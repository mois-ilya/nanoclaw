/** Registers the host-owned platform layer (L0) with the project-document composer. */
import {
  setConfigChangedListener,
  setDisabledToolsProvider,
  setManagedMcpServersProvider,
} from '../container-config.js';
import { setGroupResourceFilter } from '../cli/guard.js';
import { setSelfModVeto } from '../modules/self-mod/guard.js';
import { setAgentsCreateVeto } from '../modules/agent-to-agent/guard.js';
import { setModuleDocExcluder, setPlatformLayerProvider } from '../project-doc-compose.js';
import { setSessionEnvProvider } from '../session-env.js';
import type { AgentGroup } from '../types.js';
import { markGroupConfigDirty } from './config-apply.js';
import { nc, ownerTgId } from './config.js';
import { managedServersFor } from './mcp-connectors.js';
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

/** Friends never see the self-mod / create_agent tools (the vetoes below stay as defense in depth). */
export const FRIEND_DISABLED_TOOLS: readonly string[] = ['add_mcp_server', 'create_agent'];

/** Module docs a friend must not receive: they describe tools and CLI the friend cannot use. */
const FRIEND_EXCLUDED_DOCS: ReadonlySet<string> = new Set(['agents', 'self-mod', 'cli']);

export async function moduleDocsExcludedFor(group: AgentGroup): Promise<ReadonlySet<string>> {
  return (await friendCliResources(group.id)) ? FRIEND_EXCLUDED_DOCS : new Set();
}

export async function disabledToolsFor(agentGroupId: string): Promise<readonly string[]> {
  return (await friendCliResources(agentGroupId)) ? FRIEND_DISABLED_TOOLS : [];
}

export function installPlatformLayer(): void {
  setDisabledToolsProvider(disabledToolsFor);
  setManagedMcpServersProvider(managedServersFor);
  setConfigChangedListener(markGroupConfigDirty);
  setSessionEnvProvider(sessionEnvFor);
  setPlatformLayerProvider(platformFor);
  setModuleDocExcluder(moduleDocsExcludedFor);
  setGroupResourceFilter(friendCliResources);
  setSelfModVeto(async (groupId) =>
    (await friendCliResources(groupId)) ? 'This agent may not change its own tools or packages.' : null,
  );
  setAgentsCreateVeto(async (groupId) =>
    (await friendCliResources(groupId)) ? 'This agent may not create other agents.' : null,
  );
}
