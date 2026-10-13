/**
 * MCP connectors (Stage 1): the host owns the records (`nc_mcp_connectors`), nanogate holds a copy and the keys.
 *
 * - A key is written only to nanogate (`secrets`, name `mcp.<id>`) and never read back or stored here; the row
 *   keeps just `key_saved_at` / `key_status`. A new key is verified against the upstream BEFORE it replaces the old one.
 * - The copy at nanogate is a full replace: `syncAllConnectors` pushes every row and removes what the host does not
 *   know (with its secret). It runs at start and every 5 minutes.
 * - `managedServersFor` is the container.json provider: an entry exists only while the connector is enabled and has
 *   a key. It carries no headers; the runner adds the session token in memory.
 * - Every change that alters the tool set of a running agent calls `markGroupConfigDirty`.
 */
import { createHash, randomBytes } from 'node:crypto';

import { getDb } from '../db/connection.js';
import { INSTALL_SLUG } from '../config.js';
import type { McpHttpServerConfig } from '../container-config.js';
import { log } from '../log.js';
import {
  MCP_GATEWAY_PORT,
  RELAY_ENDPOINT,
  nanogateAdmin,
  type McpConnectorState,
} from '../gateway-providers/nanogate/index.js';
import type { Connector, ConnectorCall, ConnectorTool } from './miniapp/types.js';
import { markGroupConfigDirty, groupApplying } from './config-apply.js';
import { tgIdOfUserId } from './config.js';
import { catalogEntry, type CatalogEntry } from './mcp-catalog.js';
import { audit, gateIdOf, getTenantByGroup, getTenantByTg, type Tenant } from './store.js';

export type ToolPolicy = Record<string, 'ask' | 'auto'>;
export type KeyStatus = 'ok' | 'rejected' | 'unverified';

export interface McpConnectorRow {
  id: string;
  user_id: string;
  catalog_id: string;
  url: string;
  secret_name: string;
  read_only: number;
  tool_policy: string;
  enabled: number;
  key_saved_at: string | null;
  key_status: KeyStatus | null;
  rev: number;
  created_at: string;
  updated_at: string;
}

export type ConnectorErrorCode = 'invalid' | 'not_found' | 'conflict' | 'key_rejected';
export class ConnectorError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Per-server tool-call timeout written to container.json: longer than the 300 s hold for a confirmation card. */
export const MCP_SERVER_TIMEOUT_MS = 420_000;
const SYNC_EVERY_MS = 5 * 60_000;
/**
 * Several installs may share one nanogate (prod + test). Every connector id carries this install's tag, and the sync
 * removes only ids with it: the other install's connectors and their keys are none of our business.
 */
const INSTALL_TAG = createHash('sha1').update(INSTALL_SLUG).digest('hex').slice(0, 4);
const OWN_ID_RE = new RegExp(`-${INSTALL_TAG}[0-9a-f]{8}$`);
const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_POLICY_ENTRIES = 200;

const now = (): string => new Date().toISOString();
const gatewayUrl = (id: string): string => `http://${RELAY_ENDPOINT}:${MCP_GATEWAY_PORT}/mcp/${id}`;

/** Connector ids whose last push to nanogate failed; cleared by the next successful push. */
const syncErrors = new Set<string>();

// ---------- table ----------

export async function listConnectors(userId: string): Promise<McpConnectorRow[]> {
  return getDb().all<McpConnectorRow>('SELECT * FROM nc_mcp_connectors WHERE user_id = ? ORDER BY created_at', userId);
}

export async function listAllConnectors(): Promise<McpConnectorRow[]> {
  return getDb().all<McpConnectorRow>('SELECT * FROM nc_mcp_connectors ORDER BY created_at');
}

export async function getConnector(id: string): Promise<McpConnectorRow | undefined> {
  return getDb().get<McpConnectorRow>('SELECT * FROM nc_mcp_connectors WHERE id = ?', id);
}

/** A new connector: disabled, no key. One per (user, catalog entry). */
export async function createConnector(userId: string, catalogId: string): Promise<McpConnectorRow> {
  const entry = catalogEntry(catalogId);
  if (!entry) throw new ConnectorError('invalid', 'Такого коннектора нет в каталоге');
  const db = getDb();
  if (await db.get('SELECT 1 AS x FROM nc_mcp_connectors WHERE user_id = ? AND catalog_id = ?', userId, catalogId)) {
    throw new ConnectorError('conflict', 'Этот коннектор уже добавлен');
  }
  const id = `${catalogId}-${INSTALL_TAG}${randomBytes(4).toString('hex')}`;
  const at = now();
  await db.run(
    `INSERT INTO nc_mcp_connectors (id, user_id, catalog_id, url, secret_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    catalogId,
    entry.url,
    `mcp.${id}`,
    at,
    at,
  );
  return (await getConnector(id))!;
}

type RowPatch = Partial<
  Pick<McpConnectorRow, 'read_only' | 'tool_policy' | 'enabled' | 'key_saved_at' | 'key_status'> & { bumpRev: boolean }
>;

async function patchRow(id: string, patch: RowPatch): Promise<McpConnectorRow> {
  const sets: string[] = ['updated_at = ?'];
  const vals: unknown[] = [now()];
  for (const k of ['read_only', 'tool_policy', 'enabled', 'key_saved_at', 'key_status'] as const) {
    if (patch[k] === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(patch[k]);
  }
  if (patch.bumpRev) sets.push('rev = rev + 1');
  await getDb().run(`UPDATE nc_mcp_connectors SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
  const row = await getConnector(id);
  if (!row) throw new ConnectorError('not_found', 'Коннектор не найден');
  return row;
}

export async function deleteConnectorRow(id: string): Promise<void> {
  await getDb().run('DELETE FROM nc_mcp_connectors WHERE id = ?', id);
  syncErrors.delete(id);
}

/** All rows of a user go with the tenant (lifecycle delete). */
export async function deleteConnectorsOfUser(userId: string): Promise<string[]> {
  const rows = await listConnectors(userId);
  await getDb().run('DELETE FROM nc_mcp_connectors WHERE user_id = ?', userId);
  for (const r of rows) syncErrors.delete(r.id);
  return rows.map((r) => r.id);
}

// ---------- policy / headers ----------

export function parsePolicy(raw: string): ToolPolicy {
  try {
    const j = JSON.parse(raw) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
    const out: ToolPolicy = {};
    for (const [k, v] of Object.entries(j)) if (v === 'ask' || v === 'auto') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

function extraHeadersOf(row: McpConnectorRow): Record<string, string> {
  const entry = catalogEntry(row.catalog_id);
  return row.read_only && entry ? { [entry.readOnlyHeader]: 'true' } : {};
}

// ---------- push / sync ----------

async function tenantOf(row: McpConnectorRow): Promise<Tenant | undefined> {
  const tg = tgIdOfUserId(row.user_id);
  return tg === null ? undefined : getTenantByTg(tg);
}

/** Pushes of one connector run one after another, each reading the row as it is when its turn comes. */
const pushChains = new Map<string, Promise<unknown>>();

/** Copy one row to nanogate. Records the failure for the Mini App instead of throwing when `quiet`. */
export function pushConnector(row: McpConnectorRow, quiet = false): Promise<boolean> {
  const prev = pushChains.get(row.id) ?? Promise.resolve();
  const run = prev.then(() => pushNow(row.id, quiet));
  const tail = run.catch(() => undefined);
  pushChains.set(row.id, tail);
  void tail.then(() => {
    if (pushChains.get(row.id) === tail) pushChains.delete(row.id);
  });
  return run;
}

async function pushNow(id: string, quiet: boolean): Promise<boolean> {
  try {
    // The latest state, not the snapshot the caller held: an older one must never land after a newer one.
    const row = await getConnector(id);
    if (!row) return true; // deleted meanwhile
    const t = await tenantOf(row);
    if (!t) throw new Error('tenant not found');
    const entry = catalogEntry(row.catalog_id);
    await nanogateAdmin.putMcpConnector(row.id, {
      tenantId: gateIdOf(t),
      title: entry?.title ?? row.catalog_id,
      url: row.url,
      secretName: row.secret_name,
      extraHeaders: extraHeadersOf(row),
      toolPolicy: parsePolicy(row.tool_policy),
      enabled: row.enabled === 1,
    });
    syncErrors.delete(row.id);
    return true;
  } catch (err) {
    syncErrors.add(id);
    log.warn('nc: connector push failed', { id, err: err instanceof Error ? err.message : String(err) });
    if (!quiet) throw err;
    return false;
  }
}

/**
 * Full replace of this install's connector inventory at nanogate: every host row is pushed, and every connector of
 * this install that the host does not know is deleted (nanogate drops its secret with it). A failure stays for the
 * next pass.
 */
export async function syncAllConnectors(): Promise<{ pushed: number; removed: number; failed: number }> {
  let pushed = 0;
  let removed = 0;
  let failed = 0;
  const rows = await listAllConnectors();
  const known = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    const t = await tenantOf(row);
    if (!t || (t.state !== 'ready' && t.state !== 'paused')) continue;
    if (await pushConnector(row, true)) pushed++;
    else failed++;
  }
  let remote: McpConnectorState[] = [];
  try {
    remote = await nanogateAdmin.listMcpConnectors();
  } catch (err) {
    log.warn('nc: connector inventory read failed', { err: err instanceof Error ? err.message : String(err) });
    return { pushed, removed, failed: failed + 1 };
  }
  for (const r of remote) {
    if (known.has(r.id) || !OWN_ID_RE.test(r.id)) continue;
    try {
      await nanogateAdmin.deleteMcpConnector(r.id);
      removed++;
    } catch (err) {
      failed++;
      log.warn('nc: stale connector removal failed', {
        id: r.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { pushed, removed, failed };
}

let syncTimer: NodeJS.Timeout | undefined;

export function startConnectorSync(): void {
  if (syncTimer) return;
  const run = (): void => {
    void syncAllConnectors().catch((err) => log.warn('nc: connector sync failed', { err }));
  };
  run();
  syncTimer = setInterval(run, SYNC_EVERY_MS);
  syncTimer.unref();
}

export function stopConnectorSync(): void {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = undefined;
}

// ---------- container.json ----------

/** The `container.json` provider: enabled connectors with a key, keyed by the catalog's server name. */
export async function managedServersFor(agentGroupId: string): Promise<Record<string, McpHttpServerConfig>> {
  const t = await getTenantByGroup(agentGroupId);
  if (!t) return {};
  const out: Record<string, McpHttpServerConfig> = {};
  for (const row of await listConnectors(t.user_id)) {
    if (!row.enabled || !row.key_saved_at) continue;
    const entry = catalogEntry(row.catalog_id);
    if (!entry) continue;
    out[entry.serverName] = { type: 'http', url: gatewayUrl(row.id), timeout: MCP_SERVER_TIMEOUT_MS };
  }
  return out;
}

async function changed(t: Tenant, reason: string): Promise<void> {
  if (t.agent_group_id) await markGroupConfigDirty(t.agent_group_id, reason);
}

// ---------- changes ----------

export interface ConnectorPatch {
  enabled?: boolean;
  readOnly?: boolean;
  toolPolicy?: Record<string, 'ask' | 'auto' | null>;
}

export async function updateConnector(t: Tenant, id: string, patch: ConnectorPatch): Promise<McpConnectorRow> {
  let row = await ownedConnector(t, id);
  const set: RowPatch = {};
  let toolsetChanged = false;
  if (patch.enabled !== undefined) {
    if (patch.enabled && !row.key_saved_at) throw new ConnectorError('conflict', 'Сначала добавьте ключ');
    if ((row.enabled === 1) !== patch.enabled) {
      set.enabled = patch.enabled ? 1 : 0;
      toolsetChanged = true;
    }
  }
  if (patch.readOnly !== undefined && (row.read_only === 1) !== patch.readOnly) {
    set.read_only = patch.readOnly ? 1 : 0;
    set.bumpRev = true;
    toolsetChanged = true;
  }
  if (patch.toolPolicy !== undefined) {
    const entries = Object.entries(patch.toolPolicy);
    if (entries.length > MAX_POLICY_ENTRIES) throw new ConnectorError('invalid', 'Слишком много правил');
    const policy = parsePolicy(row.tool_policy);
    for (const [tool, v] of entries) {
      if (!TOOL_NAME_RE.test(tool)) throw new ConnectorError('invalid', 'Неверное имя инструмента');
      if (v === null) delete policy[tool];
      else if (v === 'ask' || v === 'auto') policy[tool] = v;
      else throw new ConnectorError('invalid', 'Правило: ask, auto или null');
    }
    const next = JSON.stringify(policy);
    if (next !== JSON.stringify(parsePolicy(row.tool_policy))) {
      set.tool_policy = next;
      set.bumpRev = true;
    }
  }
  if (Object.keys(set).length === 0) return row;
  row = await patchRow(id, set);
  await pushConnector(row, true);
  // The policy is applied by nanogate at once; the tool set (toggle, read-only) needs the running sessions to restart.
  if (toolsetChanged) await changed(t, 'connector toggled');
  await audit(t.user_id, 'connector_update', id, {
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.readOnly !== undefined ? { readOnly: patch.readOnly } : {}),
    ...(patch.toolPolicy !== undefined ? { policy: Object.keys(patch.toolPolicy).length } : {}),
  });
  return row;
}

/** The connector, only if it belongs to this tenant (someone else's id looks like a missing one). */
export async function ownedConnector(t: Tenant, id: string): Promise<McpConnectorRow> {
  const row = await getConnector(id);
  if (!row || row.user_id !== t.user_id) throw new ConnectorError('not_found', 'Коннектор не найден');
  return row;
}

export interface SavedKey {
  row: McpConnectorRow;
  warning?: string;
}

/**
 * Save a key: format check, nanogate probes the candidate in memory (`initialize` + `tools/list`; the old key stays if
 * the upstream rejects it), write the secret, mark the row, push. The first key also switches the connector on.
 */
export async function saveConnectorKey(t: Tenant, id: string, rawValue: unknown): Promise<SavedKey> {
  const row0 = await ownedConnector(t, id);
  const entry = catalogEntry(row0.catalog_id);
  if (!entry) throw new ConnectorError('not_found', 'Коннектор не найден');
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!entry.keyRe.test(value)) throw new ConnectorError('invalid', `Не похоже на токен ${entry.title}`);
  // nanogate must know the connector before it can probe it.
  if (!(await pushConnector(row0, true)))
    throw new ConnectorError('conflict', 'Не удалось сохранить ключ, попробуйте ещё раз');
  const probe = await nanogateAdmin.probeMcpConnector(id, value).catch(() => null);
  if (probe && !probe.ok && probe.error === 'key_rejected') {
    throw new ConnectorError('key_rejected', `${entry.title} не принял ключ`);
  }
  const verdict: 'ok' | 'unverified' = probe?.ok ? 'ok' : 'unverified';

  try {
    await nanogateAdmin.putSecret(gateIdOf(t), row0.secret_name, value);
  } catch (err) {
    log.warn('nc: connector key write failed', { id, err: err instanceof Error ? err.name : 'error' });
    throw new ConnectorError('conflict', 'Не удалось сохранить ключ, попробуйте ещё раз');
  }
  const first = !row0.key_saved_at;
  let row = await patchRow(id, {
    key_saved_at: now(),
    key_status: verdict,
    ...(first ? { enabled: 1 } : {}),
    bumpRev: true,
  });
  let warning: string | undefined;
  if (!(await pushConnector(row, true))) warning = 'Не удалось передать настройки шлюзу, повторю автоматически';
  else if (verdict === 'unverified') warning = `${entry.title} сейчас недоступен, ключ не проверен`;
  await changed(t, 'connector key set');
  await audit(t.user_id, 'connector_key_set', id); // never the value
  return { row, ...(warning ? { warning } : {}) };
}

export async function removeConnectorKey(t: Tenant, id: string): Promise<McpConnectorRow> {
  const row0 = await ownedConnector(t, id);
  await nanogateAdmin.deleteSecret(gateIdOf(t), row0.secret_name).catch((err) => {
    log.warn('nc: connector key delete failed', { id, err: err instanceof Error ? err.name : 'error' });
  });
  const row = await patchRow(id, { key_saved_at: null, key_status: null, enabled: 0, bumpRev: true });
  await pushConnector(row, true);
  await changed(t, 'connector key removed');
  await audit(t.user_id, 'connector_key_removed', id);
  return row;
}

export async function removeConnector(t: Tenant, id: string): Promise<void> {
  const row = await ownedConnector(t, id);
  // A failure here leaves a stale copy at nanogate; the next full sync removes it.
  await nanogateAdmin.deleteMcpConnector(id).catch((err) => {
    log.warn('nc: connector delete failed at nanogate', { id, err: err instanceof Error ? err.message : String(err) });
  });
  await nanogateAdmin.deleteSecret(gateIdOf(t), row.secret_name).catch(() => undefined);
  await deleteConnectorRow(id);
  await changed(t, 'connector removed');
  await audit(t.user_id, 'connector_delete', id);
}

/** nanogate saw the upstream reject the key (HTTP 401/403 for a whole request): remember it for the Mini App. */
export async function markKeyRejected(connectorId: string): Promise<void> {
  const row = await getConnector(connectorId);
  if (!row || !row.key_saved_at || row.key_status === 'rejected') return;
  await patchRow(connectorId, { key_status: 'rejected' });
  await audit('system', 'connector_key_rejected', connectorId);
}

/** Connectors of the user whose key needs attention (for the home screen). */
export async function connectorIssueCount(userId: string): Promise<number> {
  const rows = await listConnectors(userId);
  return rows.filter((r) => r.key_status === 'rejected').length;
}

// ---------- views ----------

const statusOf = (row: McpConnectorRow): Connector['status'] => {
  if (!row.key_saved_at) return 'no_key';
  if (row.key_status === 'rejected') return 'key_rejected';
  if (!row.enabled) return 'disabled';
  return row.key_status === 'unverified' ? 'upstream_error' : 'ok';
};

function toolsView(row: McpConnectorRow, state: McpConnectorState | undefined): ConnectorTool[] {
  const policy = parsePolicy(row.tool_policy);
  return (state?.tools ?? []).map((t) => {
    const p = policy[t.name] ?? null;
    return {
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      readOnly: t.readOnly,
      policy: p,
      asks: p ? p === 'ask' : !t.readOnly,
    };
  });
}

/** Rows of this tenant as the Mini App sees them. `remote` is nanogate's list for the tenant (tools), if it answered. */
export async function connectorViews(t: Tenant, rows?: McpConnectorRow[]): Promise<Connector[]> {
  const mine = rows ?? (await listConnectors(t.user_id));
  if (mine.length === 0) return [];
  let remote: McpConnectorState[] | null = null;
  try {
    remote = await nanogateAdmin.listMcpConnectors(gateIdOf(t));
  } catch (err) {
    log.warn('nc: connector list failed', { user: t.user_id, err: err instanceof Error ? err.message : String(err) });
  }
  const applying = t.agent_group_id ? await groupApplying(t.agent_group_id) : false;
  return mine.map((row) => {
    const entry = catalogEntry(row.catalog_id);
    const warning =
      remote === null || syncErrors.has(row.id) ? 'Нет связи со шлюзом: настройки применятся позже' : undefined;
    return {
      id: row.id,
      catalogId: row.catalog_id,
      title: entry?.title ?? row.catalog_id,
      enabled: row.enabled === 1,
      readOnly: row.read_only === 1,
      key: {
        set: !!row.key_saved_at,
        ...(row.key_saved_at ? { savedAt: row.key_saved_at } : {}),
        status: row.key_saved_at ? row.key_status : null,
      },
      status: statusOf(row),
      ...(warning ? { warning } : {}),
      applying,
      tools: toolsView(
        row,
        remote?.find((r) => r.id === row.id),
      ),
    };
  });
}

export async function connectorView(t: Tenant, row: McpConnectorRow, warning?: string): Promise<Connector> {
  const [view] = await connectorViews(t, [row]);
  return warning && !view.warning ? { ...view, warning } : view;
}

export async function connectorCalls(t: Tenant, row: McpConnectorRow): Promise<ConnectorCall[]> {
  const calls = await nanogateAdmin.mcpCalls({ tenantId: gateIdOf(t), connectorId: row.id, limit: 20 });
  return calls.map((c) => ({
    at: new Date(c.startedAt).toISOString(),
    tool: c.tool,
    dangerous: c.dangerous,
    decision: c.decision,
    status: c.status,
    ...(c.finishedAt !== null && c.finishedAt >= c.startedAt ? { durationMs: c.finishedAt - c.startedAt } : {}),
  }));
}
