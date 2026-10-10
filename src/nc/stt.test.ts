import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TMP = vi.hoisted(() => `/tmp/nc-stt-${process.pid}`);
vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: `${TMP}/data` };
});

import { closeDb } from '../db/index.js';
import { resetGroqKeyState } from './groq-key.js';
import {
  estimateDurationS,
  groqFilename,
  inferenceUrl,
  isHallucination,
  judgeSegments,
  timeoutFor,
  transcribe,
} from './stt.js';
import { getDb } from '../db/connection.js';
import { setupDb } from './test-helpers.js';

beforeEach(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  resetGroqKeyState();
  process.env.NC_STT_URL = 'http://127.0.0.1:8178';
  await setupDb();
});
afterEach(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.NC_GROQ_KEY_FILE;
  delete process.env.NC_GROQ_STT_MODEL;
  delete process.env.NC_STT_URL;
  await closeDb();
});

const meta = { mime: 'audio/ogg', durationS: 10, userId: 5 };
const resp = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('transcribe', () => {
  it('posts multipart to /inference and returns text', async () => {
    const f = resp({ text: ' Привет  мир ' });
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'Привет мир', lang: undefined });
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8178/inference');
    expect((init.body as FormData).get('response_format')).toBe('verbose_json');
    expect((init.body as FormData).get('suppress_nst')).toBe('true');
    expect((init.body as FormData).get('language')).toBe('auto');
  });
  it('maps errors', async () => {
    expect(await transcribe(Buffer.from('a'), { ...meta, durationS: 301 }, resp({}))).toEqual({ error: 'too_long' });
    expect(await transcribe(Buffer.from('a'), meta, resp({ text: '  ' }))).toEqual({ error: 'empty' });
    expect(await transcribe(Buffer.from('a'), meta, resp({}, 500))).toEqual({ error: 'failed' });
    expect(
      await transcribe(
        Buffer.from('a'),
        meta,
        vi.fn(async () => {
          throw new Error('down');
        }) as unknown as typeof fetch,
      ),
    ).toEqual({ error: 'failed' });
  });
  it('treats an HTTP-200 {error} body as a server failure, not silence', async () => {
    expect(await transcribe(Buffer.from('a'), meta, resp({ error: 'FFmpeg conversion failed.' }))).toEqual({
      error: 'failed',
    });
  });
  it('drops whisper hallucinations in any bracket style', async () => {
    for (const text of [
      'Продолжение следует...',
      '(музыка)',
      '[Музыка]',
      'Субтитры сделал DimaTorzok',
      '[BLANK_AUDIO]',
      'Редактор субтитров А.Семкин',
    ]) {
      expect(await transcribe(Buffer.from('a'), meta, resp({ text }))).toEqual({ error: 'empty' });
    }
    expect(isHallucination('Включи свет на кухне')).toBe(false);
  });
  it('rejects clips whose segments are all no-speech or low-confidence', async () => {
    const noSpeech = { text: 'что-то', segments: [{ start: 0, end: 2, avg_logprob: -0.3, no_speech_prob: 0.9 }] };
    expect(await transcribe(Buffer.from('a'), meta, resp(noSpeech))).toEqual({ error: 'empty' });
    const lowLp = { text: 'что-то', segments: [{ start: 0, end: 2, avg_logprob: -1.6, no_speech_prob: 0.1 }] };
    expect(await transcribe(Buffer.from('a'), meta, resp(lowLp))).toEqual({ error: 'empty' });
    const good = {
      text: 'привет',
      language: 'ru',
      segments: [{ start: 0, end: 2, avg_logprob: -0.2, no_speech_prob: 0.05 }],
    };
    const r = await transcribe(Buffer.from('a'), meta, resp(good));
    expect(r).toMatchObject({ text: 'привет', lang: 'ru' });
    expect((r as { confidence: number }).confidence).toBeGreaterThan(0.7);
    expect(judgeSegments(undefined)).toEqual({ silent: false });
  });
  it('does not record voice seconds for a server error', async () => {
    const { getDb } = await import('../db/connection.js');
    await transcribe(Buffer.from('a'), meta, resp({ error: 'x' }));
    const row = await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM nc_usage_voice');
    expect(row?.n ?? 0).toBe(0);
  });
  it('serialises calls and scales the timeout with duration', async () => {
    let active = 0;
    let maxActive = 0;
    const f = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return new Response(JSON.stringify({ text: 'ok' }));
    }) as unknown as typeof fetch;
    await Promise.all([
      transcribe(Buffer.from('a'), meta, f),
      transcribe(Buffer.from('a'), meta, f),
      transcribe(Buffer.from('a'), meta, f),
    ]);
    expect(maxActive).toBe(1);
    expect(timeoutFor(10)).toBe(30_000);
    expect(timeoutFor(200)).toBe(215_000);
  });
  it('url helper', () => {
    expect(inferenceUrl('http://h/inference')).toBe('http://h/inference');
    expect(inferenceUrl('http://h/')).toBe('http://h/inference');
  });
});

describe('untimed audio (Telegram reports duration 0)', () => {
  it('estimates the clip length from the file size, within [30 s, 5 min]', () => {
    expect(estimateDurationS(10_000)).toBe(30);
    expect(estimateDurationS(1_600_000)).toBe(200);
    expect(estimateDurationS(4_000_000)).toBe(300);
  });

  // A whisper that needs 60 s for the clip: the 30 s floor of a known-short voice note must not apply to it.
  const slowFetch = (ms: number) =>
    vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          const t = setTimeout(
            () =>
              resolve(new Response(JSON.stringify({ text: 'длинная запись', segments: [{ start: 0, end: 214.2 }] }))),
            ms,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        }),
    ) as unknown as typeof fetch;

  it("a 4 MB mp3 with duration 0 is not aborted at 30 s and is counted by whisper's own length", async () => {
    vi.useFakeTimers();
    try {
      const p = transcribe(
        Buffer.alloc(4_000_000),
        { mime: 'audio/mpeg', durationS: 0, userId: 77 },
        slowFetch(60_000),
      );
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await p).toMatchObject({ text: 'длинная запись' });
    } finally {
      vi.useRealTimers();
    }
    const r = await getDb().get<{ s: number }>(
      'SELECT SUM(seconds) AS s FROM nc_usage_voice WHERE user_id = ?',
      'telegram:77',
    );
    expect(r?.s).toBe(215);
  });

  it('a known 5 s voice note keeps the 30 s limit', async () => {
    vi.useFakeTimers();
    try {
      const p = transcribe(Buffer.alloc(10_000), { mime: 'audio/ogg', durationS: 5, userId: 78 }, slowFetch(60_000));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await p).toEqual({ error: 'failed' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('groq stt', () => {
  const GK = `gsk_${'k'.repeat(30)}`;
  const putMini = (k: string) => {
    fs.mkdirSync(`${TMP}/data/secrets`, { recursive: true });
    fs.writeFileSync(`${TMP}/data/secrets/groq_api_key`, `${k}\n`);
  };
  const putServer = (k: string) => {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(`${TMP}/srv`, `${k}\n`);
    process.env.NC_GROQ_KEY_FILE = `${TMP}/srv`;
  };
  const routed = (groq: () => Response | Promise<Response>) =>
    vi.fn(async (url: string) =>
      String(url).startsWith('https://api.groq.com/')
        ? groq()
        : new Response(JSON.stringify({ text: 'локально' }), { status: 200 }),
    ) as unknown as typeof fetch;
  const groqCalls = (f: typeof fetch) =>
    (f as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).startsWith('https://api.groq.com/'),
    );

  it('no key: local only', async () => {
    const f = routed(() => new Response('{}'));
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'локально', lang: undefined });
    expect(groqCalls(f)).toHaveLength(0);
  });

  it('sends a voice.ogg multipart with Bearer auth and the model, returns the text', async () => {
    putServer(GK);
    process.env.NC_GROQ_STT_MODEL = 'whisper-large-v3-turbo';
    const f = routed(() => new Response(JSON.stringify({ text: ' Привет  Groq ' })));
    expect(await transcribe(Buffer.from('a'), { ...meta, mime: 'audio/ogg' }, f)).toEqual({
      text: 'Привет Groq',
      lang: undefined,
    });
    const calls = groqCalls(f);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${GK}`);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.has('language')).toBe(false);
    expect((form.get('file') as File).name).toBe('voice.ogg');
    expect(fs.existsSync(`${TMP}/srv`)).toBe(true);
  });

  it('uses language, segments and duration from verbose_json', async () => {
    putMini(GK);
    const f = routed(
      () =>
        new Response(
          JSON.stringify({
            text: 'привет',
            language: 'russian',
            duration: 7.2,
            segments: [{ start: 0, end: 7, avg_logprob: -0.1, no_speech_prob: 0.01 }],
          }),
        ),
    );
    const r = await transcribe(Buffer.from('a'), { ...meta, durationS: 0 }, f);
    expect(r).toMatchObject({ text: 'привет', lang: 'russian' });
    expect((r as { confidence: number }).confidence).toBeGreaterThan(0.8);
    const silent = routed(
      () => new Response(JSON.stringify({ text: 'эээ', segments: [{ start: 0, end: 2, no_speech_prob: 0.9 }] })),
    );
    expect(await transcribe(Buffer.from('a'), meta, silent)).toEqual({ error: 'empty' });
  });

  it('a parked Mini App key falls through to the server key, not to local', async () => {
    const SK = `gsk_${'s'.repeat(30)}`;
    putMini(GK);
    putServer(SK);
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.groq.com/')) return new Response(JSON.stringify({ text: 'локально' }));
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === `Bearer ${GK}`
        ? new Response('no', { status: 401 })
        : new Response(JSON.stringify({ text: 'сервер' }));
    }) as unknown as typeof fetch;
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'сервер', lang: undefined });
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'сервер', lang: undefined });
    expect(
      groqCalls(f).map((c) => (c[1] as RequestInit & { headers: Record<string, string> }).headers.authorization),
    ).toEqual([`Bearer ${GK}`, `Bearer ${SK}`, `Bearer ${SK}`]);
  });

  it('Mini App key wins over the server key', async () => {
    putServer(`gsk_${'s'.repeat(30)}`);
    putMini(GK);
    const f = routed(() => new Response(JSON.stringify({ text: 'ok' })));
    await transcribe(Buffer.from('a'), meta, f);
    const [, init] = groqCalls(f)[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${GK}`);
  });

  it('falls back to local on 500', async () => {
    putMini(GK);
    const f = routed(() => new Response('x', { status: 500 }));
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'локально', lang: undefined });
    expect(groqCalls(f)).toHaveLength(1);
  });

  it('falls back to local on a network error', async () => {
    putMini(GK);
    const f = routed(() => {
      throw new Error('offline');
    });
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'локально', lang: undefined });
  });

  it('falls back to local on timeout', async () => {
    putMini(GK);
    vi.useFakeTimers();
    try {
      const f = vi.fn(async (url: string, init?: RequestInit) => {
        if (!String(url).startsWith('https://api.groq.com/')) return new Response(JSON.stringify({ text: 'локально' }));
        return new Promise<Response>((_, rej) =>
          init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))),
        );
      }) as unknown as typeof fetch;
      const p = transcribe(Buffer.from('a'), meta, f);
      await vi.advanceTimersByTimeAsync(30_001);
      expect(await p).toEqual({ text: 'локально', lang: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('401 falls back and parks the key for 10 minutes', async () => {
    putMini(GK);
    const f = routed(() => new Response('no', { status: 401 }));
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'локально', lang: undefined });
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'локально', lang: undefined });
    expect(groqCalls(f)).toHaveLength(1);
  });

  it('audio over 25 MB goes straight to local', async () => {
    putMini(GK);
    const f = routed(() => new Response(JSON.stringify({ text: 'groq' })));
    await transcribe(Buffer.alloc(25 * 1024 * 1024 + 1), meta, f);
    expect(groqCalls(f)).toHaveLength(0);
  });

  it('groq works without a local server', async () => {
    putMini(GK);
    delete process.env.NC_STT_URL;
    const f = routed(() => new Response(JSON.stringify({ text: 'groq' })));
    expect(await transcribe(Buffer.from('a'), meta, f)).toEqual({ text: 'groq', lang: undefined });
  });

  it('maps MIME to a Groq-accepted file name (.oga becomes .ogg)', () => {
    expect(groqFilename('audio/ogg')).toBe('voice.ogg');
    expect(groqFilename('audio/x-opus+ogg')).toBe('voice.ogg');
    expect(groqFilename('')).toBe('voice.ogg');
    expect(groqFilename('audio/mpeg')).toBe('voice.mp3');
    expect(groqFilename('audio/mp4')).toBe('voice.m4a');
    expect(groqFilename('audio/x-wav')).toBe('voice.wav');
    expect(groqFilename('audio/flac')).toBe('voice.flac');
    expect(groqFilename('audio/webm')).toBe('voice.webm');
  });
});
