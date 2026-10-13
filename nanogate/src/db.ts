import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { TenantPolicy } from './policy.js';
import { normalizePolicy } from './policy.js';

export type Db = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('owner','friend','guest','system')),
  status TEXT NOT NULL CHECK(status IN ('active','paused','revoked')),
  epoch INTEGER NOT NULL DEFAULT 0,
  policy_json TEXT NOT NULL,
  budget_period TEXT NOT NULL DEFAULT 'month' CHECK(budget_period IN ('month')),
  budget_limit_micros INTEGER,
  period_tz TEXT NOT NULL DEFAULT 'UTC',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,
  enc TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('session','host')),
  tenant_id TEXT NOT NULL,
  session_key TEXT,
  purpose TEXT,
  runtime_identity TEXT,
  epoch INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS tokens_live_session
  ON tokens(session_key) WHERE kind = 'session' AND revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  model TEXT NOT NULL,
  turn_id TEXT,
  reserved_micros INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open','settled','abandoned')),
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS reservations_open ON reservations(status, tenant_id);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  session_key TEXT,
  purpose TEXT,
  turn_id TEXT,
  model TEXT NOT NULL,
  service_tier TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_5m INTEGER NOT NULL,
  cache_creation_1h INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  server_tool_json TEXT NOT NULL,
  cost_micros INTEGER NOT NULL,
  price_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reconciled','estimated')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_tenant_time ON usage(tenant_id, started_at);
CREATE TABLE IF NOT EXISTS secrets (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS connectors (
  tenant_id TEXT PRIMARY KEY,
  socks_addr TEXT NOT NULL,
  status TEXT NOT NULL,
  routes_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_connectors (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  secret_name TEXT NOT NULL,
  extra_headers TEXT NOT NULL DEFAULT '{}',
  tool_policy TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_connectors_tenant ON mcp_connectors(tenant_id);
CREATE TABLE IF NOT EXISTS mcp_tools (
  connector_id TEXT NOT NULL,
  name TEXT NOT NULL,
  read_only INTEGER NOT NULL,
  title TEXT,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (connector_id, name)
);
CREATE TABLE IF NOT EXISTS mcp_calls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connector_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  dangerous INTEGER NOT NULL,
  decision TEXT NOT NULL,
  status TEXT,
  http_status INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_calls_tenant_time ON mcp_calls(tenant_id, started_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS egress_stats (
  tenant_id TEXT NOT NULL,
  day TEXT NOT NULL,
  bytes_up INTEGER NOT NULL DEFAULT 0,
  bytes_down INTEGER NOT NULL DEFAULT 0,
  tunnels INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
`;

export function openDb(stateDir: string): Db {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(stateDir, 'nanogate.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export interface TenantRow {
  id: string;
  kind: string;
  status: 'active' | 'paused' | 'revoked';
  epoch: number;
  policy: TenantPolicy;
  budgetLimitMicros: number | null;
  periodTz: string;
}

interface RawTenant {
  id: string;
  kind: string;
  status: 'active' | 'paused' | 'revoked';
  epoch: number;
  policy_json: string;
  budget_limit_micros: number | null;
  period_tz: string;
}

export function getTenant(db: Db, id: string): TenantRow | null {
  const r = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as RawTenant | undefined;
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    epoch: r.epoch,
    policy: normalizePolicy(JSON.parse(r.policy_json)),
    budgetLimitMicros: r.budget_limit_micros,
    periodTz: r.period_tz,
  };
}

export interface ConnectorRow {
  socksAddr: string;
  status: string;
  cidrs: string[];
  exitNode: boolean;
}

export function getConnector(db: Db, tenantId: string): ConnectorRow | null {
  const r = db.prepare('SELECT * FROM connectors WHERE tenant_id = ?').get(tenantId) as
    | { socks_addr: string; status: string; routes_json: string }
    | undefined;
  if (!r) return null;
  const routes = JSON.parse(r.routes_json) as { cidrs?: string[]; exitNode?: boolean };
  return { socksAddr: r.socks_addr, status: r.status, cidrs: routes.cidrs ?? [], exitNode: !!routes.exitNode };
}

export function insertEvent(db: Db, tenantId: string, type: string, payload: unknown): void {
  db.prepare('INSERT INTO events(tenant_id, type, payload_json, created_at) VALUES (?,?,?,?)').run(
    tenantId,
    type,
    JSON.stringify(payload),
    Date.now(),
  );
}

export type McpToolPolicy = Record<string, 'ask' | 'auto'>;

export interface McpConnectorRow {
  id: string;
  tenantId: string;
  title: string;
  url: string;
  secretName: string;
  extraHeaders: Record<string, string>;
  toolPolicy: McpToolPolicy;
  enabled: boolean;
  /** bumped on any change of key, url, headers or tool policy; a held call is only sent if it is unchanged */
  rev: number;
  updatedAt: number;
}

interface RawMcpConnector {
  id: string;
  tenant_id: string;
  title: string;
  url: string;
  secret_name: string;
  extra_headers: string;
  tool_policy: string;
  enabled: number;
  rev: number;
  updated_at: number;
}

const toMcpConnector = (r: RawMcpConnector): McpConnectorRow => ({
  id: r.id,
  tenantId: r.tenant_id,
  title: r.title,
  url: r.url,
  secretName: r.secret_name,
  extraHeaders: JSON.parse(r.extra_headers) as Record<string, string>,
  toolPolicy: JSON.parse(r.tool_policy) as McpToolPolicy,
  enabled: r.enabled === 1,
  rev: r.rev,
  updatedAt: r.updated_at,
});

export function getMcpConnector(db: Db, id: string): McpConnectorRow | null {
  const r = db.prepare('SELECT * FROM mcp_connectors WHERE id = ?').get(id) as RawMcpConnector | undefined;
  return r ? toMcpConnector(r) : null;
}

export function listMcpConnectors(db: Db, tenantId?: string): McpConnectorRow[] {
  const rows = (
    tenantId === undefined
      ? db.prepare('SELECT * FROM mcp_connectors ORDER BY id').all()
      : db.prepare('SELECT * FROM mcp_connectors WHERE tenant_id = ? ORDER BY id').all(tenantId)
  ) as RawMcpConnector[];
  return rows.map(toMcpConnector);
}

export function getMcpConnectorBySecret(db: Db, tenantId: string, secretName: string): McpConnectorRow | null {
  const r = db
    .prepare('SELECT * FROM mcp_connectors WHERE tenant_id = ? AND secret_name = ?')
    .get(tenantId, secretName) as RawMcpConnector | undefined;
  return r ? toMcpConnector(r) : null;
}

/** Insert or update; rev grows when anything the key/URL/headers/policy depends on changes. Returns the stored row. */
export function upsertMcpConnector(db: Db, c: Omit<McpConnectorRow, 'rev' | 'updatedAt'>): McpConnectorRow {
  const old = getMcpConnector(db, c.id);
  const eh = JSON.stringify(c.extraHeaders);
  const tp = JSON.stringify(c.toolPolicy);
  const changed =
    !old ||
    old.tenantId !== c.tenantId ||
    old.url !== c.url ||
    old.secretName !== c.secretName ||
    JSON.stringify(old.extraHeaders) !== eh ||
    JSON.stringify(old.toolPolicy) !== tp;
  db.prepare(
    `INSERT INTO mcp_connectors(id, tenant_id, title, url, secret_name, extra_headers, tool_policy, enabled, rev, updated_at)
     VALUES (?,?,?,?,?,?,?,?,1,?)
     ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id, title=excluded.title, url=excluded.url, secret_name=excluded.secret_name,
       extra_headers=excluded.extra_headers, tool_policy=excluded.tool_policy, enabled=excluded.enabled,
       rev=rev+${changed && old ? 1 : 0}, updated_at=excluded.updated_at`,
  ).run(c.id, c.tenantId, c.title, c.url, c.secretName, eh, tp, c.enabled ? 1 : 0, Date.now());
  return getMcpConnector(db, c.id)!;
}

export function bumpMcpRev(db: Db, id: string): void {
  db.prepare('UPDATE mcp_connectors SET rev = rev + 1 WHERE id = ?').run(id);
}

export function deleteMcpConnector(db: Db, id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM mcp_tools WHERE connector_id = ?').run(id);
    db.prepare('DELETE FROM mcp_connectors WHERE id = ?').run(id);
  })();
}

export interface McpToolRow {
  name: string;
  readOnly: boolean;
  title: string | null;
  seenAt: number;
}

export function listMcpTools(db: Db, connectorId: string): McpToolRow[] {
  const rows = db
    .prepare('SELECT name, read_only, title, seen_at FROM mcp_tools WHERE connector_id = ? ORDER BY name')
    .all(connectorId) as { name: string; read_only: number; title: string | null; seen_at: number }[];
  return rows.map((r) => ({ name: r.name, readOnly: r.read_only === 1, title: r.title, seenAt: r.seen_at }));
}

/** replaceAll: the list is the full inventory, tools it does not mention are forgotten. */
export function upsertMcpTools(
  db: Db,
  connectorId: string,
  tools: { name: string; readOnly: boolean; title?: string | null }[],
  replaceAll: boolean,
): void {
  const now = Date.now();
  const up = db.prepare(
    `INSERT INTO mcp_tools(connector_id, name, read_only, title, seen_at) VALUES (?,?,?,?,?)
     ON CONFLICT(connector_id, name) DO UPDATE SET read_only=excluded.read_only, title=excluded.title, seen_at=excluded.seen_at`,
  );
  db.transaction(() => {
    if (replaceAll) db.prepare('DELETE FROM mcp_tools WHERE connector_id = ?').run(connectorId);
    for (const t of tools) up.run(connectorId, t.name, t.readOnly ? 1 : 0, t.title ? t.title.slice(0, 120) : null, now);
  })();
}

export interface McpCallInsert {
  id: string;
  tenantId: string;
  connectorId: string;
  sessionKey: string;
  tool: string;
  dangerous: boolean;
  decision: string;
  startedAt: number;
}

export function insertMcpCall(db: Db, c: McpCallInsert): void {
  db.prepare(
    `INSERT INTO mcp_calls(id, tenant_id, connector_id, session_key, tool, dangerous, decision, started_at) VALUES (?,?,?,?,?,?,?,?)`,
  ).run(c.id, c.tenantId, c.connectorId, c.sessionKey, c.tool, c.dangerous ? 1 : 0, c.decision, c.startedAt);
}

export function finishMcpCall(
  db: Db,
  id: string,
  f: { decision?: string; status: string | null; httpStatus?: number | null },
): void {
  db.prepare(
    'UPDATE mcp_calls SET decision = COALESCE(?, decision), status = ?, http_status = ?, finished_at = ? WHERE id = ?',
  ).run(f.decision ?? null, f.status, f.httpStatus ?? null, Date.now(), id);
}

export interface McpCallRow {
  id: string;
  connectorId: string;
  tool: string;
  dangerous: boolean;
  decision: string;
  status: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export function listMcpCalls(db: Db, tenantId: string, connectorId: string | undefined, limit: number): McpCallRow[] {
  const rows = db
    .prepare(
      `SELECT id, connector_id, tool, dangerous, decision, status, started_at, finished_at FROM mcp_calls
     WHERE tenant_id = ? ${connectorId ? 'AND connector_id = ?' : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...(connectorId ? [tenantId, connectorId, limit] : [tenantId, limit])) as {
    id: string;
    connector_id: string;
    tool: string;
    dangerous: number;
    decision: string;
    status: string | null;
    started_at: number;
    finished_at: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    connectorId: r.connector_id,
    tool: r.tool,
    dangerous: r.dangerous === 1,
    decision: r.decision,
    status: r.status,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  }));
}

export function pruneMcpCalls(db: Db, now: number, retentionDays: number): number {
  return db.prepare('DELETE FROM mcp_calls WHERE started_at < ?').run(now - retentionDays * 86_400_000).changes;
}

/** After a restart nothing is in flight: close the rows the previous process left open. */
export function reapMcpCalls(db: Db): number {
  const now = Date.now();
  const a = db
    .prepare(
      "UPDATE mcp_calls SET decision='unavailable', finished_at=? WHERE finished_at IS NULL AND decision='pending'",
    )
    .run(now).changes;
  const b = db
    .prepare("UPDATE mcp_calls SET status='unknown', finished_at=? WHERE finished_at IS NULL")
    .run(now).changes;
  return a + b;
}
