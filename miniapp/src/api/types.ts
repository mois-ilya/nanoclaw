// Mini App API contract (v1). Shared: the SPA and the backend import this same file.
// Keep it dependency-free and type-only.

export type Role = 'owner' | 'friend';
export type LifecycleState = 'ready' | 'paused';
export interface Me {
  userId: string;
  name: string;
  role: Role;
  state: LifecycleState;
  lang: 'ru' | 'en';
  tz: string;
}
export interface Money {
  micros: number;
} // USD micros; UI formats "$3.10"
export interface Budget {
  limit: Money | null;
  used: Money;
  reserved: Money;
  periodStart: string;
  periodEnd: string;
  status: 'ok' | 'warn' | 'exhausted';
}
export interface HomeView {
  me: Me;
  assistant: { status: 'ready' | 'busy' | 'paused' | 'error'; currentTask?: string };
  budget: Budget;
  nextTasks: TaskSummary[];
  recentMemory: { title: string; path: string; updatedAt: string }[];
  attention?: { pendingRequests: number; friendsOverBudget: number; connectorIssues: number } /* owner */;
}
export interface PromptView {
  layers: {
    id: 'platform' | 'personal' | 'skills';
    title: string;
    locked: boolean;
    markdown: string;
    source: string;
  }[];
  composedAt: string;
}
export interface MemoryTree {
  entries: { path: string; title: string; size: number; updatedAt: string; kind: 'file' | 'dir' }[];
  truncated: boolean;
}
export interface MemoryFile {
  path: string;
  markdown: string;
  truncated: boolean;
  updatedAt: string;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  locked: boolean;
}
export interface TaskSummary {
  id: string;
  name: string;
  scheduleHuman: string;
  nextRunAt: string | null;
  status: 'active' | 'paused';
  lastResult?: 'ok' | 'error' | 'silent';
}
export interface TaskDetail extends TaskSummary {
  prompt: string;
  runs: { at: string; result: 'ok' | 'error' | 'silent'; note?: string }[];
}
export interface UsageView {
  budget: Budget;
  daily: { day: string; cost: Money }[];
  byModel: { model: string; cost: Money }[];
  byPurpose: { purpose: 'chat' | 'task' | 'voice' | 'guest'; cost: Money }[];
  topTurns: { title: string; at: string; cost: Money }[];
  pending: Money;
  priceVersion: string;
}
export interface Connection {
  id: 'tailscale';
  status: 'not_connected' | 'connecting' | 'connected' | 'error' | 'expired';
  node?: string;
  exitNode?: string;
  exitNodeOnline?: boolean;
  routes?: string[];
  lastCheckAt?: string;
  keySavedAt?: string;
  keyExpiresAt?: string;
  message?: string;
}
export interface EgressView {
  route: 'direct' | 'residential';
  residentialAvailable: boolean;
}
export interface Settings {
  lang: 'ru' | 'en';
  tz: string;
  preset: 'fast' | 'normal' | 'deep';
  quietHours: { from: string; to: string } | null;
  showSteps: boolean;
}
// owner
export interface AccessRequest {
  id: string;
  userId: string;
  name: string;
  username?: string;
  firstMessage: string;
  createdAt: string;
}
export interface Friend {
  userId: string;
  name: string;
  username?: string;
  state: 'ready' | 'paused' | 'provisioning' | 'provisioning_failed';
  budget: Budget;
  lastActiveAt?: string;
  container: 'running' | 'idle';
  egress: 'direct' | 'residential';
}
export interface GuestContext {
  published: { version: number; markdown: string; publishedAt: string } | null;
  draft: string;
  enabled: boolean;
  recent: { at: string; chatTitle: string; query: string; answer: string }[];
}
export interface SystemView {
  version: string;
  uptimeS: number;
  slice: { memUsed: number; memMax: number };
  containers: { running: number; max: number };
  gateway: 'ok' | 'down';
  connectors: { tenant: string; status: string }[];
  spendByUser: { name: string; cost: Money }[];
  globalCap: Money;
  errors7d: number;
}

// MCP connectors (Stage 1). Owner-only in the Cabinet; keys are write-only and never come back.
export interface CatalogItem {
  id: string;
  title: string;
  description: string;
  keyLabel: string;
  keyHelp: string;
  keyUrl: string;
}
export interface ConnectorTool {
  name: string;
  title?: string;
  readOnly: boolean;
  policy: 'ask' | 'auto' | null;
  asks: boolean;
}
export interface Connector {
  id: string;
  catalogId: string;
  title: string;
  enabled: boolean;
  readOnly: boolean;
  key: { set: boolean; savedAt?: string; status: 'ok' | 'rejected' | 'unverified' | null };
  status: 'ok' | 'no_key' | 'key_rejected' | 'upstream_error' | 'disabled';
  warning?: string;
  applying: boolean; // running sessions still hold the old config
  tools: ConnectorTool[]; // empty until the first probe / tools/list
}
export interface ConnectorsView {
  catalog: CatalogItem[];
  connectors: Connector[];
}
export interface ConnectorCall {
  at: string;
  tool: string;
  dangerous: boolean;
  decision:
    | 'auto'
    | 'approved'
    | 'denied'
    | 'expired'
    | 'unavailable'
    | 'disconnected'
    | 'revoked'
    | 'disabled'
    | 'pending';
  status: 'ok' | 'tool_error' | 'upstream_error' | 'unknown' | null;
  durationMs?: number;
}

// Session / errors (see "Auth flow" in the contract)
export interface SessionResponse {
  token: string;
  expiresAt: string;
  me: Me;
}
export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'rate_limited'
  | 'internal';
export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
