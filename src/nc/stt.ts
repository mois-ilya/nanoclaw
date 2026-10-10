/** Voice transcription: Groq Whisper when a key is set, else (or on failure) a local whisper-server (`POST /inference`). */
import { log } from '../log.js';
import { nc } from './config.js';
import { markGroqKeyInvalid, usableGroqKey } from './groq-key.js';
import type { TranscribeResult } from './port.js';
import { recordVoice } from './store.js';

export const MAX_VOICE_SECONDS = 300;
export const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_TIMEOUT_MS = 30_000;
/** Groq free tier file limit; bigger audio goes straight to the local server. */
export const GROQ_MAX_BYTES = 25 * 1024 * 1024;
/** Whisper-server is serial; time spent waiting in our own queue never counts against the HTTP timeout. */
const QUEUE_WAIT_MAX_MS = 10 * 60_000;
/** Spike I tunes these on the target host. */
export const NO_SPEECH_MAX = 0.6;
export const AVG_LOGPROB_MIN = -1.0;

export function inferenceUrl(base: string): string {
  return /\/inference\/?$/.test(base) ? base : `${base.replace(/\/+$/, '')}/inference`;
}

/** HTTP timeout for one request, derived from the clip length (ARM host: roughly real time). */
export function timeoutFor(durationS: number): number {
  return Math.max(30_000, Math.ceil(durationS * 1000 + 15_000));
}

/**
 * Clip length for the timeout when Telegram reports duration 0 (untimed audio files): at 64 kbit/s
 * (8 kB/s, a conservative low bitrate so the estimate errs long) capped at the 5-minute limit.
 */
export function estimateDurationS(sizeBytes: number): number {
  return Math.min(MAX_VOICE_SECONDS, Math.max(30, Math.ceil(sizeBytes / 8000)));
}

// ---------- serial queue ----------

let tail: Promise<void> = Promise.resolve();

/** Run `fn` after every earlier STT call has finished (concurrency 1, FIFO). */
async function serial<T>(fn: () => Promise<T>): Promise<T> {
  const prev = tail;
  let release!: () => void;
  tail = new Promise<void>((r) => (release = r));
  let waitTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      prev,
      new Promise<void>((_, rej) => {
        waitTimer = setTimeout(() => rej(new Error('stt queue wait exceeded')), QUEUE_WAIT_MAX_MS);
        waitTimer.unref?.();
      }),
    ]);
  } catch (err) {
    release(); // do not hold up the queue behind us
    throw err;
  } finally {
    if (waitTimer) clearTimeout(waitTimer);
  }
  try {
    return await fn();
  } finally {
    release();
  }
}

// ---------- hallucination filter ----------

const HALLUCINATION_EXACT = new Set([
  'blank_audio',
  'blank audio',
  'silence',
  'тишина',
  'музыка',
  'music',
  'музыкальная заставка',
  'аплодисменты',
  'applause',
  'смех',
  'laughter',
  'продолжение следует',
  'спасибо за просмотр',
  'спасибо за внимание',
  'thanks for watching',
  'thank you for watching',
  'подписывайтесь на канал',
  'не забудьте подписаться на канал',
  'amara org',
  'субтитры сделал dimatorzok',
]);
// JS `\b` is ASCII-only, so Cyrillic anchors use whitespace/string edges.
const HALLUCINATION_RE = [
  /^(редактор )?субтитр(ы|ов)(?= |$).{0,60}$/,
  /(^| )dimatorzok( |$)/,
  /(^| )субтитры (сделал|создавал|подогнал|добавил)/,
  /(^| )subtitles? (by|made by)( |$)/,
  /(^| )амара ?орг( |$)/,
];

/** Lower-case, drop every bracket/punctuation, collapse spaces. Brackets (round/square/none) are all treated alike. */
function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[()[\]{}*♪♫"'«».,!?…:;\-–—]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isHallucination(text: string): boolean {
  const n = normalise(text);
  if (!n) return true;
  if (HALLUCINATION_EXACT.has(n)) return true;
  return HALLUCINATION_RE.some((re) => re.test(n));
}

interface Segment {
  start?: number;
  end?: number;
  text?: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/** Low-confidence verdict from verbose_json segments; `confidence` in 0..1 (exp of the weighted avg logprob). */
export function judgeSegments(segments: Segment[] | undefined): { silent: boolean; confidence?: number } {
  const segs = (segments ?? []).filter((s) => typeof s === 'object' && s !== null);
  if (segs.length === 0) return { silent: false };
  if (segs.every((s) => typeof s.no_speech_prob === 'number' && s.no_speech_prob > NO_SPEECH_MAX))
    return { silent: true, confidence: 0 };
  let w = 0;
  let acc = 0;
  for (const s of segs) {
    if (typeof s.avg_logprob !== 'number') continue;
    const d = typeof s.start === 'number' && typeof s.end === 'number' ? Math.max(0.1, s.end - s.start) : 1;
    w += d;
    acc += s.avg_logprob * d;
  }
  if (w === 0) return { silent: false };
  const avg = acc / w;
  return { silent: avg < AVG_LOGPROB_MIN, confidence: Math.max(0, Math.min(1, Math.exp(avg))) };
}

/**
 * File name Groq accepts for a MIME type. Telegram voice is OGG/Opus, and Groq rejects `.oga`, so ogg-ish
 * (and unknown) types are always sent as `voice.ogg`.
 */
export function groqFilename(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (/flac/.test(m)) return 'voice.flac';
  if (/mpeg|mp3|mpga/.test(m)) return 'voice.mp3';
  if (/m4a/.test(m)) return 'voice.m4a';
  if (/mp4/.test(m)) return m.startsWith('video/') ? 'voice.mp4' : 'voice.m4a';
  if (/wav/.test(m)) return 'voice.wav';
  if (/webm/.test(m)) return 'voice.webm';
  return 'voice.ogg';
}

interface GroqBody {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: Segment[];
}

/** One Groq request. Returns the parsed body, or null when the caller should fall back to the local server. */
async function groqTranscribe(
  audio: Buffer,
  meta: { mime: string },
  key: string,
  fetchFn: typeof fetch,
): Promise<GroqBody | null> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: meta.mime || 'audio/ogg' }), groqFilename(meta.mime));
  form.append('model', nc.groqSttModel());
  form.append('response_format', 'verbose_json');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetchFn(GROQ_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) markGroqKeyInvalid(key);
      log.warn('nc: groq stt failed', { kind: 'http', status: res.status });
      return null;
    }
    return (await res.json()) as GroqBody;
  } catch {
    log.warn('nc: groq stt failed', { kind: ctrl.signal.aborted ? 'timeout' : 'network' });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function transcribe(
  audio: Buffer,
  meta: { mime: string; durationS: number; userId: number },
  fetchFn: typeof fetch = fetch,
): Promise<TranscribeResult> {
  if (meta.durationS > MAX_VOICE_SECONDS) return { error: 'too_long' };
  const knownS = meta.durationS > 0;
  const budgetS = knownS ? meta.durationS : estimateDurationS(audio.length);
  const groq = audio.length <= GROQ_MAX_BYTES ? usableGroqKey() : null;
  if (groq) {
    const startedAt = Date.now();
    let body = await groqTranscribe(audio, meta, groq.key, fetchFn);
    // A parked Mini App key falls through to the server key before going local.
    if (!body) {
      const next = usableGroqKey();
      if (next && next.key !== groq.key) body = await groqTranscribe(audio, meta, next.key, fetchFn);
    }
    if (body) {
      log.info('nc: stt done', { provider: 'groq', audioS: meta.durationS, ms: Date.now() - startedAt });
      const reportedS = typeof body.duration === 'number' && body.duration > 0 ? Math.ceil(body.duration) : 0;
      const countedS = knownS ? meta.durationS : reportedS > 0 ? Math.min(MAX_VOICE_SECONDS, reportedS) : budgetS;
      await recordVoice(`telegram:${meta.userId}`, countedS).catch(() => undefined);
      const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
      if (!text || isHallucination(text)) return { error: 'empty' };
      const verdict = judgeSegments(body.segments);
      if (verdict.silent) return { error: 'empty' };
      const lang = typeof body.language === 'string' ? body.language : undefined;
      return { text, lang, ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}) };
    }
  }
  const base = nc.sttUrl();
  if (!base) {
    log.warn('nc: NC_STT_URL is not set; voice transcription unavailable');
    return { error: 'failed' };
  }
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: meta.mime || 'audio/ogg' }), 'voice.ogg');
  form.append('response_format', 'verbose_json');
  form.append('suppress_nst', 'true');
  form.append('language', 'auto');
  try {
    return await serial(async () => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutFor(budgetS));
      const startedAt = Date.now();
      try {
        const res = await fetchFn(inferenceUrl(base), { method: 'POST', body: form, signal: ctrl.signal });
        if (!res.ok) {
          log.warn('nc: stt http error', { status: res.status });
          return { error: 'failed' } as const;
        }
        const body = (await res.json()) as {
          text?: unknown;
          error?: unknown;
          language?: unknown;
          detected_language?: unknown;
          segments?: Segment[];
        };
        // whisper-server reports ffmpeg/decoding failures as HTTP 200 `{error}`.
        if (typeof body.error === 'string') {
          log.warn('nc: stt server error', { error: body.error });
          return { error: 'failed' } as const;
        }
        const elapsed = Date.now() - startedAt;
        log.info('nc: stt done', {
          audioS: meta.durationS,
          ms: elapsed,
          msPerAudioS: meta.durationS > 0 ? Math.round(elapsed / meta.durationS) : null,
        });
        // Voice is free locally, but the seconds are counted for the Mini App. Untimed audio: whisper's own length.
        const reportedS = Math.max(0, ...(body.segments ?? []).map((s) => (typeof s?.end === 'number' ? s.end : 0)));
        const countedS = knownS
          ? meta.durationS
          : reportedS > 0
            ? Math.min(MAX_VOICE_SECONDS, Math.ceil(reportedS))
            : budgetS;
        await recordVoice(`telegram:${meta.userId}`, countedS).catch(() => undefined);
        const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
        if (!text || isHallucination(text)) return { error: 'empty' } as const;
        const verdict = judgeSegments(body.segments);
        if (verdict.silent) return { error: 'empty' } as const;
        const lang =
          typeof body.language === 'string'
            ? body.language
            : typeof body.detected_language === 'string'
              ? body.detected_language
              : undefined;
        return { text, lang, ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}) };
      } finally {
        clearTimeout(timer);
      }
    });
  } catch (err) {
    log.warn('nc: stt request failed', { err: err instanceof Error ? err.message : String(err) });
    return { error: 'failed' };
  }
}
