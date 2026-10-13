/**
 * Stage 1 end-to-end: the host's admin client and approval subscription against a REAL nanogate
 * (nanogate/test/harness.ts) in front of a fake HTTPS MCP upstream. The agent side is a plain
 * fetch with the session token, as the runner does.
 */
import https from 'node:https';
import type net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { INSTALL_SLUG } from '../../config.js';
import { MCP_TEST_CERT, MCP_TEST_KEY } from '../../../nanogate/test/fixtures/mcp-cert.js';
import { type Gate, makeGate } from '../../../nanogate/test/harness.js';
import type { GatewayApprovalDecision, GatewayApprovalRequest } from '../gateway-provider-registry.js';
import { createNanogateAdmin, mcpApprovalTuning, nanogateProvider, setNanogateAdminForTests } from './index.js';

const KEY = 'ghp_E2E_SECRET_KEY_0123456789';
const CID = 'gh-e2e1';
const TOOLS = [
  { name: 'get_thing', annotations: { readOnlyHint: true } },
  { name: 'create_thing', annotations: { readOnlyHint: false } },
];

async function fakeMcp() {
  const seen: Array<{ headers: Record<string, unknown>; body: any }> = [];
  const calls: Record<string, number> = {};
  const server = https.createServer({ key: MCP_TEST_KEY, cert: MCP_TEST_CERT }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ headers: req.headers, body });
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return void res.end('{}');
      }
      const reply = (result: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(200, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      switch (body?.method) {
        case 'initialize':
          return reply({
            protocolVersion: '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'f', version: '1' },
          });
        case 'tools/list':
          return reply({ tools: TOOLS });
        case 'tools/call':
          calls[body.params.name] = (calls[body.params.name] ?? 0) + 1;
          return reply({ content: [{ type: 'text', text: `ok:${body.params.name}` }] });
        default:
          res.writeHead(202);
          return void res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    seen,
    calls,
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let g: Gate;
let up: Awaited<ReturnType<typeof fakeMcp>>;
let ac: AbortController;
let sub: Promise<void>;
let token: string;
let requests: GatewayApprovalRequest[];
let nextDecision: GatewayApprovalDecision;
let resolvedIds: string[];

beforeEach(async () => {
  up = await fakeMcp();
  g = await makeGate(
    { disableBuiltinDeny: ['127.0.0.0/8'], mcp: { holdMs: 5000 } },
    async (host: string) => (host === 'mcp.test' ? [{ address: '127.0.0.1', family: 4 }] : []),
    { mcpUpstreamCa: MCP_TEST_CERT },
  );
  const admin = createNanogateAdmin({ socketPath: g.gate.adminSocket });
  setNanogateAdminForTests(admin);
  await g.tenant('t1');
  const sessionKey = `${INSTALL_SLUG}/ag1/sess1`;
  token = (await admin.ensureSession({ tenantId: 't1', sessionKey, runtimeIdentity: 'rt', disposition: 'create' }))
    .token;
  await admin.putMcpConnector(CID, {
    tenantId: 't1',
    title: 'GitHub',
    url: `https://mcp.test:${up.port}/mcp/`,
    secretName: `mcp.${CID}`,
    extraHeaders: {},
    toolPolicy: {},
    enabled: true,
  });
  await admin.putSecret('t1', `mcp.${CID}`, KEY);
  expect(await admin.probeMcpConnector(CID)).toEqual({ ok: true, tools: 2 });

  requests = [];
  resolvedIds = [];
  nextDecision = 'approve';
  mcpApprovalTuning.waitMs = 500;
  mcpApprovalTuning.retryMs = 50;
  ac = new AbortController();
  sub = nanogateProvider.approvals.subscribe(
    async (req) => {
      requests.push(req);
      return nextDecision;
    },
    ac.signal,
    async (id) => void resolvedIds.push(id),
  );
});

afterEach(async () => {
  ac.abort();
  await sub;
  setNanogateAdminForTests(null);
  await g.close();
  await up.close();
  mcpApprovalTuning.waitMs = 25_000;
  mcpApprovalTuning.retryMs = 2_000;
});

const post = (body: unknown, sid?: string) =>
  fetch(`http://127.0.0.1:${g.gate.ports.mcp}/mcp/${CID}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sid ? { 'mcp-session-id': sid } : {}),
    },
    body: JSON.stringify(body),
  });

let n = 1;
async function openSession(): Promise<string> {
  const r = await post({
    jsonrpc: '2.0',
    id: n++,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'a', version: '1' } },
  });
  const sid = r.headers.get('mcp-session-id')!;
  await r.text();
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid);
  await (await post({ jsonrpc: '2.0', id: n++, method: 'tools/list' }, sid)).text();
  return sid;
}
const callTool = async (sid: string, name: string) => {
  const r = await post(
    { jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name, arguments: { title: 'x' } } },
    sid,
  );
  return { status: r.status, text: await r.text() };
};

describe('stage 1 end to end: host admin client + real nanogate + fake MCP upstream', () => {
  it('safe call passes with the key injected; the agent never sees the key', async () => {
    const sid = await openSession();
    const r = await callTool(sid, 'get_thing');
    expect(r.status).toBe(200);
    expect(r.text).toContain('ok:get_thing');
    expect(requests).toEqual([]);
    expect(up.calls.get_thing).toBe(1);
    expect(up.seen.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    // nothing the agent received or holds contains the key
    expect(r.text).not.toContain(KEY);
    expect(token).not.toContain(KEY);
    expect(sid).not.toContain(KEY);
  });

  it('dangerous call is held, the host decides approve, and it is forwarded exactly once', async () => {
    const sid = await openSession();
    const r = await callTool(sid, 'create_thing');
    expect(r.status).toBe(200);
    expect(r.text).toContain('ok:create_thing');
    expect(r.text).not.toContain(KEY);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      agentGroupId: 'ag1',
      sessionId: 'sess1',
      trigger: 'policy',
      summary: { action: 'create_thing', resource: 'GitHub' },
      audit: { connectorId: CID, tool: 'create_thing' },
    });
    expect(up.calls.create_thing).toBe(1);
    // the call row reflects the decision
    const calls = await createNanogateAdmin({ socketPath: g.gate.adminSocket }).mcpCalls({
      tenantId: 't1',
      connectorId: CID,
    });
    expect(calls.find((c) => c.tool === 'create_thing')).toMatchObject({
      decision: 'approved',
      dangerous: true,
      status: 'ok',
    });
    // the pending entry is gone, the host is told it resolved
    await vi.waitFor(() => expect(resolvedIds).toEqual([requests[0]!.id]));
  });

  it('reject returns isError to the agent and never reaches the upstream', async () => {
    nextDecision = 'deny';
    const sid = await openSession();
    const r = await callTool(sid, 'create_thing');
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).result.isError).toBe(true);
    expect(r.text).not.toContain(KEY);
    expect(requests).toHaveLength(1);
    expect(up.calls.create_thing ?? 0).toBe(0);
    const calls = await createNanogateAdmin({ socketPath: g.gate.adminSocket }).mcpCalls({
      tenantId: 't1',
      connectorId: CID,
    });
    expect(calls.find((c) => c.tool === 'create_thing')).toMatchObject({ decision: 'denied' });
  });
});
