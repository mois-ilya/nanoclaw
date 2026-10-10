import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startProvisioning, retryProvisioning, pauseFriend, deleteFriend, resumeFriend } = vi.hoisted(() => ({
  startProvisioning: vi.fn(async () => true),
  retryProvisioning: vi.fn(async () => true),
  pauseFriend: vi.fn(async () => undefined),
  deleteFriend: vi.fn(async () => undefined),
  resumeFriend: vi.fn(async () => undefined),
}));
vi.mock('./provision.js', () => ({ startProvisioning, retryProvisioning }));
vi.mock('./lifecycle.js', () => ({
  pauseFriend,
  deleteFriend,
  resumeFriend,
  LifecycleError: class LifecycleError extends Error {},
}));

import type { CallbackQuery } from '../channels/telegram/botapi/index.js';
import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { productCallback } from './callbacks.js';
import { createRequest, getRequest, getTenantByTg, insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, FRIEND_B, OWNER, fakeNanogate, installFakeAdapter, setupDb } from './test-helpers.js';

function press(from: number, data: string, chat = from): CallbackQuery {
  return {
    id: 'q',
    from: { id: from, is_bot: false, first_name: 'x' },
    chat_instance: 'c',
    data,
    message: { message_id: 7, date: 1, chat: { id: chat, type: 'private' } },
  } as never;
}

let fake: ReturnType<typeof installFakeAdapter>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  await setupDb();
  fake = installFakeAdapter();
  setNanogateAdminForTests(fakeNanogate());
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'pending' });
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
});

const OWNER_DATA = (reqId: string): string[] => [
  `p:ap:${reqId}`,
  `p:al:${reqId}`,
  `p:dn:${reqId}`,
  `p:lim:${FRIEND_A}`,
  `p:ls:${FRIEND_A}:25`,
  `p:ra:${FRIEND_A}:10`,
  `p:rx:${FRIEND_A}`,
  `p:rt:${FRIEND_A}`,
  `p:fp:${FRIEND_A}`,
  `p:fr:${FRIEND_A}`,
  `p:fd:${FRIEND_A}`,
  `p:fdc:${FRIEND_A}`,
  `p:fdx:${FRIEND_A}`,
];

describe('owner-only callbacks', () => {
  it('every owner action is refused for any other user, with no side effects', async () => {
    const req = await createRequest(FRIEND_A, 'привет');
    for (const attacker of [FRIEND_A, FRIEND_B, 999999]) {
      for (const data of OWNER_DATA(req.id)) {
        const r = await productCallback(press(attacker, data), data);
        expect(r, `${attacker} ${data}`).toEqual({ toast: 'Недоступно' });
      }
    }
    expect(startProvisioning).not.toHaveBeenCalled();
    expect(pauseFriend).not.toHaveBeenCalled();
    expect(deleteFriend).not.toHaveBeenCalled();
    expect(retryProvisioning).not.toHaveBeenCalled();
    expect((await getRequest(req.id))?.status).toBe('pending');
    expect((await getTenantByTg(FRIEND_A))?.state).toBe('pending');
    expect(fake.sent).toHaveLength(0);
  });

  it('the owner id pressing a button that sits in some OTHER chat is refused', async () => {
    const req = await createRequest(FRIEND_A, 'x');
    const r = await productCallback(press(OWNER, `p:ap:${req.id}`, FRIEND_A), `p:ap:${req.id}`);
    expect(r).toEqual({ toast: 'Недоступно' });
    expect(startProvisioning).not.toHaveBeenCalled();
  });

  it('a callback without a message (inline) is refused for owner actions', async () => {
    const q = { ...press(OWNER, 'p:fd:1'), message: undefined } as CallbackQuery;
    expect(await productCallback(q, 'p:fp:2001')).toEqual({ toast: 'Недоступно' });
  });

  it('owner approve starts provisioning once; a double tap is a no-op', async () => {
    const req = await createRequest(FRIEND_A, 'привет');
    expect(await productCallback(press(OWNER, `p:ap:${req.id}`), `p:ap:${req.id}`)).toEqual({ toast: 'Принято' });
    expect(startProvisioning).toHaveBeenCalledTimes(1);
    expect(startProvisioning).toHaveBeenCalledWith(FRIEND_A, 10_000_000, `telegram:${OWNER}`);
    expect(await productCallback(press(OWNER, `p:ap:${req.id}`), `p:ap:${req.id}`)).toEqual({
      toast: 'Уже обработано',
    });
    expect(startProvisioning).toHaveBeenCalledTimes(1);
  });

  it('"Принять, лимит $5" uses $5; deny sets a 30-day cooldown and informs the user', async () => {
    const r1 = await createRequest(FRIEND_A, 'a');
    await productCallback(press(OWNER, `p:al:${r1.id}`), `p:al:${r1.id}`);
    expect(startProvisioning).toHaveBeenCalledWith(FRIEND_A, 5_000_000, expect.any(String));

    await insertTenantIfAbsent({ tgId: FRIEND_B, name: 'Б', state: 'pending' });
    const r2 = await createRequest(FRIEND_B, 'b');
    await productCallback(press(OWNER, `p:dn:${r2.id}`), `p:dn:${r2.id}`);
    const t = await getTenantByTg(FRIEND_B);
    expect(t?.state).toBe('denied');
    expect(Date.parse(t!.denied_until!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    expect(fake.sent.some((s) => s.chatId === FRIEND_B && s.md.includes('не может дать'))).toBe(true);
  });

  it('delete needs the explicit second confirmation button', async () => {
    await productCallback(press(OWNER, `p:fd:${FRIEND_A}`), `p:fd:${FRIEND_A}`);
    expect(deleteFriend).not.toHaveBeenCalled();
    await productCallback(press(OWNER, `p:fdc:${FRIEND_A}`), `p:fdc:${FRIEND_A}`);
    expect(deleteFriend).toHaveBeenCalledWith(FRIEND_A, `telegram:${OWNER}`);
  });

  it('malformed ids are rejected, unknown ops are inert', async () => {
    expect(await productCallback(press(OWNER, 'p:fp:abc'), 'p:fp:abc')).toEqual({ toast: 'Неверные данные' });
    expect(await productCallback(press(OWNER, 'p:zz:1'), 'p:zz:1')).toEqual({ toast: 'Неизвестная кнопка' });
    expect(await productCallback(press(OWNER, 'x:ap:1'), 'x:ap:1')).toEqual({ toast: 'Неизвестная кнопка' });
  });
});

describe('friend-side callbacks', () => {
  beforeEach(async () => {
    await updateTenant(FRIEND_A, { state: 'ready', agent_group_id: 'ag-1', limit_usd_micros: 10_000_000 });
  });

  it('"Попросить поднять" works only for the tenant itself, once per window', async () => {
    expect(await productCallback(press(FRIEND_B, `p:rl:${FRIEND_A}`), `p:rl:${FRIEND_A}`)).toEqual({
      toast: 'Недоступно',
    });
    expect(fake.sent).toHaveLength(0);
    expect(await productCallback(press(FRIEND_A, `p:rl:${FRIEND_A}`), `p:rl:${FRIEND_A}`)).toEqual({
      toast: 'Передал',
    });
    const card = fake.sent.find((s) => s.chatId === OWNER)!;
    expect(card.buttons!.flat().map((b) => b.data)).toEqual([
      `p:ra:${FRIEND_A}:5`,
      `p:ra:${FRIEND_A}:10`,
      `p:rx:${FRIEND_A}`,
    ]);
    expect(await productCallback(press(FRIEND_A, `p:rl:${FRIEND_A}`), `p:rl:${FRIEND_A}`)).toEqual({
      toast: 'Запрос уже отправлен',
    });
  });

  it('owner grants +$10 by raising the stored limit', async () => {
    await productCallback(press(OWNER, `p:ra:${FRIEND_A}:10`), `p:ra:${FRIEND_A}:10`);
    expect((await getTenantByTg(FRIEND_A))?.limit_usd_micros).toBe(20_000_000);
    expect(await productCallback(press(OWNER, `p:ra:${FRIEND_A}:99`), `p:ra:${FRIEND_A}:99`)).toEqual({
      toast: 'Неверное значение',
    });
  });
});
