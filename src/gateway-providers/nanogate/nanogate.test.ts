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
  agentEnv,
  createNanogateAdmin,
  mintHostToken,
  nanogateProvider,
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

beforeEach(async () => {
  calls = [];
  tokens = new Map();
  healthy = true;
  knownTenants = new Set(['g1']);
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
      env: { NANORELAY_MAP: '8080=nanogate:8080,3128=nanogate:3128' },
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
    });
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
