/**
 * nanogate provider — behavior against a fake admin server on a temp unix
 * socket (the real admin API is covered in nanogate/test).
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { INSTALL_SLUG } from '../../config.js';
import { PodmanSessionDriver } from '../../drivers/podman-driver.js';
import { FIXTURE_POLICY, fixtureSpec } from '../../drivers/spec-fixture.js';
import { validateSpec, type DriverCapabilities, type SessionSpec } from '../../drivers/types.js';
import {
  gatewayPurposeForThread,
  gatewayRuntimeIdentity,
  type GatewaySessionInput,
} from '../gateway-provider-registry.js';
import {
  NanogateNoSessionTokenError,
  MCP_GATEWAY_PORT,
  agentEnv,
  createNanogateAdmin,
  mcpApprovalTuning,
  mintHostToken,
  nanogateProvider,
  parseRuntimeIdentity,
  registerTenantProvisioner,
  registerTenantResolver,
  setNanogateAdminForTests,
  startNanogateHealth,
  stopNanogateHealth,
} from './index.js';

const TOKEN = 'ngs_' + 'A'.repeat(43);
const SOCK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ngt-'));
const SOCK = path.join(SOCK_DIR, 'a.sock');

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

let server: http.Server;
let calls: Call[];
/** sessionKey -> token, the fake's whole state. */
let tokens: Map<string, string>;
let healthy: boolean;
let knownTenants: Set<string>;
/** Per-test handler for the `/mcp-*` admin routes; unset means 404. */
let mcpFake:
  | ((req: http.IncomingMessage, body: Record<string, unknown>, reply: (s: number, j: unknown) => void) => void)
  | null;

beforeEach(async () => {
  calls = [];
  tokens = new Map();
  healthy = true;
  knownTenants = new Set(['g1']);
  mcpFake = null;
  process.env.NANORELAY_IMAGE = 'nanorelay@sha256:' + 'a'.repeat(64);
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      calls.push({ method: req.method!, url: req.url!, body });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (req.url!.startsWith('/mcp-') && mcpFake) return mcpFake(req, body, reply);
      if (req.url === '/healthz') return reply(healthy ? 200 : 503, { ok: healthy });
      if (req.url === '/sessions/ensure') {
        const key = body.sessionKey as string;
        if (!knownTenants.has(body.tenantId as string)) return reply(404, { error: 'tenant_not_found' });
        const live = tokens.get(key);
        if (live) return reply(200, { token: live, created: false });
        if (body.disposition === 'adopt') return reply(409, { error: 'no_session_token' });
        tokens.set(key, TOKEN);
        return reply(200, { token: TOKEN, created: true });
      }
      if (req.url === '/sessions/release') {
        if (body.kind === 'session-ended') tokens.delete(body.sessionKey as string);
        return reply(200, { ok: true });
      }
      if (req.url === '/host-tokens') return reply(201, { token: 'ngh_' + 'B'.repeat(43), hashPrefix: 'abcdef012345' });
      return reply(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(SOCK, resolve));
  setNanogateAdminForTests(createNanogateAdmin({ socketPath: SOCK, timeoutMs: 10_000 }));
});

afterEach(async () => {
  stopNanogateHealth();
  registerTenantResolver(null);
  registerTenantProvisioner(null);
  setNanogateAdminForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(SOCK, { force: true });
});

const podmanCaps: DriverCapabilities = new PodmanSessionDriver({ ...FIXTURE_POLICY }).capabilities();

function input(disposition: 'create' | 'adopt', over: Partial<GatewaySessionInput> = {}): GatewaySessionInput {
  const key = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };
  return {
    key,
    disposition,
    runtimeIdentity: gatewayRuntimeIdentity(key),
    groupName: 'g',
    containerName: 'ncl-spike-s1',
    capabilities: podmanCaps,
    ...over,
  };
}

const signal = new AbortController().signal;

describe('ensure', () => {
  it('forwards purpose "task" in the ensure body and omits it otherwise', async () => {
    await nanogateProvider.sessions.ensure(input('create', { purpose: 'task' }), signal);
    expect(calls.filter((x) => x.url === '/sessions/ensure').at(-1)!.body).toMatchObject({ purpose: 'task' });
    await nanogateProvider.sessions.ensure(input('create'), signal);
    expect(calls.filter((x) => x.url === '/sessions/ensure').at(-1)!.body).not.toHaveProperty('purpose');
  });

  it('derives purpose from the thread id', () => {
    expect(gatewayPurposeForThread('system:tasks:abc')).toBe('task');
    expect(gatewayPurposeForThread('system:tasks')).toBe('task');
    expect(gatewayPurposeForThread(null)).toBeUndefined();
    expect(gatewayPurposeForThread('123')).toBeUndefined();
  });

  it('creates a token and contributes the relay topology and agent env', async () => {
    const lease = await nanogateProvider.sessions.ensure(input('create'), signal);
    const c = lease.contribution;

    expect(calls.find((x) => x.url === '/sessions/ensure')!.body).toEqual({
      tenantId: 'g1',
      sessionKey: 'spike/g1/s1',
      runtimeIdentity: 'spike/g1/s1',
      disposition: 'create',
    });
    expect(c.networkAccess).toEqual({ endpoint: 'nanorelay', target: { kind: 'session-container', role: 'relay' } });
    expect(c.containers).toHaveLength(1);
    expect(c.containers![0]).toMatchObject({
      role: 'relay',
      image: process.env.NANORELAY_IMAGE,
      env: { NANORELAY_MAP: '8080=nanogate:8080,3128=nanogate:3128,8081=nanogate:8081' },
      mounts: [],
    });
    expect(c.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'http://nanorelay:8080/anthropic',
      ANTHROPIC_API_KEY: TOKEN,
      HTTPS_PROXY: `http://s:${TOKEN}@nanorelay:3128`,
      HTTP_PROXY: `http://s:${TOKEN}@nanorelay:3128`,
      https_proxy: `http://s:${TOKEN}@nanorelay:3128`,
      http_proxy: `http://s:${TOKEN}@nanorelay:3128`,
      NO_PROXY: 'nanorelay,localhost,127.0.0.1',
      no_proxy: 'nanorelay,localhost,127.0.0.1',
      NC_MCP_GATEWAY_PREFIX: 'http://nanorelay:8081/mcp/',
      CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '420000',
      CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '0',
    });
    expect(MCP_GATEWAY_PORT).toBe(8081);
  });

  it('adopt returns the SAME token and never mints', async () => {
    const first = await nanogateProvider.sessions.ensure(input('create'), signal);
    const adopted = await nanogateProvider.sessions.ensure(input('adopt'), signal);
    expect(adopted.contribution.env!.ANTHROPIC_API_KEY).toBe(first.contribution.env!.ANTHROPIC_API_KEY);
    expect(tokens.size).toBe(1);
  });

  it('fails closed with a typed error when adopt finds no token', async () => {
    await expect(nanogateProvider.sessions.ensure(input('adopt'), signal)).rejects.toBeInstanceOf(
      NanogateNoSessionTokenError,
    );
    expect(tokens.size).toBe(0);
  });

  it('maps the tenant through the registered resolver', async () => {
    knownTenants.add('tenant-x');
    registerTenantResolver((g) => ({ tenantId: `tenant-${g === 'g1' ? 'x' : g}`, kind: 'friend' }));
    await nanogateProvider.sessions.ensure(input('create'), signal);
    expect(calls.find((x) => x.url === '/sessions/ensure')!.body.tenantId).toBe('tenant-x');
  });

  it('provisions an unknown tenant once on create, via the registered provisioner', async () => {
    knownTenants.clear();
    const provision = vi.fn(async () => {
      knownTenants.add('g1');
    });
    registerTenantProvisioner(provision);
    await nanogateProvider.sessions.ensure(input('create'), signal);
    expect(provision).toHaveBeenCalledWith({ tenantId: 'g1', kind: 'friend' }, expect.anything());
  });

  it('refuses a driver without auxiliary containers and a missing relay image', async () => {
    await expect(
      nanogateProvider.sessions.ensure(
        input('create', { capabilities: { ...podmanCaps, auxiliaryContainers: false } }),
        signal,
      ),
    ).rejects.toThrow(/auxiliary containers/);
    delete process.env.NANORELAY_IMAGE;
    await expect(nanogateProvider.sessions.ensure(input('create'), signal)).rejects.toThrow(/NANORELAY_IMAGE/);
  });

  it('rejects a token that is not in the ngs_ format before it reaches a URL', () => {
    expect(agentEnv('ngs_abcdefghijklmnop0123').NODE_USE_ENV_PROXY).toBe('1');
    expect(agentEnv('ngs_abcdefghijklmnop0123').ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-5-5');
    process.env.NC_MODEL_SMALL = 'claude-haiku-5-6';
    try {
      expect(agentEnv('ngs_abcdefghijklmnop0123').ANTHROPIC_SMALL_FAST_MODEL).toBe('claude-haiku-5-6');
    } finally {
      delete process.env.NC_MODEL_SMALL;
    }
    expect(() => agentEnv('ngs_x@evil/')).toThrow(/unexpected format/);
    expect(() => agentEnv('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA')).toThrow(/unexpected format/);
  });
});

describe('agent env feature toggles', () => {
  const token = 'ngs_abcdefghijklmnop0123';
  afterEach(() => {
    delete process.env.NC_TOOL_SEARCH;
    delete process.env.NC_PROMPT_CACHE_1H;
  });

  it('turns tool search and the 1h prompt cache on by default', () => {
    expect(agentEnv(token)).toMatchObject({ ENABLE_TOOL_SEARCH: 'true', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
  });

  it('NC_TOOL_SEARCH=0 and NC_PROMPT_CACHE_1H=0 switch them off independently', () => {
    process.env.NC_TOOL_SEARCH = '0';
    expect(agentEnv(token)).not.toHaveProperty('ENABLE_TOOL_SEARCH');
    expect(agentEnv(token).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
    process.env.NC_PROMPT_CACHE_1H = 'false';
    expect(agentEnv(token)).not.toHaveProperty('CLAUDE_CODE_PROMPT_CACHE_TTL');
  });
});

describe('release', () => {
  it('revokes on session-ended and only notifies on host-detached', async () => {
    const lease = await nanogateProvider.sessions.ensure(input('create'), signal);
    await lease.release!({ kind: 'host-detached', reason: 'shutdown' });
    expect(tokens.size).toBe(1);
    expect(calls.at(-1)!.body).toEqual({ sessionKey: 'spike/g1/s1', kind: 'host-detached' });

    await lease.release!({ kind: 'session-ended', reason: 'done' });
    expect(tokens.size).toBe(0);
    expect(calls.at(-1)!.body).toEqual({ sessionKey: 'spike/g1/s1', kind: 'session-ended' });
  });

  it('swallows a host-detached failure but surfaces a session-ended one', async () => {
    const lease = await nanogateProvider.sessions.ensure(input('create'), signal);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(lease.release!({ kind: 'host-detached', reason: 'x' })).resolves.toBeUndefined();
    await expect(lease.release!({ kind: 'session-ended', reason: 'x' })).rejects.toThrow(/unreachable/);
    server = http.createServer(); // keep afterEach's close() valid
    await new Promise<void>((resolve) => server.listen(SOCK, resolve));
  });
});

describe('health', () => {
  it('reports availability from /healthz and flips with it', async () => {
    expect(await nanogateProvider.availability!.read()).toBe(true);
    healthy = false;
    stopNanogateHealth();
    expect(await nanogateProvider.availability!.read()).toBe(false);
    healthy = true;
    stopNanogateHealth();
    expect(await nanogateProvider.availability!.read()).toBe(true);
  });

  it('reads unavailable when the socket is gone', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await nanogateProvider.availability!.read()).toBe(false);
    server = http.createServer();
    await new Promise<void>((resolve) => server.listen(SOCK, resolve));
  });

  it('tells session leases when a healthy gateway turns unhealthy', async () => {
    await startNanogateHealth(30);
    const report = vi.fn();
    const lease = await nanogateProvider.sessions.ensure(input('create'), signal);
    lease.onUnavailable!(report);
    await new Promise((r) => setTimeout(r, 80));
    expect(report).not.toHaveBeenCalled();
    healthy = false;
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce(), { timeout: 4000 });
  });
});

describe('approvals and helpers', () => {
  it('holds the approval subscription open until the signal aborts', async () => {
    const controller = new AbortController();
    let settled = false;
    const p = nanogateProvider.approvals
      .subscribe(async () => 'deny', controller.signal)
      .then(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    controller.abort();
    await p;
    expect(settled).toBe(true);
  });

  it('mints host tokens through the admin socket', async () => {
    expect(await mintHostToken('g1', 'stt')).toMatch(/^ngh_/);
    expect(calls.at(-1)!.body).toEqual({ tenantId: 'g1', purpose: 'stt' });
  });
});

describe('the contribution passes upstream validation with the podman capabilities', () => {
  it('accepts the token-bearing contributed env and the relay container', async () => {
    const lease = await nanogateProvider.sessions.ensure(input('create'), signal);
    const c = lease.contribution;
    const base = fixtureSpec();
    const spec: SessionSpec = {
      ...base,
      networkAccess: c.networkAccess,
      containers: [{ ...base.containers[0], contributedEnv: c.env }, ...c.containers!],
    };
    expect(() => validateSpec(spec, FIXTURE_POLICY, podmanCaps)).not.toThrow();
  });

  it('would refuse the same token on the composed env lane (credential-shaped name)', async () => {
    const lease = await nanogateProvider.sessions.ensure(input('create'), signal);
    const base = fixtureSpec();
    const spec: SessionSpec = {
      ...base,
      containers: [{ ...base.containers[0], env: { ANTHROPIC_API_KEY: lease.contribution.env!.ANTHROPIC_API_KEY } }],
    };
    expect(() => validateSpec(spec, FIXTURE_POLICY, podmanCaps)).toThrow(/secret-shaped env/);
  });
});

describe('reapOrphans', () => {
  it("revokes only this install's vanished sessions and keeps foreign keys", async () => {
    const { INSTALL_SLUG } = await import('../../config.js');
    const { resetSessionDriver } = await import('../../drivers/index.js');
    const mine = (id: string) => `${INSTALL_SLUG}/g1/${id}`;
    // Fake nanogate with a richer /sessions + /sessions/reconcile.
    const reconcile: string[][] = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/sessions') {
          return res.end(
            JSON.stringify({
              sessions: [mine('alive'), mine('gone'), 'other-install/g9/x'].map((sessionKey) => ({
                sessionKey,
                tenantId: 't',
                runtimeIdentity: null,
              })),
            }),
          );
        }
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        reconcile.push(body.liveSessionKeys);
        res.end(JSON.stringify({ revoked: [mine('gone')] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(SOCK, resolve));

    resetSessionDriver({
      kind: 'fake',
      capabilities: () => podmanCaps,
      prepare: () => Promise.reject(new Error('unused')),
      listSessions: async () => [
        {
          handle: { key: { installSlug: INSTALL_SLUG, agentGroupId: 'g1', sessionId: 'alive' } } as never,
          phase: 'running',
        },
      ],
      watchSessions: () => ({ stop: () => {} }),
    });
    try {
      await nanogateProvider.sessions.reapOrphans!();
    } finally {
      resetSessionDriver(null);
    }
    expect(reconcile).toHaveLength(1);
    expect(new Set(reconcile[0])).toEqual(new Set([mine('alive'), 'other-install/g9/x']));
  });

  it('skips the sweep when the live runtime list cannot be read', async () => {
    const { resetSessionDriver } = await import('../../drivers/index.js');
    resetSessionDriver({
      kind: 'fake',
      capabilities: () => podmanCaps,
      prepare: () => Promise.reject(new Error('unused')),
      listSessions: () => Promise.reject(new Error('runtime down')),
      watchSessions: () => ({ stop: () => {} }),
    });
    try {
      await nanogateProvider.sessions.reapOrphans!();
    } finally {
      resetSessionDriver(null);
    }
    expect(calls.some((c) => c.url === '/sessions/reconcile')).toBe(false);
  });
});

describe('parseRuntimeIdentity', () => {
  it('inverts gatewayRuntimeIdentity', () => {
    const key = { installSlug: 'spike', agentGroupId: 'ag-1', sessionId: 'sess-9' };
    expect(parseRuntimeIdentity(gatewayRuntimeIdentity(key))).toEqual(key);
  });
  it('rejects anything that is not exactly slug/group/session', () => {
    for (const bad of ['', 'a', 'a/b', 'a/b/c/d', 'a//c', '/b/c']) expect(parseRuntimeIdentity(bad)).toBeNull();
  });
});

describe('mcp admin client methods', () => {
  it('sends connector CRUD, probe, calls and decisions on the documented paths', async () => {
    const seen: string[] = [];
    mcpFake = (req, body, reply) => {
      seen.push(`${req.method} ${req.url} ${JSON.stringify(body)}`);
      if (req.method === 'PUT' || req.method === 'DELETE') return reply(204, undefined);
      if (req.url!.startsWith('/mcp-connectors/') && req.url!.endsWith('/probe'))
        return reply(200, { ok: true, tools: 3 });
      if (req.url!.startsWith('/mcp-connectors'))
        return reply(200, { connectors: [{ id: 'github-aa', tenantId: 'g1' }] });
      if (req.url!.startsWith('/mcp-calls')) return reply(200, { calls: [{ id: 'mc_1' }] });
      if (req.url!.endsWith('/decision')) return reply(200, { accepted: false });
      return reply(404, { error: 'not_found' });
    };
    const admin = createNanogateAdmin({ socketPath: SOCK });
    const body = {
      tenantId: 'g1',
      title: 'GitHub',
      url: 'https://x.test/mcp/',
      secretName: 'mcp.github-aa',
      extraHeaders: {},
      toolPolicy: {},
      enabled: true,
    };
    await admin.putMcpConnector('github-aa', body);
    expect(await admin.listMcpConnectors('g 1')).toEqual([{ id: 'github-aa', tenantId: 'g1' }]);
    expect(await admin.probeMcpConnector('github-aa')).toEqual({ ok: true, tools: 3 });
    await admin.probeMcpConnector('github-aa', 'ghp_x');
    expect(await admin.mcpCalls({ tenantId: 'g1', connectorId: 'github-aa', limit: 5 })).toEqual([{ id: 'mc_1' }]);
    expect(await admin.decideMcpApproval('mc_1', 'deny')).toEqual({ accepted: false });
    await admin.deleteMcpConnector('github-aa');
    expect(seen).toEqual([
      `PUT /mcp-connectors/github-aa ${JSON.stringify(body)}`,
      'GET /mcp-connectors?tenantId=g%201 {}',
      'POST /mcp-connectors/github-aa/probe {}',
      'POST /mcp-connectors/github-aa/probe {"candidateKey":"ghp_x"}',
      'GET /mcp-calls?tenantId=g1&connectorId=github-aa&limit=5 {}',
      'POST /mcp-approvals/mc_1/decision {"decision":"deny"}',
      'DELETE /mcp-connectors/github-aa {}',
    ]);
  });

  it('long-poll waits past the default timeout and aborts on signal', async () => {
    let hits = 0;
    mcpFake = () => {
      hits++; // never replies: the poll hangs like nanogate holding it
    };
    const admin = createNanogateAdmin({ socketPath: SOCK, timeoutMs: 50 });
    const ac = new AbortController();
    const p = admin.waitMcpApprovals(0, 30_000, ac.signal);
    const settled = vi.fn();
    p.catch(settled);
    await new Promise((r) => setTimeout(r, 200)); // longer than the 50 ms default
    expect(hits).toBe(1);
    expect(settled).not.toHaveBeenCalled();
    ac.abort();
    await expect(p).rejects.toThrow(/unreachable/);
    await expect(admin.waitMcpApprovals(0, 1, ac.signal)).rejects.toThrow(/unreachable/);
  });
});

describe('approvals.subscribe over the mcp-approvals long-poll', () => {
  const pending = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    tenantId: 'g1',
    sessionKey: `${INSTALL_SLUG}/g1/s1`,
    connectorId: 'github-aa',
    connectorTitle: 'GitHub',
    tool: 'create_issue',
    args: [{ label: 'title', type: 'text', value: 'hi' }],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ...over,
  });
  const tune = { ...mcpApprovalTuning };
  beforeEach(() => {
    mcpApprovalTuning.waitMs = 20;
    mcpApprovalTuning.retryMs = 20;
  });
  afterEach(() => Object.assign(mcpApprovalTuning, tune));

  const until = async (cond: () => boolean) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    expect(cond()).toBe(true);
  };

  it('turns a pending call into a request, posts the decision, and resolves a vanished id', async () => {
    let current: unknown[] = [];
    let version = 1;
    const decisions: Array<{ url: string; body: Record<string, unknown> }> = [];
    mcpFake = (req, body, reply) => {
      if (req.url!.endsWith('/decision')) {
        decisions.push({ url: req.url!, body });
        return reply(200, { accepted: true });
      }
      const since = Number(new URL(req.url!, 'http://x').searchParams.get('since'));
      if (since >= version) return setTimeout(() => reply(200, { version, pending: current }), 20);
      reply(200, { version, pending: current });
    };
    const seen: any[] = [];
    const resolved: string[] = [];
    const ac = new AbortController();
    const done = nanogateProvider.approvals.subscribe(
      async (r) => {
        seen.push(r);
        return 'approve';
      },
      ac.signal,
      async (id) => {
        resolved.push(id);
      },
    );
    current = [pending('mc_a')];
    version = 2;
    await until(() => decisions.length === 1);
    expect(decisions[0]).toEqual({ url: '/mcp-approvals/mc_a/decision', body: { decision: 'approve' } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id: 'mc_a',
      trigger: 'policy',
      agentGroupId: 'g1',
      sessionId: 's1',
      runtimeIdentity: `${INSTALL_SLUG}/g1/s1`,
      title: 'GitHub: подтвердите действие',
      question: 'Агент хочет вызвать create_issue',
      displayFields: [{ label: 'title', type: 'text', value: 'hi' }],
      audit: { connectorId: 'github-aa', tool: 'create_issue' },
    });
    expect(seen[0].summary).toMatchObject({ action: 'create_issue', resource: 'GitHub' });
    // The same id again is not re-decided; its disappearance resolves the card.
    current = [];
    version = 3;
    await until(() => resolved.length === 1);
    expect(resolved).toEqual(['mc_a']);
    expect(seen).toHaveLength(1);
    ac.abort();
    await done;
  });

  it('answers "unavailable" without deciding for a call held since before the host started, or an unparseable one', async () => {
    const decisions: Array<Record<string, unknown> & { url: string }> = [];
    const old = new Date(Date.now() - 60_000).toISOString();
    mcpFake = (req, body, reply) => {
      if (req.url!.endsWith('/decision')) {
        decisions.push({ url: req.url!, ...body });
        return reply(200, { accepted: true });
      }
      const since = Number(new URL(req.url!, 'http://x').searchParams.get('since'));
      const r = {
        version: 1,
        pending: [pending('mc_old', { createdAt: old }), pending('mc_bad', { sessionKey: 'nope' })],
      };
      if (since >= 1) return setTimeout(() => reply(200, r), 20);
      reply(200, r);
    };
    const decide = vi.fn(async () => 'approve' as const);
    const ac = new AbortController();
    const done = nanogateProvider.approvals.subscribe(decide, ac.signal);
    await until(() => decisions.length === 2);
    expect(decisions.map((d) => [d.url, d.decision]).sort()).toEqual([
      ['/mcp-approvals/mc_bad/decision', 'unavailable'],
      ['/mcp-approvals/mc_old/decision', 'unavailable'],
    ]);
    expect(decide).not.toHaveBeenCalled();
    ac.abort();
    await done;
  });

  it('ignores calls of another install on a shared nanogate', async () => {
    let polls = 0;
    mcpFake = (_req, _b, reply) => {
      polls++;
      reply(200, { version: polls, pending: [pending('mc_x', { sessionKey: `not-${INSTALL_SLUG}/g1/s1` })] });
    };
    const decide = vi.fn(async () => 'approve' as const);
    const ac = new AbortController();
    const done = nanogateProvider.approvals.subscribe(decide, ac.signal);
    await until(() => polls >= 3);
    expect(decide).not.toHaveBeenCalled();
    ac.abort();
    await done;
  });

  it('survives socket errors: keeps polling from since=0 and never returns while the signal is live', async () => {
    const sinces: number[] = [];
    let n = 0;
    mcpFake = (req, _b, reply) => {
      sinces.push(Number(new URL(req.url!, 'http://x').searchParams.get('since')));
      n++;
      if (n === 1) return reply(200, { version: 7, pending: [] });
      if (n === 2) return (req.socket as import('node:net').Socket).destroy(); // socket dies mid-poll
      if (n === 3) return reply(500, { error: 'boom' });
      if (n === 4) return reply(200, { nope: true }); // malformed
      setTimeout(() => reply(200, { version: 8, pending: [] }), 20);
    };
    let returned = false;
    const ac = new AbortController();
    const done = nanogateProvider.approvals
      .subscribe(async () => 'deny', ac.signal)
      .then(() => {
        returned = true;
      });
    await until(() => n >= 6);
    expect(returned).toBe(false);
    expect(sinces.slice(0, 3)).toEqual([0, 7, 0]);
    expect(sinces[3]).toBe(0);
    ac.abort();
    await done;
    expect(returned).toBe(true);
  });

  it('posts "unavailable" when the coordinator throws', async () => {
    const decisions: Array<Record<string, unknown>> = [];
    mcpFake = (req, body, reply) => {
      if (req.url!.endsWith('/decision')) {
        decisions.push(body);
        return reply(200, { accepted: true });
      }
      const since = Number(new URL(req.url!, 'http://x').searchParams.get('since'));
      const r = { version: 1, pending: [pending('mc_t')] };
      if (since >= 1) return setTimeout(() => reply(200, r), 20);
      reply(200, r);
    };
    const ac = new AbortController();
    const done = nanogateProvider.approvals.subscribe(async () => {
      throw new Error('coordinator down');
    }, ac.signal);
    await until(() => decisions.length === 1);
    expect(decisions[0]).toEqual({ decision: 'unavailable' });
    ac.abort();
    await done;
  });
});
