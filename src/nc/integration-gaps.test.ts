/** Wiring checked by the integration pass: adapter binding, per-tenant runner env, DM destination name. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  getActiveContainerCount: vi.fn(() => 0),
  wakeContainer: vi.fn(),
}));

import { createAgentGroup, closeDb } from '../db/index.js';
import { getDestinations } from '../modules/agent-to-agent/db/agent-destinations.js';
import { sessionEnvFor, setSessionEnvProvider } from '../session-env.js';
import * as adapter from '../channels/telegram/adapter/index.js';
import { bindAdapter } from './bind.js';
import { loadBudgetNotes } from './budget.js';
import { insertTenantIfAbsent, kvSet } from './store.js';
import { sessionEnvFor as ncSessionEnv, installPlatformLayer } from './platform.js';
import { ensureDmWiring, upgradeDmWirings } from './tenants.js';
import { dmSession } from './chat.js';
import { updateMessagingGroupAgent } from '../db/messaging-groups.js';
import { updateTenant } from './store.js';
import { canReplay } from './port.js';
import { OWNER, FRIEND_A, setupDb } from './test-helpers.js';

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  await setupDb();
});
afterEach(async () => {
  setSessionEnvProvider(undefined);
  await closeDb();
});

describe('binding to the Telegram adapter', () => {
  it('exports replayPrivateUpdate, so the port can replay retained voice/photos', () => {
    expect(typeof adapter.replayPrivateUpdate).toBe('function');
    bindAdapter();
    expect(canReplay()).toBe(true);
  });

  it('the 80% budget note carries the «Подробнее» Mini App button', async () => {
    bindAdapter();
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await kvSet(
      `budget-note:${FRIEND_A}`,
      JSON.stringify({ text: '80% лимита использовано', until: Date.now() + 86_400_000 }),
    );
    await loadBudgetNotes();
    const { getHooks } = await import('../channels/telegram/adapter/hooks.js');
    expect(await getHooks().budgetNote!(FRIEND_A)).toEqual({
      text: '80% лимита использовано',
      button: { text: 'Подробнее', webApp: 'usage' },
    });
    expect(await getHooks().budgetNote!(FRIEND_A)).toBeNull(); // one-shot
  });
});

describe('per-tenant runner env', () => {
  it('friends get 10 minutes per turn, the owner 30', async () => {
    installPlatformLayer();
    expect(sessionEnvFor({ id: 'ag-friend' })).toEqual({ NC_TURN_TIMEOUT_MS: String(10 * 60_000) });
    expect(ncSessionEnv({ id: 'ag-friend' }).NC_TURN_TIMEOUT_MS).toBe('600000');
  });

  it('the limits are tunable', () => {
    process.env.NC_TURN_TIMEOUT_FRIEND_MS = '120000';
    try {
      expect(ncSessionEnv({ id: 'x' }).NC_TURN_TIMEOUT_MS).toBe('120000');
    } finally {
      delete process.env.NC_TURN_TIMEOUT_FRIEND_MS;
    }
  });
});

describe('DM wiring', () => {
  it('drops wiring to other agent groups left on the same DM (reused database)', async () => {
    const mk = (id: string) => ({
      id,
      name: id,
      folder: id,
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    await createAgentGroup(mk('ag-old'));
    await createAgentGroup(mk('ag-new'));
    const mg = await ensureDmWiring(FRIEND_A, 'Маша', mk('ag-old') as never);
    await ensureDmWiring(FRIEND_A, 'Маша', mk('ag-new') as never);
    const { getMessagingGroupAgents } = await import('../db/messaging-groups.js');
    expect((await getMessagingGroupAgents(mg.id)).map((w) => w.agent_group_id)).toEqual(['ag-new']);
  });
});

describe('DM wiring is per-thread (private-chat topics)', () => {
  const mk = (id: string) => ({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });

  it('a new DM wiring is per-thread with threads on', async () => {
    const ag = mk('ag-topics');
    await createAgentGroup(ag);
    const mg = await ensureDmWiring(FRIEND_A, 'Маша', ag as never);
    const { getMessagingGroupAgents } = await import('../db/messaging-groups.js');
    const [w] = await getMessagingGroupAgents(mg.id);
    expect(w).toMatchObject({ session_mode: 'per-thread', threads: 1 });
  });

  it('an existing shared wiring is upgraded (ensureDmWiring and the boot-time sweep)', async () => {
    const ag = mk('ag-old-shared');
    await createAgentGroup(ag);
    const mg = await ensureDmWiring(FRIEND_A, 'Маша', ag as never);
    const { getMessagingGroupAgents } = await import('../db/messaging-groups.js');
    const old = async () => {
      const [w] = await getMessagingGroupAgents(mg.id);
      await updateMessagingGroupAgent(w.id, { session_mode: 'shared', threads: 0 });
    };
    await old();
    await ensureDmWiring(FRIEND_A, 'Маша', ag as never);
    expect((await getMessagingGroupAgents(mg.id))[0]).toMatchObject({ session_mode: 'per-thread', threads: 1 });

    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: ag.id });
    await old();
    expect(await upgradeDmWirings()).toBe(1);
    expect((await getMessagingGroupAgents(mg.id))[0]).toMatchObject({ session_mode: 'per-thread', threads: 1 });
    expect(await upgradeDmWirings()).toBe(0); // idempotent
  });

  it('every topic has its own session; thread null is the general conversation', async () => {
    const ag = mk('ag-sessions');
    await createAgentGroup(ag);
    await ensureDmWiring(FRIEND_A, 'Маша', ag as never);
    const t = { tg_id: FRIEND_A, agent_group_id: ag.id };
    const general = await dmSession(t, true);
    const topic7 = await dmSession(t, true, '7');
    const topic8 = await dmSession(t, true, '8');
    expect(general?.thread_id).toBeNull();
    expect(topic7?.thread_id).toBe('7');
    expect(new Set([general?.id, topic7?.id, topic8?.id]).size).toBe(3);
    expect((await dmSession(t, true, '7'))?.id).toBe(topic7?.id);
    expect((await dmSession(t, false))?.id).toBe(general?.id);
  });
});

describe('DM destination name', () => {
  it('a Cyrillic display name still gives the agent the stable ASCII destination «dm»', async () => {
    const ag = {
      id: 'ag-cyr',
      name: 'Маша',
      folder: 'masha',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    await createAgentGroup(ag);
    await ensureDmWiring(FRIEND_A, 'Маша', ag as never);
    const dests = await getDestinations('ag-cyr');
    expect(dests.map((d) => d.local_name)).toEqual(['dm']);
    await ensureDmWiring(FRIEND_A, 'Маша', ag as never); // idempotent
    expect((await getDestinations('ag-cyr')).map((d) => d.local_name)).toEqual(['dm']);
  });
});
