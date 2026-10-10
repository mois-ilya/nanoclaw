/**
 * Budget awareness: nanogate status for the gate, the `/events` poller
 * (budget_80 / budget_100 / global_cap), and the 80 % one-line note that the
 * adapter appends to the next final answer (`consumeBudgetNote`).
 */
import { quietOf } from './prefs.js';
import { log } from '../log.js';
import { escapeMd, fmtUsd } from './util.js';
import { nanogateAdmin, type BudgetSnapshot } from '../gateway-providers/nanogate/index.js';
import { copy } from './copy.js';
import { nc, ownerTgId, tgIdOfUserId, USD } from './config.js';
import { hasSystemPaused, pauseAllTasks, resumeAllTasks } from './tasks.js';
import { gateIdOf, kvDelete, kvGet, kvSet, getPrefs, getTenantByTg, audit } from './store.js';
import { tg } from './port.js';

const STATUS_TTL_MS = 10_000;
const cache = new Map<string, { at: number; snap: BudgetSnapshot | null }>();

/** Cached nanogate budget; null when nanogate is unreachable (callers fail open: the proxy still enforces). */
export async function budgetFor(userId: string, fresh = false): Promise<BudgetSnapshot | null> {
  const hit = cache.get(userId);
  if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.snap;
  let snap: BudgetSnapshot | null = null;
  try {
    snap = await nanogateAdmin.budget(userId);
  } catch (err) {
    log.warn('nc: budget lookup failed', { userId, err });
  }
  cache.set(userId, { at: Date.now(), snap });
  return snap;
}

export function invalidateBudget(userId?: string): void {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export function isExhausted(snap: BudgetSnapshot | null): boolean {
  return snap?.status === 'exhausted';
}

export function periodEndLabel(snap: BudgetSnapshot): string {
  const d = new Date(typeof snap.periodEnd === 'number' ? snap.periodEnd : Date.parse(String(snap.periodEnd)));
  if (Number.isNaN(d.getTime())) return 'в начале следующего месяца';
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: nc.defaultTz() }).format(d);
}

// ---------- 80 % note (durable: kv `budget-note:<tg>`, dropped once its period is over) ----------

interface Note {
  text: string;
  /** Epoch ms after which the note is stale (end of the period it was armed in). */
  until: number;
}
const notes = new Map<number, Note>();
const noteKey = (tgId: number): string => `budget-note:${tgId}`;

function periodEndMs(snap: BudgetSnapshot | null): number {
  const v = snap ? (typeof snap.periodEnd === 'number' ? snap.periodEnd : Date.parse(String(snap.periodEnd))) : NaN;
  if (Number.isFinite(v)) return v;
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Reload armed notes after a host restart. */
export async function loadBudgetNotes(): Promise<void> {
  const { listTenants } = await import('./store.js');
  for (const t of await listTenants()) {
    const raw = await kvGet(noteKey(t.tg_id));
    if (!raw) continue;
    try {
      const n = JSON.parse(raw) as Note;
      if (typeof n.text === 'string' && n.until > Date.now()) notes.set(t.tg_id, n);
      else await kvDelete(noteKey(t.tg_id));
    } catch {
      await kvDelete(noteKey(t.tg_id));
    }
  }
}

/** One-shot: the 80 % line for the next final answer to this chat, if armed and still current. */
export function consumeBudgetNote(chatId: number): string | undefined {
  const n = notes.get(chatId);
  if (!n) return undefined;
  notes.delete(chatId);
  void kvDelete(noteKey(chatId)).catch(() => undefined);
  return n.until > Date.now() ? n.text : undefined;
}

// ---------- global cap flag ----------

let capUntil = 0;
const CAP_KEY = 'globalCapUntil';

/** Epoch ms until which the installation cap blocks everything; null when not capped. */
export function globalCapUntil(): number | null {
  return capUntil > Date.now() ? capUntil : null;
}

export function resetGlobalCapForTests(): void {
  capUntil = 0;
}

export async function loadGlobalCap(): Promise<void> {
  const v = Number(await kvGet(CAP_KEY));
  capUntil = Number.isFinite(v) ? v : 0;
}

function nextUtcMonthStart(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

export function globalCapCopy(owner: boolean): string {
  const until = globalCapUntil();
  const when = until
    ? new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(until))
    : 'начала следующего месяца';
  return owner
    ? `Общий лимит расхода по установке исчерпан до ${when}. Подними его в настройках сервера или подожди.`
    : `Лимит установки исчерпан до ${when}. Я отвечу, как только он обновится.`;
}

// ---------- events ----------

let lastSeen = 0;
let timer: NodeJS.Timeout | undefined;

const SYSTEM_BUTTON = [[{ text: 'Открыть «Система»', webApp: 'system' }]];

export async function handleBudgetEvent(e: { tenantId: string; type: string; payload?: unknown }): Promise<void> {
  const tgId = tgIdOfUserId(e.tenantId);
  const owner = ownerTgId();
  invalidateBudget(e.tenantId);

  if (e.type === 'global_cap' || e.type === 'global_80') {
    if (e.type === 'global_cap') {
      capUntil = nextUtcMonthStart();
      await kvSet(CAP_KEY, String(capUntil));
    }
    if (owner) {
      const p = (e.payload ?? {}) as { usedMicros?: number; capMicros?: number };
      const nums =
        typeof p.usedMicros === 'number' && typeof p.capMicros === 'number'
          ? ` (${fmtUsd(p.usedMicros)} из ${fmtUsd(p.capMicros)})`
          : '';
      const md =
        e.type === 'global_cap'
          ? `⚠️ Достигнут общий лимит расхода по установке${nums}. ${globalCapCopy(true)}`
          : `💡 Общий расход по установке дошёл до 80 %${nums}.`;
      // Rethrow: the poller then keeps the event un-acked and retries instead of losing the alert.
      await tg.sendProduct(owner, md, { buttons: SYSTEM_BUTTON, silent: e.type === 'global_80' });
    }
    return;
  }
  if (tgId === null || tgId === owner) return;
  const t = await getTenantByTg(tgId);
  if (!t || t.state !== 'ready') return;
  const snap = await budgetFor(e.tenantId, true);
  const limit = snap?.limitMicros ?? t.limit_usd_micros ?? 0;

  if (e.type === 'budget_80') {
    const note: Note = {
      text: copy.budgetNote80(snap?.usedMicros ?? Math.round(limit * 0.8), limit),
      until: periodEndMs(snap),
    };
    notes.set(tgId, note);
    await kvSet(noteKey(tgId), JSON.stringify(note));
    return;
  }
  if (e.type === 'budget_100') {
    const resets = snap ? periodEndLabel(snap) : 'в начале следующего месяца';
    // Pause first (idempotent) so a retried notice does not redo it.
    if (t.agent_group_id) await pauseAllTasks(t.agent_group_id, tgId).catch(() => 0);
    await tg.sendProduct(tgId, copy.budgetExhausted(limit, resets), {
      buttons: [[{ text: `Попросить ${nc.ownerNameGen()} поднять`, data: `p:rl:${tgId}` }]],
    });
    if (owner) {
      await tg
        .sendProduct(owner, `**${escapeMd(t.name, 80)}** исчерпал(а) лимит ${fmtUsd(limit)}/мес.`, {
          silent: true,
          buttons: [
            [
              { text: `Лимит → ${fmtUsd(limit + 5 * USD)}`, data: `p:ra:${tgId}:5` },
              { text: `Лимит → ${fmtUsd(limit + 10 * USD)}`, data: `p:ra:${tgId}:10` },
            ],
          ],
        })
        .catch((err) => log.warn('nc: owner budget_100 notice failed', { err }));
    }
    await audit('system', 'budget_100', e.tenantId);
  }
}

const eventTries = new Map<number, number>();
const MAX_EVENT_TRIES = 5;

export async function pollBudgetEventsOnce(): Promise<void> {
  const events = await nanogateAdmin.events(lastSeen);
  let max = lastSeen;
  for (const e of events.slice().sort((a, b) => a.id - b.id)) {
    if (e.id <= lastSeen) continue;
    try {
      await handleBudgetEvent(e);
    } catch (err) {
      const n = (eventTries.get(e.id) ?? 0) + 1;
      eventTries.set(e.id, n);
      log.warn('nc: budget event handler failed', { type: e.type, attempt: n, err });
      // Not delivered: stop here so the event (and everything after it) is retried on the next poll.
      if (n < MAX_EVENT_TRIES) break;
    }
    eventTries.delete(e.id);
    max = Math.max(max, e.id);
  }
  if (max > lastSeen) {
    lastSeen = max;
    await nanogateAdmin.ackEvents(max);
  }
}

/** True while `now` falls into the user's quiet hours (HH:MM..HH:MM in their tz; may wrap midnight). */
export function inQuietHours(from: string | null, to: string | null, tz: string, now = new Date()): boolean {
  if (!from || !to || !/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) return false;
  let hm: string;
  try {
    hm = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(
      now,
    );
  } catch {
    return false;
  }
  const mins = (s: string): number => Number(s.split(':')[0]) * 60 + Number(s.split(':')[1]);
  const cur = mins(hm);
  const a = mins(from);
  const b = mins(to);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

/** Resume tasks that were paused by budget_100 once the new period has begun (never in quiet hours). */
export async function resumeBudgetPausedTasks(): Promise<void> {
  const { listTenants } = await import('./store.js');
  for (const t of await listTenants()) {
    if (t.state !== 'ready' || !t.agent_group_id) continue;
    if (!(await hasSystemPaused(t.tg_id))) continue;
    const snap = await budgetFor(gateIdOf(t), true);
    if (!snap || isExhausted(snap)) continue;
    const prefs = await getPrefs(t.user_id, { tz: nc.defaultTz() });
    const quiet = quietOf(prefs);
    if (quiet && inQuietHours(quiet.from, quiet.to, prefs.tz)) continue;
    const out = await resumeAllTasks(t.agent_group_id, t.tg_id).catch(() => null);
    if (out && out.skipped.length > 0) {
      const list = out.skipped.map((n) => `«${escapeMd(n, 60)}»`).join(', ');
      await tg
        .sendProduct(
          t.tg_id,
          `Пока был лимит, пропущено ${out.skipped.length} ${out.skipped.length === 1 ? 'напоминание' : 'напоминаний'}: ${list}.`,
          { silent: true },
        )
        .catch(() => undefined);
    }
  }
}

export function startBudgetPolling(intervalMs = 10_000): void {
  if (timer) return;
  let ticks = 0;
  void loadBudgetNotes().catch(() => undefined);
  void loadGlobalCap().catch(() => undefined);
  timer = setInterval(() => {
    void pollBudgetEventsOnce().catch(() => undefined);
    if (++ticks % 30 === 0) void resumeBudgetPausedTasks().catch(() => undefined);
  }, intervalMs);
  timer.unref();
}

export function stopBudgetPolling(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
