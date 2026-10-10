import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = vi.hoisted(() => `/tmp/nc-api-${process.pid}`);
vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: path.join(TMP, 'data'), GROUPS_DIR: path.join(TMP, 'groups'), TIMEZONE: 'UTC' };
});
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
const { previewGuestAnswer } = vi.hoisted(() => ({ previewGuestAnswer: vi.fn(async (q: string) => `Ответ на: ${q}`) }));
vi.mock('../guest.js', async (orig) => ({ ...(await orig<typeof import('../guest.js')>()), previewGuestAnswer }));
const { startProvisioning } = vi.hoisted(() => ({ startProvisioning: vi.fn(async () => true) }));
vi.mock('../provision.js', () => ({ startProvisioning, retryProvisioning: vi.fn() }));

import { closeDb, createAgentGroup } from '../../db/index.js';
import { createSession, taskThreadId } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import { createScheduledTask, prepareScheduledTask } from '../../modules/scheduling/create.js';
import { setNanogateAdminForTests } from '../../gateway-providers/nanogate/index.js';
import { createRequest, getTenantByTg, insertTenantIfAbsent, updateTenant } from '../store.js';
import { FRIEND_A, FRIEND_B, OWNER, fakeNanogate, initDataFor, installFakeAdapter, setupDb } from '../test-helpers.js';
import { startMiniAppServer, type RunningMiniApp } from './server.js';
import { sessions } from './sessions.js';

const BOT = '123456:API-TEST';
let app: RunningMiniApp;
let base: string;
let ng: ReturnType<typeof fakeNanogate>;

async function mkTenant(tgId: number, folder: string, state: 'ready' | 'paused' | 'pending' = 'ready'): Promise<void> {
  const gid = `ag-${folder}`;
  await createAgentGroup({ id: gid, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() });
  await insertTenantIfAbsent({ tgId, name: `User${tgId}`, state });
  await updateTenant(tgId, { agent_group_id: gid, limit_usd_micros: 10_000_000 });
  fs.mkdirSync(path.join(TMP, 'groups', folder, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'groups', folder, 'memory', 'secret.md'), `secret of ${folder}`);
}

async function login(userId: number): Promise<{ token: string; res: Response }> {
  const res = await fetch(`${base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData: initDataFor(userId, BOT) }),
  });
  const j = res.ok ? ((await res.clone().json()) as { token: string }) : { token: '' };
  return { token: j.token, res };
}

function call(token: string, method: string, p: string, body?: unknown, csrf = true): Promise<Response> {
  return fetch(`${base}${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(csrf && method !== 'GET' ? { 'x-csrf': token } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  await setupDb();
  installFakeAdapter();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  await mkTenant(OWNER, 'owner');
  await mkTenant(FRIEND_A, 'fa');
  await mkTenant(FRIEND_B, 'fb');
  app = await startMiniAppServer({ port: 0, botToken: () => BOT, staticDir: path.join(TMP, 'static') });
  base = `http://127.0.0.1:${app.port}`;
});
afterEach(async () => {
  await app.close();
  setNanogateAdminForTests(null);
  await closeDb();
  sessions.revokeUser(OWNER);
  sessions.revokeUser(FRIEND_A);
  sessions.revokeUser(FRIEND_B);
});

describe('session / auth', () => {
  it('logs in a ready friend and returns me', async () => {
    const { res } = await login(FRIEND_A);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { me: { role: string; userId: string } };
    expect(j.me).toMatchObject({ role: 'friend', userId: `telegram:${FRIEND_A}` });
  });

  it('refuses forged initData and unknown / pending users identically', async () => {
    const forged = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: initDataFor(OWNER, 'wrong:token') }),
    });
    expect(forged.status).toBe(401);
    expect(((await forged.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    const unknown = await login(777777);
    expect(unknown.res.status).toBe(403);
    await insertTenantIfAbsent({ tgId: 888, name: 'P', state: 'pending' });
    const pending = await login(888);
    expect(pending.res.status).toBe(403);
  });

  it('refuses stale initData (>24h)', async () => {
    const res = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: initDataFor(FRIEND_A, BOT, Math.floor(Date.now() / 1000) - 100_000) }),
    });
    expect(res.status).toBe(401);
  });

  it('requires a valid bearer; garbage and missing tokens get 401', async () => {
    expect((await fetch(`${base}/api/home`)).status).toBe(401);
    expect((await call('x'.repeat(40), 'GET', '/api/home')).status).toBe(401);
    expect((await call('not a token', 'GET', '/api/home')).status).toBe(401);
  });

  it('mutations without the matching X-CSRF are refused', async () => {
    const { token } = await login(FRIEND_A);
    const r = await call(token, 'PATCH', '/api/settings', { showSteps: false }, false);
    expect(r.status).toBe(403);
  });

  it('an epoch bump invalidates live sessions', async () => {
    const { token } = await login(FRIEND_A);
    expect((await call(token, 'GET', '/api/home')).status).toBe(200);
    await updateTenant(FRIEND_A, { epoch: 2 });
    expect((await call(token, 'GET', '/api/home')).status).toBe(401);
  });

  it('a tenant paused after login loses everything except the read-only home', async () => {
    const { token } = await login(FRIEND_A);
    await updateTenant(FRIEND_A, { state: 'paused' });
    expect((await call(token, 'GET', '/api/home')).status).toBe(200);
    expect((await call(token, 'GET', '/api/memory')).status).toBe(403);
    expect((await call(token, 'PATCH', '/api/settings', { showSteps: false })).status).toBe(403);
  });

  it('a deleted tenant is locked out', async () => {
    const { token } = await login(FRIEND_A);
    await updateTenant(FRIEND_A, { state: 'deleted' });
    expect((await call(token, 'GET', '/api/home')).status).toBe(403);
  });

  it('enforces the body limit and JSON content type', async () => {
    const { token } = await login(FRIEND_A);
    const big = await call(token, 'PATCH', '/api/settings', { tz: 'x'.repeat(70_000) });
    expect(big.status).toBe(413);
    const bad = await fetch(`${base}/api/settings`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'x-csrf': token, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(bad.status).toBe(415);
  });
});

describe('role enforcement', () => {
  it('every /api/owner route is 403 for a friend and does nothing', async () => {
    const { token } = await login(FRIEND_A);
    const req = await createRequest(FRIEND_B, 'x');
    const cases: Array<[string, string, unknown?]> = [
      ['GET', '/api/owner/requests'],
      ['POST', `/api/owner/requests/${req.id}/approve`, {}],
      ['POST', `/api/owner/requests/${req.id}/deny`, {}],
      ['GET', '/api/owner/friends'],
      ['PATCH', `/api/owner/friends/telegram%3A${FRIEND_B}`, { limitUsd: 999 }],
      ['POST', `/api/owner/friends/telegram%3A${FRIEND_B}/pause`, {}],
      ['POST', `/api/owner/friends/telegram%3A${FRIEND_B}/resume`, {}],
      ['DELETE', `/api/owner/friends/telegram%3A${FRIEND_B}`, { confirmName: `User${FRIEND_B}` }],
      ['GET', '/api/owner/guest'],
      ['PUT', '/api/owner/guest/draft', { markdown: 'x' }],
      ['POST', '/api/owner/guest/publish', {}],
      ['POST', '/api/owner/guest/enabled', { enabled: true }],
      ['GET', '/api/owner/system'],
    ];
    for (const [m, p, b] of cases) expect((await call(token, m, p, b)).status, `${m} ${p}`).toBe(403);
    expect(startProvisioning).not.toHaveBeenCalled();
    expect((await getTenantByTg(FRIEND_B))?.limit_usd_micros).toBe(10_000_000);
  });

  it('the owner can approve a request once and gets 409 afterwards', async () => {
    const { token } = await login(OWNER);
    await insertTenantIfAbsent({ tgId: 555, name: 'Новый', state: 'pending' });
    const req = await createRequest(555, 'hi');
    expect((await call(token, 'POST', `/api/owner/requests/${req.id}/approve`, { limitUsd: 7 })).status).toBe(204);
    expect(startProvisioning).toHaveBeenCalledWith(555, 7_000_000, `telegram:${OWNER}`);
    expect((await call(token, 'POST', `/api/owner/requests/${req.id}/approve`, {})).status).toBe(409);
    expect((await call(token, 'POST', `/api/owner/requests/zzzzzzzzzz/approve`, {})).status).toBe(404);
    expect((await call(token, 'POST', `/api/owner/requests/${req.id}/approve`, { limitUsd: -1 })).status).toBe(400);
  });

  it('owner cannot target their own tenant through friend routes; delete needs the exact name', async () => {
    const { token } = await login(OWNER);
    expect((await call(token, 'POST', `/api/owner/friends/telegram%3A${OWNER}/pause`, {})).status).toBe(404);
    expect(
      (await call(token, 'DELETE', `/api/owner/friends/telegram%3A${FRIEND_A}`, { confirmName: 'nope' })).status,
    ).toBe(400);
    expect((await call(token, 'GET', '/api/owner/friends')).status).toBe(200);
  });
});

describe('tenant scoping of data routes', () => {
  it('memory: a friend reads only their own memory; traversal and foreign paths fail', async () => {
    const { token } = await login(FRIEND_A);
    const own = await call(token, 'GET', '/api/memory/file?path=secret.md');
    expect(((await own.json()) as { markdown: string }).markdown).toBe('secret of fa');
    for (const p of [
      '../fb/memory/secret.md',
      '../../fb/memory/secret.md',
      '/etc/passwd',
      'a/../../x',
      '.hidden',
      encodeURIComponent('../fb/memory/secret.md'),
    ]) {
      const r = await call(token, 'GET', `/api/memory/file?path=${p}`);
      expect([400, 404], p).toContain(r.status);
    }
    const tree = (await (await call(token, 'GET', '/api/memory')).json()) as { entries: Array<{ path: string }> };
    expect(tree.entries.map((e) => e.path)).toEqual(['secret.md']);
  });

  it('memory: a symlink planted by the agent cannot escape the group', async () => {
    const { token } = await login(FRIEND_A);
    fs.writeFileSync(path.join(TMP, 'host-secret'), 'HOST');
    fs.symlinkSync(path.join(TMP, 'host-secret'), path.join(TMP, 'groups', 'fa', 'memory', 'leak.md'));
    fs.symlinkSync(path.join(TMP, 'groups', 'fb', 'memory'), path.join(TMP, 'groups', 'fa', 'memory', 'bdir'));
    expect((await call(token, 'GET', '/api/memory/file?path=leak.md')).status).toBe(404);
    expect((await call(token, 'GET', '/api/memory/file?path=bdir/secret.md')).status).toBe(404);
    const tree = (await (await call(token, 'GET', '/api/memory')).json()) as { entries: Array<{ path: string }> };
    expect(tree.entries.map((e) => e.path)).toEqual(['secret.md']);
  });

  it('memory: oversize files are truncated, not loaded', async () => {
    const { token } = await login(FRIEND_A);
    fs.writeFileSync(path.join(TMP, 'groups', 'fa', 'memory', 'big.md'), 'x'.repeat(5_000_000));
    const j = (await (await call(token, 'GET', '/api/memory/file?path=big.md')).json()) as {
      markdown: string;
      truncated: boolean;
    };
    expect(j.truncated).toBe(true);
    expect(j.markdown.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('tasks: a friend sees and controls only their own series', async () => {
    for (const [gid, sid] of [
      ['ag-fa', 's-a'],
      ['ag-fb', 's-b'],
    ] as const) {
      await createSession({
        id: sid,
        agent_group_id: gid,
        messaging_group_id: null,
        thread_id: null,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: new Date().toISOString(),
      });
      initSessionFolder(gid, sid);
    }
    const ta = await createScheduledTask(
      'ag-fa',
      prepareScheduledTask({ name: 'mine', prompt: 'моя задача', recurrence: '0 9 * * 1' }),
    );
    const tb = await createScheduledTask(
      'ag-fb',
      prepareScheduledTask({ name: 'theirs', prompt: 'чужая задача', recurrence: '0 9 * * 2' }),
    );
    const idA = ta.row.seriesId ?? ta.row.id;
    const idB = tb.row.seriesId ?? tb.row.id;

    const { token } = await login(FRIEND_A);
    const list = (await (await call(token, 'GET', '/api/tasks')).json()) as Array<{ id: string; name: string }>;
    expect(list.map((t) => t.id)).toEqual([idA]);
    expect((await call(token, 'GET', `/api/tasks/${idB}`)).status).toBe(404);
    expect((await call(token, 'POST', `/api/tasks/${idB}/pause`)).status).toBe(404);
    expect((await call(token, 'DELETE', `/api/tasks/${idB}`)).status).toBe(404);
    // B's task is untouched
    const { token: tokB } = await login(FRIEND_B);
    const listB = (await (await call(tokB, 'GET', '/api/tasks')).json()) as Array<{ id: string; status: string }>;
    expect(listB).toEqual([expect.objectContaining({ id: idB, status: 'active' })]);
    expect((await call(token, 'POST', `/api/tasks/${idA}/pause`)).status).toBe(204);
    expect((await call(token, 'DELETE', `/api/tasks/${idA}`)).status).toBe(204);
    expect((await call(token, 'GET', '/api/tasks')).status).toBe(200);
    expect((await call(token, 'GET', '/api/tasks/..%2F..%2Fx')).status).toBe(400);
  });

  it('usage/budget queries are always scoped to the session tenant', async () => {
    const { token } = await login(FRIEND_A);
    await call(token, 'GET', '/api/usage?days=14');
    await call(token, 'GET', '/api/home');
    for (const c of ng.usage.mock.calls) expect(c[0].tenantId).toBe(`telegram:${FRIEND_A}`);
    for (const c of ng.budget.mock.calls) expect(c[0]).toBe(`telegram:${FRIEND_A}`);
    expect((await call(token, 'GET', '/api/usage?days=7')).status).toBe(400);
  });

  it('friend Tailscale keys are refused (no per-friend connector yet) and the card never claims «connecting»', async () => {
    const { token } = await login(FRIEND_A);
    expect(
      (await call(token, 'PUT', '/api/connections/tailscale/key', { key: 'tskey-auth-abcdef123456' })).status,
    ).toBe(403);
    expect((await call(token, 'POST', '/api/connections/tailscale/reconnect')).status).toBe(403);
    expect(ng.putSecret).not.toHaveBeenCalled();
    const j = (await (await call(token, 'GET', '/api/connections')).json()) as {
      connections: Array<{ status: string; message?: string }>;
    };
    expect(j.connections[0].status).toBe('not_connected');
    expect(j.connections[0].message).toContain('Скоро');
  });

  it('revoking the owner connector is refused (server-managed)', async () => {
    process.env.NC_OWNER_CONNECTOR_SOCKS = '10.91.2.2:1055';
    const { token } = await login(OWNER);
    expect((await call(token, 'DELETE', '/api/connections/tailscale')).status).toBe(409);
    expect(ng.deleteConnector).not.toHaveBeenCalled();
    delete process.env.NC_OWNER_CONNECTOR_SOCKS;
  });

  it('the Home Assistant token is owner-only, written to a 0600 file in the owner group, never read back', async () => {
    const tok = 'a'.repeat(40);
    const { token: ft } = await login(FRIEND_A);
    expect((await call(ft, 'PUT', '/api/owner/secrets/ha-token', { token: tok })).status).toBe(403);
    const { token } = await login(OWNER);
    expect((await call(token, 'PUT', '/api/owner/secrets/ha-token', { token: 'short' })).status).toBe(400);
    expect((await call(token, 'PUT', '/api/owner/secrets/ha-token', { token: tok })).status).toBe(204);
    const file = path.join(TMP, 'groups', 'owner', '.secrets', 'ha_token');
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(tok);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(await (await call(token, 'GET', '/api/connections')).text()).not.toContain(tok);
    const st = (await (await call(token, 'GET', '/api/connections')).json()) as { haToken: { savedAt: string } | null };
    expect(Date.parse(st.haToken!.savedAt)).toBeGreaterThan(0);
    expect(
      ((await (await call(ft, 'GET', '/api/connections')).json()) as Record<string, unknown>).haToken,
    ).toBeUndefined();
    expect((await call(token, 'DELETE', '/api/owner/secrets/ha-token')).status).toBe(204);
    expect(((await (await call(token, 'GET', '/api/connections')).json()) as { haToken: unknown }).haToken).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('the Groq key is owner-only, host-only (DATA_DIR/secrets, 0600), verified, never read back', async () => {
    const good = `gsk_${'A1b2'.repeat(10)}`;
    const real = globalThis.fetch;
    let groqStatus = 200;
    let groqThrows = false;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('https://api.groq.com/')) {
        if (groqThrows) throw new Error('offline');
        return new Response('{}', { status: groqStatus });
      }
      return real(input, init);
    });
    try {
      const { token: ft } = await login(FRIEND_A);
      expect((await call(ft, 'PUT', '/api/owner/secrets/groq-key', { key: good })).status).toBe(403);
      const { token } = await login(OWNER);
      expect((await call(token, 'PUT', '/api/owner/secrets/groq-key', { key: 'nope' })).status).toBe(400);
      groqStatus = 401;
      expect((await call(token, 'PUT', '/api/owner/secrets/groq-key', { key: good })).status).toBe(400);
      groqStatus = 200;
      expect((await call(token, 'PUT', '/api/owner/secrets/groq-key', { key: good })).status).toBe(204);
      const file = path.join(TMP, 'data', 'secrets', 'groq_api_key');
      expect(fs.readFileSync(file, 'utf8').trim()).toBe(good);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      const text = await (await call(token, 'GET', '/api/connections')).text();
      expect(text).not.toContain(good);
      const st = JSON.parse(text) as { stt: { provider: string; groqKey: { source: string; savedAt: string } } };
      expect(st.stt.provider).toBe('groq');
      expect(st.stt.groqKey.source).toBe('miniapp');
      expect(Date.parse(st.stt.groqKey.savedAt)).toBeGreaterThan(0);
      expect(
        ((await (await call(ft, 'GET', '/api/connections')).json()) as Record<string, unknown>).stt,
      ).toBeUndefined();
      // network failure on verification: saved anyway
      groqThrows = true;
      expect((await call(token, 'PUT', '/api/owner/secrets/groq-key', { key: `gsk_${'Z9'.repeat(15)}` })).status).toBe(
        204,
      );
      expect((await call(token, 'DELETE', '/api/owner/secrets/groq-key')).status).toBe(204);
      expect(fs.existsSync(file)).toBe(false);
      const after = (await (await call(token, 'GET', '/api/connections')).json()) as {
        stt: { groqKey: unknown; provider: string };
      };
      expect(after.stt.groqKey).toBeNull();
      expect(after.stt.provider).toBe('none');
    } finally {
      spy.mockRestore();
    }
  });

  it('a server-provided Groq key is reported as such and survives DELETE', async () => {
    const srv = path.join(TMP, 'srv-groq');
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(srv, `gsk_${'S'.repeat(30)}\n`);
    process.env.NC_GROQ_KEY_FILE = srv;
    try {
      const { token } = await login(OWNER);
      expect((await call(token, 'DELETE', '/api/owner/secrets/groq-key')).status).toBe(204);
      const st = (await (await call(token, 'GET', '/api/connections')).json()) as {
        stt: { provider: string; groqKey: { source: string } };
      };
      expect(st.stt.provider).toBe('groq');
      expect(st.stt.groqKey.source).toBe('server');
    } finally {
      delete process.env.NC_GROQ_KEY_FILE;
    }
  });

  it('a friend cannot switch to residential egress unless the owner enabled it', async () => {
    process.env.NC_OWNER_CONNECTOR_SOCKS = '10.91.2.2:1055';
    const { token } = await login(FRIEND_A);
    expect((await call(token, 'PUT', '/api/egress', { route: 'residential' })).status).toBe(403);
    const { token: ot } = await login(OWNER);
    expect(
      (await call(ot, 'PATCH', `/api/owner/friends/telegram%3A${FRIEND_A}`, { egress: 'residential' })).status,
    ).toBe(204);
    expect((await call(token, 'PUT', '/api/egress', { route: 'residential' })).status).toBe(204);
    delete process.env.NC_OWNER_CONNECTOR_SOCKS;
  });
});

describe('product screens', () => {
  it('memory: the runtime scaffold (index.md, system/**) is not shown or counted as «Запомнил»', async () => {
    const dir = path.join(TMP, 'groups', 'fa', 'memory');
    fs.mkdirSync(path.join(dir, 'system'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.md'), '# index');
    fs.writeFileSync(path.join(dir, 'system', 'definition.md'), 'def');
    fs.writeFileSync(path.join(dir, 'system', 'index.md'), 'idx');
    fs.rmSync(path.join(dir, 'secret.md'));
    const { token } = await login(FRIEND_A);
    const tree = (await (await call(token, 'GET', '/api/memory')).json()) as { entries: unknown[] };
    expect(tree.entries).toEqual([]); // empty state shows
    const home = (await (await call(token, 'GET', '/api/home')).json()) as { recentMemory: unknown[] };
    expect(home.recentMemory).toEqual([]);
    fs.writeFileSync(path.join(dir, 'tea.md'), 'любит чай');
    const home2 = (await (await call(token, 'GET', '/api/home')).json()) as { recentMemory: Array<{ path: string }> };
    expect(home2.recentMemory.map((m) => m.path)).toEqual(['tea.md']);
  });

  it('skills: only what the user really has, in Russian, with the enabled chip (no locks)', async () => {
    const { updateContainerConfigJson, ensureContainerConfig } = await import('../../db/container-configs.js');
    await ensureContainerConfig('ag-fa');
    await updateContainerConfigJson('ag-fa', 'skills', ['agent-browser', 'self-customize']);
    const { token } = await login(FRIEND_A);
    const list = (await (await call(token, 'GET', '/api/skills')).json()) as Array<{
      id: string;
      name: string;
      enabled: boolean;
      locked: boolean;
    }>;
    expect(list).toEqual([
      expect.objectContaining({ id: 'agent-browser', name: 'Браузер', enabled: true, locked: false }),
    ]);
  });

  it('usage: stt is voice, agent is chat, task spend is task; voice minutes are reported; top conversations are titled', async () => {
    ng.usage.mockImplementation(async (q: { groupBy?: string }) => {
      if (q.groupBy === 'purpose')
        return {
          rows: [
            { key: 'agent', cost_micros: 2_000_000 },
            { key: 'stt', cost_micros: 100 },
            { key: 'task', cost_micros: 500_000 },
          ],
        };
      if (q.groupBy === 'session')
        return {
          rows: [
            { key: 's-fa-1', cost_micros: 1_500_000 },
            { key: 's-fb-1', cost_micros: 9_000_000 },
          ],
        };
      return { rows: [] };
    });
    await createSession({
      id: 's-fa-1',
      agent_group_id: 'ag-fa',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-10-05T10:00:00Z',
    });
    await createSession({
      id: 's-fb-1',
      agent_group_id: 'ag-fb',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-10-05T10:00:00Z',
    });
    const { recordVoice } = await import('../store.js');
    await recordVoice(`telegram:${FRIEND_A}`, 90);
    const { token } = await login(FRIEND_A);
    const u = (await (await call(token, 'GET', '/api/usage?days=14')).json()) as {
      byPurpose: Array<{ purpose: string; cost: { micros: number } }>;
      topTurns: Array<{ title: string }>;
      voiceSeconds: number;
    };
    const p = Object.fromEntries(u.byPurpose.map((x) => [x.purpose, x.cost.micros]));
    expect(p).toEqual({ chat: 2_000_000, voice: 100, task: 500_000 });
    expect(u.voiceSeconds).toBe(90);
    expect(u.topTurns.map((t) => t.title)).toEqual([expect.stringMatching(/^Разговор /)]); // the other tenant's session is never listed
  });

  it('resuming a task while the budget is exhausted is refused with the reset date', async () => {
    await createSession({
      id: 's-r',
      agent_group_id: 'ag-fa',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: new Date().toISOString(),
    });
    initSessionFolder('ag-fa', 's-r');
    const t = await createScheduledTask(
      'ag-fa',
      prepareScheduledTask({ name: 'x', prompt: 'p', recurrence: '0 9 * * *' }),
    );
    const id = t.row.seriesId ?? t.row.id;
    ng.budget.mockResolvedValue({
      limitMicros: 1,
      usedMicros: 1,
      reservedMicros: 0,
      periodStart: 0,
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'exhausted',
    });
    const { invalidateBudget } = await import('../budget.js');
    invalidateBudget();
    const { token } = await login(FRIEND_A);
    await call(token, 'POST', `/api/tasks/${id}/pause`);
    const r = await call(token, 'POST', `/api/tasks/${id}/resume`);
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('Лимит исчерпан');
  });

  it('system: the healthy owner connector is «ok» with a human label, errors are counted by class', async () => {
    process.env.NC_OWNER_CONNECTOR_SOCKS = '127.0.0.1:9';
    const { recordError } = await import('../alerts.js');
    await recordError('container', 's-1', 'boom');
    await recordError('gateway', 'nanogate');
    const { token } = await login(OWNER);
    const sys = (await (await call(token, 'GET', '/api/owner/system')).json()) as {
      connectors: Array<{ tenant: string; status: string }>;
      errors7d: number;
      errorsByClass: Record<string, number>;
    };
    expect(sys.errors7d).toBe(2);
    expect(sys.errorsByClass).toEqual({ container: 1, gateway: 1 });
    expect(sys.connectors[0].tenant).toContain('Домашняя сеть');
    expect(['ok', 'down']).toContain(sys.connectors[0].status); // never the raw word «configured»
    delete process.env.NC_OWNER_CONNECTOR_SOCKS;
  });
});

describe('settings validation', () => {
  it('validates and persists', async () => {
    const { token } = await login(FRIEND_A);
    expect((await call(token, 'PATCH', '/api/settings', { tz: 'Mars/Base' })).status).toBe(400);
    expect((await call(token, 'PATCH', '/api/settings', { preset: 'god' })).status).toBe(400);
    expect((await call(token, 'PATCH', '/api/settings', { quietHours: { from: '25:00', to: '08:00' } })).status).toBe(
      400,
    );
    const r = await call(token, 'PATCH', '/api/settings', {
      tz: 'Asia/Tbilisi',
      showSteps: false,
      quietHours: { from: '23:00', to: '08:00' },
    });
    expect(await r.json()).toMatchObject({
      tz: 'Asia/Tbilisi',
      showSteps: false,
      quietHours: { from: '23:00', to: '08:00' },
    });
  });
});

describe('static', () => {
  it('serves index with CSP and blocks traversal', async () => {
    fs.mkdirSync(path.join(TMP, 'static'), { recursive: true });
    fs.writeFileSync(path.join(TMP, 'static', 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(TMP, 'outside.txt'), 'nope');
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toContain("script-src 'self'");
    const t = await fetch(`${base}/..%2foutside.txt`);
    expect([403, 404]).toContain(t.status);
    expect((await fetch(`${base}/assets/x.js`)).status).toBe(404);
  });
});

describe('integration gaps', () => {
  it('memory titles come from frontmatter or the first H1, else the file name', async () => {
    const dir = path.join(TMP, 'groups', 'fa', 'memory');
    fs.writeFileSync(path.join(dir, 'fm.md'), '---\ntitle: "Рейсы в Тбилиси"\ntags: [a]\n---\n\n# Другой заголовок\n');
    fs.writeFileSync(path.join(dir, 'h1.md'), 'вступление\n\n# Любимые места\n\nтекст');
    fs.writeFileSync(path.join(dir, 'plain.md'), 'просто текст');
    const { token } = await login(FRIEND_A);
    const tree = (await (await call(token, 'GET', '/api/memory')).json()) as {
      entries: Array<{ path: string; title: string }>;
    };
    const t = Object.fromEntries(tree.entries.map((e) => [e.path, e.title]));
    expect(t['fm.md']).toBe('Рейсы в Тбилиси');
    expect(t['h1.md']).toBe('Любимые места');
    expect(t['plain.md']).toBe('plain');
    const home = (await (await call(token, 'GET', '/api/home')).json()) as {
      recentMemory: Array<{ path: string; title: string }>;
    };
    expect(home.recentMemory.find((m) => m.path === 'fm.md')?.title).toBe('Рейсы в Тбилиси');
  });

  it('usage: the cost of a scheduled-task session moves from «chat» to «task»', async () => {
    ng.usage.mockImplementation(async (q: { groupBy?: string }) => {
      if (q.groupBy === 'purpose') return { rows: [{ key: 'agent', cost_micros: 3_000_000 }] };
      if (q.groupBy === 'session') return { rows: [{ key: 's-task', cost_micros: 1_000_000 }] };
      return { rows: [] };
    });
    await createSession({
      id: 's-task',
      agent_group_id: 'ag-fa',
      messaging_group_id: null,
      thread_id: taskThreadId('abc'),
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-10-05T10:00:00Z',
    });
    const { token } = await login(FRIEND_A);
    const u = (await (await call(token, 'GET', '/api/usage?days=14')).json()) as {
      byPurpose: Array<{ purpose: string; cost: { micros: number } }>;
    };
    expect(Object.fromEntries(u.byPurpose.map((x) => [x.purpose, x.cost.micros]))).toEqual({
      chat: 2_000_000,
      task: 1_000_000,
    });
  });

  it('guest preview: owner only, validated, rate limited, same model path', async () => {
    const f = (await login(FRIEND_A)).token;
    expect((await call(f, 'POST', '/api/owner/guest/preview', { question: 'кто ты' })).status).toBe(403);
    const { token } = await login(OWNER);
    expect((await call(token, 'POST', '/api/owner/guest/preview', { question: '  ' })).status).toBe(400);
    expect((await call(token, 'POST', '/api/owner/guest/preview', { question: 'кто ты' })).status).toBe(400); // empty draft
    await call(token, 'PUT', '/api/owner/guest/draft', { markdown: 'Я Илья, разработчик.' });
    const r = await call(token, 'POST', '/api/owner/guest/preview', { question: 'кто ты', useDraft: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ answer: 'Ответ на: кто ты' });
    expect(previewGuestAnswer).toHaveBeenCalledWith('кто ты', 'Я Илья, разработчик.');
    let last = 200;
    for (let i = 0; i < 6; i++)
      last = (await call(token, 'POST', '/api/owner/guest/preview', { question: `q${i}` })).status;
    expect(last).toBe(429);
  });

  it('guest context carries maxChars', async () => {
    const { token } = await login(OWNER);
    const g = (await (await call(token, 'GET', '/api/owner/guest')).json()) as { maxChars: number };
    expect(g.maxChars).toBe(8000);
  });

  it('system: build id, deploy time and the last audit rows (no detail)', async () => {
    process.env.NANOCLAW_BUILD_ID = 'abc123def4567';
    process.env.NC_GRAFANA_URL = 'https://grafana.example.org/d/x';
    try {
      const { audit } = await import('../store.js');
      await audit('telegram:1', 'set_limit', 'telegram:2', { secret: 'x' });
      const { token } = await login(OWNER);
      const sys = (await (await call(token, 'GET', '/api/owner/system')).json()) as {
        buildId?: string;
        grafanaUrl?: string;
        recentAudit: Array<Record<string, unknown>>;
      };
      expect(sys.buildId).toBe('abc123def4567');
      expect(sys.grafanaUrl).toBe('https://grafana.example.org/d/x');
      expect(sys.recentAudit[0]).toMatchObject({ actor: 'telegram:1', action: 'set_limit', target: 'telegram:2' });
      expect(JSON.stringify(sys.recentAudit)).not.toContain('secret');
    } finally {
      delete process.env.NANOCLAW_BUILD_ID;
      delete process.env.NC_GRAFANA_URL;
    }
  });

  it('quiet hours: default 23:00-08:00 until the user turns them off; off survives and reaches the adapter', async () => {
    const { token } = await login(FRIEND_A);
    expect(await (await call(token, 'GET', '/api/settings')).json()).toMatchObject({
      quietHours: { from: '23:00', to: '08:00' },
    });
    const { getUserPrefs } = await import('../prefs.js');
    expect((await getUserPrefs(FRIEND_A)).quietHours).toEqual({ from: '23:00', to: '08:00' });
    await call(token, 'PATCH', '/api/settings', { quietHours: null });
    expect(await (await call(token, 'GET', '/api/settings')).json()).toMatchObject({ quietHours: null });
    expect((await getUserPrefs(FRIEND_A)).quietHours).toBeNull();
    await call(token, 'PATCH', '/api/settings', { quietHours: { from: '22:30', to: '07:00' } });
    expect((await getUserPrefs(FRIEND_A)).quietHours).toEqual({ from: '22:30', to: '07:00' });
  });

  it('the owner connection is marked server-managed', async () => {
    process.env.NC_OWNER_CONNECTOR_SOCKS = '10.91.2.2:1055';
    try {
      const { token } = await login(OWNER);
      const j = (await (await call(token, 'GET', '/api/connections')).json()) as {
        connections: Array<{ managed?: boolean }>;
      };
      expect(j.connections[0].managed).toBe(true);
    } finally {
      delete process.env.NC_OWNER_CONNECTOR_SOCKS;
    }
  });
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
