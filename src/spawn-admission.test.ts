import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerSessionKindResolver } from './lifecycle-policy.js';
import {
  _resetSpawnAdmissionForTesting,
  admitSpawn,
  drainSpawnQueue,
  queuedWakeCount,
  releaseSpawnSlot,
  requestIdlePreempt,
  setIdlePreemptor,
} from './spawn-admission.js';
import type { Session } from './types.js';

const sess = (id: string, group: string): Session => ({
  id,
  agent_group_id: group,
  messaging_group_id: null,
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: new Date().toISOString(),
});

afterEach(() => {
  setIdlePreemptor(null);
  delete process.env.NC_MAX_CONTAINERS;
  registerSessionKindResolver(null);
  _resetSpawnAdmissionForTesting();
});

describe('spawn admission', () => {
  it('has no cap by default', () => {
    expect(admitSpawn(sess('a', 'g'), new Set(['x', 'y', 'z']))).toBe(true);
  });

  it('queues over the cap and starts the owner before earlier friends', () => {
    process.env.NC_MAX_CONTAINERS = '2';
    registerSessionKindResolver((g) => (g === 'owner-g' ? 'owner' : 'friend'));
    const active = new Set(['r1', 'r2']);
    expect(admitSpawn(sess('f1', 'fg'), active)).toBe(false);
    expect(admitSpawn(sess('o1', 'owner-g'), active)).toBe(false);
    expect(admitSpawn(sess('f1', 'fg'), active)).toBe(false); // retry does not double-queue
    expect(queuedWakeCount()).toBe(2);

    const start = vi.fn();
    drainSpawnQueue(active, start);
    expect(start).not.toHaveBeenCalled();

    active.delete('r1');
    drainSpawnQueue(active, start);
    expect(start.mock.calls.map((c) => (c[0] as Session).id)).toEqual(['o1']);
    expect(admitSpawn(sess('o1', 'owner-g'), active)).toBe(true); // pre-admitted by the queue

    // the admitted-but-not-yet-active session still holds its slot
    drainSpawnQueue(active, start);
    expect(start).toHaveBeenCalledTimes(1);

    active.add('o1');
    releaseSpawnSlot('o1');
    active.delete('r2');
    drainSpawnQueue(active, start);
    expect(start.mock.calls.map((c) => (c[0] as Session).id)).toEqual(['o1', 'f1']);
  });
});

describe('idle preempt request', () => {
  it('asks the preemptor only while a wake is queued', () => {
    process.env.NC_MAX_CONTAINERS = '1';
    const calls: Array<[number, string[]]> = [];
    setIdlePreemptor((queued, ids) => calls.push([queued, ids]));
    const active = new Set(['idle-1']);
    requestIdlePreempt(active);
    expect(calls).toEqual([]);
    expect(admitSpawn(sess('f1', 'fg'), active)).toBe(false);
    requestIdlePreempt(active);
    expect(calls).toEqual([[1, ['idle-1']]]);
  });
});
