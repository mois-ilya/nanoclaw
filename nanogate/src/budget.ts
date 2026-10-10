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
  const status = limit === null ? 'ok' : usedMicros + reservedMicros >= limit || denied ? 'exhausted' : usedMicros * 100 >= limit * 80 ? 'warn' : 'ok';
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
  reserve: number;
  limit: number | null;
  tz: string;
  /** cap on this token's spend (settled + open reservations) inside the rolling window; null = none */
  windowCap: number | null;
  windowMs: number;
  globalCap: number | null;
  now: number;
}

/** Retry hint for a transient refusal (own requests in flight, or a reservation larger than what is left). */
const BUSY_RETRY_MS = 10_000;

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'budget' | 'budget_busy' | 'turn' | 'global'; resetAt: number };

/** Atomic check + insert (BEGIN IMMEDIATE). */
export function reserveBudget(db: Db, i: ReserveInput): ReserveResult {
  const tx = db.transaction((): ReserveResult => {
    const per = periodBounds(i.tz, i.now);
    if (i.limit !== null) {
      const u = used(db, i.tenantId, per);
      const open = openReserved(db, i.tenantId);
      if (u + open + i.reserve > i.limit) {
        // The hard stop (budget_100, "exhausted" until the period or limit changes) is recorded only when the
        // tenant's own in-flight requests are not what pushed it over: a refusal caused by parallel requests is
        // transient and must not end the month for a friend who still has money left. With nothing in flight,
        // what is left cannot cover a single request, so that refusal is final.
        const exhausted = open === 0;
        if (!exhausted) return { ok: false, reason: 'budget_busy', resetAt: i.now + BUSY_RETRY_MS };
        if (!db.prepare("SELECT 1 FROM events WHERE tenant_id=? AND type='budget_100' AND json_extract(payload_json,'$.periodStart')=? AND json_extract(payload_json,'$.limitMicros')=?").get(i.tenantId, per.start, i.limit)) {
          insertEvent(db, i.tenantId, 'budget_100', { periodStart: per.start, periodEnd: per.end, usedMicros: u, limitMicros: i.limit, denied: true });
        }
        return { ok: false, reason: 'budget', resetAt: per.end };
      }
    }
    if (i.windowCap !== null) {
      // Server-side only: derived from the ledger, so the agent cannot reset it by changing or omitting a header.
      const spent =
        (db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM usage WHERE tenant_id=? AND session_key IS ? AND started_at>=?').get(i.tenantId, i.sessionKey, i.now - i.windowMs) as { s: number }).s +
        (db.prepare("SELECT COALESCE(SUM(reserved_micros),0) AS s FROM reservations WHERE tenant_id=? AND token_hash=? AND status='open'").get(i.tenantId, i.tokenHash) as { s: number }).s;
      if (spent + i.reserve > i.windowCap) return { ok: false, reason: 'turn', resetAt: per.end };
    }
    if (i.globalCap !== null) {
      const g = periodBounds('UTC', i.now);
      const gu = (db.prepare('SELECT COALESCE(SUM(cost_micros),0) AS s FROM usage WHERE started_at>=? AND started_at<?').get(g.start, g.end) as { s: number }).s;
      const go = (db.prepare("SELECT COALESCE(SUM(reserved_micros),0) AS s FROM reservations WHERE status='open'").get() as { s: number }).s;
      if (gu + go + i.reserve > i.globalCap) {
        const seen = db.prepare("SELECT 1 FROM events WHERE type='global_cap' AND json_extract(payload_json,'$.periodStart')=?").get(g.start);
        if (!seen) insertEvent(db, 'global', 'global_cap', { periodStart: g.start });
        return { ok: false, reason: 'global', resetAt: g.end };
      }
    }
    db.prepare(
      "INSERT INTO reservations(id, tenant_id, token_hash, request_id, model, turn_id, reserved_micros, status, created_at) VALUES (?,?,?,?,?,?,?,'open',?)",
    ).run(i.id, i.tenantId, i.tokenHash, i.requestId, i.model, i.turnId, i.reserve, i.now);
    return { ok: true };
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
