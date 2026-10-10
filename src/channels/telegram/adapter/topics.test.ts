/** Private-chat topics = separate conversations, and the «Thinking…» placeholder that replaces the 👀. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError, type Message, type Update } from '../botapi/index.js';
import type { ChannelSetup, InboundMessage } from '../../adapter.js';
import { Deliverer } from './deliver.js';
import { FakeApi } from './fakes.js';
import { draftIdFor } from './format.js';
import { resetHooks, setStopHandler, setUserPrefsProvider, setBudgetNoteProvider } from './hooks.js';
import { Ingress } from './ingress.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { MemoryStore } from './store.js';

const CHAT = 100;
const PLATFORM = `telegram:${CHAT}`;

let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let del: Deliverer;
let ing: Ingress;
let inbound: Array<{ platformId: string; threadId: string | null; msg: InboundMessage }>;
let actions: unknown[][];
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const host: ChannelSetup = {
  onInbound: (platformId, threadId, msg) => void inbound.push({ platformId, threadId, msg }),
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: (...a) => void actions.push(a),
};

let uid = 1;
const msg = (over: Record<string, unknown> = {}) =>
  ({
    message_id: uid++,
    from: { id: CHAT, is_bot: false, first_name: 'Илья' },
    chat: { id: CHAT, type: 'private' },
    date: 1_700_000_000,
    ...over,
  }) as unknown as Message;
const topicMsg = (thread: number, over: Record<string, unknown> = {}) =>
  msg({ message_thread_id: thread, is_topic_message: true, ...over });
const upd = (u: Omit<Update, 'update_id'>): Update => ({ update_id: uid++, ...u });
async function feed(u: Update) {
  await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now());
  const p = ing.dispatch(u.update_id, u);
  await tick(2000);
  await p;
}
const start = (turnId: string, threadId?: number, sessionId = 'sess-1') =>
  rt.turns.onTurn({ chatId: CHAT, threadId, turnId, sessionId, state: 'started' });
const finish = (turnId: string, threadId?: number) =>
  rt.turns.onTurn({ chatId: CHAT, threadId, turnId, sessionId: 'sess-1', state: 'finished' });
const badRequest = (method: string) =>
  new TelegramError({ method, kind: 'bad_request', code: 400, description: 'not supported' });

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  setUserPrefsProvider(() => ({ showSteps: true }));
  setBudgetNoteProvider(() => null);
  inbound = [];
  actions = [];
  api = new FakeApi();
  store = new MemoryStore();
  rt = createRuntime({ api: api.asBotApi(), store, ownerId: CHAT, botUsername: 'test_bot' });
  setRuntime(rt);
  ing = new Ingress(rt, host);
  del = new Deliverer(rt);
});
afterEach(() => {
  ing.shutdown();
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  resetHooks();
  vi.useRealTimers();
});

describe('topic = its own conversation', () => {
  it('a message in topic 7 reaches the host with threadId "7"; outside a topic it is null', async () => {
    await feed(upd({ message: topicMsg(7, { text: 'в теме' }) }));
    await feed(upd({ message: msg({ text: 'вне темы' }) }));
    expect(inbound.map((i) => i.threadId)).toEqual(['7', null]);
  });

  it('media and photos keep the topic', async () => {
    api.files.set('f1', { path: 'p/a.png', data: Buffer.from('x') });
    await feed(upd({ message: topicMsg(7, { photo: [{ file_id: 'f1', file_unique_id: 'u', width: 1, height: 1 }] }) }));
    expect(inbound[0].threadId).toBe('7');
  });

  it('every outgoing call of the reply carries message_thread_id 7', async () => {
    await feed(upd({ message: topicMsg(7, { text: 'привет' }) }));
    const mid = (inbound[0].msg.content as { nc: { tgMessageId: number } }).nc.tgMessageId;
    start(`tg:${CHAT}:${mid}`, 7);
    await tick(100);
    const p = del.deliver(PLATFORM, '7', {
      kind: 'chat',
      content: { markdown: 'Ответ\n\nВторой абзац', nc: { final: true } },
      files: [{ filename: 'a.txt', data: Buffer.from('x') }],
    });
    await tick(5000);
    await p;
    const threaded = ['sendChatAction', 'sendRichMessageDraft', 'sendRichMessage', 'sendDocument'];
    for (const method of threaded) {
      expect(api.of(method).length, method).toBeGreaterThan(0);
      for (const c of api.of(method)) expect(c.params.message_thread_id, method).toBe(7);
    }
  });

  it('reserved thread ids never reach Telegram as threads', async () => {
    const p = del.deliver(PLATFORM, 'system:tasks:abc', { kind: 'chat', content: { markdown: 'Сводка' } });
    await tick(3000);
    await p;
    expect(api.of('sendRichMessage')[0].params).not.toHaveProperty('message_thread_id');
  });

  it('two topics have independent active turns that do not supersede each other', async () => {
    start(`tg:${CHAT}:11`, 7, 'sess-7');
    start(`tg:${CHAT}:12`, 8, 'sess-8');
    start(`tg:${CHAT}:13`, undefined, 'sess-g');
    await tick(3500); // drafts of one chat are spaced ~1 s apart
    expect(rt.turns.hasActiveTurn(CHAT, 7)).toBe(true);
    expect(rt.turns.hasActiveTurn(CHAT, 8)).toBe(true);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    const drafts = api.of('sendRichMessageDraft');
    expect(new Set(drafts.map((d) => d.params.message_thread_id))).toEqual(new Set([7, 8, undefined]));
    // topic 7 finishes: the others keep running
    finish(`tg:${CHAT}:11`, 7);
    expect(rt.turns.hasActiveTurn(CHAT, 7)).toBe(false);
    expect(rt.turns.hasActiveTurn(CHAT, 8)).toBe(true);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    // a final addressed to topic 8 closes only topic 8
    const p = del.deliver(PLATFORM, '8', { kind: 'chat', content: { markdown: 'Готово', nc: { final: true } } });
    await tick(5000);
    await p;
    expect(rt.turns.hasActiveTurn(CHAT, 8)).toBe(false);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    expect(rt.turns.turnForDraft(CHAT, draftIdFor(`tg:${CHAT}:13`))).toMatchObject({ sessionId: 'sess-g' });
  });

  it('commands and callbacks act on their own topic: question buttons answer into it', async () => {
    const p = del.deliver(PLATFORM, '7', {
      kind: 'chat',
      content: { type: 'ask_question', questionId: 'q1', title: 'T', question: 'Q?', options: ['Да', 'Нет'] },
    });
    await tick(3000);
    await p;
    const card = api.of('sendRichMessage')[0];
    expect(card.params.message_thread_id).toBe(7);
    const data = card.params.reply_markup.inline_keyboard[0][0].callback_data as string;
    await feed(
      upd({
        callback_query: {
          id: 'cb',
          from: { id: CHAT, is_bot: false, first_name: 'Илья' },
          chat_instance: 'x',
          data,
          message: {
            message_id: 5,
            message_thread_id: 7,
            is_topic_message: true,
            chat: { id: CHAT, type: 'private' },
            date: 1,
          },
        },
      } as never),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0][3]).toMatchObject({ platformId: PLATFORM, threadId: '7' });
  });

  it('stop in a topic targets that topic: its turn, not the others', async () => {
    const stopped: Array<{ sessionId: string; turnId: string }> = [];
    setStopHandler(async (t) => void stopped.push(t));
    start(`tg:${CHAT}:11`, 7, 'sess-7');
    start(`tg:${CHAT}:12`, 8, 'sess-8');
    await tick(100);
    const before8 = api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 8).length;
    await feed(
      upd({
        stopped_message_generation: {
          chat: { id: CHAT, type: 'private' },
          message_thread_id: 7,
          draft_id: draftIdFor(`tg:${CHAT}:11`),
        },
      } as never),
    );
    expect(stopped).toEqual([{ chatId: CHAT, sessionId: 'sess-7', turnId: `tg:${CHAT}:11` }]);
    // topic 7's drafts are off; topic 8 keeps its heartbeat
    const n7 = api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 7).length;
    await tick(40_000);
    expect(api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 7)).toHaveLength(n7);
    expect(api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 8).length).toBeGreaterThan(
      before8,
    );
  });

  it('/stop typed in a topic switches off that topic only', async () => {
    start(`tg:${CHAT}:11`, 7);
    start(`tg:${CHAT}:12`, 8);
    await tick(100);
    const p = ing.dispatch(
      uid,
      upd({
        message: topicMsg(7, { text: '/stop', entities: [{ type: 'bot_command', offset: 0, length: 5 }] }),
      }),
    );
    await tick(100);
    await p;
    const n7 = api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 7).length;
    await tick(40_000);
    expect(api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 7)).toHaveLength(n7);
    expect(rt.turns.hasActiveTurn(CHAT, 8)).toBe(true);
  });
});

describe('«Thinking…» placeholder', () => {
  it('is sent on inbound with empty text; the turn’s rich draft reuses the draft id', async () => {
    await feed(upd({ message: msg({ text: 'привет' }) }));
    const mid = (inbound[0].msg.content as { nc: { tgMessageId: number } }).nc.tgMessageId;
    const ph = api.placeholderDrafts();
    expect(ph).toHaveLength(1);
    expect(ph[0].params).toMatchObject({
      chat_id: CHAT,
      draft_id: draftIdFor(`tg:${CHAT}:${mid}`),
      rich_message: { blocks: [{ type: 'thinking' }] },
    });
    expect(api.of('sendMessageDraft')).toHaveLength(0);
    expect(api.of('setMessageReaction')).toHaveLength(0);
    start(`tg:${CHAT}:${mid}:ag`);
    await tick(0);
    expect(api.turnDrafts()[0].params.draft_id).toBe(ph[0].params.draft_id);
  });

  it('is re-sent before it expires (every 20 s) and given up after 2 minutes', async () => {
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    await tick(20_000);
    expect(api.placeholderDrafts()).toHaveLength(2);
    await tick(60_000);
    expect(api.placeholderDrafts().length).toBeGreaterThanOrEqual(5);
    await tick(3 * 60_000);
    const n = api.placeholderDrafts().length;
    expect(n).toBeLessThanOrEqual(8);
    await tick(60_000);
    expect(api.placeholderDrafts()).toHaveLength(n);
  });

  it('stops refreshing once the turn starts', async () => {
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    start(`tg:${CHAT}:7`);
    await tick(60_000);
    expect(api.placeholderDrafts()).toHaveLength(1);
  });

  it('stops refreshing after the final / failure / stop', async () => {
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    const p = del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'быстро', nc: { final: true } } });
    await tick(3000);
    await p;
    const n = api.placeholderDrafts().length;
    await tick(60_000);
    expect(api.placeholderDrafts()).toHaveLength(n);

    rt.turns.noteInbound(CHAT, 9);
    await tick(0);
    rt.turns.disableDrafts(CHAT);
    const m = api.placeholderDrafts().length;
    await tick(60_000);
    expect(api.placeholderDrafts()).toHaveLength(m);
  });

  it('a rejected custom emoji is retried once as a plain block, and later placeholders skip the emoji', async () => {
    api.failNext('sendRichMessageDraft', badRequest('sendRichMessageDraft'));
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    const sent = api.placeholderDrafts();
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0].params)).toContain('custom_emoji');
    expect(JSON.stringify(sent[1].params)).not.toContain('custom_emoji');
    expect(sent[1].params.draft_id).toBe(sent[0].params.draft_id);
    expect(api.of('setMessageReaction')).toHaveLength(0); // the plain block was accepted: no 👀
    // a later conversation goes straight to the plain block
    rt.turns.noteInbound(CHAT, 9, 8);
    await tick(0);
    const later = api.placeholderDrafts().filter((c) => c.params.message_thread_id === 8);
    expect(later).toHaveLength(1);
    expect(JSON.stringify(later[0].params)).not.toContain('custom_emoji');
  });

  it('falls back to 👀 when the placeholder is rejected (emoji and plain block alike)', async () => {
    api.failNext('sendRichMessageDraft', badRequest('sendRichMessageDraft'));
    api.failNext('sendRichMessageDraft', badRequest('sendRichMessageDraft'));
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    expect(api.of('setMessageReaction')[0].params).toMatchObject({ message_id: 7, reaction: [{ emoji: '👀' }] });
    await tick(60_000);
    expect(api.placeholderDrafts()).toHaveLength(2); // emoji + plain attempt, then no more retries
    // the turn clears the 👀 when it ends
    start(`tg:${CHAT}:7`);
    finish(`tg:${CHAT}:7`);
    await tick(2000);
    expect(api.of('setMessageReaction').pop()!.params).toMatchObject({ message_id: 7, reaction: [] });
  });

  it('uses 👀 for a message that arrives while a turn is already running in the same topic', async () => {
    start(`tg:${CHAT}:7`, 7);
    await tick(100);
    rt.turns.noteInbound(CHAT, 8, 7);
    await tick(0);
    expect(api.placeholderDrafts()).toHaveLength(0);
    expect(api.of('setMessageReaction')[0].params).toMatchObject({ message_id: 8, reaction: [{ emoji: '👀' }] });
    // ...while a message in another topic still gets its own placeholder
    rt.turns.noteInbound(CHAT, 9, 8);
    await tick(0);
    expect(api.placeholderDrafts()[0].params).toMatchObject({
      message_thread_id: 8,
      rich_message: { blocks: [{ type: 'thinking' }] },
    });
  });

  it('a second message before the turn starts is acknowledged with 👀 (one placeholder per conversation)', async () => {
    rt.turns.noteInbound(CHAT, 7);
    rt.turns.noteInbound(CHAT, 8);
    await tick(0);
    expect(api.placeholderDrafts()).toHaveLength(1);
    expect(api.of('setMessageReaction')[0].params).toMatchObject({ message_id: 8 });
  });

  it('a blocked chat is not retried and gets no reaction', async () => {
    api.failNext(
      'sendRichMessageDraft',
      new TelegramError({ method: 'sendRichMessageDraft', kind: 'forbidden', code: 403, description: 'blocked' }),
    );
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    expect(api.of('setMessageReaction')).toHaveLength(0);
    expect(await store.isBlocked(CHAT)).toBe(true);
  });

  it('releaseInbound drops the placeholder of a rejected message', async () => {
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    rt.turns.releaseInbound(CHAT, 7);
    await tick(60_000);
    expect(api.placeholderDrafts()).toHaveLength(1);
    expect(api.of('setMessageReaction')).toHaveLength(0);
  });
});

describe('review fixes', () => {
  it('a message_thread_id without is_topic_message is not a topic', async () => {
    await feed(upd({ message: msg({ message_thread_id: 7, text: 'ответ на сообщение' }) }));
    expect(inbound[0].threadId).toBeNull();
  });

  it('a slash command no product handler took gets no placeholder (👀 instead)', async () => {
    await feed(upd({ message: msg({ text: '/clear', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }) }));
    expect(api.placeholderDrafts()).toHaveLength(0);
    expect(api.of('setMessageReaction')[0].params).toMatchObject({ reaction: [{ emoji: '👀' }] });
  });

  it('stop of a draft uses the thread of the turn that owns it, not the update’s', async () => {
    setStopHandler(async () => {});
    start(`tg:${CHAT}:11`, 7, 'sess-7');
    start(`tg:${CHAT}:12`, 8, 'sess-8');
    await tick(3500);
    await feed(
      upd({
        stopped_message_generation: { chat: { id: CHAT, type: 'private' }, draft_id: draftIdFor(`tg:${CHAT}:12`) },
      } as never),
    );
    const n8 = api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 8).length;
    await tick(40_000);
    expect(api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 8)).toHaveLength(n8);
    expect(api.of('sendRichMessageDraft').filter((d) => d.params.message_thread_id === 7).length).toBeGreaterThan(1);
  });

  it('a turn whose id is an echo id links to no message and does not collide with the original', async () => {
    api.failNext('sendRichMessageDraft', badRequest('sendRichMessageDraft'));
    api.failNext('sendRichMessageDraft', badRequest('sendRichMessageDraft'));
    rt.turns.noteInbound(CHAT, 5, 7); // topic 7: 👀 fallback on message 5
    await tick(0);
    start(`tg:${CHAT}:5:echo:sess-b`, 8);
    await tick(100);
    const draft = api.turnDrafts()[0].params;
    expect(draft.draft_id).not.toBe(draftIdFor(`tg:${CHAT}:5`));
    finish(`tg:${CHAT}:5:echo:sess-b`, 8);
    await tick(2000);
    // topic 8's turn must not clear the 👀 of topic 7's message 5
    expect(api.of('setMessageReaction').filter((c) => c.params.reaction.length === 0)).toHaveLength(0);
  });
});
