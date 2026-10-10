import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dmSession, injectChat } = vi.hoisted(() => ({
  dmSession: vi.fn(async () => ({ id: 's1', agent_group_id: 'ag-1' })),
  injectChat: vi.fn(async () => undefined),
}));
vi.mock('./chat.js', () => ({ dmSession, injectChat, killGroupContainers: vi.fn() }));
const { running } = vi.hoisted(() => ({ running: { v: false } }));
vi.mock('../container-runner.js', () => ({ isContainerRunning: () => running.v }));
const { listTasks, pauseTask, resumeTask, deleteTask, runTaskNow } = vi.hoisted(() => ({
  listTasks: vi.fn(async () => [] as unknown[]),
  pauseTask: vi.fn(async () => 1),
  resumeTask: vi.fn(async () => 1),
  deleteTask: vi.fn(async () => true),
  runTaskNow: vi.fn(async () => 1),
}));
vi.mock('./tasks.js', () => ({ listTasks, pauseTask, resumeTask, deleteTask, runTaskNow }));
const { claims } = vi.hoisted(() => ({ claims: { n: 0 } }));
vi.mock('../session-manager.js', async (orig) => ({
  ...(await orig<typeof import('../session-manager.js')>()),
  withExistingMailboxSession: async (_g: string, _s: string, fn: (m: unknown) => unknown) =>
    fn({ getProcessingClaims: () => Array.from({ length: claims.n }, () => ({})) }),
}));
vi.mock('./health.js', () => ({ healthReport: vi.fn(async () => 'HEALTH') }));

import { closeDb } from '../db/index.js';
import { commandHandler, handleTaskCallback, renderTaskList } from './commands.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { invalidateBudget } from './budget.js';
import { lookupTaskToken, mintTaskToken } from './tasktokens.js';
import type { PrivateUpdateCtx } from './port.js';
import { insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, FRIEND_B, OWNER, fakeNanogate, groupUpdate, installFakeAdapter, setupDb } from './test-helpers.js';

const c = (id: number): PrivateUpdateCtx => ({
  update: groupUpdate(id, '/x'),
  user: { id, firstName: 'x' },
  chatId: id,
  kind: 'command',
});
let fake: ReturnType<typeof installFakeAdapter>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  await setupDb();
  fake = installFakeAdapter();
  await insertTenantIfAbsent({ tgId: OWNER, name: 'Илья', state: 'ready' });
  await updateTenant(OWNER, { agent_group_id: 'ag-o' });
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
  await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
});
afterEach(closeDb);

describe('commands', () => {
  it('owner-only commands are swallowed (never reach the agent) for friends and do nothing', async () => {
    for (const cmd of ['/friends', '/guest', '/health']) expect(await commandHandler(c(FRIEND_A), cmd, '')).toBe(true);
    expect(fake.sent).toHaveLength(0);
  });
  it('owner gets /health and /friends', async () => {
    expect(await commandHandler(c(OWNER), '/health', '')).toBe(true);
    expect(fake.sent[0].md).toBe('HEALTH');
    expect(await commandHandler(c(OWNER), '/friends', '')).toBe(true);
  });
  it('/new injects /clear into the caller own session; /stop injects /stop', async () => {
    await commandHandler(c(FRIEND_A), '/new', '');
    // Cold container: the clear rides along silently, no wake, one Russian confirmation.
    expect(injectChat).toHaveBeenCalledWith(expect.anything(), FRIEND_A, '/clear', { silent: true, wake: false });
    expect(fake.sent.at(-1)!.md).toContain('новый разговор');
    running.v = true;
    await commandHandler(c(FRIEND_A), 'stop@my_bot', '');
    expect(injectChat).toHaveBeenLastCalledWith(expect.anything(), FRIEND_A, '/stop');
  });
  it('/stop with no running container answers at once and does not wake one', async () => {
    running.v = false;
    await commandHandler(c(FRIEND_A), '/stop', '');
    expect(injectChat).not.toHaveBeenCalled();
    expect(fake.sent.at(-1)!.md).toBe('Сейчас нечего останавливать.');
  });
  it('unknown commands fall through to the agent; non-ready users are swallowed silently', async () => {
    expect(await commandHandler(c(FRIEND_A), '/whatever', '')).toBe(false);
    await updateTenant(FRIEND_A, { state: 'paused' });
    expect(await commandHandler(c(FRIEND_A), '/new', '')).toBe(true);
    expect(injectChat).not.toHaveBeenCalled();
  });
  it('task buttons require the matching presser', async () => {
    const q = { from: { id: FRIEND_B }, id: 'q' } as never;
    expect(await handleTaskCallback(q, 'tc', 'deadbeef00')).toEqual({ toast: 'Кнопка устарела' });
  });
});

const tasks = [
  { id: 'a-1', name: 'Дайджест', scheduleHuman: 'По будням в 09:00', nextRunAt: null, status: 'active' },
  { id: 'b-2', name: 'Позвонить маме', scheduleHuman: 'Один раз', nextRunAt: null, status: 'paused' },
];
const press = (id: number, messageId = 7) =>
  ({ from: { id }, id: 'q', message: { chat: { id }, message_id: messageId } }) as never;

describe('/tasks list', () => {
  it('numbers the rows and puts the same number on the buttons', async () => {
    listTasks.mockResolvedValue(tasks);
    const v = await renderTaskList(FRIEND_A, 'ag-1');
    expect(v.md).toContain('1. **Дайджест**');
    expect(v.md).toContain('2. **Позвонить маме**');
    expect(v.buttons[0].map((b) => b.text)).toEqual(['⏸ 1', '✖ 1']);
    expect(v.buttons[1].map((b) => b.text)).toEqual(['▶️ 2', '✖ 2']);
  });

  it('delete asks first, names the task, and only «Да, удалить» deletes; the list is re-rendered after each action', async () => {
    listTasks.mockResolvedValue(tasks);
    const tok = await mintTaskToken(FRIEND_A, 'a-1', true);
    expect(await handleTaskCallback(press(FRIEND_A), 'tc', tok)).toEqual({});
    expect(deleteTask).not.toHaveBeenCalled();
    const ask = fake.edited.at(-1)!;
    expect(ask.md).toContain('Удалить «Дайджест»');
    const yes = ask.buttons!.flat()[0].data!.split(':');
    expect(yes[1]).toBe('tcc');
    expect((await handleTaskCallback(press(FRIEND_A), 'tcc', yes[2])).toast).toBe('Удалено');
    expect(deleteTask).toHaveBeenCalledWith('ag-1', 'a-1');
    expect(fake.edited.at(-1)!.md).toContain('Мои задачи'); // refreshed list
  });

  it('pause refreshes the list too; «Повторить» runs the task now', async () => {
    listTasks.mockResolvedValue(tasks);
    const tok = await mintTaskToken(FRIEND_A, 'a-1', true);
    await handleTaskCallback(press(FRIEND_A), 'tp', tok);
    expect(pauseTask).toHaveBeenCalledWith('ag-1', 'a-1');
    expect(fake.edited.length).toBeGreaterThan(0);
    expect((await handleTaskCallback(press(FRIEND_A), 'trun', tok)).toast).toBe('Запускаю');
  });

  it('while the budget is exhausted a task cannot be resumed from the list', async () => {
    const ng = fakeNanogate();
    ng.budget.mockResolvedValue({
      limitMicros: 1,
      usedMicros: 1,
      reservedMicros: 0,
      periodStart: 0,
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'exhausted',
    });
    setNanogateAdminForTests(ng);
    invalidateBudget();
    const tok = await mintTaskToken(FRIEND_A, 'b-2', true);
    const r = await handleTaskCallback(press(FRIEND_A), 'tr', tok);
    expect(r.toast).toContain('Лимит исчерпан');
    expect(r.toast).toContain('1 ноября');
    expect(resumeTask).not.toHaveBeenCalled();
    setNanogateAdminForTests(null);
  });

  it('the per-user token cap drops only the oldest tokens, recent buttons keep working', async () => {
    vi.useFakeTimers();
    try {
      const toks: string[] = [];
      for (let i = 0; i < 303; i++) {
        vi.advanceTimersByTime(1000);
        toks.push(await mintTaskToken(FRIEND_A, `s-${i}`));
      }
      expect(await lookupTaskToken(toks[302]!)).toBeDefined();
      expect(await lookupTaskToken(toks[290]!)).toBeDefined();
      expect(await lookupTaskToken(toks[0]!)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('/stop answers at once, without waking a container, when no turn is in flight', async () => {
    running.v = true; // a warm container is not a running turn
    fake = installFakeAdapter({ hasActiveTurn: () => false });
    await commandHandler(c(FRIEND_A), '/stop', '');
    expect(injectChat).not.toHaveBeenCalled();
    expect(fake.sent.at(-1)!.md).toBe('Сейчас нечего останавливать.');
    fake = installFakeAdapter({ hasActiveTurn: () => true });
    await commandHandler(c(FRIEND_A), '/stop', '');
    expect(injectChat).toHaveBeenCalledWith(expect.anything(), FRIEND_A, '/stop');
  });

  it('/new and /stop typed in a topic act on that topic (its session, its turn)', async () => {
    running.v = true;
    const topicCtx = (id: number, thread: number): PrivateUpdateCtx => ({
      ...c(id),
      message: {
        message_id: 5,
        message_thread_id: thread,
        is_topic_message: true,
        chat: { id, type: 'private' },
        date: 1,
      },
    });
    const active = vi.fn((_chat: number, thread?: number) => thread === 7);
    fake = installFakeAdapter({ hasActiveTurn: active });
    await commandHandler(topicCtx(FRIEND_A, 7), '/stop', '');
    expect(dmSession).toHaveBeenLastCalledWith(expect.anything(), false, '7');
    expect(active).toHaveBeenLastCalledWith(FRIEND_A, 7);
    expect(injectChat).toHaveBeenLastCalledWith(expect.anything(), FRIEND_A, '/stop');
    // the same command in another topic finds nothing running there
    injectChat.mockClear();
    await commandHandler(topicCtx(FRIEND_A, 8), '/stop', '');
    expect(injectChat).not.toHaveBeenCalled();
    expect(fake.sent.at(-1)!.md).toBe('Сейчас нечего останавливать.');
    await commandHandler(topicCtx(FRIEND_A, 8), '/new', '');
    expect(dmSession).toHaveBeenLastCalledWith(expect.anything(), true, '8');
  });

  it('/stop still reaches a container with a claimed row when the adapter lost the turn (host restart)', async () => {
    running.v = true;
    claims.n = 1;
    fake = installFakeAdapter({ hasActiveTurn: () => false });
    await commandHandler(c(FRIEND_A), '/stop', '');
    expect(injectChat).toHaveBeenCalledWith(expect.anything(), FRIEND_A, '/stop');
    claims.n = 0;
  });
});

describe('/friends', () => {
  it('shows Russian state labels, pending requests with buttons, and a reopen button for denied/deleted', async () => {
    const { createRequest } = await import('./store.js');
    await insertTenantIfAbsent({ tgId: FRIEND_B, name: 'Петя', state: 'pending' });
    await createRequest(FRIEND_B, 'привет');
    await insertTenantIfAbsent({ tgId: 2003, name: 'Вася', state: 'denied' });
    await insertTenantIfAbsent({ tgId: 2004, name: 'Гоша', state: 'deleted' });
    await insertTenantIfAbsent({ tgId: 2005, name: 'Зоя', state: 'provisioning_failed' });
    await updateTenant(FRIEND_A, { state: 'paused' });
    await commandHandler(c(OWNER), '/friends', '');
    const all = fake.sent.map((m) => m.md).join('\n');
    expect(all).toContain('⏸ на паузе');
    expect(all).toContain('⏳ ждёт решения');
    expect(all).toContain('⚠️ не создан');
    expect(all).not.toMatch(/\b(ready|paused|provisioning_failed|pending)\b/);
    const datas = fake.sent.flatMap((m) => (m.buttons ?? []).flat().map((b) => b.data ?? ''));
    expect(datas.some((d) => d.startsWith('p:ap:'))).toBe(true);
    expect(datas).toContain('p:ro:2003');
    expect(datas).toContain('p:ro:2004');
    expect(datas).toContain('p:rt:2005');
  });
  it('/help differs for the owner; /menu has three quick actions', async () => {
    await commandHandler(c(FRIEND_A), '/help', '');
    expect(fake.sent.at(-1)!.md).not.toContain('/friends');
    await commandHandler(c(OWNER), '/help', '');
    expect(fake.sent.at(-1)!.md).toContain('/friends');
    await commandHandler(c(OWNER), '/menu', '');
    expect(fake.sent.at(-1)!.buttons![1]).toHaveLength(3);
  });
});
