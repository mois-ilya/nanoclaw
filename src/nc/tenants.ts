/**
 * Tenant plumbing shared by the gate, provisioning, lifecycle and the Mini App:
 *  - the sync agent-group -> nanogate tenant resolver (nanogate's `registerTenantResolver` is sync);
 *  - nanogate tenant upsert/policy;
 *  - owner bootstrap and the DM wiring helper.
 */
import {
  createDestination,
  getDestinationByName,
  getDestinationByTarget,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import {
  getContainerConfig,
  updateContainerConfigJson,
  updateContainerConfigScalars,
} from '../db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { initGroupFilesystem } from '../group-init.js';
import { log } from '../log.js';
import {
  nanogateAdmin,
  registerTenantProvisioner,
  registerTenantResolver,
  type NanogateAdmin,
  type ResolvedTenant,
  type TenantPolicy,
  type TenantUpsert,
} from '../gateway-providers/nanogate/index.js';
import { grantRole, isOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { AgentGroup, MessagingGroup } from '../types.js';
import { ownerPersona } from './templates.js';
import { nc, ownerTgId, platformIdOf, presetConfig, tgIdOfUserId, userIdOf } from './config.js';
import {
  gateIdOf,
  getTenantByTg,
  insertTenantIfAbsent,
  kvGet,
  listTenants,
  updateTenant,
  type Egress,
  type Tenant,
} from './store.js';

// ---------- resolver ----------

const byGroup = new Map<string, ResolvedTenant>();

export function rememberGroupTenant(agentGroupId: string, tgId: number, kind: 'owner' | 'friend', epoch = 1): void {
  byGroup.set(agentGroupId, { tenantId: gateIdOf({ user_id: userIdOf(tgId), epoch }), kind });
}

export function forgetGroupTenant(agentGroupId: string): void {
  byGroup.delete(agentGroupId);
}

/**
 * Unknown groups resolve to a friend tenant named after the group itself:
 * nanogate has no such tenant, so the session fails closed (tenant_not_found).
 */
export function resolveTenant(agentGroupId: string): ResolvedTenant {
  return byGroup.get(agentGroupId) ?? { tenantId: agentGroupId, kind: 'friend' };
}

export async function loadTenantMap(): Promise<void> {
  byGroup.clear();
  const owner = ownerTgId();
  for (const t of await listTenants()) {
    if (!t.agent_group_id) continue;
    if (t.state === 'deleted' || t.state === 'denied' || t.state === 'pending') continue;
    byGroup.set(t.agent_group_id, { tenantId: gateIdOf(t), kind: t.tg_id === owner ? 'owner' : 'friend' });
  }
}

// ---------- nanogate tenant ----------

export function nanogatePolicy(kind: 'owner' | 'friend', egress: Egress): TenantPolicy {
  const m = nc.models();
  // The guest model is called with the owner's token (guest.ts), so it must be allowed for the owner.
  const models = [...new Set([m.fast, m.normal, m.deep, m.small, ...(kind === 'owner' ? [m.guest] : [])])];
  const owner = ownerTgId();
  const allow = nc.ownerTailnetAllow();
  return {
    models,
    maxTokens: 32000,
    allowServiceTiers: ['standard'],
    serverTools: kind === 'owner' ? ['web_search', 'web_fetch'] : ['web_search'],
    egress: {
      route: egress === 'residential' ? 'connector' : 'direct',
      fallbackDirect: false,
      ports: [443, 80],
      tailnet: false,
      // Friends reach the internet through the OWNER's home connector (plan v8 M5/A4); tailnet stays off for them.
      ...(kind === 'friend' && egress === 'residential' && owner !== null ? { connectorTenant: userIdOf(owner) } : {}),
      // Home automation: an explicit owner allowlist, never "any tailnet address" (plan v8 M6).
      ...(kind === 'owner' ? { tailnet: allow.length > 0, tailnetAllow: allow } : {}),
    },
    maxConcurrentRequests: kind === 'owner' ? 4 : 2,
  };
}

export function nanogateBody(t: Tenant, status: 'active' | 'paused' = 'active'): TenantUpsert {
  const isOwnerTenant = t.tg_id === ownerTgId();
  return {
    kind: isOwnerTenant ? 'owner' : 'friend',
    status,
    policy: nanogatePolicy(isOwnerTenant ? 'owner' : 'friend', t.egress),
    // Owner has no wall of their own: the global installation cap applies (plan §13.5).
    budgetLimitMicros: isOwnerTenant ? null : t.limit_usd_micros,
    periodTz: nc.defaultTz(),
  };
}

export async function pushTenant(t: Tenant, status: 'active' | 'paused' = 'active'): Promise<void> {
  // A friend routed «через дом» references the owner's connector tenant, which nanogate must already know.
  const owner = ownerTgId();
  if (t.egress === 'residential' && owner !== null && t.tg_id !== owner) {
    const o = await getTenantByTg(owner);
    if (o)
      await nanogateAdmin
        .putTenant(gateIdOf(o), nanogateBody(o, 'active'))
        .catch((err) => log.warn('nc: owner tenant pre-push failed', { err }));
  }
  await nanogateAdmin.putTenant(gateIdOf(t), nanogateBody(t, status));
}

/** Self-heal: nanogate answered tenant_not_found for a group we know. */
async function provisionFromStore(tenant: ResolvedTenant, _admin: NanogateAdmin): Promise<void> {
  const t = await getTenantByTg(tgIdOfUserId(tenant.tenantId) ?? -1);
  if (!t || (t.state !== 'ready' && t.state !== 'provisioning')) throw new Error('unknown or inactive tenant');
  await pushTenant(t);
}

// ---------- wiring ----------

/**
 * The agent addresses the user's chat by this name (`<message to="dm">`, task prompts). A name derived from
 * the display name collapses to `unnamed` for Cyrillic, so the DM gets a stable ASCII one.
 */
export const DM_DESTINATION = 'dm';

async function ensureDmDestination(agentGroupId: string, messagingGroupId: string, now: string): Promise<void> {
  try {
    if (await getDestinationByTarget(agentGroupId, 'channel', messagingGroupId)) return;
    if (await getDestinationByName(agentGroupId, DM_DESTINATION)) return; // taken: the generic naming handles it
    await createDestination({
      agent_group_id: agentGroupId,
      local_name: DM_DESTINATION,
      target_type: 'channel',
      target_id: messagingGroupId,
      created_at: now,
    });
  } catch (err) {
    // Without the agent-to-agent module there is no destination table; naming falls back to the default.
    log.debug('nc: dm destination not pre-created', { err });
  }
}

export async function ensureDmWiring(
  tgId: number,
  displayName: string,
  agentGroup: AgentGroup,
): Promise<MessagingGroup> {
  const now = new Date().toISOString();
  const platformId = platformIdOf(tgId);
  let mg = await getMessagingGroupByPlatform('telegram', platformId);
  if (!mg) {
    mg = {
      id: `mg-${randomUUID()}`,
      channel_type: 'telegram',
      platform_id: platformId,
      name: displayName,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    };
    await createMessagingGroup(mg);
    mg = (await getMessagingGroupByPlatform('telegram', platformId)) ?? mg;
  }
  const existing = await getMessagingGroupAgentByPair(mg.id, agentGroup.id);
  if (!existing) {
    await ensureDmDestination(agentGroup.id, mg.id, now);
    await createMessagingGroupAgent({
      id: `mga-${randomUUID()}`,
      messaging_group_id: mg.id,
      agent_group_id: agentGroup.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  }
  return mg;
}

function skillsExcept(excluded: string[]): string[] {
  try {
    return fs
      .readdirSync(path.join(process.cwd(), 'container', 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && !excluded.includes(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return ['agent-browser', 'welcome', 'frontend-engineer'];
  }
}

// ---------- owner bootstrap ----------

let ownerGroupId: string | null = null;
export function ownerAgentGroupId(): string | null {
  return ownerGroupId;
}

/** Idempotent. Runs in onHostStart; nanogate being down is retried by the caller. */
export async function bootstrapOwner(): Promise<{ nanogateOk: boolean }> {
  const tgId = ownerTgId();
  if (tgId === null) {
    log.warn('nc: NANOCLAW_OWNER_TELEGRAM_ID is not set; owner bootstrap skipped');
    return { nanogateOk: true };
  }
  const now = new Date().toISOString();
  const userId = userIdOf(tgId);
  await upsertUser({ id: userId, kind: 'telegram', display_name: nc.ownerName(), created_at: now });
  if (!(await isOwner(userId))) {
    await grantRole({ user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
  }

  let ag = await getAgentGroupByFolder('owner');
  let created = false;
  if (!ag) {
    ag = { id: `ag-${randomUUID()}`, name: 'owner', folder: 'owner', agent_provider: null, created_at: now };
    await createAgentGroup(ag);
    created = true;
  }
  await initGroupFilesystem(ag, { instructions: ownerPersona({ tz: nc.defaultTz() }) });
  if (created || !(await getContainerConfig(ag.id))) {
    const deep = presetConfig('deep');
    await updateContainerConfigScalars(ag.id, {
      cli_scope: 'global',
      model: deep.model,
      effort: deep.effort,
      timezone: nc.defaultTz(),
      assistant_name: nc.botName(),
    });
    await updateContainerConfigJson(ag.id, 'skills', skillsExcept(['self-customize']));
  }
  ownerGroupId = ag.id;

  await ensureDmWiring(tgId, nc.ownerName(), ag);

  const createdTenant = await insertTenantIfAbsent({ tgId, name: nc.ownerName(), state: 'ready' });
  await updateTenant(tgId, { state: 'ready', agent_group_id: ag.id, limit_usd_micros: null });
  // Owner egress defaults to the home connector when one is configured (plan §3), on every boot until the owner
  // picks a route themselves: enabling the connector after the tenant already exists must not leave them on the Hetzner IP.
  if (nc.ownerConnectorSocks() && (createdTenant || (await kvGet('egress-chosen:owner')) !== '1')) {
    await updateTenant(tgId, { egress: 'residential' });
  }
  rememberGroupTenant(ag.id, tgId, 'owner');

  const t = await getTenantByTg(tgId);
  let nanogateOk = true;
  if (t) {
    try {
      await pushTenant(t);
    } catch (err) {
      nanogateOk = false;
      log.warn('nc: owner tenant not pushed to nanogate yet', { err });
    }
  }
  return { nanogateOk };
}

export function installResolver(): void {
  registerTenantResolver(resolveTenant);
  registerTenantProvisioner(provisionFromStore);
}
