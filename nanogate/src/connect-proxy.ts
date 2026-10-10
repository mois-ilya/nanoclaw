import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { CidrSet, parseIp } from './cidr.js';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { getConnector } from './db.js';
import type { LiveEntry } from './live.js';
import { type TenantPolicy, tailnetAllowed } from './policy.js';
import { socks5Connect } from './socks5.js';
import { type Auth, authenticate, revalidate } from './tokens.js';

const BUILTIN_DENY = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12',
  '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15',
  '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4', '255.255.255.255/32',
  '::/128', '::1/128', '::/96', 'fc00::/7', 'fe80::/10', 'ff00::/8', '64:ff9b::/96', '2001:db8::/32', '2002::/16', '2001::/32',
  // SIIT IPv4-translated (::ffff:0:a.b.c.d; distinct from IPv4-mapped, which parseIp already folds to IPv4),
  // local-use NAT64 and the IPv6 discard prefix.
  '::ffff:0:0:0/96', '64:ff9b:1::/48', '100::/64',
];

/** Never reachable by anyone, not even through a connector route that covers them (tailnet IP destinations). */
const ALWAYS_DENY = ['0.0.0.0/8', '127.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '::/128', '::1/128', 'fe80::/10', 'ff00::/8'];

/** Normalise a CIDR string so config.disableBuiltinDeny can be compared textually. */
export function buildDenySets(cfg: Config): { denySet: CidrSet; hardDenySet: CidrSet } {
  const disabled = new Set(cfg.disableBuiltinDeny);
  const hard = [...cfg.denyCidrs, ...cfg.hostAddresses];
  return {
    denySet: new CidrSet([...BUILTIN_DENY.filter((c) => !disabled.has(c)), ...hard]),
    // disableBuiltinDeny (tests) lets direct dials reach loopback echo servers; it never reaches this set.
    hardDenySet: new CidrSet([...ALWAYS_DENY, ...hard]),
  };
}

export interface Authority {
  host: string; // lower-case, IDNA-ASCII, no brackets, no trailing dot
  port: number;
  isIp: boolean;
}

export function parseAuthority(authority: string, defaultPort?: number): Authority | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:\[\]\s/?#@\\]+)(?::(\d{1,5}))?$/.exec(authority);
  if (!m) return null;
  const port = m[2] !== undefined ? Number(m[2]) : defaultPort;
  if (port === undefined || port < 1 || port > 65535) return null;
  let host: string;
  try {
    host = new URL(`http://${m[1]}`).hostname; // IDNA + numeric IPv4 normalisation (0x7f.1 -> 127.0.0.1)
  } catch {
    return null;
  }
  host = host.replace(/^\[|\]$/g, '');
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) return null;
  const isIp = net.isIP(host) !== 0;
  if (!isIp && !/^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/.test(host)) return null;
  return { host, port, isIp };
}

export type Plan =
  | { kind: 'direct'; /** every validated address, IPv4 first */ ips: string[]; port: number }
  | { kind: 'socks'; socksAddr: string; owner: string; host: string; port: number };
export interface Deny {
  deny: true;
  status: number;
  reason: string;
}

const d = (status: number, reason: string): Deny => ({ deny: true, status, reason });

function isModelHost(cfg: Config, host: string): boolean {
  return cfg.modelHosts.some((m) => host === m || host.endsWith(`.${m}`));
}

/** Decide where (and whether) a tenant's connection to host:port goes. Resolves DNS once and pins the IP. */
export async function planRoute(ctx: Ctx, tenantId: string, policy: TenantPolicy, a: Authority): Promise<Plan | Deny> {
  const { host, port, isIp } = a;
  const eg = policy.egress;
  if (isModelHost(ctx.config, host)) return d(403, 'model_host');

  const tailnetName = !isIp && (host.endsWith('.ts.net') || !host.includes('.'));
  if (!isIp && (host === 'localhost' || host.endsWith('.localhost'))) return d(403, 'denied_address');
  if (isIp || tailnetName) {
    // Names are only ever matched against an exact (or *.x.ts.net) allowlist entry and handed to the connector
    // unresolved, so what a name finally maps to is the connector's resolver's business; the connector uplink
    // firewall is the backstop for that (see README "Tailnet names").
    // Tailnet destinations: always the REQUESTING tenant's own connector and allowlist.
    const ip = isIp ? parseIp(host) : null;
    if (isIp && !ip) return d(403, 'bad_ip');
    if (ip && ctx.hardDenySet.matches(ip)) return d(403, 'denied_address');
    if (!eg.tailnet || !tailnetAllowed(policy, host, ip, port)) return d(403, 'tailnet_not_allowed');
    const c = getConnector(ctx.db, tenantId);
    if (!c) return d(403, 'no_connector');
    if (c.status !== 'up') return d(502, 'connector_down');
    if (ip && !new CidrSet(c.cidrs).matches(ip)) return d(403, 'not_in_routes');
    return { kind: 'socks', socksAddr: c.socksAddr, owner: tenantId, host, port };
  }

  if (!eg.ports.includes(port)) return d(403, 'port_denied');
  const r = await resolveLimited(ctx, tenantId, host);
  if ('deny' in r) return r;
  const addrs = r;
  if (addrs.length === 0) return d(502, 'dns_failed');
  // Every answer must pass before any is tried (a single bad answer rejects the lot); IPv4 first, then IPv6.
  const ips: { address: string; v: 4 | 6 }[] = [];
  for (const x of addrs) {
    const ip = parseIp(x.address);
    if (!ip || ctx.denySet.matches(ip)) return d(403, 'denied_address');
    if (!ips.some((i) => i.address === x.address)) ips.push({ address: x.address, v: ip.v });
  }
  ips.sort((x, y) => x.v - y.v);
  const pinned = ips[0]!.address;
  if (eg.route === 'connector') {
    const owner = eg.connectorTenant ?? tenantId;
    const c = getConnector(ctx.db, owner);
    if (c && c.status === 'up' && c.exitNode) return { kind: 'socks', socksAddr: c.socksAddr, owner, host: pinned, port };
    if (!eg.fallbackDirect) return d(502, 'connector_down');
  }
  return { kind: 'direct', ips: ips.map((i) => i.address), port };
}

/**
 * Resolver admission: a bounded FIFO wait queue per tenant in front of a per-tenant and a process-wide
 * concurrency cap. An honest burst (npm install, a browser page load) waits its turn instead of being refused;
 * 429 only when the tenant's queue is full, 503 when the whole process has too many waiters. The caller's
 * deadline (dnsTimeoutMs) covers queue wait plus lookup. A slot is held until the lookup really settles; the
 * default resolver cancels at dnsTimeoutMs, so that is bounded too (see makeDefaultResolver).
 */
interface DnsWaiter {
  start(): void;
}

function dnsPump(ctx: Ctx): void {
  const lim = ctx.config.connectLimits;
  const q = ctx.dns;
  let progressed = true;
  while (progressed && q.global < lim.dnsGlobal) {
    progressed = false;
    for (const [tenant, waiters] of [...q.queues]) {
      if (q.global >= lim.dnsGlobal) break;
      if ((q.perTenant.get(tenant) ?? 0) >= lim.dnsPerTenant) continue;
      const w = waiters.shift();
      if (!w) continue;
      q.queued--;
      // round-robin between tenants: a tenant that was served goes to the back
      q.queues.delete(tenant);
      if (waiters.length) q.queues.set(tenant, waiters);
      w.start();
      progressed = true;
    }
  }
}

async function resolveLimited(ctx: Ctx, tenantId: string, host: string): Promise<{ address: string }[] | Deny> {
  const lim = ctx.config.connectLimits;
  const q = ctx.dns;
  const queue = q.queues.get(tenantId);
  const mustWait = q.global >= lim.dnsGlobal || (q.perTenant.get(tenantId) ?? 0) >= lim.dnsPerTenant || (queue?.length ?? 0) > 0;
  if (mustWait) {
    if ((queue?.length ?? 0) >= lim.dnsQueuePerTenant) return d(429, 'too_many_dns');
    if (q.queued >= lim.dnsQueueGlobal) return d(503, 'dns_busy');
  }
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (r: { address: string }[] | Deny) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const waiter: DnsWaiter = {
      start() {
        q.global++;
        q.perTenant.set(tenantId, (q.perTenant.get(tenantId) ?? 0) + 1);
        const release = () => {
          q.global--;
          const n = (q.perTenant.get(tenantId) ?? 1) - 1;
          if (n > 0) q.perTenant.set(tenantId, n);
          else q.perTenant.delete(tenantId);
          dnsPump(ctx);
        };
        (async () => ctx.resolve(host))().then(
          (r) => { release(); finish(r); },
          () => { release(); finish(d(502, 'dns_failed')); },
        );
      },
    };
    timer = setTimeout(() => {
      const w = q.queues.get(tenantId);
      const i = w ? w.indexOf(waiter) : -1;
      if (w && i >= 0) {
        w.splice(i, 1);
        q.queued--;
        if (!w.length) q.queues.delete(tenantId);
      }
      finish(d(504, 'dns_timeout'));
    }, lim.dnsTimeoutMs);
    if (!mustWait) return waiter.start();
    const w = q.queues.get(tenantId) ?? [];
    w.push(waiter);
    q.queues.set(tenantId, w);
    q.queued++;
  });
}

function dialOne(ip: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: ip, port });
    const fail = (e: Error) => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      s.destroy();
      reject(e);
    };
    const onAbort = () => fail(new Error('aborted'));
    const t = setTimeout(() => fail(new Error('dial timeout')), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    s.once('connect', () => {
      clearTimeout(t);
      signal.removeEventListener('abort', onAbort);
      s.removeAllListeners('error');
      s.pause();
      resolve(s);
    });
    s.once('error', fail);
  });
}

/** Direct dials try every validated address in turn (IPv4 first), each with its own connect timeout. */
async function dial(ctx: Ctx, plan: Plan, signal: AbortSignal): Promise<net.Socket> {
  if (plan.kind === 'socks') return socks5Connect(plan.socksAddr, { host: plan.host, port: plan.port }, ctx.config.socksTimeoutMs, signal);
  let last: Error = new Error('no address');
  for (const ip of plan.ips) {
    if (signal.aborted) throw new Error('aborted');
    try {
      return await dialOne(ip, plan.port, ctx.config.socksTimeoutMs, signal);
    } catch (e) {
      last = e as Error;
    }
  }
  throw last;
}

export function proxyToken(h: http.IncomingHttpHeaders): string | undefined {
  const v = h['proxy-authorization'];
  if (typeof v !== 'string') return undefined;
  if (/^bearer /i.test(v)) return v.slice(7).trim();
  if (/^basic /i.test(v)) {
    const dec = Buffer.from(v.slice(6).trim(), 'base64').toString('utf8');
    const i = dec.indexOf(':');
    if (i < 0) return dec;
    return dec.slice(i + 1) || dec.slice(0, i); // token is the password; tolerate token-as-username
  }
  return undefined;
}

function reply(sock: Duplex, status: number, reason: string, extra: Record<string, string> = {}): void {
  const text = http.STATUS_CODES[status] ?? 'Error';
  const hdr = Object.entries({ 'x-nanogate-reason': reason, ...extra, 'content-length': '0', connection: 'close' })
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('');
  sock.end(`HTTP/1.1 ${status} ${text}\r\n${hdr}\r\n`);
}

function authProxy(ctx: Ctx, req: http.IncomingMessage, sock: Duplex): Auth | null {
  const r = authenticate(ctx.db, proxyToken(req.headers), 'session');
  if (r.ok) return r.auth;
  if (r.reason === 'paused') reply(sock, 403, 'tenant_paused');
  else reply(sock, 407, 'auth_required', { 'proxy-authenticate': 'Basic realm="nanogate"' });
  return null;
}

function egressStat(ctx: Ctx, tenantId: string) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `${tenantId}|${day}`;
  let s = ctx.egress.get(key);
  if (!s) ctx.egress.set(key, (s = { tenantId, day, up: 0, down: 0, tunnels: 0 }));
  return s;
}

export function flushEgress(ctx: Ctx): void {
  if (ctx.egress.size === 0) return;
  const st = ctx.db.prepare(
    `INSERT INTO egress_stats(tenant_id, day, bytes_up, bytes_down, tunnels) VALUES (?,?,?,?,?)
     ON CONFLICT(tenant_id, day) DO UPDATE SET bytes_up=bytes_up+excluded.bytes_up, bytes_down=bytes_down+excluded.bytes_down, tunnels=tunnels+excluded.tunnels`,
  );
  const items = [...ctx.egress.values()];
  ctx.egress.clear();
  ctx.db.transaction(() => {
    for (const s of items) st.run(s.tenantId, s.day, s.up, s.down, s.tunnels);
  })();
}

interface Opened {
  auth: Auth;
  plan: Plan;
  upstream: net.Socket;
  /** the registry entry taken at authentication time; runTunnel re-points its destroy() at the tunnel */
  entry: LiveEntry;
  unreg: () => void;
}

/** Wire client and upstream together with idle/duration/byte limits; registered so revoke can kill it. */
function runTunnel(ctx: Ctx, o: Opened, client: net.Socket, bodySource?: NodeJS.ReadableStream): void {
  const { auth, plan, upstream, entry, unreg } = o;
  const lim = ctx.config.connectLimits;
  egressStat(ctx, auth.tenant.id).tunnels++; // bytes are always attributed to the REQUESTING tenant
  let total = 0;
  let closed = false;
  const kill = () => {
    if (closed) return;
    closed = true;
    clearTimeout(maxTimer);
    unreg();
    client.destroy();
    upstream.destroy();
  };
  entry.destroy = kill;
  const maxTimer = setTimeout(kill, lim.maxTunnelSeconds * 1000);
  maxTimer.unref();
  const count = (dir: 'up' | 'down') => (c: Buffer) => {
    // Looked up per chunk: flushEgress drops flushed entries from the map, a held reference would be orphaned.
    egressStat(ctx, auth.tenant.id)[dir] += c.length;
    total += c.length;
    if (total > lim.maxBytesPerTunnel) kill();
  };
  (bodySource ?? client).on('data', count('up'));
  upstream.on('data', count('down'));
  for (const s of [client, upstream]) {
    s.setTimeout(lim.idleSeconds * 1000, kill);
    s.on('close', kill);
    s.on('error', kill);
  }
  if (bodySource) bodySource.pipe(upstream, { end: false });
  else client.pipe(upstream);
  upstream.pipe(client);
}

/**
 * Take a tunnel slot and register with the live registry synchronously (the caller has not awaited since
 * authenticating), so the limit counts connections still resolving/dialling and revoke/pause/release/policy
 * changes can abort whatever stage this one is in. Re-validates the token right before dialling.
 */
async function open(ctx: Ctx, auth0: Auth, a: Authority, sock: Duplex): Promise<Opened | null> {
  if (ctx.live.count(auth0.tenant.id, 'tunnel') >= ctx.config.connectLimits.maxTunnelsPerTenant) {
    reply(sock, 429, 'too_many_tunnels');
    return null;
  }
  if (ctx.live.total('tunnel') >= ctx.config.connectLimits.maxTunnelsGlobal) {
    reply(sock, 429, 'too_many_tunnels');
    return null;
  }
  const ac = new AbortController();
  const entry: LiveEntry = {
    tenantId: auth0.tenant.id, tokenHash: auth0.tokenHash, kind: 'tunnel',
    destroy: () => {
      ac.abort();
      sock.destroy();
    },
  };
  const unreg = ctx.live.add(entry);
  const bail = (status: number, reason: string, extra?: Record<string, string>): null => {
    unreg();
    if (!ac.signal.aborted) reply(sock, status, reason, extra);
    return null;
  };
  try {
    const plan = await planRoute(ctx, auth0.tenant.id, auth0.tenant.policy, a);
    if (ac.signal.aborted) return null;
    if ('deny' in plan) {
      ctx.log({ msg: 'connect_denied', tenant: auth0.tenant.id, host: a.host, port: a.port, reason: plan.reason });
      return bail(plan.status, plan.reason);
    }
    const v = revalidate(ctx.db, auth0);
    if (!v.ok) {
      return v.reason === 'paused' ? bail(403, 'tenant_paused') : bail(407, 'auth_required', { 'proxy-authenticate': 'Basic realm="nanogate"' });
    }
    if (plan.kind === 'socks') {
      entry.via = 'connector';
      entry.connectorOwner = plan.owner;
    } else entry.via = 'direct';
    let upstream: net.Socket;
    try {
      upstream = await dial(ctx, plan, ac.signal);
    } catch {
      return bail(502, 'dial_failed');
    }
    if (ac.signal.aborted) {
      upstream.destroy();
      return null;
    }
    return { auth: v.auth, plan, upstream, entry, unreg };
  } catch (e) {
    unreg();
    throw e;
  }
}

export function createConnectServer(ctx: Ctx): http.Server {
  const server = http.createServer((req, res) => {
    // Plain-HTTP proxying: absolute-form request, rewritten to origin-form, one request per connection.
    const sock = req.socket;
    const handle = async () => {
      if (!/^http:\/\//i.test(req.url ?? '')) return reply(sock, 405, 'unsupported');
      const auth = authProxy(ctx, req, sock);
      if (!auth) return;
      let url: URL;
      try {
        url = new URL(req.url!);
      } catch {
        return reply(sock, 400, 'bad_url');
      }
      if (url.username || url.password || req.headers['transfer-encoding']) return reply(sock, url.username ? 400 : 501, 'unsupported');
      const a = parseAuthority(url.host, 80);
      if (!a) return reply(sock, 400, 'bad_authority');
      const o = await open(ctx, auth, a, sock);
      if (!o) return;
      let head = `${req.method} ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!;
        if (/^(host|connection|keep-alive|te|upgrade|trailer|proxy-.*|transfer-encoding)$/i.test(k)) continue;
        head += `${k}: ${req.rawHeaders[i + 1]!.replace(/[\r\n]/g, ' ')}\r\n`;
      }
      o.upstream.write(`${head}\r\n`);
      runTunnel(ctx, o, sock, req);
    };
    sock.on('error', () => undefined);
    handle().catch(() => sock.destroy());
  });

  server.on('connect', (req, sock: net.Socket, headBuf: Buffer) => {
    sock.on('error', () => undefined);
    const handle = async () => {
      const auth = authProxy(ctx, req, sock);
      if (!auth) return;
      const a = parseAuthority(req.url ?? '');
      if (!a) return reply(sock, 400, 'bad_authority');
      const o = await open(ctx, auth, a, sock);
      if (!o) return;
      sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (headBuf.length) o.upstream.write(headBuf);
      ctx.log({ msg: 'connect', tenant: o.auth.tenant.id, host: a.host, port: a.port, via: o.plan.kind });
      runTunnel(ctx, o, sock);
    };
    handle().catch(() => sock.destroy());
  });
  server.on('clientError', (_e, sock) => sock.destroy());
  return server;
}
