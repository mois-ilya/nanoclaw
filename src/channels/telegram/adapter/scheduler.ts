/**
 * Per-chat outbound scheduler (contract C4 / plan T6).
 *
 * One serial queue per chat. Priority: final > product > status > draft.
 * `spaced` tasks (anything that produces a message or edit) start at least
 * `spacingMs` after the previous spaced task started; `retry_after` blocks the
 * whole chat. Tasks with a `key` coalesce: a pending task with the same key is
 * replaced by the newest one (only the latest draft/status edit survives).
 *
 * Time comes from global Date.now/setTimeout at call time, so vitest fake
 * timers drive it deterministically.
 */
import { TelegramError } from '../botapi/index.js';
import { log } from '../../../log.js';

export type Priority = 'final' | 'product' | 'status' | 'draft';
const RANK: Record<Priority, number> = { final: 0, product: 1, status: 2, draft: 3 };

export interface EnqueueOptions {
  prio: Priority;
  /** Coalescing key (scoped to the chat). */
  key?: string;
  /** Default true. Reactions / chat actions pass false. */
  spaced?: boolean;
  /** How many times a 429 is retried before the error is surfaced. Default: 5 for final/product, 2 otherwise. */
  maxRateRetries?: number;
}

interface Entry {
  seq: number;
  opts: EnqueueOptions & { spaced: boolean };
  fn: () => Promise<unknown>;
  attempts: number;
  promise: Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface ChatQueue {
  entries: Entry[];
  running: boolean;
  lastSpacedStart: number;
  blockedUntil: number;
  wake?: () => void;
}

export interface SchedulerOptions {
  spacingMs?: number;
  /** Extra margin added to retry_after. */
  retryMarginMs?: number;
}

export class Scheduler {
  private readonly chats = new Map<number, ChatQueue>();
  private seq = 0;
  private readonly spacingMs: number;
  private readonly retryMarginMs: number;
  private stopped = false;

  constructor(opts: SchedulerOptions = {}) {
    this.spacingMs = opts.spacingMs ?? 1050;
    this.retryMarginMs = opts.retryMarginMs ?? 250;
  }

  private queue(chatId: number): ChatQueue {
    let q = this.chats.get(chatId);
    if (!q) {
      q = { entries: [], running: false, lastSpacedStart: -Infinity, blockedUntil: 0 };
      this.chats.set(chatId, q);
    }
    return q;
  }

  enqueue<T>(chatId: number, opts: EnqueueOptions, fn: () => Promise<T>): Promise<T> {
    const q = this.queue(chatId);
    const o = { ...opts, spaced: opts.spaced ?? true };
    if (o.key) {
      const existing = q.entries.find((e) => e.opts.key === o.key);
      if (existing) {
        // Coalesce: the newest content wins, all callers share one outcome.
        existing.fn = fn;
        if (RANK[o.prio] < RANK[existing.opts.prio]) existing.opts.prio = o.prio;
        return existing.promise as Promise<T>;
      }
    }
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    q.entries.push({ seq: this.seq++, opts: o, fn, attempts: 0, promise, resolve, reject });
    q.wake?.();
    if (!q.running) void this.pump(chatId, q);
    return promise as Promise<T>;
  }

  /** Drop pending (not yet running) tasks with this key; their promises resolve undefined. */
  cancel(chatId: number, key: string): number {
    const q = this.chats.get(chatId);
    if (!q) return 0;
    let n = 0;
    q.entries = q.entries.filter((e) => {
      if (e.opts.key === key) {
        e.resolve(undefined);
        n++;
        return false;
      }
      return true;
    });
    return n;
  }

  pending(chatId: number): number {
    return this.chats.get(chatId)?.entries.length ?? 0;
  }

  /** Reject nothing, resolve all pending with undefined and refuse new work (teardown). */
  stop(): void {
    this.stopped = true;
    for (const q of this.chats.values()) {
      for (const e of q.entries) e.resolve(undefined);
      q.entries = [];
      q.wake?.();
    }
  }

  private pickRunnable(q: ChatQueue, now: number): Entry | undefined {
    if (now < q.blockedUntil) return undefined;
    let best: Entry | undefined;
    for (const e of q.entries) {
      if (e.opts.spaced && now < q.lastSpacedStart + this.spacingMs) continue;
      if (
        !best ||
        RANK[e.opts.prio] < RANK[best.opts.prio] ||
        (RANK[e.opts.prio] === RANK[best.opts.prio] && e.seq < best.seq)
      )
        best = e;
    }
    return best;
  }

  private nextWakeDelay(q: ChatQueue, now: number): number {
    let at = Infinity;
    if (now < q.blockedUntil) at = q.blockedUntil;
    else {
      // Only spaced entries are not runnable when not blocked.
      at = q.lastSpacedStart + this.spacingMs;
    }
    return Math.max(1, at - now);
  }

  private async pump(chatId: number, q: ChatQueue): Promise<void> {
    q.running = true;
    try {
      while (q.entries.length > 0 && !this.stopped) {
        const now = Date.now();
        const entry = this.pickRunnable(q, now);
        if (!entry) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(
              () => {
                q.wake = undefined;
                resolve();
              },
              this.nextWakeDelay(q, now),
            );
            q.wake = () => {
              clearTimeout(timer);
              q.wake = undefined;
              resolve();
            };
          });
          continue;
        }
        q.entries = q.entries.filter((e) => e !== entry);
        if (entry.opts.spaced) q.lastSpacedStart = now;
        try {
          entry.resolve(await entry.fn());
        } catch (err) {
          if (err instanceof TelegramError && err.kind === 'rate_limit') {
            const max = entry.opts.maxRateRetries ?? (RANK[entry.opts.prio] <= RANK.product ? 5 : 2);
            const waitMs = (err.retryAfter ?? 1) * 1000 + this.retryMarginMs;
            q.blockedUntil = Math.max(q.blockedUntil, Date.now() + waitMs);
            entry.attempts += 1;
            if (entry.attempts <= max) {
              log.warn('Telegram rate limit', { chatId, method: err.method, retryAfter: err.retryAfter });
              q.entries.push(entry);
              continue;
            }
          }
          entry.reject(err);
        }
      }
    } finally {
      q.running = false;
      const t = Date.now();
      if (q.entries.length === 0 && t >= q.blockedUntil && t >= q.lastSpacedStart + this.spacingMs) {
        this.chats.delete(chatId);
      }
    }
  }
}
