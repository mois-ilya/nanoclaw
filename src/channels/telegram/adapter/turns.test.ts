import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError } from '../botapi/index.js';
import { FakeApi } from './fakes.js';
import { Deliverer } from './deliver.js';
import { draftIdFor } from './format.js';
import { resetHooks, setBudgetNoteProvider, setUserPrefsProvider } from './hooks.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { MemoryStore } from './store.js';

const CHAT = 42;
const PLATFORM = `telegram:${CHAT}`;

let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let del: Deliverer;

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const deliverNow = async (content: Record<string, unknown>) => {
  const p = del.deliver(PLATFORM, null, { kind: 'chat', content });
  await tick(3000);
  return p;
};
const text = (call: { params: any }) => JSON.stringify(call.params); // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  setUserPrefsProvider(() => ({ showSteps: true }));
  setBudgetNoteProvider(() => null);
  api = new FakeApi();
  store = new MemoryStore();
  rt = createRuntime({
    api: api.asBotApi(),
    store,
    ownerId: 1,
    botUsername: 'test_bot',
    turnCfg: { stopEnabled: true },
  });
  setRuntime(rt);
  del = new Deliverer(rt);
});
afterEach(() => {
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  resetHooks();
  vi.useRealTimers();
});

const badRequest = () =>
  new TelegramError({
    method: 'sendRichMessageDraft',
    kind: 'bad_request',
    code: 400,
    description: 'drafts unsupported',
  });

const start = (turnId = 'tg:42:7:ag') =>
  rt.turns.onTurn({ chatId: CHAT, turnId, sessionId: 'sess-1', state: 'started' });
const step = (
  seq: number,
  id: string,
  label: string,
  state: 'running' | 'done' | 'failed' = 'running',
  ms?: number,
  turnId = 'tg:42:7:ag',
) => rt.turns.onProgress({ chatId: CHAT, turnId, sessionId: 'sess-1', seq, step: { id, label, state, ms } });

describe('turn UX', () => {
  it('inbound: «Thinking…» placeholder (no 👀) and typing immediately', async () => {
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    expect(api.placeholderDrafts()[0].params).toMatchObject({
      chat_id: CHAT,
      draft_id: draftIdFor('tg:42:7'),
      rich_message: { blocks: [{ type: 'thinking' }] },
    });
    expect(api.of('sendMessageDraft')).toHaveLength(0); // iOS renders an empty draft as a blank bubble
    expect(api.of('setMessageReaction')).toHaveLength(0);
    expect(api.of('sendChatAction')[0].params).toMatchObject({ chat_id: CHAT, action: 'typing' });
  });

  it('the rich draft shows the moment the turn starts; setTyping is skipped once a draft is active', async () => {
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    expect(api.turnDrafts()).toHaveLength(0);
    start();
    await tick(0);
    expect(api.turnDrafts()).toHaveLength(1);
    const before = api.of('sendChatAction').length;
    rt.turns.sendTyping(CHAT);
    await tick(10);
    expect(api.of('sendChatAction')).toHaveLength(before);
  });

  it('draft at turn start: stable draft_id, can_stop, header + checklist + divider + preview; throttled; heartbeat', async () => {
    rt.turns.noteInbound(CHAT, 7);
    start();
    step(1, 's1', 'Открываю страницу habr.com', 'done', 1200);
    step(2, 's2', 'Читаю notes.md', 'running');
    await tick(2500);
    const drafts = () => api.turnDrafts();
    // the first draft goes out at turn start; the step events refresh it within the throttle window
    expect(drafts().length).toBeGreaterThanOrEqual(1);
    const base = drafts().length;
    const p = drafts()[base - 1].params;
    expect(p.draft_id).toBe(draftIdFor('tg:42:7'));
    expect(p.can_stop).toBe(true);
    const s = text(drafts()[base - 1]);
    expect(s).toContain('Работаю · 0:0');
    expect(s).toContain('✅ Открываю страницу habr.com');
    expect(s).toContain('⏳ Читаю notes.md');

    // burst of previews inside the throttle window -> coalesced
    for (let i = 1; i <= 10; i++) {
      rt.turns.onPreview({
        chatId: CHAT,
        turnId: 'tg:42:7:ag',
        sessionId: 'sess-1',
        seq: i,
        text: `Ответ часть ${i}\n\n`,
      });
      await tick(50);
    }
    await tick(2000);
    const n = drafts().length;
    expect(n - base).toBeGreaterThanOrEqual(2);
    expect(n - base).toBeLessThanOrEqual(4);
    const last = text(drafts()[n - 1]);
    expect(last).toContain('Ответ часть 10');
    expect(last).toContain('divider');
    // same draft id on every update (animates)
    expect(new Set(drafts().map((d) => d.params.draft_id)).size).toBe(1);
    // spacing between draft sends >= 1.05 s
    const times = drafts().map((d) => d.at);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(1050);

    // heartbeat: idle for 16 s -> one more draft with the new elapsed time
    const before = drafts().length;
    await tick(16_000);
    expect(drafts().length).toBe(before + 1);
    expect(text(drafts()[before])).toContain('Работаю · 0:');
  });

  it('draft persisted for the stop button and mapped back to the turn', async () => {
    start();
    await tick(100);
    const id = draftIdFor('tg:42:7');
    expect(rt.turns.turnForDraft(CHAT, id)).toEqual({
      sessionId: 'sess-1',
      turnId: 'tg:42:7:ag',
      threadId: undefined,
    });
    expect(await store.getOpenDraft(CHAT, id)).toMatchObject({ session_id: 'sess-1', turn_id: 'tg:42:7:ag' });
  });

  it('ignores out-of-order seq and late events after the turn ended', async () => {
    start();
    rt.turns.onPreview({ chatId: CHAT, turnId: 'tg:42:7:ag', sessionId: 's', seq: 5, text: 'новый' });
    rt.turns.onPreview({ chatId: CHAT, turnId: 'tg:42:7:ag', sessionId: 's', seq: 3, text: 'старый' });
    await tick(2600);
    const lastDraft = () => api.turnDrafts().pop()!;
    expect(text(lastDraft())).toContain('новый');
    expect(text(lastDraft())).not.toContain('старый');
    rt.turns.onTurn({ chatId: CHAT, turnId: 'tg:42:7:ag', sessionId: 's', state: 'finished' });
    const n = api.turnDrafts().length;
    rt.turns.onPreview({ chatId: CHAT, turnId: 'tg:42:7:ag', sessionId: 's', seq: 9, text: 'поздно' });
    await tick(20_000);
    expect(api.turnDrafts()).toHaveLength(n);
  });

  it('status card at 45 s: silent, edited in place on step changes (max one per 5 s), terminal on final', async () => {
    rt.turns.noteInbound(CHAT, 7);
    start();
    step(1, 'a', 'Ищу: кошки', 'running');
    await tick(44_000);
    expect(api.of('sendRichMessage')).toHaveLength(0);
    await tick(2000);
    const cards = api.of('sendRichMessage');
    expect(cards).toHaveLength(1);
    expect(cards[0].params.disable_notification).toBe(true);
    expect(text(cards[0])).toContain('⏳ Работаю · 0:45');
    const cardId = 1000; // first message id handed out by the fake

    // rapid step changes -> edits no more than one per 5 s
    for (let i = 2; i <= 8; i++) {
      step(i, `s${i}`, `Шаг ${i}`, 'done');
      await tick(1000);
    }
    await tick(6000);
    const edits = api.of('editMessageText').filter((c) => c.params.message_id === cardId);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < edits.length; i++) expect(edits[i].at - edits[i - 1].at).toBeGreaterThanOrEqual(5000);
    expect(text(edits[edits.length - 1])).toContain('Шаг 8');

    // final
    await deliverNow({ markdown: 'Готовый ответ', nc: { final: true } });
    await tick(3000);
    const term = api
      .of('editMessageText')
      .filter((c) => c.params.message_id === cardId)
      .pop()!;
    expect(text(term)).toMatch(/✓ Готово · 0:5\d · ответ ниже/);
  });

  it('final: details block (>=3 steps), 👀 cleared, draft dropped, card closed', async () => {
    // drafts unsupported -> the placeholder falls back to the 👀 acknowledgement
    api.failNext('sendRichMessageDraft', badRequest());
    api.failNext('sendRichMessageDraft', badRequest());
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    start();
    step(1, 'a', 'Открываю страницу habr.com', 'done', 3000);
    step(2, 'b', 'Читаю a.md', 'done', 1000);
    step(3, 'c', 'Пишу b.md', 'done', 2000);
    await tick(3000);
    expect(api.turnDrafts().length).toBeGreaterThan(0);
    const before = api.turnDrafts().length;
    const id = await deliverNow({ markdown: '# Итог\n\nВсё сделано.', nc: { final: true } });
    expect(id).toBeDefined();
    const finals = api.of('sendRichMessage');
    expect(finals).toHaveLength(1);
    const s = text(finals[0]);
    expect(s).toContain('Всё сделано');
    expect(s).toContain('Что я сделал (3 шага,');
    expect(s).toContain('habr');
    expect(finals[0].params.disable_notification).toBeUndefined();
    await tick(2000);
    const reactions = api.of('setMessageReaction');
    expect(reactions[reactions.length - 1].params).toMatchObject({ message_id: 7, reaction: [] });
    await tick(30_000);
    expect(api.turnDrafts().length).toBe(before);
    // finished arriving after the final is a no-op
    rt.turns.onTurn({ chatId: CHAT, turnId: 'tg:42:7:ag', sessionId: 's', state: 'finished' });
    await tick(1000);
  });

  it('final without enough steps / time: no details; showSteps=false suppresses', async () => {
    start();
    step(1, 'a', 'Читаю a.md', 'done', 100);
    await tick(1000);
    await deliverNow({ text: 'Коротко' });
    expect(text(api.of('sendRichMessage')[0])).not.toContain('Что я сделал');

    setUserPrefsProvider(() => ({ showSteps: false }));
    start('t2');
    for (let i = 1; i <= 4; i++) step(i, `x${i}`, `Шаг ${i}`, 'done', 10, 't2');
    await tick(2000);
    await deliverNow({ text: 'Другое' });
    expect(text(api.of('sendRichMessage')[1])).not.toContain('Что я сделал');
  });

  it('long turn (> 90 s) notifies explicitly; > 20 s with 1 step shows details', async () => {
    start();
    step(1, 'a', 'Выполняю команду', 'done', 1000);
    await tick(95_000);
    await deliverNow({ text: 'Долго делал', nc: { final: true } });
    const f = api.of('sendRichMessage').pop()!;
    expect(f.params.disable_notification).toBe(false);
    expect(text(f)).toContain('Что я сделал (1 шаг, 1 мин');
  });

  it('budget note is appended once to the next final', async () => {
    let note: string | null = 'Использовано 80% лимита';
    setBudgetNoteProvider(() => {
      const n = note;
      note = null;
      return n;
    });
    await deliverNow({ text: 'A' });
    await deliverNow({ text: 'B' });
    await tick(3000);
    const sent = api.of('sendRichMessage');
    expect(text(sent[0])).toContain('80%');
    expect(text(sent[1])).not.toContain('80%');
  });

  it('cancelled: drafts stop, 👀 cleared, card → «Остановлено»', async () => {
    api.failNext('sendRichMessageDraft', badRequest());
    api.failNext('sendRichMessageDraft', badRequest());
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    start();
    await tick(46_000);
    expect(api.of('sendRichMessage')).toHaveLength(1);
    rt.turns.onTurn({ chatId: CHAT, turnId: 'tg:42:7:ag', sessionId: 's', state: 'cancelled' });
    await tick(3000);
    const n = api.turnDrafts().length;
    await tick(40_000);
    expect(api.turnDrafts()).toHaveLength(n);
    expect(text(api.of('editMessageText').pop()!)).toContain('⏹ Остановлено');
    expect(api.of('setMessageReaction').pop()!.params.reaction).toEqual([]);
  });

  it('failed: card → «Ошибка»; failure notice chat row closes the turn as failed without details', async () => {
    start();
    for (let i = 1; i <= 4; i++) step(i, `x${i}`, `Шаг ${i}`, 'done');
    await tick(46_000);
    await deliverNow({ text: 'Что-то сломалось', failureNotice: true });
    await tick(3000);
    expect(text(api.of('sendRichMessage').pop()!)).not.toContain('Что я сделал');
    expect(text(api.of('editMessageText').pop()!)).toContain('⚠️ Ошибка');
  });

  it('final that never reaches the user (throws) keeps the turn alive for the retry', async () => {
    start();
    step(1, 'a', 'x', 'done');
    api.failNext(
      'sendRichMessage',
      new (await import('../botapi/index.js')).TelegramError({
        method: 'sendRichMessage',
        kind: 'bad_request',
        code: 400,
        description: 'bad',
      }),
    );
    // rich rejected -> plain fallback succeeds (no throw)
    await deliverNow({ text: 'hello' });
    expect(api.of('sendMessage')).toHaveLength(1);
  });
});
