/**
 * Tenant offboarding (v8 M14): pause / resume / delete, from the Mini App and
 * `/friends`. The owner tenant is never paused or deleted here.
 */
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { getDb, hasTable } from '../db/connection.js';
import { getAgentGroup } from '../db/agent-groups.js';
import { log } from '../log.js';
import { nanogateAdmin } from '../gateway-providers/nanogate/index.js';
import { sessionsBaseDir } from '../session-manager.js';
import { killGroupContainers } from './chat.js';
import { ownerTgId } from './config.js';
import { sessions } from './miniapp/sessions.js';
import { clearChatSurface, setChatSurface } from './surface.js';
import { tg } from './port.js';
import {
  audit,
  clearRetained,
  deletePrefs,
  gateIdOf,
  listJobs,
  patchJob,
  getTenantByTg,
  kvDelete,
  transitionTenant,
  updateTenant,
  upsertJob,
  type Tenant,
} from './store.js';
import { deleteUserKey } from './groq-key.js';
import { deleteConnectorsOfUser } from './mcp-connectors.js';
import { forgetGroupTenant, pushTenant } from './tenants.js';
import { pauseAllTasks, resumeAllTasks } from './tasks.js';
import { invalidateBudget } from './budget.js';

export const TRASH_DIR = (): string => path.resolve(process.env.NC_TRASH_DIR || path.join(process.cwd(), 'trash'));
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export class LifecycleError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
  }
}

async function friend(tgId: number): Promise<Tenant> {
  if (tgId === ownerTgId()) throw new LifecycleError('forbidden', 'owner tenant cannot be changed here');
  const t = await getTenantByTg(tgId);
  if (!t) throw new LifecycleError('not_found', 'no such friend');
  return t;
}

/** Pause / resume / delete of one tenant never interleave: a slow gateway call must not be overtaken by the opposite action. */
const locks = new Map<number, Promise<unknown>>();
function withTenantLock<T>(tgId: number, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(tgId) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(tgId, tail);
  void tail.then(() => {
    if (locks.get(tgId) === tail) locks.delete(tgId);
  });
  return run;
}

export const pauseFriend = (tgId: number, actor: string): Promise<void> =>
  withTenantLock(tgId, () => pauseFriendNow(tgId, actor));
export const resumeFriend = (tgId: number, actor: string): Promise<void> =>
  withTenantLock(tgId, () => resumeFriendNow(tgId, actor));
export const deleteFriend = (tgId: number, actor: string): Promise<void> =>
  withTenantLock(tgId, () => deleteFriendNow(tgId, actor));

async function pauseFriendNow(tgId: number, actor: string): Promise<void> {
  const t = await friend(tgId);
  if (!(await transitionTenant(tgId, ['ready'], 'paused'))) {
    throw new LifecycleError('conflict', `cannot pause from state ${t.state}`);
  }
  await suspend(t);
  await audit(actor, 'pause', t.user_id);
}

/** Stop everything a tenant can spend or run. Each step is best-effort and logged. */
async function suspend(t: Tenant, revoke = false): Promise<void> {
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.warn(`nc: suspend step failed: ${name}`, { tgId: t.tg_id, err });
    }
  };
  await step('nanogate-pause', () => nanogateAdmin.pauseTenant(gateIdOf(t)));
  // nanogate `revoke` is terminal (the tenant id can never be PUT or resumed again), so it
  // is reserved for delete. A paused tenant gets 403 tenant_paused on every call, and
  // stopping its containers ends its sessions, which revokes their tokens.
  if (revoke) await step('nanogate-revoke', () => nanogateAdmin.revokeTenant(gateIdOf(t)));
  await step('connector', () => nanogateAdmin.deleteConnector(gateIdOf(t)));
  if (t.agent_group_id) {
    const g = t.agent_group_id;
    await step('tasks', () => pauseAllTasks(g, t.tg_id));
    await step('containers', () => killGroupContainers(g, 'tenant-paused'));
  }
  sessions.revokeUser(t.tg_id);
  invalidateBudget(gateIdOf(t));
}

async function resumeFriendNow(tgId: number, actor: string): Promise<void> {
  const t = await friend(tgId);
  if (!(await transitionTenant(tgId, ['paused'], 'ready'))) {
    throw new LifecycleError('conflict', `cannot resume from state ${t.state}`);
  }
  const fresh = (await getTenantByTg(tgId))!;
  try {
    await pushTenant(fresh, 'active'); // upsert re-activates a revoked tenant
  } catch (err) {
    // Central state must not say «ready» while the gateway is still paused: put it back so the owner can retry.
    await transitionTenant(tgId, ['ready'], 'paused').catch(() => false);
    throw err;
  }
  await nanogateAdmin.resumeTenant(gateIdOf(t)).catch(() => undefined);
  if (t.agent_group_id) await resumeAllTasks(t.agent_group_id, t.tg_id).catch(() => 0);
  invalidateBudget(gateIdOf(t));
  await setChatSurface(tgId, false).catch((err) => log.warn('nc: chat surface after resume failed', { tgId, err }));
  await audit(actor, 'resume', t.user_id);
}

const CASCADE = [
  'DELETE FROM pending_questions WHERE session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
  'DELETE FROM pending_sender_approvals WHERE agent_group_id = ?',
  'DELETE FROM pending_channel_approvals WHERE agent_group_id = ?',
  'DELETE FROM sessions WHERE agent_group_id = ?',
  'DELETE FROM messaging_group_agents WHERE agent_group_id = ?',
  'DELETE FROM agent_group_members WHERE agent_group_id = ?',
  'DELETE FROM user_roles WHERE agent_group_id = ?',
  'DELETE FROM container_configs WHERE agent_group_id = ?',
];

/** FK-ordered cascade, mirroring `ncl groups delete` (that handler is not exported). */
async function deleteAgentGroupRows(agentGroupId: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    if (await hasTable(db, 'agent_destinations')) {
      await db.run('DELETE FROM agent_destinations WHERE agent_group_id = ?', agentGroupId);
      await db.run("DELETE FROM agent_destinations WHERE target_type = 'agent' AND target_id = ?", agentGroupId);
    }
    if (await hasTable(db, 'pending_approvals')) {
      await db.run(
        'DELETE FROM pending_approvals WHERE agent_group_id = ? OR session_id IN (SELECT id FROM sessions WHERE agent_group_id = ?)',
        agentGroupId,
        agentGroupId,
      );
    }
    for (const sql of CASCADE) await db.run(sql, agentGroupId);
    await db.run('DELETE FROM agent_groups WHERE id = ?', agentGroupId);
  });
}

function moveToTrash(src: string, label: string): string | null {
  if (!fs.existsSync(src)) return null;
  const dest = path.join(TRASH_DIR(), `${Date.now()}-${label}`);
  fs.mkdirSync(TRASH_DIR(), { recursive: true, mode: 0o700 });
  fs.renameSync(src, dest);
  return dest;
}

async function deleteFriendNow(tgId: number, actor: string): Promise<void> {
  const t = await friend(tgId);
  if (t.state === 'deleted') throw new LifecycleError('conflict', 'already deleted');
  await suspend(t, true);
  await updateTenant(tgId, { epoch: t.epoch + 1 });
  const step = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      log.warn(`nc: delete step failed: ${name}`, { tgId, err });
    }
  };
  // MCP connectors: the copies at nanogate (their secrets go with the tenant's below) and the host rows.
  await step('mcp-connectors', async () => {
    for (const id of await deleteConnectorsOfUser(t.user_id)) {
      await nanogateAdmin
        .deleteMcpConnector(id)
        .catch((err) => log.warn('nc: connector removal failed', { tgId, err }));
    }
  });
  await step('groq-key', async () => deleteUserKey(t.user_id));
  // Secrets and connector state at nanogate.
  await step('secrets', async () => {
    for (const s of await nanogateAdmin.listSecrets(gateIdOf(t))) await nanogateAdmin.deleteSecret(gateIdOf(t), s.name);
  });

  const trashed: string[] = [];
  if (t.agent_group_id) {
    const ag = await getAgentGroup(t.agent_group_id);
    const gid = t.agent_group_id;
    await step('rows', async () => {
      const { getMessagingGroupsByAgentGroup, deleteMessagingGroup } = await import('../db/messaging-groups.js');
      const mgs = await getMessagingGroupsByAgentGroup(gid);
      await deleteAgentGroupRows(gid);
      for (const mg of mgs) {
        await getDb().run('DELETE FROM user_dms WHERE messaging_group_id = ?', mg.id);
        await getDb()
          .run('DELETE FROM pending_sender_approvals WHERE messaging_group_id = ?', mg.id)
          .catch(() => undefined);
        await deleteMessagingGroup(mg.id).catch((err) => log.warn('nc: dm messaging group kept', { err }));
      }
    });
    await step('dirs', async () => {
      if (ag) {
        const g = moveToTrash(path.join(GROUPS_DIR, ag.folder), `group-${ag.folder}`);
        if (g) trashed.push(g);
      }
      const s = moveToTrash(path.join(sessionsBaseDir(), gid), `sessions-${gid}`);
      if (s) trashed.push(s);
    });
    forgetGroupTenant(gid);
  }
  for (const dir of trashed) {
    const job = await upsertJob('purge', dir);
    await patchJob(job.id, { step: new Date(Date.now() + TRASH_RETENTION_MS).toISOString() });
  }
  // A failed/stale provision job must not be resumed mid-way by the next approval (it would skip persona, config,
  // membership and DM wiring that this delete just removed).
  await step('jobs', async () => {
    for (const j of await listJobs(['pending', 'running', 'failed'])) {
      if (j.kind === 'provision' && j.tenant === String(tgId)) await patchJob(j.id, { status: 'done' });
    }
  });
  // Grants do not outlive the life they were given for: re-approval starts on direct egress.
  await step('grants', async () => {
    await kvDelete(`egress-ok:${tgId}`);
    await kvDelete(`sys-paused:${tgId}`);
  });
  await deletePrefs(t.user_id);
  await clearRetained(tgId);
  // A deleted user may ask again after the cooldown (or sooner if the owner reopens): their next life gets a new nanogate tenant id.
  await updateTenant(tgId, {
    state: 'deleted',
    agent_group_id: null,
    egress: 'direct',
    denied_until: new Date(Date.now() + TRASH_RETENTION_MS).toISOString(),
  });
  await step('surface', () => clearChatSurface(tgId));
  await audit(actor, 'delete', t.user_id, { trashed: trashed.length });
  await tg.sendProduct(tgId, 'Доступ закрыт.').catch(() => undefined);
}

/** Purge trash older than retention. Paths are re-validated to sit inside the trash dir. */
export async function purgeDueTrash(now = Date.now()): Promise<number> {
  let n = 0;
  const root = TRASH_DIR() + path.sep;
  for (const job of await listJobs(['pending'])) {
    if (job.kind !== 'purge') continue;
    if (Date.parse(job.step) > now) continue;
    const target = path.resolve(job.tenant);
    if (!target.startsWith(root)) {
      await patchJob(job.id, { status: 'failed', last_error: 'path outside trash' });
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
    await patchJob(job.id, { status: 'done' });
    n++;
  }
  return n;
}

/**
 * The Home Assistant token feature is gone: remove any leftover `ha_token` in each group's `.secrets`, and the
 * `.secrets` dir when that leaves it empty. lstat/unlink/rmdir only, so a symlink planted in an
 * agent-writable folder is never followed.
 */
export function removeLegacyHaTokens(): void {
  let groups: fs.Dirent[];
  try {
    groups = fs.readdirSync(GROUPS_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const g of groups) {
    if (!g.isDirectory()) continue; // Dirent from readdir does not follow symlinks
    const dir = path.join(GROUPS_DIR, g.name, '.secrets');
    try {
      if (!fs.lstatSync(dir).isDirectory()) continue;
      const file = path.join(dir, 'ha_token');
      try {
        fs.lstatSync(file);
        fs.unlinkSync(file);
        log.info('nc: removed legacy Home Assistant token', { group: g.name });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        log.info('nc: removed empty .secrets dir', { group: g.name });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
        log.warn('nc: legacy ha_token cleanup failed', { group: g.name, err });
    }
  }
}
