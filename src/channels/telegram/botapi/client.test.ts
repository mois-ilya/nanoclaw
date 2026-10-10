import { describe, expect, it } from 'vitest';

import { BotApi } from './client.js';
import { FileTooLargeError, TelegramError } from './errors.js';
import { InputFile } from './types.js';

const TOKEN = '123456:SECRET-token_abc';

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(handler: (call: Call) => Response | Promise<Response>, timeoutMs?: number) {
  const f = fakeFetch(handler);
  return { bot: new BotApi({ token: TOKEN, fetch: f.fn, timeoutMs }), calls: f.calls };
}

async function catchErr(p: Promise<unknown>): Promise<TelegramError> {
  try {
    await p;
  } catch (e) {
    return e as TelegramError;
  }
  throw new Error('expected rejection');
}

describe('BotApi.call', () => {
  it('POSTs JSON to /bot<token>/<method> and unwraps result', async () => {
    const { bot, calls } = api(() => json({ ok: true, result: { id: 1, is_bot: true, first_name: 'b' } }));
    const me = await bot.getMe();
    expect(me.id).toBe(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[0].init.body).toBe('{}');
  });

  it('honours baseUrl', async () => {
    const f = fakeFetch(() => json({ ok: true, result: true }));
    const bot = new BotApi({ token: TOKEN, baseUrl: 'http://localhost:8081/', fetch: f.fn });
    await bot.deleteMessage(1, 2);
    expect(f.calls[0].url).toBe(`http://localhost:8081/bot${TOKEN}/deleteMessage`);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ chat_id: 1, message_id: 2 });
  });

  it('sends rich message payload verbatim', async () => {
    const { bot, calls } = api(() =>
      json({ ok: true, result: { message_id: 5, date: 0, chat: { id: 1, type: 'private' } } }),
    );
    await bot.sendRichMessage({ chat_id: 1, rich_message: { blocks: [{ type: 'divider' }] } });
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      chat_id: 1,
      rich_message: { blocks: [{ type: 'divider' }] },
    });
    expect(calls[0].url.endsWith('/sendRichMessage')).toBe(true);
  });

  it('uses multipart/form-data when an InputFile is present', async () => {
    const { bot, calls } = api(() =>
      json({ ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } } }),
    );
    await bot.sendDocument({
      chat_id: 42,
      document: new InputFile(Buffer.from('hello'), 'a.txt', 'text/plain'),
      caption: 'cap',
      reply_parameters: { message_id: 7 },
      disable_notification: true,
    });
    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((calls[0].init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(body.get('chat_id')).toBe('42');
    expect(body.get('caption')).toBe('cap');
    expect(body.get('disable_notification')).toBe('true');
    expect(JSON.parse(body.get('reply_parameters') as string)).toEqual({ message_id: 7 });
    const file = body.get('document') as Blob & { name: string };
    expect(file.name).toBe('a.txt');
    expect(file.type).toBe('text/plain');
    expect(await file.text()).toBe('hello');
  });

  it('getUpdates extends the timeout by the long-poll window', async () => {
    let seenTimeout = 0;
    const orig = globalThis.setTimeout;
    // Capture the timer duration our client arms.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms && ms >= 1000) seenTimeout = ms;
      return orig(fn, ms);
    }) as typeof setTimeout;
    try {
      const { bot } = api(() => json({ ok: true, result: [] }), 5000);
      await bot.getUpdates({ timeout: 25 });
    } finally {
      globalThis.setTimeout = orig;
    }
    expect(seenTimeout).toBe(30_000);
  });
});

describe('error classification', () => {
  const cases: Array<[number, string, string]> = [
    [400, 'Bad Request: message is too long', 'bad_request'],
    [401, 'Unauthorized', 'forbidden'],
    [403, 'Forbidden: bot was blocked by the user', 'forbidden'],
    [404, 'Not Found', 'not_found'],
    [409, 'Conflict: terminated by other getUpdates request', 'conflict'],
    [429, 'Too Many Requests: retry after 7', 'rate_limit'],
    [502, 'Bad Gateway', 'server'],
  ];
  it.each(cases)('HTTP %i -> %s', async (status, description, kind) => {
    const { bot } = api(() => json({ ok: false, error_code: status, description }, status));
    const err = await catchErr(bot.sendMessage({ chat_id: 1, text: 'x' }));
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.kind).toBe(kind);
    expect(err.code).toBe(status);
    expect(err.description).toBe(description);
    expect(err.method).toBe('sendMessage');
  });

  it('parses retry_after and migrate_to_chat_id', async () => {
    const rl = api(() =>
      json({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 12 } }, 429),
    );
    const e1 = await catchErr(rl.bot.sendMessage({ chat_id: 1, text: 'x' }));
    expect(e1.kind).toBe('rate_limit');
    expect(e1.retryAfter).toBe(12);

    const mg = api(() =>
      json(
        {
          ok: false,
          error_code: 400,
          description: 'group chat was upgraded',
          parameters: { migrate_to_chat_id: -1001234 },
        },
        400,
      ),
    );
    const e2 = await catchErr(mg.bot.sendMessage({ chat_id: 1, text: 'x' }));
    expect(e2.kind).toBe('bad_request');
    expect(e2.migrateToChatId).toBe(-1001234);
  });

  it('non-JSON error body falls back to HTTP status', async () => {
    const { bot } = api(() => new Response('<html>Bad gateway</html>', { status: 502 }));
    const err = await catchErr(bot.getMe());
    expect(err.kind).toBe('server');
    expect(err.code).toBe(502);
    expect(err.uncertain).toBe(true); // 5xx may have taken effect
  });

  it('timeout after send is kind=timeout and uncertain', async () => {
    const { bot } = api(
      ({ init }) =>
        new Promise<Response>((_, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
      20,
    );
    const err = await catchErr(bot.getMe());
    expect(err.kind).toBe('timeout');
    expect(err.uncertain).toBe(true);
  });

  it('connect failure is network, certain; mid-flight reset is network, uncertain', async () => {
    const refused = api(() => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
      });
    });
    const e1 = await catchErr(refused.bot.getMe());
    expect(e1.kind).toBe('network');
    expect(e1.uncertain).toBe(false);

    const reset = api(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'read ECONNRESET' } });
    });
    const e2 = await catchErr(reset.bot.getMe());
    expect(e2.kind).toBe('network');
    expect(e2.uncertain).toBe(true);
  });
});

describe('token redaction', () => {
  it('strips the token from network error messages', async () => {
    const { bot } = api(() => {
      throw Object.assign(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`), {
        cause: { code: 'ECONNRESET', message: `socket hang up bot${TOKEN}` },
      });
    });
    const err = await catchErr(bot.getMe());
    expect(err.message).not.toContain(TOKEN);
    expect(err.description).not.toContain(TOKEN);
    expect(JSON.stringify({ ...err, stack: err.stack?.split('\n')[0] })).not.toContain(TOKEN);
  });

  it('strips the token from API error descriptions', async () => {
    const { bot } = api(() => json({ ok: false, error_code: 400, description: `bad url /bot${TOKEN}/x` }, 400));
    const err = await catchErr(bot.getMe());
    expect(err.message).not.toContain(TOKEN);
    expect(err.description).toContain('<token>');
  });
});

describe('downloadFile', () => {
  it('returns the body and requests /file/bot<token>/<path>', async () => {
    const { bot, calls } = api(() => new Response(Buffer.from('abc')));
    const buf = await bot.downloadFile('photos/file_1.jpg');
    expect(buf.toString()).toBe('abc');
    expect(calls[0].url).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);
  });

  it('rejects by content-length', async () => {
    const { bot } = api(() => new Response('x', { headers: { 'content-length': '999' } }));
    await expect(bot.downloadFile('a', { maxBytes: 10 })).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('rejects while streaming when no content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(8));
        c.enqueue(new Uint8Array(8));
        c.close();
      },
    });
    const { bot } = api(() => new Response(stream));
    await expect(bot.downloadFile('a', { maxBytes: 10 })).rejects.toBeInstanceOf(FileTooLargeError);
  });

  it('maps HTTP errors', async () => {
    const { bot } = api(() => new Response('nope', { status: 404 }));
    const err = await catchErr(bot.downloadFile('a'));
    expect(err.kind).toBe('not_found');
  });
});

describe('BotApi response body handling', () => {
  const stalledBody = () =>
    new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('times out when the body stalls after headers (uncertain)', async () => {
    const { bot } = api(() => stalledBody(), 50);
    const err = await catchErr(bot.getMe());
    expect(err.kind).toBe('timeout');
    expect(err.uncertain).toBe(true);
  });

  it('a 200 with an unparseable body is uncertain, not bad_request', async () => {
    const { bot } = api(() => new Response('{"ok":tr', { status: 200 }));
    const err = await catchErr(bot.getMe());
    expect(err.kind).toBe('network');
    expect(err.uncertain).toBe(true);
  });

  it('a body stream error after 200 is uncertain', async () => {
    const body = new ReadableStream({
      pull(c) {
        c.error(new Error('ECONNRESET'));
      },
    });
    const { bot } = api(() => new Response(body, { status: 200 }));
    const err = await catchErr(bot.getMe());
    expect(err).toBeInstanceOf(TelegramError);
    expect(err.uncertain).toBe(true);
  });

  it('downloadFile times out on a stalled body', async () => {
    const { bot } = api(() => new Response(new ReadableStream({ start() {} }), { status: 200 }), 50);
    const err = await catchErr(bot.downloadFile('a/b'));
    expect(err.kind).toBe('timeout');
  });
});
