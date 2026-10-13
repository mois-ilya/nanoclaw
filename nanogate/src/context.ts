import type { Config } from './config.js';
import type { Db } from './db.js';
import type { LiveRegistry } from './live.js';
import type { CidrSet } from './cidr.js';
import type { McpApprovals } from './mcp-approvals.js';

/** A gateway-issued Mcp-Session-Id: bound to the agent token and connector, and to the upstream's own id if it has one. */
export interface McpSessionBinding {
  tokenHash: string;
  connectorId: string;
  upstreamSid: string | null;
  lastUsed: number;
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface Ctx {
  db: Db;
  config: Config;
  apiKey: string;
  encKey: Buffer;
  live: LiveRegistry;
  log: (o: Record<string, unknown>) => void;
  resolve: Resolver;
  /** built-in + config deny set */
  denySet: CidrSet;
  /** config.denyCidrs + hostAddresses only: never exempted, not even for tailnet routes */
  hardDenySet: CidrSet;
  inflight: Map<string, number>;
  /** reservation ids of requests still being handled (the periodic sweep must not touch them) */
  activeReservations: Set<string>;
  /** bytes of request bodies currently held in memory, all tenants */
  bodyBytes: number;
  /** same, per tenant */
  tenantBodyBytes: Map<string, number>;
  /** DNS lookups running (global / per tenant) and the FIFO wait queues in front of them */
  dns: { global: number; perTenant: Map<string, number>; queues: Map<string, { start(): void }[]>; queued: number };
  warnedBetas: Set<string>;
  mcpSessions: Map<string, McpSessionBinding>;
  mcpApprovals: McpApprovals;
  /** TEST ONLY: extra CA for the HTTPS client talking to MCP upstreams. */
  mcpUpstreamCa?: string | Buffer;
  egress: Map<string, { tenantId: string; day: string; up: number; down: number; tunnels: number }>;
}
