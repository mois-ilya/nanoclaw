import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  running: new Map<string, number>(), // session id -> config start (ms)
  claimed: new Set<string>(),
  due: new Map<string, number>(),
  killed: [] as Array<[string, string]>,
}));
vi.mock('../container-runner.js', () => ({
  isContainerRunning: (id: string) => h.running.has(id),
  getContainerConfigStartedAtMs: (id: string) => h.running.get(id),
  killContainer: (id: string, reason: string) => {
    h.killed.push([id, reason]);
    h.running.delete(id);
  },
}));
vi.mock('../session-manager.js', () => ({
  withExistingMailboxSession: async (
    _g: string,
    id: string,
    fn: (m: { countDueMessages(): number; getProcessingClaims(): unknown[] }) => unknown,
  ) => fn({ countDueMessages: () => h.due.get(id) ?? 0, getProcessingClaims: () => (h.claimed.has(id) ? [{}] : []) }),
}));

import { closeDb, createAgentGroup, createSession } from '../db/index.js';
import { applyConfigSweep, groupApplying, markGroupConfigDirty, stopConfigApply } from './config-apply.js';
import { kvGet } from './store.js';
import { setupDb } from './test-helpers.js';
import type { Session } from '../types.js';

const now = (): string => new Date().toISOString();
function session(id: string, group: string, status: Session['status'] = 'active'): Session {
  return {
    id,
    agent_group_id: group,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status,
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
  h.running.clear();
  h.claimed.clear();
  h.due.clear();
  h.killed.length = 0;
  await setupDb();
  for (const g of ['ag-a', 'ag-b']) {
    await createAgentGroup({ id: g, name: g, folder: g, agent_provider: null, created_at: now() });
  }
  await createSession(session('s1', 'ag-a'));
  await createSession(session('s2', 'ag-a'));
  await createSession(session('s3', 'ag-b'));
});
afterEach(async () => {
  stopConfigApply();
  vi.useRealTimers();
  await closeDb();
});

const BEFORE = Date.parse('2026-10-14T11:00:00Z');

describe('applyConfigSweep', () => {
  it('stops only the idle session; the one with a processing claim waits and is stopped on a later pass', async () => {
    h.running.set('s1', BEFORE);
    h.running.set('s2', BEFORE);
    h.claimed.add('s2');
    await markGroupConfigDirty('ag-a', 'connector toggled');
    expect(await applyConfigSweep()).toBe(1);
    expect(h.killed).toEqual([['s1', 'config changed']]);
    expect(await groupApplying('ag-a')).toBe(true); // s2 still holds the old config
    h.claimed.delete('s2');
    expect(await applyConfigSweep()).toBe(1);
    expect(h.killed.map(([id]) => id)).toEqual(['s1', 's2']);
    expect(await groupApplying('ag-a')).toBe(false);
  });

  it('a session with due messages is busy', async () => {
    h.running.set('s1', BEFORE);
    h.due.set('s1', 2);
    await markGroupConfigDirty('ag-a', 'x');
    expect(await applyConfigSweep()).toBe(0);
    h.due.set('s1', 0);
    expect(await applyConfigSweep()).toBe(1);
  });

  it('leaves a container started after the mark alone', async () => {
    await markGroupConfigDirty('ag-a', 'x');
    vi.setSystemTime(new Date('2026-10-14T12:00:05Z'));
    h.running.set('s1', Date.now());
    expect(await applyConfigSweep()).toBe(0);
    expect(await groupApplying('ag-a')).toBe(false);
  });

  it('only touches the marked group, running containers of active sessions', async () => {
    h.running.set('s1', BEFORE);
    h.running.set('s3', BEFORE); // other group, no mark
    await markGroupConfigDirty('ag-a', 'x');
    await applyConfigSweep();
    expect(h.killed.map(([id]) => id)).toEqual(['s1']);
    // a session that is not running is not a candidate (its next spawn reads the new file)
    expect(await groupApplying('ag-b')).toBe(false);
  });

  it('the mark lives in kv, so a host restart still finds the stale container', async () => {
    h.running.set('s1', BEFORE);
    await markGroupConfigDirty('ag-a', 'x');
    expect(Number(await kvGet('cfg-changed:ag-a'))).toBe(Date.now());
    stopConfigApply(); // "restart": no in-memory state survives, only kv
    expect(await applyConfigSweep()).toBe(1);
  });

  it('an adopted container (start 0, no real start time known) counts as older than any mark', async () => {
    h.running.set('s1', 0);
    await markGroupConfigDirty('ag-a', 'x');
    expect(await applyConfigSweep()).toBe(1);
  });

  it('drops the mark once nothing stale runs and it is old enough; a fresh one stays', async () => {
    await markGroupConfigDirty('ag-a', 'x');
    await applyConfigSweep();
    expect(await kvGet('cfg-changed:ag-a')).toBeDefined(); // may still be spawning
    vi.setSystemTime(new Date('2026-10-14T12:11:00Z'));
    await applyConfigSweep();
    expect(await kvGet('cfg-changed:ag-a')).toBeUndefined();
  });

  it('a mark with a stale container still running is kept however old it is', async () => {
    h.running.set('s1', BEFORE);
    h.claimed.add('s1');
    await markGroupConfigDirty('ag-a', 'x');
    vi.setSystemTime(new Date('2026-10-14T13:00:00Z'));
    await applyConfigSweep();
    expect(await kvGet('cfg-changed:ag-a')).toBeDefined();
  });

  it('a mark triggers one debounced pass without waiting for the sweep tick', async () => {
    h.running.set('s1', BEFORE);
    await markGroupConfigDirty('ag-a', 'x');
    await markGroupConfigDirty('ag-a', 'y');
    expect(h.killed).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(() => expect(h.killed).toEqual([['s1', 'config changed']]));
  });
});
