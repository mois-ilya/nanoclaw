import type { Db } from './db.js';
import { insertEvent } from './db.js';
import type { PriceTable, Usage } from './pricing.js';

export interface Period {
  start: number;
  end: number;
}

function tzOffsetMs(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function monthStart(y: number, m: number, tz: string): number {
  const guess = Date.UTC(y, m, 1);
  const off1 = tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(guess - off1, tz);
}

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Calendar-month bounds in the tenant's timezone, as epoch ms [start, end). */
export function periodBounds(tz: string, now: number): Period {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric' });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(now))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const y = p.year!;
  const m = p.month! - 1;
  return { start: monthStart(y, m, tz), end: monthStart(m === 11 ? y + 1 : y, (m + 1) % 12, tz) };
}

const used = (db: Db, tenantId: string, per: Period): number =>
  (db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM usage WHERE tenant_id=? AND started_at>=? AND started_at<?')
    .get(tenantId, per.start, per.end) as { s: number }).s;

const openReserved = (db: Db, tenantId: string): number =>
  (db.prepare("SELECT COALESCE(SUM(reserved_micros),0) AS s FROM reservations WHERE tenant_id=? AND status='open'")
    .get(tenantId) as { s: number }).s;

export function budgetSnapshot(db: Db, tenantId: string, limit: number | null, tz: string, now = Date.now()) {
  const per = periodBounds(tz, now);
  const usedMicros = used(db, tenantId, per);
  const reservedMicros = openReserved(db, tenantId);
  // Requests are refused on a worst-case reserve, so the settled total can stay below the limit: a recorded
  // denial at this (or a higher) limit also counts as exhausted. Raising the limit clears it.
  const denied = limit !== null && deniedAtLimit(db, tenantId, per.start, limit);
  // Open reservations are worst-case and transient: they never make the month "exhausted" on their own.
  const status = limit === null ? 'ok' : usedMicros >= limit || denied ? 'exhausted' : usedMicros * 100 >= limit * 80 ? 'warn' : 'ok';
  return { limitMicros: limit, usedMicros, reservedMicros, periodStart: per.start, periodEnd: per.end, status };
}

const deniedAtLimit = (db: Db, tenantId: string, periodStart: number, limit: number): boolean =>
  !!db.prepare("SELECT 1 FROM events WHERE tenant_id=? AND type='budget_100' AND json_extract(payload_json,'$.periodStart')=? AND json_extract(payload_json,'$.limitMicros')>=?")
    .get(tenantId, periodStart, limit);

export interface ReserveInput {
  id: string;
  tenantId: string;
  tokenHash: string;
  requestId: string;
  model: string;
  /** informational label from the agent; never used for any cap */
  turnId: string | null;
  /** session_key of the token (null for host tokens) */
  sessionKey: string | null;
  /** worst-case cost of the request as sent */
  reserve: number;
  /**
   * How the reserve scales with max_tokens (reserve = base + perToken * maxTokens). When the full reserve does not fit
   * what is left, max_tokens is lowered to fit, down to minTokens, instead of refusing the request.
   */
  clamp?: { base: number; perToken: number; maxTokens: number; minTokens: number };
  limit: number | null;
  tz: string;
  /** cap on this token's spend (settled + open reservations) inside the rolling window; null = none */
  windowCap: number | null;
  windowMs: number;
  globalCap: number | null;
  now: number;
}

/** Retry hint for a transient refusal (the tenant's or the installation's own requests are in flight). */
const BUSY_RETRY_MS = 10_000;

export type ReserveResult =
  | { ok: true; reserve: number; maxTokens?: number }
  | { ok: false; reason: 'budget' | 'budget_busy' | 'turn' | 'global' | 'global_busy'; resetAt: number };

/**
 * Atomic check + insert (BEGIN IMMEDIATE).
 *
 * The reserve is a worst-case bound (full max_tokens, dearest input rate), so settled spend stays well below what was
 * reserved. To let a budget actually be used up, a request whose full reserve does not fit what is left is admitted
 * with a lower max_tokens (see ReserveInput.clamp). Only when not even minTokens fit is it refused:
 * - own requests still in flight → transient (budget_busy / global_busy, retry soon);
 * - nothing in flight → the money is really gone: the hard stop (budget_100 / global_cap event, final for the period).
 */
export function reserveBudget(db: Db, i: ReserveInput): ReserveResult {
  const tx = db.transaction((): ReserveResult => {
    const per = periodBounds(i.tz, i.now);
    const g = periodBounds('UTC', i.now);
    let tenantOpen = 0;
    let globalOpen = 0;
    let tenantUsed = 0;
    const room: Array<{ kind: 'budget' | 'global' | 'turn'; avail: number }> = [];
    if (i.limit !== null) {
      tenantUsed = used(db, i.tenantId, per);
      tenantOpen = openReserved(db, i.tenantId);
      room.push({ kind: 'budget', avail: i.limit - tenantUsed - tenantOpen });
    }
    if (i.globalCap !== null) {
      const gu = (db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM usage WHERE started_at>=? AND started_at<?').get(g.start, g.end) as { s: number }).s;
      globalOpen = (db.prepare("SELECT COALESCE(SUM(reserved_micros),0) AS s FROM reservations WHERE status='open'").get() as { s: number }).s;
      room.push({ kind: 'global', avail: i.globalCap - gu - globalOpen });
    }
    if (i.windowCap !== null) {
      // Server-side only: derived from the ledger, so the agent cannot reset it by changing or omitting a header.
      const spent =
        (db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM usage WHERE tenant_id=? AND session_key IS ? AND started_at>=?').get(i.tenantId, i.sessionKey, i.now - i.windowMs) as { s: number }).s +
        (db.prepare("SELECT COALESCE(SUM(reserved_micros),0) AS s FROM reservations WHERE tenant_id=? AND token_hash=? AND status='open'").get(i.tenantId, i.tokenHash) as { s: number }).s;
      room.push({ kind: 'turn', avail: i.windowCap - spent });
    }
    const avail = room.reduce((m, r) => Math.min(m, r.avail), Infinity);

    let reserve = i.reserve;
    let maxTokens = i.clamp?.maxTokens;
    if (reserve > avail && i.clamp && i.clamp.perToken > 0) {
      const fit = Math.floor((avail - i.clamp.base) / i.clamp.perToken);
      if (fit >= i.clamp.minTokens) {
        maxTokens = Math.min(i.clamp.maxTokens, fit);
        reserve = Math.ceil(i.clamp.base + i.clamp.perToken * maxTokens);
      }
    }
    if (reserve > avail) {
      // The tightest constraint decides the refusal (ties: budget, then global, then the window cap).
      const binding = room.filter((r) => r.avail === avail)[0]!.kind;
      if (binding === 'turn') return { ok: false, reason: 'turn', resetAt: per.end };
      if (binding === 'budget') {
        if (tenantOpen > 0) return { ok: false, reason: 'budget_busy', resetAt: i.now + BUSY_RETRY_MS };
        if (!db.prepare("SELECT 1 FROM events WHERE tenant_id=? AND type='budget_100' AND json_extract(payload_json,'$.periodStart')=? AND json_extract(payload_json,'$.limitMicros')=?").get(i.tenantId, per.start, i.limit)) {
          insertEvent(db, i.tenantId, 'budget_100', { periodStart: per.start, periodEnd: per.end, usedMicros: tenantUsed, limitMicros: i.limit, denied: true });
        }
        return { ok: false, reason: 'budget', resetAt: per.end };
      }
      if (globalOpen > 0) return { ok: false, reason: 'global_busy', resetAt: i.now + BUSY_RETRY_MS };
      const seen = db.prepare("SELECT 1 FROM events WHERE type='global_cap' AND json_extract(payload_json,'$.periodStart')=?").get(g.start);
      if (!seen) insertEvent(db, 'global', 'global_cap', { periodStart: g.start });
      return { ok: false, reason: 'global', resetAt: g.end };
    }
    db.prepare(
      "INSERT INTO reservations(id, tenant_id, token_hash, request_id, model, turn_id, reserved_micros, status, created_at) VALUES (?,?,?,?,?,?,?,'open',?)",
    ).run(i.id, i.tenantId, i.tokenHash, i.requestId, i.model, i.turnId, reserve, i.now);
    return { ok: true, reserve, maxTokens };
  });
  return tx.immediate();
}

export interface SettleInput {
  reservationId: string | null;
  requestId: string;
  tenantId: string;
  sessionKey: string | null;
  purpose: string | null;
  turnId: string | null;
  model: string;
  usage: Usage;
  costMicros: number;
  prices: PriceTable;
  status: 'reconciled' | 'estimated';
  /** reservation final status */
  reservation: 'settled' | 'abandoned';
  startedAt: number;
  limit: number | null;
  tz: string;
}

export function settle(db: Db, s: SettleInput): void {
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO usage(request_id, tenant_id, session_key, purpose, turn_id, model, service_tier, input_tokens, output_tokens,
        cache_creation_5m, cache_creation_1h, cache_read, server_tool_json, cost_micros, price_version, status, started_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      s.requestId, s.tenantId, s.sessionKey, s.purpose, s.turnId, s.model, s.usage.serviceTier, s.usage.input, s.usage.output,
      s.usage.cacheCreation5m, s.usage.cacheCreation1h, s.usage.cacheRead, JSON.stringify(s.usage.serverTools), s.costMicros,
      s.prices.version, s.status, s.startedAt, now,
    );
    if (s.reservationId) {
      db.prepare("UPDATE reservations SET status=?, settled_at=? WHERE id=? AND status='open'").run(s.reservation, now, s.reservationId);
    }
    checkThresholds(db, s.tenantId, s.limit, s.tz, now);
  })();
}

/** Insert budget_80 / budget_100 once per period each. */
export function checkThresholds(db: Db, tenantId: string, limit: number | null, tz: string, now: number): void {
  if (limit === null || limit <= 0) return;
  const per = periodBounds(tz, now);
  const u = used(db, tenantId, per);
  for (const [pct, type] of [[80, 'budget_80'], [100, 'budget_100']] as const) {
    if (u * 100 < limit * pct) continue;
    const seen = db.prepare('SELECT 1 FROM events WHERE tenant_id=? AND type=? AND json_extract(payload_json,\'$.periodStart\')=?').get(tenantId, type, per.start);
    if (!seen) insertEvent(db, tenantId, type, { periodStart: per.start, periodEnd: per.end, usedMicros: u, limitMicros: limit });
  }
}

/**
 * On start, any reservation still open belongs to a dead process: charge it as estimated. While running, the
 * periodic sweep passes the ids of requests still in flight in `skip`; anything else open (e.g. a settlement
 * that failed) is charged conservatively at the reserved amount.
 */
export function sweepOpenReservations(db: Db, prices: PriceTable, skip?: ReadonlySet<string>): number {
  const rows = (db.prepare("SELECT * FROM reservations WHERE status='open'").all() as {
    id: string; tenant_id: string; request_id: string; model: string; turn_id: string | null; reserved_micros: number; created_at: number;
  }[]).filter((r) => !skip?.has(r.id));
  const ins = db.prepare(
    `INSERT OR IGNORE INTO usage(request_id, tenant_id, session_key, purpose, turn_id, model, service_tier, input_tokens, output_tokens,
      cache_creation_5m, cache_creation_1h, cache_read, server_tool_json, cost_micros, price_version, status, started_at, ended_at)
     VALUES (?,?,NULL,NULL,?,?,NULL,0,0,0,0,0,'{}',?,?,'estimated',?,?)`,
  );
  const upd = db.prepare("UPDATE reservations SET status='abandoned', settled_at=? WHERE id=?");
  const now = Date.now();
  db.transaction(() => {
    for (const r of rows) {
      ins.run(r.request_id, r.tenant_id, r.turn_id, r.model, r.reserved_micros, prices.version, r.created_at, now);
      upd.run(now, r.id);
    }
  })();
  return rows.length;
}
