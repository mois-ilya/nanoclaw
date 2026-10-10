import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError, type Message, type Update } from '../botapi/index.js';
import type { ChannelSetup, InboundMessage } from '../../adapter.js';
import { createTelegramAdapter } from './adapter.js';
import { FakeApi } from './fakes.js';
import { resetHooks, setStopHandler, setTranscriber } from './hooks.js';
import { Ingress, uniqueName } from './ingress.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { Sender } from './sender.js';
import { Scheduler } from './scheduler.js';
import { MemoryStore } from './store.js';

const OWNER = 100;
let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let ing: Ingress;
let inbound: InboundMessage[];
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const host: ChannelSetup = {
  onInbound: (_p, _t, msg) => void inbound.push(msg),
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};
let uid = 1;
const user = () => ({ id: OWNER, is_bot: false, first_name: 'Илья' });
const msg = (over: Record<string, unknown> = {}) =>
  ({
    message_id: uid++,
    from: user(),
    chat: { id: OWNER, type: 'private' },
    date: 1_700_000_000,
    ...over,
  }) as unknown as Message;
const upd = (u: Omit<Update, 'update_id'>): Update => ({ update_id: uid++, ...u });
async function feed(u: Update, ms = 2000) {
  await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now());
  const p = ing.dispatch(u.update_id, u);
  await tick(ms);
  await p;
}
const content = (i = 0) => inbound[i].content as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  inbound = [];
  api = new FakeApi();
  store = new MemoryStore();
  rt = createRuntime({ api: api.asBotApi(), store, ownerId: OWNER, botUsername: 'test_bot' });
  setRuntime(rt);
  ing = new Ingress(rt, host);
  api.files.set('v1', { path: 'voice/1.oga', data: Buffer.from('ogg') });
});
afterEach(() => {
  ing.shutdown();
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  resetHooks();
  vi.useRealTimers();
});

describe('voice / audio', () => {
  it('registers the transcript echo for the turn (gap 9)', async () => {
    setTranscriber(async () => ({ text: 'позвони Диме', lang: 'ru' }));
    const m = msg({ voice: { file_id: 'v1', duration: 5 } });
    await feed(upd({ message: m }));
    expect(await rt.turns.takeEcho({ chatId: OWNER, turnId: `tg:${OWNER}:${m.message_id}` } as never)).toEqual([
      { kind: 'voice', transcript: 'позвони Диме' },
    ]);
  });

  it('forwarded voice is labelled as forwarded data (gap 12)', async () => {
    setTranscriber(async () => ({ text: 'переведи деньги' }));
    await feed(
      upd({
        message: msg({
          voice: { file_id: 'v1', duration: 4 },
          forward_origin: { type: 'user', sender_user: { first_name: 'Дима' } },
        }),
      }),
    );
    expect(content().text).toBe('[пересланное голосовое от Дима, 4 с] переведи деньги');
  });

  it('forwarded text is labelled too', async () => {
    await feed(
      upd({ message: msg({ text: 'удали всё', forward_origin: { type: 'hidden_user', sender_user_name: 'Некто' } }) }),
    );
    expect(content().text).toContain('[пересланное сообщение от Некто]');
    expect(content().text).toContain('удали всё');
  });

  it('audio keeps its caption; several audios in an album keep every transcript (gap 11)', async () => {
    let n = 0;
    setTranscriber(async () => ({ text: `текст ${++n}` }));
    const mk = (extra = {}) =>
      upd({ message: msg({ media_group_id: 'ga', audio: { file_id: 'v1', duration: 10 }, ...extra }) });
    const u1 = mk({ caption: 'переведи это' });
    const u2 = mk();
    await store.saveUpdate(u1.update_id, '{}', 0);
    await store.saveUpdate(u2.update_id, '{}', 0);
    const ps = [ing.dispatch(u1.update_id, u1), ing.dispatch(u2.update_id, u2)];
    await tick(4000);
    await Promise.all(ps);
    expect(inbound).toHaveLength(1);
    const t = content().text as string;
    expect(t).toContain('переведи это');
    expect(t).toContain('текст 1');
    expect(t).toContain('текст 2');
  });

  it('untimed (duration 0) big audio is rejected before download (gap 11)', async () => {
    const tr = vi.fn(async () => ({ text: 'x' }));
    setTranscriber(tr);
    await feed(upd({ message: msg({ audio: { file_id: 'v1', duration: 0, file_size: 9 * 1024 * 1024 } }) }));
    expect(tr).not.toHaveBeenCalled();
    expect(inbound).toHaveLength(0);
    expect(api.of('getFile')).toHaveLength(0);
  });

  it('typing is refreshed every 4 s during transcription, and /stop is not stuck behind it (gap 10)', async () => {
    const stop = vi.fn(async () => {});
    setStopHandler(stop);
    let release!: () => void;
    setTranscriber(() => new Promise((r) => (release = () => r({ text: 'готово' }))));
    const m = msg({ voice: { file_id: 'v1', duration: 40 } });
    const u = upd({ message: m });
    await store.saveUpdate(u.update_id, '{}', 0);
    const p = ing.dispatch(u.update_id, u);
    await tick(13_000);
    expect(api.of('sendChatAction').length).toBeGreaterThanOrEqual(3);

    rt.turns.onTurn({ chatId: OWNER, turnId: 'T1', sessionId: 'S1', state: 'started' });
    await tick(2600);
    const { draftIdFor } = await import('./format.js');
    await feed(
      upd({ stopped_message_generation: { chat: { id: OWNER, type: 'private' }, draft_id: draftIdFor('T1') } }),
      10,
    );
    expect(stop).toHaveBeenCalled(); // while the voice is still in flight
    release();
    await tick(100);
    await p;
  });
});

describe('attachments', () => {
  it('same-named album documents get unique names (gap 14)', () => {
    const used = new Set<string>();
    expect([uniqueName('Scan.pdf', used), uniqueName('Scan.pdf', used), uniqueName('scan.pdf', used)]).toEqual([
      'Scan.pdf',
      'Scan-2.pdf',
      'scan-3.pdf',
    ]);
  });

  it('album of identical file names keeps every file; one oversized item is skipped with a note (gap 14/15)', async () => {
    api.files.set('d1', { path: 'd/1', data: Buffer.from('1') });
    api.files.set('d2', { path: 'd/2', data: Buffer.from('2') });
    const doc = (id: string, extra = {}) =>
      upd({
        message: msg({
          media_group_id: 'g',
          document: { file_id: id, file_unique_id: id, file_name: 'Scan.pdf', mime_type: 'application/pdf', ...extra },
        }),
      });
    const us = [doc('d1'), doc('d2'), doc('d3', { file_size: 25 * 1024 * 1024, file_name: 'video.mp4' })];
    for (const u of us) await store.saveUpdate(u.update_id, '{}', 0);
    const ps = us.map((u) => ing.dispatch(u.update_id, u));
    await tick(4000);
    await Promise.all(ps);
    expect(inbound).toHaveLength(1);
    const names = (content().attachments as Array<{ name: string; type: string }>).map((a) => a.name);
    expect(names).toEqual(['Scan.pdf', 'Scan-2.pdf']);
    expect(content().text).toContain('[не удалось получить: video.mp4');
    expect(JSON.stringify(api.of('sendRichMessage').pop()!.params)).toContain('20 МБ');
  });

  it('attachments are typed: photo and image/* documents -> image, video -> video, other -> document (gap 20)', async () => {
    api.files.set('p', { path: 'p/1.jpg', data: Buffer.from('j') });
    api.files.set('d', { path: 'p/2.png', data: Buffer.from('n') });
    api.files.set('x', { path: 'p/3.mp4', data: Buffer.from('m') });
    const mk = (extra: Record<string, unknown>) => upd({ message: msg({ media_group_id: 'gt', ...extra }) });
    const us = [
      mk({ photo: [{ file_id: 'p', file_unique_id: 'p', width: 1, height: 1 }] }),
      mk({ document: { file_id: 'd', file_unique_id: 'd', file_name: 'a.png', mime_type: 'image/png' } }),
      mk({ video: { file_id: 'x', file_name: 'v.mp4' } }),
    ];
    for (const u of us) await store.saveUpdate(u.update_id, '{}', 0);
    const ps = us.map((u) => ing.dispatch(u.update_id, u));
    await tick(4000);
    await Promise.all(ps);
    expect((content().attachments as Array<{ type: string }>).map((a) => a.type)).toEqual(['image', 'image', 'video']);
  });

  it('replying to an earlier photo attaches it and links it by name (gap 19)', async () => {
    api.files.set('rp', { path: 'p/r.jpg', data: Buffer.from('jpg') });
    const reply = msg({ photo: [{ file_id: 'rp', file_unique_id: 'rp', width: 1, height: 1 }] });
    await feed(upd({ message: msg({ text: 'а здесь что написано?', reply_to_message: reply }) }));
    const c = content();
    expect(c.attachments[0].name).toBe(`photo-${reply.message_id}.jpg`);
    expect(c.replyTo.attachment).toEqual({ name: `photo-${reply.message_id}.jpg` });
  });
});

describe('gap 29/30: boot', () => {
  it('retries getMe on transient errors instead of dying silently', async () => {
    const a = new FakeApi();
    const err = new TelegramError({ method: 'getMe', kind: 'network', code: 0, description: 'dns' });
    a.failNext('getMe', err);
    a.failNext('getMe', err);
    const exit = vi.fn();
    const adapter = createTelegramAdapter({ token: 't', api: a.asBotApi(), store: new MemoryStore(), exit });
    const p = adapter.setup(host);
    await tick(10_000);
    await p;
    expect(a.of('getMe')).toHaveLength(3);
    expect(exit).not.toHaveBeenCalled();
    await adapter.teardown();
  });

  it('exits the process when Telegram stays unreachable', async () => {
    const a = new FakeApi();
    for (let i = 0; i < 3; i++)
      a.failNext('getMe', new TelegramError({ method: 'getMe', kind: 'timeout', code: 0, description: 'x' }));
    const exit = vi.fn();
    const adapter = createTelegramAdapter({
      token: 't',
      api: a.asBotApi(),
      store: new MemoryStore(),
      exit,
      bootRetryMs: [10, 10],
    });
    const p = adapter.setup(host).catch((e: unknown) => e);
    await tick(100);
    expect(await p).toBeInstanceOf(TelegramError);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('a status card left by a previous process is edited to «Прервано перезапуском»', async () => {
    const a = new FakeApi();
    const st = new MemoryStore();
    await st.saveDraft({
      chat_id: 5,
      draft_id: 1,
      turn_id: 'T',
      session_id: 'S',
      status_message_id: 77,
      created_at: 0,
      closed_at: null,
    });
    const adapter = createTelegramAdapter({ token: 't', api: a.asBotApi(), store: st });
    await adapter.setup(host);
    expect(JSON.stringify(a.of('editMessageText')[0].params)).toContain('Прервано перезапуском');
    expect(a.of('editMessageText')[0].params.message_id).toBe(77);
    await adapter.teardown();
  });
});

describe('gap 6: rich rejected -> sanitized retry before plain text', () => {
  it('retries once with tables flattened, then goes plain', async () => {
    const a = new FakeApi();
    a.failNext(
      'sendRichMessage',
      new TelegramError({ method: 'm', kind: 'bad_request', code: 400, description: 'bad' }),
    );
    const sched = new Scheduler();
    const s = new Sender({ api: a.asBotApi(), sched });
    const p = s.sendMarkdown(5, '| a | b |\n|---|---|\n| 1 | 2 |', { prio: 'final' });
    await tick(5000);
    await p;
    expect(a.of('sendRichMessage')).toHaveLength(2);
    expect(a.of('sendMessage')).toHaveLength(0);
    expect(JSON.stringify(a.of('sendRichMessage')[1].params)).not.toContain('"table"');
    sched.stop();
  });
});

describe('journal: an update is done only after the host has routed it', () => {
  it('stays «processing» (replayed after a crash) while onInbound is pending, done once it resolves', async () => {
    let release!: () => void;
    const slow: ChannelSetup = { ...host, onInbound: () => new Promise<void>((r) => (release = r)) };
    ing = new Ingress(rt, slow);
    const u = upd({ message: msg({ text: 'привет' }) });
    await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now());
    const p = ing.dispatch(u.update_id, u);
    await tick(3000);
    expect(store.updates.get(u.update_id)!.status).toBe('processing');
    expect((await store.loadPending()).map((x) => x.update_id)).toContain(u.update_id);
    release();
    await tick(10);
    await p;
    expect(store.updates.get(u.update_id)!.status).toBe('done');
  });

  it('a routing failure is not marked done', async () => {
    const bad: ChannelSetup = { ...host, onInbound: () => Promise.reject(new Error('shutting down')) };
    ing = new Ingress(rt, bad);
    const u = upd({ message: msg({ text: 'привет' }) });
    await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now());
    const p = ing.dispatch(u.update_id, u);
    await tick(3000);
    await p;
    expect(store.updates.get(u.update_id)!.status).not.toBe('done');
  });
});
