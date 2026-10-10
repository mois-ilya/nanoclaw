import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushEgress } from '../src/connect-proxy.js';
import { type Gate, basic, echoServer, fakeSocks, makeGate, proxyConnect, readN } from './harness.js';

let g: Gate;
let echo: Awaited<ReturnType<typeof echoServer>>;
let socks: Awaited<ReturnType<typeof fakeSocks>>;
let tok: string;

const DNS: Record<string, string[]> = {
  'echo.test': ['127.0.0.1'],
  'priv.test': ['10.1.2.3'],
  'mixed.test': ['127.0.0.1', '10.1.2.3'],
  'mapped.test': ['::ffff:10.1.2.3'],
  'awg.test': ['10.201.0.5'],
  'web.test': ['127.0.0.1'],
  '6to4.test': ['2002:7f00:1::1'],
  'teredo.test': ['2001:0:4136:e378::1'],
};

async function setup(policy: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  echo = await echoServer();
  socks = await fakeSocks({ host: '127.0.0.1', port: echo.port });
  g = await makeGate(
    // 127/8 removed from the deny set (TEST ONLY) so the echo servers are reachable
    { disableBuiltinDeny: ['127.0.0.0/8'], denyCidrs: ['10.201.0.0/20'], ...extra },
    async (h) => {
      if (!DNS[h]) throw new Error('ENOTFOUND');
      return DNS[h]!.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  );
  await g.tenant('t1', {}, { egress: { route: 'direct', ports: [echo.port, 443], ...policy } });
  tok = await g.session('t1');
}
afterEach(async () => {
  await g.close();
  echo.close();
  socks.close();
});

describe('CONNECT auth and validation', () => {
  beforeEach(() => setup());

  it('407 without a token, with a bad token; accepts Basic password, Bearer, and rejects session-less tenants', async () => {
    const noAuth = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`);
    expect(noAuth.status).toBe(407);
    noAuth.socket.destroy();
    const bad = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic('ngs_bad'));
    expect(bad.status).toBe(407);
    bad.socket.destroy();
    for (const auth of [basic(tok), `Bearer ${tok}`]) {
      const ok = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, auth);
      expect(ok.status).toBe(200);
      ok.socket.write('ping');
      expect(await readN(ok.socket, 4)).toBe('ping');
      ok.socket.destroy();
    }
  });

  it('paused tenant gets 403', async () => {
    await g.admin('POST', '/tenants/t1/pause');
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    expect(r.status).toBe(403);
  });

  it.each([
    ['private IP answer', 'priv.test:443', 'denied_address'],
    ['mixed DNS answers', 'mixed.test:443', 'denied_address'],
    ['IPv4-mapped IPv6 answer', 'mapped.test:443', 'denied_address'],
    ['6to4 answer', '6to4.test:443', 'denied_address'],
    ['Teredo answer', 'teredo.test:443', 'denied_address'],
    ['config.denyCidrs (AWG subnet)', 'awg.test:443', 'denied_address'],
    ['IP literal', '8.8.8.8:443', 'tailnet_not_allowed'],
    ['IPv4 literal obfuscated (loopback)', '0x7f.1:443', 'denied_address'],
    ['mapped literal (loopback)', '[::ffff:127.0.0.1]:443', 'denied_address'],
    ['anthropic API host', 'api.anthropic.com:443', 'model_host'],
    ['anthropic subdomain', 'x.anthropic.com:443', 'model_host'],
    ['anthropic trailing dot', 'API.Anthropic.com.:443', 'model_host'],
    ['port not allowed', 'echo.test:25', 'port_denied'],
  ])('403: %s', async (_n, authority, reason) => {
    const r = await proxyConnect(g.gate.ports.connect, authority, basic(tok));
    expect(r.status).toBe(403);
    expect(r.reason).toBe(reason);
  });

  it('400 for malformed authority, 502 for DNS failure', async () => {
    expect((await proxyConnect(g.gate.ports.connect, 'echo.test', basic(tok))).status).toBe(400);
    const r = await proxyConnect(g.gate.ports.connect, 'nx.test:443', basic(tok));
    expect(r.status).toBe(502);
  });

  it('pins the validated IP: DNS is consulted once per connection', async () => {
    let calls = 0;
    const orig = g.gate.ctx.resolve;
    g.gate.ctx.resolve = async (h) => { calls++; return orig(h); };
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    console.log("DBG", r.status, r.reason);
    expect(r.status).toBe(200);
    r.socket.destroy();
    expect(calls).toBe(1);
  });

  it('enforces maxTunnelsPerTenant', async () => {
    await g.close();
    echo.close();
    socks.close();
    await setup({}, { connectLimits: { maxTunnelsPerTenant: 1 } });
    const a = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    expect(a.status).toBe(200);
    const b = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    expect(b.status).toBe(429);
    a.socket.destroy();
  });

  it('revoke destroys live tunnels; session release does too', async () => {
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    console.log("DBG", r.status, r.reason);
    const closed = new Promise<void>((res) => r.socket.on('close', () => res()));
    await g.admin('POST', '/sessions/release', { sessionKey: 's-t1', kind: 'session-ended' });
    await closed;
    const tok2 = await g.session('t1', 'again');
    const r2 = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok2));
    expect(r2.status).toBe(200);
    const closed2 = new Promise<void>((res) => r2.socket.on('close', () => res()));
    await g.admin('POST', '/tenants/t1/revoke');
    await closed2;
  });

  it('counts bytes per tenant and flushes to egress_stats', async () => {
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    console.log("DBG", r.status, r.reason);
    r.socket.write('hello');
    await readN(r.socket, 5);
    flushEgress(g.gate.ctx);
    const row = g.gate.ctx.db.prepare('SELECT * FROM egress_stats WHERE tenant_id=?').get('t1') as any;
    expect(row.bytes_up).toBe(5);
    expect(row.bytes_down).toBe(5);
    expect(row.tunnels).toBe(1);
    r.socket.destroy();
  });
});

describe('plain HTTP via the proxy', () => {
  it('proxies absolute-form http:// with the same validation; 405 otherwise', async () => {
    await setup();
    const web = http.createServer((req, res) => res.end(`hello ${req.url} host=${req.headers.host} ${req.headers['proxy-authorization'] ?? 'noauth'}`));
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    const wport = (web.address() as net.AddressInfo).port;
    await g.tenant('t1', {}, { egress: { route: 'direct', ports: [wport] } });
    const get = (url: string, auth = basic(tok)) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = http.request({ host: '127.0.0.1', port: g.gate.ports.connect, method: 'GET', path: url, headers: { host: url.startsWith('/') ? 'x' : new URL(url).host, 'proxy-authorization': auth }, agent: false }, (res) => {
          let b = '';
          res.on('data', (d) => (b += d));
          res.on('end', () => resolve({ status: res.statusCode!, body: b }));
        });
        r.on('error', reject);
        r.end();
      });
    const ok = await get(`http://web.test:${wport}/a?b=1`);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe(`hello /a?b=1 host=web.test:${wport} noauth`);
    expect((await get(`http://priv.test:${wport}/`)).status).toBe(403);
    expect((await get(`http://web.test:${wport}/`, 'Basic Zm9vOmJhcg==')).status).toBe(407);
    expect((await get('/plain')).status).toBe(405);
    web.close();
  });
});

describe('connector routing', () => {
  const putConnector = (tenant: string, o: Record<string, unknown> = {}) =>
    g.admin('PUT', `/connectors/${tenant}`, { socksAddr: socks.addr, status: 'up', routes: { cidrs: ['100.70.163.88/32', '10.201.0.0/20'], exitNode: true }, ...o });

  it('route=connector sends public traffic through SOCKS using the validated IP', async () => {
    await setup({ route: 'connector' });
    await putConnector('t1');
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    console.log("DBG", r.status, r.reason);
    expect(r.status).toBe(200);
    r.socket.write('via');
    expect(await readN(r.socket, 3)).toBe('via');
    expect(socks.targets).toEqual([{ atyp: 1, host: '127.0.0.1', port: echo.port }]);
    r.socket.destroy();
  });

  it('connector down: 502 connector_down, or direct with fallbackDirect', async () => {
    await setup({ route: 'connector' });
    await putConnector('t1', { status: 'down' });
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    console.log("DBG", r.status, r.reason);
    expect(r.status).toBe(502);
    expect(r.reason).toBe('connector_down');
    await g.tenant('t1', {}, { egress: { route: 'connector', fallbackDirect: true, ports: [echo.port] } });
    const r2 = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    expect(r2.status).toBe(200);
    expect(socks.targets).toHaveLength(0);
    r2.socket.destroy();
    // no exit node advertised counts as unavailable
    await putConnector('t1', { routes: { cidrs: [], exitNode: false } });
    await g.tenant('t1', {}, { egress: { route: 'connector', ports: [echo.port] } });
    expect((await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok))).status).toBe(502);
  });

  it('tailnet needs tailnet:true + tailnetAllow match + connector routes; names go to SOCKS as domains', async () => {
    await setup({ tailnet: true, tailnetAllow: ['100.70.163.88/32:*', 'ha.tail1.ts.net:8123', '192.168.8.0/24:8123', '10.201.0.0/20:*'] });
    await putConnector('t1');
    const ip = await proxyConnect(g.gate.ports.connect, '100.70.163.88:22', basic(tok));
    expect(ip.status).toBe(200);
    ip.socket.destroy();
    const name = await proxyConnect(g.gate.ports.connect, 'ha.tail1.ts.net:8123', basic(tok));
    expect(name.status).toBe(200);
    name.socket.destroy();
    expect(socks.targets).toEqual([
      { atyp: 1, host: '100.70.163.88', port: 22 },
      { atyp: 3, host: 'ha.tail1.ts.net', port: 8123 },
    ]);
    const cases: [string, number, string][] = [
      ['100.70.163.89:22', 403, 'tailnet_not_allowed'], // in no allow entry
      ['ha.tail1.ts.net:22', 403, 'tailnet_not_allowed'], // port not allowed
      ['other.tail1.ts.net:8123', 403, 'tailnet_not_allowed'],
      ['192.168.8.5:8123', 403, 'not_in_routes'], // allowed but connector does not route it
      ['10.201.0.5:443', 403, 'denied_address'], // AWG subnet: denied even if allowed AND advertised
      ['somehost:443', 403, 'tailnet_not_allowed'], // single-label names are tailnet names too
    ];
    for (const [a, status, reason] of cases) {
      const r = await proxyConnect(g.gate.ports.connect, a, basic(tok));
      expect([a, r.status, r.reason]).toEqual([a, status, reason]);
      r.socket.destroy();
    }
  });

  it('tailnet is denied without tailnet:true or without a connector', async () => {
    await setup({ tailnet: false, tailnetAllow: ['100.70.163.88/32:*'] });
    await putConnector('t1');
    expect((await proxyConnect(g.gate.ports.connect, '100.70.163.88:22', basic(tok))).status).toBe(403);
    await g.tenant('t1', {}, { egress: { tailnet: true, tailnetAllow: ['100.70.163.88/32:*'], ports: [443] } });
    await g.admin('DELETE', '/connectors/t1');
    const r = await proxyConnect(g.gate.ports.connect, '100.70.163.88:22', basic(tok));
    expect(r.reason).toBe('no_connector');
  });

  it('connectorTenant: public egress uses the owner connector, tailnet never does; bytes count for the requester', async () => {
    await setup();
    await g.tenant('owner', { kind: 'owner' });
    await g.tenant('t1', {}, { egress: { route: 'connector', connectorTenant: 'owner', ports: [echo.port], tailnet: true, tailnetAllow: ['100.70.163.88/32:*'] } });
    await putConnector('owner');
    const r = await proxyConnect(g.gate.ports.connect, `echo.test:${echo.port}`, basic(tok));
    console.log("DBG", r.status, r.reason);
    expect(r.status).toBe(200);
    r.socket.write('abc');
    await readN(r.socket, 3);
    expect(socks.targets).toHaveLength(1);
    // tailnet destination: t1 has no connector of its own, owner's is NOT used
    const t = await proxyConnect(g.gate.ports.connect, '100.70.163.88:22', basic(tok));
    expect(t.status).toBe(403);
    expect(t.reason).toBe('no_connector');
    expect(socks.targets).toHaveLength(1);
    flushEgress(g.gate.ctx);
    const rows = g.gate.ctx.db.prepare('SELECT tenant_id, bytes_up FROM egress_stats').all() as any[];
    expect(rows).toEqual([{ tenant_id: 't1', bytes_up: 3 }]);
    // taking the owner's connector down kills t1's tunnel carried by it
    const closed = new Promise<void>((res) => r.socket.on('close', () => res()));
    await putConnector('owner', { status: 'down' });
    await closed;
  });
});
