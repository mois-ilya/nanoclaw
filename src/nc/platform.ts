/** Registers the host-owned platform layer (L0) with the project-document composer. */
import { setGroupResourceFilter } from '../cli/guard.js';
import { setSelfModVeto } from '../modules/self-mod/guard.js';
import { setAgentsCreateVeto } from '../modules/agent-to-agent/guard.js';
import { setPlatformLayerProvider } from '../project-doc-compose.js';
import { setSessionEnvProvider } from '../session-env.js';
import type { AgentGroup } from '../types.js';
import { nc, ownerTgId } from './config.js';
import { getPrefs, getTenantByGroup } from './store.js';
import { platformLayer } from './templates.js';
import { ownerAgentGroupId } from './tenants.js';

/** The L0 text for a group, or null for groups that are not a tenant's (nothing nc owns). */
export async function platformFor(group: AgentGroup): Promise<string | null> {
  const t = await getTenantByGroup(group.id);
  if (t) {
    const prefs = await getPrefs(t.user_id, { tz: nc.defaultTz() });
    return platformLayer(t.tg_id === ownerTgId() ? 'owner' : 'friend', { name: t.name, lang: prefs.lang });
  }
  if (ownerAgentGroupId() === group.id) return platformLayer('owner', { name: '' });
  return null;
}

const FRIEND_CLI_RESOURCES: ReadonlySet<string> = new Set(['tasks', 'me']);

/** v8 M9: a friend's agent may use the CLI for tasks and its own settings only. */
export async function friendCliResources(agentGroupId: string): Promise<ReadonlySet<string> | null> {
  const t = await getTenantByGroup(agentGroupId);
  return t && t.tg_id !== ownerTgId() ? FRIEND_CLI_RESOURCES : null;
}

/** Runner env for a tenant's container: the turn time limit (owner 30 min, friends 10 min). */
export function sessionEnvFor(group: { id: string }): Record<string, string> {
  return { NC_TURN_TIMEOUT_MS: String(nc.turnTimeoutMs(ownerAgentGroupId() === group.id)) };
}

export function installPlatformLayer(): void {
  setSessionEnvProvider(sessionEnvFor);
  setPlatformLayerProvider(platformFor);
  setGroupResourceFilter(friendCliResources);
  setSelfModVeto(async (groupId) =>
    (await friendCliResources(groupId)) ? 'This agent may not change its own tools or packages.' : null,
  );
  setAgentsCreateVeto(async (groupId) =>
    (await friendCliResources(groupId)) ? 'This agent may not create other agents.' : null,
  );
}
