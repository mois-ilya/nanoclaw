/** Shared settings writes (Mini App PATCH /api/settings and the agent's `ncl me set-timezone`). */
import { updateContainerConfigScalars } from '../db/container-configs.js';
import { nc } from './config.js';
import { getPrefs, putPrefs, type Tenant } from './store.js';
import { rearmRecurring } from './tasks.js';

export function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(tz);
  } catch {
    return false;
  }
}

/**
 * Set a tenant's timezone everywhere it matters: prefs (Mini App), the group's container config (cron and
 * naive `--process-after` are read in it, the agent's clock too) and the next armed occurrence of every
 * recurring task. A running container keeps the old TZ until its next spawn.
 */
export async function applyTimezone(t: Pick<Tenant, 'user_id' | 'agent_group_id'>, tz: string): Promise<boolean> {
  if (!validTz(tz)) return false;
  const cur = await getPrefs(t.user_id, { tz: nc.defaultTz() });
  if (cur.tz !== tz) await putPrefs(t.user_id, { ...cur, tz });
  if (t.agent_group_id) {
    await updateContainerConfigScalars(t.agent_group_id, { timezone: tz });
    if (cur.tz !== tz) await rearmRecurring(t.agent_group_id, tz).catch(() => 0);
  }
  return true;
}
