import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parseRpc } from '../src/mcp-proxy.js';
import { MCP_TEST_CERT, MCP_TEST_KEY } from './fixtures/mcp-cert.js';
import { type Gate, makeGate } from './harness.js';

const KEY = 'ghp_SECRETKEYVALUE0123456789';
const NEWKEY = 'ghp_ANOTHERVALIDKEY987654321';

// ---- fake MCP upstream: HTTPS on loopback, JSON or SSE, with or without a session id -----------------------------

interface FakeOpts {
  /** issue an Mcp-Session-Id on initialize (default true) */
  stateful?: boolean;
  /** answer tools/list as SSE */
  listSse?: boolean;
  redirect?: boolean;
}

const TOOLS = [
  { name: 'get_thing', annotations: { readOnlyHint: true, title: 'Get thing' } },
  { name: 'stream_thing', annotations: { readOnlyHint: true } },
  { name: 'slow_thing', annotations: { readOnlyHint: true } },
  { name: 'endless_thing', annotations: { readOnlyHint: true } },
  { name: 'err_thing', annotations: { readOnlyHint: true } },
  { name: 'create_thing', description: 'no annotations' },
  { name: 'delete_thing', annotations: { readOnlyHint: false } },
  { name: 'odd_thing', annotations: { readOnlyHint: 'true' } },
];

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

async function fakeMcp(o: FakeOpts = {}) {
  const seen: Seen[] = [];
  const calls: Record<string, number> = {};
  const valid = new Set([KEY, NEWKEY]);
  const state = { streamEnded: false, upstreamClosedEndless: false, refuseAll: false, tools: TOOLS as unknown[] };
  const server = https.createServer({ key: MCP_TEST_KEY, cert: MCP_TEST_CERT }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // not JSON
      }
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      // These must never reach the agent.
      const leak = { 'set-cookie': 'upstream=1', 'www-authenticate': 'Bearer realm="x"', 'x-upstream-private': '1' };
      if (o.redirect) {
        res.writeHead(302, { location: `https://mcp.test:${(server.address() as net.AddressInfo).port}/elsewhere` });
        return void res.end();
      }
      if (state.refuseAll || !valid.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) {
        res.writeHead(401, { 'content-type': 'application/json', ...leak });
        return void res.end('{"error":"bad credentials"}');
      }
      if (req.method === 'DELETE') {
        res.writeHead(200, leak);
        return void res.end();
      }
      const id = body?.id;
      const json = (result: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
          ...leak,
          ...extra,
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      switch (body?.method) {
        case 'initialize':
          return json(
            { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } },
            o.stateful === false ? {} : { 'mcp-session-id': 'up-sid-1' },
          );
        case 'tools/list':
          if (o.listSse) {
            res.writeHead(200, { 'content-type': 'text/event-stream', ...leak });
            return void res.end(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id, result: { tools: state.tools } })}\n\n`,
            );
          }
          return json({ tools: state.tools });
        case 'tools/call': {
          const name = body.params.name as string;
          calls[name] = (calls[name] ?? 0) + 1;
          if (name === 'stream_thing') {
            res.writeHead(200, { 'content-type': 'text/event-stream', ...leak });
            res.write(
              `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`,
            );
            return void setTimeout(() => {
              state.streamEnded = true;
              res.end(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'streamed' }] } })}\n\n`,
              );
            }, 400);
          }
          if (name === 'endless_thing') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            const t = setInterval(() => res.write(': tick\n\n'), 30);
            res.on('close', () => {
              clearInterval(t);
              state.upstreamClosedEndless = true;
            });
            return;
          }
          if (name === 'slow_thing')
            return void setTimeout(() => !res.destroyed && json({ content: [{ type: 'text', text: 'slow' }] }), 1500);
          if (name === 'err_thing') return json({ isError: true, content: [{ type: 'text', text: 'nope' }] });
          return json({ content: [{ type: 'text', text: `ok:${name}` }] });
        }
        default:
          if (body && body.id === undefined) {
            res.writeHead(202, leak);
            return void res.end();
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no such method' } }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    calls,
    valid,
    state,
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
type Fake = Awaited<ReturnType<typeof fakeMcp>>;

// ---- fixture ------------------------------------------------------------------------------------------------------

const CID = 'gh-test1';
const resolver = async (host: string) => {
  if (host === 'mcp.test' || host === 'mcp2.test') return [{ address: '127.0.0.1', family: 4 }];
  if (host === 'deny.test') return [{ address: '10.0.0.1', family: 4 }];
  return [];
};

let g: Gate;
let up: Fake;
let logs: string[];
afterEach(async () => {
  await g?.close();
  await up?.close();
});

async function setup(
  fake: FakeOpts = {},
  mcp: Record<string, unknown> = {},
  extra: { putSecret?: boolean; policy?: Record<string, string>; url?: string } = {},
) {
  up = await fakeMcp(fake);
  logs = [];
  g = await makeGate({ disableBuiltinDeny: ['127.0.0.0/8'], mcp: { holdMs: 5000, ...mcp } }, resolver, {
    mcpUpstreamCa: MCP_TEST_CERT,
    log: (o) => void logs.push(JSON.stringify(o)),
  });
  await g.tenant('t1');
  const token = await g.session('t1');
  await putConnector({ toolPolicy: extra.policy ?? {}, ...(extra.url ? { url: extra.url } : {}) });
  if (extra.putSecret !== false) await g.admin('PUT', `/secrets/t1/mcp.${CID}`, { value: KEY });
  return token;
}

const connectorBody = (over: Record<string, unknown> = {}) => ({
  tenantId: 't1',
  title: 'GitHub',
  url: `https://mcp.test:${up.port}/mcp/`,
  secretName: `mcp.${CID}`,
  extraHeaders: { 'X-MCP-Readonly': 'true' },
  toolPolicy: {},
  enabled: true,
  ...over,
});
const putConnector = (over: Record<string, unknown> = {}, id = CID) =>
  g.admin('PUT', `/mcp-connectors/${id}`, connectorBody(over));

let nextId = 100;
function post(
  token: string | null,
  body: unknown,
  sid?: string | null,
  extra: Record<string, string> = {},
  id = CID,
  port = g.gate.ports.mcp,
) {
  return fetch(`http://127.0.0.1:${port}/mcp/${id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sid ? { 'mcp-session-id': sid } : {}),
      ...extra,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const rpc = (method: string, params?: unknown, id: number | null = nextId++) => ({
  jsonrpc: '2.0',
  ...(id === null ? {} : { id }),
  method,
  ...(params ? { params } : {}),
});
const callTool = (token: string, sid: string, name: string, args: unknown = {}, id = nextId++) =>
  post(token, rpc('tools/call', { name, arguments: args }, id), sid);

/** initialize + initialized + tools/list: returns the gateway session id */
async function session(token: string, id = CID): Promise<string> {
  const r = await post(
    token,
    rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }),
    null,
    {},
    id,
  );
  expect(r.status).toBe(200);
  const sid = r.headers.get('mcp-session-id')!;
  expect(sid).toMatch(/^mcps_/);
  await r.text();
  expect((await post(token, rpc('notifications/initialized', undefined, null), sid, {}, id)).status).toBe(202);
  const l = await post(token, rpc('tools/list'), sid, {}, id);
  expect(l.status).toBe(200);
  await l.text();
  return sid;
}

const bodyOf = async (r: Response) => parseRpc(r.headers.get('content-type') ?? undefined, await r.text())[0]!;
const textOf = (m: any): string => m?.result?.content?.[0]?.text ?? '';

async function pending(n = 1, timeoutMs = 3000): Promise<any[]> {
  const t0 = Date.now();
  for (;;) {
    const r = await g.admin('GET', '/mcp-approvals?since=0&waitMs=0');
    if (r.json.pending.length >= n) return r.json.pending;
    if (Date.now() - t0 > timeoutMs) throw new Error(`pending: wanted ${n}, have ${r.json.pending.length}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}
const pendingNow = async (): Promise<any[]> => (await g.admin('GET', '/mcp-approvals?since=0&waitMs=0')).json.pending;
const decide = (id: string, decision: string) => g.admin('POST', `/mcp-approvals/${id}/decision`, { decision });
const callRows = () => g.gate.ctx.db.prepare('SELECT * FROM mcp_calls ORDER BY started_at, rowid').all() as any[];
const upCalls = (name: string) => up.calls[name] ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- tests ----------------------------------------------------------------------------------------------------------

describe('mcp proxy: authentication and routing', () => {
  it('rejects missing, invalid, foreign-tenant tokens and disabled connectors without touching the upstream', async () => {
    const t1 = await setup();
    await g.tenant('t2');
    const t2 = await g.session('t2');
    const init = rpc('initialize', {});

    const none = await post(null, init);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBeNull();
    expect(await none.json()).toEqual({ error: 'unauthorized' });
    expect((await post('ngs_garbage', init)).status).toBe(401);
    // a host token is not a session token
    const host = (await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'stt' })).json.token as string;
    expect((await post(host, init)).status).toBe(401);
    // somebody else's connector is indistinguishable from a missing one
    expect((await post(t2, init)).status).toBe(404);
    expect((await post(t1, init, null, {}, 'no-such-connector')).status).toBe(404);
    expect((await post(t1, init, null, {}, 'AB')).status).toBe(404);
    // paused tenant
    await g.admin('POST', '/tenants/t1/pause');
    expect((await post(t1, init)).status).toBe(403);
    await g.admin('POST', '/tenants/t1/resume');
    // disabled
    await putConnector({ enabled: false });
    expect((await post(t1, init)).status).toBe(404);
    // discovery paths
    for (const p of [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp/gh-test1',
      '/mcp',
      '/',
    ]) {
      const r = await fetch(`http://127.0.0.1:${g.gate.ports.mcp}${p}`, { headers: { authorization: `Bearer ${t1}` } });
      expect(r.status).toBe(404);
      expect(r.headers.get('www-authenticate')).toBeNull();
    }
    expect(up.seen.length).toBe(0);
  });

  it('GET is 405 (no standalone stream, not resumable); batches are 400; oversized bodies are 413', async () => {
    const token = await setup({}, { maxBodyBytes: 1024 });
    const get = await fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream', 'last-event-id': '5' },
    });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST, DELETE');
    const sid = await session(token);
    const batch = await post(token, [rpc('tools/list'), rpc('tools/list')], sid);
    expect(batch.status).toBe(400);
    expect(await batch.json()).toEqual({ error: 'batch_unsupported' });
    expect((await post(token, '{not json', sid)).status).toBe(400);
    const big = await post(
      token,
      rpc('tools/call', { name: 'get_thing', arguments: { x: 'a'.repeat(4000) } }),
      sid,
    ).catch(() => null);
    expect(big?.status ?? 413).toBe(413);
    expect(up.seen.filter((s) => s.body?.method === 'tools/call').length).toBe(0);
  });

  it('injects the key, drops the agent credentials and upstream auth/cookie headers', async () => {
    const token = await setup();
    const sid = await session(token);
    const r = await post(token, rpc('tools/call', { name: 'get_thing', arguments: {} }), sid, {
      cookie: 'agent=1',
      'x-forwarded-for': '9.9.9.9',
      'x-api-key': 'leak',
      'mcp-protocol-version': '2025-06-18',
      'last-event-id': '3',
    });
    expect(textOf(await bodyOf(r))).toBe('ok:get_thing');
    const s = up.seen.at(-1)!;
    expect(s.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(s.headers['user-agent']).toBe('nanogate');
    expect(s.headers['x-mcp-readonly']).toBe('true');
    expect(s.headers['mcp-protocol-version']).toBe('2025-06-18');
    expect(s.headers.cookie).toBeUndefined();
    expect(s.headers['x-forwarded-for']).toBeUndefined();
    expect(s.headers['x-api-key']).toBeUndefined();
    expect(s.headers['last-event-id']).toBeUndefined();
    expect(JSON.stringify(s.headers)).not.toContain(token);
    expect(r.headers.get('www-authenticate')).toBeNull();
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(r.headers.get('x-upstream-private')).toBeNull();
    expect(r.headers.get('mcp-protocol-version')).toBe('2025-06-18');
  });
});

describe('mcp proxy: gateway-issued sessions', () => {
  it('stateful upstream: gateway id differs from the upstream id, which the upstream sees; foreign and restarted sessions are 404', async () => {
    const token = await setup();
    await g.tenant('t2');
    const t2 = await g.session('t2');
    await g.admin('PUT', '/mcp-connectors/gh-test2', connectorBody({ tenantId: 't2', secretName: 'mcp.gh-test2' }));
    await g.admin('PUT', '/secrets/t2/mcp.gh-test2', { value: KEY });
    const sid = await session(token);
    expect(sid).not.toBe('up-sid-1');
    expect(up.seen.find((s) => s.body?.method === 'tools/list')!.headers['mcp-session-id']).toBe('up-sid-1');
    expect(up.seen[0]!.headers['mcp-session-id']).toBeUndefined();
    expect(JSON.stringify(up.seen.map((s) => s.headers))).not.toContain(sid);

    // t2 presents t1's session id on its own connector, and t1 on a connector with a session of its own kind
    expect((await post(t2, rpc('tools/list'), sid, {}, 'gh-test2')).status).toBe(404);
    expect((await post(token, rpc('tools/list'))).status).toBe(404); // no id at all
    expect((await post(token, rpc('tools/list'), 'mcps_made-up')).status).toBe(404);
    // after a gateway "restart" every id is gone and the client must initialize again
    g.gate.ctx.mcpSessions.clear();
    expect((await post(token, rpc('tools/list'), sid)).status).toBe(404);
    const sid2 = await session(token);
    expect((await post(token, rpc('tools/list'), sid2)).status).toBe(200);
    // DELETE reaches the upstream with the upstream id and forgets the session
    const del = await fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid2 },
    });
    expect(del.status).toBe(204);
    const d = up.seen.filter((s) => s.method === 'DELETE').at(-1)!;
    expect(d.headers['mcp-session-id']).toBe('up-sid-1');
    expect(d.headers.authorization).toBe(`Bearer ${KEY}`);
    expect((await post(token, rpc('tools/list'), sid2)).status).toBe(404);
  });

  it('stateless upstream (no session id) is supported', async () => {
    const token = await setup({ stateful: false });
    const sid = await session(token);
    expect(sid).toMatch(/^mcps_/);
    for (const s of up.seen) expect(s.headers['mcp-session-id']).toBeUndefined();
    const r = await callTool(token, sid, 'get_thing');
    expect(textOf(await bodyOf(r))).toBe('ok:get_thing');
    expect(up.seen.at(-1)!.headers['mcp-session-id']).toBeUndefined();
    const del = await fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid },
    });
    expect(del.status).toBe(204);
    expect(up.seen.filter((s) => s.method === 'DELETE').length).toBe(0);
  });

  it('a connector change that invalidates sessions (url) or a secret delete drops them', async () => {
    const token = await setup();
    const sid = await session(token);
    await putConnector({ title: 'Renamed' });
    expect((await post(token, rpc('tools/list'), sid)).status).toBe(200);
    await g.admin('DELETE', `/secrets/t1/mcp.${CID}`);
    expect((await post(token, rpc('tools/list'), sid)).status).toBe(404);
    await g.admin('PUT', `/secrets/t1/mcp.${CID}`, { value: KEY });
    const sid2 = await session(token);
    await putConnector({ url: `https://mcp2.test:${up.port}/mcp/` });
    expect((await post(token, rpc('tools/list'), sid2)).status).toBe(404);
  });
});

describe('mcp proxy: streaming and tool inventory', () => {
  it('streams SSE: the first event arrives before the upstream finishes', async () => {
    const token = await setup();
    const sid = await session(token);
    const first = await new Promise<{ firstAt: number; endedFlagAtFirst: boolean; all: string }>((resolve, reject) => {
      const body = JSON.stringify(rpc('tools/call', { name: 'stream_thing', arguments: {} }));
      const req = http.request(
        {
          host: '127.0.0.1',
          port: g.gate.ports.mcp,
          path: `/mcp/${CID}`,
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-session-id': sid,
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          expect(res.headers['content-type']).toContain('text/event-stream');
          let got = '';
          let firstAt = 0;
          let flag = true;
          res.on('data', (c) => {
            if (!firstAt) {
              firstAt = Date.now();
              flag = up.state.streamEnded;
            }
            got += c;
          });
          res.on('end', () => resolve({ firstAt, endedFlagAtFirst: flag, all: got }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    expect(first.endedFlagAtFirst).toBe(false);
    expect(first.all).toContain('notifications/progress');
    expect(first.all).toContain('streamed');
  });

  for (const sse of [false, true]) {
    it(`tools/list (${sse ? 'SSE' : 'JSON'}) fills mcp_tools; read_only only for readOnlyHint === true`, async () => {
      const token = await setup({ listSse: sse });
      await session(token);
      const rows = Object.fromEntries(
        (g.gate.ctx.db.prepare('SELECT name, read_only, title FROM mcp_tools').all() as any[]).map((r) => [r.name, r]),
      );
      expect(Object.keys(rows).sort()).toEqual(TOOLS.map((t) => t.name).sort());
      expect(rows.get_thing).toMatchObject({ read_only: 1, title: 'Get thing' });
      for (const n of ['create_thing', 'delete_thing', 'odd_thing']) expect(rows[n].read_only).toBe(0);
      const view = (await g.admin('GET', '/mcp-connectors?tenantId=t1')).json.connectors[0];
      expect(view).toMatchObject({ id: CID, tenantId: 't1', enabled: true });
      expect(view.tools.find((t: any) => t.name === 'get_thing')).toEqual({
        name: 'get_thing',
        readOnly: true,
        title: 'Get thing',
      });
      expect(typeof view.toolsSeenAt).toBe('number');
    });
  }
});

describe('mcp proxy: calls without approval', () => {
  it('a read-only tool passes at once and is logged as auto/ok; a tool error is tool_error', async () => {
    const token = await setup();
    const sid = await session(token);
    expect(textOf(await bodyOf(await callTool(token, sid, 'get_thing', { a: 1 })))).toBe('ok:get_thing');
    const e = await bodyOf(await callTool(token, sid, 'err_thing'));
    expect(e.result.isError).toBe(true);
    expect(await pendingNow()).toEqual([]);
    const rows = callRows();
    expect(rows.map((r) => [r.tool, r.dangerous, r.decision, r.status])).toEqual([
      ['get_thing', 0, 'auto', 'ok'],
      ['err_thing', 0, 'auto', 'tool_error'],
    ]);
    expect(rows[0]!.http_status).toBe(200);
    expect(rows[0]!.finished_at).toBeGreaterThan(0);
    const log = logs.map((l) => JSON.parse(l)).find((l) => l.msg === 'mcp_call')!;
    expect(log).toMatchObject({ tenant: 't1', connector: CID, tool: 'get_thing', decision: 'auto', status: 'ok' });
    // calls API
    const api = (await g.admin('GET', `/mcp-calls?tenantId=t1&connectorId=${CID}&limit=1`)).json.calls;
    expect(api).toHaveLength(1);
    expect(api[0]).toMatchObject({
      connectorId: CID,
      tool: 'err_thing',
      decision: 'auto',
      status: 'tool_error',
      dangerous: false,
    });
    expect((await g.admin('GET', '/mcp-calls')).status).toBe(400);
  });

  it('a policy override turns a read-only tool into ask and a write tool into auto', async () => {
    const token = await setup({}, {}, { policy: { get_thing: 'ask', create_thing: 'auto' } });
    const sid = await session(token);
    expect(textOf(await bodyOf(await callTool(token, sid, 'create_thing')))).toBe('ok:create_thing');
    const held = callTool(token, sid, 'get_thing');
    const [p] = await pending();
    expect(p.tool).toBe('get_thing');
    await decide(p.id, 'deny');
    expect((await bodyOf(await held)).result.isError).toBe(true);
  });

  it('missing key: tools/call is an isError result, other methods are 503', async () => {
    const token = await setup({}, {}, { putSecret: false });
    expect((await post(token, rpc('initialize', {}))).status).toBe(503);
    g.gate.ctx.mcpSessions.set('mcps_x', {
      tokenHash: (await import('../src/tokens.js')).hashToken(token),
      connectorId: CID,
      upstreamSid: null,
      lastUsed: Date.now(),
    });
    const r = await bodyOf(await callTool(token, 'mcps_x', 'create_thing'));
    expect(r.result.isError).toBe(true);
    expect(textOf(r)).toContain('Ключ не задан');
    expect(up.seen.length).toBe(0);
  });

  it('an upstream 401/403 on tools/call becomes an isError result without its body, and raises mcp_key_rejected', async () => {
    const token = await setup();
    const sid = await session(token);
    up.state.refuseAll = true;
    const r = await callTool(token, sid, 'get_thing');
    expect(r.status).toBe(200);
    const m = (await r.json()) as any;
    expect(m.result.isError).toBe(true);
    expect(textOf(m)).toContain('не принял ключ');
    expect(JSON.stringify(m)).not.toContain('bad credentials');
    expect(r.headers.get('www-authenticate')).toBeNull();
    const ev = (await g.admin('GET', '/events')).json.events.find((e: any) => e.type === 'mcp_key_rejected');
    expect(ev).toMatchObject({ tenantId: 't1', payload: { connectorId: CID } });
    // other methods: 502, never the upstream's 401 (the client would start OAuth discovery)
    expect((await post(token, rpc('tools/list'), sid)).status).toBe(502);
  });
});

describe('mcp proxy: held approvals', () => {
  const dangerous = (token: string, sid: string, args: unknown = { title: 'hello', token: 'tok-should-be-masked' }) =>
    callTool(token, sid, 'create_thing', args);

  it('approve sends exactly one upstream call; the card carries masked arguments; a second decision is not accepted', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    const [p] = await pending();
    expect(p).toMatchObject({ tenantId: 't1', connectorId: CID, connectorTitle: 'GitHub', tool: 'create_thing' });
    expect(p.id).toMatch(/^mc_[0-9a-f]{24}$/);
    expect(p.sessionKey).toBe('s-t1');
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(5000);
    expect(p.args).toEqual([
      { label: 'title', type: 'text', value: 'hello' },
      { label: 'token', type: 'text', value: '•••' },
    ]);
    expect(JSON.stringify(p)).not.toContain('tok-should-be-masked');
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)).toMatchObject({ id: p.id, decision: 'pending', dangerous: 1, finished_at: null });

    expect((await decide(p.id, 'approve')).json).toEqual({ accepted: true });
    expect(textOf(await bodyOf(await held))).toBe('ok:create_thing');
    expect(upCalls('create_thing')).toBe(1);
    expect((await decide(p.id, 'approve')).json).toEqual({ accepted: false });
    expect(upCalls('create_thing')).toBe(1);
    expect(callRows().at(-1)).toMatchObject({ id: p.id, decision: 'approved', status: 'ok' });
    expect(await pendingNow()).toEqual([]);
  });

  it('long-poll returns at once for a newer version and waits otherwise', async () => {
    const token = await setup();
    const sid = await session(token);
    const v0 = (await g.admin('GET', '/mcp-approvals?since=0&waitMs=0')).json.version as number;
    const t0 = Date.now();
    const empty = await g.admin('GET', `/mcp-approvals?since=${v0}&waitMs=150`);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(130);
    expect(empty.json).toEqual({ version: v0, pending: [] });
    const waiting = g.admin('GET', `/mcp-approvals?since=${v0}&waitMs=5000`);
    const held = dangerous(token, sid);
    const r = await waiting;
    expect(r.json.version).toBeGreaterThan(v0);
    expect(r.json.pending).toHaveLength(1);
    await decide(r.json.pending[0].id, 'deny');
    await held;
  });

  it('the held request survives its body being fully read (the response, not the request, decides)', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    const [p] = await pending();
    await sleep(300);
    expect((await pendingNow()).map((x) => x.id)).toEqual([p.id]);
    await decide(p.id, 'approve');
    expect(textOf(await bodyOf(await held))).toBe('ok:create_thing');
    expect(callRows().at(-1)!.decision).toBe('approved');
  });

  it('deny: isError, nothing sent upstream', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    const [p] = await pending();
    await decide(p.id, 'deny');
    const m = await bodyOf(await held);
    expect(m.result.isError).toBe(true);
    expect(textOf(m)).toContain('отклонил');
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)).toMatchObject({ decision: 'denied', status: null });
  });

  it('unavailable: isError, nothing sent upstream', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    const [p] = await pending();
    await decide(p.id, 'unavailable');
    expect(textOf(await bodyOf(await held))).toContain('недоступно');
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('unavailable');
  });

  it('times out after holdMs: expired, card removed, a late decision is not accepted', async () => {
    const token = await setup({}, { holdMs: 200 });
    const sid = await session(token);
    const held = dangerous(token, sid);
    const [p] = await pending();
    const m = await bodyOf(await held);
    expect(textOf(m)).toContain('Нет подтверждения');
    expect(await pendingNow()).toEqual([]);
    expect((await decide(p.id, 'approve')).json).toEqual({ accepted: false });
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('expired');
  });

  it('the client going away drops the card and sends nothing (fetch abort)', async () => {
    const token = await setup();
    const sid = await session(token);
    const ac = new AbortController();
    const held = fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sid,
      },
      body: JSON.stringify(rpc('tools/call', { name: 'create_thing', arguments: {} })),
    }).catch(() => null);
    const [p] = await pending();
    ac.abort();
    await held;
    for (let i = 0; i < 100 && (await pendingNow()).length; i++) await sleep(20);
    expect(await pendingNow()).toEqual([]);
    expect((await decide(p.id, 'approve')).json).toEqual({ accepted: false });
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('disconnected');
  });

  it('a half-closed client socket (FIN after the full request) also counts as gone', async () => {
    const token = await setup();
    const sid = await session(token);
    const body = JSON.stringify(rpc('tools/call', { name: 'create_thing', arguments: {} }));
    const sock = net.connect(g.gate.ports.mcp, '127.0.0.1');
    sock.on('error', () => undefined);
    sock.write(
      `POST /mcp/${CID} HTTP/1.1\r\nHost: x\r\nauthorization: Bearer ${token}\r\nmcp-session-id: ${sid}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
    await pending();
    sock.end();
    for (let i = 0; i < 100 && (await pendingNow()).length; i++) await sleep(20);
    expect(await pendingNow()).toEqual([]);
    expect(upCalls('create_thing')).toBe(0);
    sock.destroy();
  });

  it('notifications/cancelled lifts the hold and removes the card; the upstream is not called', async () => {
    const token = await setup();
    const sid = await session(token);
    const id = nextId++;
    const held = callTool(token, sid, 'create_thing', {}, id);
    await pending();
    const c = await post(token, rpc('notifications/cancelled', { requestId: id, reason: 'user' }, null), sid);
    expect(c.status).toBe(202);
    const m = await bodyOf(await held);
    expect(m.result.isError).toBe(true);
    expect(await pendingNow()).toEqual([]);
    expect(upCalls('create_thing')).toBe(0);
    expect(up.seen.some((s) => s.body?.method === 'notifications/cancelled')).toBe(false);
    expect(callRows().at(-1)!.decision).toBe('disconnected');
    // a cancel for something that is not held goes to the upstream
    await post(token, rpc('notifications/cancelled', { requestId: 99999 }, null), sid);
    expect(up.seen.at(-1)!.body.method).toBe('notifications/cancelled');
  });

  it('session release revokes the held call', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    await pending();
    await g.admin('POST', '/sessions/release', { sessionKey: 's-t1', kind: 'session-ended' });
    const m = await held.then(bodyOf, () => null);
    if (m) expect(m.result.isError).toBe(true);
    expect(await pendingNow()).toEqual([]);
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('revoked');
  });

  it('tenant revoke revokes the held call', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    await pending();
    await g.admin('POST', '/tenants/t1/revoke');
    await held.then(bodyOf, () => null);
    expect(await pendingNow()).toEqual([]);
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('revoked');
  });

  it('disabling the connector rejects the held call as disabled', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    await pending();
    await putConnector({ enabled: false });
    const m = await bodyOf(await held);
    expect(m.result.isError).toBe(true);
    expect(await pendingNow()).toEqual([]);
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('disabled');
  });

  it('deleting the connector rejects the held call', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = dangerous(token, sid);
    await pending();
    expect((await g.admin('DELETE', `/mcp-connectors/${CID}`)).status).toBe(204);
    expect((await bodyOf(await held)).result.isError).toBe(true);
    expect(upCalls('create_thing')).toBe(0);
    expect(callRows().at(-1)!.decision).toBe('disabled');
  });

  for (const [what, change] of [
    ['the key is replaced', async () => void (await g.admin('PUT', `/secrets/t1/mcp.${CID}`, { value: NEWKEY }))],
    ['the tool policy changes', async () => void (await putConnector({ toolPolicy: { get_thing: 'ask' } }))],
    ['the read-only header changes', async () => void (await putConnector({ extraHeaders: {} }))],
    [
      'the url changes within the same host',
      async () => void (await putConnector({ url: `https://mcp.test:${up.port}/other/` })),
    ],
  ] as const) {
    it(`rev binding: if ${what} while the call waits, an approval does not send it`, async () => {
      const token = await setup();
      const sid = await session(token);
      const held = dangerous(token, sid);
      const [p] = await pending();
      await change();
      // (a url change also drops the gateway session and rejects the pending call; both end without an upstream call)
      await decide(p.id, 'approve');
      const m = await bodyOf(await held);
      expect(m.result.isError).toBe(true);
      expect(upCalls('create_thing')).toBe(0);
      expect(['revoked', 'disabled']).toContain(callRows().at(-1)!.decision);
    });
  }

  it('rev only grows on a real change', async () => {
    await setup();
    const rev = () =>
      (g.gate.ctx.db.prepare('SELECT rev FROM mcp_connectors WHERE id=?').get(CID) as any).rev as number;
    const r0 = rev();
    await putConnector();
    expect(rev()).toBe(r0);
    await putConnector({ title: 'Other title', enabled: false });
    expect(rev()).toBe(r0);
    await putConnector({ toolPolicy: { a: 'ask' } });
    expect(rev()).toBe(r0 + 1);
    await g.admin('PUT', `/secrets/t1/mcp.${CID}`, { value: NEWKEY });
    expect(rev()).toBe(r0 + 2);
    await g.admin('PUT', '/secrets/t1/other', { value: 'x' });
    expect(rev()).toBe(r0 + 2);
  });

  it('limits: per tenant and in total', async () => {
    const token = await setup({}, { maxPendingPerTenant: 1, maxPendingTotal: 2 });
    const sid = await session(token);
    const first = dangerous(token, sid);
    await pending();
    const second = await bodyOf(await dangerous(token, sid));
    expect(second.result.isError).toBe(true);
    expect(textOf(second)).toContain('Слишком много');
    expect(upCalls('create_thing')).toBe(0);

    await g.tenant('t2');
    const t2 = await g.session('t2');
    await g.admin('PUT', '/mcp-connectors/gh-test2', connectorBody({ tenantId: 't2', secretName: 'mcp.gh-test2' }));
    await g.admin('PUT', '/secrets/t2/mcp.gh-test2', { value: KEY });
    await g.tenant('t3');
    const t3 = await g.session('t3');
    await g.admin('PUT', '/mcp-connectors/gh-test3', connectorBody({ tenantId: 't3', secretName: 'mcp.gh-test3' }));
    await g.admin('PUT', '/secrets/t3/mcp.gh-test3', { value: KEY });
    const sid2 = await session(t2, 'gh-test2');
    const sid3 = await session(t3, 'gh-test3');
    const other = post(t2, rpc('tools/call', { name: 'create_thing', arguments: {} }), sid2, {}, 'gh-test2');
    // the t2 call is the second pending one; the total (2) is now full for t3
    await pending(2);
    const blocked = await post(t3, rpc('tools/call', { name: 'create_thing', arguments: {} }), sid3, {}, 'gh-test3');
    expect(textOf(await bodyOf(blocked))).toContain('Слишком много');
    for (const p of await pendingNow()) await decide(p.id, 'deny');
    await first;
    await other;
  });
});

describe('mcp proxy: upstream hygiene', () => {
  it('redirects are not followed', async () => {
    const token = await setup({ redirect: true });
    const sid = 'mcps_fixed';
    g.gate.ctx.mcpSessions.set(sid, {
      tokenHash: (await import('../src/tokens.js')).hashToken(token),
      connectorId: CID,
      upstreamSid: null,
      lastUsed: Date.now(),
    });
    g.gate.ctx.db.prepare("INSERT INTO mcp_tools VALUES (?, 'get_thing', 1, NULL, 0)").run(CID);
    const r = await post(token, rpc('tools/list'), sid);
    expect(r.status).toBe(502);
    expect(up.seen.length).toBe(1); // only the original request; the Location was not visited
    const c = await bodyOf(await callTool(token, sid, 'get_thing'));
    expect(c.result.isError).toBe(true);
  });

  it('an address in the deny set is refused before any connection, so no key is sent', async () => {
    // no disableBuiltinDeny for 10/8: deny.test resolves to 10.0.0.1
    const token = await setup({}, {}, { url: 'https://deny.test:9/mcp/' });
    const t0 = Date.now();
    const r = await post(token, rpc('initialize', {}));
    expect(r.status).toBe(502);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(up.seen.length).toBe(0);
    const probe = await g.admin('POST', `/mcp-connectors/${CID}/probe`);
    expect(probe.json).toEqual({ ok: false, error: 'upstream_unreachable' });
  });

  it('plain http connector urls are rejected when stored', async () => {
    await setup();
    const r = await putConnector({ url: `http://mcp.test:${up.port}/mcp/` });
    expect(r.status).toBe(400);
  });

  it('absolute deadline: a response body that outlasts upstreamTimeoutMs is cut, and the upstream is aborted', async () => {
    const token = await setup({}, { upstreamTimeoutMs: 400 });
    const sid = await session(token);
    const t0 = Date.now();
    const outcome = await callTool(token, sid, 'endless_thing').then(
      (r) =>
        r.text().then(
          () => 'ended',
          () => 'cut',
        ),
      () => 'cut',
    );
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(outcome).toBe('cut');
    for (let i = 0; i < 50 && !up.state.upstreamClosedEndless; i++) await sleep(20);
    expect(up.state.upstreamClosedEndless).toBe(true);
    expect(callRows().at(-1)!.status).toBe('unknown');
  });

  it('absolute deadline: after the request was sent a stall is "result unknown", not a retry', async () => {
    const token = await setup({}, { upstreamTimeoutMs: 300 });
    const sid = await session(token);
    const m = await bodyOf(await callTool(token, sid, 'slow_thing'));
    expect(m.result.isError).toBe(true);
    expect(textOf(m)).toContain('Результат неизвестен');
    expect(callRows().at(-1)!.status).toBe('unknown');
    expect(upCalls('slow_thing')).toBe(1);
  });

  it('an agent that disconnects mid-call aborts the upstream request', async () => {
    const token = await setup();
    const sid = await session(token);
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
      method: 'POST',
      signal: ac.signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-session-id': sid },
      body: JSON.stringify(rpc('tools/call', { name: 'endless_thing', arguments: {} })),
    });
    const r = await p;
    await r.body!.getReader().read();
    ac.abort();
    for (let i = 0; i < 100 && !up.state.upstreamClosedEndless; i++) await sleep(20);
    expect(up.state.upstreamClosedEndless).toBe(true);
  });
});

describe('mcp probe', () => {
  it('ok fills the inventory; the stored key is used', async () => {
    await setup();
    const r = await g.admin('POST', `/mcp-connectors/${CID}/probe`);
    expect(r.json).toEqual({ ok: true, tools: TOOLS.length });
    expect(up.seen.map((s) => s.body?.method ?? s.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
      'DELETE',
    ]);
    expect(up.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(up.seen[1]!.headers['mcp-session-id']).toBe('up-sid-1');
    expect((g.gate.ctx.db.prepare('SELECT COUNT(*) AS n FROM mcp_tools').get() as any).n).toBe(TOOLS.length);
  });

  it('replaces the inventory (tools the upstream dropped disappear)', async () => {
    await setup();
    g.gate.ctx.db.prepare("INSERT INTO mcp_tools VALUES (?, 'ghost', 1, NULL, 0)").run(CID);
    await g.admin('POST', `/mcp-connectors/${CID}/probe`);
    expect(g.gate.ctx.db.prepare("SELECT 1 FROM mcp_tools WHERE name='ghost'").get()).toBeUndefined();
  });

  it('key_rejected on 401, no_key without a key, upstream_unreachable when nothing listens', async () => {
    await setup({}, {}, { putSecret: false });
    expect((await g.admin('POST', `/mcp-connectors/${CID}/probe`)).json).toEqual({ ok: false, error: 'no_key' });
    await g.admin('PUT', `/secrets/t1/mcp.${CID}`, { value: 'ghp_WRONG' });
    expect((await g.admin('POST', `/mcp-connectors/${CID}/probe`)).json).toEqual({
      ok: false,
      error: 'key_rejected',
      status: 401,
    });
    await putConnector({ url: 'https://mcp.test:1/mcp/' });
    expect((await g.admin('POST', `/mcp-connectors/${CID}/probe`)).json).toEqual({
      ok: false,
      error: 'upstream_unreachable',
    });
    expect((await g.admin('POST', '/mcp-connectors/nope-nope/probe')).status).toBe(404);
  });

  it('a candidate key is vetted in memory: nothing is stored, a good one does not replace the old one', async () => {
    await setup();
    const enc = () =>
      (g.gate.ctx.db.prepare('SELECT enc FROM secrets WHERE name=?').get(`mcp.${CID}`) as any).enc as string;
    const before = enc();
    const bad = await g.admin('POST', `/mcp-connectors/${CID}/probe`, { candidateKey: 'ghp_WRONGWRONG' });
    expect(bad.json).toEqual({ ok: false, error: 'key_rejected', status: 401 });
    expect(enc()).toBe(before);
    up.seen.length = 0;
    const good = await g.admin('POST', `/mcp-connectors/${CID}/probe`, { candidateKey: NEWKEY });
    expect(good.json).toEqual({ ok: true, tools: TOOLS.length });
    expect(up.seen[0]!.headers.authorization).toBe(`Bearer ${NEWKEY}`);
    expect(enc()).toBe(before);
    expect((await g.admin('POST', `/mcp-connectors/${CID}/probe`, { candidateKey: 'has space' })).status).toBe(400);
    expect((await g.admin('POST', `/mcp-connectors/${CID}/probe`, { candidateKey: 7 })).status).toBe(400);
  });

  it('works for a disabled connector (the key is verified before it is switched on)', async () => {
    await setup();
    await putConnector({ enabled: false });
    expect((await g.admin('POST', `/mcp-connectors/${CID}/probe`)).json).toMatchObject({ ok: true });
  });
});

describe('mcp admin: inventory sync', () => {
  it('DELETE removes the connector, its tools and its key, and is idempotent', async () => {
    const token = await setup();
    await session(token);
    expect((await g.admin('DELETE', `/mcp-connectors/${CID}`)).status).toBe(204);
    expect((await g.admin('DELETE', `/mcp-connectors/${CID}`)).status).toBe(204);
    expect((await g.admin('GET', '/secrets/t1')).json.secrets).toEqual([]);
    expect((g.gate.ctx.db.prepare('SELECT COUNT(*) AS n FROM mcp_tools').get() as any).n).toBe(0);
    expect((await post(token, rpc('initialize', {}))).status).toBe(404);
  });
});

describe('mcp: secrets never leak', () => {
  it('neither the key nor a candidate appears in logs, mcp_calls, events or admin responses', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = callTool(token, sid, 'create_thing', {
      api_key: 'argument-secret-value',
      nested: { password: 'p4ss', ok: 'visible' },
    });
    const [p] = await pending();
    expect(JSON.stringify(p)).not.toContain('argument-secret-value');
    expect(JSON.stringify(p)).not.toContain('p4ss');
    expect(JSON.stringify(p)).toContain('visible');
    await decide(p.id, 'approve');
    await held;
    up.state.refuseAll = true;
    await callTool(token, sid, 'get_thing');
    up.state.refuseAll = false;
    const responses = [
      await g.admin('GET', '/mcp-connectors'),
      await g.admin('GET', '/mcp-calls?tenantId=t1'),
      await g.admin('GET', '/mcp-approvals?since=0&waitMs=0'),
      await g.admin('GET', '/events'),
      await g.admin('GET', '/secrets/t1'),
      await g.admin('POST', `/mcp-connectors/${CID}/probe`, { candidateKey: NEWKEY }),
      await g.admin('POST', `/mcp-connectors/${CID}/probe`, { candidateKey: 'ghp_BADCANDIDATE' }),
    ].map((r) => r.raw);
    const dump = [
      ...logs,
      ...responses,
      JSON.stringify(callRows()),
      JSON.stringify(g.gate.ctx.db.prepare('SELECT * FROM events').all()),
      JSON.stringify(g.gate.ctx.db.prepare('SELECT * FROM mcp_connectors').all()),
    ].join('\n');
    for (const secret of [KEY, NEWKEY, 'ghp_BADCANDIDATE', 'argument-secret-value']) expect(dump).not.toContain(secret);
    expect(callRows().map((r) => Object.keys(r))).not.toContain('args');
  });
});

describe('mcp admin: calls and approvals api validation', () => {
  it('limits and ids are validated', async () => {
    await setup();
    expect((await g.admin('GET', '/mcp-calls?tenantId=t1&limit=0')).status).toBe(400);
    expect((await g.admin('GET', '/mcp-calls?tenantId=t1&limit=x')).status).toBe(400);
    for (let i = 0; i < 3; i++) {
      g.gate.ctx.db
        .prepare("INSERT INTO mcp_calls VALUES (?, 't1', ?, 's', 'x', 0, 'auto', 'ok', 200, ?, ?)")
        .run(`mc_${String(i).padStart(24, '0')}`, CID, 1000 + i, 1001 + i);
    }
    const r = (await g.admin('GET', '/mcp-calls?tenantId=t1&limit=1000')).json.calls;
    expect(r.map((c: any) => c.startedAt)).toEqual([1002, 1001, 1000]);
    expect((await g.admin('POST', '/mcp-approvals/not-an-id/decision', { decision: 'approve' })).status).toBe(400);
    expect((await g.admin('POST', `/mcp-approvals/mc_${'0'.repeat(24)}/decision`, { decision: 'maybe' })).status).toBe(
      400,
    );
    expect(
      (await g.admin('POST', `/mcp-approvals/mc_${'0'.repeat(24)}/decision`, { decision: 'approve' })).json,
    ).toEqual({ accepted: false });
  });

  it('prunes old calls and closes rows a previous process left open', async () => {
    await setup();
    const { pruneMcpCalls, reapMcpCalls } = await import('../src/db.js');
    const db = g.gate.ctx.db;
    db.prepare("INSERT INTO mcp_calls VALUES ('mc_old', 't1', ?, 's', 'x', 0, 'auto', 'ok', 200, ?, ?)").run(
      CID,
      Date.now() - 40 * 86_400_000,
      Date.now(),
    );
    db.prepare("INSERT INTO mcp_calls VALUES ('mc_pend', 't1', ?, 's', 'x', 1, 'pending', NULL, NULL, ?, NULL)").run(
      CID,
      Date.now(),
    );
    db.prepare("INSERT INTO mcp_calls VALUES ('mc_run', 't1', ?, 's', 'x', 0, 'auto', NULL, NULL, ?, NULL)").run(
      CID,
      Date.now(),
    );
    expect(pruneMcpCalls(db, Date.now(), 30)).toBe(1);
    expect(reapMcpCalls(db)).toBe(2);
    expect(db.prepare("SELECT decision, status FROM mcp_calls WHERE id='mc_pend'").get()).toEqual({
      decision: 'unavailable',
      status: null,
    });
    expect(db.prepare("SELECT decision, status FROM mcp_calls WHERE id='mc_run'").get()).toEqual({
      decision: 'auto',
      status: 'unknown',
    });
  });
});

describe('mcp proxy: review fixes', () => {
  it('a message whose keys differ only by case is refused before anything reaches the upstream', async () => {
    const token = await setup();
    const sid = await session(token);
    const before = up.seen.length;
    const method = await post(
      token,
      { jsonrpc: '2.0', id: 900, method: 'tools/list', Method: 'tools/call', params: { name: 'create_thing' } },
      sid,
    );
    expect(method.status).toBe(400);
    const name = await post(
      token,
      { jsonrpc: '2.0', id: 901, method: 'tools/call', params: { name: 'get_thing', Name: 'create_thing' } },
      sid,
    );
    expect(name.status).toBe(400);
    const args = await post(
      token,
      { jsonrpc: '2.0', id: 902, method: 'tools/call', params: { name: 'get_thing', Arguments: { x: 1 } } },
      sid,
    );
    expect(args.status).toBe(400);
    expect(up.seen.length).toBe(before);
  });

  it('what goes upstream is the canonical JSON, one value per key', async () => {
    const token = await setup();
    const sid = await session(token);
    const raw =
      '{"jsonrpc":"2.0","id":903,"method":"tools/call","params":{"name":"get_thing","name":"get_thing","arguments":{"a":1}}}';
    expect(textOf(await bodyOf(await post(token, raw, sid)))).toBe('ok:get_thing');
    expect(up.seen.at(-1)!.body).toEqual({
      jsonrpc: '2.0',
      id: 903,
      method: 'tools/call',
      params: { name: 'get_thing', arguments: { a: 1 } },
    });
  });

  it('a complete tools/list replaces the cache: a tool that left the inventory is no longer read-only', async () => {
    const token = await setup();
    const sid = await session(token);
    expect(textOf(await bodyOf(await callTool(token, sid, 'get_thing')))).toBe('ok:get_thing');
    up.state.tools = TOOLS.filter((t) => t.name !== 'get_thing');
    await (await post(token, rpc('tools/list'), sid)).text();
    const held = callTool(token, sid, 'get_thing');
    const [p] = await pending();
    expect(p.tool).toBe('get_thing');
    await decide(p.id, 'deny');
    await held;
  });

  it('terminating the MCP session settles its held approval', async () => {
    const token = await setup();
    const sid = await session(token);
    const held = callTool(token, sid, 'create_thing');
    await pending();
    const del = await fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sid },
    });
    expect(del.status).toBe(204);
    expect((await bodyOf(await held)).result.isError).toBe(true);
    expect(await pendingNow()).toEqual([]);
    expect(upCalls('create_thing')).toBe(0);
  });
});
