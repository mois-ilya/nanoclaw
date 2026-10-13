/**
 * Minimal HTTP/1.1-over-unix-socket client for the nanogate admin API
 * (see nanogate/src/admin-api.ts). No dependencies, per-request timeout.
 */
import http from 'node:http';

export const DEFAULT_ADMIN_SOCKET = '/run/nanogate/admin.sock';
const DEFAULT_TIMEOUT_MS = 5_000;

/** A non-2xx admin reply. `code` is nanogate's `{error: code}` string. */
export class NanogateAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly path: string,
  ) {
    super(`nanogate admin ${path} -> ${status} ${code}`);
    this.name = 'NanogateAdminError';
  }
}

/** The admin socket could not be reached or timed out (distinct from an HTTP error reply). */
export class NanogateUnreachableError extends Error {
  constructor(path: string, cause: unknown) {
    super(`nanogate admin ${path} unreachable`, { cause });
    this.name = 'NanogateUnreachableError';
  }
}

/** `adopt` found no live token: the session must fail closed, never mint. */
export class NanogateNoSessionTokenError extends Error {
  constructor(readonly sessionKey: string) {
    super('nanogate has no session token to adopt (no_session_token); refusing to mint on adopt');
    this.name = 'NanogateNoSessionTokenError';
  }
}

export type TenantKind = 'owner' | 'friend' | 'guest' | 'system';
export type HostTokenPurpose = 'stt' | 'guest' | 'miniapp' | 'system';

export interface TenantPolicy {
  models?: string[];
  maxTokens?: number;
  allowServiceTiers?: string[];
  betas?: string[];
  serverTools?: string[];
  egress?: {
    route?: 'direct' | 'connector';
    fallbackDirect?: boolean;
    ports?: number[];
    tailnet?: boolean;
    tailnetPorts?: number[] | 'any';
    tailnetAllow?: string[];
    connectorTenant?: string;
  };
  maxConcurrentRequests?: number;
  perTurnCapMicros?: number;
  [extra: string]: unknown;
}

export interface TenantUpsert {
  kind: TenantKind;
  status?: 'active' | 'paused';
  policy: TenantPolicy;
  budgetLimitMicros: number | null;
  periodTz?: string;
}

export interface BudgetSnapshot {
  limitMicros: number | null;
  usedMicros: number;
  reservedMicros: number;
  periodStart: number | string;
  periodEnd: number | string;
  status: string;
}

export interface NanogateEvent {
  id: number;
  tenantId: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

export interface NanogateSessionRow {
  sessionKey: string;
  tenantId: string;
  runtimeIdentity: string | null;
}

/** Body of `PUT /mcp-connectors/:id` (nanogate keeps its own copy; the secret lives apart under `mcp.<id>`). */
export interface McpConnectorUpsert {
  tenantId: string;
  title: string;
  url: string;
  secretName: string;
  extraHeaders: Record<string, string>;
  toolPolicy: Record<string, 'ask' | 'auto'>;
  enabled: boolean;
}

export interface McpConnectorTool {
  name: string;
  readOnly: boolean;
  title?: string | null;
}

export interface McpConnectorState {
  id: string;
  tenantId: string;
  enabled: boolean;
  tools: McpConnectorTool[];
  toolsSeenAt: number | null;
}

export type McpProbeResult =
  | { ok: true; tools: number }
  | { ok: false; error: 'no_key' | 'key_rejected' | 'upstream_unreachable' | 'upstream_error'; status?: number };

export type McpCallDecision =
  | 'auto'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'unavailable'
  | 'disconnected'
  | 'revoked'
  | 'disabled'
  | 'pending';

export interface McpCallRow {
  id: string;
  connectorId: string;
  tool: string;
  dangerous: boolean;
  decision: McpCallDecision;
  status: 'ok' | 'tool_error' | 'upstream_error' | 'unknown' | null;
  startedAt: number;
  finishedAt: number | null;
}

/** A dangerous `tools/call` that nanogate is holding for a human decision. */
export interface McpPending {
  id: string;
  tenantId: string;
  /** Runtime identity 'slug/group/session'. */
  sessionKey: string;
  connectorId: string;
  connectorTitle: string;
  tool: string;
  args: Array<{ label: string; type: 'text' | 'long_text'; value: string }>;
  createdAt: string;
  expiresAt: string;
}

export interface McpApprovalsReply {
  version: number;
  pending: McpPending[];
}

export type McpApprovalDecision = 'approve' | 'deny' | 'unavailable';

export interface NanogateAdmin {
  healthz(): Promise<boolean>;
  ensureSession(input: {
    tenantId: string;
    sessionKey: string;
    runtimeIdentity: string;
    disposition: 'create' | 'adopt';
    purpose?: 'task';
  }): Promise<{ token: string; created: boolean }>;
  releaseSession(sessionKey: string, kind: 'session-ended' | 'host-detached'): Promise<void>;
  listSessions(): Promise<NanogateSessionRow[]>;
  reconcileSessions(liveSessionKeys: string[]): Promise<{ revoked: string[] }>;
  putTenant(id: string, body: TenantUpsert): Promise<void>;
  pauseTenant(id: string): Promise<void>;
  resumeTenant(id: string): Promise<void>;
  revokeTenant(id: string): Promise<void>;
  mintHostToken(tenantId: string, purpose: HostTokenPurpose): Promise<{ token: string; hashPrefix: string }>;
  deleteHostToken(hashPrefix: string): Promise<void>;
  usage(query: { tenantId?: string; from?: number; to?: number; groupBy?: string }): Promise<unknown>;
  budget(tenantId: string): Promise<BudgetSnapshot>;
  events(after?: number): Promise<NanogateEvent[]>;
  ackEvents(upTo: number): Promise<void>;
  putSecret(tenantId: string, name: string, value: string): Promise<void>;
  deleteSecret(tenantId: string, name: string): Promise<void>;
  listSecrets(tenantId: string): Promise<Array<{ name: string; updatedAt?: number }>>;
  putConnector(
    tenantId: string,
    body: { socksAddr: string; status: 'up' | 'down'; routes: { cidrs: string[]; exitNode: boolean } },
  ): Promise<void>;
  deleteConnector(tenantId: string): Promise<void>;
  /** TCP-connect probe of a connector SOCKS address from nanogate's own network (the host cannot resolve it). */
  probeConnector(socksAddr: string): Promise<boolean>;
  putMcpConnector(id: string, body: McpConnectorUpsert): Promise<void>;
  deleteMcpConnector(id: string): Promise<void>;
  listMcpConnectors(tenantId?: string): Promise<McpConnectorState[]>;
  /** With `candidateKey`: vet a new key in memory only; nothing is stored. */
  probeMcpConnector(id: string, candidateKey?: string): Promise<McpProbeResult>;
  mcpCalls(query: { tenantId: string; connectorId?: string; limit?: number }): Promise<McpCallRow[]>;
  /** Long-poll: answers at once when nanogate's version is past `since`, else after `waitMs` (<= 30000). */
  waitMcpApprovals(since: number, waitMs: number, signal?: AbortSignal): Promise<McpApprovalsReply>;
  /** `accepted:false` means the call already finished (expired, disconnected, revoked). */
  decideMcpApproval(id: string, decision: McpApprovalDecision): Promise<{ accepted: boolean }>;
}

interface RequestOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Long-poll slack on top of `waitMs`, so the poll ends by nanogate's answer rather than our deadline. */
const LONG_POLL_SLACK_MS = 5_000;

export function createNanogateAdmin(
  opts: { socketPath?: string; timeoutMs?: number } = {},
): NanogateAdmin & { socketPath: string } {
  const socketPath = opts.socketPath ?? process.env.NANOGATE_ADMIN_SOCKET?.trim() ?? DEFAULT_ADMIN_SOCKET;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function request(
    method: string,
    path: string,
    body?: unknown,
    ropts: RequestOpts = {},
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      if (ropts.signal?.aborted) return reject(new NanogateUnreachableError(path, new Error('aborted')));
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          socketPath,
          path,
          method,
          // One connection per call: no pooled socket to a restarted nanogate goes stale.
          agent: false,
          headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json: unknown = {};
            if (text) {
              try {
                json = JSON.parse(text);
              } catch {
                json = { error: 'bad_json' };
              }
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
          res.on('error', (err) => reject(new NanogateUnreachableError(path, err)));
        },
      );
      // Total deadline, not idle: a hung admin socket must not stall session admission.
      req.setTimeout(ropts.timeoutMs ?? timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => reject(new NanogateUnreachableError(path, err)));
      if (ropts.signal) {
        const onAbort = () => req.destroy(new Error('aborted'));
        ropts.signal.addEventListener('abort', onAbort, { once: true });
        req.on('close', () => ropts.signal!.removeEventListener('abort', onAbort));
      }
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function call<T>(method: string, path: string, body?: unknown, ropts?: RequestOpts): Promise<T> {
    const { status, json } = await request(method, path, body, ropts);
    if (status >= 200 && status < 300) return json as T;
    const code =
      typeof (json as { error?: unknown })?.error === 'string' ? (json as { error: string }).error : `http_${status}`;
    throw new NanogateAdminError(status, code, path);
  }

  const seg = encodeURIComponent;
  return {
    socketPath,
    async healthz() {
      try {
        const { status } = await request('GET', '/healthz');
        return status === 200;
      } catch {
        return false;
      }
    },
    ensureSession: (input) => call('POST', '/sessions/ensure', input),
    async releaseSession(sessionKey, kind) {
      await call('POST', '/sessions/release', { sessionKey, kind });
    },
    async listSessions() {
      return (await call<{ sessions: NanogateSessionRow[] }>('GET', '/sessions')).sessions;
    },
    reconcileSessions: (liveSessionKeys) => call('POST', '/sessions/reconcile', { liveSessionKeys }),
    async putTenant(id, body) {
      await call('PUT', `/tenants/${seg(id)}`, body);
    },
    async pauseTenant(id) {
      await call('POST', `/tenants/${seg(id)}/pause`);
    },
    async resumeTenant(id) {
      await call('POST', `/tenants/${seg(id)}/resume`);
    },
    async revokeTenant(id) {
      await call('POST', `/tenants/${seg(id)}/revoke`);
    },
    mintHostToken: (tenantId, purpose) => call('POST', '/host-tokens', { tenantId, purpose }),
    async deleteHostToken(hashPrefix) {
      await call('DELETE', `/host-tokens/${seg(hashPrefix)}`);
    },
    usage(query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) q.set(k, String(v));
      return call('GET', `/usage?${q.toString()}`);
    },
    budget: (tenantId) => call('GET', `/budget/${seg(tenantId)}`),
    async events(after = 0) {
      return (await call<{ events: NanogateEvent[] }>('GET', `/events?after=${after}`)).events;
    },
    async ackEvents(upTo) {
      await call('POST', '/events/ack', { upTo });
    },
    async putSecret(tenantId, name, value) {
      await call('PUT', `/secrets/${seg(tenantId)}/${seg(name)}`, { value });
    },
    async deleteSecret(tenantId, name) {
      await call('DELETE', `/secrets/${seg(tenantId)}/${seg(name)}`);
    },
    async listSecrets(tenantId) {
      const r = await call<{ secrets?: Array<{ name: string; updatedAt?: number }> }>(
        'GET',
        `/secrets/${seg(tenantId)}`,
      );
      return r.secrets ?? [];
    },
    async putConnector(tenantId, body) {
      await call('PUT', `/connectors/${seg(tenantId)}`, body);
    },
    async deleteConnector(tenantId) {
      await call('DELETE', `/connectors/${seg(tenantId)}`);
    },
    async probeConnector(socksAddr) {
      const r = await call<{ up?: boolean }>('POST', '/connectors/probe', { socksAddr });
      return r.up === true;
    },
    async putMcpConnector(id, body) {
      await call('PUT', `/mcp-connectors/${seg(id)}`, body);
    },
    async deleteMcpConnector(id) {
      await call('DELETE', `/mcp-connectors/${seg(id)}`);
    },
    async listMcpConnectors(tenantId) {
      const q = tenantId === undefined ? '' : `?tenantId=${seg(tenantId)}`;
      return (await call<{ connectors?: McpConnectorState[] }>('GET', `/mcp-connectors${q}`)).connectors ?? [];
    },
    // Probe talks to the upstream (up to 5 list pages), so it gets more than the default 5 s.
    probeMcpConnector: (id, candidateKey) =>
      call('POST', `/mcp-connectors/${seg(id)}/probe`, candidateKey === undefined ? undefined : { candidateKey }, {
        timeoutMs: 45_000,
      }),
    async mcpCalls(query) {
      const q = new URLSearchParams({ tenantId: query.tenantId });
      if (query.connectorId !== undefined) q.set('connectorId', query.connectorId);
      if (query.limit !== undefined) q.set('limit', String(query.limit));
      return (await call<{ calls?: McpCallRow[] }>('GET', `/mcp-calls?${q.toString()}`)).calls ?? [];
    },
    waitMcpApprovals: (since, waitMs, signal) =>
      call('GET', `/mcp-approvals?since=${since}&waitMs=${waitMs}`, undefined, {
        timeoutMs: waitMs + LONG_POLL_SLACK_MS,
        signal,
      }),
    decideMcpApproval: (id, decision) => call('POST', `/mcp-approvals/${seg(id)}/decision`, { decision }),
  };
}
