/** Owner alerts, the weekly digest and turn metrics. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  getActiveContainerCount: vi.fn(() => 0),
  killContainer: vi.fn(),
}));

import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { emitHostError, emitHostTurn } from '../host-errors.js';
import { alertOwner, recordError, startAlerts, stopAlerts, watchOnce } from './alerts.js';
import { buildDigest, maybeSendDigest } from './digest.js';
import { errorsByClass, healthReport, recentErrors } from './health.js';
import { percentile, recordTurn, turnMetrics } from './metrics.js';
import { insertTenantIfAbsent, kvGet, updateTenant } from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, installFakeAdapter, setupDb } from './test-helpers.js';

let fake: ReturnType<typeof installFakeAdapter>;
let ng: ReturnType<typeof fakeNanogate>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  await setupDb();
  fake = installFakeAdapter();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  await insertTenantIfAbsent({ tgId: OWNER, name: 'Илья', state: 'ready' });
  await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
  await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
});
afterEach(async () => {
  stopAlerts();
  setNanogateAdminForTests(null);
  await closeDb();
});

describe('error record', () => {
  it('counts every class, not only failed slash-commands', async () => {
    await recordError('container', 's-1', 'spawn failed');
    await recordError('container', 's-2');
    await recordError('render', 'chat-1');
    expect(await recentErrors()).toBe(3);
    expect(await errorsByClass()).toEqual({ container: 2, render: 1 });
    expect(await healthReport()).toContain('container: 2');
  });
});

describe('owner alerts', () => {
  it('nanogate down: alerted once after two failed checks, and again on recovery', async () => {
    ng.healthz.mockResolvedValue(false);
    await watchOnce();
    expect(fake.sent).toHaveLength(0); // one blip is not an outage
    await watchOnce();
    await watchOnce();
    const down = fake.sent.filter((s) => s.chatId === OWNER);
    expect(down).toHaveLength(1);
    expect(down[0].md).toContain('недоступен');
    ng.healthz.mockResolvedValue(true);
    await watchOnce();
    expect(fake.sent.at(-1)!.md).toContain('снова работает');
    expect(await errorsByClass()).toEqual({ gateway: 1 });
  });

  it('three container start failures in ten minutes alert the owner, at most once an hour', async () => {
    startAlerts(3_600_000);
    for (let i = 0; i < 5; i++) emitHostError('container', 's-9', 'boom');
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.sent.filter((s) => s.md.includes('не запускается'))).toHaveLength(1);
    expect(await recentErrors()).toBe(5);
  });

  it('alertOwner throttles by key', async () => {
    expect(await alertOwner('k', 'a')).toBe(true);
    expect(await alertOwner('k', 'b')).toBe(false);
    expect(await alertOwner('k', 'c', { throttleMs: 0 })).toBe(true);
    expect(await kvGet('alert:k')).toBeTruthy();
  });
});

describe('weekly digest', () => {
  it('goes out on Monday after 09:00 local, once per week', async () => {
    const mon = new Date('2026-10-12T10:00:00Z'); // Monday; default tz Europe/Moscow = 13:00
    expect(await maybeSendDigest(new Date('2026-10-13T10:00:00Z'))).toBe(false); // Tuesday
    expect(await maybeSendDigest(new Date('2026-10-12T04:00:00Z'))).toBe(false); // 07:00 Moscow
    expect(await maybeSendDigest(mon)).toBe(true);
    expect(await maybeSendDigest(new Date('2026-10-12T15:00:00Z'))).toBe(false);
    const m = fake.sent.at(-1)!;
    expect(m.chatId).toBe(OWNER);
    expect(m.buttons!.flat()[0].webApp).toBe('system');
    expect(m.md).toContain('Неделя в цифрах');
  });
  it('lists spend per person and errors', async () => {
    ng.usage.mockResolvedValue({ rows: [{ cost_micros: 1_250_000 }] });
    await recordError('turn', 'chat');
    const text = await buildDigest();
    expect(text).toContain('Маша');
    expect(text).toContain('$1.25');
    expect(text).toContain('Ошибок: 1');
  });
});

describe('turn metrics', () => {
  it('percentiles, cold-start, stop, failure and voice rates', async () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 95)).toBe(0);
    const t0 = 1_000_000;
    await recordTurn({
      chatId: 1,
      outcome: 'final',
      tInbound: t0,
      tReact: t0 + 300,
      tFirstPreview: t0 + 2000,
      tFinal: t0 + 9000,
      voice: true,
      coldStart: true,
    });
    await recordTurn({ chatId: 1, outcome: 'failed', tInbound: t0, tReact: t0 + 400 });
    await recordTurn({ chatId: 2, outcome: 'cancelled', tInbound: t0, tReact: t0 + 200, stopped: true });
    await recordTurn({
      chatId: 2,
      outcome: 'final',
      tInbound: t0,
      tReact: t0 + 250,
      tFirstPreview: t0 + 3000,
      tFinal: t0 + 6000,
    });
    const m = await turnMetrics(7);
    expect(m.turns).toBe(4);
    expect(m.coldStartRate).toBe(0.25);
    expect(m.failRate).toBe(0.25);
    expect(m.stopRate).toBe(0.25);
    expect(m.voiceShare).toBe(0.25);
    expect(m.reactMs.p50).toBe(250);
    expect(m.firstPreviewMs.p95).toBe(3000);
  });
  it('the host bus feeds the table (adapter -> nc)', async () => {
    const { startTurnMetrics } = await import('./metrics.js');
    startTurnMetrics();
    emitHostTurn({ chatId: 5, outcome: 'final', tInbound: 1000, tReact: 1100, tFinal: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await turnMetrics(1)).turns).toBeGreaterThanOrEqual(1);
  });
});

describe('/health stays fast when nanogate hangs', () => {
  it('skips per-tenant spend lookups when the gateway is down', async () => {
    ng.healthz.mockResolvedValue(false);
    const t = Date.now();
    const text = await healthReport();
    expect(Date.now() - t).toBeLessThan(1500);
    expect(text).toContain('недоступен');
    expect(ng.budget).not.toHaveBeenCalled();
  });
});
