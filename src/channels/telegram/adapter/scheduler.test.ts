import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramError } from '../botapi/index.js';
import { Scheduler } from './scheduler.js';

describe('Scheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('spaces sends by >= 1.05 s per chat but not across chats', async () => {
    const s = new Scheduler();
    const starts: Array<[number, number]> = [];
    const mk = (chat: number) => s.enqueue(chat, { prio: 'final' }, async () => void starts.push([chat, Date.now()]));
    const t0 = Date.now();
    const ps = [mk(1), mk(1), mk(1), mk(2)];
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all(ps);
    const c1 = starts.filter(([c]) => c === 1).map(([, t]) => t - t0);
    expect(c1).toEqual([0, 1050, 2100]);
    expect(starts.find(([c]) => c === 2)![1] - t0).toBe(0);
  });

  it('runs higher priority first among waiting tasks', async () => {
    const s = new Scheduler();
    const order: string[] = [];
    const first = s.enqueue(1, { prio: 'final' }, async () => void order.push('first'));
    await vi.advanceTimersByTimeAsync(0);
    const p = [
      s.enqueue(1, { prio: 'draft' }, async () => void order.push('draft')),
      s.enqueue(1, { prio: 'status' }, async () => void order.push('status')),
      s.enqueue(1, { prio: 'product' }, async () => void order.push('product')),
      s.enqueue(1, { prio: 'final' }, async () => void order.push('final')),
    ];
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([first, ...p]);
    expect(order).toEqual(['first', 'final', 'product', 'status', 'draft']);
  });

  it('coalesces keyed tasks: only the latest runs, all callers share the outcome', async () => {
    const s = new Scheduler();
    const ran: number[] = [];
    await s.enqueue(1, { prio: 'final' }, async () => 0);
    const a = s.enqueue(1, { prio: 'draft', key: 'draft' }, async () => ran.push(1));
    const b = s.enqueue(1, { prio: 'draft', key: 'draft' }, async () => ran.push(2));
    const c = s.enqueue(1, { prio: 'draft', key: 'draft' }, async () => ran.push(3));
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([a, b, c]);
    expect(ran).toEqual([3]);
  });

  it('honours retry_after for the whole chat and retries the task', async () => {
    const s = new Scheduler();
    let n = 0;
    const t0 = Date.now();
    const times: number[] = [];
    const p = s.enqueue(1, { prio: 'final' }, async () => {
      times.push(Date.now() - t0);
      if (n++ === 0)
        throw new TelegramError({
          method: 'sendMessage',
          kind: 'rate_limit',
          code: 429,
          description: 'x',
          retryAfter: 3,
        });
      return 'ok';
    });
    const other = s.enqueue(1, { prio: 'final', spaced: false }, async () => void times.push(-(Date.now() - t0)));
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe('ok');
    await other;
    expect(times[0]).toBe(0);
    expect(times[1]).toBeGreaterThanOrEqual(3000);
    // the unspaced task was also held back by the chat-wide block
    expect(-times[2]).toBeGreaterThanOrEqual(3000);
  });

  it('surfaces the 429 after maxRateRetries', async () => {
    const s = new Scheduler();
    const err = new TelegramError({ method: 'm', kind: 'rate_limit', code: 429, description: 'x', retryAfter: 1 });
    const p = s.enqueue(1, { prio: 'draft', maxRateRetries: 1 }, async () => {
      throw err;
    });
    const assertion = expect(p).rejects.toBe(err);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it('cancel drops pending keyed tasks', async () => {
    const s = new Scheduler();
    await s.enqueue(1, { prio: 'final' }, async () => 0);
    let ran = false;
    const p = s.enqueue(1, { prio: 'draft', key: 'draft' }, async () => void (ran = true));
    expect(s.cancel(1, 'draft')).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeUndefined();
    expect(ran).toBe(false);
  });
});
