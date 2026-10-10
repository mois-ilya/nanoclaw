import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError } from '../botapi/index.js';
import { Deliverer, parseMessageId } from './deliver.js';
import { FakeApi } from './fakes.js';
import { resetHooks, setBudgetNoteProvider, setUserPrefsProvider } from './hooks.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { MemoryStore } from './store.js';

const CHAT = 5;
const PLATFORM = `telegram:${CHAT}`;
let api: FakeApi;
let store: MemoryStore;
let rt: TelegramRuntime;
let del: Deliverer;
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const J = (c: { params: unknown }) => JSON.stringify(c.params);
async function run<T>(p: Promise<T>): Promise<T> {
  await tick(10_000);
  return p;
}
const err = (kind: ConstructorParameters<typeof TelegramError>[0]['kind'], code = 0, description = 'x') =>
  new TelegramError({ method: 'm', kind, code, description });

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  setUserPrefsProvider(() => ({ showSteps: true }));
  setBudgetNoteProvider(() => null);
  api = new FakeApi();
  store = new MemoryStore();
  rt = createRuntime({ api: api.asBotApi(), store, botUsername: 'test_bot' });
  setRuntime(rt);
  del = new Deliverer(rt);
});
afterEach(() => {
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  vi.useRealTimers();
});

describe('Deliverer', () => {
  it('parses message ids', () => {
    expect(parseMessageId('123')).toBe(123);
    expect(parseMessageId('tg:5:77:ag-1')).toBe(77);
    expect(parseMessageId('weird')).toBeNull();
  });

  it('plain chat → sendRichMessage, returns the id', async () => {
    const id = await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'Привет **мир**' } }));
    expect(id).toBe('1000');
    expect(api.of('sendRichMessage')).toHaveLength(1);
  });

  it('very long answers (> 3 parts): first part as summary + the full text as answer.md', async () => {
    const md = Array.from({ length: 12 }, (_, i) => `## Раздел ${i}\n\n${'слово '.repeat(1200)}`).join('\n\n');
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { markdown: md } }));
    expect(api.of('sendRichMessage')).toHaveLength(1);
    expect(J(api.of('sendRichMessage')[0])).not.toContain('продолжение ниже');
    expect(api.of('sendDocument')).toHaveLength(1);
  });

  it('medium answers split into parts with >= 1.05 s spacing', async () => {
    const md = Array.from({ length: 5 }, (_, i) => `## Раздел ${i}\n\n${'слово '.repeat(1200)}`).join('\n\n');
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { markdown: md } }));
    const sent = api.of('sendRichMessage');
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < sent.length; i++) expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(1050);
    expect(J(sent[0])).toContain('продолжение ниже');
  });

  it('rich rejected (400) → plain sendMessage fallback', async () => {
    api.failNext('sendRichMessage', err('bad_request', 400, 'bad markup'));
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'hello world' } }));
    expect(api.of('sendMessage')).toHaveLength(1);
    expect(J(api.of('sendMessage')[0])).toContain('hello world');
  });

  it('uncertain outcome (timeout): no resend, but «Показать ещё раз» is offered and re-sends nothing by itself', async () => {
    api.failNext('sendRichMessage', err('timeout'));
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'x' } }));
    const sent = api.of('sendRichMessage');
    expect(sent).toHaveLength(2);
    expect(J(sent[1])).toContain('p:rs:');
    expect(api.of('sendMessage')).toHaveLength(0);
  });

  it('5xx is uncertain too: no resend of the answer, resend offered', async () => {
    api.failNext('sendRichMessage', err('server', 502));
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'x' } }));
    expect(api.of('sendRichMessage')).toHaveLength(2);
    expect(J(api.of('sendRichMessage')[1])).toContain('p:rs:');
  });

  it('pre-send network failure is retried internally with backoff; the answer goes out once', async () => {
    const e = err('network');
    e.preSend = true;
    api.failNext('sendRichMessage', e);
    const p = del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'привет' } });
    await tick(20_000);
    await expect(p).resolves.toMatch(/^\d+$/);
    const sent = api.of('sendRichMessage');
    expect(sent).toHaveLength(2); // one failed attempt + one success
    expect(sent[1].at - sent[0].at).toBeGreaterThanOrEqual(1000);
  });

  it('forbidden → resolves and marks the chat blocked; later deliveries are skipped', async () => {
    api.failNext('sendRichMessage', err('forbidden', 403, 'bot was blocked'));
    await expect(run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'x' } }))).resolves.toBeUndefined();
    await tick(10);
    expect(await store.isBlocked(CHAT)).toBe(true);
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'y' } }));
    expect(api.of('sendRichMessage')).toHaveLength(1);
  });

  it('retry_after is honoured and the send is retried', async () => {
    api.failNext(
      'sendRichMessage',
      new TelegramError({ method: 'm', kind: 'rate_limit', code: 429, description: 'x', retryAfter: 4 }),
    );
    await run(del.deliver(PLATFORM, null, { kind: 'chat', content: { text: 'x' } }));
    const s = api.of('sendRichMessage');
    expect(s).toHaveLength(2);
    expect(s[1].at - s[0].at).toBeGreaterThanOrEqual(4000);
  });

  it('files after text: image → sendPhoto (falls back to document), other → sendDocument', async () => {
    api.failNext('sendPhoto', err('bad_request', 400, 'PHOTO_INVALID_DIMENSIONS'));
    await run(
      del.deliver(PLATFORM, null, {
        kind: 'chat',
        content: { text: 'вот' },
        files: [
          { filename: 'a.png', data: Buffer.from('x') },
          { filename: 'b.xlsx', data: Buffer.from('y') },
        ],
      }),
    );
    expect(
      api.calls.map((c) => c.method).filter((m) => ['sendRichMessage', 'sendPhoto', 'sendDocument'].includes(m)),
    ).toEqual(['sendRichMessage', 'sendPhoto', 'sendDocument', 'sendDocument']);
  });

  it('files-only message is allowed', async () => {
    await run(
      del.deliver(PLATFORM, null, {
        kind: 'chat',
        content: {},
        files: [{ filename: 'r.pdf', data: Buffer.from('z') }],
      }),
    );
    expect(api.of('sendRichMessage')).toHaveLength(0);
    expect(api.of('sendDocument')).toHaveLength(1);
  });

  it('edit → editMessageText (rich); "not modified" is swallowed; keyboard removed', async () => {
    await run(
      del.deliver(PLATFORM, null, { kind: 'chat', content: { operation: 'edit', messageId: '321', text: 'новое' } }),
    );
    expect(api.of('editMessageText')[0].params).toMatchObject({ chat_id: CHAT, message_id: 321 });
    expect(api.of('editMessageText')[0].params.reply_markup).toBeUndefined();
    api.failNext('editMessageText', err('bad_request', 400, 'message is not modified'));
    await expect(
      run(
        del.deliver(PLATFORM, null, { kind: 'chat', content: { operation: 'edit', messageId: '321', text: 'новое' } }),
      ),
    ).resolves.toBeUndefined();
  });

  it('reaction → setMessageReaction; invalid reaction is logged, not thrown', async () => {
    await run(
      del.deliver(PLATFORM, null, {
        kind: 'chat',
        content: { operation: 'reaction', messageId: 'tg:5:9:ag', emoji: '👍' },
      }),
    );
    expect(api.of('setMessageReaction')[0].params).toMatchObject({
      message_id: 9,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
    api.failNext('setMessageReaction', err('bad_request', 400, 'REACTION_INVALID'));
    await expect(
      run(
        del.deliver(PLATFORM, null, { kind: 'chat', content: { operation: 'reaction', messageId: '9', emoji: 'x' } }),
      ),
    ).resolves.toBeUndefined();
  });

  it('ask_question: short callback ids stored (30 d TTL), keyboard sent', async () => {
    const id = await run(
      del.deliver(PLATFORM, null, {
        kind: 'chat-sdk',
        content: {
          type: 'ask_question',
          questionId: 'q1',
          title: 'Выбор',
          question: 'Что делаем?',
          options: ['Да', { label: 'Нет', value: 'no' }],
        },
      }),
    );
    expect(id).toBe('1000');
    const kb = api.of('sendRichMessage')[0].params.reply_markup.inline_keyboard.flat();
    expect(kb).toHaveLength(2);
    for (const b of kb) {
      expect(b.callback_data).toMatch(/^q:[0-9a-z]{8}$/);
      const row = await store.getCallback(b.callback_data.slice(2));
      expect(row?.question_id).toBe('q1');
      expect(row!.expires_at - row!.created_at).toBe(30 * 24 * 3600 * 1000);
    }
    expect((await store.getCallback(kb[1].callback_data.slice(2)))!.value).toBe('no');
  });

  it('ask_question with requirePresentation and nothing resolvable throws', async () => {
    const p = del.deliver(PLATFORM, null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'nope',
        title: 't',
        question: 'q',
        options: ['a'],
        requirePresentation: true,
      },
    });
    const assertion = expect(p).rejects.toThrow(/requirePresentation/);
    await tick(100);
    await assertion;
  });

  it('terminal card edit', async () => {
    await run(
      del.deliver(PLATFORM, null, {
        kind: 'chat',
        content: {
          operation: 'edit',
          messageId: '10',
          questionId: 'q1',
          terminalCard: { title: 'Выбор', question: 'Что?', resolution: 'Да' },
        },
      }),
    );
    const s = J(api.of('editMessageText')[0]);
    expect(s).toContain('Выбор');
    expect(s).toContain('✔ Да');
  });

  it('card: URL buttons only', async () => {
    await run(
      del.deliver(PLATFORM, null, {
        kind: 'chat-sdk',
        content: {
          type: 'card',
          card: {
            title: 'T',
            description: 'D',
            actions: [
              { label: 'Open', url: 'https://x.y' },
              { label: 'Bad', url: 'javascript:1' },
            ],
          },
        },
      }),
    );
    expect(api.of('sendRichMessage')[0].params.reply_markup.inline_keyboard).toEqual([
      [{ text: 'Open', url: 'https://x.y' }],
    ]);
  });
});
