import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { failureStreaks, pauseTask } = vi.hoisted(() => ({
  failureStreaks: vi.fn(),
  pauseTask: vi.fn(async () => 1),
}));
vi.mock('./tasks.js', () => ({ failureStreaks, pauseTask }));
vi.mock('../modules/scheduling/run-log.js', () => ({
  readRunLogTail: vi.fn(async () => ['2026-10-10 09:00 — сайт не отвечает (503)']),
}));

import { closeDb } from '../db/index.js';
import { insertTenantIfAbsent, kvGet, updateTenant } from './store.js';
import { sweepTaskFailures } from './taskfail.js';
import { FRIEND_A, OWNER, installFakeAdapter, setupDb } from './test-helpers.js';

let fake: ReturnType<typeof installFakeAdapter>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  await setupDb();
  fake = installFakeAdapter();
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
  await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
});
afterEach(closeDb);

const streak = (failed: number, status: 'active' | 'paused' = 'active') => [
  { id: 'digest-ab12', name: 'Дайджест', failed, status },
];

describe('failed scheduled runs are never silent', () => {
  it('tells the user once with [Повторить] [Выключить]', async () => {
    failureStreaks.mockResolvedValue(streak(1));
    expect(await sweepTaskFailures()).toBe(1);
    const m = fake.sent.at(-1)!;
    expect(m.chatId).toBe(FRIEND_A);
    expect(m.md).toContain('⚠️ «Дайджест» не отработал');
    expect(m.md).toContain('сайт не отвечает');
    const data = m.buttons!.flat().map((b) => b.data!.split(':').slice(0, 2).join(':'));
    expect(data).toEqual(['p:trun', 'p:tp']);
    expect(pauseTask).not.toHaveBeenCalled();
  });

  it('the same failure is not announced again, and a second failure the same day is throttled', async () => {
    failureStreaks.mockResolvedValue(streak(1));
    await sweepTaskFailures();
    await sweepTaskFailures();
    expect(fake.sent).toHaveLength(1);
    failureStreaks.mockResolvedValue(streak(2));
    await sweepTaskFailures();
    expect(fake.sent).toHaveLength(1); // one message per task per day
  });

  it('a new day brings a new message for a new failure; a success resets the memory', async () => {
    failureStreaks.mockResolvedValue(streak(1));
    await sweepTaskFailures(new Date('2026-10-10T10:00:00Z'));
    failureStreaks.mockResolvedValue(streak(2));
    await sweepTaskFailures(new Date('2026-10-11T10:00:00Z'));
    expect(fake.sent).toHaveLength(2);
    failureStreaks.mockResolvedValue(streak(0));
    await sweepTaskFailures();
    expect(await kvGet('taskfail-seen:digest-ab12')).toBeUndefined();
  });

  it('five failures in a row switch the task off and say so (even on a day that already had a message)', async () => {
    failureStreaks.mockResolvedValue(streak(4));
    await sweepTaskFailures(new Date('2026-10-10T10:00:00Z'));
    failureStreaks.mockResolvedValue(streak(5));
    await sweepTaskFailures(new Date('2026-10-10T12:00:00Z'));
    expect(pauseTask).toHaveBeenCalledWith('ag-1', 'digest-ab12');
    expect(fake.sent.at(-1)!.md).toContain('Я его выключил');
  });

  it('a failed send is retried on the next pass', async () => {
    const { tg } = await import('./port.js');
    const spy = vi.spyOn(tg, 'sendProduct').mockRejectedValueOnce(new Error('down'));
    failureStreaks.mockResolvedValue(streak(1));
    expect(await sweepTaskFailures()).toBe(0);
    spy.mockRestore();
    expect(await sweepTaskFailures()).toBe(1);
  });
});
