/**
 * Per-session reconcile — one session's maintenance pass, extracted from the
 * host sweep so it can run per key instead of only inside the global tick.
 * `reconcileSession(sessionId)` is the `ReconcileFn` shape from
 * src/reconcile.ts: level-triggered, reads current state, a missing or
 * closed session is a clean no-op.
 *
 * Stuck / idle detection (replaces the old IDLE_TIMEOUT setTimeout + 10-min
 * heartbeat threshold):
 *
 *   If the container isn't running and there are 'processing' rows left over
 *   (e.g. it crashed mid-turn) → reset them to pending with backoff +
 *   tries++. Existing retry machinery does the rest.
 *
 *   If the container IS running:
 *     1. Absolute ceiling: heartbeat age > max(30 min, current_bash_timeout)
 *        → kill. Covers the "alive but silent for 30 min" case. Extended
 *        only while Bash is declared as running longer, honouring the
 *        user's own timeout directive. Kill then resets processing rows.
 *        When no heartbeat file exists yet, falls back to the tracked
 *        container spawn time so a container that goes idle without ever
 *        reaching an SDK event —
 *        and so never writes a heartbeat — still ages out instead of
 *        living forever (see decideStuckAction's grace-period comment).
 *
 *     2. Message-scoped stuck: for each 'processing' row, tolerance =
 *        max(60s, current_bash_timeout_ms_if_Bash_running). If
 *        (claim_age > tolerance) AND (heartbeat_mtime <= status_changed)
 *        → kill + reset this message + tries++. Semantics: "container
 *        claimed a message and went quiet past tolerance since the claim."
 */
import fs from 'fs';

import { getSessionClaim } from './db/coordination.js';
import { getSession, isTaskThread, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { idleMsFor, sessionKind } from './lifecycle-policy.js';
import { setIdlePreemptor } from './spawn-admission.js'; // nanoclaw-fork
import { log } from './log.js';
import { heartbeatPath, withExistingMailboxSession } from './session-manager.js';
import { getContainerStartedAtMs, isContainerRunning, killContainer } from './container-runner.js';
import { hasReplyDelivered } from './reply-ledger.js';
import { requestWake } from './request-wake.js';
import type { Session } from './types.js';
import type { ContainerState, InboundMailbox, OutboundMailbox } from './mailbox/index.js';

// Absolute idle ceiling for a running container. If the heartbeat file hasn't
// been touched in this long, the container is either stuck or doing genuinely
// nothing — kill and restart on the next inbound.
export const ABSOLUTE_CEILING_MS = 30 * 60 * 1000;
// Stuck tolerance window applied per 'processing' claim — "did we see any
// signs of life since this message was claimed?"
export const CLAIM_STUCK_MS = 60 * 1000;
const MAX_TRIES = 5;
// nanoclaw-fork: a chat turn is retried once after a crash (not 5 times with 80 s backoff).
const CHAT_MAX_TRIES = 1;
const BACKOFF_BASE_MS = 5000;

export type StuckDecision =
  | { action: 'ok' }
  | { action: 'kill-ceiling'; heartbeatAgeMs: number; ceilingMs: number }
  | { action: 'kill-claim'; messageId: string; claimAgeMs: number; toleranceMs: number }
  | { action: 'kill-idle'; idleMs: number; limitMs: number };

/**
 * Pure decision for whether a running container should be killed this sweep
 * tick. Inputs are all deterministic; filesystem and mailbox reads happen in the
 * caller.
 */
export function decideStuckAction(args: {
  now: number;
  heartbeatMtimeMs: number; // 0 when heartbeat file absent
  containerStartedAtMs?: number; // fallback when heartbeat file absent
  containerState: ContainerState | null;
  claims: Array<{ messageId: string; statusChanged: string }>;
  /** nanoclaw-fork: per-role idle limit (NC_IDLE_*_MINUTES); null/undefined = no idle stop. */
  idleLimitMs?: number | null;
  /** nanoclaw-fork: messages are waiting for this container, so it is not idle. */
  hasDueMessages?: boolean;
}): StuckDecision {
  const { now, heartbeatMtimeMs, containerStartedAtMs, containerState, claims, idleLimitMs, hasDueMessages } = args;
  const declaredBashMs = bashTimeoutMs(containerState);

  // Ceiling check prefers the heartbeat file's mtime. A freshly-spawned
  // container hasn't had any SDK activity yet so no heartbeat file exists —
  // if we treated that as infinitely stale we'd kill every container within
  // seconds of spawn. But "no heartbeat file" isn't only a spawn-grace-period
  // signal: a container can also finish its one turn (or find nothing to do)
  // without its poll loop ever reaching an SDK event, in which case a
  // heartbeat file is never created for the rest of that container's life,
  // and it sits alive-but-idle forever, immune to this check. Falling back
  // to the container's spawn timestamp gives fresh spawns the same grace
  // period as before (age starts at ~0) while still aging out a
  // container that never ticks. Genuinely-dead containers that never wrote a
  // heartbeat AND have no session record are caught by the separate
  // "container process not running" cleanup path, not here. If a fresh
  // container is hanging at the gate (claimed a message but never did
  // anything) the claim-stuck check below handles it independently of this
  // fallback.
  const effectiveHeartbeatMs = heartbeatMtimeMs !== 0 ? heartbeatMtimeMs : (containerStartedAtMs ?? 0);
  // nanoclaw-fork: idle stop — nothing claimed, nothing waiting, no activity for the role's limit.
  if (idleLimitMs && effectiveHeartbeatMs !== 0 && claims.length === 0 && !hasDueMessages && !declaredBashMs) {
    const idle = now - effectiveHeartbeatMs;
    if (idle > idleLimitMs) return { action: 'kill-idle', idleMs: idle, limitMs: idleLimitMs };
  }
  if (effectiveHeartbeatMs !== 0) {
    const heartbeatAge = now - effectiveHeartbeatMs;
    const ceiling = Math.max(ABSOLUTE_CEILING_MS, declaredBashMs ?? 0);
    if (heartbeatAge > ceiling) {
      return { action: 'kill-ceiling', heartbeatAgeMs: heartbeatAge, ceilingMs: ceiling };
    }
  }

  const tolerance = Math.max(CLAIM_STUCK_MS, declaredBashMs ?? 0);
  for (const claim of claims) {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt)) continue;
    const claimAge = now - claimedAt;
    if (claimAge <= tolerance) continue;
    if (heartbeatMtimeMs > claimedAt) continue;
    return { action: 'kill-claim', messageId: claim.messageId, claimAgeMs: claimAge, toleranceMs: tolerance };
  }

  return { action: 'ok' };
}

/** A per-task session with no live tasks and no running container is spent → close it. */
export function shouldCloseTaskSession(
  threadId: string | null,
  containerRunning: boolean,
  liveTaskCount: number,
): boolean {
  return isTaskThread(threadId) && !containerRunning && liveTaskCount === 0;
}

/** Reconcile one session against current state. Missing/closed sessions no-op. */
export async function reconcileSession(sessionId: string): Promise<void> {
  const session = await getSession(sessionId);
  if (!session || session.status !== 'active') return;
  await reconcileActiveSession(session);
}

async function reconcileActiveSession(session: Session): Promise<void> {
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  try {
    let dueCount = 0;
    let shouldWake = false;
    const exists = await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks());
      dueCount = mailbox.countDueMessages();
      shouldWake = dueCount > 0 && !isContainerRunning(session.id);
      if (!shouldWake) {
        await maintainSessionMailbox(mailbox, session, agentGroup.id);
      }
      return true;
    });
    if (!exists) return;

    if (!shouldWake) return;

    // Waking refreshes routing through the mailbox. Keep it outside the
    // session transaction so serialized implementations do not re-enter
    // themselves while the sweep still owns the session.
    log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
    await requestWake(session, 'due-message');

    await withExistingMailboxSession(agentGroup.id, session.id, async (mailbox) => {
      await maintainSessionMailbox(mailbox, session, agentGroup.id);
    });
  } catch (err) {
    log.error('Session mailbox sweep failed', {
      agentGroupId: agentGroup.id,
      sessionId: session.id,
      err,
    });
  }
}

async function maintainSessionMailbox(
  mailbox: InboundMailbox & OutboundMailbox,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  const alive = isContainerRunning(session.id);
  if (alive) {
    await enforceRunningContainerSla(mailbox, mailbox, session, agentGroupId);
  }
  if (!alive) {
    await noticeGaveUp(mailbox, session, resetStuckProcessingRows(mailbox, mailbox, session, 'container not running'));
  }

  // MODULE-HOOK:scheduling-recurrence:start
  const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
  await handleRecurrence(mailbox, session);
  // MODULE-HOOK:scheduling-recurrence:end

  if (isTaskThread(session.thread_id)) {
    const liveTasks = mailbox.countLiveTasks();
    if (shouldCloseTaskSession(session.thread_id, isContainerRunning(session.id), liveTasks)) {
      await updateSession(session.id, { status: 'closed' });
      log.info('Closed spent task session', { sessionId: session.id, threadId: session.thread_id });
    }
  }

  // MODULE-HOOK:cross-session-echo-prune:start
  try {
    const { pruneEchoBacklog } = await import('./modules/cross-session-context/index.js');
    const pruned = pruneEchoBacklog(mailbox);
    if (pruned > 0) log.info('Pruned session-echo backlog', { sessionId: session.id, pruned });
  } catch (err) {
    log.error('Echo backlog prune failed', { sessionId: session.id, err });
  }
  // MODULE-HOOK:cross-session-echo-prune:end
}

async function wakeIfDue(session: Session, agentGroupId: string): Promise<void> {
  try {
    const due = await withExistingMailboxSession(agentGroupId, session.id, (m) => m.countDueMessages());
    if (due && due > 0) await requestWake(session, 'due-message');
  } catch (err) {
    log.warn('Post-stop wake check failed', { sessionId: session.id, err });
  }
}

// nanoclaw-fork: NC_MAX_CONTAINERS counts warm idle containers; when a wake is queued, stop one of them
// (friend first, then the longest quiet) instead of making the queued user wait out the idle limit.
const preempting = new Set<string>();

async function preemptIdleContainer(queued: number, activeIds: string[]): Promise<void> {
  if (preempting.size >= queued) return;
  const candidates: { id: string; friend: boolean; hbMs: number; session: Session; groupId: string }[] = [];
  for (const id of activeIds) {
    if (preempting.has(id)) continue;
    const session = await getSession(id);
    if (!session || session.status !== 'active') continue;
    const idle = await withExistingMailboxSession(session.agent_group_id, id, (m) => {
      if (m.getProcessingClaims().length > 0) return false;
      return m.countDueMessages() === 0;
    }).catch(() => false);
    if (!idle) continue;
    const hb = heartbeatMtimeMs(session.agent_group_id, id) || (getContainerStartedAtMs(id) ?? 0);
    candidates.push({
      id,
      friend: sessionKind(session.agent_group_id) !== 'owner',
      hbMs: hb,
      session,
      groupId: session.agent_group_id,
    });
  }
  candidates.sort((a, b) => Number(b.friend) - Number(a.friend) || a.hbMs - b.hbMs);
  const victim = candidates[0];
  if (!victim || preempting.size >= queued) return;
  preempting.add(victim.id);
  log.info('Stopping idle container to free a slot for a queued wake', { sessionId: victim.id, queued });
  killContainer(victim.id, 'idle-preempt', () => {
    preempting.delete(victim.id);
    void wakeIfDue(victim.session, victim.groupId);
  });
}

setIdlePreemptor((queued, activeIds) => {
  void preemptIdleContainer(queued, activeIds).catch((err) => log.warn('Idle preempt failed', { err }));
});

export function _preemptIdleContainerForTesting(queued: number, activeIds: string[]): Promise<void> {
  return preemptIdleContainer(queued, activeIds);
}

function heartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  const hbPath = heartbeatPath(agentGroupId, sessionId);
  try {
    return fs.statSync(hbPath).mtimeMs;
  } catch {
    return 0;
  }
}

function bashTimeoutMs(state: ContainerState | null): number | null {
  if (!state || state.currentTool !== 'Bash') return null;
  return state.toolDeclaredTimeoutMs;
}

/**
 * The incarnation gate: evidence that predates the current incarnation's
 * durable claim time is not evidence against this container. A heartbeat
 * mtime older than the claim is the previous incarnation's file — treated as
 * absent, so the spawn-time fallback gives the fresh container its grace. A
 * processing claim older than the claim time was inherited from a crashed
 * predecessor — its age is measured from this incarnation's start, so the
 * fresh container gets a full tolerance window to clear it before it can
 * kill. Replaces the old wake-tick grace flag: the fence is a durable fact
 * about when this incarnation began, not volatile "we just woke it"
 * bookkeeping — it survives restarts and applies on every pass, not only the
 * one that issued the wake.
 */
async function enforceRunningContainerSla(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  agentGroupId: string,
): Promise<void> {
  let incarnationStartMs = 0;
  const claimRow = await getSessionClaim(session.id);
  if (claimRow?.claimed_at) {
    const parsed = Date.parse(claimRow.claimed_at);
    if (!Number.isNaN(parsed)) incarnationStartMs = parsed;
  }

  const rawHeartbeatMs = heartbeatMtimeMs(agentGroupId, session.id);
  const gatedHeartbeatMs = rawHeartbeatMs >= incarnationStartMs ? rawHeartbeatMs : 0;
  const gatedClaims = outDb.getProcessingClaims().map((claim) => {
    const claimedAt = Date.parse(claim.statusChanged);
    if (Number.isNaN(claimedAt) || claimedAt >= incarnationStartMs) return claim;
    return { ...claim, statusChanged: new Date(incarnationStartMs).toISOString() };
  });

  const decision = decideStuckAction({
    now: Date.now(),
    heartbeatMtimeMs: gatedHeartbeatMs,
    containerStartedAtMs: getContainerStartedAtMs(session.id),
    containerState: outDb.getContainerState(),
    claims: gatedClaims,
    idleLimitMs: idleMsFor(agentGroupId),
    hasDueMessages: inDb.countDueMessages() > 0,
  });

  if (decision.action === 'ok') return;

  if (decision.action === 'kill-idle') {
    log.info('Stopping idle container', { sessionId: session.id, idleMs: decision.idleMs, limitMs: decision.limitMs });
    // nanoclaw-fork: a message that landed while the stop was in flight saw "already running" — wake it after exit.
    killContainer(session.id, 'idle', () => void wakeIfDue(session, agentGroupId));
    return;
  }

  if (decision.action === 'kill-ceiling') {
    log.warn('Killing container past absolute ceiling', {
      sessionId: session.id,
      heartbeatAgeMs: decision.heartbeatAgeMs,
      ceilingMs: decision.ceilingMs,
    });
    killContainer(session.id, 'absolute-ceiling');
    await noticeGaveUp(outDb, session, resetStuckProcessingRows(inDb, outDb, session, 'absolute-ceiling'));
    return;
  }

  log.warn('Killing container — message claimed then silent', {
    sessionId: session.id,
    messageId: decision.messageId,
    claimAgeMs: decision.claimAgeMs,
    toleranceMs: decision.toleranceMs,
  });
  killContainer(session.id, 'claim-stuck');
  await noticeGaveUp(outDb, session, resetStuckProcessingRows(inDb, outDb, session, 'claim-stuck'));
}

export function _resetStuckProcessingRowsForTesting(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  reason: string,
): number {
  return resetStuckProcessingRows(inDb, outDb, session, reason);
}

function resetStuckProcessingRows(
  inDb: InboundMailbox,
  outDb: OutboundMailbox,
  session: Session,
  reason: string,
): number {
  let failed = 0;
  const claims = outDb.getProcessingClaims();
  const now = Date.now();
  const isChat = !!session.messaging_group_id && !isTaskThread(session.thread_id);
  const maxTries = isChat ? CHAT_MAX_TRIES : MAX_TRIES;
  // nanoclaw-fork: if any message of the crashed batch already got a delivered reply, re-running the
  // turn would send it again (and repeat side effects): give the batch up instead.
  const partlyAnswered = isChat && claims.some((c) => hasReplyDelivered(session.id, c.messageId));
  for (const { messageId } of claims) {
    const msg = inDb.getMessageForRetry(messageId, 'pending');
    if (!msg) continue;

    // Already rescheduled for a future retry — don't bump tries again. The
    // wake path (sweep step 2) will fire when process_after elapses and a
    // fresh container will clean the orphan claim on startup.
    if (msg.processAfter && Date.parse(msg.processAfter) > now) continue;

    if (partlyAnswered || msg.tries >= maxTries) {
      inDb.markMessageFailed(msg.id);
      failed++;
      if (partlyAnswered) partialGaveUp.add(session.id);
      log.warn(
        partlyAnswered
          ? 'Message marked as failed: the crashed turn already delivered a reply'
          : 'Message marked as failed after max retries',
        { messageId: msg.id, sessionId: session.id, reason },
      );
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      inDb.retryWithBackoff(msg.id, backoffSec);
      log.info('Reset stale message with backoff', {
        messageId: msg.id,
        tries: msg.tries,
        backoffMs,
        reason,
      });
    }
  }

  // Drop the orphan 'processing' rows. Without this, the next sweep tick
  // would re-read them, see the old status_changed timestamp, conclude the
  // freshly respawned container is stuck, and SIGKILL it before its
  // agent-runner has a chance to run clearStaleProcessingAcks() on startup.
  try {
    const cleared = outDb.deleteOrphanProcessingClaims();
    if (cleared > 0) {
      log.info('Cleared orphan processing claims', { sessionId: session.id, cleared, reason });
    }
  } catch (err) {
    log.warn('Failed to clear orphan processing claims', { sessionId: session.id, err });
  }
  return failed;
}

// Sessions whose last give-up was a partly answered turn (copy differs from "retries exhausted").
const partialGaveUp = new Set<string>();

/** nanoclaw-fork: a message given up after MAX_TRIES must not vanish silently. */
export async function noticeGaveUp(outDb: OutboundMailbox, session: Session, failed: number): Promise<void> {
  const partial = partialGaveUp.delete(session.id);
  if (failed === 0 || !session.messaging_group_id || isTaskThread(session.thread_id)) return;
  try {
    const mg = await getMessagingGroup(session.messaging_group_id);
    if (!mg) return;
    await outDb.writeDirect({
      id: `gaveup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      platformId: mg.platform_id,
      channelType: mg.channel_type,
      threadId: session.thread_id,
      content: JSON.stringify({
        text: partial
          ? 'Ответ оборвался на середине: что-то пошло не так. Часть ты уже получил. Если нужно продолжить, пришли сообщение ещё раз.'
          : 'Не смог обработать твоё сообщение: несколько попыток подряд не дошли до конца. Пришли его ещё раз.',
      }),
    });
  } catch (err) {
    log.warn('Failed to notify about a message given up after max retries', { sessionId: session.id, err });
  }
}
