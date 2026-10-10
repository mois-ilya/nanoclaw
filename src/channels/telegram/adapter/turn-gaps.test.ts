import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError } from '../botapi/index.js';
import { FakeApi } from './fakes.js';
import { Deliverer } from './deliver.js';
import { resetHooks, setBudgetNoteProvider, setUserPrefsProvider } from './hooks.js';
import { mapReaction } from './reactions.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { MemoryStore } from './store.js';
import { buildKeyboard } from './sender.js';

const CHAT = 42;
const PLATFORM = `telegram:${CHAT}`;
const T = 'tg:42:7:ag';

let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let del: Deliverer;

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const J = (c: { params: unknown }) => JSON.stringify(c.params);
const send = async (content: Record<string, unknown>, files?: Array<{ filename: string; data: Buffer }>) => {
  const p = del.deliver(PLATFORM, null, { kind: 'chat', content, files });
  await tick(3000);
  return p;
};
/** The «Thinking…» placeholder is rejected: the message gets the 👀 instead. */
const failPlaceholder = () =>
  api.failNext(
    'sendMessageDraft',
    new TelegramError({ method: 'sendMessageDraft', kind: 'bad_request', code: 400, description: 'no drafts' }),
  );
const start = (turnId = T) => rt.turns.onTurn({ chatId: CHAT, turnId, sessionId: 'sess-1', state: 'started' });
const finish = (state: 'finished' | 'cancelled' | 'failed' = 'finished', turnId = T) =>
  rt.turns.onTurn({ chatId: CHAT, turnId, sessionId: 'sess-1', state });
const step = (seq: number, label: string, state: 'running' | 'done' = 'done', ms = 1000) =>
  rt.turns.onProgress({ chatId: CHAT, turnId: T, sessionId: 'sess-1', seq, step: { id: `s${seq}`, label, state, ms } });

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

describe('gap 1/13: interim chat rows do not close the turn', () => {
  it('interim message, 3 steps, final: drafts continue, details on the last message, 👀 cleared only at the end', async () => {
    failPlaceholder();
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    start();
    await tick(500);
    await send({ text: 'Принял, займусь' });
    const reactionsAfterInterim = api.of('setMessageReaction').filter((c) => J(c).includes('"reaction":[]'));
    expect(reactionsAfterInterim).toHaveLength(0);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);

    const draftsBefore = api.of('sendRichMessageDraft').length;
    step(1, 'Открываю страницу habr.com');
    step(2, 'Читаю a.md');
    step(3, 'Пишу b.md');
    await tick(20_000);
    expect(api.of('sendRichMessageDraft').length).toBeGreaterThan(draftsBefore);
    expect(J(api.of('sendRichMessageDraft').pop()!)).toContain('Пишу b.md');

    await send({ text: 'Готово, вот результат' });
    expect(api.of('setMessageReaction').filter((c) => J(c).includes('"reaction":[]'))).toHaveLength(0);
    finish();
    await tick(3000);
    const edit = api.of('editMessageText').find((c) => J(c).includes('Что я сделал (3 шага'));
    expect(edit).toBeDefined();
    expect(J(edit!)).toContain('Готово, вот результат');
    expect(api.of('setMessageReaction').pop()!.params).toMatchObject({ message_id: 7, reaction: [] });
    const n = api.of('sendRichMessageDraft').length;
    await tick(40_000);
    expect(api.of('sendRichMessageDraft')).toHaveLength(n);
  });

  it('send_file mid-turn: text first, the file right after it (before the row is acked); turn stays open', async () => {
    start();
    await send({ text: 'Вот таблица. Подробности ниже.\nВторая строка' }, [
      { filename: 'a.xlsx', data: Buffer.from('x') },
    ]);
    expect(api.of('sendDocument')).toHaveLength(1);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    finish();
    await tick(3000);
    expect(api.of('sendDocument')).toHaveLength(1);
    const order = api.calls.map((c) => c.method).filter((m) => ['sendRichMessage', 'sendDocument'].includes(m));
    expect(order[0]).toBe('sendRichMessage');
    expect(order[order.length - 1]).toBe('sendDocument');
  });

  it('a row of another turn (nc.turnId mismatch) never closes the active turn', async () => {
    start();
    await send({ text: 'напоминание', nc: { turnId: 'tg:42:99:ag', final: true } });
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
  });
});

describe('gap 21/22/26-28: scheduled-task rows are standalone and respect quiet hours', () => {
  it('task row: no details, turn stays open, silent in quiet hours', async () => {
    vi.setSystemTime(new Date('2026-03-01T23:30:00Z'));
    setUserPrefsProvider(() => ({ showSteps: true, quietHours: { from: '23:00', to: '08:00' }, tz: 'UTC' }));
    start();
    for (let i = 1; i <= 4; i++) step(i, `Шаг ${i}`);
    await send({ text: 'Утренняя сводка', nc: { source: 'task', seriesId: 's1' } });
    const s = api.of('sendRichMessage').pop()!;
    expect(J(s)).not.toContain('Что я сделал');
    expect(s.params.disable_notification).toBe(true);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
  });

  it('task row outside quiet hours is not silenced', async () => {
    vi.setSystemTime(new Date('2026-03-01T12:00:00Z'));
    setUserPrefsProvider(() => ({ showSteps: true, quietHours: { from: '23:00', to: '08:00' }, tz: 'UTC' }));
    await send({ text: 'Сводка', nc: { source: 'task' } });
    expect(api.of('sendRichMessage').pop()!.params.disable_notification).toBeUndefined();
  });

  it('quiet-hours window uses the user timezone', async () => {
    vi.setSystemTime(new Date('2026-03-01T20:30:00Z')); // 23:30 in Moscow
    setUserPrefsProvider(() => ({ showSteps: true, quietHours: { from: '23:00', to: '08:00' }, tz: 'Europe/Moscow' }));
    await send({ text: 'Сводка', nc: { source: 'task' } });
    expect(api.of('sendRichMessage').pop()!.params.disable_notification).toBe(true);
  });
});

describe('gap 2/23: dead turns end', () => {
  it('idle watchdog closes a turn without events and sends the failure copy with [Повторить]', async () => {
    failPlaceholder();
    rt.turns.noteInbound(CHAT, 7);
    await tick(0);
    start();
    await tick(6 * 60_000);
    const n = api.of('sendRichMessageDraft').length;
    await tick(60_000);
    expect(api.of('sendRichMessageDraft')).toHaveLength(n);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
    const notice = api.of('sendRichMessage').pop()!;
    expect(J(notice)).toContain('Что-то сломалось');
    expect(J(notice)).toContain('p:rty:tg:42:7');
    expect(api.of('setMessageReaction').pop()!.params.reaction).toEqual([]);
  });

  it('progress events keep the watchdog quiet', async () => {
    start();
    for (let i = 1; i <= 10; i++) {
      step(i, `Шаг ${i}`);
      await tick(60_000);
    }
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
  });

  it('failTurnsForSession fails the open turn at once', async () => {
    start();
    await tick(500);
    rt.turns.failTurnsForSession('sess-1');
    await tick(1000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
    expect(J(api.of('sendRichMessage').pop()!)).toContain('Что-то сломалось');
    rt.turns.failTurnsForSession('sess-1'); // idempotent
    await tick(1000);
    expect(api.of('sendRichMessage')).toHaveLength(1);
  });

  it('failTurnsForSession quiet closes the turn without the crash copy (the host owns it)', async () => {
    start();
    await tick(500);
    rt.turns.failTurnsForSession('sess-1', { quiet: true });
    await tick(1000);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
    expect(api.of('sendRichMessage').some((c) => J(c).includes('Что-то сломалось'))).toBe(false);
  });

  it('a retried turn (same turnId) after a quiet crash-close starts again', async () => {
    start();
    await tick(500);
    rt.turns.failTurnsForSession('sess-1', { quiet: true });
    await tick(100);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
    start();
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(true);
    // a plain finish is still remembered: stale telemetry cannot reopen it
    finish();
    await tick(100);
    start();
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
  });

  it('a stale 👀 after a restart is cleared from the turn id', async () => {
    start('tg:42:55:ag');
    finish('finished', 'tg:42:55:ag');
    await tick(100);
    expect(api.of('setMessageReaction').pop()!.params).toMatchObject({ message_id: 55, reaction: [] });
  });
});

describe('gap 3: reactions', () => {
  it('maps names to allowed emoji, keeps literal allowed emoji, falls back to 👍', () => {
    expect(mapReaction('thumbs_up')).toBe('👍');
    expect(mapReaction('heart')).toBe('❤');
    expect(mapReaction(':fire:')).toBe('🔥');
    expect(mapReaction('check')).toBe('👍');
    expect(mapReaction('🔥')).toBe('🔥');
    expect(mapReaction('???')).toBe('👍');
  });

  it('the agent reaction on the user message survives the turn cleanup', async () => {
    rt.turns.noteInbound(CHAT, 7);
    start();
    await tick(100);
    await send({ operation: 'reaction', messageId: 'tg:42:7', emoji: 'thumbs_up' });
    expect(api.of('setMessageReaction').pop()!.params).toMatchObject({
      message_id: 7,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
    finish();
    await tick(2000);
    const cleared = api
      .of('setMessageReaction')
      .filter((c) => J(c).includes('"reaction":[]') && c.params.message_id === 7);
    expect(cleared).toHaveLength(0);
  });
});

describe('gap 4: failure copy', () => {
  const buttons = (m: { params: { reply_markup?: { inline_keyboard: Array<Array<{ callback_data?: string }>> } } }) =>
    (m.params.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

  it.each([
    ['The agent run failed. Check the logs for details.', 'Что-то сломалось', ['p:rty:tg:42:7']],
    ['429 rate_limit_error: overloaded_error', 'перегружена', ['p:rty:tg:42:7']],
    ['402 budget exceeded', 'на этот месяц', ['p:rl:42', undefined]],
    ['timeout: wall-clock exceeded', 'слишком долго', ['p:cont', 'p:new']],
  ])('%s -> Russian copy + the buttons of its class, raw text hidden', async (raw, ru, data) => {
    start();
    await send({ text: raw, failureNotice: true });
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain(ru);
    expect(J(m)).not.toContain(raw);
    expect(buttons(m)).toEqual(data);
  });

  it.each([
    ['busy', 'параллельный запрос', ['p:rty:tg:42:7']],
    ['turn_cap', 'Слишком дорогой запрос', ['p:new']],
  ])('nanogate 429 class %s -> its own copy and buttons', async (failureClass, ru, data) => {
    start();
    await send({ text: 'x', failureNotice: true, failureClass });
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain(ru);
    expect(J(m)).not.toContain('на этот месяц');
    expect(buttons(m)).toEqual(data);
  });

  it('keys on failureClass: the runner global_cap copy is not shown as a personal budget', async () => {
    start();
    await send({
      text: 'Сервис сейчас достиг общего лимита расходов. Попробуй чуть позже.',
      failureNotice: true,
      failureClass: 'global_cap',
    });
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain('общего лимита');
    expect(J(m)).not.toContain('на этот месяц');
    expect(buttons(m)).toEqual([]);
  });

  it('a legacy text without failureClass still mentioning «общего лимита» is global_cap too', async () => {
    start();
    await send({ text: '…общего лимита расходов…', failureNotice: true });
    expect(J(api.of('sendRichMessage').pop()!)).not.toContain('на этот месяц');
  });

  it('timeout keeps the runner text with the partial result and offers [Продолжить] [Начать заново]', async () => {
    start();
    await send({
      markdown: 'Задача шла слишком долго, я остановился. Вот что успел:\n\nНашёл три варианта: A, B, C',
      failureNotice: true,
      failureClass: 'timeout',
      nc: { turnId: 'tg:42:7', timeout: true },
    });
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain('Нашёл три варианта');
    expect(buttons(m)).toEqual(['p:cont', 'p:new']);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
  });
});

describe('gap 5: stop', () => {
  it('stopped row gets [Продолжить] [Начать заново] and closes the turn as cancelled', async () => {
    start();
    await tick(3000);
    await send({ text: 'Часть ответа', nc: { stopped: true } });
    const m = api.of('sendRichMessage').pop()!;
    const data = m.params.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data);
    expect(data).toEqual(['p:cont', 'p:new']);
    expect(rt.turns.hasActiveTurn(CHAT)).toBe(false);
  });

  it('disableDrafts stops heartbeat and preview drafts at once', async () => {
    start();
    await tick(3000);
    rt.turns.disableDrafts(CHAT);
    const n = api.of('sendRichMessageDraft').length;
    rt.turns.onPreview({ chatId: CHAT, turnId: T, sessionId: 's', seq: 3, text: 'ещё' });
    await tick(60_000);
    expect(api.of('sendRichMessageDraft')).toHaveLength(n);
  });
});

describe('gap 7: status card', () => {
  it('has the hint and a Stop button; the terminal edit drops the keyboard', async () => {
    start();
    await tick(46_000);
    const card = api.of('sendRichMessage')[0];
    expect(J(card)).toContain('можно закрыть чат');
    expect(J(card)).toContain('⏹ Остановить');
    finish();
    await tick(3000);
    const term = api.of('editMessageText').pop()!;
    expect(term.params.reply_markup).toBeUndefined();
  });
});

describe('gap 9: voice echo', () => {
  it('prepends «🎤 Расшифровка» to the reply of that turn; expandable when long', async () => {
    await rt.turns.noteVoice(CHAT, 7, [{ kind: 'voice', transcript: 'позвони Диме' }]);
    start();
    await send({ text: 'Хорошо', nc: { final: true } });
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain('🎤 Расшифровка: «позвони Диме»');
    expect(J(m).indexOf('Расшифровка')).toBeLessThan(J(m).indexOf('Хорошо'));
    expect(J(m)).toContain('blockquote');

    await rt.turns.noteVoice(CHAT, 8, [{ kind: 'video_note', transcript: 'x'.repeat(100) }]);
    start('tg:42:8:ag');
    await send({ text: 'ok', nc: { final: true } });
    expect(J(api.of('sendRichMessage').pop()!)).toContain('expandable_blockquote');
  });

  it('echo survives into the failure notice', async () => {
    await rt.turns.noteVoice(CHAT, 7, [{ kind: 'audio', transcript: 'привет' }]);
    start();
    rt.turns.failTurnsForSession('sess-1');
    await tick(2000); // the draft sent at turn start holds the spacing slot for a second
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain('🎧 Расшифровка: «привет»');
    expect(J(m)).toContain('Что-то сломалось');
  });
});

describe('gap 16/17/18: files', () => {
  it('one short line + one file -> caption on the file, upload_document action, size-scaled timeout', async () => {
    const calls: unknown[] = [];
    const orig = api.sendDocument.bind(api);
    (api as any).sendDocument = (p: unknown, opts?: unknown) => {
      // eslint-disable-line @typescript-eslint/no-explicit-any
      calls.push(opts);
      return orig(p);
    };
    await send({ text: 'Вот таблица' }, [{ filename: 'a.xlsx', data: Buffer.alloc(12 * 1024 * 1024) }]);
    expect(api.of('sendRichMessage')).toHaveLength(0);
    expect(api.of('sendDocument')[0].params.caption).toBe('Вот таблица');
    expect(api.of('sendChatAction').some((c) => c.params.action === 'upload_document')).toBe(true);
    expect((calls[0] as { timeoutMs: number }).timeoutMs).toBeGreaterThanOrEqual(120_000);
  });

  it('photos get upload_photo', async () => {
    await send({}, [{ filename: 'a.png', data: Buffer.from('x') }]);
    expect(api.of('sendChatAction').some((c) => c.params.action === 'upload_photo')).toBe(true);
  });
});

describe('gap 25: budget note', () => {
  it('80% note carries a [Подробнее] Mini App button on the final', async () => {
    rt.miniAppShortName = 'cabinet';
    setBudgetNoteProvider(() => ({ text: '💡 Использовано 80 %', button: { text: 'Подробнее', webApp: 'usage' } }));
    await send({ text: 'Ответ' });
    const m = api.of('sendRichMessage').pop()!;
    expect(J(m)).toContain('80 %');
    expect(m.params.reply_markup.inline_keyboard[0][0]).toMatchObject({
      text: 'Подробнее',
      url: 'https://t.me/test_bot/cabinet?startapp=usage',
    });
  });
});

describe('gap 31: Mini App button without a short name', () => {
  it('uses a native web_app button when only the URL is known', () => {
    const kb = buildKeyboard(
      [[{ text: 'Открыть кабинет', webApp: 'tasks' }]],
      'test_bot',
      undefined,
      'https://app.example/x',
    );
    expect(kb!.inline_keyboard[0][0]).toEqual({
      text: 'Открыть кабинет',
      web_app: { url: 'https://app.example/x?startapp=tasks' },
    });
  });
});

describe('gap 24: resend', () => {
  it('offers «Показать ещё раз» when the outcome is unknown', async () => {
    api.failNext(
      'sendRichMessage',
      new (await import('../botapi/index.js')).TelegramError({
        method: 'm',
        kind: 'timeout',
        code: 0,
        description: 'x',
      }),
    );
    await send({ text: 'Важный ответ' });
    expect(J(api.of('sendRichMessage').pop()!)).toContain('p:rs:');
  });
});
