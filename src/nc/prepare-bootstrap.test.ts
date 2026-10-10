import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  getActiveContainerCount: vi.fn(() => 0),
  wakeContainer: vi.fn(),
}));

import { closeDb } from '../db/index.js';
import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { runHostPrepare } from '../host-lifecycle.js';
import './index.js';
import { OWNER, fakeNanogate, setupDb } from './test-helpers.js';

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  await setupDb();
  setNanogateAdminForTests(fakeNanogate());
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
});

it('owner bootstrap and DM wiring exist after host prepare, i.e. before inbound routing is released', async () => {
  expect(await getAgentGroupByFolder('owner')).toBeUndefined();
  await runHostPrepare({} as never);
  expect(await getAgentGroupByFolder('owner')).toBeDefined();
  expect(await getMessagingGroupByPlatform('telegram', `telegram:${OWNER}`)).toBeDefined();
});
