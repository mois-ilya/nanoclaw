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
}

export function createNanogateAdmin(
  opts: { socketPath?: string; timeoutMs?: number } = {},
): NanogateAdmin & { socketPath: string } {
  const socketPath = opts.socketPath ?? process.env.NANOGATE_ADMIN_SOCKET?.trim() ?? DEFAULT_ADMIN_SOCKET;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
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
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => reject(new NanogateUnreachableError(path, err)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { status, json } = await request(method, path, body);
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
  };
}
