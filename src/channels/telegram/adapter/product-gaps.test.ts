/** Integration pass: watchdog vs silent steps/questions, interim draft, runner buttons, retry prompts, replay, uploads. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError, type Message, type Update } from '../botapi/index.js';
import type { ChannelSetup, InboundMessage } from '../../adapter.js';
import { Deliverer } from './deliver.js';
import { FakeApi } from './fakes.js';
import {
  resetHooks,
  setBudgetNoteProvider,
  setTaskTokenProvider,
  setTranscriber,
  setUserPrefsProvider,
} from './hooks.js';
import { Ingress } from './ingress.js';
import {
  buttonValue,
  clearButtons,
  createRuntime,
  replayPrivateUpdate,
  retryPrompt,
  setReplayHandler,
  setRuntime,
  type TelegramRuntime,
} from './runtime.js';
import { MemoryStore } from './store.js';

const CHAT = 42;
const PLATFORM = `telegram:${CHAT}`;
const T = 'tg:42:7:ag';

let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let del: Deliverer;
let ing: Ingress;
let inbound: InboundMessage[];

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const J = (c: { params: unknown }) => JSON.stringify(c.params);
const send = async (content: Record<string, unknown>, files?: Array<{ filename: string; data: Buffer }>) => {
  const p = del.deliver(PLATFORM, null, { kind: 'chat', content, files });
  await tick(3000);
  return p;
};
const start = (turnId = T) => rt.turns.onTurn({ chatId: CHAT, turnId, sessionId: 'sess-1', state: 'started' });
const finish = (state: 'finished' | 'cancelled' | 'failed' = 'finished', turnId = T) =>
  rt.turns.onTurn({ chatId: CHAT, turnId, sessionId: 'sess-1', state });
const progress = (seq: number, id: string, state: 'running' | 'done', label = 'Выполняю команду') =>
  rt.turns.onProgress({ chatId: CHAT, turnId: T, sessionId: 'sess-1', seq, step: { id, label, state } });
const host: ChannelSetup = {
  onInbound: (_p, _t, msg) => void inbound.push(msg),
  onInboundEvent: () => {},
  onMetadata: () => {},
  onAction: () => {},
};
const callbackData = (m: {
  params: { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } };
}) => (m.params.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  setUserPrefsProvider(() => ({ showSteps: true }));
  setBudgetNoteProvider(() => null);
  inbound = [];
  api = new FakeApi();
  store = new MemoryStore();
  rt = createRuntime({
    api: api.asBotApi(),
    store,
    ownerId: CHAT,
    botUsername: 'test_bot',
    turnCfg: { stopEnabled: true },
  });
  setRuntime(rt);
  del = new Deliverer(rt);
  ing = new Ingress(rt, host);
});
afterEach(() => {
  ing.shutdown();
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  setReplayHandler(undefined);
  resetHooks();
  vi.useRealTimers();
});

describe('idle watchdog does not kill healthy silent turns', () => {
  it('a tool step still running for 12 minutes keeps the turn open', async () => {
    start();
    progress(1, 't1', 'running');
    await tick(12 * 60_000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    expect(api.of('sendRichMessage').filter((c) => J(c).includes('Что-то сломалось'))).toHaveLength(0);
    progress(2, 't1', 'done');
    await tick(6 * 60_000); // done step, nothing else: now the watchdog may fire
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
  });

  it('an ask_question card pending for 6 minutes does not fail the turn; answering re-arms the clock', async () => {
    start();
    const asked = del.deliver(PLATFORM, null, {
      kind: 'chat',
      content: {
        type: 'ask_question',
        questionId: 'q1',
        title: 'Удалить?',
        question: 'Удалить X?',
        options: ['Да', 'Нет'],
      },
    });
    await tick(1500); // the draft sent at turn start holds the spacing slot for a second
    await asked;
    await tick(6 * 60_000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    expect(api.of('sendRichMessage').filter((c) => J(c).includes('Что-то сломалось'))).toHaveLength(0);
    // The user answers at 6:00 -> the idle clock runs again from there.
    const btn = api.of('sendRichMessage')[0].params.reply_markup.inline_keyboard[0][0].callback_data as string;
    expect(btn).toMatch(/^q:/);
    const u: Update = {
      update_id: 900,
      callback_query: {
        id: 'cb1',
        from: { id: CHAT, is_bot: false, first_name: 'A' },
        chat_instance: 'x',
        data: btn,
        message: { message_id: 5, chat: { id: CHAT, type: 'private' }, date: 1 },
      },
    } as Update;
    await store.saveUpdate(900, JSON.stringify(u), Date.now());
    const p = ing.dispatch(900, u);
    await tick(100);
    await p;
    await tick(4 * 60_000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    await tick(2 * 60_000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
  });

  it('a step stuck forever is still given up on after the grace period', async () => {
    start();
    progress(1, 't1', 'running');
    await tick(45 * 60_000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
  });
});

describe('interim message vs the draft', () => {
  it('the re-sent draft does not repeat the text that was just delivered', async () => {
    start();
    rt.turns.onPreview({ chatId: CHAT, turnId: T, sessionId: 'sess-1', seq: 1, text: 'Нашёл три варианта' });
    await tick(3000); // draft is live and shows the preview
    expect(J(api.of('sendRichMessageDraft').pop()!)).toContain('Нашёл три варианта');
    await send({ text: 'Нашёл три варианта' }); // the block closed: delivered as an interim message
    await tick(5000); // the draft comes back after 1.5 s
    const last = api.of('sendRichMessageDraft').pop()!;
    expect(J(last)).not.toContain('Нашёл три варианта');
    expect(J(last)).toContain('Работаю');
    // A throttled preview of the same block that trails its chat row must not bring it back.
    rt.turns.onPreview({ chatId: CHAT, turnId: T, sessionId: 'sess-1', seq: 2, text: 'Нашёл три варианта' });
    await tick(5000);
    expect(J(api.of('sendRichMessageDraft').pop()!)).not.toContain('Нашёл три варианта');
    // New text does show.
    rt.turns.onPreview({ chatId: CHAT, turnId: T, sessionId: 'sess-1', seq: 3, text: 'Теперь второе' });
    await tick(3000);
    expect(J(api.of('sendRichMessageDraft').pop()!)).toContain('Теперь второе');
    finish();
  });

  it('the overload step is a transient line in the draft and disappears from «Что я сделал»', async () => {
    start();
    progress(1, 'api-retry', 'running', 'Модель сейчас перегружена, пробую снова…');
    await tick(3000);
    expect(J(api.of('sendRichMessageDraft').pop()!)).toContain('перегружена');
    progress(2, 'api-retry', 'done', 'Модель сейчас перегружена, пробую снова…');
    await tick(3000);
    expect(J(api.of('sendRichMessageDraft').pop()!)).not.toContain('перегружена');
  });
});

describe('runner-supplied buttons', () => {
  it('suggest_replies: up to 3 chips on the last part, text kept in the callback store', async () => {
    start();
    await send({
      text: 'Вот ответ',
      nc: { turnId: 'tg:42:7', suggest: ['Сделай план', 'Подробнее', 'Короче', 'лишнее'] },
    });
    const m = api.of('sendRichMessage').pop()!;
    const data = callbackData(m);
    expect(data).toHaveLength(3);
    expect(data.every((d) => /^p:sr:[0-9a-z]{8}$/.test(d!))).toBe(true);
    const texts = [];
    for (const d of data) texts.push(await buttonValue(CHAT, d!.slice(5), 'sr'));
    expect(texts).toEqual(['Сделай план', 'Подробнее', 'Короче']);
    expect(await buttonValue(999, data[0]!.slice(5), 'sr')).toBeUndefined(); // another chat cannot use it
    finish();
  });

  it('reminder row: [Сделано] [Отложить на час] with non-colliding tokens; it does not take the voice echo of the open turn', async () => {
    const minted: string[] = [];
    setTaskTokenProvider(async (chatId, seriesId) => {
      expect(chatId).toBe(CHAT);
      minted.push(seriesId);
      return `tok${minted.length}`;
    });
    await rt.turns.noteVoice(CHAT, 7, [{ kind: 'voice', transcript: 'позвони Диме' }]);
    start();
    await send({ text: '⏰ Пора звонить', nc: { source: 'task', seriesId: 's1', reminder: { seriesId: 'task-1' } } });
    const reminder = api.of('sendRichMessage').pop()!;
    expect(callbackData(reminder)).toEqual(['p:rd:tok1', 'p:sz:tok2']);
    expect(J(reminder)).not.toContain('Расшифровка');
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    await send({ text: 'Готово', nc: { turnId: 'tg:42:7' } });
    finish();
    await tick(3000);
    expect(J(api.of('sendRichMessage').pop()!)).toContain('Расшифровка');
  });

  it('task-created row: [Отменить] [Изменить время]', async () => {
    setTaskTokenProvider(async (_c, s) => `t${s.length}`);
    await send({ text: 'Создал напоминание', nc: { taskCreated: { seriesId: 'abc' } } });
    expect(callbackData(api.of('sendRichMessage').pop()!)).toEqual(['p:tc:t3', 'p:tt:t3']);
  });
});

describe('long answers', () => {
  it('a many-part answer inside a turn becomes a summary plus answer.md, not N messages', async () => {
    start();
    const long = Array.from({ length: 30 }, (_, i) => `Раздел ${i}\n\n${'слово '.repeat(900)}`).join('\n\n');
    await send({ markdown: long, nc: { turnId: 'tg:42:7' } });
    expect(api.of('sendDocument')).toHaveLength(1);
    expect(api.of('sendRichMessage').length).toBeLessThanOrEqual(2);
    finish();
  });
});

describe('file upload timeouts', () => {
  const timeout = () =>
    new TelegramError({ method: 'sendDocument', kind: 'timeout', code: 0, description: 'no response within 30000ms' });

  it('a timeout is retried once with a longer limit', async () => {
    api.failNext('sendDocument', timeout());
    await send({ text: 'Вот файл\nвторая строка' }, [{ filename: 'a.pdf', data: Buffer.from('x') }]);
    expect(api.of('sendDocument')).toHaveLength(2);
    expect(J(api.of('sendRichMessage').pop()!)).not.toContain('Не уверен');
  });

  it('two timeouts in a row: the user is told the file may be missing', async () => {
    api.failNext('sendDocument', timeout());
    api.failNext('sendDocument', timeout());
    const p = del.deliver(PLATFORM, null, {
      kind: 'chat',
      content: { text: 'Вот файл\nвторая строка' },
      files: [{ filename: 'a.pdf', data: Buffer.from('x') }],
    });
    await tick(30_000);
    await p;
    expect(J(api.of('sendRichMessage').pop()!)).toContain('Не уверен, что файл «a.pdf» дошёл');
  });

  it('an uncertain failure after the body (5xx) is still treated as delivered', async () => {
    api.failNext(
      'sendDocument',
      new TelegramError({ method: 'sendDocument', kind: 'server', code: 502, description: 'bad gateway' }),
    );
    await send({ text: 'Вот файл\nвторая строка' }, [{ filename: 'a.pdf', data: Buffer.from('x') }]);
    expect(api.of('sendDocument')).toHaveLength(1);
  });
});

describe('retry prompt + replay', () => {
  const msg = (over: Record<string, unknown> = {}) =>
    ({
      message_id: 7,
      from: { id: CHAT, is_bot: false, first_name: 'Илья' },
      chat: { id: CHAT, type: 'private' },
      date: 1_700_000_000,
      ...over,
    }) as unknown as Message;
  const upd = (m: Message): Update => ({ update_id: 500 + m.message_id, message: m }) as Update;
  async function feed(u: Update) {
    await store.saveUpdate(u.update_id, JSON.stringify(u), Date.now());
    const p = ing.dispatch(u.update_id, u);
    await tick(2000);
    await p;
  }

  it('the inbound prompt is stored for [Повторить] under the base turn id', async () => {
    await feed(upd(msg({ text: 'найди рейс в Тбилиси' })));
    expect(inbound).toHaveLength(1);
    expect(await retryPrompt(CHAT, 'tg:42:7')).toBe('найди рейс в Тбилиси');
    expect(await retryPrompt(CHAT, 'tg:42:7:ag')).toBe('найди рейс в Тбилиси');
    expect(await retryPrompt(77, 'tg:42:7')).toBeUndefined();
  });

  it('a voice message is retried by its transcript', async () => {
    api.files.set('v1', { path: 'voice/1.oga', data: Buffer.from('ogg') });
    setTranscriber(async () => ({ text: 'закажи такси', lang: 'ru' }));
    await feed(upd(msg({ message_id: 8, voice: { file_id: 'v1', duration: 3 } })));
    expect(await retryPrompt(CHAT, 'tg:42:8')).toContain('закажи такси');
  });

  it('replayPrivateUpdate re-runs an already seen update through the pipeline (voice included)', async () => {
    api.files.set('v1', { path: 'voice/1.oga', data: Buffer.from('ogg') });
    setTranscriber(async () => ({ text: 'напомни завтра', lang: 'ru' }));
    const u = upd(msg({ message_id: 9, voice: { file_id: 'v1', duration: 3 } }));
    // First pass: the gate retained it before approval (dedupe key remembered).
    await feed(u);
    expect(inbound).toHaveLength(1);
    await feed(u);
    expect(inbound).toHaveLength(1); // plain redelivery is deduped
    setReplayHandler((x) => ing.replay(x));
    const p = replayPrivateUpdate(u);
    await tick(2000);
    await p;
    expect(inbound).toHaveLength(2);
    expect(String((inbound[1].content as { text: string }).text)).toContain('напомни завтра');
  });

  it('replayPrivateUpdate without a running adapter fails loudly', async () => {
    setReplayHandler(undefined);
    await expect(replayPrivateUpdate(upd(msg({ text: 'x' })))).rejects.toThrow();
  });

  it('clearButtons removes the inline keyboard', async () => {
    const p = clearButtons(CHAT, 5);
    await tick(100);
    await p;
    expect(api.calls.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
  });
});
