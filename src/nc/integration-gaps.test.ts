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
import { ensureDmWiring } from './tenants.js';
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
