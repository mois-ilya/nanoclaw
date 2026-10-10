import fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = vi.hoisted(() => `/tmp/nc-life-${process.pid}`);
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: `${TMP}/data`, GROUPS_DIR: `${TMP}/groups`, TIMEZONE: 'UTC' };
});
const { killContainer } = vi.hoisted(() => ({ killContainer: vi.fn() }));
vi.mock('../container-runner.js', () => ({
  killContainer,
  isContainerRunning: vi.fn(() => false),
  getActiveContainerCount: vi.fn(() => 0),
}));

import { closeDb, createAgentGroup } from '../db/index.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { createSession } from '../db/sessions.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { deleteFriend, LifecycleError, pauseFriend, purgeDueTrash, resumeFriend } from './lifecycle.js';
import { sessions } from './miniapp/sessions.js';
import {
  getTenantByTg,
  insertTenantIfAbsent,
  putPrefs,
  retain,
  takeRetained,
  updateTenant,
  getPrefs,
} from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, groupUpdate, installFakeAdapter, setupDb } from './test-helpers.js';

let ng: ReturnType<typeof fakeNanogate>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  process.env.NC_TRASH_DIR = `${TMP}/trash`;
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  await setupDb();
  installFakeAdapter();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  await createAgentGroup({
    id: 'ag-a',
    name: 'a',
    folder: 'f-a',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createSession({
    id: 's-a',
    agent_group_id: 'ag-a',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  fs.mkdirSync(`${TMP}/groups/f-a/memory`, { recursive: true });
  fs.writeFileSync(`${TMP}/groups/f-a/memory/x.md`, 'm');
  fs.mkdirSync(`${TMP}/data/v2-sessions/ag-a/s-a`, { recursive: true });
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
  await updateTenant(FRIEND_A, { agent_group_id: 'ag-a', limit_usd_micros: 10_000_000 });
});
afterEach(async () => {
  delete process.env.NC_TRASH_DIR;
  setNanogateAdminForTests(null);
  await closeDb();
});

describe('lifecycle', () => {
  it('pause stops spend, containers and Mini App sessions; resume reactivates (no terminal revoke)', async () => {
    const tok = sessions.create({ tgId: FRIEND_A, userId: `telegram:${FRIEND_A}`, epoch: 1 });
    await pauseFriend(FRIEND_A, 'owner');
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('paused');
    expect(ng.pauseTenant).toHaveBeenCalledWith(`telegram:${FRIEND_A}`);
    expect(ng.revokeTenant).not.toHaveBeenCalled();
    expect(killContainer).toHaveBeenCalledWith('s-a', 'tenant-paused');
    expect(sessions.get(tok.token)).toBeNull();

    await resumeFriend(FRIEND_A, 'owner');
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('ready');
    expect(ng.putTenant).toHaveBeenCalledWith(`telegram:${FRIEND_A}`, expect.objectContaining({ status: 'active' }));
  });

  it('the owner tenant cannot be paused or deleted through lifecycle', async () => {
    await insertTenantIfAbsent({ tgId: OWNER, name: 'Илья', state: 'ready' });
    await expect(pauseFriend(OWNER, 'x')).rejects.toBeInstanceOf(LifecycleError);
    await expect(deleteFriend(OWNER, 'x')).rejects.toBeInstanceOf(LifecycleError);
  });

  it('pause from a non-ready state is a conflict', async () => {
    await updateTenant(FRIEND_A, { state: 'provisioning' });
    await expect(pauseFriend(FRIEND_A, 'o')).rejects.toBeInstanceOf(LifecycleError);
  });

  it('delete: revokes at nanogate, removes rows, moves dirs to trash, wipes prefs/retained, keeps a closed tombstone; purge honours retention and path', async () => {
    await putPrefs(`telegram:${FRIEND_A}`, {
      lang: 'ru',
      tz: 'UTC',
      preset: 'normal',
      quiet_from: null,
      quiet_to: null,
      show_steps: true,
    });
    await retain(FRIEND_A, JSON.stringify(groupUpdate(FRIEND_A, 'x')));
    await deleteFriend(FRIEND_A, 'owner');

    const t = (await getTenantByTg(FRIEND_A))!;
    expect(t.state).toBe('deleted');
    expect(t.agent_group_id).toBeNull();
    expect(t.epoch).toBe(2);
    expect(ng.revokeTenant).toHaveBeenCalled();
    expect(await getAgentGroup('ag-a')).toBeUndefined();
    expect(fs.existsSync(`${TMP}/groups/f-a`)).toBe(false);
    expect(fs.existsSync(`${TMP}/data/v2-sessions/ag-a`)).toBe(false);
    expect(fs.readdirSync(`${TMP}/trash`).length).toBe(2);
    expect(await takeRetained(FRIEND_A)).toHaveLength(0);
    expect((await getPrefs(`telegram:${FRIEND_A}`, { tz: 'X' })).tz).toBe('X'); // defaults again = row gone

    expect(await purgeDueTrash()).toBe(0); // not due
    expect(await purgeDueTrash(Date.now() + 31 * 86_400_000)).toBe(2);
    expect(fs.readdirSync(`${TMP}/trash`).length).toBe(0);
  });
});

describe('re-admitting a deleted friend', () => {
  it('a new life uses a new nanogate tenant id (revoke is terminal), the old id is never reused', async () => {
    const { pushTenant, nanogatePolicy } = await import('./tenants.js');
    const { gateIdOf } = await import('./store.js');
    await deleteFriend(FRIEND_A, 'owner');
    expect(ng.revokeTenant).toHaveBeenCalledWith(`telegram:${FRIEND_A}`);
    const t = (await getTenantByTg(FRIEND_A))!;
    expect(gateIdOf(t)).toBe(`telegram:${FRIEND_A}.e2`);
    expect(t.denied_until).toBeTruthy(); // cooldown before they can ask again
    await updateTenant(FRIEND_A, { state: 'ready', agent_group_id: 'ag-a' });
    await pushTenant((await getTenantByTg(FRIEND_A))!);
    expect(ng.putTenant).toHaveBeenLastCalledWith(`telegram:${FRIEND_A}.e2`, expect.anything());
    void nanogatePolicy;
  });
  it('tgIdOfUserId understands versioned ids (budget events keep working)', async () => {
    const { tgIdOfUserId } = await import('./config.js');
    expect(tgIdOfUserId(`telegram:${FRIEND_A}.e3`)).toBe(FRIEND_A);
    expect(tgIdOfUserId(`telegram:${FRIEND_A}`)).toBe(FRIEND_A);
    expect(tgIdOfUserId('telegram:abc')).toBeNull();
  });
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
