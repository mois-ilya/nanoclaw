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
