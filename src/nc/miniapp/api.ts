/**
 * Mini App API handlers (miniapp-api.md). SECURITY INVARIANTS:
 *  - the tenant is derived ONLY from the authenticated session (never from a URL, query or body);
 *  - data handlers use `tenant.agent_group_id` of THAT tenant exclusively;
 *  - owner routes are flagged `owner: true` and the server re-checks the role on every call;
 *  - the only cross-tenant addressing is the owner's friend routes, which resolve a friend row
 *    by `telegram:<id>` and refuse the owner's own id.
 */
import fs from 'node:fs';
import path from 'node:path';

import { AnchoredDir } from '../../anchored-dir.js';
import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import { getSession, getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { isContainerRunning } from '../../container-runner.js';
import { parseSkillSelection } from '../../container-config.js';
import { log } from '../../log.js';
import { nanogateAdmin, type BudgetSnapshot } from '../../gateway-providers/nanogate/index.js';
import { dmSession, injectChat } from '../chat.js';
import { activeTurnInChat } from '../port.js';
import { invalidateBudget } from '../budget.js';
import { approveRequest, denyRequest } from '../decisions.js';
import { nc, ownerTgId, presetConfig, tgIdOfUserId, USD, userIdOf, type Preset } from '../config.js';
import { ownerConnectorConfigured, ownerConnectorStatus, syncOwnerConnector } from '../connector.js';
import {
  GUEST_MAX_CHARS,
  getDraft,
  getPublished,
  guestEnabled,
  putDraft,
  publishDraft,
  recentGuest,
  setGuestEnabled,
} from '../guest-store.js';
import { collectSystem } from '../health.js';
import { previewGuestAnswer } from '../guest.js';
import { deleteFriend, LifecycleError, pauseFriend, resumeFriend } from '../lifecycle.js';
import {
  audit,
  gateIdOf,
  getPrefs,
  getTenantByTg,
  kvDelete,
  kvGet,
  kvSet,
  listPendingRequests,
  listTenants,
  putPrefs,
  updateTenant,
  type Prefs,
  type Tenant,
} from '../store.js';
import { budgetBlock } from '../commands.js';
import { quietOf } from '../prefs.js';
import { validTz } from '../settings.js';
import { deleteTask, getTaskDetail, listTasks, pauseTask, rearmRecurring, resumeTask, taskName } from '../tasks.js';
import { pushTenant } from '../tenants.js';
import { ApiError, bad, conflict, forbidden, notFound } from './errors.js';
import { listBounded, parseRelPath, readBoundedPath, readBounded, UnsafePathError } from './readbounded.js';
import type {
  AccessRequest,
  Budget,
  Connection,
  EgressView,
  Friend,
  GuestContext,
  HomeView,
  MemoryFile,
  MemoryTree,
  Me,
  PromptView,
  Settings,
  Skill,
  SystemView,
  TaskDetail,
  TaskSummary,
  UsageView,
} from './types.js';

const MEMORY_FILE_MAX = 64 * 1024;
const PROMPT_MAX = 256 * 1024;
const MEMORY_MAX_ENTRIES = 500;

export interface Ctx {
  tenant: Tenant;
  isOwner: boolean;
  q: URLSearchParams;
  body: Record<string, unknown>;
  m: RegExpMatchArray;
}

export type Result = { status?: number; json?: unknown };
export type Handler = (c: Ctx) => Promise<Result | undefined>;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  re: RegExp;
  handler: Handler;
  owner?: boolean;
  /** Reachable while the tenant is paused (read-only home). */
  pausedOk?: boolean;
}

const ok = (json: unknown): Result => ({ json });
const noContent: Result = { status: 204 };

// ---------- shared mappers ----------

const iso = (v: number | string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
};

function toBudget(s: BudgetSnapshot | null, t: Tenant): Budget {
  if (!s) {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    return {
      limit: t.limit_usd_micros === null ? null : { micros: t.limit_usd_micros },
      used: { micros: 0 },
      reserved: { micros: 0 },
      periodStart: start.toISOString(),
      periodEnd: end.toISOString(),
      status: 'ok',
    };
  }
  return {
    limit: s.limitMicros === null ? null : { micros: s.limitMicros },
    used: { micros: s.usedMicros },
    reserved: { micros: s.reservedMicros },
    periodStart: iso(s.periodStart),
    periodEnd: iso(s.periodEnd),
    status: s.status === 'exhausted' || s.status === 'warn' ? s.status : 'ok',
  };
}

async function budgetOf(t: Tenant): Promise<Budget> {
  try {
    return toBudget(await nanogateAdmin.budget(gateIdOf(t)), t);
  } catch (err) {
    log.warn('nc: miniapp budget lookup failed', { user: t.user_id, err });
    return toBudget(null, t);
  }
}

export async function meOf(t: Tenant, isOwner: boolean): Promise<Me> {
  const prefs = await getPrefs(t.user_id, { tz: nc.defaultTz(), preset: isOwner ? 'deep' : 'normal' });
  return {
    userId: t.user_id,
    name: t.name,
    role: isOwner ? 'owner' : 'friend',
    state: t.state === 'paused' ? 'paused' : 'ready',
    lang: prefs.lang,
    tz: prefs.tz,
  };
}

/** Group folder of THIS tenant, or a 409 if it has none (e.g. mid-provisioning). */
async function folderOf(t: Tenant): Promise<string> {
  if (!t.agent_group_id) throw conflict('Пространство ещё не готово');
  const g = await getAgentGroup(t.agent_group_id);
  if (!g) throw conflict('Пространство ещё не готово');
  return g.folder;
}

function titleOf(p: string): string {
  const base = p.split('/').pop() ?? p;
  return base.replace(/\.(md|markdown|txt)$/i, '');
}

/** `title:` from YAML frontmatter, else the first `# ` heading, from the head of a note; null when neither. */
export function noteTitle(head: string): string | null {
  const text = head.replace(/^\uFEFF/, '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (fm) {
    const t = /^title:\s*(.+)$/m.exec(fm[1]);
    const v = t?.[1]
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .trim();
    if (v) return v.slice(0, 120);
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return h1 ? h1[1].trim().slice(0, 120) : null;
}

const TITLE_PEEK_BYTES = 2048;
const TITLE_PEEK_MAX_FILES = 200;

/** Titles of notes by path (frontmatter / first H1), peeking at bounded heads through the anchored root. */
function memoryTitles(folder: string, paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let root: AnchoredDir | null = null;
  try {
    root = memoryRoot(folder);
    if (!root) return out;
    for (const p of paths.filter((x) => /\.(md|markdown|txt)$/i.test(x)).slice(0, TITLE_PEEK_MAX_FILES)) {
      try {
        const t = noteTitle(readBoundedPath(root, p, TITLE_PEEK_BYTES).data.toString('utf8'));
        if (t) out.set(p, t);
      } catch {
        /* unreadable or refused: keep the file name */
      }
    }
  } catch {
    /* `memory` swapped for a symlink: file names only */
  } finally {
    root?.close();
  }
  return out;
}

function memoryRoot(folder: string): AnchoredDir | null {
  return AnchoredDir.open(path.join(GROUPS_DIR, folder), ['memory']);
}

/** Files the runtime creates at the first boot (index.md, system/**): internal, not something the user «taught» the assistant. */
export function isMemoryScaffold(p: string): boolean {
  return p === 'index.md' || p === 'system' || p.startsWith('system/');
}

function listMemory(folder: string): { entries: ReturnType<typeof listBounded>['entries']; truncated: boolean } {
  const r = listMemoryRaw(folder);
  return { ...r, entries: r.entries.filter((e) => !isMemoryScaffold(e.path)) };
}

function listMemoryRaw(folder: string): { entries: ReturnType<typeof listBounded>['entries']; truncated: boolean } {
  let root: AnchoredDir | null = null;
  try {
    root = memoryRoot(folder);
  } catch {
    return { entries: [], truncated: false }; // `memory` swapped for a symlink: show nothing
  }
  if (!root) return { entries: [], truncated: false };
  try {
    return listBounded(root, { maxEntries: MEMORY_MAX_ENTRIES, maxDepth: 5 });
  } finally {
    root.close();
  }
}

// ---------- home ----------

const home: Handler = async ({ tenant, isOwner }) => {
  const me = await meOf(tenant, isOwner);
  const budget = await budgetOf(tenant);
  let status: HomeView['assistant']['status'] = tenant.state === 'paused' ? 'paused' : 'ready';
  let nextTasks: TaskSummary[] = [];
  let recentMemory: HomeView['recentMemory'] = [];
  if (tenant.state === 'ready' && tenant.agent_group_id) {
    // «Занят» only while a turn is really in flight; a warm idle container is not busy.
    if (activeTurnInChat(tenant.tg_id) === true) status = 'busy';
    nextTasks = (await listTasks(tenant.agent_group_id).catch(() => []))
      .filter((x) => x.status === 'active' && x.nextRunAt)
      .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))
      .slice(0, 3);
    const folder = await folderOf(tenant).catch(() => null);
    if (folder) {
      const recent = listMemory(folder)
        .entries.filter((e) => e.kind === 'file')
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 5);
      const titles = memoryTitles(
        folder,
        recent.map((e) => e.path),
      );
      recentMemory = recent.map((e) => ({
        title: titles.get(e.path) ?? titleOf(e.path),
        path: e.path,
        updatedAt: new Date(e.mtimeMs).toISOString(),
      }));
    }
  }
  const view: HomeView = { me, assistant: { status }, budget, nextTasks, recentMemory };
  if (isOwner) {
    const friends = (await listTenants()).filter((t) => t.tg_id !== ownerTgId() && t.state === 'ready');
    let over = 0;
    for (const f of friends) if ((await budgetOf(f)).status === 'exhausted') over++;
    view.attention = {
      pendingRequests: (await listPendingRequests()).length,
      friendsOverBudget: over,
      connectorIssues: ownerConnectorConfigured() && !(await nanogateAdmin.healthz().catch(() => false)) ? 1 : 0,
    };
  }
  return ok(view);
};

// ---------- prompt ----------

/** Section names the composer itself emits; any other `# ` line is just text inside a section (e.g. the persona's own headings). */
function isComposerSection(name: string): boolean {
  return (
    name === 'Persona' ||
    name === 'NanoClaw Platform' ||
    name === 'NanoClaw Runtime Contract' ||
    name === 'Native Runtime Skills' ||
    name.startsWith('NanoClaw Module: ') ||
    name.startsWith('NanoClaw Skill: ') ||
    name.startsWith('MCP Server: ')
  );
}

export function splitSections(md: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  let cur: { name: string; lines: string[] } | null = null;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const h = !fence ? /^# (.+)$/.exec(line) : null;
    if (h && isComposerSection(h[1].trim())) {
      if (cur) out.push({ name: cur.name, body: cur.lines.join('\n').trim() });
      cur = { name: h[1].trim(), lines: [] };
    } else if (cur) cur.lines.push(line);
  }
  if (cur) out.push({ name: cur.name, body: cur.lines.join('\n').trim() });
  return out;
}

const prompt: Handler = async ({ tenant }) => {
  const folder = await folderOf(tenant);
  let composed = '';
  let composedAt = new Date().toISOString();
  let root: AnchoredDir | null = null;
  try {
    root = AnchoredDir.open(path.join(GROUPS_DIR, folder), []);
    if (root) {
      try {
        const r = readBounded(root, 'CLAUDE.md', PROMPT_MAX);
        composed = r.data.toString('utf8');
        composedAt = new Date(r.mtimeMs).toISOString();
      } catch {
        /* not composed yet (never spawned), or refused: fall back to the persona alone */
      }
      if (!composed) {
        try {
          const r = readBounded(root, 'instructions.prepend.md', PROMPT_MAX);
          composed = `# Persona\n\n${r.data.toString('utf8')}`;
          composedAt = new Date(r.mtimeMs).toISOString();
        } catch {
          /* nothing yet */
        }
      }
    }
  } finally {
    root?.close();
  }
  const platform: string[] = [];
  const personal: string[] = [];
  const skills: string[] = [];
  for (const s of splitSections(composed)) {
    const block = `## ${s.name}\n\n${s.body}`;
    if (s.name === 'Persona') personal.push(s.body);
    else if (s.name.startsWith('NanoClaw Skill:') || s.name.startsWith('MCP Server:')) skills.push(block);
    else platform.push(block);
  }
  const view: PromptView = {
    layers: [
      {
        id: 'platform',
        title: 'Платформа',
        locked: true,
        markdown: platform.join('\n\n'),
        source: 'платформа NanoClaw',
      },
      {
        id: 'personal',
        title: 'Личные инструкции',
        locked: false,
        markdown: personal.join('\n\n'),
        source: 'instructions.prepend.md',
      },
      {
        id: 'skills',
        title: 'Навыки и инструменты',
        locked: true,
        markdown: skills.join('\n\n'),
        source: 'выбранные навыки',
      },
    ],
    composedAt,
  };
  return ok(view);
};

// ---------- memory ----------

const memoryTree: Handler = async ({ tenant }) => {
  const folder = await folderOf(tenant);
  const { entries, truncated } = listMemory(folder);
  const titles = memoryTitles(
    folder,
    entries.filter((e) => e.kind === 'file').map((e) => e.path),
  );
  const view: MemoryTree = {
    entries: entries.map((e) => ({
      path: e.path,
      title: titles.get(e.path) ?? titleOf(e.path),
      size: e.size,
      updatedAt: new Date(e.mtimeMs).toISOString(),
      kind: e.kind,
    })),
    truncated,
  };
  return ok(view);
};

const memoryFile: Handler = async ({ tenant, q }) => {
  const folder = await folderOf(tenant);
  const rel = q.get('path');
  try {
    parseRelPath(rel);
  } catch {
    throw bad('Неверный путь');
  }
  let root: AnchoredDir | null = null;
  try {
    root = memoryRoot(folder);
    if (!root) throw notFound();
    let r;
    try {
      r = readBoundedPath(root, rel as string, MEMORY_FILE_MAX);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (err instanceof UnsafePathError) throw notFound();
      throw notFound(); // missing, symlink, FIFO, directory...: all the same answer
    }
    if (r.data.includes(0)) throw bad('Это не текстовый файл');
    const view: MemoryFile = {
      path: rel as string,
      markdown: r.data.toString('utf8'),
      truncated: r.truncated,
      updatedAt: new Date(r.mtimeMs).toISOString(),
    };
    return ok(view);
  } finally {
    root?.close();
  }
};

const memoryForget: Handler = async ({ tenant, body }) => {
  try {
    parseRelPath(body.path);
  } catch {
    throw bad('Неверный путь');
  }
  const s = await dmSession(tenant, true);
  if (!s) throw conflict('Пространство ещё не готово');
  await injectChat(
    s,
    tenant.tg_id,
    `Пользователь просит забыть запись памяти «${body.path as string}». Удали или отредактируй этот файл в memory/ и подтверди одной короткой фразой.`,
    { sender: 'Кабинет' },
  );
  await audit(tenant.user_id, 'memory_forget', tenant.user_id);
  return { status: 202, json: {} };
};

// ---------- skills ----------

function frontmatterDescription(file: string): string {
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      const m = /^description:\s*(.+)$/m.exec(buf.subarray(0, n).toString('utf8'));
      return m ? m[1].trim().slice(0, 300) : '';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

/** Display names for the skills a user can actually have (the ids and English descriptions are internal). */
const SKILL_RU: Record<string, { name: string; description: string }> = {
  'agent-browser': { name: 'Браузер', description: 'Открываю сайты, ищу и достаю нужное, заполняю формы.' },
  'frontend-engineer': { name: 'Фронтенд', description: 'Собираю и правлю веб-интерфейсы.' },
};
const HIDDEN_SKILLS = new Set(['self-customize', 'welcome']);

const skills: Handler = async ({ tenant }) => {
  if (!tenant.agent_group_id) throw conflict('Пространство ещё не готово');
  const row = await getContainerConfig(tenant.agent_group_id);
  const selection = parseSkillSelection(row?.skills, tenant.name);
  const dir = path.join(process.cwd(), 'container', 'skills');
  let names: string[] = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    /* no skills dir */
  }
  // Only what this user really has: a skill that is switched off (or owner-only) is not an ability.
  const out: Skill[] = names
    .filter((id) => !HIDDEN_SKILLS.has(id) && (selection === 'all' || selection.includes(id)))
    .map((id) => ({
      id,
      name: SKILL_RU[id]?.name ?? id,
      description: SKILL_RU[id]?.description ?? frontmatterDescription(path.join(dir, id, 'SKILL.md')),
      enabled: true,
      locked: false,
    }));
  return ok(out);
};

// ---------- tasks ----------

const TASK_ID = /^[a-z0-9][a-z0-9-]{0,100}$/;

function taskId(c: Ctx): string {
  const id = decodeURIComponent(c.m[1] ?? '');
  if (!TASK_ID.test(id)) throw bad('Неверный id задачи');
  return id;
}

function groupOf(t: Tenant): string {
  if (!t.agent_group_id) throw conflict('Пространство ещё не готово');
  return t.agent_group_id;
}

const tasksList: Handler = async ({ tenant }) => ok(await listTasks(groupOf(tenant)));
const taskGet: Handler = async (c) => {
  const d: TaskDetail | undefined = await getTaskDetail(groupOf(c.tenant), taskId(c));
  if (!d) throw notFound();
  return ok(d);
};
const taskVerb =
  (verb: 'pause' | 'resume'): Handler =>
  async (c) => {
    if (verb === 'resume') {
      // While the budget is exhausted a task would fire, hit the wall and fail silently: it comes back by itself.
      const blocked = await budgetBlock(c.tenant);
      if (blocked) throw conflict(blocked);
    }
    const n = await (verb === 'pause' ? pauseTask : resumeTask)(groupOf(c.tenant), taskId(c));
    if (n === 0) throw notFound();
    return noContent;
  };
const taskDelete: Handler = async (c) => {
  try {
    if (!(await deleteTask(groupOf(c.tenant), taskId(c)))) throw notFound();
  } catch (err) {
    if (err instanceof Error && err.message === 'task_running') throw conflict('Задача сейчас выполняется');
    throw err;
  }
  return noContent;
};

// ---------- usage ----------

interface UsageRow {
  key?: string;
  cost_micros?: number | null;
}

type Purpose = UsageView['byPurpose'][number]['purpose'];
/** nanogate purposes -> the four the screen knows: `stt` is voice, `agent` (and miniapp/system) is chat. */
const PURPOSE_MAP: Record<string, Purpose> = {
  stt: 'voice',
  agent: 'chat',
  miniapp: 'chat',
  system: 'chat',
  task: 'task',
  guest: 'guest',
  chat: 'chat',
  voice: 'voice',
};

/** Voice minutes are free (local whisper) but counted: the screen shows «Голос: N мин · бесплатно». */
async function voiceSecondsSince(userId: string, fromMs: number): Promise<number> {
  const r = await getDb().get<{ s: number | null }>(
    'SELECT SUM(seconds) AS s FROM nc_usage_voice WHERE user_id = ? AND at >= ?',
    userId,
    new Date(fromMs).toISOString(),
  );
  return r?.s ?? 0;
}

/** The five most expensive sessions of the period, titled «Разговор <дата>» or by task name. */
async function topConversations(tenant: Tenant, rows: UsageRow[]): Promise<UsageView['topTurns']> {
  const top = rows
    .filter((r) => r.key && (r.cost_micros ?? 0) > 0)
    .sort((a, b) => (b.cost_micros ?? 0) - (a.cost_micros ?? 0))
    .slice(0, 5);
  const out: UsageView['topTurns'] = [];
  for (const r of top) {
    const sess = await getSession(r.key as string).catch(() => undefined);
    if (!sess || sess.agent_group_id !== tenant.agent_group_id) continue; // only this tenant's own sessions
    const at = sess.last_active ?? sess.created_at;
    let title: string;
    if (isTaskThread(sess.thread_id)) {
      const series = sess.thread_id?.split(':').slice(1).join(':') ?? '';
      title = `Задача «${(series && tenant.agent_group_id ? await taskName(tenant.agent_group_id, series) : undefined) ?? 'без названия'}»`;
    } else {
      title = `Разговор ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date(at))}`;
    }
    out.push({ title, at: iso(at), cost: { micros: r.cost_micros ?? 0 } });
  }
  return out;
}

const usage: Handler = async ({ tenant, q }) => {
  const daysRaw = q.get('days') ?? '14';
  if (daysRaw !== '14' && daysRaw !== '30') throw bad('days: 14 или 30');
  const days = Number(daysRaw);
  const to = Date.now() + 86_400_000;
  const from = Date.now() - days * 86_400_000;
  const rows = async (groupBy: string): Promise<UsageRow[]> => {
    try {
      const r = (await nanogateAdmin.usage({ tenantId: gateIdOf(tenant), from, to, groupBy })) as { rows?: UsageRow[] };
      return r.rows ?? [];
    } catch (err) {
      log.warn('nc: usage lookup failed', { err });
      return [];
    }
  };
  const [byDay, byModel, byPurpose, bySession] = await Promise.all([
    rows('day'),
    rows('model'),
    rows('purpose'),
    rows('session'),
  ]);
  const map = new Map(byDay.map((r) => [r.key ?? '', r.cost_micros ?? 0]));
  const daily: UsageView['daily'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    daily.push({ day, cost: { micros: map.get(day) ?? 0 } });
  }
  const purposeCost = new Map<string, number>();
  for (const r of byPurpose) {
    const p = PURPOSE_MAP[r.key ?? ''] ?? 'chat';
    purposeCost.set(p, (purposeCost.get(p) ?? 0) + (r.cost_micros ?? 0));
  }
  // nanogate tags a session's calls `agent`; the sessions of scheduled tasks are «Задачи» on this screen.
  let taskMicros = 0;
  for (const r of bySession) {
    if (!r.key || (r.cost_micros ?? 0) <= 0) continue;
    const sess = await getSession(r.key).catch(() => undefined);
    if (sess && sess.agent_group_id === tenant.agent_group_id && isTaskThread(sess.thread_id))
      taskMicros += r.cost_micros ?? 0;
  }
  if (taskMicros > 0) {
    const chat = purposeCost.get('chat') ?? 0;
    const moved = Math.min(chat, taskMicros);
    purposeCost.set('chat', chat - moved);
    purposeCost.set('task', (purposeCost.get('task') ?? 0) + moved);
  }
  const budget = await budgetOf(tenant);
  const topTurns = await topConversations(tenant, bySession);
  const voiceSeconds = await voiceSecondsSince(tenant.user_id, from).catch(() => 0);
  const view: UsageView & { voiceSeconds: number } = {
    budget,
    daily,
    byModel: byModel
      .filter((r) => r.key)
      .map((r) => ({ model: r.key as string, cost: { micros: r.cost_micros ?? 0 } })),
    byPurpose: [...purposeCost.entries()].map(([purpose, micros]) => ({
      purpose: purpose as UsageView['byPurpose'][number]['purpose'],
      cost: { micros },
    })),
    topTurns,
    pending: budget.reserved,
    priceVersion: 'n/a',
    voiceSeconds,
  };
  return ok(view);
};

// ---------- connections / egress ----------

async function egressView(t: Tenant, isOwner: boolean): Promise<EgressView> {
  const allowed = isOwner || (await kvGet(`egress-ok:${t.tg_id}`)) === '1';
  return { route: t.egress, residentialAvailable: ownerConnectorConfigured() && allowed };
}

const connections: Handler = async ({ tenant, isOwner }) => {
  let conn: Connection & { managed?: boolean };
  if (isOwner && ownerConnectorConfigured()) {
    // The owner's connector is run by the server (Nix): report what is really there, with the exit node by name.
    const st = await ownerConnectorStatus();
    const exit = nc.ownerExitNode();
    conn = {
      id: 'tailscale',
      managed: true,
      status: st === 'ok' ? 'connected' : 'error',
      node: nc.ownerName(),
      ...(exit ? { exitNode: exit, exitNodeOnline: st === 'ok' } : {}),
      routes: nc.ownerTailnetCidrs(),
      lastCheckAt: new Date().toISOString(),
      ...(st === 'ok' ? {} : { message: 'Домашний выход недоступен: запросы «Через дом» не пройдут.' }),
      ...(st === 'ok' && !exit ? { message: 'Выходной узел не настроен: «Через дом» выходит с адреса сервера.' } : {}),
    };
  } else {
    // Per-friend Tailscale is a later phase: never claim «Подключаюсь…» without a process behind it.
    conn = { id: 'tailscale', status: 'not_connected', message: 'Скоро: подключение своей домашней сети.' };
  }
  // Write-only secret: only whether (and when) it was saved, never the value.
  let haToken: { savedAt: string } | null = null;
  if (isOwner) {
    try {
      const f = path.join(GROUPS_DIR, await folderOf(tenant), '.secrets', 'ha_token');
      haToken = { savedAt: fs.lstatSync(f).mtime.toISOString() };
    } catch {
      haToken = null;
    }
  }
  return ok({ connections: [conn], egress: await egressView(tenant, isOwner), ...(isOwner ? { haToken } : {}) });
};

const SERVER_MANAGED = 'Управляется сервером';

/** Keys are not accepted yet: the owner's connector is server-managed, per-friend connectors come later. */
const tsKey: Handler = async ({ isOwner }) => {
  if (!isOwner) throw forbidden('Подключение своей сети пока недоступно');
  throw conflict(SERVER_MANAGED);
};

const tsReconnect: Handler = async ({ tenant, isOwner }) => {
  // Friends have no connector of their own yet: nothing to reconnect.
  if (!isOwner) throw forbidden('Подключение своей сети пока недоступно');
  await syncOwnerConnector();
  await audit(tenant.user_id, 'tailscale_reconnect', tenant.user_id);
  return { status: 202, json: {} };
};

const tsDelete: Handler = async ({ isOwner }) => {
  // Deleting the owner's connector would silently cut off all residential egress (502 connector_down).
  if (isOwner) throw conflict(SERVER_MANAGED);
  throw forbidden('Подключение своей сети пока недоступно');
};

// ---------- Home Assistant token (owner only, write-only) ----------

const HA_TOKEN = /^[A-Za-z0-9._~+/=-]{20,4096}$/;

/** `groups/<folder>/.secrets` (0700), refusing a symlink the agent may have planted in its writable folder. */
function secretsDir(folder: string): string {
  const base = path.join(GROUPS_DIR, folder);
  const dir = path.join(base, '.secrets');
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) throw conflict('Каталог секретов недоступен');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

/**
 * The long-lived Home Assistant token lives in a file only the owner's agent group sees
 * (`/workspace/agent/.secrets/ha_token`); nanogate injects no credentials on CONNECT. Never read back.
 */
const haTokenPut: Handler = async ({ tenant, body }) => {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!HA_TOKEN.test(token)) throw bad('Это не похоже на токен Home Assistant');
  const dir = secretsDir(await folderOf(tenant));
  const fd = fs.openSync(
    path.join(dir, 'ha_token'),
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeSync(fd, `${token}\n`);
  } finally {
    fs.closeSync(fd);
  }
  await audit(tenant.user_id, 'ha_token_saved', tenant.user_id); // never the value
  return noContent;
};

const haTokenDelete: Handler = async ({ tenant }) => {
  const dir = secretsDir(await folderOf(tenant));
  fs.rmSync(path.join(dir, 'ha_token'), { force: true });
  await audit(tenant.user_id, 'ha_token_removed', tenant.user_id);
  return noContent;
};

const egressPut: Handler = async ({ tenant, isOwner, body }) => {
  const route = body.route;
  if (route !== 'direct' && route !== 'residential') throw bad('route: direct или residential');
  if (route === 'residential') {
    if (!ownerConnectorConfigured()) throw conflict('Домашний выход не настроен');
    if (!isOwner && (await kvGet(`egress-ok:${tenant.tg_id}`)) !== '1')
      throw forbidden('Домашний выход не включён владельцем');
  }
  await updateTenant(tenant.tg_id, { egress: route });
  if (isOwner) await kvSet('egress-chosen:owner', '1'); // from now on bootstrap leaves the owner's choice alone
  await pushTenant((await getTenantByTg(tenant.tg_id))!, tenant.state === 'paused' ? 'paused' : 'active');
  await audit(tenant.user_id, 'egress', tenant.user_id, { route });
  return noContent;
};

// ---------- settings ----------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function toSettings(p: Prefs): Settings {
  return {
    lang: p.lang,
    tz: p.tz,
    preset: p.preset,
    quietHours: quietOf(p),
    showSteps: p.show_steps,
  };
}

const settingsGet: Handler = async ({ tenant, isOwner }) =>
  ok(toSettings(await getPrefs(tenant.user_id, { tz: nc.defaultTz(), preset: isOwner ? 'deep' : 'normal' })));

const settingsPatch: Handler = async ({ tenant, isOwner, body }) => {
  const cur = await getPrefs(tenant.user_id, { tz: nc.defaultTz(), preset: isOwner ? 'deep' : 'normal' });
  const next: Prefs = { ...cur };
  if (body.lang !== undefined) {
    if (body.lang !== 'ru' && body.lang !== 'en') throw bad('lang');
    next.lang = body.lang;
  }
  if (body.tz !== undefined) {
    if (typeof body.tz !== 'string' || !validTz(body.tz)) throw bad('tz');
    next.tz = body.tz;
  }
  if (body.preset !== undefined) {
    if (body.preset !== 'fast' && body.preset !== 'normal' && body.preset !== 'deep') throw bad('preset');
    next.preset = body.preset;
  }
  if (body.showSteps !== undefined) {
    if (typeof body.showSteps !== 'boolean') throw bad('showSteps');
    next.show_steps = body.showSteps;
  }
  if (body.quietHours !== undefined) {
    const qh = body.quietHours as { from?: unknown; to?: unknown } | null;
    if (qh === null) {
      // '' = explicitly off (null would mean «never set» -> the 23:00-08:00 default).
      next.quiet_from = '';
      next.quiet_to = '';
    } else if (
      typeof qh === 'object' &&
      typeof qh.from === 'string' &&
      typeof qh.to === 'string' &&
      HHMM.test(qh.from) &&
      HHMM.test(qh.to)
    ) {
      next.quiet_from = qh.from;
      next.quiet_to = qh.to;
    } else throw bad('quietHours');
  }
  await putPrefs(tenant.user_id, next);
  if (tenant.agent_group_id && (next.preset !== cur.preset || next.tz !== cur.tz)) {
    const p = presetConfig(next.preset as Preset);
    await updateContainerConfigScalars(tenant.agent_group_id, { model: p.model, effort: p.effort, timezone: next.tz });
  }
  // The next armed occurrence of every recurring task was computed in the old zone: re-arm it.
  if (tenant.agent_group_id && next.tz !== cur.tz) await rearmRecurring(tenant.agent_group_id, next.tz).catch(() => 0);
  return ok(toSettings(next));
};

// ---------- owner ----------

const ownerRequests: Handler = async () => {
  const out: AccessRequest[] = [];
  for (const r of await listPendingRequests()) {
    const t = await getTenantByTg(r.tg_id);
    out.push({
      id: r.id,
      userId: userIdOf(r.tg_id),
      name: t?.name ?? String(r.tg_id),
      username: t?.username ?? undefined,
      firstMessage: r.first_message,
      createdAt: r.created_at,
    });
  }
  return ok(out);
};

function usdParam(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) throw bad('limitUsd: число от 0 до 1000');
  return Math.round(v * USD);
}

const REQ_ID = /^[0-9a-f]{10}$/;

const ownerApprove: Handler = async ({ tenant, m, body }) => {
  const id = decodeURIComponent(m[1] ?? '');
  if (!REQ_ID.test(id)) throw notFound();
  const limit = usdParam(body.limitUsd);
  const r = await approveRequest(id, limit ?? nc.defaultLimitMicros(), tenant.user_id);
  if (r === 'not_found') throw notFound();
  if (r === 'already_decided') throw conflict('Запрос уже обработан');
  if (r === 'failed') throw conflict('Статус изменился');
  return noContent;
};

const ownerDeny: Handler = async ({ tenant, m }) => {
  const id = decodeURIComponent(m[1] ?? '');
  if (!REQ_ID.test(id)) throw notFound();
  const r = await denyRequest(id, tenant.user_id);
  if (r === 'not_found') throw notFound();
  if (r === 'already_decided') throw conflict('Запрос уже обработан');
  return noContent;
};

const FRIEND_STATES = new Set(['ready', 'paused', 'provisioning', 'provisioning_failed']);

async function friendFromParam(m: RegExpMatchArray): Promise<Tenant> {
  const tgId = tgIdOfUserId(decodeURIComponent(m[1] ?? ''));
  if (tgId === null || tgId === ownerTgId()) throw notFound();
  const t = await getTenantByTg(tgId);
  if (!t || !FRIEND_STATES.has(t.state)) throw notFound();
  return t;
}

const ownerFriends: Handler = async () => {
  const out: Friend[] = [];
  for (const t of await listTenants()) {
    if (t.tg_id === ownerTgId() || !FRIEND_STATES.has(t.state)) continue;
    let lastActive: string | undefined;
    let container: Friend['container'] = 'idle';
    if (t.agent_group_id) {
      const ss = await getSessionsByAgentGroup(t.agent_group_id);
      lastActive = ss
        .map((s) => s.last_active)
        .filter((x): x is string => !!x)
        .sort()
        .pop();
      if (ss.some((s) => isContainerRunning(s.id))) container = 'running';
    }
    out.push({
      userId: t.user_id,
      name: t.name,
      username: t.username ?? undefined,
      state: t.state as Friend['state'],
      budget: await budgetOf(t),
      lastActiveAt: lastActive,
      container,
      egress: t.egress,
    });
  }
  return ok(out);
};

const ownerFriendPatch: Handler = async ({ tenant, m, body }) => {
  const f = await friendFromParam(m);
  const limit = usdParam(body.limitUsd);
  if (limit !== undefined) {
    await updateTenant(f.tg_id, { limit_usd_micros: limit });
    invalidateBudget(gateIdOf(f));
  }
  if (body.egress !== undefined) {
    if (body.egress !== 'direct' && body.egress !== 'residential') throw bad('egress');
    if (body.egress === 'residential') {
      if (!ownerConnectorConfigured()) throw conflict('Домашний выход не настроен');
      await kvSet(`egress-ok:${f.tg_id}`, '1');
    } else {
      await kvDelete(`egress-ok:${f.tg_id}`);
    }
    await updateTenant(f.tg_id, { egress: body.egress });
  }
  if (limit !== undefined || body.egress !== undefined) {
    await pushTenant((await getTenantByTg(f.tg_id))!, f.state === 'paused' ? 'paused' : 'active');
    await audit(tenant.user_id, 'friend_patch', f.user_id, { limit, egress: body.egress });
  }
  return noContent;
};

async function lifecycle(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
    return noContent;
  } catch (err) {
    if (err instanceof LifecycleError) {
      throw err.code === 'not_found' ? notFound() : err.code === 'forbidden' ? forbidden() : conflict(err.message);
    }
    throw err;
  }
}

const ownerFriendPause: Handler = async ({ tenant, m }) => {
  const f = await friendFromParam(m);
  return lifecycle(() => pauseFriend(f.tg_id, tenant.user_id));
};
const ownerFriendResume: Handler = async ({ tenant, m }) => {
  const f = await friendFromParam(m);
  return lifecycle(() => resumeFriend(f.tg_id, tenant.user_id));
};
const ownerFriendDelete: Handler = async ({ tenant, m, body }) => {
  const f = await friendFromParam(m);
  if (typeof body.confirmName !== 'string' || body.confirmName !== f.name)
    throw bad('Имя для подтверждения не совпадает');
  return lifecycle(() => deleteFriend(f.tg_id, tenant.user_id));
};

async function guestContext(): Promise<GuestContext & { maxChars: number }> {
  return {
    published: await getPublished(),
    draft: await getDraft(),
    enabled: await guestEnabled(),
    recent: await recentGuest(),
    maxChars: GUEST_MAX_CHARS,
  };
}

const PREVIEW_WINDOW_MS = 60_000;
const PREVIEW_MAX_PER_WINDOW = 4;
const previewCalls: number[] = [];

/** «Проверить ответ»: the real guest path (same prompt, model, shaping) on a question the owner types, by draft or published text. */
const ownerGuestPreview: Handler = async ({ body }) => {
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  if (!question) throw bad('question');
  const now = Date.now();
  while (previewCalls.length && now - previewCalls[0] > PREVIEW_WINDOW_MS) previewCalls.shift();
  if (previewCalls.length >= PREVIEW_MAX_PER_WINDOW)
    throw new ApiError('rate_limited', 'Слишком часто: подожди минуту');
  previewCalls.push(now);
  const context = body.useDraft === false ? ((await getPublished())?.markdown ?? '') : await getDraft();
  if (!context.trim()) throw bad(body.useDraft === false ? 'Ничего не опубликовано' : 'Черновик пуст');
  try {
    return ok({ answer: await previewGuestAnswer(question, context) });
  } catch (err) {
    log.warn('nc: guest preview failed', { err: err instanceof Error ? err.message : String(err) });
    throw new ApiError('internal', 'Не удалось получить ответ. Попробуй ещё раз.');
  }
};

const ownerGuestGet: Handler = async () => ok(await guestContext());
const ownerGuestDraft: Handler = async ({ body }) => {
  if (typeof body.markdown !== 'string') throw bad('markdown');
  try {
    await putDraft(body.markdown);
  } catch {
    throw bad('Слишком длинный текст');
  }
  return noContent;
};
const ownerGuestPublish: Handler = async ({ tenant }) => {
  const draft = await getDraft();
  if (!draft.trim()) throw bad('Черновик пуст');
  await publishDraft(tenant.user_id);
  await audit(tenant.user_id, 'guest_publish', tenant.user_id);
  return noContent;
};
const ownerGuestEnabled: Handler = async ({ body }) => {
  if (typeof body.enabled !== 'boolean') throw bad('enabled');
  await setGuestEnabled(body.enabled);
  return noContent;
};
const ownerSystem: Handler = async () => ok((await collectSystem()) satisfies SystemView);

// ---------- table ----------

const seg = '([^/]+)';

export const routes: Route[] = [
  { method: 'GET', re: /^\/api\/home$/, handler: home, pausedOk: true },
  { method: 'GET', re: /^\/api\/prompt$/, handler: prompt },
  { method: 'GET', re: /^\/api\/memory$/, handler: memoryTree },
  { method: 'GET', re: /^\/api\/memory\/file$/, handler: memoryFile },
  { method: 'POST', re: /^\/api\/memory\/forget$/, handler: memoryForget },
  { method: 'GET', re: /^\/api\/skills$/, handler: skills },
  { method: 'GET', re: /^\/api\/tasks$/, handler: tasksList },
  { method: 'GET', re: new RegExp(`^/api/tasks/${seg}$`), handler: taskGet },
  { method: 'POST', re: new RegExp(`^/api/tasks/${seg}/pause$`), handler: taskVerb('pause') },
  { method: 'POST', re: new RegExp(`^/api/tasks/${seg}/resume$`), handler: taskVerb('resume') },
  { method: 'DELETE', re: new RegExp(`^/api/tasks/${seg}$`), handler: taskDelete },
  { method: 'GET', re: /^\/api\/usage$/, handler: usage },
  { method: 'GET', re: /^\/api\/connections$/, handler: connections },
  { method: 'PUT', re: /^\/api\/connections\/tailscale\/key$/, handler: tsKey },
  { method: 'POST', re: /^\/api\/connections\/tailscale\/reconnect$/, handler: tsReconnect },
  { method: 'DELETE', re: /^\/api\/connections\/tailscale$/, handler: tsDelete },
  { method: 'PUT', re: /^\/api\/owner\/secrets\/ha-token$/, handler: haTokenPut, owner: true },
  { method: 'DELETE', re: /^\/api\/owner\/secrets\/ha-token$/, handler: haTokenDelete, owner: true },
  { method: 'PUT', re: /^\/api\/egress$/, handler: egressPut },
  { method: 'GET', re: /^\/api\/settings$/, handler: settingsGet },
  { method: 'PATCH', re: /^\/api\/settings$/, handler: settingsPatch },
  { method: 'GET', re: /^\/api\/owner\/requests$/, handler: ownerRequests, owner: true },
  { method: 'POST', re: new RegExp(`^/api/owner/requests/${seg}/approve$`), handler: ownerApprove, owner: true },
  { method: 'POST', re: new RegExp(`^/api/owner/requests/${seg}/deny$`), handler: ownerDeny, owner: true },
  { method: 'GET', re: /^\/api\/owner\/friends$/, handler: ownerFriends, owner: true },
  { method: 'PATCH', re: new RegExp(`^/api/owner/friends/${seg}$`), handler: ownerFriendPatch, owner: true },
  { method: 'POST', re: new RegExp(`^/api/owner/friends/${seg}/pause$`), handler: ownerFriendPause, owner: true },
  { method: 'POST', re: new RegExp(`^/api/owner/friends/${seg}/resume$`), handler: ownerFriendResume, owner: true },
  { method: 'DELETE', re: new RegExp(`^/api/owner/friends/${seg}$`), handler: ownerFriendDelete, owner: true },
  { method: 'GET', re: /^\/api\/owner\/guest$/, handler: ownerGuestGet, owner: true },
  { method: 'PUT', re: /^\/api\/owner\/guest\/draft$/, handler: ownerGuestDraft, owner: true },
  { method: 'POST', re: /^\/api\/owner\/guest\/publish$/, handler: ownerGuestPublish, owner: true },
  { method: 'POST', re: /^\/api\/owner\/guest\/preview$/, handler: ownerGuestPreview, owner: true },
  { method: 'POST', re: /^\/api\/owner\/guest\/enabled$/, handler: ownerGuestEnabled, owner: true },
  { method: 'GET', re: /^\/api\/owner\/system$/, handler: ownerSystem, owner: true },
];
