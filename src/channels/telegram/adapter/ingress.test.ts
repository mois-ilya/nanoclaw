import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Message, Update } from '../botapi/index.js';
import type { ChannelSetup, InboundMessage } from '../../adapter.js';
import { FakeApi } from './fakes.js';
import {
  resetHooks,
  setCommandHandler,
  setGuestHandler,
  setPrivateGate,
  setProductCallbackHandler,
  setStopHandler,
  setTranscriber,
} from './hooks.js';
import { Ingress } from './ingress.js';
import { Poller } from './poller.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { MemoryStore } from './store.js';
import { TelegramError } from '../botapi/index.js';

const OWNER = 100;
let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let ing: Ingress;
let inbound: Array<{ platformId: string; msg: InboundMessage }>;
let actions: unknown[][];
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const host: ChannelSetup = {
  onInbound: (platformId, _t, msg) => void inbound.push({ platformId, msg }),
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: (...a) => void actions.push(a),
};

let uid = 1;
const user = (id = OWNER) => ({ id, is_bot: false, first_name: 'Илья', username: 'ilya' });
const msg = (over: Record<string, unknown> = {}, from = OWNER, id = uid++) =>
  ({
    message_id: id,
    from: user(from),
    chat: { id: from, type: 'private' },
    date: 1_700_000_000,
    ...over,
  }) as unknown as Message;
const upd = (u: Omit<Update, 'update_id'>): Update => ({ update_id: uid++, ...u });
async function feed(u: Update) {
  await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now());
  const p = ing.dispatch(u.update_id, u);
  await tick(2000);
  await p;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  inbound = [];
  actions = [];
  api = new FakeApi();
  store = new MemoryStore();
  rt = createRuntime({ api: api.asBotApi(), store, ownerId: OWNER, botUsername: 'test_bot' });
  setRuntime(rt);
  ing = new Ingress(rt, host);
});
afterEach(() => {
  ing.shutdown();
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  resetHooks();
  vi.useRealTimers();
});

describe('private message pipeline', () => {
  it('route: «Thinking…» placeholder + typing, then onInbound with the contract content shape', async () => {
    await feed(
      upd({
        message: msg({
          text: 'привет',
          reply_to_message: { message_id: 3, text: 'раньше', chat: { id: OWNER, type: 'private' }, date: 1 },
        }),
      }),
    );
    expect(api.placeholderDrafts()[0].params).toMatchObject({
      chat_id: OWNER,
      rich_message: { blocks: [{ type: 'thinking' }] },
    });
    expect(api.of('setMessageReaction')).toHaveLength(0);
    expect(api.of('sendChatAction')).toHaveLength(1);
    expect(inbound).toHaveLength(1);
    const { platformId, msg: m } = inbound[0];
    expect(platformId).toBe(`telegram:${OWNER}`);
    expect(m).toMatchObject({ kind: 'chat', isMention: true, isGroup: false });
    expect(m.id).toMatch(/^tg:100:\d+$/);
    expect(m.content).toMatchObject({
      text: 'привет',
      senderId: 'telegram:100',
      sender: 'Илья',
      senderName: 'Илья',
      replyTo: { id: 'tg:100:3', text: 'раньше' },
      nc: { chatId: OWNER },
    });
  });

  it('default gate (no product module): owner only, nothing for strangers', async () => {
    await feed(upd({ message: msg({ text: 'hi' }, 555) }));
    expect(inbound).toHaveLength(0);
    expect(api.of('setMessageReaction')).toHaveLength(0);
  });

  it('gate handled → nothing downloaded, no ack, no inbound; gate sees every message', async () => {
    const gate = vi.fn(async () => ({ action: 'handled' as const }));
    setPrivateGate(gate);
    await feed(upd({ message: msg({ text: 'a' }, 7) }));
    await feed(upd({ message: msg({ text: 'b' }, 7) }));
    expect(gate).toHaveBeenCalledTimes(2);
    expect(inbound).toHaveLength(0);
    expect(api.calls.filter((c) => c.method !== 'getMe')).toHaveLength(0);
  });

  it('route-with-content patches content but never senderId', async () => {
    setPrivateGate(async () => ({
      action: 'route-with-content',
      content: { text: 'патч', senderId: 'telegram:1', extra: 1 },
    }));
    await feed(upd({ message: msg({ text: 'a' }, 7) }));
    expect(inbound[0].msg.content).toMatchObject({ text: 'патч', senderId: 'telegram:7', extra: 1 });
  });

  it('dedupes redelivered messages', async () => {
    const m = msg({ text: 'once' });
    await feed(upd({ message: m }));
    await feed(upd({ message: m }));
    expect(inbound).toHaveLength(1);
  });

  it('product commands go to the command handler (after the gate); handled → not routed, no ack', async () => {
    setCommandHandler(async (_c, command, args) => command === 'start' && args === 'inv_x');
    await feed(
      upd({ message: msg({ text: '/start inv_x', entities: [{ type: 'bot_command', offset: 0, length: 6 }] }) }),
    );
    expect(inbound).toHaveLength(0);
    expect(api.of('setMessageReaction')).toHaveLength(0);
  });

  it('unknown commands pass to the agent as text', async () => {
    setCommandHandler(async () => false);
    await feed(upd({ message: msg({ text: '/wat 1', entities: [{ type: 'bot_command', offset: 0, length: 4 }] }) }));
    expect(inbound[0].msg.content).toMatchObject({ text: '/wat 1' });
  });

  it('voice: transcribed, prefixed, voice block; long voice rejected before download', async () => {
    api.files.set('v1', { path: 'voice/1.oga', data: Buffer.from('ogg') });
    const tr = vi.fn(async () => ({ text: 'напомни завтра', lang: 'ru' }));
    setTranscriber(tr);
    await feed(upd({ message: msg({ voice: { file_id: 'v1', duration: 23, file_size: 100 } }) }));
    expect(tr).toHaveBeenCalledOnce();
    expect(inbound[0].msg.content).toMatchObject({
      text: '[голосовое, 23 с] напомни завтра',
      voice: { durationS: 23, transcript: 'напомни завтра', lang: 'ru' },
    });

    await feed(upd({ message: msg({ voice: { file_id: 'v1', duration: 301 } }) }));
    expect(inbound).toHaveLength(1);
    expect(JSON.stringify(api.of('sendRichMessage').pop()!.params)).toContain('слишком длинная');
    // 👀 released
    expect(api.of('setMessageReaction').pop()!.params.reaction).toEqual([]);
  });

  it.each([
    ['empty', 'Не расслышал'],
    ['failed', 'Не получилось расшифровать'],
    ['budget', 'Лимит'],
  ] as const)('transcriber error %s → UX copy, no inbound', async (error, copy) => {
    api.files.set('v1', { path: 'voice/1.oga', data: Buffer.from('ogg') });
    setTranscriber(async () => ({ error }));
    await feed(upd({ message: msg({ voice: { file_id: 'v1', duration: 5 } }) }));
    expect(inbound).toHaveLength(0);
    expect(JSON.stringify(api.of('sendRichMessage').pop()!.params)).toContain(copy);
  });

  it('document > 20 MB → copy, never downloaded', async () => {
    await feed(
      upd({
        message: msg({
          document: { file_id: 'd', file_unique_id: 'd', file_size: 25 * 1024 * 1024, file_name: 'big.zip' },
        }),
      }),
    );
    expect(inbound).toHaveLength(0);
    expect(api.of('getFile')).toHaveLength(0);
    expect(JSON.stringify(api.of('sendRichMessage').pop()!.params)).toContain('20 МБ');
  });

  it('photo + caption → attachment base64', async () => {
    api.files.set('p2', { path: 'photos/2.jpg', data: Buffer.from('jpegdata') });
    await feed(
      upd({
        message: msg({
          caption: 'смотри',
          photo: [
            { file_id: 'p1', file_unique_id: 'p1', width: 10, height: 10 },
            { file_id: 'p2', file_unique_id: 'p2', width: 100, height: 100, file_size: 8 },
          ],
        }),
      }),
    );
    const c = inbound[0].msg.content as {
      text: string;
      attachments: Array<{ name: string; data: string; mimeType: string }>;
    };
    expect(c.text).toBe('смотри');
    expect(c.attachments[0]).toMatchObject({
      mimeType: 'image/jpeg',
      data: Buffer.from('jpegdata').toString('base64'),
    });
  });

  it('media group is debounced 1.5 s into ONE inbound event; gate still sees each message', async () => {
    api.files.set('a', { path: 'p/a.jpg', data: Buffer.from('A') });
    api.files.set('b', { path: 'p/b.jpg', data: Buffer.from('B') });
    const gate = vi.fn(async () => ({ action: 'route' as const }));
    setPrivateGate(gate);
    const mk = (fid: string, extra = {}) =>
      upd({
        message: msg({
          media_group_id: 'g1',
          photo: [{ file_id: fid, file_unique_id: fid, width: 1, height: 1 }],
          ...extra,
        }),
      });
    const u1 = mk('a', { caption: 'альбом' });
    const u2 = mk('b');
    await store.saveUpdate(u1.update_id, '{}', 0);
    await store.saveUpdate(u2.update_id, '{}', 0);
    const p = [ing.dispatch(u1.update_id, u1), ing.dispatch(u2.update_id, u2)];
    await tick(1000);
    expect(inbound).toHaveLength(0);
    await tick(1000);
    await Promise.all(p);
    expect(gate).toHaveBeenCalledTimes(2);
    expect(inbound).toHaveLength(1);
    const c = inbound[0].msg.content as { text: string; attachments: unknown[] };
    expect(c.attachments).toHaveLength(2);
    expect(c.text).toBe('альбом');
  });

  it('album members stay unfinished in the journal until the album is routed (a restart replays them)', async () => {
    api.files.set('a', { path: 'p/a.jpg', data: Buffer.from('A') });
    setPrivateGate(async () => ({ action: 'route' as const }));
    const u1 = upd({
      message: msg({ media_group_id: 'g9', photo: [{ file_id: 'a', file_unique_id: 'a', width: 1, height: 1 }] }),
    });
    await store.saveUpdate(u1.update_id, '{}', 0);
    const p = ing.dispatch(u1.update_id, u1);
    await tick(1000); // inside the debounce window
    expect((await store.loadPending()).map((x) => x.update_id)).toContain(u1.update_id);
    await tick(1000);
    await p;
    expect((await store.loadPending()).map((x) => x.update_id)).not.toContain(u1.update_id);
  });

  it('group chats: bot leaves; guest messages are not group messages', async () => {
    await feed(upd({ message: { ...msg({ text: 'x' }), chat: { id: -9, type: 'supergroup' } } as never }));
    expect(api.of('leaveChat')).toHaveLength(1);
    expect(inbound).toHaveLength(0);
    await feed(upd({ message: { ...msg({ text: 'x' }), chat: { id: -9, type: 'supergroup' } } as never }));
    expect(api.of('leaveChat')).toHaveLength(1);
  });

  it('edited_message is ignored', async () => {
    await feed(upd({ edited_message: msg({ text: 'x' }) }));
    expect(inbound).toHaveLength(0);
  });

  it('blocked chat is unblocked by a new message', async () => {
    await store.setBlocked(OWNER, true, 0);
    await feed(upd({ message: msg({ text: 'я вернулся' }) }));
    await tick(10);
    expect(await store.isBlocked(OWNER)).toBe(false);
  });
});

describe('callbacks, guest, stop, membership', () => {
  const cb = (data: string, chat = OWNER) =>
    upd({
      callback_query: {
        id: `cq${uid}`,
        from: user(OWNER),
        chat_instance: 'c',
        data,
        message: { message_id: 55, chat: { id: chat, type: 'private' }, date: 1 },
      },
    });

  it('q: button → answerCallbackQuery + onAction(questionId, value, user, address)', async () => {
    await store.saveCallback({
      short_id: 'abcd1234',
      question_id: 'Q',
      value: 'approve',
      chat_id: OWNER,
      created_at: 0,
      expires_at: Date.now() + 1e6,
    });
    await feed(upd({ callback_query: cb('q:abcd1234').callback_query }));
    expect(api.of('answerCallbackQuery')).toHaveLength(1);
    expect(actions).toEqual([
      ['Q', 'approve', `telegram:${OWNER}`, { messageId: '55', platformId: `telegram:${OWNER}`, threadId: null }],
    ]);
  });

  it('expired / foreign-chat q: button is refused', async () => {
    await store.saveCallback({
      short_id: 'old',
      question_id: 'Q',
      value: 'v',
      chat_id: OWNER,
      created_at: 0,
      expires_at: 1,
    });
    await feed(cb('q:old'));
    await store.saveCallback({
      short_id: 'other',
      question_id: 'Q',
      value: 'v',
      chat_id: 999,
      created_at: 0,
      expires_at: Date.now() + 1e6,
    });
    await feed(cb('q:other'));
    expect(actions).toHaveLength(0);
    expect(api.of('answerCallbackQuery')).toHaveLength(2);
  });

  it('p: buttons go to the product handler; toast is shown', async () => {
    const h = vi.fn(async () => ({ toast: 'Готово' }));
    setProductCallbackHandler(h);
    await feed(cb('p:ap:12'));
    expect(h).toHaveBeenCalledOnce();
    expect(api.of('answerCallbackQuery')[0].params.text).toBe('Готово');
  });

  it('guest_message: deduped by guest_query_id', async () => {
    const h = vi.fn(async () => {});
    setGuestHandler(h);
    const g = { ...msg({ text: '@bot помоги' }), guest_query_id: 'gq1' } as never;
    await feed(upd({ guest_message: g }));
    await feed(upd({ guest_message: g }));
    expect(h).toHaveBeenCalledOnce();
  });

  it('stopped_message_generation: resolves draft → turn → stop handler; ignored without an active turn', async () => {
    const stop = vi.fn(async () => {});
    setStopHandler(stop);
    const { draftIdFor } = await import('./format.js');
    await feed(upd({ stopped_message_generation: { chat: { id: OWNER, type: 'private' }, draft_id: 12345 } }));
    expect(stop).not.toHaveBeenCalled();
    rt.turns.onTurn({ chatId: OWNER, turnId: 'T1', sessionId: 'S1', state: 'started' });
    await tick(2600);
    await feed(
      upd({ stopped_message_generation: { chat: { id: OWNER, type: 'private' }, draft_id: draftIdFor('T1') } }),
    );
    expect(stop).toHaveBeenCalledWith({ chatId: OWNER, sessionId: 'S1', turnId: 'T1' });
  });

  it('stop mapping survives a restart via the persisted draft row', async () => {
    const stop = vi.fn(async () => {});
    setStopHandler(stop);
    await store.saveDraft({
      chat_id: OWNER,
      draft_id: 777,
      turn_id: 'T9',
      session_id: 'S9',
      status_message_id: null,
      created_at: 0,
      closed_at: null,
    });
    await feed(upd({ stopped_message_generation: { chat: { id: OWNER, type: 'private' }, draft_id: 777 } }));
    expect(stop).toHaveBeenCalledWith({ chatId: OWNER, sessionId: 'S9', turnId: 'T9' });
  });

  it('my_chat_member: private kicked/member toggles blocked; group add → leave', async () => {
    await feed(
      upd({ my_chat_member: { chat: { id: OWNER, type: 'private' }, new_chat_member: { status: 'kicked' } } }),
    );
    await tick(10);
    expect(await store.isBlocked(OWNER)).toBe(true);
    await feed(
      upd({ my_chat_member: { chat: { id: OWNER, type: 'private' }, new_chat_member: { status: 'member' } } }),
    );
    await tick(10);
    expect(await store.isBlocked(OWNER)).toBe(false);
    await feed(upd({ my_chat_member: { chat: { id: -5, type: 'group' }, new_chat_member: { status: 'member' } } }));
    expect(api.of('leaveChat')).toHaveLength(1);
  });
});

describe('Poller', () => {
  it('journals updates before processing, advances the offset, replays unfinished ones after restart', async () => {
    const u1 = upd({ message: msg({ text: 'one' }) });
    const u2 = upd({ message: msg({ text: 'two' }) });
    api.updates.push([u1, u2]);
    const poller = new Poller(rt, ing, { conflictBackoffMs: 100 });
    poller.start();
    await tick(10);
    expect(store.updates.has(u1.update_id)).toBe(true);
    expect(inbound.map((i) => (i.msg.content as { text: string }).text)).toEqual(['one', 'two']);
    expect(store.updates.get(u1.update_id)!.status).toBe('done');
    await tick(10);
    const polls = api.of('getUpdates');
    expect(polls[0].params.offset).toBeUndefined();
    expect(polls[0].params).toMatchObject({ timeout: 50 });
    expect(polls[0].params.allowed_updates).toEqual([
      'message',
      'edited_message',
      'callback_query',
      'guest_message',
      'stopped_message_generation',
      'my_chat_member',
    ]);
    expect(polls[1].params.offset).toBe(u2.update_id + 1);
    await poller.stop();

    // restart with an unfinished journal row
    const u3 = upd({ message: msg({ text: 'three' }) });
    await store.saveUpdate(u3.update_id, JSON.stringify(u3), 0);
    inbound = [];
    const ing2 = new Ingress(rt, host);
    const p2 = new Poller(rt, ing2);
    p2.start();
    await tick(10);
    expect(inbound.map((i) => (i.msg.content as { text: string }).text)).toEqual(['three']);
    await p2.stop();
  });

  it('409 conflict backs off 30 s instead of hammering', async () => {
    api.failNext(
      'getUpdates',
      new TelegramError({ method: 'getUpdates', kind: 'conflict', code: 409, description: 'Conflict' }),
    );
    const poller = new Poller(rt, ing);
    poller.start();
    await tick(10);
    expect(api.of('getUpdates')).toHaveLength(1);
    await tick(29_000);
    expect(api.of('getUpdates')).toHaveLength(1);
    await tick(1500);
    expect(api.of('getUpdates').length).toBeGreaterThanOrEqual(2);
    await poller.stop();
  });

  it('duplicate update ids are not processed twice', async () => {
    const u = upd({ message: msg({ text: 'dup' }) });
    api.updates.push([u], [u]);
    const poller = new Poller(rt, ing);
    poller.start();
    await tick(50);
    expect(inbound).toHaveLength(1);
    await poller.stop();
  });
});
