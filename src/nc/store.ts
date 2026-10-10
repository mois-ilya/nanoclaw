/** Repository over the `nc_*` tables. Plain SQL via the central DbDriver. */
import { randomUUID } from 'node:crypto';

import { getDb } from '../db/connection.js';
import { userIdOf } from './config.js';

export type TenantState =
  | 'pending'
  | 'provisioning'
  | 'provisioning_failed'
  | 'ready'
  | 'paused'
  | 'denied'
  | 'deleted';

/**
 * The tenant id nanogate knows this user by. nanogate `revoke` is terminal, so a deleted friend who is let in
 * again gets a fresh id: `telegram:<id>` for the first life, `telegram:<id>.e<epoch>` afterwards.
 */
export const gateIdOf = (t: { user_id: string; epoch: number }): string =>
  t.epoch > 1 ? `${t.user_id}.e${t.epoch}` : t.user_id;

export type Egress = 'direct' | 'residential';

export interface Tenant {
  user_id: string;
  tg_id: number;
  name: string;
  username: string | null;
  state: TenantState;
  agent_group_id: string | null;
  epoch: number;
  limit_usd_micros: number | null;
  egress: Egress;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
  denied_until: string | null;
}

export interface RequestRow {
  id: string;
  tg_id: number;
  first_message: string;
  card_message_id: number | null;
  status: 'pending' | 'approved' | 'denied';
  created_at: string;
}

const now = (): string => new Date().toISOString();

// ---------- tenants ----------

export async function getTenantByTg(tgId: number): Promise<Tenant | undefined> {
  return getDb().get<Tenant>('SELECT * FROM nc_tenants WHERE tg_id = ?', tgId);
}

export async function getTenantByGroup(agentGroupId: string): Promise<Tenant | undefined> {
  return getDb().get<Tenant>('SELECT * FROM nc_tenants WHERE agent_group_id = ?', agentGroupId);
}

export async function listTenants(): Promise<Tenant[]> {
  return getDb().all<Tenant>('SELECT * FROM nc_tenants ORDER BY created_at');
}

export async function insertTenantIfAbsent(t: {
  tgId: number;
  name: string;
  username?: string | null;
  state: TenantState;
}): Promise<boolean> {
  const at = now();
  const r = await getDb().run(
    `INSERT OR IGNORE INTO nc_tenants (user_id, tg_id, name, username, state, epoch, egress, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'direct', ?, ?)`,
    userIdOf(t.tgId),
    t.tgId,
    t.name,
    t.username ?? null,
    t.state,
    at,
    at,
  );
  return r.changes > 0;
}

type TenantPatch = Partial<
  Pick<
    Tenant,
    | 'name'
    | 'username'
    | 'state'
    | 'agent_group_id'
    | 'epoch'
    | 'limit_usd_micros'
    | 'egress'
    | 'decided_at'
    | 'denied_until'
  >
>;

const PATCHABLE = new Set([
  'name',
  'username',
  'state',
  'agent_group_id',
  'epoch',
  'limit_usd_micros',
  'egress',
  'decided_at',
  'denied_until',
]);

export async function updateTenant(tgId: number, patch: TenantPatch): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!PATCHABLE.has(k) || v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  vals.push(now(), tgId);
  await getDb().run(`UPDATE nc_tenants SET ${sets.join(', ')} WHERE tg_id = ?`, ...vals);
}

/** Compare-and-set a state transition; false if the row was not in `from`. */
export async function transitionTenant(
  tgId: number,
  from: TenantState[],
  to: TenantState,
  patch: TenantPatch = {},
): Promise<boolean> {
  const placeholders = from.map(() => '?').join(',');
  const r = await getDb().run(
    `UPDATE nc_tenants SET state = ?, updated_at = ? WHERE tg_id = ? AND state IN (${placeholders})`,
    to,
    now(),
    tgId,
    ...from,
  );
  if (r.changes === 0) return false;
  await updateTenant(tgId, patch);
  return true;
}

// ---------- requests ----------

export async function createRequest(tgId: number, firstMessage: string): Promise<RequestRow> {
  const row: RequestRow = {
    id: randomUUID().replace(/-/g, '').slice(0, 10),
    tg_id: tgId,
    first_message: firstMessage.slice(0, 500),
    card_message_id: null,
    status: 'pending',
    created_at: now(),
  };
  await getDb().run(
    'INSERT INTO nc_requests (id, tg_id, first_message, card_message_id, status, created_at) VALUES (?,?,?,?,?,?)',
    row.id,
    row.tg_id,
    row.first_message,
    null,
    row.status,
    row.created_at,
  );
  return row;
}

export async function getRequest(id: string): Promise<RequestRow | undefined> {
  return getDb().get<RequestRow>('SELECT * FROM nc_requests WHERE id = ?', id);
}

export async function listPendingRequests(): Promise<RequestRow[]> {
  return getDb().all<RequestRow>("SELECT * FROM nc_requests WHERE status = 'pending' ORDER BY created_at");
}

export async function setRequestCard(id: string, messageId: number): Promise<void> {
  await getDb().run('UPDATE nc_requests SET card_message_id = ? WHERE id = ?', messageId, id);
}

/** Atomically claim a pending request; false if someone else (double tap) already decided it. */
export async function decideRequest(id: string, status: 'approved' | 'denied'): Promise<boolean> {
  const r = await getDb().run("UPDATE nc_requests SET status = ? WHERE id = ? AND status = 'pending'", status, id);
  return r.changes > 0;
}

// ---------- retained first messages (<= 5 per user) ----------

export const RETAIN_MAX = 5;

export async function retain(tgId: number, updateJson: string): Promise<void> {
  const db = getDb();
  const last = await db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM nc_retained WHERE tg_id = ?', tgId);
  const seq = (last?.m ?? 0) + 1;
  await db.run('INSERT INTO nc_retained (tg_id, seq, update_json) VALUES (?,?,?)', tgId, seq, updateJson);
  await db.run('DELETE FROM nc_retained WHERE tg_id = ? AND seq <= ?', tgId, seq - RETAIN_MAX);
}

export async function takeRetained(tgId: number): Promise<string[]> {
  const db = getDb();
  const rows = await db.all<{ seq: number; update_json: string }>(
    'SELECT seq, update_json FROM nc_retained WHERE tg_id = ? ORDER BY seq',
    tgId,
  );
  return rows.map((r) => r.update_json);
}

export async function clearRetainedOne(tgId: number, updateJson: string): Promise<boolean> {
  const r = await getDb().run(
    'DELETE FROM nc_retained WHERE tg_id = ? AND seq = (SELECT MIN(seq) FROM nc_retained WHERE tg_id = ? AND update_json = ?)',
    tgId,
    tgId,
    updateJson,
  );
  return r.changes > 0;
}

export async function clearRetained(tgId: number): Promise<void> {
  await getDb().run('DELETE FROM nc_retained WHERE tg_id = ?', tgId);
}

// ---------- notices (rate-limited user-facing replies) ----------

/** True if `kind` was not shown to `tgId` within `windowMs`; records the show. */
export async function noticeDue(tgId: number, kind: string, windowMs: number): Promise<boolean> {
  const db = getDb();
  const row = await db.get<{ at: string }>('SELECT at FROM nc_notices WHERE tg_id = ? AND kind = ?', tgId, kind);
  if (row && Date.now() - Date.parse(row.at) < windowMs) return false;
  await db.run(
    `INSERT INTO nc_notices (tg_id, kind, at) VALUES (?,?,?)
     ON CONFLICT(tg_id, kind) DO UPDATE SET at = excluded.at`,
    tgId,
    kind,
    now(),
  );
  return true;
}

// ---------- prefs ----------

export interface Prefs {
  lang: 'ru' | 'en';
  tz: string;
  preset: 'fast' | 'normal' | 'deep';
  quiet_from: string | null;
  quiet_to: string | null;
  show_steps: boolean;
}

export async function getPrefs(userId: string, defaults: { tz: string; preset?: Prefs['preset'] }): Promise<Prefs> {
  const row = await getDb().get<{
    lang: string;
    tz: string;
    preset: string;
    quiet_from: string | null;
    quiet_to: string | null;
    show_steps: number;
  }>('SELECT * FROM nc_prefs WHERE user_id = ?', userId);
  if (!row) {
    return {
      lang: 'ru',
      tz: defaults.tz,
      preset: defaults.preset ?? 'normal',
      quiet_from: null,
      quiet_to: null,
      show_steps: true,
    };
  }
  return {
    lang: row.lang === 'en' ? 'en' : 'ru',
    tz: row.tz,
    preset: row.preset === 'fast' || row.preset === 'deep' ? row.preset : 'normal',
    quiet_from: row.quiet_from,
    quiet_to: row.quiet_to,
    show_steps: row.show_steps !== 0,
  };
}

export async function putPrefs(userId: string, p: Prefs): Promise<void> {
  await getDb().run(
    `INSERT INTO nc_prefs (user_id, lang, tz, preset, quiet_from, quiet_to, show_steps)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET lang=excluded.lang, tz=excluded.tz, preset=excluded.preset,
       quiet_from=excluded.quiet_from, quiet_to=excluded.quiet_to, show_steps=excluded.show_steps`,
    userId,
    p.lang,
    p.tz,
    p.preset,
    p.quiet_from,
    p.quiet_to,
    p.show_steps ? 1 : 0,
  );
}

export async function deletePrefs(userId: string): Promise<void> {
  await getDb().run('DELETE FROM nc_prefs WHERE user_id = ?', userId);
}

// ---------- audit ----------

export async function audit(actor: string, action: string, target?: string, detail?: unknown): Promise<void> {
  await getDb().run(
    'INSERT INTO nc_audit (id, at, actor, action, target, detail) VALUES (?,?,?,?,?,?)',
    randomUUID(),
    now(),
    actor,
    action,
    target ?? null,
    detail === undefined ? null : JSON.stringify(detail).slice(0, 2000),
  );
}

// ---------- jobs ----------

export interface Job {
  id: string;
  kind: string;
  tenant: string;
  step: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export async function upsertJob(kind: string, tenant: string): Promise<Job> {
  const db = getDb();
  const existing = await db.get<Job>(
    "SELECT * FROM nc_jobs WHERE kind = ? AND tenant = ? AND status IN ('pending','running','failed') ORDER BY updated_at DESC LIMIT 1",
    kind,
    tenant,
  );
  if (existing) return existing;
  const job: Job = {
    id: randomUUID(),
    kind,
    tenant,
    step: 'start',
    status: 'pending',
    attempts: 0,
    last_error: null,
    updated_at: now(),
  };
  await db.run(
    'INSERT INTO nc_jobs (id, kind, tenant, step, status, attempts, last_error, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    job.id,
    job.kind,
    job.tenant,
    job.step,
    job.status,
    0,
    null,
    job.updated_at,
  );
  return job;
}

export async function patchJob(
  id: string,
  p: Partial<Pick<Job, 'step' | 'status' | 'attempts' | 'last_error'>>,
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  sets.push('updated_at = ?');
  vals.push(now(), id);
  await getDb().run(`UPDATE nc_jobs SET ${sets.join(', ')} WHERE id = ?`, ...vals);
}

export async function listJobs(statuses: Job['status'][]): Promise<Job[]> {
  const ph = statuses.map(() => '?').join(',');
  return getDb().all<Job>(`SELECT * FROM nc_jobs WHERE status IN (${ph}) ORDER BY updated_at`, ...statuses);
}

// ---------- kv ----------

export async function kvGet(key: string): Promise<string | undefined> {
  return (await getDb().get<{ value: string }>('SELECT value FROM nc_kv WHERE key = ?', key))?.value;
}

export async function kvSet(key: string, value: string): Promise<void> {
  await getDb().run(
    'INSERT INTO nc_kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export async function kvDelete(key: string): Promise<void> {
  await getDb().run('DELETE FROM nc_kv WHERE key = ?', key);
}

// ---------- voice usage ----------

export async function recordVoice(userId: string, seconds: number): Promise<void> {
  await getDb().run(
    'INSERT INTO nc_usage_voice (id, user_id, at, seconds) VALUES (?,?,?,?)',
    randomUUID(),
    userId,
    now(),
    Math.round(seconds),
  );
}
