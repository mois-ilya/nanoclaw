import fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = vi.hoisted(() => `/tmp/nc-prov-${process.pid}`);
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: `${TMP}/data`, GROUPS_DIR: `${TMP}/groups`, TIMEZONE: 'UTC' };
});
const { initGroupFilesystem, routeInbound } = vi.hoisted(() => ({
  initGroupFilesystem: vi.fn(async (_g: { id: string }, _o?: { instructions?: string }) => undefined),
  routeInbound: vi.fn(async (_e: { message: { id: string; content: string } }) => undefined),
}));
vi.mock('../group-init.js', async () => {
  const { ensureContainerConfig } = await import('../db/container-configs.js');
  return {
    initGroupFilesystem: async (g: { id: string }, o?: { instructions?: string }) => {
      await ensureContainerConfig(g.id);
      return initGroupFilesystem(g, o);
    },
  };
});
vi.mock('../router.js', () => ({ routeInbound }));
vi.mock('../container-runner.js', () => ({
  killContainer: vi.fn(),
  isContainerRunning: vi.fn(() => false),
  getActiveContainerCount: vi.fn(() => 0),
}));

import { closeDb } from '../db/index.js';
import { getContainerConfig } from '../db/container-configs.js';
import { getMessagingGroupByPlatform, getMessagingGroupAgents } from '../db/messaging-groups.js';
import { getAllAgentGroups } from '../db/agent-groups.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { runProvisionJob, startProvisioning, retryProvisioning } from './provision.js';
import { approveRequest } from './decisions.js';
import {
  createRequest,
  getTenantByTg,
  insertTenantIfAbsent,
  retain,
  setRequestCard,
  takeRetained,
  listJobs,
} from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, groupUpdate, installFakeAdapter, setupDb } from './test-helpers.js';

let fake: ReturnType<typeof installFakeAdapter>;
let ng: ReturnType<typeof fakeNanogate>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  fs.rmSync(TMP, { recursive: true, force: true });
  await setupDb();
  fake = installFakeAdapter();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', username: 'm', state: 'pending' });
  await retain(FRIEND_A, JSON.stringify(groupUpdate(FRIEND_A, 'первое сообщение', 11)));
  await retain(FRIEND_A, JSON.stringify(groupUpdate(FRIEND_A, 'второе', 12)));
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const jobs = await listJobs(['pending', 'running']);
    if (jobs.length === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('provisioning', () => {
  it('approve -> group, config, member, wiring, nanogate, ready, welcome, replay once, card edit', async () => {
    const req = await createRequest(FRIEND_A, 'первое сообщение');
    await setRequestCard(req.id, 55);
    expect(await approveRequest(req.id, 10_000_000, 'owner')).toBe('ok');
    await settle();

    const t = (await getTenantByTg(FRIEND_A))!;
    expect(t.state).toBe('ready');
    expect(t.agent_group_id).toBeTruthy();
    const ag = (await getAllAgentGroups()).find((g) => g.id === t.agent_group_id)!;
    expect(ag.folder).toBe(`f-${FRIEND_A}`);
    const cfg = (await getContainerConfig(ag.id))!;
    expect(cfg.cli_scope).toBe('group');
    expect(JSON.parse(cfg.skills)).toEqual(['agent-browser']); // the host sends the welcome itself; the upstream welcome skill advertises owner-only powers
    expect(await isMember(`telegram:${FRIEND_A}`, ag.id)).toBe(true);
    const mg = (await getMessagingGroupByPlatform('telegram', `telegram:${FRIEND_A}`))!;
    expect(mg.unknown_sender_policy).toBe('strict');
    const wirings = await getMessagingGroupAgents(mg.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({ sender_scope: 'known', engage_pattern: '.' });
    expect(ng.putTenant).toHaveBeenCalledWith(
      `telegram:${FRIEND_A}`,
      expect.objectContaining({ kind: 'friend', budgetLimitMicros: 10_000_000 }),
    );
    expect(initGroupFilesystem.mock.calls[0][1]?.instructions).toContain('Маша');
    // welcome with the privacy line, once
    const welcomes = fake.sent.filter((s) => s.chatId === FRIEND_A);
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].md).toContain('не читает через бота');
    // retained messages replayed exactly once, in order, then gone
    expect(routeInbound).toHaveBeenCalledTimes(2);
    expect(JSON.parse(routeInbound.mock.calls[0][0].message.content).text).toBe('первое сообщение');
    expect(routeInbound.mock.calls[0][0].message.id).toBe(`tg:${FRIEND_A}:11`);
    expect(await takeRetained(FRIEND_A)).toHaveLength(0);
    expect(fake.edited.some((e) => e.messageId === 55 && e.md.includes('принят'))).toBe(true);
  });

  it('a failure keeps the retained messages, marks failed, tells the owner; retry resumes without duplicates', async () => {
    ng.putTenant.mockRejectedValueOnce(new Error('nanogate down'));
    expect(await startProvisioning(FRIEND_A, 10_000_000, 'owner')).toBe(true);
    await settle();
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('provisioning_failed');
    expect(await takeRetained(FRIEND_A)).toHaveLength(2);
    expect(routeInbound).not.toHaveBeenCalled();
    const alert = fake.sent.find((s) => s.chatId === OWNER)!;
    expect(alert).toBeTruthy();
    expect(alert.md).toContain('Не удалось');
    expect(alert.buttons!.flat()[0].data).toBe(`p:rt:${FRIEND_A}`);

    expect(await retryProvisioning(FRIEND_A)).toBe(true);
    await settle();
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('ready');
    expect((await getAllAgentGroups()).filter((g) => g.folder.startsWith('f-'))).toHaveLength(1); // no second group
    expect(routeInbound).toHaveBeenCalledTimes(2);
  });

  it('a second start while provisioning is a no-op (double approve)', async () => {
    expect(await startProvisioning(FRIEND_A, 1, 'o')).toBe(true);
    expect(await startProvisioning(FRIEND_A, 1, 'o')).toBe(false);
    await settle();
  });

  it('re-running a finished job never re-sends the welcome', async () => {
    await startProvisioning(FRIEND_A, 1, 'o');
    await settle();
    const done = (await import('./store.js')).upsertJob;
    const job = await done('provision', String(FRIEND_A));
    await runProvisionJob({ ...job, step: 'welcome' });
    expect(fake.sent.filter((s) => s.chatId === FRIEND_A)).toHaveLength(1);
  });
});

describe('replay of what was sent before approval', () => {
  const voice = (id: number): unknown => ({
    update_id: id,
    message: {
      message_id: id,
      date: 1_800_000_000,
      chat: { id: FRIEND_A, type: 'private' },
      from: { id: FRIEND_A, is_bot: false, first_name: 'Маша' },
      voice: { file_id: 'f', duration: 5 },
    },
  });

  it('voice and photos go through the adapter pipeline (download, transcribe, onInbound) when it can replay', async () => {
    const replay = vi.fn(async (_u: unknown) => undefined);
    fake = installFakeAdapter({ replay });
    await retain(FRIEND_A, JSON.stringify(voice(13)));
    await startProvisioning(FRIEND_A, 1, 'o');
    await settle();
    expect(replay).toHaveBeenCalledTimes(3); // 2 texts + 1 voice, in order
    expect((replay.mock.calls[2][0] as { update_id: number }).update_id).toBe(13);
    expect(routeInbound).not.toHaveBeenCalled(); // the adapter routes, not us
    expect(fake.sent.some((s) => s.chatId === FRIEND_A && s.md.includes('ещё раз'))).toBe(false);
  });

  it('without an adapter pipeline a voice is not silently lost: the friend is asked to resend', async () => {
    await retain(FRIEND_A, JSON.stringify(voice(13)));
    await startProvisioning(FRIEND_A, 1, 'o');
    await settle();
    expect(routeInbound).toHaveBeenCalledTimes(2); // the texts
    expect(fake.sent.some((s) => s.chatId === FRIEND_A && s.md.includes('Пришли, пожалуйста, ещё раз'))).toBe(true);
  });

  it('a bare /start is not replayed', async () => {
    const replay = vi.fn(async (_u: unknown) => undefined);
    fake = installFakeAdapter({ replay });
    await retain(FRIEND_A, JSON.stringify(groupUpdate(FRIEND_A, '/start', 14)));
    await startProvisioning(FRIEND_A, 1, 'o');
    await settle();
    expect(replay).toHaveBeenCalledTimes(2);
  });
});

describe('a failure after the ready step', () => {
  it('stays retryable: «Повторить» resumes from the failed step and the friend is welcomed', async () => {
    const welcomeFail = vi.spyOn((await import('./port.js')).tg, 'sendProduct');
    welcomeFail.mockRejectedValueOnce(new Error('403 blocked')); // the welcome
    expect(await startProvisioning(FRIEND_A, 1, 'owner')).toBe(true);
    await settle();
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('ready'); // already past 'ready'
    const failed = (await listJobs(['failed'])).find((j) => j.kind === 'provision');
    expect(failed?.step).toBe('welcome');
    welcomeFail.mockRestore();
    expect(await retryProvisioning(FRIEND_A)).toBe(true);
    await settle();
    expect((await listJobs(['failed'])).length).toBe(0);
    expect(fake.sent.some((s) => s.chatId === FRIEND_A && s.md.includes('Привет'))).toBe(true);
    expect(routeInbound).toHaveBeenCalledTimes(2);
  });
  it('nothing to retry when no job failed', async () => {
    await startProvisioning(FRIEND_A, 1, 'o');
    await settle();
    expect(await retryProvisioning(FRIEND_A)).toBe(false);
  });
});

describe('owner egress default', () => {
  it('follows the connector on every boot until the owner chooses a route', async () => {
    process.env.NC_OWNER_CONNECTOR_SOCKS = '127.0.0.1:1055';
    const { bootstrapOwner } = await import('./tenants.js');
    const { updateTenant, kvSet } = await import('./store.js');
    await bootstrapOwner(); // first boot, connector already there
    expect((await getTenantByTg(OWNER))?.egress).toBe('residential');
    await updateTenant(OWNER, { egress: 'direct' }); // e.g. the tenant predates the connector
    await bootstrapOwner();
    expect((await getTenantByTg(OWNER))?.egress).toBe('residential');
    await updateTenant(OWNER, { egress: 'direct' });
    await kvSet('egress-chosen:owner', '1'); // the owner picked «Напрямую» in Кабинет
    await bootstrapOwner();
    expect((await getTenantByTg(OWNER))?.egress).toBe('direct');
    delete process.env.NC_OWNER_CONNECTOR_SOCKS;
  });
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
