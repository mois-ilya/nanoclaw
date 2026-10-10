import fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = vi.hoisted(() => `/tmp/nc-aa-${process.pid}`);
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: `${TMP}/data`, GROUPS_DIR: `${TMP}/groups`, TIMEZONE: 'UTC' };
});
const { rearm } = vi.hoisted(() => ({ rearm: vi.fn(async () => 1) }));
vi.mock('./tasks.js', async () => ({ ...(await vi.importActual<object>('./tasks.js')), rearmRecurring: rearm }));

import { closeDb } from '../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../db/container-configs.js';
import { appendGuestDraft, setTimezoneForGroup } from './agent-actions.js';
import { friendCliResources, installPlatformLayer } from './platform.js';
import { agentsCreate } from '../modules/agent-to-agent/guard.js';
import { getDraft } from './guest-store.js';
import { getPrefs, insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, OWNER, installFakeAdapter, setupDb } from './test-helpers.js';

let fake: ReturnType<typeof installFakeAdapter>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  await setupDb();
  fake = installFakeAdapter();
  for (const [tg, g] of [
    [OWNER, 'ag-o'],
    [FRIEND_A, 'ag-f'],
  ] as const) {
    await insertTenantIfAbsent({ tgId: tg, name: tg === OWNER ? 'Илья' : 'Маша', state: 'ready' });
    await updateTenant(tg, { agent_group_id: g });
  }
  const { createAgentGroup } = await import('../db/index.js');
  for (const g of ['ag-o', 'ag-f']) {
    await createAgentGroup({ id: g, name: g, folder: g, agent_provider: null, created_at: new Date().toISOString() });
    await ensureContainerConfig(g);
  }
});
afterEach(closeDb);
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('ncl me set-timezone', () => {
  it('writes prefs and the group config and re-arms recurring tasks', async () => {
    await setTimezoneForGroup('ag-f', 'Asia/Tbilisi');
    expect((await getPrefs(`telegram:${FRIEND_A}`, { tz: 'X' })).tz).toBe('Asia/Tbilisi');
    expect((await getContainerConfig('ag-f'))?.timezone).toBe('Asia/Tbilisi');
    expect(rearm).toHaveBeenCalledWith('ag-f', 'Asia/Tbilisi');
  });
  it('rejects an unknown zone and a group without a tenant', async () => {
    await expect(setTimezoneForGroup('ag-f', 'Mars/Base')).rejects.toThrow(/unknown timezone/);
    await expect(setTimezoneForGroup('ag-none', 'UTC')).rejects.toThrow(/no tenant/);
  });
});

describe('ncl guest append', () => {
  it('owner only: facts go to the DRAFT and the owner gets the «Открыть «Гость»» confirmation', async () => {
    const r = await appendGuestDraft('ag-o', '- живу в Тбилиси\nлюблю чай');
    expect(r.added).toBe(2);
    expect(await getDraft()).toBe('- живу в Тбилиси\n- люблю чай\n');
    const m = fake.sent.at(-1)!;
    expect(m.chatId).toBe(OWNER);
    expect(m.md).toContain('Добавил в гостевой черновик (2 факта)');
    expect(m.buttons!.flat()[0].webApp).toBe('guest');
  });
  it('a friend agent cannot touch it', async () => {
    await expect(appendGuestDraft('ag-f', 'x')).rejects.toThrow(/only the owner/);
    expect(await getDraft()).toBe('');
  });
});

describe('friend CLI scope', () => {
  it('friends are narrowed to tasks and their own settings; the owner is not narrowed', async () => {
    expect([...(await friendCliResources('ag-f'))!].sort()).toEqual(['me', 'tasks']);
    expect(await friendCliResources('ag-o')).toBeNull();
    expect(await friendCliResources('ag-unknown')).toBeNull();
  });
});

describe('create_agent veto', () => {
  it('a friend agent cannot even ask the owner to create an agent group; the owner agent still can', async () => {
    installPlatformLayer();
    const input = (agentGroupId: string) =>
      ({ actor: { kind: 'agent', agentGroupId }, payload: { name: 'x' } }) as never;
    expect((await agentsCreate.decide(input('ag-f'))).effect).toBe('deny');
    expect((await agentsCreate.decide(input('ag-o'))).effect).not.toBe('deny');
  });
});

describe('applyTimezone keeps the owner on the deep preset', () => {
  it('the first prefs write for the owner stores deep, not normal', async () => {
    const { applyTimezone } = await import('./settings.js');
    await applyTimezone({ user_id: `telegram:${OWNER}`, agent_group_id: 'ag-o' }, 'Asia/Tbilisi');
    expect((await getPrefs(`telegram:${OWNER}`, { tz: 'UTC' })).preset).toBe('deep');
    await applyTimezone({ user_id: `telegram:${FRIEND_A}`, agent_group_id: 'ag-f' }, 'Asia/Tbilisi');
    expect((await getPrefs(`telegram:${FRIEND_A}`, { tz: 'UTC' })).preset).toBe('normal');
  });
});
