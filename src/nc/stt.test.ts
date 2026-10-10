import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb } from '../db/index.js';
import { estimateDurationS, inferenceUrl, isHallucination, judgeSegments, timeoutFor, transcribe } from './stt.js';
import { getDb } from '../db/connection.js';
import { setupDb } from './test-helpers.js';

beforeEach(async () => {
  process.env.NC_STT_URL = 'http://127.0.0.1:8178';
  await setupDb();
});
afterEach(async () => {
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
