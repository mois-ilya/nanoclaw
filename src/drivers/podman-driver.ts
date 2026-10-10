/**
 * Podman driver — nanoclaw-fork realization of the session seam on a rootful
 * Podman reached over its socket (`podman --remote --url unix:///...`).
 *
 * Copy-adapt of `docker-driver.ts` (upstream nanocoai/nanoclaw v2026.10.0).
 * Shared argv helpers (hardening, resources, mounts, env, labels, naming,
 * mount-source check) are imported from there; the lifecycle, adoption,
 * residue and watch logic is copied because it is entangled with the topology
 * differences below. When merging upstream, diff the two files.
 *
 * What differs from the docker realization:
 * - Session network: `--internal --opt isolate=true --subnet <alloc>`, a /28
 *   carved out of `NANOCLAW_SESSION_POOL` by this driver.
 * - Auxiliary containers: uplink is `NANOCLAW_AUX_UPLINK_NETWORK` (default
 *   `nanogate-svc`), never the default bridge, never `host-gateway`. They are
 *   read-only, have a 16m tmpfs /tmp and their own small resource limits.
 * - The agent joins ONLY the session network.
 * - The topology is verified after create AND on adoption; any mismatch tears
 *   the session down and throws `spec-invalid: topology_mismatch` (fail closed).
 * - Fail-closed spec gate: only `session-container` network targets are
 *   realized (unless `NANOCLAW_ALLOW_UNGATED=1`, dev only).
 * - `imageBuild: false` — images are pre-imported, there is no build daemon.
 *
 * The host process is trusted with the Podman socket (root-equivalent); agents
 * never see it.
 */
import { CONTAINER_TMP_MB } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { logContentEnabled } from '../log-content.js';

import { realCli, validateRuntimeName, type Cli, type SupervisedProcess } from './cli.js';
import {
  agentContainerName,
  assertMountSourcesExist,
  auxiliaryContainerName,
  dockerEventToSessionEvent,
  envArgs,
  hardeningArgs,
  labelArgs,
  mountArgs,
  resourceArgs,
  sessionNetworkName,
  userArgs,
} from './docker-driver.js';
import { registerSessionDriver } from './driver-registry.js';
import { JsonDocumentStream } from './json-stream.js';
import {
  LABELS,
  asFailureError,
  isGatewayOwned,
  labelsForKey,
  specInvalid,
  validateSpec,
  type ContainerSpec,
  type DriverCapabilities,
  type MountPolicy,
  type NetworkAccessIntent,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionFailure,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './types.js';

export const PODMAN_DEFAULT_URL = 'unix:///run/podman/podman.sock';
export const DEFAULT_SESSION_POOL = '10.90.0.0/16';
export const DEFAULT_AUX_UPLINK_NETWORK = 'nanogate-svc';
/** Session networks are /28s: 14 usable addresses, plenty for agent + relay. */
const SESSION_PREFIX = 28;
const SUBNET_CREATE_ATTEMPTS = 8;
/** Auxiliary containers get their own small limits; the agent's are never applied to them. */
export const DEFAULT_AUX_RESOURCES = { memoryMb: 64, cpus: '0.25', pidsLimit: 64 } as const;
const AUX_TMP_MB = 16;

/** Watch reconnection: bounded backoff, never give up (see `watchSessions`). */
const WATCH_RECOVERY_BASE_MS = 1_000;
const WATCH_RECOVERY_MAX_MS = 30_000;

export interface PodmanDriverOptions extends MountPolicy {
  /** The final CLI (prefix included). Tests inject a FakeCli; production uses `podmanCli(url)`. */
  cli?: Cli;
  /** Socket URL, used for the default CLI and for `execSpec`. */
  url?: string;
  sessionPool?: string;
  auxUplinkNetwork?: string;
  /** Dev only: realize specs whose network target is not a session container. */
  allowUngated?: boolean;
  /** Agent /tmp tmpfs cap. */
  tmpfsMb?: number;
  /** systemd slice for every session container (`--cgroup-parent`); default NANOCLAW_CGROUP_PARENT, unset = podman's default. */
  cgroupParent?: string;
}

const CGROUP_PARENT = /^[A-Za-z0-9_.@:-]+\.slice$/;

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  attempt: number;
}

export function podmanRemoteArgs(url: string): string[] {
  return ['--remote', '--url', url];
}

/** Wrap a raw CLI so every invocation carries the `--remote --url` prefix. */
export function prefixedCli(inner: Cli, prefix: string[]): Cli {
  return {
    bin: inner.bin,
    run: (args, opts) => inner.run([...prefix, ...args], opts),
    start: (args, opts) => inner.start([...prefix, ...args], opts),
  };
}

export function podmanCli(url: string = resolvePodmanUrl()): Cli {
  return prefixedCli(realCli('podman'), podmanRemoteArgs(url));
}

export function resolvePodmanUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.NANOCLAW_PODMAN_URL?.trim() ||
    readEnvFile(['NANOCLAW_PODMAN_URL']).NANOCLAW_PODMAN_URL?.trim() ||
    PODMAN_DEFAULT_URL
  );
}

function setting(key: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[key]?.trim() || readEnvFile([key])[key]?.trim() || '';
}

export class PodmanSessionDriver implements SessionDriver {
  readonly kind = 'podman' as const;
  readonly #cli: Cli;
  readonly #policy: MountPolicy;
  readonly #url: string;
  readonly #pool: string;
  readonly #uplink: string;
  readonly #allowUngated: boolean;
  readonly #tmpfsMb: number;
  readonly #cgroupParent: string;
  readonly #watches = new Map<string, InstallWatch>();
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();

  constructor(opts: PodmanDriverOptions) {
    this.#url = opts.url ?? resolvePodmanUrl();
    this.#cli = opts.cli ?? podmanCli(this.#url);
    this.#policy = opts;
    this.#pool = opts.sessionPool ?? (setting('NANOCLAW_SESSION_POOL') || DEFAULT_SESSION_POOL);
    this.#uplink = validateRuntimeName(
      opts.auxUplinkNetwork ?? (setting('NANOCLAW_AUX_UPLINK_NETWORK') || DEFAULT_AUX_UPLINK_NETWORK),
      'network',
    );
    this.#allowUngated = opts.allowUngated ?? setting('NANOCLAW_ALLOW_UNGATED') === '1';
    this.#tmpfsMb = opts.tmpfsMb ?? CONTAINER_TMP_MB;
    this.#cgroupParent = opts.cgroupParent ?? setting('NANOCLAW_CGROUP_PARENT');
    if (this.#cgroupParent && !CGROUP_PARENT.test(this.#cgroupParent)) {
      throw new Error(
        `NANOCLAW_CGROUP_PARENT must be a systemd slice name (e.g. nanoclaw.slice), got ${JSON.stringify(this.#cgroupParent)}`,
      );
    }
    parsePool(this.#pool); // fail at construction on a malformed pool
  }

  capabilities(): DriverCapabilities {
    return {
      isolationTiers: ['container'],
      admissionEnforced: false,
      networkPolicy: 'topology',
      encryptedVolumes: false,
      unrealized: [],
      sharedNetworkNamespace: false,
      auxiliaryContainers: true,
      // Images arrive pre-imported; there is no build daemon on this runtime.
      imageBuild: false,
    };
  }

  async ensureReady(): Promise<void> {
    await assertPodmanHostConfig({ allowUngated: this.#allowUngated });
    const { enforceNanoclawAssets } = await import('../nanoclaw-preflight.js');
    enforceNanoclawAssets();
    ensurePodmanRunning(this.#cli);
  }

  async reconcileNetworkAccess(_access: NetworkAccessIntent): Promise<void> {
    // session-container targets live inside the session network; nothing global to restore.
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    validateSpec(spec, this.#policy, this.capabilities());

    // Fail-closed gate: a session that is not behind a per-session gateway
    // container would need host-level egress this driver does not provide.
    if (spec.networkAccess.target.kind !== 'session-container' && !this.#allowUngated) {
      throw specInvalid('ungated_network_access');
    }

    const extra = spec.containers.filter((c) => c.role !== 'agent');
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = validateRuntimeName(agentContainerName(spec), 'container');
    if (extra.length > 0 && spec.networkAccess.target.kind !== 'session-container') {
      throw specInvalid('a session cannot use both a central gateway network and an auxiliary gateway container');
    }
    const target = spec.networkAccess.target;
    if (target.kind === 'session-container' && !extra.some((c) => c.role === target.role)) {
      throw specInvalid('session-container network target must name an auxiliary container');
    }
    const privateNetwork = extra.length > 0 ? sessionNetworkName(spec) : undefined;
    const auxiliaryNames = extra.map((container) => auxiliaryContainerName(spec, container.role));

    this.#remember(spec.key);

    // Idempotency on key: an existing live container for this key is the session.
    if (this.#existingSession(name, spec.key)) {
      const adopted = new PodmanHandle(
        spec.key,
        name,
        this.#cli,
        null,
        auxiliaryNames,
        privateNetwork,
        this.#emit,
        podmanRemoteArgs(this.#url),
      );
      if (privateNetwork) await this.#verifyOrTeardown(spec, adopted, name, auxiliaryNames, privateNetwork);
      return adopted;
    }

    for (const container of spec.containers) assertMountSourcesExist(container.mounts);

    const created: string[] = [];
    try {
      if (privateNetwork) {
        this.#removeStaleNetwork(privateNetwork);
        this.#createSessionNetwork(spec, privateNetwork);
        for (let i = 0; i < extra.length; i++) {
          const container = extra[i];
          const auxiliaryName = auxiliaryNames[i];
          created.push(auxiliaryName);
          this.#cli.run(this.#auxCreateArgs(spec, container, auxiliaryName));
          const alias =
            target.kind === 'session-container' && target.role === container.role
              ? spec.networkAccess.endpoint
              : container.role;
          this.#cli.run(['network', 'connect', '--alias', alias, privateNetwork, auxiliaryName]);
        }
      }
      created.push(name);
      this.#cli.run(this.#agentCreateArgs(spec, agent, name, privateNetwork));
    } catch (error) {
      for (const createdName of created.reverse()) {
        try {
          this.#cli.run(['rm', '--force', createdName]);
        } catch {
          /* prepare is atomic: allocate all or leave nothing */
        }
      }
      if (privateNetwork) {
        try {
          this.#cli.run(['network', 'rm', privateNetwork]);
        } catch {
          /* prepare is atomic: allocate all or leave nothing */
        }
      }
      throw normalizePodmanError(error);
    }

    const handle = new PodmanHandle(
      spec.key,
      name,
      this.#cli,
      spec,
      auxiliaryNames,
      privateNetwork,
      this.#emit,
      podmanRemoteArgs(this.#url),
    );
    if (privateNetwork) await this.#verifyOrTeardown(spec, handle, name, auxiliaryNames, privateNetwork);
    return handle;
  }

  // ---------- topology ----------

  async #verifyOrTeardown(
    spec: SessionSpec,
    handle: SessionHandle,
    agentName: string,
    auxiliaryNames: string[],
    sessionNet: string,
  ): Promise<void> {
    const problems = verifyTopology(this.#cli, {
      agentName,
      auxiliaryNames,
      auxiliaryRoles: spec.containers.filter((c) => c.role !== 'agent').map((c) => c.role),
      sessionNet,
      uplink: this.#uplink,
      endpoint: spec.networkAccess.endpoint,
      targetRole: spec.networkAccess.target.kind === 'session-container' ? spec.networkAccess.target.role : undefined,
    });
    if (problems.length === 0) return;
    // Metadata only: object names and network names, never env or mounts.
    log.error('Session topology mismatch — failing closed', { containerName: agentName, problems });
    try {
      await handle.stop('topology_mismatch');
    } catch (err) {
      log.error('Topology teardown failed', { containerName: agentName, err });
    }
    throw specInvalid('topology_mismatch');
  }

  /** A leftover network of the same name (no live agent) would turn create into a conflict. */
  #removeStaleNetwork(name: string): void {
    try {
      this.#cli.run(['network', 'exists', name]);
    } catch {
      return; // absent (exit 1) — the normal case
    }
    try {
      this.#cli.run(['network', 'rm', name]);
    } catch {
      /* still attached: the create below fails loudly */
    }
  }

  #createSessionNetwork(spec: SessionSpec, name: string): void {
    const labels = labelArgs(labelsForKey(spec.key, 'session-network', spec.labels));
    let lastError: unknown;
    for (let attempt = 0; attempt < SUBNET_CREATE_ATTEMPTS; attempt++) {
      const subnet = allocateSubnet(this.#pool, this.#usedSubnets());
      try {
        this.#cli.run([
          'network',
          'create',
          '--internal',
          '--opt',
          'isolate=true',
          '--subnet',
          subnet,
          ...labels,
          name,
        ]);
        return;
      } catch (error) {
        lastError = error;
        const msg = error instanceof Error ? error.message : String(error);
        // Only a subnet race is retried: another allocator took the /28 between list and create.
        if (!/subnet|overlap|in use|conflict/i.test(msg) || /name.*(exists|already)/i.test(msg)) throw error;
      }
    }
    throw lastError;
  }

  /** Every subnet any network on this runtime holds — not just ours: an overlap is a conflict regardless of owner. */
  #usedSubnets(): string[] {
    const names = this.#cli
      .run(['network', 'ls', '--format', '{{.Name}}'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((n) => validateRuntimeName(n.trim(), 'network'));
    if (names.length === 0) return [];
    const parsed = JSON.parse(this.#cli.run(['network', 'inspect', ...names]) || '[]') as unknown;
    const out: string[] = [];
    for (const net of Array.isArray(parsed) ? parsed : []) {
      const subnets =
        (net as { subnets?: unknown; Subnets?: unknown }).subnets ?? (net as { Subnets?: unknown }).Subnets;
      for (const s of Array.isArray(subnets) ? subnets : []) {
        const cidr = (s as { subnet?: unknown; Subnet?: unknown }).subnet ?? (s as { Subnet?: unknown }).Subnet;
        if (typeof cidr === 'string') out.push(cidr);
      }
    }
    return out;
  }

  // ---------- create argv ----------

  #agentCreateArgs(
    spec: SessionSpec,
    agent: ContainerSpec,
    name: string,
    privateNetwork: string | undefined,
  ): string[] {
    return createArgs(spec, agent, name, {
      networkArgs: privateNetwork ? ['--network', privateNetwork] : [],
      tmpfs: `/tmp:rw,size=${this.#tmpfsMb}m,mode=1777`,
      readOnly: false,
      resourceSpec: spec,
      cgroupParent: this.#cgroupParent,
    });
  }

  #auxCreateArgs(spec: SessionSpec, container: ContainerSpec, name: string): string[] {
    // The aux container's limits come from its own spec or the small default,
    // never from the agent's session resources.
    const r = container.resources ?? DEFAULT_AUX_RESOURCES;
    const auxSpec: SessionSpec = { ...spec, resources: { memoryMb: r.memoryMb, cpus: r.cpus, pidsLimit: r.pidsLimit } };
    return createArgs(spec, container, name, {
      networkArgs: ['--network', this.#uplink],
      tmpfs: `/tmp:rw,size=${AUX_TMP_MB}m,mode=1777`,
      readOnly: true,
      resourceSpec: auxSpec,
      cgroupParent: this.#cgroupParent,
    });
  }

  // ---------- discovery (copy of docker-driver, podman dialect) ----------

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    let out: string;
    try {
      out = this.#cli.run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        `label=${LABELS.role}=agent`,
        '--format',
        `{{.Names}}|{{.State}}|{{index .Labels "${LABELS.group}"}}|{{index .Labels "${LABELS.session}"}}`,
      ]);
    } catch (error) {
      throw normalizePodmanError(error);
    }
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, state, agentGroupId, sessionId] = line.split('|');
        const key: SessionKey = { installSlug, agentGroupId, sessionId };
        const auxiliaries = auxiliaryContainerNames(this.#cli, key);
        this.#remember(key);
        return {
          handle: new PodmanHandle(
            key,
            name,
            this.#cli,
            null,
            auxiliaries,
            auxiliaries.length > 0 ? sessionNetworkName({ key }) : undefined,
            this.#emit,
            podmanRemoteArgs(this.#url),
          ),
          phase: podmanStatePhase(state),
        };
      });
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), attempt: 0 };
      this.#watches.set(installSlug, watch);
      this.#connectWatch(installSlug, watch);
    }
    watch.subscribers.add(onEvent);
    return {
      stop: () => {
        watch.subscribers.delete(onEvent);
      },
    };
  }

  #connectWatch(installSlug: string, watch: InstallWatch, reconnected = false): void {
    const stream = new JsonDocumentStream();
    const proc = this.#cli.start(
      [
        'events',
        '--filter',
        'type=container',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        '{{json .}}',
      ],
      { captureStdout: true },
    );
    proc.onStdout((chunk) => {
      watch.attempt = 0;
      for (const doc of stream.push(chunk)) {
        const event = podmanEventToSessionEvent(doc, installSlug);
        if (!event) continue;
        for (const subscriber of watch.subscribers) subscriber(event);
      }
    });
    proc.onExit(() => {
      if (this.#watches.get(installSlug) !== watch) return;
      const delay = Math.min(WATCH_RECOVERY_BASE_MS * 2 ** watch.attempt, WATCH_RECOVERY_MAX_MS);
      watch.attempt += 1;
      const timer = setTimeout(() => this.#connectWatch(installSlug, watch, true), delay);
      timer.unref?.();
    });
    if (reconnected) void this.#reconcileWatchGap(installSlug, watch);
  }

  async #reconcileWatchGap(installSlug: string, watch: InstallWatch): Promise<void> {
    if (this.#watches.get(installSlug) !== watch) return;
    let snapshots: SessionSnapshot[];
    try {
      snapshots = await this.listSessions(installSlug);
    } catch {
      return;
    }
    const listed = new Set(snapshots.map((s) => keyId(s.handle.key)));
    const gapKeys = snapshots.filter((s) => s.phase === 'terminal').map((s) => s.handle.key);
    for (const [id, key] of this.#knownKeys.get(installSlug) ?? []) {
      if (!listed.has(id)) gapKeys.push(key);
    }
    for (const key of gapKeys) this.#emit({ key, kind: 'terminal' });
  }

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(keyId(key), key);
  }

  readonly #emit = (event: SessionEvent): void => {
    const watch = this.#watches.get(event.key.installSlug);
    if (!watch) return;
    for (const subscriber of watch.subscribers) subscriber(event);
  };

  async reapResidue(installSlug: string): Promise<void> {
    try {
      const out = this.#cli.run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--filter',
        'status=exited',
        '--filter',
        'status=created',
        '--format',
        `{{.Names}}|{{index .Labels "${LABELS.session}"}}|{{index .Labels "${LABELS.role}"}}`,
      ]);
      const stale = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|'))
        .filter(([, sessionId, role]) => !isGatewayOwned(sessionId, role))
        .map(([name]) => name);
      for (const name of stale) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(name, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (stale.length > 0) log.info('Removed orphaned containers', { count: stale.length, names: stale });
    } catch (err) {
      log.warn('Failed to clean up orphaned containers', { err });
    }

    try {
      const out = this.#cli.run([
        'ps',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        `{{.Names}}|{{index .Labels "${LABELS.session}"}}|{{index .Labels "${LABELS.role}"}}`,
      ]);
      const preSeam = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('|'))
        .filter(([, sessionId, role]) => !sessionId && !isGatewayOwned(sessionId, role))
        .map(([name]) => name);
      for (const name of preSeam) {
        try {
          this.#cli.run(['rm', '--force', validateRuntimeName(name, 'container')]);
        } catch {
          /* already gone */
        }
      }
      if (preSeam.length > 0) log.info('Stopped pre-seam containers', { count: preSeam.length, names: preSeam });
    } catch (err) {
      log.warn('Failed to clean up pre-seam containers', { err });
    }

    let names: string[] = [];
    try {
      const out = this.#cli.run([
        'network',
        'ls',
        '--filter',
        `label=${LABELS.install}=${installSlug}`,
        '--format',
        '{{.Name}}',
      ]);
      names = out.trim().split('\n').filter(Boolean);
    } catch (err) {
      log.warn('Failed to list install-owned networks', { err });
      return;
    }
    const removed: string[] = [];
    for (const name of names) {
      try {
        this.#cli.run(['network', 'rm', validateRuntimeName(name, 'network')]);
        removed.push(name);
      } catch {
        /* still in use by a live session, or already gone */
      }
    }
    if (removed.length > 0) log.info('Removed orphaned networks', { count: removed.length, names: removed });
  }

  #existingSession(name: string, key: SessionKey): boolean {
    let out: string;
    try {
      out = this.#cli.run([
        'inspect',
        '--format',
        `{{index .Config.Labels "${LABELS.install}"}}|{{index .Config.Labels "${LABELS.group}"}}|{{index .Config.Labels "${LABELS.session}"}}`,
        name,
      ]);
    } catch {
      return false;
    }
    const [install, group, session] = out.trim().split('|');
    if (install === key.installSlug && group === key.agentGroupId && session === key.sessionId) return true;
    log.warn('Container name collision: existing container is not this session', {
      containerName: name,
      wanted: key,
      found: { install, group, session },
    });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }
}

class PodmanHandle implements SessionHandle {
  #proc: SupervisedProcess | null = null;
  #stopping = false;
  #attachExitCode: number | null | undefined;
  readonly #stderrTail: string[] = [];

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: Cli,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly pendingSpec: SessionSpec | null,
    private readonly auxiliaryNames: readonly string[],
    private readonly privateNetwork: string | undefined,
    private readonly emit: (event: SessionEvent) => void,
    private readonly remoteArgs: readonly string[],
  ) {}

  async start(): Promise<void> {
    if (this.#proc) return;
    for (const auxiliary of this.auxiliaryNames) {
      try {
        this.cli.run(['start', auxiliary]);
      } catch (error) {
        throw normalizePodmanError(error);
      }
    }
    const proc = this.cli.start(['start', '--attach', this.name]);
    this.#proc = proc;
    proc.onStderr((line) => {
      // NANOCLAW_LOG_CONTENT=0: the runner prints result text / scratchpad to stderr
      if (logContentEnabled()) log.debug(line, { container: this.name });
      else log.debug('container stderr (content hidden)', { container: this.name, chars: line.length });
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 10) this.#stderrTail.shift();
    });
    proc.onExit((code) => {
      this.#attachExitCode = code;
      if (!this.#stopping && code !== 0 && code !== null && this.#stderrTail.length > 0) {
        log.warn('Container exited non-zero', {
          containerName: this.name,
          code,
          stderrTail: logContentEnabled() ? this.#stderrTail : `[${this.#stderrTail.length} lines hidden]`,
        });
      }
      this.emit({ key: this.key, kind: 'terminal' });
    });
  }

  async status(): Promise<SessionStatus> {
    let state: string;
    try {
      state = this.cli.run(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', this.name]).trim();
    } catch {
      if (!this.#stopping && typeof this.#attachExitCode === 'number' && this.#attachExitCode !== 0) {
        return {
          phase: 'failed',
          failure: { kind: 'started-then-died', retryable: false, exitCode: this.#attachExitCode },
        };
      }
      if (!this.#stopping && this.#proc && this.#attachExitCode === undefined) {
        return { phase: 'running' };
      }
      return this.pendingSpec && !this.#proc ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const [status, exit] = state.split('|');
    if (status === 'running') {
      for (const auxiliary of this.auxiliaryNames) {
        try {
          const [auxStatus, auxExit] = this.cli
            .run(['inspect', '--format', '{{.State.Status}}|{{.State.ExitCode}}', auxiliary])
            .trim()
            .split('|');
          if (auxStatus !== 'running') {
            return {
              phase: 'failed',
              failure: {
                kind: 'started-then-died',
                retryable: false,
                ...(auxExit ? { exitCode: Number(auxExit) } : {}),
              },
            };
          }
        } catch {
          return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false } };
        }
      }
      return { phase: 'running' };
    }
    // Podman reports a freshly created container as 'created' (older: 'configured').
    if (status === 'created' || status === 'configured' || status === 'initialized') return { phase: 'ready' };
    if ((status === 'exited' || status === 'stopped') && exit !== '0') {
      return { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: Number(exit) } };
    }
    return { phase: 'stopped' };
  }

  async stop(reason: string): Promise<void> {
    this.#stopping = true;
    log.info('Stopping session container', { containerName: this.name, reason });
    const grace = String(this.pendingSpec?.stopGraceSeconds ?? 1);
    try {
      this.cli.run(['stop', '-t', grace, this.name]);
    } catch {
      this.#proc?.kill();
    }
    try {
      this.cli.run(['rm', '--force', this.name]);
    } catch (error) {
      this.#confirmRemoved(this.name, error);
    }
    for (const auxiliary of [...this.auxiliaryNames].reverse()) {
      try {
        this.cli.run(['stop', '-t', '1', auxiliary]);
      } catch {
        /* already gone */
      }
      try {
        this.cli.run(['rm', '--force', auxiliary]);
      } catch (error) {
        this.#confirmRemoved(auxiliary, error);
      }
    }
    if (this.privateNetwork) {
      try {
        this.cli.run(['network', 'rm', this.privateNetwork]);
      } catch {
        /* already gone or still in use */
      }
    }
  }

  #confirmRemoved(name: string, error: unknown): void {
    try {
      // Podman's name filter is a regex without the docker leading slash.
      const remaining = this.cli.run(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
      if (!remaining.trim()) return;
    } catch (probeError) {
      throw normalizePodmanError(probeError);
    }
    throw normalizePodmanError(error);
  }

  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: 'podman',
      argsTty: [...this.remoteArgs, 'exec', '-it', this.name, ...command],
      argsPlain: [...this.remoteArgs, 'exec', '-i', this.name, ...command],
    };
  }
}

function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

// ---------- create argv ----------

function createArgs(
  spec: SessionSpec,
  container: ContainerSpec,
  name: string,
  opts: { networkArgs: string[]; tmpfs: string; readOnly: boolean; resourceSpec: SessionSpec; cgroupParent?: string },
): string[] {
  const args = ['create', '--rm', '--name', name];
  args.push(...labelArgs(labelsForKey(spec.key, container.role, { ...spec.labels, ...(container.labels ?? {}) })));
  args.push(...resourceArgs(opts.resourceSpec));
  args.push(...hardeningArgs(opts.resourceSpec));
  // No /etc/hosts generated by podman: it would add host.containers.internal, a name for the host's gateway.
  args.push('--no-hosts');
  if (opts.cgroupParent) args.push('--cgroup-parent', opts.cgroupParent);
  // NANOCLAW_LOG_CONTENT=0: stderr carries result text, so conmon must not persist it (journald/k8s-file). `start --attach` still streams it.
  if (!logContentEnabled()) args.push('--log-driver', 'none');
  if (opts.readOnly) args.push('--read-only');
  args.push('--tmpfs', opts.tmpfs);
  args.push(...userArgs(spec));
  args.push(...envArgs(container.env));
  args.push(...envArgs(container.contributedEnv ?? {}));
  args.push(...mountArgs(container.mounts));
  args.push(...opts.networkArgs);
  if (container.command && container.command.length > 0) {
    args.push('--entrypoint', container.command[0]);
    args.push(container.image, ...container.command.slice(1), ...(container.args ?? []));
  } else {
    args.push(container.image, ...(container.args ?? []));
  }
  return args;
}

function auxiliaryContainerNames(cli: Cli, key: SessionKey): string[] {
  try {
    return cli
      .run([
        'ps',
        '-a',
        '--filter',
        `label=${LABELS.install}=${key.installSlug}`,
        '--filter',
        `label=${LABELS.group}=${key.agentGroupId}`,
        '--filter',
        `label=${LABELS.session}=${key.sessionId}`,
        '--format',
        `{{.Names}}|{{index .Labels "${LABELS.role}"}}`,
      ])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('|'))
      .filter(([, role]) => role !== 'agent')
      .map(([name]) => validateRuntimeName(name, 'container'));
  } catch {
    return [];
  }
}

// ---------- subnet allocation ----------

interface Pool {
  base: number;
  prefix: number;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseCidr(cidr: string): Pool | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(cidr.trim());
  if (!m) return null;
  const ip = ipToInt(m[1]);
  const prefix = Number(m[2]);
  if (ip === null || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  return { base: Math.floor(ip / size) * size, prefix };
}

export function parsePool(pool: string): Pool {
  const parsed = parseCidr(pool);
  if (!parsed || parsed.prefix > SESSION_PREFIX) {
    throw new Error(`NANOCLAW_SESSION_POOL must be an IPv4 CIDR no smaller than /${SESSION_PREFIX} (got '${pool}')`);
  }
  return parsed;
}

/** First free /28 of `pool` that overlaps none of `used`. Throws `resources-exhausted` when the pool is full. */
export function allocateSubnet(pool: string, used: readonly string[]): string {
  const { base, prefix } = parsePool(pool);
  const slotSize = 2 ** (32 - SESSION_PREFIX);
  const slots = 2 ** (SESSION_PREFIX - prefix);
  const ranges = used
    .map(parseCidr)
    .filter((p): p is Pool => p !== null)
    .map((p) => [p.base, p.base + 2 ** (32 - p.prefix)] as const);
  for (let i = 0; i < slots; i++) {
    const start = base + i * slotSize;
    const end = start + slotSize;
    if (ranges.every(([s, e]) => end <= s || start >= e)) return `${intToIp(start)}/${SESSION_PREFIX}`;
  }
  throw asFailureError({ kind: 'resources-exhausted', retryable: true });
}

// ---------- topology verification ----------

export interface TopologyExpectation {
  agentName: string;
  auxiliaryNames: readonly string[];
  auxiliaryRoles: readonly string[];
  sessionNet: string;
  uplink: string;
  endpoint: string;
  targetRole: string | undefined;
}

interface InspectDoc {
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> };
  HostConfig?: {
    NetworkMode?: string;
    ExtraHosts?: string[] | null;
    Privileged?: boolean;
    CapAdd?: string[] | null;
  };
}

// Podman 5 reports `bridge` for any container on user-defined bridge networks; the network set is checked separately.
const FORBIDDEN_NETWORK_MODE = /^(host|pasta|slirp|container:|ns:)/i;

/**
 * Inspect the realized objects and return every deviation from the intended
 * topology (empty = verified). An inspect failure is itself a deviation: a
 * topology that cannot be read cannot be trusted.
 */
export function verifyTopology(cli: Cli, expect: TopologyExpectation): string[] {
  const problems: string[] = [];
  const sameSet = (actual: string[], wanted: string[]): boolean =>
    actual.length === wanted.length && wanted.every((w) => actual.includes(w));

  const inspectContainer = (name: string): InspectDoc | null => {
    try {
      const parsed = JSON.parse(cli.run(['inspect', '--type', 'container', name])) as unknown;
      return (Array.isArray(parsed) ? parsed[0] : parsed) as InspectDoc;
    } catch {
      problems.push(`inspect_failed:${name}`);
      return null;
    }
  };
  const checkCommon = (name: string, doc: InspectDoc): void => {
    const mode = doc.HostConfig?.NetworkMode ?? '';
    if (FORBIDDEN_NETWORK_MODE.test(mode)) problems.push(`network_mode:${name}:${mode}`);
    if ((doc.HostConfig?.ExtraHosts ?? []).some((h) => /host-gateway/i.test(h))) problems.push(`host_gateway:${name}`);
    if (doc.HostConfig?.Privileged) problems.push(`privileged:${name}`);
    if ((doc.HostConfig?.CapAdd ?? []).length > 0) problems.push(`cap_add:${name}`);
  };

  const agent = inspectContainer(expect.agentName);
  if (agent) {
    const nets = Object.keys(agent.NetworkSettings?.Networks ?? {});
    if (!sameSet(nets, [expect.sessionNet])) problems.push(`agent_networks:[${nets.join(',')}]`);
    checkCommon(expect.agentName, agent);
  }
  expect.auxiliaryNames.forEach((auxName, i) => {
    const aux = inspectContainer(auxName);
    if (!aux) return;
    const networks = aux.NetworkSettings?.Networks ?? {};
    const nets = Object.keys(networks);
    if (!sameSet(nets, [expect.sessionNet, expect.uplink]))
      problems.push(`aux_networks:${auxName}:[${nets.join(',')}]`);
    if (expect.auxiliaryRoles[i] === expect.targetRole) {
      const aliases = networks[expect.sessionNet]?.Aliases ?? [];
      if (!aliases.includes(expect.endpoint)) problems.push(`endpoint_alias_missing:${auxName}`);
    }
    checkCommon(auxName, aux);
  });

  try {
    const parsed = JSON.parse(cli.run(['network', 'inspect', expect.sessionNet])) as unknown;
    const net = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      internal?: boolean;
      options?: Record<string, string>;
    };
    if (net?.internal !== true) problems.push('session_network_not_internal');
    const isolate = String(net?.options?.isolate ?? '').toLowerCase();
    if (isolate !== 'true' && isolate !== 'strict') problems.push('session_network_not_isolated');
  } catch {
    problems.push(`inspect_failed:${expect.sessionNet}`);
  }
  return problems;
}

// ---------- podman dialect helpers ----------

/** `podman ps` state → seam phase. 'created'/'configured' are prepared-not-started, NOT corpses. */
export function podmanStatePhase(state: string): SessionPhase {
  if (state === 'running' || state === 'paused' || state === 'restarting' || state === 'stopping') return 'running';
  if (state === 'created' || state === 'configured' || state === 'initialized') return 'starting';
  return 'terminal';
}

interface PodmanEventDoc {
  Action?: string;
  Status?: string;
  Attributes?: Record<string, string>;
  Actor?: { Attributes?: Record<string, string> };
}

/** Podman's event verbs differ from docker's: died/remove/cleanup. */
const PODMAN_ACTION_ALIASES: Record<string, string> = {
  died: 'die',
  remove: 'destroy',
  removed: 'destroy',
  cleanup: 'stop',
  init: 'create',
};

/**
 * One `podman events` document → one best-effort hint. Normalizes to docker's
 * event shape (`Action`, `Actor.Attributes`) and reuses its mapping; tolerant
 * of both podman JSON layouts (labels under `Attributes` or `Actor.Attributes`).
 */
export function podmanEventToSessionEvent(doc: unknown, installSlug: string): SessionEvent | null {
  const event = doc as PodmanEventDoc;
  const raw = (event.Action ?? event.Status ?? '').toLowerCase();
  return dockerEventToSessionEvent(
    {
      Action: PODMAN_ACTION_ALIASES[raw] ?? raw,
      Actor: { Attributes: event.Actor?.Attributes ?? event.Attributes ?? {} },
    },
    installSlug,
  );
}

export function normalizePodmanError(error: unknown): Error & SessionFailure {
  if (isSessionFailureError(error)) return error;
  const msg = error instanceof Error ? error.message : String(error);
  const failure: SessionFailure =
    /manifest unknown|pull access denied|not found: manifest|No such image|image not known|unable to pull|initializing source/i.test(
      msg,
    )
      ? { kind: 'image-unavailable', retryable: true }
      : /Cannot connect to (the )?(Docker daemon|Podman)|daemon is not running|unable to connect to Podman|dial unix|connection refused/i.test(
            msg,
          )
        ? { kind: 'runtime-unavailable', retryable: true }
        : /no space left|cannot allocate memory/i.test(msg)
          ? { kind: 'resources-exhausted', retryable: true }
          : { kind: 'unknown', retryable: false, opaqueRef: `podman-${Date.now()}` };
  return asFailureError(failure);
}

function isSessionFailureError(error: unknown): error is Error & SessionFailure {
  return (
    error instanceof Error &&
    typeof (error as { kind?: unknown }).kind === 'string' &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean'
  );
}

export function ensurePodmanRunning(cli: Cli): void {
  try {
    cli.run(['info'], { timeoutMs: 10_000 });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\nFATAL: cannot reach the Podman socket. Agents cannot run without a container runtime.');
    console.error(
      'Check NANOCLAW_PODMAN_URL, that podman.socket is active, and that this user is in the podman group.\n',
    );
    throw new Error('Container runtime is required but failed to start', { cause: err });
  }
}

const TRUTHY_OFF = new Set(['', 'false', '0']);

/**
 * Startup assertion: the podman driver is only safe behind the nanogate
 * provider (every session is a `session-container` via nanogate), and the
 * upstream global egress lockdown must stay off (its network is unused here
 * and would be created as a stray).
 */
export async function assertPodmanHostConfig(
  opts: { allowUngated?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  const env = opts.env ?? process.env;
  const lockdown = setting('NANOCLAW_EGRESS_LOCKDOWN', env).toLowerCase();
  if (!TRUTHY_OFF.has(lockdown)) {
    throw new Error(
      `NANOCLAW_EGRESS_LOCKDOWN='${lockdown}' with the podman driver: refusing to start. ` +
        'Session networks are managed by the podman driver; unset NANOCLAW_EGRESS_LOCKDOWN.',
    );
  }
  if (opts.allowUngated) return;
  const { configuredGatewayProviderKind } = await import('../gateway-providers/index.js');
  const kind = configuredGatewayProviderKind(env);
  if (kind !== 'nanogate') {
    throw new Error(
      `Gateway provider is '${kind}' but the podman driver requires 'nanogate': refusing to start. ` +
        'Set NANOCLAW_GATEWAY_PROVIDER=nanogate (or NANOCLAW_ALLOW_UNGATED=1 for development only).',
    );
  }
}

// Registered here (not in index.ts): `installed.ts` imports this file, and the
// registry lives in its own module for exactly that load-order reason.
registerSessionDriver('podman', (policy) => new PodmanSessionDriver(policy));
