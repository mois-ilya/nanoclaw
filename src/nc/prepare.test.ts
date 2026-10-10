/** A host restart must adopt running sessions: the tenant map has to be loaded BEFORE adoption. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  getActiveContainerCount: vi.fn(() => 0),
  killContainer: vi.fn(),
  wakeContainer: vi.fn(),
}));

import { closeDb } from '../db/index.js';
import { runHostPrepare } from '../host-lifecycle.js';
import './index.js';
import { forgetGroupTenant, resolveTenant } from './tenants.js';
import { insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, OWNER, setupDb } from './test-helpers.js';

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  await setupDb();
});
afterEach(closeDb);

describe('prepare phase (before adoption)', () => {
  it('maps agent groups to nanogate tenants so an adopted session is not rejected as tenant_not_found', async () => {
    await insertTenantIfAbsent({ tgId: OWNER, name: 'Илья', state: 'ready' });
    await updateTenant(OWNER, { agent_group_id: 'ag-owner' });
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-f', epoch: 2 });
    forgetGroupTenant('ag-owner');
    forgetGroupTenant('ag-f');
    expect(resolveTenant('ag-owner').tenantId).toBe('ag-owner'); // the pre-fix state: unmapped
    await runHostPrepare({
      db: undefined as never,
      deliveryAdapter: undefined as never,
      signal: new AbortController().signal,
    });
    expect(resolveTenant('ag-owner')).toEqual({ tenantId: `telegram:${OWNER}`, kind: 'owner' });
    expect(resolveTenant('ag-f')).toEqual({ tenantId: `telegram:${FRIEND_A}.e2`, kind: 'friend' });
  });
});
