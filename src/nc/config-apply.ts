/**
 * Applying a changed `container.json` to the sessions that are already running.
 *
 * A container reads its config once, at spawn. When the effective config of an agent group changes (connector
 * toggled or key changed, skill switched, MCP server added), the host leaves a mark `cfg-changed:<group>` (ms,
 * kv). `applyConfigSweep` stops every running container of that group that started before the mark and is idle
 * (no processing claim, nothing due): nothing wakes it, the next message starts it with the fresh file. Busy ones
 * wait for the next pass. The sweep rides the host sweep tick (`registerSweepDuty`); a mark also triggers one
 * debounced pass so the common case does not wait a minute. The mark lives in kv and the start time comes from
 * the runtime, so a host restart needs no generation counter.
 */
import { getContainerConfigStartedAtMs, isContainerRunning, killContainer } from '../container-runner.js';
import { getDb, hasTable } from '../db/connection.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { log } from '../log.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { kvDelete, kvGet, kvSet } from './store.js';

const KEY_PREFIX = 'cfg-changed:';
const DEBOUNCE_MS = 2_000;
/** A mark with no stale container is dropped only after this long: a spawn in flight is not yet «running». */
const MARK_TTL_MS = 10 * 60_000;

let debounce: NodeJS.Timeout | undefined;

/** Record that the group's config changed now, and schedule a prompt (debounced) apply pass. */
export async function markGroupConfigDirty(agentGroupId: string, reason: string): Promise<void> {
  await kvSet(KEY_PREFIX + agentGroupId, String(Date.now()));
  log.info('nc: group config changed', { group: agentGroupId, reason });
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = undefined;
    void applyConfigSweep().catch((err) => log.warn('nc: config apply failed', { err }));
  }, DEBOUNCE_MS);
  debounce.unref();
}

export function stopConfigApply(): void {
  if (debounce) clearTimeout(debounce);
  debounce = undefined;
}

async function changedAt(agentGroupId: string): Promise<number> {
  const n = Number(await kvGet(KEY_PREFIX + agentGroupId));
  return Number.isFinite(n) ? n : 0;
}

/** Sessions of the group that run a container started before the mark. */
async function staleSessions(
  agentGroupId: string,
  mark: number,
): Promise<Array<{ id: string; agent_group_id: string }>> {
  if (!mark) return [];
  const out: Array<{ id: string; agent_group_id: string }> = [];
  for (const s of await getSessionsByAgentGroup(agentGroupId)) {
    if (s.status !== 'active' || !isContainerRunning(s.id)) continue;
    const started = getContainerConfigStartedAtMs(s.id);
    if (started !== undefined && started < mark) out.push(s);
  }
  return out;
}

/** True while the group has a running container that still holds the old config (the Mini App says «применяется»). */
export async function groupApplying(agentGroupId: string): Promise<boolean> {
  return (await staleSessions(agentGroupId, await changedAt(agentGroupId))).length > 0;
}

async function idle(s: { id: string; agent_group_id: string }): Promise<boolean> {
  // One read for both: a message claimed between two separate reads would look like neither busy nor due.
  const free = await withExistingMailboxSession(
    s.agent_group_id,
    s.id,
    (m) => m.getProcessingClaims().length === 0 && m.countDueMessages() === 0,
  ).catch(() => false);
  return free === true;
}

/** One pass over every group with a mark. Returns how many containers it stopped. */
export async function applyConfigSweep(): Promise<number> {
  const db = getDb();
  if (!(await hasTable(db, 'nc_kv'))) return 0;
  const marks = await db.all<{ key: string }>('SELECT key FROM nc_kv WHERE key LIKE ?', `${KEY_PREFIX}%`);
  let stopped = 0;
  for (const { key } of marks) {
    const group = key.slice(KEY_PREFIX.length);
    const mark = await changedAt(group);
    const stale = await staleSessions(group, mark);
    // Nothing holds the old config any more (and no spawn is in flight): the mark has done its job. Kept forever it
    // would make every host restart kill the adopted containers of the group once more.
    if (stale.length === 0 && Date.now() - mark > MARK_TTL_MS) await kvDelete(key);
    for (const s of stale) {
      if (!(await idle(s))) continue;
      log.info('nc: stopping idle container to apply a changed config', { group, sessionId: s.id });
      killContainer(s.id, 'config changed');
      stopped++;
    }
  }
  return stopped;
}
