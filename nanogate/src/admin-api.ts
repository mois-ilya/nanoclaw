import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { Ctx } from './context.js';
import { budgetSnapshot, validTz } from './budget.js';
import { type TenantRow, getConnector, getTenant } from './db.js';
import { normalizePolicy } from './policy.js';
import { decrypt, encrypt, insertToken, mintToken, revokeTokens } from './tokens.js';
import { validConnectorCidr } from './cidr.js';

class HttpError extends Error {
  constructor(public status: number, public code: string) {
    super(code);
  }
}

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body: unknown;
}
type Handler = (ctx: Ctx, m: RegExpMatchArray, q: URLSearchParams, body: Json) => Reply | Promise<Reply>;

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ok = (body: unknown = { ok: true }, status = 200): Reply => ({ status, body });
const needStr = (v: unknown, name: string): string => {
  if (typeof v !== 'string' || !v || v.length > 512) throw new HttpError(400, `${name} required`);
  return v;
};
const tenantOr404 = (ctx: Ctx, id: string): TenantRow => {
  const t = getTenant(ctx.db, id);
  if (!t) throw new HttpError(404, 'tenant_not_found');
  return t;
};

function setStatus(ctx: Ctx, id: string, status: string): void {
  ctx.db.prepare('UPDATE tenants SET status=?, updated_at=? WHERE id=?').run(status, Date.now(), id);
}

const routes: [string, RegExp, Handler][] = [
  ['GET', /^\/healthz$/, (ctx) => {
    let keyReadable = false;
    let dbWritable = false;
    try {
      fs.accessSync(ctx.config.anthropicKeyFile, fs.constants.R_OK);
      keyReadable = fs.readFileSync(ctx.config.anthropicKeyFile, 'utf8').trim().length > 0;
    } catch {
      // reported below
    }
    try {
      ctx.db.exec('BEGIN IMMEDIATE; ROLLBACK');
      fs.accessSync(`${ctx.config.stateDir}/nanogate.db`, fs.constants.W_OK);
      dbWritable = true;
    } catch {
      // reported below
    }
    const okAll = keyReadable && dbWritable;
    return { status: okAll ? 200 : 503, body: { ok: okAll, upstreamKeyReadable: keyReadable, dbWritable } };
  }],

  ['PUT', /^\/tenants\/([^/]+)$/, (ctx, m, _q, b) => {
    const id = m[1]!;
    if (!ID.test(id)) throw new HttpError(400, 'bad_tenant_id');
    const kind = b.kind;
    if (kind !== 'owner' && kind !== 'friend' && kind !== 'guest' && kind !== 'system') throw new HttpError(400, 'bad_kind');
    const existing = getTenant(ctx.db, id);
    if (existing?.status === 'revoked') throw new HttpError(409, 'tenant_revoked');
    const status = b.status ?? existing?.status ?? 'active';
    if (status !== 'active' && status !== 'paused') throw new HttpError(400, 'bad_status');
    let policy;
    try {
      policy = normalizePolicy(b.policy);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const ct = policy.egress.connectorTenant;
    if (ct && ct !== id && !getTenant(ctx.db, ct)) throw new HttpError(400, 'unknown_connectorTenant');
    const limit = b.budgetLimitMicros;
    if (limit !== null && (!Number.isInteger(limit) || (limit as number) < 0)) throw new HttpError(400, 'bad_budgetLimitMicros');
    const tz = (b.periodTz ?? 'UTC') as string;
    if (typeof tz !== 'string' || !validTz(tz)) throw new HttpError(400, 'bad_periodTz');
    const now = Date.now();
    const oldPolicy = (ctx.db.prepare('SELECT policy_json FROM tenants WHERE id=?').get(id) as { policy_json: string } | undefined)?.policy_json;
    ctx.db.prepare(
      `INSERT INTO tenants(id, kind, status, epoch, policy_json, budget_period, budget_limit_micros, period_tz, created_at, updated_at)
       VALUES (?,?,?,0,?,'month',?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, status=excluded.status, policy_json=excluded.policy_json,
         budget_limit_micros=excluded.budget_limit_micros, period_tz=excluded.period_tz, updated_at=excluded.updated_at`,
    ).run(id, kind, status, JSON.stringify(policy), limit, tz, now, now);
    // Tunnels were admitted under the old policy (tailnet, ports, connector choice): when it changes, drop all of
    // this tenant's tunnels (pending ones included) and let clients reconnect under the new one.
    if (status === 'paused' || (oldPolicy !== undefined && oldPolicy !== JSON.stringify(policy))) ctx.live.killTenant(id, ['tunnel']);
    return ok({ ok: true, id });
  }],
  ['POST', /^\/tenants\/([^/]+)\/pause$/, (ctx, m) => {
    const t = tenantOr404(ctx, m[1]!);
    if (t.status === 'revoked') throw new HttpError(409, 'tenant_revoked');
    setStatus(ctx, t.id, 'paused');
    ctx.live.killTenant(t.id, ['tunnel']);
    return ok();
  }],
  ['POST', /^\/tenants\/([^/]+)\/resume$/, (ctx, m) => {
    const t = tenantOr404(ctx, m[1]!);
    if (t.status === 'revoked') throw new HttpError(409, 'tenant_revoked');
    setStatus(ctx, t.id, 'active');
    return ok();
  }],
  ['POST', /^\/tenants\/([^/]+)\/revoke$/, (ctx, m) => {
    const t = tenantOr404(ctx, m[1]!);
    ctx.db.transaction(() => {
      ctx.db.prepare("UPDATE tenants SET status='revoked', epoch=epoch+1, updated_at=? WHERE id=?").run(Date.now(), t.id);
      revokeTokens(ctx.db, 'tenant_id = ?', t.id);
    })();
    const killed = ctx.live.killTenant(t.id);
    return ok({ ok: true, killed });
  }],

  ['POST', /^\/sessions\/ensure$/, (ctx, _m, _q, b) => {
    const tenantId = needStr(b.tenantId, 'tenantId');
    const sessionKey = needStr(b.sessionKey, 'sessionKey');
    const runtimeIdentity = typeof b.runtimeIdentity === 'string' ? b.runtimeIdentity : null;
    if (b.disposition !== 'create' && b.disposition !== 'adopt') throw new HttpError(400, 'bad_disposition');
    const t = tenantOr404(ctx, tenantId);
    const live = ctx.db.prepare("SELECT enc, tenant_id, epoch FROM tokens WHERE kind='session' AND session_key=? AND revoked_at IS NULL")
      .get(sessionKey) as { enc: string; tenant_id: string; epoch: number } | undefined;
    if (live && (live.tenant_id !== tenantId || live.epoch !== t.epoch)) throw new HttpError(409, 'session_key_conflict');
    const purpose = b.purpose === 'task' ? 'task' : b.purpose === undefined || b.purpose === 'agent' ? null : undefined;
    if (purpose === undefined) throw new HttpError(400, 'bad_purpose');
    if (live) {
      if (b.purpose !== undefined) ctx.db.prepare("UPDATE tokens SET purpose=? WHERE kind='session' AND session_key=? AND revoked_at IS NULL").run(purpose, sessionKey);
      if (runtimeIdentity) ctx.db.prepare("UPDATE tokens SET runtime_identity=? WHERE kind='session' AND session_key=? AND revoked_at IS NULL").run(runtimeIdentity, sessionKey);
      return ok({ token: decrypt(ctx.encKey, live.enc), created: false });
    }
    if (b.disposition === 'adopt') throw new HttpError(409, 'no_session_token'); // adopt never mints
    if (t.status !== 'active') throw new HttpError(403, 'tenant_not_active');
    const token = mintToken('session');
    insertToken(ctx.db, { token, kind: 'session', tenantId, epoch: t.epoch, enc: encrypt(ctx.encKey, token), sessionKey, ...(purpose ? { purpose } : {}), ...(runtimeIdentity ? { runtimeIdentity } : {}) });
    return ok({ token, created: true });
  }],
  ['POST', /^\/sessions\/release$/, (ctx, _m, _q, b) => {
    const sessionKey = needStr(b.sessionKey, 'sessionKey');
    if (b.kind === 'host-detached') {
      ctx.log({ msg: 'session_host_detached', sessionKey });
      return ok({ ok: true, revoked: 0 });
    }
    if (b.kind !== 'session-ended') throw new HttpError(400, 'bad_kind');
    const rows = revokeTokens(ctx.db, "kind='session' AND session_key = ?", sessionKey);
    for (const r of rows) ctx.live.killToken(r.hash);
    return ok({ ok: true, revoked: rows.length });
  }],
  ['GET', /^\/sessions$/, (ctx) => {
    const rows = ctx.db.prepare("SELECT session_key, tenant_id, runtime_identity FROM tokens WHERE kind='session' AND revoked_at IS NULL").all() as
      { session_key: string; tenant_id: string; runtime_identity: string | null }[];
    return ok({ sessions: rows.map((r) => ({ sessionKey: r.session_key, tenantId: r.tenant_id, runtimeIdentity: r.runtime_identity })) });
  }],
  ['POST', /^\/sessions\/reconcile$/, (ctx, _m, _q, b) => {
    if (!Array.isArray(b.liveSessionKeys) || b.liveSessionKeys.some((k) => typeof k !== 'string')) throw new HttpError(400, 'bad_liveSessionKeys');
    const keep = new Set(b.liveSessionKeys as string[]);
    const all = ctx.db.prepare("SELECT hash, session_key FROM tokens WHERE kind='session' AND revoked_at IS NULL").all() as { hash: string; session_key: string }[];
    const revoked: string[] = [];
    const upd = ctx.db.prepare('UPDATE tokens SET revoked_at=? WHERE hash=?');
    for (const r of all) {
      if (keep.has(r.session_key)) continue;
      upd.run(Date.now(), r.hash);
      ctx.live.killToken(r.hash);
      revoked.push(r.session_key);
    }
    return ok({ revoked });
  }],

  ['POST', /^\/host-tokens$/, (ctx, _m, _q, b) => {
    const t = tenantOr404(ctx, needStr(b.tenantId, 'tenantId'));
    if (!['stt', 'guest', 'miniapp', 'system'].includes(b.purpose as string)) throw new HttpError(400, 'bad_purpose');
    if (t.status === 'revoked') throw new HttpError(409, 'tenant_revoked');
    const token = mintToken('host');
    const hash = insertToken(ctx.db, { token, kind: 'host', tenantId: t.id, epoch: t.epoch, purpose: b.purpose as string });
    return ok({ token, hashPrefix: hash.slice(0, 12) }, 201);
  }],
  ['DELETE', /^\/host-tokens\/([0-9a-f]{8,64})$/, (ctx, m) => {
    const prefix = m[1]!;
    const rows = ctx.db.prepare("SELECT hash FROM tokens WHERE kind='host' AND revoked_at IS NULL AND hash LIKE ?").all(`${prefix}%`) as { hash: string }[];
    if (rows.length === 0) throw new HttpError(404, 'not_found');
    if (rows.length > 1) throw new HttpError(409, 'ambiguous_prefix');
    revokeTokens(ctx.db, 'hash = ?', rows[0]!.hash);
    ctx.live.killToken(rows[0]!.hash);
    return ok();
  }],

  ['GET', /^\/usage$/, (ctx, _m, q) => {
    const groupBy = q.get('groupBy');
    const col = { day: "strftime('%Y-%m-%d', started_at/1000, 'unixepoch')", model: 'model', purpose: 'COALESCE(purpose, \'\')', session: 'COALESCE(session_key, \'\')' }[groupBy ?? ''];
    if (groupBy && !col) throw new HttpError(400, 'bad_groupBy');
    const where: string[] = [];
    const args: unknown[] = [];
    const tid = q.get('tenantId');
    if (tid) { where.push('tenant_id = ?'); args.push(tid); }
    const ts = (s: string | null): number | null => {
      if (!s) return null;
      const n = /^\d+$/.test(s) ? Number(s) : Date.parse(s);
      if (!Number.isFinite(n)) throw new HttpError(400, 'bad_time');
      return n;
    };
    const from = ts(q.get('from'));
    const to = ts(q.get('to'));
    if (from !== null) { where.push('started_at >= ?'); args.push(from); }
    if (to !== null) { where.push('started_at < ?'); args.push(to); }
    const sql = `SELECT ${col ? `${col} AS key,` : ''} COUNT(*) AS requests, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
      SUM(cache_creation_5m) AS cache_creation_5m, SUM(cache_creation_1h) AS cache_creation_1h, SUM(cache_read) AS cache_read,
      SUM(cost_micros) AS cost_micros, SUM(status='estimated') AS estimated_requests
      FROM usage ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${col ? 'GROUP BY key ORDER BY key' : ''}`;
    return ok({ rows: ctx.db.prepare(sql).all(...args) });
  }],
  ['GET', /^\/budget\/([^/]+)$/, (ctx, m) => {
    const t = tenantOr404(ctx, m[1]!);
    return ok(budgetSnapshot(ctx.db, t.id, t.budgetLimitMicros, t.periodTz));
  }],

  ['GET', /^\/events$/, (ctx, _m, q) => {
    const after = Number(q.get('after') ?? 0);
    const rows = ctx.db.prepare('SELECT id, tenant_id, type, payload_json, created_at FROM events WHERE id > ? AND acked = 0 ORDER BY id LIMIT 500').all(Number.isFinite(after) ? after : 0) as
      { id: number; tenant_id: string; type: string; payload_json: string; created_at: number }[];
    return ok({ events: rows.map((r) => ({ id: r.id, tenantId: r.tenant_id, type: r.type, payload: JSON.parse(r.payload_json), createdAt: r.created_at })) });
  }],
  ['POST', /^\/events\/ack$/, (ctx, _m, _q, b) => {
    if (!Number.isInteger(b.upTo)) throw new HttpError(400, 'bad_upTo');
    const r = ctx.db.prepare('UPDATE events SET acked=1 WHERE id <= ?').run(b.upTo);
    return ok({ ok: true, acked: r.changes });
  }],

  // Secrets are write-only: no route ever returns a value.
  ['PUT', /^\/secrets\/([^/]+)\/([^/]+)$/, (ctx, m, _q, b) => {
    tenantOr404(ctx, m[1]!);
    const value = needStr(b.value, 'value');
    if (!ID.test(m[2]!)) throw new HttpError(400, 'bad_name');
    ctx.db.prepare('INSERT INTO secrets(tenant_id, name, enc, updated_at) VALUES (?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET enc=excluded.enc, updated_at=excluded.updated_at')
      .run(m[1], m[2], encrypt(ctx.encKey, value), Date.now());
    return ok();
  }],
  ['DELETE', /^\/secrets\/([^/]+)\/([^/]+)$/, (ctx, m) => {
    ctx.db.prepare('DELETE FROM secrets WHERE tenant_id=? AND name=?').run(m[1], m[2]);
    return ok();
  }],
  ['GET', /^\/secrets\/([^/]+)$/, (ctx, m) => {
    const rows = ctx.db.prepare('SELECT name, updated_at FROM secrets WHERE tenant_id=? ORDER BY name').all(m[1]) as { name: string; updated_at: number }[];
    return ok({ secrets: rows.map((r) => ({ name: r.name, updatedAt: r.updated_at })) });
  }],

  ['PUT', /^\/connectors\/([^/]+)$/, (ctx, m, _q, b) => {
    tenantOr404(ctx, m[1]!);
    const socksAddr = needStr(b.socksAddr, 'socksAddr');
    if (!/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):\d{1,5}$/.test(socksAddr)) throw new HttpError(400, 'bad_socksAddr');
    const status = b.status;
    if (status !== 'up' && status !== 'down') throw new HttpError(400, 'bad_status');
    const routes = (b.routes ?? {}) as { cidrs?: unknown; exitNode?: unknown };
    const cidrs = routes.cidrs ?? [];
    if (!Array.isArray(cidrs) || cidrs.some((c) => typeof c !== 'string' || !validConnectorCidr(c))) throw new HttpError(400, 'bad_cidrs');
    const old = getConnector(ctx.db, m[1]!);
    ctx.db.prepare('INSERT INTO connectors(tenant_id, socks_addr, status, routes_json, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET socks_addr=excluded.socks_addr, status=excluded.status, routes_json=excluded.routes_json, updated_at=excluded.updated_at')
      .run(m[1], socksAddr, status, JSON.stringify({ cidrs, exitNode: routes.exitNode === true }), Date.now());
    // Tunnels carried by this connector were admitted against its old routes / address: drop them on any change.
    const exitNode = routes.exitNode === true;
    const changed = !old || old.socksAddr !== socksAddr || old.exitNode !== exitNode || JSON.stringify(old.cidrs) !== JSON.stringify(cidrs);
    if (status === 'down' || changed) ctx.live.killConnectorTunnels(m[1]!);
    return ok();
  }],
  // TCP-connect probe of a connector's SOCKS address from nanogate's own network namespace: the host process is
  // outside the connector network (the address is a container alias there), so only nanogate can see it.
  ['POST', /^\/connectors\/probe$/, async (_ctx, _m, _q, b) => {
    const socksAddr = needStr(b.socksAddr, 'socksAddr');
    const mm = socksAddr.match(/^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/);
    if (!mm) throw new HttpError(400, 'bad_socksAddr');
    const up = await new Promise<boolean>((resolve) => {
      const sock = net.connect({ host: mm[1]!.replace(/^\[|\]$/g, ''), port: Number(mm[2]) });
      const done = (v: boolean): void => { sock.destroy(); resolve(v); };
      sock.setTimeout(1500, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
    return ok({ up });
  }],
  ['DELETE', /^\/connectors\/([^/]+)$/, (ctx, m) => {
    ctx.db.prepare('DELETE FROM connectors WHERE tenant_id=?').run(m[1]);
    ctx.live.killConnectorTunnels(m[1]!);
    return ok();
  }],
];

export function createAdminServer(ctx: Ctx): http.Server {
  return http.createServer((req, res) => {
    const send = (r: Reply) => {
      const body = JSON.stringify(r.body);
      res.writeHead(r.status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    const fail = (e: unknown): void => {
      if (e instanceof HttpError) return send({ status: e.status, body: { error: e.code } });
      if (e instanceof SyntaxError) return send({ status: 400, body: { error: 'invalid_json' } });
      ctx.log({ msg: 'admin_error', error: (e as Error).message });
      send({ status: 500, body: { error: 'internal' } });
    };
    const chunks: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > 1024 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const url = new URL(req.url ?? '/', 'http://admin');
        let body: Json = {};
        if (chunks.length) {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'body_must_be_object');
          body = parsed as Json;
        }
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : url.pathname;
        let pathMatched = false;
        for (const [method, re, h] of routes) {
          const m = path.match(re);
          if (!m) continue;
          pathMatched = true;
          if (method !== req.method) continue;
          const r = h(ctx, m.map((s) => (s === undefined ? s : decodeURIComponent(s))) as unknown as RegExpMatchArray, url.searchParams, body);
          if (r instanceof Promise) { r.then(send, fail); return; }
          return send(r);
        }
        throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found');
      } catch (e) {
        fail(e);
      }
    });
  });
}
