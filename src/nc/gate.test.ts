import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { invalidateBudget } from './budget.js';
import { privateGate } from './gate.js';
import './migrations.js';
import type { PrivateUpdateCtx } from './port.js';
import { getTenantByTg, updateTenant, insertTenantIfAbsent, takeRetained } from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, groupUpdate, installFakeAdapter, setupDb } from './test-helpers.js';

function ctx(userId: number, text: string, over: Partial<PrivateUpdateCtx> = {}): PrivateUpdateCtx {
  const update = groupUpdate(userId, text, Math.floor(Math.random() * 1e6));
  return {
    update,
    user: { id: userId, firstName: 'Маша', username: 'masha_k', languageCode: 'ru' },
    chatId: userId,
    message: update.message,
    kind: 'text',
    ...over,
  };
}

let fake: ReturnType<typeof installFakeAdapter>;
let ng: ReturnType<typeof fakeNanogate>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  await setupDb();
  fake = installFakeAdapter();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  invalidateBudget();
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
});

describe('private gate', () => {
  it('routes the owner without touching tenants', async () => {
    expect(await privateGate(ctx(OWNER, 'привет'))).toEqual({ action: 'route' });
    expect(fake.sent).toHaveLength(0);
  });

  it('unknown user: creates request, owner card with 3 buttons, retains, tells the user once, never routes', async () => {
    const d = await privateGate(ctx(FRIEND_A, 'привет <b>[x](http://evil)</b>'));
    expect(d).toEqual({ action: 'handled' });
    const t = await getTenantByTg(FRIEND_A);
    expect(t?.state).toBe('pending');
    const card = fake.sent.find((s) => s.chatId === OWNER)!;
    expect(card.md).toContain('Запрос доступа');
    expect(card.md).not.toContain('(http://evil)'); // escaped
    const datas = card.buttons!.flat().map((b) => b.data!);
    // accept, 5/10/25 presets, deny
    expect(datas.map((x) => x.split(':')[1]).sort()).toEqual(['al', 'al', 'al', 'ap', 'dn']);
    for (const x of datas) expect(Buffer.byteLength(x)).toBeLessThanOrEqual(64);
    expect(fake.sent.filter((s) => s.chatId === FRIEND_A)).toHaveLength(1);
    expect((await takeRetained(FRIEND_A)).length).toBe(1);
  });

  it('pending: repeated messages are retained (max 5) with at most one reply per 24h', async () => {
    await privateGate(ctx(FRIEND_A, 'один'));
    for (let i = 0; i < 7; i++) expect((await privateGate(ctx(FRIEND_A, `m${i}`))).action).toBe('handled');
    expect(fake.sent.filter((s) => s.chatId === FRIEND_A)).toHaveLength(1); // only the first pending copy
    expect(fake.sent.filter((s) => s.chatId === OWNER)).toHaveLength(1); // no second card
    expect((await takeRetained(FRIEND_A)).length).toBe(5);
  });

  it('denied within cooldown is silent; after cooldown a new request is created', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'denied' });
    await updateTenant(FRIEND_A, { denied_until: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await privateGate(ctx(FRIEND_A, 'эй'))).action).toBe('handled');
    expect(fake.sent).toHaveLength(0);
    await updateTenant(FRIEND_A, { denied_until: new Date(Date.now() - 1000).toISOString() });
    await privateGate(ctx(FRIEND_A, 'эй'));
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('pending');
    expect(fake.sent.some((s) => s.chatId === OWNER)).toBe(true);
  });

  it('paused / provisioning / deleted / unknown states never route', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'paused' });
    for (const state of ['paused', 'provisioning', 'provisioning_failed', 'deleted', 'pending'] as const) {
      await updateTenant(FRIEND_A, { state });
      expect((await privateGate(ctx(FRIEND_A, 'x'))).action).toBe('handled');
    }
    await updateTenant(FRIEND_A, { state: 'weird' as never });
    expect((await privateGate(ctx(FRIEND_A, 'x'))).action).toBe('handled');
  });

  it('ready routes; exhausted budget blocks non-commands only', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    expect(await privateGate(ctx(FRIEND_A, 'привет'))).toEqual({ action: 'route' });
    ng.budget.mockResolvedValue({
      limitMicros: 10_000_000,
      usedMicros: 10_000_000,
      reservedMicros: 0,
      periodStart: 0,
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'exhausted',
    });
    invalidateBudget();
    expect((await privateGate(ctx(FRIEND_A, 'привет'))).action).toBe('handled');
    expect(fake.sent.at(-1)!.md).toContain('Лимит');
    expect(fake.sent.at(-1)!.buttons!.flat()[0].data).toBe(`p:rl:${FRIEND_A}`);
    expect((await privateGate(ctx(FRIEND_A, '/tasks', { kind: 'command' }))).action).toBe('route');
  });

  it('ready without an agent group is not routed', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    expect((await privateGate(ctx(FRIEND_A, 'x'))).action).toBe('handled');
  });

  it('a chat id that differs from the user id is not served', async () => {
    expect((await privateGate(ctx(FRIEND_A, 'x', { chatId: -100500 }))).action).toBe('handled');
    expect(await getTenantByTg(FRIEND_A)).toBeUndefined();
  });

  it('a gate failure fails closed', async () => {
    ng.budget.mockRejectedValue(new Error('boom'));
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    // budget errors fail open to the proxy (it enforces), but DB errors must not route:
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await closeDb();
    expect((await privateGate(ctx(FRIEND_A, 'x'))).action).toBe('handled');
  });
});

describe('gate: product polish', () => {
  it('a bare /start is shown as «(открыл бота)» on the card and is not retained', async () => {
    await privateGate(ctx(FRIEND_A, '/start', { kind: 'command' }));
    const card = fake.sent.find((s) => s.chatId === OWNER)!;
    expect(card.md).toContain('открыл бота');
    expect(card.md).not.toContain('«/start»');
    expect((await takeRetained(FRIEND_A)).length).toBe(0);
  });

  it('friends get «Такой команды нет» for upstream admin commands instead of an English denial', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    const d = await privateGate(ctx(FRIEND_A, '/clear', { kind: 'command' }));
    expect(d.action).toBe('handled');
    expect(fake.sent.at(-1)!.md).toContain('Такой команды нет');
    // a product command passes even with an exhausted budget
    ng.budget.mockResolvedValue({
      limitMicros: 1,
      usedMicros: 1,
      reservedMicros: 0,
      periodStart: 0,
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'exhausted',
    });
    invalidateBudget();
    expect((await privateGate(ctx(FRIEND_A, '/new', { kind: 'command' }))).action).toBe('route');
  });

  it('an unknown slash command with an exhausted budget gets the budget wall, never routed', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    ng.budget.mockResolvedValue({
      limitMicros: 1,
      usedMicros: 1,
      reservedMicros: 0,
      periodStart: 0,
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'exhausted',
    });
    invalidateBudget();
    expect((await privateGate(ctx(FRIEND_A, '/whatever', { kind: 'command' }))).action).toBe('handled');
    expect(fake.sent.at(-1)!.md).toContain('Лимит');
    expect(fake.sent.at(-1)!.buttons!.flat()[0].data).toBe(`p:rl:${FRIEND_A}`);
  });

  it('nanogate down: the message is still routed, the friend is told once per outage window', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    ng.budget.mockRejectedValue(new Error('down'));
    invalidateBudget();
    expect((await privateGate(ctx(FRIEND_A, 'привет'))).action).toBe('route');
    expect((await privateGate(ctx(FRIEND_A, 'ещё раз'))).action).toBe('route');
    const notes = fake.sent.filter((s) => s.chatId === FRIEND_A && s.md.includes('временно недоступен'));
    expect(notes).toHaveLength(1);
  });

  it('the installation cap answers deterministically without routing (friend and owner)', async () => {
    const { handleBudgetEvent, resetGlobalCapForTests } = await import('./budget.js');
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    await handleBudgetEvent({ tenantId: 'global', type: 'global_cap' });
    expect((await privateGate(ctx(FRIEND_A, 'привет'))).action).toBe('handled');
    expect(fake.sent.at(-1)!.md).toContain('Лимит установки исчерпан');
    expect((await privateGate(ctx(OWNER, 'привет'))).action).toBe('handled');
    expect(fake.sent.at(-1)!.buttons!.flat()[0].webApp).toBe('system');
    resetGlobalCapForTests();
  });

  it('the provisioning copy is rate-limited and honest about a failure', async () => {
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'provisioning_failed' });
    for (let i = 0; i < 4; i++) await privateGate(ctx(FRIEND_A, `м${i}`));
    const msgs = fake.sent.filter((s) => s.chatId === FRIEND_A);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].md).toContain('уже знает');
  });

  it('a deleted friend is shut out during the cooldown; after the owner reopens, the next message is a fresh request', async () => {
    const { reopenDenied } = await import('./decisions.js');
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'deleted' });
    await updateTenant(FRIEND_A, { denied_until: new Date(Date.now() + 86_400_000).toISOString(), epoch: 2 });
    expect((await privateGate(ctx(FRIEND_A, 'эй'))).action).toBe('handled');
    expect(fake.sent.at(-1)!.md).toBe('Доступ закрыт.');
    expect(await reopenDenied(FRIEND_A, 'owner')).toBe(true);
    expect((await privateGate(ctx(FRIEND_A, 'эй'))).action).toBe('handled');
    const t = (await getTenantByTg(FRIEND_A))!;
    expect(t.state).toBe('pending');
    expect(t.epoch).toBe(2); // the nanogate id stays versioned
    expect(fake.sent.some((s) => s.chatId === OWNER && s.md.includes('Запрос доступа'))).toBe(true);
  });
});
