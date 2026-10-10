/** Buttons under chat messages: [Повторить], [Продолжить], [Начать заново], suggested replies, reminders, task-created. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { injectChat, dmSession, getTaskDetail, listTasks, createScheduledTask } = vi.hoisted(() => ({
  injectChat: vi.fn(async () => undefined),
  dmSession: vi.fn(async () => ({ id: 'sess-1', agent_group_id: 'ag-1' })),
  getTaskDetail: vi.fn(async () => ({
    id: 'task-1',
    name: 'Позвонить маме',
    prompt: 'Напомни позвонить маме',
    runs: [],
  })),
  listTasks: vi.fn(async () => [{ id: 'task-1', name: 'Позвонить маме' }]),
  createScheduledTask: vi.fn(async () => ({ session: { id: 's', agent_group_id: 'ag-1' }, row: {} })),
}));
vi.mock('./chat.js', () => ({ dmSession, injectChat }));
vi.mock('../container-runner.js', () => ({ isContainerRunning: vi.fn(() => true), killContainer: vi.fn() }));
vi.mock('./tasks.js', async (orig) => ({ ...(await orig<typeof import('./tasks.js')>()), getTaskDetail, listTasks }));
vi.mock('../modules/scheduling/create.js', async (orig) => ({
  ...(await orig<typeof import('../modules/scheduling/create.js')>()),
  createScheduledTask,
}));
vi.mock('../container-config.js', async (orig) => ({
  ...(await orig<typeof import('../container-config.js')>()),
  resolveGroupTimezone: vi.fn(async () => 'Europe/Moscow'),
}));

import type { CallbackQuery } from '../channels/telegram/botapi/index.js';
import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { productCallback, resetRetryGuardForTests } from './callbacks.js';
import { insertTenantIfAbsent, updateTenant } from './store.js';
import { mintTaskToken } from './tasktokens.js';
import { FRIEND_A, FRIEND_B, OWNER, fakeNanogate, installFakeAdapter, setupDb } from './test-helpers.js';

function press(from: number, data: string, text = 'Сообщение бота', chat = from): CallbackQuery {
  return {
    id: 'q',
    from: { id: from, is_bot: false, first_name: 'x' },
    chat_instance: 'c',
    data,
    message: { message_id: 7, date: 1, text, chat: { id: chat, type: 'private' } },
  } as never;
}

let fake: ReturnType<typeof installFakeAdapter>;
let active: boolean | undefined;
const prompts = new Map<string, string>([['tg:2001:5', 'найди рейс в Тбилиси']]);
const values = new Map<string, string>([['abcd1234', 'Сделай план']]);

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  active = false;
  resetRetryGuardForTests();
  await setupDb();
  fake = installFakeAdapter({
    hasActiveTurn: () => active,
    retryPrompt: async (chat, turn) =>
      chat === FRIEND_A ? prompts.get(/^tg:-?\d+:\d+/.exec(turn)?.[0] ?? turn) : undefined,
    buttonValue: async (chat, id, kind) => (chat === FRIEND_A && kind === 'sr' ? values.get(id) : undefined),
  });
  setNanogateAdminForTests(fakeNanogate());
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
  await updateTenant(FRIEND_A, { state: 'ready', agent_group_id: 'ag-1' });
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
});

describe('[Повторить]', () => {
  it('re-injects the original prompt once; a double tap does not run it twice', async () => {
    const d = 'p:rty:tg:2001:5';
    expect(await productCallback(press(FRIEND_A, d), d)).toEqual({ toast: 'Повторяю' });
    expect(await productCallback(press(FRIEND_A, d), d)).toEqual({ toast: 'Уже запускаю' });
    expect(injectChat).toHaveBeenCalledTimes(1);
    const [session, tgId, text, opts] = injectChat.mock.calls[0] as unknown as [
      { id: string },
      number,
      string,
      { id: string; sender: string },
    ];
    expect(session.id).toBe('sess-1');
    expect(tgId).toBe(FRIEND_A);
    expect(text).toBe('найди рейс в Тбилиси');
    expect(opts.sender).toBe('Маша');
    // same base id as the failed turn: a second failure keeps a working [Повторить]
    expect(opts.id).toMatch(/^tg:2001:5:r/);
    expect(fake.cleared).toEqual([{ chatId: FRIEND_A, messageId: 7 }]);
  });

  it('the legacy p:retry: spelling works too', async () => {
    expect(await productCallback(press(FRIEND_A, 'p:retry:tg:2001:5'), 'p:retry:tg:2001:5')).toEqual({
      toast: 'Повторяю',
    });
  });

  it('not while the assistant is still answering', async () => {
    active = true;
    expect(await productCallback(press(FRIEND_A, 'p:rty:tg:2001:5'), 'p:rty:tg:2001:5')).toEqual({
      toast: 'Я ещё отвечаю — подожди',
    });
    expect(injectChat).not.toHaveBeenCalled();
  });

  it('an unknown or expired prompt says so instead of doing nothing', async () => {
    const r = await productCallback(press(FRIEND_A, 'p:rty:tg:2001:99'), 'p:rty:tg:2001:99');
    expect(r?.toast).toContain('пришли его ещё раз');
    expect(injectChat).not.toHaveBeenCalled();
  });

  it('only the owner of the chat (a ready tenant, in its own chat) can press it', async () => {
    expect(await productCallback(press(FRIEND_B, 'p:rty:tg:2001:5'), 'p:rty:tg:2001:5')).toEqual({
      toast: 'Недоступно',
    });
    expect(await productCallback(press(FRIEND_A, 'p:rty:tg:2001:5', 'x', OWNER), 'p:rty:tg:2001:5')).toEqual({
      toast: 'Недоступно',
    });
    expect(injectChat).not.toHaveBeenCalled();
  });
});

describe('[Продолжить] / [Начать заново]', () => {
  it('p:cont injects «продолжай» as the user', async () => {
    expect(await productCallback(press(FRIEND_A, 'p:cont'), 'p:cont')).toEqual({ toast: 'Продолжаю' });
    expect(injectChat).toHaveBeenCalledWith({ id: 'sess-1', agent_group_id: 'ag-1' }, FRIEND_A, 'продолжай', {
      sender: 'Маша',
    });
  });

  it('p:new clears the session silently and confirms in Russian', async () => {
    await productCallback(press(FRIEND_A, 'p:new'), 'p:new');
    expect(injectChat).toHaveBeenCalledWith({ id: 'sess-1', agent_group_id: 'ag-1' }, FRIEND_A, '/clear', {
      silent: true,
      wake: true,
    });
    expect(fake.sent.at(-1)?.chatId).toBe(FRIEND_A);
    expect(fake.sent.at(-1)?.md).toMatch(/нов|заново|разговор/i);
  });
});

describe('suggested replies', () => {
  it("a chip sends its stored text as the user's next message", async () => {
    expect(await productCallback(press(FRIEND_A, 'p:sr:abcd1234'), 'p:sr:abcd1234')).toBeUndefined();
    expect(injectChat).toHaveBeenCalledWith({ id: 'sess-1', agent_group_id: 'ag-1' }, FRIEND_A, 'Сделай план', {
      sender: 'Маша',
    });
    expect(fake.cleared).toHaveLength(1);
  });

  it('a stale or foreign chip is refused', async () => {
    expect(await productCallback(press(FRIEND_A, 'p:sr:deadbeef'), 'p:sr:deadbeef')).toEqual({
      toast: 'Кнопка устарела',
    });
    expect(injectChat).not.toHaveBeenCalled();
  });
});

describe('reminder and task-created buttons', () => {
  it('[Сделано] turns the reminder into a checked line without buttons', async () => {
    const tok = await mintTaskToken(FRIEND_A, 'task-1');
    expect(await productCallback(press(FRIEND_A, `p:rd:${tok}`, '⏰ Позвонить маме'), `p:rd:${tok}`)).toEqual({
      toast: 'Отмечено',
    });
    expect(fake.edited.at(-1)).toMatchObject({ chatId: FRIEND_A, messageId: 7, buttons: [] });
    expect(fake.edited.at(-1)?.md.startsWith('✔')).toBe(true);
  });

  it('[Отложить на час] creates a one-shot copy an hour from now (p:sz does not collide with the resend p:rs)', async () => {
    const tok = await mintTaskToken(FRIEND_A, 'task-1');
    expect(await productCallback(press(FRIEND_A, `p:sz:${tok}`), `p:sz:${tok}`)).toEqual({
      toast: 'Напомню через час',
    });
    const [group, prepared] = createScheduledTask.mock.calls[0] as unknown as [
      string,
      { prompt: string; recurrence: string | null; processAfter: string },
    ];
    expect(group).toBe('ag-1');
    expect(prepared.prompt).toBe('Напомни позвонить маме');
    expect(prepared.recurrence).toBeNull();
    const dt = Date.parse(prepared.processAfter) - Date.now();
    expect(dt).toBeGreaterThan(55 * 60_000);
    expect(dt).toBeLessThan(65 * 60_000);
  });

  it('snooze works for a one-shot that already fired (no live task): it uses the reminder text', async () => {
    getTaskDetail.mockResolvedValueOnce(undefined as never);
    const tok = await mintTaskToken(FRIEND_A, 'task-gone');
    await productCallback(press(FRIEND_A, `p:sz:${tok}`, '⏰ Выпить таблетку'), `p:sz:${tok}`);
    expect((createScheduledTask.mock.calls[0] as unknown as [string, { prompt: string }])[1].prompt).toContain(
      'Выпить таблетку',
    );
  });

  it('[Изменить время] asks the agent to move the task', async () => {
    const tok = await mintTaskToken(FRIEND_A, 'task-1');
    expect(await productCallback(press(FRIEND_A, `p:tt:${tok}`), `p:tt:${tok}`)).toEqual({ toast: 'Спрашиваю' });
    expect((injectChat.mock.calls[0] as unknown as [unknown, number, string])[2]).toContain('Позвонить маме');
  });

  it("someone else's token does nothing", async () => {
    const tok = await mintTaskToken(FRIEND_A, 'task-1');
    expect(await productCallback(press(FRIEND_B, `p:sz:${tok}`), `p:sz:${tok}`)).toEqual({ toast: 'Кнопка устарела' });
    expect(createScheduledTask).not.toHaveBeenCalled();
  });
});
