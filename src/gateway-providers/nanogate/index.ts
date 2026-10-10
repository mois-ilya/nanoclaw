/**
 * nanogate gateway provider.
 *
 * nanogate (this repo's `nanogate/`) is the only holder of the real Anthropic
 * key. Each agent session gets an opaque per-session token (`ngs_...`) and a
 * per-session `nanorelay` container that forwards the agent's model and CONNECT
 * traffic to nanogate over the `nanogate-svc` network. The agent itself has no
 * route anywhere else (internal session network, see `drivers/podman-driver.ts`).
 *
 * Tenant = agent group (upstream's privacy unit). Session key = the stable
 * `slug/group/session` runtime identity, so a restarted host adopts the SAME
 * token and never mints a replacement for a surviving runtime.
 *
 * Documented exception: the session-scoped token rides in the agent's env
 * (ANTHROPIC_API_KEY and the proxy userinfo). It is a capability bound to one
 * session, revoked when the session ends — not an upstream credential.
 */
import { readEnvFile } from '../../env.js';
import { registerSessionKindResolver } from '../../lifecycle-policy.js';
import { log } from '../../log.js';
import { looksLikeCredential, type ContainerSpec } from '../../drivers/types.js';
import {
  gatewayRuntimeIdentity,
  registerGatewayProvider,
  type GatewayProviderDefinition,
  type GatewaySessionInput,
  type GatewaySessionLease,
  type GatewaySessionRelease,
} from '../gateway-provider-registry.js';
import {
  NanogateAdminError,
  NanogateNoSessionTokenError,
  createNanogateAdmin,
  type HostTokenPurpose,
  type NanogateAdmin,
  type TenantKind,
} from './admin-client.js';

export * from './admin-client.js';

export const NANOGATE_KIND = 'nanogate';
export const RELAY_ROLE = 'relay';
export const RELAY_ENDPOINT = 'nanorelay';
const HEALTH_INTERVAL_MS = 10_000;
/** A health lease older than this reads as unavailable (the probe loop died). */
const HEALTH_STALE_MS = 35_000;
const SESSION_TOKEN = /^ngs_[A-Za-z0-9_-]{16,128}$/;

// ---------- admin client singleton ----------

let adminClient: NanogateAdmin = createNanogateAdmin();

/** Test seam: swap the admin client (e.g. one on a temp socket). */
export function setNanogateAdminForTests(next: NanogateAdmin | null): void {
  adminClient = next ?? createNanogateAdmin();
}

/**
 * Admin surface for the product module (budget, usage, events, secrets,
 * connectors, tenants). A facade so a test-swapped client is always honored.
 */
export const nanogateAdmin: NanogateAdmin = new Proxy({} as NanogateAdmin, {
  get: (_t, prop) => (adminClient as unknown as Record<string | symbol, unknown>)[prop],
});

/** For voice (stt) and guest paths that call the host-caller port directly. */
export async function mintHostToken(tenantId: string, purpose: HostTokenPurpose): Promise<string> {
  return (await adminClient.mintHostToken(tenantId, purpose)).token;
}

// ---------- tenant mapping ----------

export interface ResolvedTenant {
  tenantId: string;
  kind: TenantKind;
}
export type TenantResolver = (agentGroupId: string) => ResolvedTenant;
export type TenantProvisioner = (tenant: ResolvedTenant, admin: NanogateAdmin) => Promise<void>;

/**
 * Default: owner when the agent group is listed in `NANOCLAW_OWNER_AGENT_GROUP_IDS`
 * (comma-separated), else friend. The product module replaces this.
 */
function defaultResolver(agentGroupId: string): ResolvedTenant {
  const raw =
    process.env.NANOCLAW_OWNER_AGENT_GROUP_IDS ??
    readEnvFile(['NANOCLAW_OWNER_AGENT_GROUP_IDS']).NANOCLAW_OWNER_AGENT_GROUP_IDS ??
    '';
  const owners = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return { tenantId: agentGroupId, kind: owners.has(agentGroupId) ? 'owner' : 'friend' };
}

let resolver: TenantResolver = defaultResolver;
let provisioner: TenantProvisioner | null = null;

/** The product module registers how an agent group maps to a tenant kind. */
export function registerTenantResolver(next: TenantResolver | null): void {
  resolver = next ?? defaultResolver;
  // nanoclaw-fork: the same owner/friend answer drives the idle stop and spawn-queue priority in core.
  registerSessionKindResolver(
    next ? (agentGroupId) => (next(agentGroupId).kind === 'owner' ? 'owner' : 'friend') : null,
  );
}

/** Optional: create the tenant (policy, budget) when nanogate answers `tenant_not_found`. */
export function registerTenantProvisioner(next: TenantProvisioner | null): void {
  provisioner = next;
}

// ---------- health ----------

let healthy = false;
let lastProbeAt = 0;
let healthTimer: NodeJS.Timeout | undefined;
let firstProbe: Promise<void> | undefined;
const unavailableReporters = new Set<(reason: string) => void>();

async function probe(): Promise<void> {
  const ok = await adminClient.healthz();
  const was = healthy;
  healthy = ok;
  lastProbeAt = Date.now();
  if (was && !ok) {
    log.error('nanogate became unavailable');
    for (const report of [...unavailableReporters]) report('nanogate admin health probe failed');
  } else if (!was && ok) {
    log.info('nanogate available');
  }
}

/** Idempotent. The first call waits for one probe so `read()` never reports a cold false-positive. */
export function startNanogateHealth(intervalMs: number = HEALTH_INTERVAL_MS): Promise<void> {
  if (!healthTimer) {
    firstProbe = probe();
    healthTimer = setInterval(() => void probe().catch(() => {}), intervalMs);
    healthTimer.unref();
  }
  return firstProbe ?? Promise.resolve();
}

export function stopNanogateHealth(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = undefined;
  firstProbe = undefined;
  healthy = false;
  lastProbeAt = 0;
  unavailableReporters.clear();
}

// ---------- ensure ----------

function setting(key: string): string {
  return process.env[key]?.trim() || readEnvFile([key])[key]?.trim() || '';
}

function relayContainer(): ContainerSpec {
  const image = setting('NANORELAY_IMAGE');
  if (!image) {
    throw new Error('NANORELAY_IMAGE is not set: the nanogate provider needs a pinned nanorelay image reference');
  }
  return {
    role: RELAY_ROLE,
    image,
    env: { NANORELAY_MAP: '8080=nanogate:8080,3128=nanogate:3128' },
    mounts: [],
    // M8: the relay is a tiny forwarder.
    resources: { memoryMb: 32, cpus: '0.25', pidsLimit: 64 },
  };
}

/** Env for the agent. The token is validated first: it ends up inside a URL's userinfo. */
export function agentEnv(token: string): Record<string, string> {
  if (!SESSION_TOKEN.test(token) || looksLikeCredential(token)) {
    throw new Error('nanogate returned a session token in an unexpected format');
  }
  const proxy = `http://s:${token}@${RELAY_ENDPOINT}:3128`;
  const noProxy = `${RELAY_ENDPOINT},localhost,127.0.0.1`;
  return {
    ANTHROPIC_BASE_URL: `http://${RELAY_ENDPOINT}:8080/anthropic`,
    // The Claude Agent SDK sends ANTHROPIC_API_KEY as x-api-key, which nanogate
    // accepts alongside Bearer. (ANTHROPIC_AUTH_TOKEN would also work.)
    ANTHROPIC_API_KEY: token,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    // Node (>= 24, and 22.21+) only honours HTTPS_PROXY for fetch/http with this flag; the agent network has no other way out.
    NODE_USE_ENV_PROXY: '1',
    // WebFetch and Explore subagents call the small model; pin it to one nanogate's default policy allows.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: smallModel(),
    ANTHROPIC_SMALL_FAST_MODEL: smallModel(),
    // Claude Code switches MCP tool search off for a non-first-party base URL unless this is set. Needs
    // `advanced-tool-use-2025-11-20` in nanogate's defaultBetas. Kill switch: NC_TOOL_SEARCH=0.
    ...(enabled('NC_TOOL_SEARCH') ? { ENABLE_TOOL_SEARCH: 'true' } : {}),
    // 1-hour prompt cache for the main conversation (needs `extended-cache-ttl-2025-04-11`; writes bill at
    // the 1h rate). Kill switch: NC_PROMPT_CACHE_1H=0.
    ...(enabled('NC_PROMPT_CACHE_1H') ? { CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' } : {}),
  };
}

/** A feature toggle that is on unless set to 0/false/off/no. */
function enabled(key: string): boolean {
  return !/^(0|false|off|no)$/i.test(setting(key));
}

/** Follows NC_MODEL_SMALL (same source as the nanogate policy in src/nc/tenants.ts). */
function smallModel(): string {
  return process.env.NC_MODEL_SMALL || 'claude-haiku-5-5';
}

async function ensureToken(input: GatewaySessionInput): Promise<string> {
  const sessionKey = gatewayRuntimeIdentity(input.key);
  const tenant = resolver(input.key.agentGroupId);
  const disposition = input.disposition ?? 'create';
  const body = {
    tenantId: tenant.tenantId,
    sessionKey,
    runtimeIdentity: input.runtimeIdentity,
    disposition,
    ...(input.purpose ? { purpose: input.purpose } : {}),
  };
  try {
    return (await adminClient.ensureSession(body)).token;
  } catch (err) {
    if (err instanceof NanogateAdminError) {
      // Never mint on adopt: a surviving runtime without a token fails closed.
      if (err.status === 409 && err.code === 'no_session_token') throw new NanogateNoSessionTokenError(sessionKey);
      if (err.status === 404 && err.code === 'tenant_not_found' && provisioner && disposition === 'create') {
        await provisioner(tenant, adminClient);
        return (await adminClient.ensureSession(body)).token;
      }
    }
    throw err;
  }
}

async function ensure(input: GatewaySessionInput, _signal: AbortSignal): Promise<GatewaySessionLease> {
  if (!input.capabilities.auxiliaryContainers) {
    throw new Error('The nanogate provider needs a session driver with auxiliary containers');
  }
  const token = await ensureToken(input);
  const sessionKey = gatewayRuntimeIdentity(input.key);
  const contribution = {
    networkAccess: { endpoint: RELAY_ENDPOINT, target: { kind: 'session-container' as const, role: RELAY_ROLE } },
    containers: [relayContainer()],
    env: agentEnv(token),
  };
  return {
    contribution,
    async release(event: GatewaySessionRelease) {
      if (event.kind === 'host-detached') {
        // Logging-only on the nanogate side; a failure here must not matter.
        await adminClient.releaseSession(sessionKey, 'host-detached').catch(() => {});
        return;
      }
      await adminClient.releaseSession(sessionKey, 'session-ended');
    },
    onUnavailable(report) {
      unavailableReporters.add(report);
      void startNanogateHealth();
    },
  };
}

// ---------- startup sweep ----------

/**
 * After adoption has settled: revoke tokens of THIS install whose runtime no
 * longer exists. Other installs' keys are passed through untouched (a shared
 * nanogate serves prod and test), and an unreadable runtime list skips the
 * sweep entirely rather than revoking everything.
 */
async function reapOrphans(): Promise<void> {
  const { getSessionDriver } = await import('../../drivers/index.js');
  const { INSTALL_SLUG } = await import('../../config.js');
  try {
    const live = await getSessionDriver().listSessions(INSTALL_SLUG);
    const liveKeys = live.filter((s) => s.phase !== 'terminal').map((s) => gatewayRuntimeIdentity(s.handle.key));
    const mine = `${INSTALL_SLUG}/`;
    const foreign = (await adminClient.listSessions()).map((s) => s.sessionKey).filter((k) => !k.startsWith(mine));
    const { revoked } = await adminClient.reconcileSessions([...liveKeys, ...foreign]);
    if (revoked.length > 0) log.info('nanogate: revoked tokens of vanished sessions', { count: revoked.length });
  } catch (err) {
    log.warn('nanogate reconcile skipped', { err });
  }
}

// ---------- registration ----------

export const nanogateProvider: GatewayProviderDefinition = {
  kind: NANOGATE_KIND,
  agentSkills: [],
  availability: {
    // This process is the only observer; nothing to publish.
    publish: async () => {},
    async read() {
      await startNanogateHealth();
      return healthy && Date.now() - lastProbeAt < HEALTH_STALE_MS;
    },
  },
  sessions: { ensure, reapOrphans },
  approvals: {
    // No approvals in v1: hold the subscription open until the host detaches.
    subscribe: (_decide, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  },
};

registerGatewayProvider(nanogateProvider);
