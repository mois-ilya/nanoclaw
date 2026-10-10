// Regression tests for the security review: each would have failed before the fix.
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushEgress } from '../src/connect-proxy.js';
import { parseCidr, validConnectorCidr } from '../src/cidr.js';
import { normalizePolicy, parseTailnetAllow } from '../src/policy.js';
import { sweepOpenReservations } from '../src/budget.js';
import { IMAGE_TOKEN_CEILING, PDF_PAGE_TOKENS, serverToolCapMicros, serverToolMicros, validatePrices } from '../src/pricing.js';
import { type Gate, basic, echoServer, fakeSocks, makeGate, PRICES, proxyConnect, rawConnect, readN, slowPost } from './harness.js';

let g: Gate;
let echo: Awaited<ReturnType<typeof echoServer>> | undefined;
let socks: Awaited<ReturnType<typeof fakeSocks>> | undefined;
afterEach(async () => {
  await g.close();
  echo?.close();
  socks?.close();
  echo = socks = undefined;
});

const BODY = JSON.stringify({ model: 'm-1', max_tokens: 100, messages: [{ role: 'user', content: 'json' }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (sql: string) => (g.gate.ctx.db.prepare(sql).get() as { n: number }).n;

/** A resolver the test releases by hand. */
function gatedResolver(answers: Record<string, string[]> = {}) {
  const waiting: (() => void)[] = [];
  let gated = true;
  let calls = 0;
  return {
    calls: () => calls,
    release: () => { gated = false; waiting.splice(0).forEach((w) => w()); },
    gate: () => { gated = true; },
    fn: async (h: string) => {
      calls++;
      if (gated) await new Promise<void>((r) => waiting.push(r));
      const a = answers[h] ?? ['127.0.0.1'];
      return a.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  };
}

async function connectSetup(over: Record<string, unknown> = {}, resolver?: (h: string) => Promise<{ address: string; family: number }[]>, policy: Record<string, unknown> = {}) {
  echo = await echoServer();
  socks = await fakeSocks({ host: '127.0.0.1', port: echo.port });
  g = await makeGate({ disableBuiltinDeny: ['127.0.0.0/8', '::1/128', '::/96'], denyCidrs: ['10.201.0.0/20'], ...over }, resolver ?? (async () => [{ address: '127.0.0.1', family: 4 }]));
  await g.tenant('t1', {}, { egress: { route: 'direct', ports: [echo.port], ...policy } });
  return g.session('t1');
}

describe('2: revoke/pause/release reach requests that authenticated but are not registered yet', () => {
  it('CONNECT: revoke during DNS leaves no tunnel and counts the pending entry as killed', async () => {
    const r = gatedResolver();
    const tok = await connectSetup({}, r.fn);
    const c = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    await vi.waitFor(() => expect(r.calls()).toBe(1));
    const rev = await g.admin('POST', '/tenants/t1/revoke');
    expect(rev.json.killed).toBe(1);
    r.release();
    expect(await c.closed).not.toContain('200');
    expect((g.gate.ctx.live as any).count('t1', 'tunnel')).toBe(0);
  });

  it('CONNECT: session release during DNS and pause during DNS both abort the pending tunnel', async () => {
    const r = gatedResolver();
    const tok = await connectSetup({}, r.fn);
    const c1 = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    await vi.waitFor(() => expect(r.calls()).toBe(1));
    await g.admin('POST', '/sessions/release', { sessionKey: 's-t1', kind: 'session-ended' });
    expect(await c1.closed).not.toContain('200');
    const tok2 = await g.session('t1', 'again');
    const c2 = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok2));
    await vi.waitFor(() => expect(r.calls()).toBe(2));
    await g.admin('POST', '/tenants/t1/pause');
    expect(await c2.closed).not.toContain('200');
    r.release();
    await sleep(50);
    expect((g.gate.ctx.live as any).count('t1', 'tunnel')).toBe(0);
  });

  it('CONNECT: a token revoked without a live kill is caught by the re-validation before dialling', async () => {
    const r = gatedResolver();
    const tok = await connectSetup({}, r.fn);
    const c = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    await vi.waitFor(() => expect(r.calls()).toBe(1));
    g.gate.ctx.db.prepare('UPDATE tokens SET revoked_at = ?').run(Date.now());
    r.release();
    await c.closed;
    expect(c.status()).toBe(407);
    expect(echo).toBeDefined();
  });

  it('CONNECT: pause between auth and dial is caught by the re-validation (403)', async () => {
    const r = gatedResolver();
    const tok = await connectSetup({}, r.fn);
    const c = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    await vi.waitFor(() => expect(r.calls()).toBe(1));
    g.gate.ctx.db.prepare("UPDATE tenants SET status='paused'").run(); // no live kill
    r.release();
    await c.closed;
    expect([c.status(), c.reason()]).toEqual([403, 'tenant_paused']);
  });

  it('Anthropic: revoke during a slow body upload never forwards upstream (probe p3)', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const { req, result } = slowPost(g.gate.ports.anthropic, tok, { 'content-length': Buffer.byteLength(BODY) });
    req.write(BODY.slice(0, 10));
    await vi.waitFor(() => expect((g.gate.ctx.live as any).count('t1', 'request')).toBe(1));
    const rev = await g.admin('POST', '/tenants/t1/revoke');
    expect(rev.json.killed).toBe(1);
    try { req.end(BODY.slice(10)); } catch { /* socket already gone */ }
    const r = await result;
    expect(r.status).not.toBe(200);
    expect(g.up.seen).toHaveLength(0);
    expect(g.usageRows()).toHaveLength(0);
    expect(count("SELECT COUNT(*) AS n FROM reservations")).toBe(0);
  });

  it('Anthropic: pause during the upload is caught by the re-validation (403) and nothing is forwarded', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const { req, result } = slowPost(g.gate.ports.anthropic, tok, { 'content-length': Buffer.byteLength(BODY) });
    req.write(BODY.slice(0, 10));
    await vi.waitFor(() => expect((g.gate.ctx.live as any).count('t1', 'request')).toBe(1));
    await g.admin('POST', '/tenants/t1/pause');
    req.end(BODY.slice(10));
    const r = await result;
    expect(r.status).toBe(403);
    expect(g.up.seen).toHaveLength(0);
  });
});

describe('3: tunnel slots and DNS are bounded', () => {
  it('parallel CONNECTs cannot exceed maxTunnelsPerTenant even with slow DNS', async () => {
    const r = gatedResolver();
    const tok = await connectSetup({ connectLimits: { maxTunnelsPerTenant: 2 } }, r.fn);
    const cs = Array.from({ length: 10 }, () => rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok)));
    await sleep(100);
    r.release();
    await sleep(200);
    const statuses = cs.map((c) => c.status());
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(8);
    cs.forEach((c) => c.socket.destroy());
  });

  it('a failed attempt gives its slot back', async () => {
    const tok = await connectSetup({ connectLimits: { maxTunnelsPerTenant: 1 } });
    for (let i = 0; i < 3; i++) {
      const bad = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port + 1}`, basic(tok)); // port_denied
      expect(bad.status).toBe(403);
    }
    const ok = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    expect(ok.status).toBe(200);
    ok.socket.destroy();
  });

  it('per-tenant lookups queue FIFO; 429 only when the tenant queue is full; other tenants still resolve', async () => {
    const hang = gatedResolver();
    const tok = await connectSetup({ connectLimits: { dnsPerTenant: 2, dnsQueuePerTenant: 1, dnsTimeoutMs: 60_000 } }, async (h) => (h === 'slow.test' ? hang.fn(h) : [{ address: '127.0.0.1', family: 4 }]));
    await g.tenant('other', {}, { egress: { route: 'direct', ports: [echo!.port] } });
    const tokO = await g.session('other');
    const hung = [1, 2].map(() => rawConnect(g.gate.ports.connect, `slow.test:${echo!.port}`, basic(tok)));
    await vi.waitFor(() => expect(hang.calls()).toBe(2));
    const queued = proxyConnect(g.gate.ports.connect, `slow.test:${echo!.port}`, basic(tok)); // waits, not refused
    await vi.waitFor(() => expect(g.gate.ctx.dns.queued).toBe(1));
    const fourth = await proxyConnect(g.gate.ports.connect, `slow.test:${echo!.port}`, basic(tok));
    expect([fourth.status, fourth.reason]).toEqual([429, 'too_many_dns']);
    const fine = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tokO));
    expect(fine.status).toBe(200);
    fine.socket.destroy();
    hang.release();
    const third = await queued;
    expect(third.status).toBe(200);
    third.socket.destroy();
    hung.forEach((c) => c.socket.destroy());
    expect(g.gate.ctx.dns.queued).toBe(0);
  });

  it('the process-wide waiter cap answers 503 dns_busy', async () => {
    const hang = gatedResolver();
    const tok = await connectSetup({ connectLimits: { dnsGlobal: 2, dnsPerTenant: 1, dnsQueueGlobal: 0, dnsTimeoutMs: 60_000 } }, hang.fn);
    for (const id of ['other', 'third']) await g.tenant(id, {}, { egress: { route: 'direct', ports: [echo!.port] } });
    const tokO = await g.session('other');
    const tokT = await g.session('third');
    const c1 = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    const c2 = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tokO));
    await vi.waitFor(() => expect(hang.calls()).toBe(2));
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tokT));
    expect([r.status, r.reason]).toEqual([503, 'dns_busy']);
    hang.release();
    c1.socket.destroy();
    c2.socket.destroy();
  });

  it('a queued lookup that waits past dnsTimeoutMs gets 504 and leaves the queue', async () => {
    const hang = gatedResolver();
    const tok = await connectSetup({ connectLimits: { dnsPerTenant: 1, dnsGlobal: 2, dnsTimeoutMs: 300 } }, hang.fn);
    const first = rawConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    await vi.waitFor(() => expect(hang.calls()).toBe(1));
    const t0 = Date.now();
    const w = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    expect([w.status, w.reason]).toEqual([504, 'dns_timeout']);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(g.gate.ctx.dns.queued).toBe(0);
    expect(g.gate.ctx.dns.queues.size).toBe(0);
    hang.release();
    first.socket.destroy();
  });

  it('a tenant that saturates its DNS cap with hanging lookups does not block another tenant', async () => {
    // default caps: dnsPerTenant 4 < dnsGlobal 16, so the attacker can never hold the whole resolver
    const hang = gatedResolver();
    const tok = await connectSetup({ connectLimits: { dnsTimeoutMs: 60_000, dnsQueuePerTenant: 2 } }, async (h) => (h.startsWith('hang') ? hang.fn(h) : [{ address: '127.0.0.1', family: 4 }]));
    await g.tenant('t2', {}, { egress: { route: 'direct', ports: [echo!.port] } });
    const tok2 = await g.session('t2');
    const hung = Array.from({ length: 6 }, (_, i) => rawConnect(g.gate.ports.connect, `hang${i}.test:${echo!.port}`, basic(tok)));
    await vi.waitFor(() => expect(hang.calls()).toBe(4));
    await vi.waitFor(() => expect(g.gate.ctx.dns.queued).toBe(2));
    const over = await proxyConnect(g.gate.ports.connect, `hang9.test:${echo!.port}`, basic(tok));
    expect([over.status, over.reason]).toEqual([429, 'too_many_dns']);
    const t0 = Date.now();
    const ok = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok2));
    expect(ok.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    ok.socket.destroy();
    hang.release();
    hung.forEach((c) => c.socket.destroy());
  });

  it.each([10, 16])('an honest burst of %i parallel CONNECTs with default limits all succeed', async (n) => {
    const tok = await connectSetup({}, async () => {
      await sleep(30);
      return [{ address: '127.0.0.1', family: 4 }];
    });
    const rs = await Promise.all(Array.from({ length: n }, () => proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok))));
    expect(rs.map((r) => r.status)).toEqual(Array(n).fill(200));
    rs.forEach((r) => r.socket.destroy());
  });

  it('the default resolver gives up at dnsTimeoutMs even when the nameserver never answers', async () => {
    const dgram = await import('node:dgram');
    const udp = dgram.createSocket('udp4');
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
    const { makeDefaultResolver } = await import('../src/server.js');
    const res = makeDefaultResolver(400, [`127.0.0.1:${udp.address().port}`]);
    const t0 = Date.now();
    await expect(res('silent.test')).rejects.toBeDefined();
    expect(Date.now() - t0).toBeLessThan(1200);
    udp.close();
    g = await makeGate(); // afterEach closes it
  });

  it('a hanging lookup times out (504) but keeps its slot until it returns', async () => {
    const hang = gatedResolver();
    const tok = await connectSetup({ connectLimits: { dnsTimeoutMs: 100 } }, hang.fn);
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    expect([r.status, r.reason]).toEqual([504, 'dns_timeout']);
    expect(g.gate.ctx.dns.global).toBe(1);
    hang.release();
    await vi.waitFor(() => expect(g.gate.ctx.dns.global).toBe(0));
    expect(g.gate.ctx.dns.perTenant.size).toBe(0);
  });
});

describe('4: bodies are bounded before they are read', () => {
  it('the concurrency check runs before the body is read (declared 30 MiB, nothing sent)', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { maxConcurrentRequests: 1 });
    const tok = await g.session('t1');
    const first = slowPost(g.gate.ports.anthropic, tok, { 'content-length': Buffer.byteLength(BODY) });
    first.req.write(BODY.slice(0, 5));
    await vi.waitFor(() => expect(g.gate.ctx.inflight.get('t1')).toBe(1));
    const second = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 30 * 1024 * 1024 });
    second.req.write('{');
    const r = await second.result;
    expect(r.status).toBe(429);
    expect(JSON.parse(r.text).error.message).toBe('too_many_concurrent_requests');
    first.req.destroy();
  });

  it('a global in-flight body-bytes cap counts bytes as they arrive and gives them back', async () => {
    g = await makeGate({ anthropicLimits: { maxInflightBodyBytes: 1000 } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    const a = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 2000 });
    a.req.write('x'.repeat(800));
    await vi.waitFor(() => expect(g.gate.ctx.bodyBytes).toBe(800));
    const b = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 2000 });
    b.req.write('x'.repeat(800));
    const r = await b.result;
    expect(r.status).toBe(429);
    expect(JSON.parse(r.text).error.message).toBe('too_many_inflight_bytes');
    a.req.destroy();
    await vi.waitFor(() => expect(g.gate.ctx.bodyBytes).toBe(0));
    expect((await g.messages(tok, 'json')).status).toBe(200);
    expect(g.gate.ctx.bodyBytes).toBe(0);
    expect(g.gate.ctx.inflight.get('t1')).toBe(0);
  });

  it('declared-but-unsent bodies reserve nothing: an honest tenant is not locked out', async () => {
    g = await makeGate({ anthropicLimits: { maxInflightBodyBytes: 1000, bodyTimeoutMs: 5000 } });
    await g.tenant('t1', {}, { maxConcurrentRequests: 8 });
    await g.tenant('honest');
    const tok = await g.session('t1');
    const tokH = await g.session('honest');
    const idle = Array.from({ length: 8 }, () => slowPost(g.gate.ports.anthropic, tok, { 'content-length': 30 * 1024 * 1024 }));
    idle.forEach((i) => i.req.write('{'));
    await vi.waitFor(() => expect(g.gate.ctx.inflight.get('t1')).toBe(8));
    expect(g.gate.ctx.bodyBytes).toBeLessThanOrEqual(8);
    expect((await g.messages(tokH, 'json')).status).toBe(200);
    idle.forEach((i) => i.req.destroy());
  });

  it('a per-tenant body-bytes cap stops one tenant filling the global cap', async () => {
    g = await makeGate({ anthropicLimits: { maxInflightBodyBytes: 1000, maxInflightBodyBytesPerTenant: 350 } });
    await g.tenant('t1');
    await g.tenant('t2');
    const tok = await g.session('t1');
    const tok2 = await g.session('t2');
    const a = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 900 });
    a.req.write('x'.repeat(200));
    await vi.waitFor(() => expect(g.gate.ctx.tenantBodyBytes.get('t1')).toBe(200));
    const b = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 900 });
    b.req.write('x'.repeat(200));
    const rb = await b.result;
    expect(rb.status).toBe(429);
    expect(JSON.parse(rb.text).error.message).toBe('too_many_inflight_bytes');
    expect((await g.messages(tok2, 'json')).status).toBe(200);
    a.req.destroy();
    await vi.waitFor(() => expect(g.gate.ctx.tenantBodyBytes.size).toBe(0));
  });

  it('count_tokens is under the per-tenant concurrency limit, counted before the body is read', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { maxConcurrentRequests: 1 });
    const tok = await g.session('t1');
    const first = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 100 }, '/anthropic/v1/messages/count_tokens');
    first.req.write('{');
    await vi.waitFor(() => expect(g.gate.ctx.inflight.get('t1')).toBe(1));
    const second = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 100 }, '/anthropic/v1/messages/count_tokens');
    second.req.write('{');
    const r = await second.result;
    expect(r.status).toBe(429);
    first.req.destroy();
  });

  it('body bytes are released once the upstream request is written, not when the stream ends', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const p = g.messages(tok, 'slow');
    await vi.waitFor(() => expect(g.up.seen).toHaveLength(1));
    expect(g.gate.ctx.inflight.get('t1')).toBe(1); // still streaming
    expect(g.gate.ctx.bodyBytes).toBe(0);
    expect(g.gate.ctx.tenantBodyBytes.size).toBe(0);
    expect((await p).status).toBe(200);
  });

  it('pre-body rejections (401, 403, 404, 405) close the connection', async () => {
    g = await makeGate();
    await g.tenant('t1');
    await g.tenant('p', { }, {});
    const tokP = await g.session('p');
    await g.admin('POST', '/tenants/p/pause');
    const hdr = async (method: string, path: string, key: string) => {
      const res = await fetch(`http://127.0.0.1:${g.gate.ports.anthropic}${path}`, { method, headers: { 'x-api-key': key, 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      await res.text();
      return [res.status, res.headers.get('connection')];
    };
    expect(await hdr('POST', '/anthropic/v1/messages', 'nope')).toEqual([401, 'close']);
    expect(await hdr('POST', '/anthropic/v1/messages', tokP)).toEqual([403, 'close']);
    expect(await hdr('POST', '/anthropic/v1/other', 'x')).toEqual([404, 'close']);
    expect(await hdr('PUT', '/anthropic/v1/messages', 'x')).toEqual([404, 'close']);
  });

  it('a rejected request with a huge declared body does not hold the socket open', async () => {
    g = await makeGate();
    const socks: net.Socket[] = [];
    const closed = Array.from({ length: 5 }, () => new Promise<void>((resolve) => {
      const s = net.connect(g.gate.ports.anthropic, '127.0.0.1', () => {
        s.write('POST /anthropic/v1/messages HTTP/1.1\r\nhost: x\r\nx-api-key: bad\r\ncontent-type: application/json\r\ncontent-length: 1000000000000\r\n\r\n{');
      });
      s.on('data', () => undefined);
      s.on('close', () => resolve());
      s.on('error', () => undefined);
      socks.push(s);
    }));
    await Promise.race([Promise.all(closed), sleep(2000).then(() => { throw new Error('sockets still open'); })]);
    socks.forEach((s) => s.destroy());
  });

  it('chunked bodies are accounted as they arrive', async () => {
    g = await makeGate({ anthropicLimits: { maxInflightBodyBytes: 1000 } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    const { req, result } = slowPost(g.gate.ports.anthropic, tok);
    req.write('x'.repeat(1500));
    const r = await result;
    expect(r.status).toBe(429);
    await vi.waitFor(() => expect(g.gate.ctx.bodyBytes).toBe(0));
  });

  it('a body that does not arrive in time gets 408 and frees its slot', async () => {
    g = await makeGate({ anthropicLimits: { bodyTimeoutMs: 150 } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    const { req, result } = slowPost(g.gate.ports.anthropic, tok, { 'content-length': Buffer.byteLength(BODY) });
    req.write(BODY.slice(0, 10));
    const r = await result;
    expect(r.status).toBe(408);
    expect(g.up.seen).toHaveLength(0);
    expect(g.gate.ctx.inflight.get('t1')).toBe(0);
    expect((g.gate.ctx.live as any).count('t1', 'request')).toBe(0);
    expect(g.gate.ctx.bodyBytes).toBe(0);
  });

  it('413 for a declared body over 32 MiB', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const { req, result } = slowPost(g.gate.ports.anthropic, tok, { 'content-length': 33 * 1024 * 1024 });
    req.write('{');
    expect((await result).status).toBe(413);
  });

  it('chunked 32 MiB bodies of 0xFF sent together never push the accounted bytes over either cap', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { maxConcurrentRequests: 4 });
    const tok = await g.session('t1');
    const lim = g.gate.ctx.config.anthropicLimits;
    const chunk = Buffer.alloc(32 * 1024 * 1024, 0xff);
    let peakG = 0;
    let peakT = 0;
    const sampler = setInterval(() => {
      peakG = Math.max(peakG, g.gate.ctx.bodyBytes);
      peakT = Math.max(peakT, g.gate.ctx.tenantBodyBytes.get('t1') ?? 0);
    }, 1);
    try {
      const reqs = [1, 2].map(() => slowPost(g.gate.ports.anthropic, tok));
      reqs.forEach((r) => r.req.write(chunk));
      await vi.waitFor(() => expect(g.gate.ctx.tenantBodyBytes.get('t1')).toBe(2 * chunk.length), { timeout: 4000 });
      reqs.forEach((r) => r.req.end());
      const rs = await Promise.all(reqs.map((r) => r.result));
      expect(rs.map((r) => r.status)).toContain(429); // the other may fit once the first gave its bytes back (then 400: not UTF-8)
      expect(peakT).toBeLessThanOrEqual(lim.maxInflightBodyBytesPerTenant);
      expect(peakG).toBeLessThanOrEqual(lim.maxInflightBodyBytes);
      await vi.waitFor(() => expect(g.gate.ctx.bodyBytes).toBe(0));
      expect(g.gate.ctx.tenantBodyBytes.size).toBe(0);
      expect(g.up.seen).toHaveLength(0);
    } finally {
      clearInterval(sampler);
    }
  }, 20_000);

  it('a body that is not valid UTF-8 is refused instead of expanding to U+FFFD', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const body = Buffer.concat([Buffer.from('{"model":"m-1","max_tokens":10,"messages":[{"role":"user","content":"'), Buffer.alloc(1000, 0xff), Buffer.from('"}]}')]);
    const { req, result } = slowPost(g.gate.ports.anthropic, tok, { 'content-length': body.length });
    req.end(body);
    const r = await result;
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.message).toBe('body is not valid UTF-8');
    expect(g.gate.ctx.bodyBytes).toBe(0);
  });

  it('transient processing memory is accounted: a body that fits only once is refused when the cap is tight', async () => {
    g = await makeGate({ anthropicLimits: { maxInflightBodyBytes: 250 } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    const r = await g.messages(tok, 'json'); // 79 bytes raw, x4 = 316 > 250
    expect(r.status).toBe(429);
    expect(JSON.parse(r.text).error.message).toBe('too_many_inflight_bytes');
    expect(g.gate.ctx.bodyBytes).toBe(0);
  });
});

describe('5: egress bytes survive a flush', () => {
  it('counts bytes sent after the first flush (probe p2)', async () => {
    const tok = await connectSetup();
    const t = await proxyConnect(g.gate.ports.connect, `echo.test:${echo!.port}`, basic(tok));
    t.socket.write('a'.repeat(10));
    await readN(t.socket, 10);
    flushEgress(g.gate.ctx);
    let got = 0;
    await new Promise<void>((res) => {
      t.socket.on('data', (d) => { got += d.length; if (got >= 1000) res(); });
      t.socket.write('b'.repeat(1000));
    });
    flushEgress(g.gate.ctx);
    t.socket.destroy();
    expect(g.gate.ctx.db.prepare('SELECT bytes_up, bytes_down, tunnels FROM egress_stats').all()).toEqual([{ bytes_up: 1010, bytes_down: 1010, tunnels: 1 }]);
  });
});

describe('6: deny set and connector routes', () => {
  it('loopback / link-local stay denied for tailnet IPs even when the connector routes cover them', async () => {
    const tok = await connectSetup({}, undefined, { tailnet: true, tailnetAllow: ['127.0.0.0/8:*', '169.254.0.0/16:*', '0.0.0.0/8:*'] });
    expect((await g.admin('PUT', '/connectors/t1', { socksAddr: socks!.addr, status: 'up', routes: { cidrs: ['127.0.0.0/8', '169.254.0.0/16'] } })).status).toBe(200);
    for (const a of ['127.0.0.1:22', '169.254.169.254:80', '0.0.0.1:22', '[::1]:22', '[fe80::1]:22']) {
      const r = await proxyConnect(g.gate.ports.connect, a, basic(tok));
      expect([a, r.status, r.reason]).toEqual([a, 403, 'denied_address']);
      r.socket.destroy();
    }
    expect(socks!.targets).toHaveLength(0);
  });

  it('hostAddresses are denied inside connector routes', async () => {
    const tok = await connectSetup({ hostAddresses: ['100.70.1.1/32'] }, undefined, { tailnet: true, tailnetAllow: ['100.70.0.0/16:*'] });
    await g.admin('PUT', '/connectors/t1', { socksAddr: socks!.addr, status: 'up', routes: { cidrs: ['100.70.0.0/16'] } });
    expect((await proxyConnect(g.gate.ports.connect, '100.70.1.1:22', basic(tok))).reason).toBe('denied_address');
    const ok = await proxyConnect(g.gate.ports.connect, '100.70.1.2:22', basic(tok));
    expect(ok.status).toBe(200);
    ok.socket.destroy();
  });

  it('parseCidr no longer folds ::ffff:0:0/96 into 0.0.0.0/0; mapped prefixes are invalid', () => {
    expect(parseCidr('::ffff:0:0/96')).toBeNull();
    expect(parseCidr('::ffff:1.2.3.4/120')).toBeNull();
    expect(parseCidr('1.2.3.4/24')).toMatchObject({ v: 4, bits: 24 });
  });

  it('connector routes: nothing broader than /8 (v4) or /16 (v6), no default routes, no mapped forms', () => {
    for (const bad of ['0.0.0.0/0', '::/0', '10.0.0.0/7', '128.0.0.0/1', 'fd00::/15', '::ffff:0:0/96', '::ffff:10.0.0.0/104', '::ffff:1.2.3.4', 'junk']) {
      expect([bad, validConnectorCidr(bad)]).toEqual([bad, false]);
    }
    for (const good of ['10.0.0.0/8', '100.64.0.0/10', '100.70.163.88/32', '192.168.8.0/24', 'fd7a:115c:a1e0::/48', 'fd00::/16', '1.2.3.4']) {
      expect([good, validConnectorCidr(good)]).toEqual([good, true]);
    }
  });

  it('PUT /connectors rejects an exit node route copied into cidrs', async () => {
    await connectSetup();
    for (const cidrs of [['0.0.0.0/0'], ['::/0'], ['10.0.0.0/8', '0.0.0.0/0'], ['::ffff:0:0/96']]) {
      const r = await g.admin('PUT', '/connectors/t1', { socksAddr: socks!.addr, status: 'up', routes: { cidrs, exitNode: true } });
      expect([cidrs, r.status, r.json.error]).toEqual([cidrs, 400, 'bad_cidrs']);
    }
    expect((await g.admin('PUT', '/connectors/t1', { socksAddr: socks!.addr, status: 'up', routes: { cidrs: ['100.64.0.0/10'], exitNode: true } })).status).toBe(200);
  });

  it('tailnet allowlist hostnames: only MagicDNS FQDNs or single labels', () => {
    for (const bad of ['example.com:443', '*.corp.lan:22', '*:22', '*.ts.net.evil.com:22', 'a..ts.net:22', '*nas:22']) {
      expect([bad, parseTailnetAllow(bad)]).toEqual([bad, null]);
      expect(() => normalizePolicy({ egress: { tailnetAllow: [bad] } })).toThrow();
    }
    for (const good of ['ha.tail1.ts.net:8123', '*.tail1.ts.net:22', 'nas:22', 'NAS:22']) expect(parseTailnetAllow(good)).not.toBeNull();
  });

  it('localhost is never a tailnet name, even if allowlisted', async () => {
    const tok = await connectSetup({}, undefined, { tailnet: true, tailnetAllow: ['localhost:22'] });
    await g.admin('PUT', '/connectors/t1', { socksAddr: socks!.addr, status: 'up', routes: { cidrs: [] } });
    const r = await proxyConnect(g.gate.ports.connect, 'localhost:22', basic(tok));
    expect([r.status, r.reason]).toEqual([403, 'denied_address']);
  });
});

describe('7: the reservation is an upper bound', () => {
  const tool = (o: Record<string, unknown> = {}) => ({ tools: [{ type: 'web_search_20250305', name: 'web_search', ...o }] });

  it('injects max_uses when absent or invalid and clamps it to the ceiling', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    await g.messages(tok, 'json', tool());
    await g.messages(tok, 'json', tool({ max_uses: 50 }));
    await g.messages(tok, 'json', tool({ max_uses: 3 }));
    await g.messages(tok, 'json', tool({ max_uses: 'lots' }));
    expect(g.up.seen.map((s) => s.body.tools[0].max_uses)).toEqual([5, 10, 3, 5]);
  });

  it('web_fetch gets max_content_tokens injected / clamped; code_execution and others get no max_uses', async () => {
    g = await makeGate({ prices: { ...PRICES, serverTools: { ...PRICES.serverTools, code_execution: 0.05 } } });
    await g.tenant('t1', {}, { serverTools: ['web_search', 'web_fetch', 'code_execution'] });
    const tok = await g.session('t1');
    const fetchTool = (o: Record<string, unknown> = {}) => ({ tools: [{ type: 'web_fetch_20250910', name: 'web_fetch', ...o }] });
    await g.messages(tok, 'json', fetchTool());
    await g.messages(tok, 'json', fetchTool({ max_content_tokens: 1_000_000 }));
    await g.messages(tok, 'json', fetchTool({ max_content_tokens: 800 }));
    await g.messages(tok, 'json', { tools: [{ type: 'code_execution_20250825', name: 'code_execution' }] });
    expect(g.up.seen.slice(0, 3).map((s) => s.body.tools[0].max_content_tokens)).toEqual([25_000, 25_000, 800]);
    expect(g.up.seen[0]!.body.tools[0].max_uses).toBe(5);
    expect(g.up.seen[3]!.body.tools[0]).toEqual({ type: 'code_execution_20250825', name: 'code_execution' });
  });

  it('Anthropic-defined client tools pass untouched with no price entry', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const tools = [{ type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' }, { type: 'bash_20250124', name: 'bash' }, { type: 'memory_20250818', name: 'memory' }];
    expect((await g.messages(tok, 'json', { tools })).status).toBe(200);
    expect(g.up.seen[0]!.body.tools).toEqual(tools);
  });

  it('url / file_id sourced documents and images are refused (their size is not in the body)', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const msg = (block: unknown) => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'json' }, block] }] });
    for (const block of [
      { type: 'document', source: { type: 'url', url: 'https://example.com/huge.pdf' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/i.png' } },
      { type: 'document', source: { type: 'file', file_id: 'file_1' } },
      { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }] },
    ]) {
      const r = await g.messages(tok, 'json', msg(block));
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text).error.message).toMatch(/^remote_source_not_allowed/);
    }
    expect(g.up.seen).toHaveLength(0);
    expect(count('SELECT COUNT(*) AS n FROM reservations')).toBe(0);
    const ok = await g.messages(tok, 'json', msg({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' } }));
    expect(ok.status).toBe(200);
  });

  it('a versioned price key reserves and settles the same server tool', async () => {
    g = await makeGate({ prices: { ...PRICES, serverTools: { web_search_2025: 0.01 } } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    expect((await g.messages(tok, 'json', tool())).status).toBe(200);
    expect(serverToolMicros(validatePrices({ ...PRICES, serverTools: { web_search_2025: 0.01 } }), 'web_search')).toBe(10_000);
  });

  it('reserves the per-use result-input allowance on top of the per-use price', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    await g.messages(tok, 'json', { max_tokens: 100, ...tool({ max_uses: 2 }) });
    const { reserved_micros } = g.gate.ctx.db.prepare('SELECT reserved_micros FROM reservations').get() as { reserved_micros: number };
    // 2 uses * (0.01 USD + 25k input tokens at the dearest rate, 6 micros/token) + 100 output tokens * 15
    expect(reserved_micros).toBeGreaterThanOrEqual(2 * (10_000 + 25_000 * 6) + 1500);
  });

  it('a policy-allowed server tool missing from the price table is rejected 400', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { serverTools: ['web_search', 'code_execution'] });
    const tok = await g.session('t1');
    const r = await g.messages(tok, 'json', { tools: [{ type: 'code_execution_20250522', name: 'code_execution' }] });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.message).toMatch(/^server_tool_unpriced/);
    expect(g.up.seen).toHaveLength(0);
    expect(count('SELECT COUNT(*) AS n FROM reservations')).toBe(0);
  });

  const reservedMicros = () => (g.gate.ctx.db.prepare('SELECT reserved_micros AS r FROM reservations ORDER BY rowid DESC LIMIT 1').get() as { r: number }).r;
  const b64 = (t: string) => Buffer.from(t, 'latin1').toString('base64');

  it('base64 images reserve a per-image token ceiling, not bytes/2', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64('x'.repeat(300)) } };
    const messages = [{ role: 'user', content: [{ type: 'text', text: 'json' }, ...Array.from({ length: 100 }, () => img)] }];
    expect((await g.messages(tok, 'json', { messages })).status).toBe(200);
    expect(reservedMicros()).toBeGreaterThanOrEqual(100 * IMAGE_TOKEN_CEILING * 6);
  });

  it('base64 PDFs reserve pages x per-page tokens; an unreadable page count falls back to a size bound', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const pdf = (data: string) => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'json' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }] }] });
    const pages = '%PDF-1.4\n' + '<< /Type /Page /Parent 1 0 R >>\n'.repeat(100) + '<< /Type /Pages >>\n';
    expect((await g.messages(tok, 'json', pdf(b64(pages)))).status).toBe(200);
    expect(reservedMicros()).toBeGreaterThanOrEqual(100 * PDF_PAGE_TOKENS * 6);
    const packed = '%PDF-1.5\n/ObjStm ' + 'z'.repeat(20_000);
    expect((await g.messages(tok, 'json', pdf(b64(packed)))).status).toBe(200);
    expect(reservedMicros()).toBeGreaterThanOrEqual(Math.floor(20_000 / 50) * PDF_PAGE_TOKENS * 6);
  });

  it('a client max_uses on a tool whose schema has none is refused, never trusted', async () => {
    g = await makeGate({ prices: { ...PRICES, serverTools: { ...PRICES.serverTools, code_execution: 0.05 } } });
    await g.tenant('t1', {}, { serverTools: ['web_search', 'code_execution'] });
    const tok = await g.session('t1');
    const r = await g.messages(tok, 'json', { tools: [{ type: 'code_execution_20250825', name: 'code_execution', max_uses: 0.0001 }] });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.text).error.message).toMatch(/^max_uses_not_supported/);
    expect(g.up.seen).toHaveLength(0);
  });

  it('serverToolCapMicros honours max_uses only for web_search / web_fetch; others reserve the worst-case loop', () => {
    const t = validatePrices({ ...PRICES, serverTools: { ...PRICES.serverTools, code_execution: 0.05 } });
    const m1 = serverToolCapMicros(t, [{ type: 'code_execution_20250825', max_uses: 0.0001 }], 'm-1', 0, 5, 10);
    expect(m1).toBe(10 * 50_000);
    expect(serverToolCapMicros(t, [{ type: 'web_search_20250305', max_uses: 50 }], 'm-1', 0, 5, 10)).toBe(10 * 10_000);
    expect(serverToolCapMicros(t, [{ type: 'web_search_20250305' }], 'm-1', 0, 5, 10)).toBe(5 * 10_000);
  });

  it('tool_use arguments shaped like a url source do not lock a conversation out; real content blocks still do', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const history = [
      { role: 'user', content: 'json' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'load', input: { source: { type: 'url', url: 'https://example.com/x' } } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: 'ok' }] }] },
    ];
    expect((await g.messages(tok, 'json', { messages: history })).status).toBe(200);
    const nested = [{ role: 'user', content: [{ type: 'document', source: { type: 'content', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/i.png' } }] } }] }];
    expect((await g.messages(tok, 'json', { messages: nested })).status).toBe(400);
  });
});

describe('8: purpose attribution is server-side', () => {
  it('session tokens record "agent" whatever the header says; host tokens keep their minted purpose', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const host = (await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'miniapp' })).json.token;
    await g.messages(tok, 'json', {}, { 'x-nanogate-purpose': 'system' });
    await g.messages(host, 'json', {}, { 'x-nanogate-purpose': 'stt' }, g.gate.ports.host);
    expect(g.usageRows().map((u) => u.purpose)).toEqual(['agent', 'miniapp']);
  });
});

describe('9: settlement errors and hung upstreams', () => {
  it('a failing settle does not crash; the open reservation is charged conservatively by the sweep', async () => {
    g = await makeGate({}, undefined, { sweepIntervalMs: 60 });
    await g.tenant('t1');
    const tok = await g.session('t1');
    g.gate.ctx.db.exec("CREATE TRIGGER boom BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'boom'); END");
    const r = await g.messages(tok, 'sse');
    expect(r.status).toBe(200);
    expect(r.text).toContain('message_stop');
    expect(g.usageRows()).toHaveLength(0);
    expect(count("SELECT COUNT(*) AS n FROM reservations WHERE status='open'")).toBe(1);
    expect(g.gate.ctx.inflight.get('t1')).toBe(0);
    expect(g.gate.ctx.activeReservations.size).toBe(0);
    // the gateway keeps serving
    g.gate.ctx.db.exec('DROP TRIGGER boom');
    await vi.waitFor(() => expect(g.usageRows()).toHaveLength(1), { timeout: 5000 });
    const res = g.gate.ctx.db.prepare('SELECT reserved_micros, status FROM reservations').get() as any;
    expect(res.status).toBe('abandoned');
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: res.reserved_micros });
    expect((await g.messages(tok, 'json')).status).toBe(200);
  });

  it('the sweep leaves reservations of requests still in flight alone', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const p = g.messages(tok, 'slow');
    await vi.waitFor(() => expect(g.gate.ctx.activeReservations.size).toBe(1));
    expect(sweepOpenReservations(g.gate.ctx.db, g.gate.ctx.config.prices, g.gate.ctx.activeReservations)).toBe(0);
    expect((await p).status).toBe(200);
    expect(g.usageRows()[0]!.status).toBe('reconciled');
  });

  it('no response headers within the timeout: 504, upstream aborted, full reservation charged', async () => {
    g = await makeGate({ anthropicLimits: { upstreamHeadersTimeoutMs: 100, upstreamNonStreamTimeoutMs: 100 } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    g.up.server.removeAllListeners('request');
    g.up.server.on('request', () => undefined); // accepts, never answers
    const r = await g.messages(tok, 'x');
    expect(r.status).toBe(504);
    const res = g.gate.ctx.db.prepare('SELECT reserved_micros, status FROM reservations').get() as any;
    expect(res.status).toBe('abandoned');
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: res.reserved_micros });
    expect(g.gate.ctx.inflight.get('t1')).toBe(0);
  });

  it('a stream silent for the idle timeout is aborted and charged the full reservation', async () => {
    g = await makeGate({ anthropicLimits: { streamIdleMs: 100 } });
    await g.tenant('t1');
    const tok = await g.session('t1');
    g.up.server.removeAllListeners('request');
    g.up.server.on('request', (_q, r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      r.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`);
    });
    const r = await g.messages(tok, 'x');
    await vi.waitFor(() => expect(g.usageRows()).toHaveLength(1), { timeout: 5000 });
    const res = g.gate.ctx.db.prepare('SELECT reserved_micros FROM reservations').get() as any;
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: res.reserved_micros, input_tokens: 10 });
  });
});

describe('10: IPv6 deny gaps and multi-address dialling', () => {
  const answers: Record<string, string[]> = {
    'siit.test': ['::ffff:0:8.8.8.8'],
    'nat64local.test': ['64:ff9b:1::1'],
    'discard.test': ['100::1'],
    'nat64.test': ['64:ff9b::8.8.8.8'],
    'v6first.test': ['::1', '127.0.0.1'],
    'firstdead.test': ['127.0.0.2', '127.0.0.1'],
    'alldead.test': ['127.0.0.2', '127.0.0.3'],
  };
  const resolver = async (h: string) => (answers[h] ?? ['127.0.0.1']).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

  it.each(['siit.test', 'nat64local.test', 'discard.test', 'nat64.test'])('%s is denied', async (host) => {
    const tok = await connectSetup({}, resolver);
    const r = await proxyConnect(g.gate.ports.connect, `${host}:${echo!.port}`, basic(tok));
    expect([r.status, r.reason]).toEqual([403, 'denied_address']);
  });

  it('tries IPv4 before IPv6, and the next address when one fails', async () => {
    const tok = await connectSetup({ socksTimeoutMs: 1000 }, resolver);
    for (const h of ['v6first.test', 'firstdead.test']) {
      const r = await proxyConnect(g.gate.ports.connect, `${h}:${echo!.port}`, basic(tok));
      expect([h, r.status]).toEqual([h, 200]);
      r.socket.write('ok');
      expect(await readN(r.socket, 2)).toBe('ok');
      r.socket.destroy();
    }
  });

  it('502 dial_failed when every address fails', async () => {
    const tok = await connectSetup({ socksTimeoutMs: 1000 }, resolver);
    const r = await proxyConnect(g.gate.ports.connect, `alldead.test:${echo!.port}`, basic(tok));
    expect([r.status, r.reason]).toEqual([502, 'dial_failed']);
  });
});

describe('11: narrowing policy or connector kills live tunnels', () => {
  const putConnector = (o: Record<string, unknown> = {}) =>
    g.admin('PUT', '/connectors/t1', { socksAddr: socks!.addr, status: 'up', routes: { cidrs: ['100.70.163.88/32', '100.70.163.89/32'], exitNode: false }, ...o });
  const tailnetPolicy = { tailnet: true, tailnetAllow: ['100.70.163.0/24:*'], ports: [] as number[] };

  async function tunnel(tok: string, addr = '100.70.163.88:22') {
    const r = await proxyConnect(g.gate.ports.connect, addr, basic(tok));
    expect(r.status).toBe(200);
    return new Promise<net.Socket>((res) => res(r.socket));
  }
  const closedOf = (s: net.Socket) => new Promise<void>((res) => s.on('close', () => res()));

  it('PUT /tenants with a narrower policy drops the tenant tunnels; an identical policy does not', async () => {
    const tok = await connectSetup({}, undefined, tailnetPolicy);
    await putConnector();
    const s = await tunnel(tok);
    const closed = closedOf(s);
    await g.tenant('t1', { budgetLimitMicros: null }, { egress: { route: 'direct', ...tailnetPolicy } });
    await sleep(100);
    expect(s.destroyed).toBe(false); // same policy, same tunnel
    await g.tenant('t1', {}, { egress: { route: 'direct', ...tailnetPolicy, tailnet: false } });
    await closed;
  });

  it('narrower ports and allowlist also drop it', async () => {
    const tok = await connectSetup({}, undefined, tailnetPolicy);
    await putConnector();
    const s = await tunnel(tok);
    const closed = closedOf(s);
    await g.tenant('t1', {}, { egress: { route: 'direct', ...tailnetPolicy, tailnetAllow: ['100.70.163.99/32:*'] } });
    await closed;
  });

  it('PUT /connectors with fewer cidrs (or another address) drops tunnels carried by it; same content does not', async () => {
    const tok = await connectSetup({}, undefined, tailnetPolicy);
    await putConnector();
    const s = await tunnel(tok);
    const closed = closedOf(s);
    await putConnector(); // heartbeat, unchanged
    await sleep(100);
    expect(s.destroyed).toBe(false);
    await putConnector({ routes: { cidrs: ['100.70.163.89/32'], exitNode: false } });
    await closed;
  });

  it('DELETE /connectors drops them', async () => {
    const tok = await connectSetup({}, undefined, tailnetPolicy);
    await putConnector();
    const s = await tunnel(tok);
    const closed = closedOf(s);
    await g.admin('DELETE', '/connectors/t1');
    await closed;
  });
});
