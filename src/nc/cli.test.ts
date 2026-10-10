/** The agent-facing `ncl` commands, end to end through the real dispatcher and guard. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({ isContainerRunning: vi.fn(() => false), killContainer: vi.fn() }));

import { createAgentGroup, closeDb } from '../db/index.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import '../cli/commands/index.js';
import { dispatch } from '../cli/dispatch.js';
import { setGroupResourceFilter } from '../cli/guard.js';
import { installPlatformLayer } from './platform.js';
import { getPrefs, insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, OWNER, installFakeAdapter, setupDb } from './test-helpers.js';

const agent = (g: string) => ({ caller: 'agent' as const, sessionId: 's', agentGroupId: g, messagingGroupId: 'mg' });
const run = (g: string, command: string, args: Record<string, unknown> = {}) =>
  dispatch({ id: '1', command, args }, agent(g));

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  await setupDb();
  installFakeAdapter();
  installPlatformLayer();
  for (const [tg, g] of [
    [OWNER, 'ag-o'],
    [FRIEND_A, 'ag-f'],
  ] as const) {
    await insertTenantIfAbsent({ tgId: tg, name: tg === OWNER ? 'Илья' : 'Маша', state: 'ready' });
    await updateTenant(tg, { agent_group_id: g });
    await createAgentGroup({ id: g, name: g, folder: g, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(g);
  }
  await updateContainerConfigScalars('ag-f', { cli_scope: 'group' });
  await updateContainerConfigScalars('ag-o', { cli_scope: 'global' });
});
afterEach(async () => {
  setGroupResourceFilter(null);
  await closeDb();
});

describe('ncl as the agent sees it', () => {
  it('a friend can set their own timezone without an approval card', async () => {
    const r = await run('ag-f', 'me-set-timezone', { timezone: 'Asia/Tbilisi' });
    expect(r.ok).toBe(true);
    expect((await getPrefs(`telegram:${FRIEND_A}`, { tz: 'X' })).tz).toBe('Asia/Tbilisi');
    expect((await getContainerConfig('ag-f'))?.timezone).toBe('Asia/Tbilisi');
  });

  it('a friend is limited to tasks and me: groups, sessions, members are refused', async () => {
    for (const cmd of ['groups-list', 'sessions-list', 'members-list', 'destinations-list']) {
      const r = await run('ag-f', cmd);
      expect(r.ok, cmd).toBe(false);
    }
    expect((await run('ag-f', 'tasks-list')).ok).toBe(true);
  });

  it('the owner agent keeps the full CLI and may use guest-append', async () => {
    expect((await run('ag-o', 'groups-list')).ok).toBe(true);
    expect((await run('ag-o', 'guest-append', { text: 'любит чай' })).ok).toBe(true);
  });

  it('a friend cannot run guest-append', async () => {
    const r = await run('ag-f', 'guest-append', { text: 'x' });
    expect(r.ok).toBe(false);
  });
});
