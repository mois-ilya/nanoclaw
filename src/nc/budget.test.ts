import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pauseAllTasks, resumeAllTasks, hasSystemPaused } = vi.hoisted(() => ({
  pauseAllTasks: vi.fn(async () => 1),
  resumeAllTasks: vi.fn(async () => ({ resumed: 1, skipped: [] as string[] })),
  hasSystemPaused: vi.fn(async () => false),
}));
vi.mock('./tasks.js', () => ({ pauseAllTasks, resumeAllTasks, hasSystemPaused }));

import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import {
  consumeBudgetNote,
  globalCapUntil,
  handleBudgetEvent,
  loadGlobalCap,
  resetGlobalCapForTests,
  inQuietHours,
  loadBudgetNotes,
  pollBudgetEventsOnce,
  resumeBudgetPausedTasks,
} from './budget.js';
import { getPrefs, insertTenantIfAbsent, kvGet, kvSet, putPrefs, updateTenant } from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, installFakeAdapter, setupDb } from './test-helpers.js';

let fake: ReturnType<typeof installFakeAdapter>;
let ng: ReturnType<typeof fakeNanogate>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  resetGlobalCapForTests();
  await setupDb();
  fake = installFakeAdapter();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
  await updateTenant(FRIEND_A, { agent_group_id: 'ag-1', limit_usd_micros: 10_000_000 });
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
});

describe('budget events', () => {
  it('budget_80 arms a one-shot note and sends nothing', async () => {
    await handleBudgetEvent({ tenantId: `telegram:${FRIEND_A}`, type: 'budget_80' });
    expect(fake.sent).toHaveLength(0);
    expect(consumeBudgetNote(FRIEND_A)).toContain('80 %');
    expect(consumeBudgetNote(FRIEND_A)).toBeUndefined();
  });
  it('budget_100 sends the exhausted message with the raise button and pauses tasks', async () => {
    await handleBudgetEvent({ tenantId: `telegram:${FRIEND_A}`, type: 'budget_100' });
    expect(fake.sent[0].chatId).toBe(FRIEND_A);
    expect(fake.sent[0].buttons!.flat()[0].data).toBe(`p:rl:${FRIEND_A}`);
    expect(pauseAllTasks).toHaveBeenCalledWith('ag-1', FRIEND_A);
  });
  it('global_cap alerts the owner; events for the owner or unknown tenants do nothing', async () => {
    await handleBudgetEvent({ tenantId: 'global', type: 'global_cap' });
    expect(fake.sent[0].chatId).toBe(OWNER);
    fake.sent.length = 0;
    await handleBudgetEvent({ tenantId: `telegram:${OWNER}`, type: 'budget_100' });
    await handleBudgetEvent({ tenantId: 'telegram:999', type: 'budget_100' });
    expect(fake.sent).toHaveLength(0);
  });
  it('polling acks what it handled', async () => {
    ng.events.mockResolvedValueOnce([
      { id: 7, tenantId: `telegram:${FRIEND_A}`, type: 'budget_80', payload: {}, createdAt: 1 },
    ]);
    await pollBudgetEventsOnce();
    expect(ng.ackEvents).toHaveBeenCalledWith(7);
  });
});

describe('mcp_key_rejected', () => {
  // The poll cursor is module state that only grows: ids stay between the neighbouring tests' (7 and 11).
  it('marks the connector key as rejected (not a budget event) and acks it', async () => {
    const { createConnector, getConnector, saveConnectorKey } = await import('./mcp-connectors.js');
    const probe = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const t = (await (await import('./store.js')).getTenantByTg(FRIEND_A))!;
    const row = await createConnector(t.user_id, 'github');
    await saveConnectorKey(t, row.id, `ghp_${'a1B2'.repeat(9)}`);
    expect((await getConnector(row.id))!.key_status).toBe('ok');
    ng.events.mockResolvedValueOnce([
      { id: 8, tenantId: t.user_id, type: 'mcp_key_rejected', payload: { connectorId: row.id }, createdAt: 1 },
      {
        id: 9,
        tenantId: t.user_id,
        type: 'mcp_key_rejected',
        payload: { connectorId: 'github-00000000' },
        createdAt: 2,
      },
      { id: 10, tenantId: t.user_id, type: 'mcp_key_rejected', payload: {}, createdAt: 3 },
    ]);
    await pollBudgetEventsOnce();
    expect((await getConnector(row.id))!.key_status).toBe('rejected');
    expect(ng.ackEvents).toHaveBeenCalledWith(10);
    expect(fake.sent).toEqual([]); // no budget notice for it
    probe.mockRestore();
  });
});

describe('durable budget state', () => {
  it('the 80 % note is stored and survives a restart', async () => {
    await handleBudgetEvent({ tenantId: `telegram:${FRIEND_A}`, type: 'budget_80' });
    expect(await kvGet(`budget-note:${FRIEND_A}`)).toContain('80 %');
    // simulate a restart: the in-memory map is gone, kv is not
    consumeBudgetNote(FRIEND_A);
    await kvSet(`budget-note:${FRIEND_A}`, JSON.stringify({ text: 'x 80 %', until: Date.now() + 60_000 }));
    await loadBudgetNotes();
    expect(consumeBudgetNote(FRIEND_A)).toBe('x 80 %');
  });
  it('a note armed in an earlier period is dropped, not shown after the reset', async () => {
    await kvSet(`budget-note:${FRIEND_A}`, JSON.stringify({ text: 'old 80 %', until: Date.now() - 1000 }));
    await loadBudgetNotes();
    expect(consumeBudgetNote(FRIEND_A)).toBeUndefined();
    expect(await kvGet(`budget-note:${FRIEND_A}`)).toBeUndefined();
  });
  it('budget_100: a failed notice is not acked (retried on the next poll), a delivered one is', async () => {
    let fail = true;
    const adapter = (await import('./port.js')).tg;
    const spy = vi.spyOn(adapter, 'sendProduct').mockImplementation(async (chatId) => {
      if (fail && chatId === FRIEND_A) throw new Error('telegram down');
      return { messageId: 1 };
    });
    ng.events.mockResolvedValue([
      { id: 11, tenantId: `telegram:${FRIEND_A}`, type: 'budget_100', payload: {}, createdAt: 1 },
    ]);
    await pollBudgetEventsOnce();
    expect(ng.ackEvents).not.toHaveBeenCalled();
    fail = false;
    await pollBudgetEventsOnce();
    expect(ng.ackEvents).toHaveBeenCalledWith(11);
    spy.mockRestore();
  });
  it('budget_100 also tells the owner silently, with the NEW limit on the buttons (a raise is permanent)', async () => {
    await handleBudgetEvent({ tenantId: `telegram:${FRIEND_A}`, type: 'budget_100' });
    const ownerMsg = fake.sent.find((m) => m.chatId === OWNER)!;
    expect(ownerMsg.md).toContain('Маша');
    expect(ownerMsg.buttons!.flat().map((b) => b.data)).toEqual([`p:ra:${FRIEND_A}:5`, `p:ra:${FRIEND_A}:10`]);
    expect(ownerMsg.buttons!.flat()[0].text).toContain('$15');
  });
});

describe('global cap', () => {
  it('global_cap sets a flag until the next UTC month and alerts the owner with an action button', async () => {
    expect(globalCapUntil()).toBeNull();
    await handleBudgetEvent({
      tenantId: 'global',
      type: 'global_cap',
      payload: { usedMicros: 100_000_000, capMicros: 100_000_000 },
    });
    expect(globalCapUntil()).toBeGreaterThan(Date.now());
    expect(await kvGet('globalCapUntil')).toBeTruthy();
    const m = fake.sent.find((x) => x.chatId === OWNER)!;
    expect(m.md).toContain('$100 из $100');
    expect(m.buttons!.flat()[0].webApp).toBe('system');
  });
  it('the latch survives a restart at the same cap and is released when the cap is raised', async () => {
    await handleBudgetEvent({ tenantId: 'global', type: 'global_cap' });
    resetGlobalCapForTests();
    await loadGlobalCap();
    expect(globalCapUntil()).not.toBeNull();
    process.env.NC_GLOBAL_CAP_USD = '500';
    try {
      resetGlobalCapForTests();
      await loadGlobalCap();
      expect(globalCapUntil()).toBeNull();
    } finally {
      delete process.env.NC_GLOBAL_CAP_USD;
    }
  });
  it('global_80 is a soft, silent heads-up and does not set the flag', async () => {
    const cap = globalCapUntil();
    await handleBudgetEvent({ tenantId: 'global', type: 'global_80' });
    expect(fake.sent.find((x) => x.chatId === OWNER)!.md).toContain('80 %');
    expect(globalCapUntil()).toBe(cap);
  });
  it('a failed global_cap alert is retried (not acked)', async () => {
    const adapter = (await import('./port.js')).tg;
    const spy = vi.spyOn(adapter, 'sendProduct').mockRejectedValue(new Error('down'));
    ng.events.mockResolvedValue([{ id: 21, tenantId: 'global', type: 'global_cap', payload: {}, createdAt: 1 }]);
    await pollBudgetEventsOnce();
    expect(ng.ackEvents).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('budget resume', () => {
  it('quiet hours wrap midnight', () => {
    expect(inQuietHours('23:00', '07:00', 'UTC', new Date('2026-11-01T00:05:00Z'))).toBe(true);
    expect(inQuietHours('23:00', '07:00', 'UTC', new Date('2026-11-01T12:00:00Z'))).toBe(false);
    expect(inQuietHours(null, null, 'UTC')).toBe(false);
  });
  it('after the reset the system-paused tasks resume and skipped one-shots get one silent summary', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T12:00:00Z')); // midday: outside the default 23:00-08:00
    hasSystemPaused.mockResolvedValue(true);
    resumeAllTasks.mockResolvedValue({ resumed: 1, skipped: ['Позвонить маме', 'Оплатить'] });
    await resumeBudgetPausedTasks();
    expect(resumeAllTasks).toHaveBeenCalledWith('ag-1', FRIEND_A);
    expect(fake.sent.at(-1)!.md).toContain('пропущено 2');
    expect(fake.sent.at(-1)!.md).toContain('Позвонить маме');
    vi.useRealTimers();
  });
  it('waits for the morning inside the default quiet hours, but not when the user switched them off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-01T00:30:00Z'));
      hasSystemPaused.mockResolvedValue(true);
      resumeAllTasks.mockResolvedValue({ resumed: 1, skipped: [] });
      await resumeBudgetPausedTasks();
      expect(resumeAllTasks).not.toHaveBeenCalled();
      const p = await getPrefs(`telegram:${FRIEND_A}`, { tz: 'UTC' });
      await putPrefs(`telegram:${FRIEND_A}`, { ...p, tz: 'UTC', quiet_from: '', quiet_to: '' });
      await resumeBudgetPausedTasks();
      expect(resumeAllTasks).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it('does not resume while the budget is still exhausted', async () => {
    hasSystemPaused.mockResolvedValue(true);
    ng.budget.mockResolvedValue({
      limitMicros: 10_000_000,
      usedMicros: 10_000_000,
      reservedMicros: 0,
      periodStart: 0,
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'exhausted',
    });
    await resumeBudgetPausedTasks();
    expect(resumeAllTasks).not.toHaveBeenCalled();
  });
});
