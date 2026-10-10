import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { injectChat } = vi.hoisted(() => ({ injectChat: vi.fn(async (..._a: unknown[]) => undefined) }));
vi.mock('./chat.js', () => ({ injectChat, dmSession: vi.fn(), killGroupContainers: vi.fn() }));

import { closeDb, createAgentGroup } from '../db/index.js';
import { createSession } from '../db/sessions.js';
import { stopHandler } from './stop.js';
import { insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, FRIEND_B, setupDb } from './test-helpers.js';

async function sess(gid: string, id: string): Promise<void> {
  await createAgentGroup({
    id: gid,
    name: gid,
    folder: gid,
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createSession({
    id,
    agent_group_id: gid,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
}

beforeEach(async () => {
  await setupDb();
  vi.clearAllMocks();
  await sess('ag-a', 's-a');
  await sess('ag-b', 's-b');
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'A', state: 'ready' });
  await updateTenant(FRIEND_A, { agent_group_id: 'ag-a' });
});
afterEach(closeDb);

describe('stopHandler', () => {
  it('stops the chat tenant own session', async () => {
    await stopHandler({ chatId: FRIEND_A, sessionId: 's-a', turnId: 't' });
    expect(injectChat).toHaveBeenCalledTimes(1);
    expect(injectChat.mock.calls[0][2]).toBe('/stop');
  });
  it('ignores a session of another tenant, an unknown chat and non-ready tenants', async () => {
    await stopHandler({ chatId: FRIEND_A, sessionId: 's-b', turnId: 't' });
    await stopHandler({ chatId: FRIEND_B, sessionId: 's-a', turnId: 't' });
    await updateTenant(FRIEND_A, { state: 'paused' });
    await stopHandler({ chatId: FRIEND_A, sessionId: 's-a', turnId: 't' });
    expect(injectChat).not.toHaveBeenCalled();
  });
});
