import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAdminServer } from './admin-api.js';
import { handleAnthropic, sendError } from './anthropic-proxy.js';
import { sweepOpenReservations } from './budget.js';
import { buildDenySets, createConnectServer, flushEgress } from './connect-proxy.js';
import { type Config, readApiKey } from './config.js';
import type { Ctx, Resolver } from './context.js';
import { openDb } from './db.js';
import { LiveRegistry } from './live.js';
import { loadEncryptionKey } from './tokens.js';

export interface NanogateOptions {
  log?: (o: Record<string, unknown>) => void;
  /** Test seam: replace DNS. */
  resolver?: Resolver;
  /** Test seam: period of the egress flush + open-reservation sweep (default 60 s). */
  sweepIntervalMs?: number;
}

export interface Nanogate {
  ctx: Ctx;
  ports: { anthropic: number; connect: number; host: number };
  adminSocket: string;
  /** Re-read key files, prices and deny sets from a new config (SIGHUP). Listeners are unchanged. */
  reload(config: Config): void;
  close(): Promise<void>;
}

const defaultLog = (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
/**
 * c-ares (dns.promises.Resolver), not dns.lookup: lookup runs on libuv's 4-thread pool, where a few hanging
 * names would starve every other tenant. c-ares uses no pool threads, so the per-tenant / global limits in
 * connect-proxy.ts really bound resolver usage. (/etc/hosts is not consulted; nothing here needs it.)
 * Each lookup gets its own Resolver that is cancelled at timeoutMs: c-ares' own timeout/tries/backoff can
 * otherwise run several times longer than that, and a slot is held until the lookup settles.
 */
export function makeDefaultResolver(timeoutMs: number, servers?: string[]): Resolver {
  return async (host) => {
    const r = new dns.promises.Resolver({ timeout: Math.max(250, Math.floor(timeoutMs / 2)), tries: 2 });
    if (servers) r.setServers(servers);
    const timer = setTimeout(() => r.cancel(), timeoutMs);
    try {
      const [a4, a6] = await Promise.allSettled([r.resolve4(host), r.resolve6(host)]);
      const out: { address: string; family: number }[] = [];
      if (a4.status === 'fulfilled') out.push(...a4.value.map((address) => ({ address, family: 4 })));
      if (a6.status === 'fulfilled') out.push(...a6.value.map((address) => ({ address, family: 6 })));
      if (out.length === 0) {
        // NODATA / NXDOMAIN on both families = empty answer (dns_failed); anything else is a real failure.
        const err = [a4, a6].find((x) => x.status === 'rejected') as PromiseRejectedResult | undefined;
        if (err) throw err.reason;
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  };
}

function listen(server: http.Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

export async function startNanogate(config: Config, opts: NanogateOptions = {}): Promise<Nanogate> {
  const sweepIntervalMs = opts.sweepIntervalMs ?? 60_000;
  const db = openDb(config.stateDir);
  const deny = buildDenySets(config);
  const ctx: Ctx = {
    db, config, apiKey: readApiKey(config.anthropicKeyFile), encKey: loadEncryptionKey(config.encryptionKeyFile),
    live: new LiveRegistry(), log: opts.log ?? defaultLog, resolve: opts.resolver ?? makeDefaultResolver(config.connectLimits.dnsTimeoutMs),
    ...deny, inflight: new Map(), activeReservations: new Set(), bodyBytes: 0, tenantBodyBytes: new Map(), dns: { global: 0, perTenant: new Map(), queues: new Map(), queued: 0 }, warnedBetas: new Set(), egress: new Map(),
  };
  const swept = sweepOpenReservations(db, config.prices);
  if (swept) ctx.log({ msg: 'swept_open_reservations', count: swept });

  const mkAnthropic = (kind: 'session' | 'host', health: boolean) =>
    http.createServer((req, res) => {
      if (health && req.method === 'GET' && req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end('{"ok":true}');
      }
      handleAnthropic(ctx, req, res, kind).catch((e: Error) => {
        ctx.log({ msg: 'anthropic_error', error: e.message });
        sendError(res, 500, 'api_error', 'internal_error');
      });
    });

  const anth = mkAnthropic('session', true);
  const host = mkAnthropic('host', false);
  const connect = createConnectServer(ctx);
  const admin = createAdminServer(ctx);
  // Streams can run long; do not let node's default request timeout cut them.
  for (const s of [anth, host]) {
    s.requestTimeout = 0;
    s.headersTimeout = 30_000;
    // Backstop: a socket that moves no bytes for this long dies (drained bodies, stalled clients); a connection cap.
    s.timeout = config.anthropicLimits.socketIdleMs;
    s.maxConnections = config.anthropicLimits.maxConnections;
  }

  const ports = {
    anthropic: await listen(anth, config.listen.anthropicPort, config.listen.bind),
    connect: await listen(connect, config.listen.connectPort, config.listen.bind),
    host: await listen(host, config.listen.hostPort, config.listen.hostBind),
  };

  const sock = config.listen.adminSocket;
  fs.mkdirSync(path.dirname(sock), { recursive: true });
  fs.rmSync(sock, { force: true });
  const oldMask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => {
      admin.once('error', reject);
      admin.listen(sock, resolve);
    });
  } finally {
    process.umask(oldMask);
  }
  fs.chmodSync(sock, 0o600);

  const timer = setInterval(() => {
    try {
      flushEgress(ctx);
    } catch (e) {
      ctx.log({ msg: 'egress_flush_error', error: (e as Error).message });
    }
    try {
      // Reservations whose settlement failed are left open by the handler: charge them conservatively here.
      const n = sweepOpenReservations(db, ctx.config.prices, ctx.activeReservations);
      if (n) ctx.log({ msg: 'swept_open_reservations', count: n });
    } catch (e) {
      ctx.log({ msg: 'sweep_error', error: (e as Error).message });
    }
  }, sweepIntervalMs);
  timer.unref();

  ctx.log({ msg: 'started', ports, admin: sock });
  return {
    ctx, ports, adminSocket: sock,
    reload(next) {
      const nd = buildDenySets(next);
      ctx.apiKey = readApiKey(next.anthropicKeyFile);
      ctx.encKey = loadEncryptionKey(next.encryptionKeyFile);
      ctx.config = next;
      ctx.denySet = nd.denySet;
      ctx.hardDenySet = nd.hardDenySet;
      ctx.log({ msg: 'reloaded', priceVersion: next.prices.version });
    },
    async close() {
      clearInterval(timer);
      for (const s of [anth, host, connect, admin]) s.closeAllConnections?.();
      await Promise.all([anth, host, connect, admin].map((s) => new Promise<void>((r) => s.close(() => r()))));
      flushEgress(ctx);
      db.close();
      fs.rmSync(sock, { force: true });
    },
  };
}
