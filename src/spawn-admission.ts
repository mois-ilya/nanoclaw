// nanoclaw-fork: global cap on concurrently running agent containers (NC_MAX_CONTAINERS) with a wait
// queue. A wake over the cap is queued, not blocked: wakeContainer answers `false` (the inbound row
// stays pending, host-sweep keeps retrying) and the queue itself starts the session the moment a slot
// frees up, owner sessions before friends, FIFO inside each group.
import { maxContainers, sessionKind } from './lifecycle-policy.js';
import { log } from './log.js';
import type { Session } from './types.js';

interface Waiter {
  session: Session;
  owner: boolean;
  seq: number;
}

const waiting = new Map<string, Waiter>();
/** Sessions admitted whose container is not yet (or no longer) tracked as active. */
const admitted = new Set<string>();
let seq = 0;

function used(active: ReadonlySet<string>): number {
  let n = active.size;
  for (const id of admitted) if (!active.has(id)) n++;
  return n;
}

/** True when the session may spawn now; false when it was queued. `active` = ids with a running container. */
export function admitSpawn(session: Session, active: ReadonlySet<string>): boolean {
  const cap = maxContainers();
  if (cap <= 0) return true;
  if (admitted.has(session.id)) return true;
  if (used(active) < cap) {
    admitted.add(session.id);
    return true;
  }
  if (!waiting.has(session.id)) {
    waiting.set(session.id, { session, owner: sessionKind(session.agent_group_id) === 'owner', seq: seq++ });
    log.info('Container cap reached — wake queued', { sessionId: session.id, cap, queued: waiting.size });
  }
  return false;
}

/** The spawn finished (container is now in `active`) or failed: it no longer holds a pre-admission slot. */
export function releaseSpawnSlot(sessionId: string): void {
  admitted.delete(sessionId);
}

/** Forget a queued wake (the session is already running, or gone). */
export function dropQueuedWake(sessionId: string): void {
  waiting.delete(sessionId);
}

/** Start queued sessions while slots are free. `start` is wakeContainer; it sees the session already admitted. */
export function drainSpawnQueue(active: ReadonlySet<string>, start: (session: Session) => void): void {
  const cap = maxContainers();
  if (cap <= 0) {
    // Cap lifted at runtime: release everyone.
    for (const w of [...waiting.values()]) {
      waiting.delete(w.session.id);
      start(w.session);
    }
    return;
  }
  while (waiting.size > 0 && used(active) < cap) {
    const next = [...waiting.values()].sort((a, b) => Number(b.owner) - Number(a.owner) || a.seq - b.seq)[0];
    waiting.delete(next.session.id);
    if (active.has(next.session.id)) continue;
    admitted.add(next.session.id);
    start(next.session);
  }
}

export function queuedWakeCount(): number {
  return waiting.size;
}

type IdlePreemptor = (queued: number, activeIds: string[]) => void;
let preemptor: IdlePreemptor | null = null;

/** reconcile-session registers how to find a warm idle container to stop (it owns the mailbox reads). */
export function setIdlePreemptor(next: IdlePreemptor | null): void {
  preemptor = next;
}

/** A wake is queued: warm idle containers hold the slots, ask for one of them to be stopped. */
export function requestIdlePreempt(active: ReadonlySet<string>): void {
  if (waiting.size > 0 && active.size > 0) preemptor?.(waiting.size, [...active]);
}

export function _resetSpawnAdmissionForTesting(): void {
  waiting.clear();
  admitted.clear();
  seq = 0;
}
