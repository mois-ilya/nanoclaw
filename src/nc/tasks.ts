/**
 * Host-side task access for the Mini App, `/tasks` and pause/delete. Every
 * operation starts from `findTaskSessions(agentGroupId)`: a tenant's tasks are
 * only reachable through that tenant's own agent group, so a foreign series id
 * can never match.
 */
import fs from 'node:fs';

import { CronExpressionParser } from 'cron-parser';

import { destroySessionMailbox, sessionDir, withExistingMailboxSession } from '../session-manager.js';
import { deleteSession, findTaskSessions, getSession, taskThreadId } from '../db/sessions.js';
import { isContainerRunning } from '../container-runner.js';
import { resolveGroupTimezone } from '../container-config.js';
import { deleteRunLog, readRunLogTail } from '../modules/scheduling/run-log.js';
import { parseTaskContent } from '../modules/scheduling/task-content.js';
import type { TaskRecord } from '../mailbox/types.js';
import { log } from '../log.js';
import { parseZonedToUtc } from '../timezone.js';
import { kvDelete, kvGet, kvSet } from './store.js';
import type { TaskDetail, TaskSummary } from './miniapp/types.js';

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** `1-5`, `0,6`, `1,3,5`, `3` -> sorted unique numbers within [min,max]; null for anything else (steps, names...). */
function parseNums(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < min || b > max || a > b) return null;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

export function humanSchedule(recurrence: string | null, processAfter: string | null, tz: string): string {
  if (!recurrence) {
    if (!processAfter) return 'Один раз';
    const d = new Date(processAfter);
    return `Один раз · ${new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d)}`;
  }
  const f = recurrence.trim().split(/\s+/);
  if (f.length === 5) {
    const [m, h, dom, mon, dow] = f;
    const minutes = /^\d+$/.test(m) && Number(m) <= 59 ? Number(m) : null;
    const hours = parseNums(h, 0, 23);
    if (minutes !== null && hours && mon === '*') {
      const at = hours.map((x) => `${pad(x)}:${pad(minutes)}`).join(' и ');
      if (dom === '*') {
        if (dow === '*') return `Каждый день в ${at}`;
        const days = parseNums(dow, 0, 7)?.map((d) => d % 7);
        if (days) {
          const set = [...new Set(days)].sort((x, y) => x - y);
          const key = set.join(',');
          if (key === '0,1,2,3,4,5,6') return `Каждый день в ${at}`;
          if (key === '1,2,3,4,5') return `По будням в ${at}`;
          if (key === '0,6') return `По выходным в ${at}`;
          if (set.length === 1) return `Каждую неделю: ${WEEKDAYS[set[0]]} в ${at}`;
          // Monday-first order reads naturally.
          const ordered = [...set].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
          const names = ordered.map((d) => WEEKDAYS_SHORT[d]).join(', ');
          return `${names[0].toUpperCase()}${names.slice(1)} в ${at}`;
        }
      } else if (dow === '*' && /^\d+$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
        return `Каждое ${Number(dom)}-е число в ${at}`;
      }
    }
    const step = /^\*\/(\d+)$/.exec(m);
    if (step && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Каждые ${step[1]} мин`;
    if (minutes === 0 && dom === '*' && mon === '*' && dow === '*') {
      if (h === '*') return 'Каждый час';
      const hs = /^\*\/(\d+)$/.exec(h);
      if (hs) return `Каждые ${hs[1]} ч`;
    }
  }
  return `По расписанию (${recurrence})`;
}

/** Human-given name stored in the task content (`name`, Unicode, <= 60 chars). */
function contentName(raw: string): string | null {
  try {
    const n = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof n === 'string' && n.trim() ? n.replace(/\s+/g, ' ').trim().slice(0, 60) : null;
  } catch {
    return null;
  }
}

interface Located {
  agentGroupId: string;
  sessionId: string;
  row: TaskRecord;
  /** Trailing consecutive failed occurrences (0 once a run succeeded). */
  failed: number;
  runs: number;
}

async function live(agentGroupId: string): Promise<Located[]> {
  const out: Located[] = [];
  for (const s of await findTaskSessions(agentGroupId)) {
    const rows = await withExistingMailboxSession(s.agent_group_id, s.id, (db) =>
      db.listLiveTasks().map((row) => {
        const sid = row.seriesId ?? row.id;
        return { row, failed: db.trailingFailedRuns(sid), runs: db.getTaskStats(sid).runs };
      }),
    );
    for (const r of rows ?? []) {
      out.push({ agentGroupId: s.agent_group_id, sessionId: s.id, row: r.row, failed: r.failed, runs: r.runs });
    }
  }
  return out;
}

function firstLine(prompt: string): string {
  return (prompt.split('\n').find((l) => l.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function summarize(l: Located, tz: string): TaskSummary {
  const content = parseTaskContent(l.row.content);
  const id = l.row.seriesId ?? l.row.id;
  return {
    id,
    name: contentName(l.row.content) ?? (firstLine(content.prompt) || id),
    scheduleHuman: humanSchedule(l.row.recurrence, l.row.processAfter, tz),
    nextRunAt: l.row.status === 'paused' ? null : l.row.processAfter,
    status: l.row.status === 'paused' ? 'paused' : 'active',
    // The most recent occurrences decide: a long-ago failure must not leave the chip on forever.
    ...(l.failed > 0 ? { lastResult: 'error' as const } : l.runs > 0 ? { lastResult: 'ok' as const } : {}),
  };
}

export async function listTasks(agentGroupId: string): Promise<TaskSummary[]> {
  const tz = await resolveGroupTimezone(agentGroupId);
  return (await live(agentGroupId)).map((l) => summarize(l, tz));
}

export async function getTaskDetail(agentGroupId: string, id: string): Promise<TaskDetail | undefined> {
  const tz = await resolveGroupTimezone(agentGroupId);
  const l = (await live(agentGroupId)).find((x) => (x.row.seriesId ?? x.row.id) === id);
  if (!l) return undefined;
  const lines = /^[a-z0-9-]+$/.test(id) ? await readRunLogTail(agentGroupId, id, 10) : [];
  const runs: TaskDetail['runs'] = [];
  for (const line of lines) {
    const [stamp, ...rest] = line.split(' — ');
    // Run-log stamps are naive group-local 'YYYY-MM-DD HH:mm'; the API contract is ISO UTC.
    const when = parseZonedToUtc(stamp.trim().replace(' ', 'T'), tz);
    if (Number.isNaN(when.getTime())) continue;
    const note = rest.join(' — ').slice(0, 200);
    const result = /ошиб|error|fail|auto-paused/i.test(note)
      ? ('error' as const)
      : /script-skip|wakeAgent=false|пропущ/i.test(note)
        ? ('silent' as const)
        : ('ok' as const);
    runs.push({ at: when.toISOString(), result, note });
  }
  runs.reverse(); // newest first
  runs.length = Math.min(runs.length, 5);
  return { ...summarize(l, tz), prompt: parseTaskContent(l.row.content).prompt, runs };
}

async function mutate(
  agentGroupId: string,
  id: string | null,
  fn: (db: import('../mailbox/types.js').InboundMailbox, seriesId: string) => number,
): Promise<number> {
  let touched = 0;
  for (const l of await live(agentGroupId)) {
    const sid = l.row.seriesId ?? l.row.id;
    if (id !== null && sid !== id) continue;
    touched += (await withExistingMailboxSession(l.agentGroupId, l.sessionId, (db) => fn(db, sid))) ?? 0;
  }
  return touched;
}

export const pauseTask = (g: string, id: string): Promise<number> => mutate(g, id, (db, sid) => db.pauseTask(sid));

/** Make the series' next occurrence due right now (failure notice «Повторить»). 0 if it is not a future/paused row. */
export const runTaskNow = (g: string, id: string): Promise<number> =>
  mutate(g, id, (db, sid) => db.updateTask(sid, { processAfter: new Date().toISOString() }) + db.resumeTask(sid));

/** Next cron occurrence strictly after now, in `tz`; null for an unparseable expression. */
export function nextCron(recurrence: string, tz: string, from = new Date()): Date | null {
  try {
    return CronExpressionParser.parse(recurrence, { tz, currentDate: from }).next().toDate();
  } catch {
    return null;
  }
}

export interface ResumeOutcome {
  resumed: number;
  /** Overdue one-shot reminders that stayed paused (system resume only): their summaries. */
  skipped: string[];
}

/**
 * Resume paused tasks. A recurring row whose `process_after` already passed is moved to its next
 * cron occurrence first (otherwise every missed occurrence would fire at once). An overdue
 * ONE-SHOT reminder fires on an explicit user resume, but stays paused on a system resume.
 */
export async function resumeTasks(
  agentGroupId: string,
  ids: string[] | null,
  opts: { system?: boolean } = {},
): Promise<ResumeOutcome> {
  const tz = await resolveGroupTimezone(agentGroupId);
  const out: ResumeOutcome = { resumed: 0, skipped: [] };
  for (const l of await live(agentGroupId)) {
    const sid = l.row.seriesId ?? l.row.id;
    if (l.row.status !== 'paused') continue;
    if (ids !== null && !ids.includes(sid)) continue;
    const overdue = l.row.processAfter !== null && Date.parse(l.row.processAfter) < Date.now();
    if (overdue && !l.row.recurrence && opts.system) {
      out.skipped.push(contentName(l.row.content) ?? firstLine(parseTaskContent(l.row.content).prompt) ?? sid);
      continue;
    }
    const n = await withExistingMailboxSession(l.agentGroupId, l.sessionId, (db) => {
      if (overdue && l.row.recurrence) {
        const next = nextCron(l.row.recurrence, tz);
        if (next) db.updateTask(sid, { processAfter: next.toISOString() });
      }
      return db.resumeTask(sid);
    });
    out.resumed += n ?? 0;
  }
  return out;
}

export const resumeTask = async (g: string, id: string): Promise<number> => (await resumeTasks(g, [id])).resumed;

// ---------- system pause (budget exhausted / tenant paused) ----------

const sysKey = (tgId: number): string => `sys-paused:${tgId}`;

async function sysPausedList(tgId: number): Promise<string[]> {
  try {
    const raw = await kvGet(sysKey(tgId));
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Pause every task that is currently running ('pending') and remember exactly which ones, so a later
 * system resume does not revive what the user had paused herself. Returns how many were paused.
 */
export async function pauseAllTasks(agentGroupId: string, tgId: number): Promise<number> {
  const ids = new Set(await sysPausedList(tgId));
  let n = 0;
  for (const l of await live(agentGroupId)) {
    if (l.row.status !== 'pending') continue;
    const sid = l.row.seriesId ?? l.row.id;
    const c = await withExistingMailboxSession(l.agentGroupId, l.sessionId, (db) => db.pauseTask(sid));
    if (c) {
      ids.add(sid);
      n += 1;
    }
  }
  if (ids.size > 0) await kvSet(sysKey(tgId), JSON.stringify([...ids]));
  return n;
}

export async function hasSystemPaused(tgId: number): Promise<boolean> {
  return (await sysPausedList(tgId)).length > 0;
}

/** Resume only what the system paused, then forget the list. */
export async function resumeAllTasks(agentGroupId: string, tgId: number): Promise<ResumeOutcome> {
  const ids = await sysPausedList(tgId);
  if (ids.length === 0) return { resumed: 0, skipped: [] };
  const out = await resumeTasks(agentGroupId, ids, { system: true });
  await kvDelete(sysKey(tgId));
  return out;
}

/** Re-arm recurring rows in a new timezone (cron is read in the group tz). */
export async function rearmRecurring(agentGroupId: string, tz: string): Promise<number> {
  let n = 0;
  for (const l of await live(agentGroupId)) {
    if (!l.row.recurrence) continue;
    const next = nextCron(l.row.recurrence, tz);
    if (!next) continue;
    const sid = l.row.seriesId ?? l.row.id;
    const c = await withExistingMailboxSession(l.agentGroupId, l.sessionId, (db) =>
      db.updateTask(sid, { processAfter: next.toISOString() }),
    );
    n += c ?? 0;
  }
  if (n > 0) log.info('nc: recurring tasks re-armed for new timezone', { agentGroupId, tz, n });
  return n;
}

/** Live series with their trailing failure streak (for the failure sweep). */
export async function failureStreaks(
  agentGroupId: string,
): Promise<Array<{ id: string; name: string; failed: number; status: 'active' | 'paused' }>> {
  const tz = await resolveGroupTimezone(agentGroupId);
  return (await live(agentGroupId)).map((l) => {
    const sum = summarize(l, tz);
    return { id: sum.id, name: sum.name, failed: l.failed, status: sum.status };
  });
}

/** Next-run timestamps and names for a human summary of what a series is called. */
export async function taskName(agentGroupId: string, id: string): Promise<string | undefined> {
  return (await listTasks(agentGroupId)).find((t) => t.id === id)?.name;
}

export async function deleteTask(agentGroupId: string, id: string): Promise<boolean> {
  for (const s of await findTaskSessions(agentGroupId, true)) {
    const found = await withExistingMailboxSession(s.agent_group_id, s.id, (db) => db.getTask(id));
    if (!found) continue;
    if (isContainerRunning(s.id)) throw new Error('task_running');
    if ((await getSession(s.id))?.thread_id === taskThreadId(id)) {
      await destroySessionMailbox(s.agent_group_id, s.id);
      fs.rmSync(sessionDir(s.agent_group_id, s.id), { recursive: true, force: true });
      await deleteSession(s.id);
    } else {
      await withExistingMailboxSession(s.agent_group_id, s.id, (db) => db.deleteTask(id));
    }
    await deleteRunLog(agentGroupId, id).catch(() => undefined);
    return true;
  }
  return false;
}
