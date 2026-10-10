import fs from 'node:fs';
import { type PriceTable, validatePrices } from './pricing.js';
import { parseCidr } from './cidr.js';

export interface Config {
  anthropicKeyFile: string;
  upstream: string;
  stateDir: string;
  encryptionKeyFile: string;
  prices: PriceTable;
  denyCidrs: string[];
  hostAddresses: string[];
  /** Per budget period (UTC month), all tenants together. null = no global cap. */
  globalCapUsdMicros: number | null;
  connectLimits: {
    maxTunnelsPerTenant: number; maxTunnelsGlobal: number; maxTunnelSeconds: number; maxBytesPerTunnel: number; idleSeconds: number;
    /** concurrent DNS lookups: per tenant, and for the whole process. The default resolver is c-ares (no libuv pool threads). */
    dnsPerTenant: number; dnsGlobal: number; dnsTimeoutMs: number;
    /** lookups allowed to WAIT for a slot: per tenant (429 when full) and process-wide (503). Wait counts toward dnsTimeoutMs. */
    dnsQueuePerTenant: number; dnsQueueGlobal: number;
  };
  anthropicLimits: {
    /** whole request body must arrive within this */
    bodyTimeoutMs: number;
    /** bytes of request bodies held in memory at once, all tenants (counted as they arrive) */
    maxInflightBodyBytes: number;
    /** same, per tenant: one tenant cannot fill the global cap */
    maxInflightBodyBytesPerTenant: number;
    /** a client socket idle this long is destroyed (backstop for drained / stalled connections) */
    socketIdleMs: number;
    /** open connections per listener (anthropic session + host servers) */
    maxConnections: number;
    /** upstream must send response headers within this */
    upstreamHeadersTimeoutMs: number;
    upstreamNonStreamTimeoutMs: number;
    /** an upstream response silent for this long is aborted */
    streamIdleMs: number;
    /** window of the per-session spend cap (policy.perTurnCapMicros) */
    capWindowMinutes: number;
    /** server tools: max_uses injected when absent / ceiling when present */
    serverToolDefaultMaxUses: number;
    serverToolMaxUses: number;
    /** input tokens reserved per allowed server-tool use (search/fetch results are billed as input) */
    serverToolResultInputTokens: number;
    /** max_tokens is never clamped below this to fit a nearly spent budget (the request is refused instead) */
    minOutputTokens: number;
  };
  /** Hosts (and their subdomains) the CONNECT proxy never reaches: the model API goes through /anthropic only. */
  modelHosts: string[];
  /** anthropic-beta values every tenant may use in addition to its own policy.betas. */
  defaultBetas: string[];
  /** TEST ONLY: built-in deny CIDRs to remove (e.g. "127.0.0.0/8" to reach local echo servers). */
  disableBuiltinDeny: string[];
  socksTimeoutMs: number;
  listen: { bind: string; hostBind: string; anthropicPort: number; connectPort: number; hostPort: number; adminSocket: string };
}

type Json = Record<string, unknown>;

const str = (v: unknown, name: string, def?: string): string => {
  if (v === undefined && def !== undefined) return def;
  if (typeof v !== 'string' || !v) throw new Error(`config.${name} must be a non-empty string`);
  return v;
};
const strArr = (v: unknown, name: string, def: string[]): string[] => {
  if (v === undefined) return def;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Error(`config.${name} must be string[]`);
  return v as string[];
};
const int = (v: unknown, name: string, def: number): number => {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`config.${name} must be a non-negative integer`);
  return v;
};

export function validateConfig(raw: unknown): Config {
  if (!raw || typeof raw !== 'object') throw new Error('config must be an object');
  const r = raw as Json;
  const cl = (r.connectLimits ?? {}) as Json;
  const ls = (r.listen ?? {}) as Json;
  const al = (r.anthropicLimits ?? {}) as Json;
  const cfg: Config = {
    anthropicKeyFile: str(r.anthropicKeyFile, 'anthropicKeyFile'),
    upstream: str(r.upstream, 'upstream', 'https://api.anthropic.com').replace(/\/+$/, ''),
    stateDir: str(r.stateDir, 'stateDir'),
    encryptionKeyFile: str(r.encryptionKeyFile, 'encryptionKeyFile'),
    prices: validatePrices(r.prices),
    denyCidrs: strArr(r.denyCidrs, 'denyCidrs', []),
    hostAddresses: strArr(r.hostAddresses, 'hostAddresses', []),
    globalCapUsdMicros: r.globalCapUsdMicros == null ? null : int(r.globalCapUsdMicros, 'globalCapUsdMicros', 0),
    connectLimits: {
      maxTunnelsPerTenant: int(cl.maxTunnelsPerTenant, 'connectLimits.maxTunnelsPerTenant', 64),
      maxTunnelsGlobal: int(cl.maxTunnelsGlobal, 'connectLimits.maxTunnelsGlobal', 256),
      maxTunnelSeconds: int(cl.maxTunnelSeconds, 'connectLimits.maxTunnelSeconds', 3600),
      maxBytesPerTunnel: int(cl.maxBytesPerTunnel, 'connectLimits.maxBytesPerTunnel', 2147483648),
      idleSeconds: int(cl.idleSeconds, 'connectLimits.idleSeconds', 300),
      dnsPerTenant: int(cl.dnsPerTenant, 'connectLimits.dnsPerTenant', 4),
      dnsGlobal: int(cl.dnsGlobal, 'connectLimits.dnsGlobal', 16),
      dnsTimeoutMs: int(cl.dnsTimeoutMs, 'connectLimits.dnsTimeoutMs', 5_000),
      dnsQueuePerTenant: int(cl.dnsQueuePerTenant, 'connectLimits.dnsQueuePerTenant', 64),
      dnsQueueGlobal: int(cl.dnsQueueGlobal, 'connectLimits.dnsQueueGlobal', 512),
    },
    anthropicLimits: {
      bodyTimeoutMs: int(al.bodyTimeoutMs, 'anthropicLimits.bodyTimeoutMs', 60_000),
      maxInflightBodyBytes: int(al.maxInflightBodyBytes, 'anthropicLimits.maxInflightBodyBytes', 160 * 1024 * 1024),
      maxInflightBodyBytesPerTenant: int(al.maxInflightBodyBytesPerTenant, 'anthropicLimits.maxInflightBodyBytesPerTenant', Math.min(128 * 1024 * 1024, int(al.maxInflightBodyBytes, 'anthropicLimits.maxInflightBodyBytes', 160 * 1024 * 1024))),
      socketIdleMs: int(al.socketIdleMs, 'anthropicLimits.socketIdleMs', 600_000),
      maxConnections: int(al.maxConnections, 'anthropicLimits.maxConnections', 2048),
      upstreamHeadersTimeoutMs: int(al.upstreamHeadersTimeoutMs, 'anthropicLimits.upstreamHeadersTimeoutMs', 120_000),
      upstreamNonStreamTimeoutMs: int(al.upstreamNonStreamTimeoutMs, 'anthropicLimits.upstreamNonStreamTimeoutMs', 600_000),
      streamIdleMs: int(al.streamIdleMs, 'anthropicLimits.streamIdleMs', 300_000),
      capWindowMinutes: int(al.capWindowMinutes, 'anthropicLimits.capWindowMinutes', 15),
      serverToolDefaultMaxUses: int(al.serverToolDefaultMaxUses, 'anthropicLimits.serverToolDefaultMaxUses', 5),
      serverToolMaxUses: int(al.serverToolMaxUses, 'anthropicLimits.serverToolMaxUses', 10),
      serverToolResultInputTokens: int(al.serverToolResultInputTokens, 'anthropicLimits.serverToolResultInputTokens', 25_000),
      minOutputTokens: int(al.minOutputTokens, 'anthropicLimits.minOutputTokens', 1024),
    },
    modelHosts: strArr(r.modelHosts, 'modelHosts', ['anthropic.com']).map((h) => h.toLowerCase()),
    defaultBetas: strArr(r.defaultBetas, 'defaultBetas', [
      'claude-code-20250219',
      'interleaved-thinking-2025-05-14',
      'fine-grained-tool-streaming-2025-05-14',
      'context-management-2025-06-27',
    ]),
    disableBuiltinDeny: strArr(r.disableBuiltinDeny, 'disableBuiltinDeny', []),
    socksTimeoutMs: int(r.socksTimeoutMs, 'socksTimeoutMs', 10_000),
    listen: {
      bind: str(ls.bind, 'listen.bind', '0.0.0.0'),
      // Host-caller listener: loopback by default; inside a container it must be
      // 0.0.0.0 so the published 127.0.0.1:<port> mapping can reach it.
      hostBind: str(ls.hostBind, 'listen.hostBind', '127.0.0.1'),
      anthropicPort: int(ls.anthropicPort, 'listen.anthropicPort', 8080),
      connectPort: int(ls.connectPort, 'listen.connectPort', 3128),
      hostPort: int(ls.hostPort, 'listen.hostPort', 8090),
      adminSocket: str(ls.adminSocket, 'listen.adminSocket', '/run/nanogate/admin.sock'),
    },
  };
  for (const c of [...cfg.denyCidrs, ...cfg.hostAddresses, ...cfg.disableBuiltinDeny]) {
    if (!parseCidr(c)) throw new Error(`config: invalid CIDR/IP ${c}`);
  }
  const a = cfg.anthropicLimits;
  if (a.serverToolDefaultMaxUses < 1 || a.serverToolMaxUses < a.serverToolDefaultMaxUses) {
    throw new Error('config.anthropicLimits: need 1 <= serverToolDefaultMaxUses <= serverToolMaxUses');
  }
  if (a.capWindowMinutes < 1) throw new Error('config.anthropicLimits.capWindowMinutes must be >= 1');
  if (cfg.connectLimits.dnsPerTenant < 1 || cfg.connectLimits.dnsGlobal < 1) throw new Error('config.connectLimits dns caps must be >= 1');
  if (cfg.connectLimits.dnsPerTenant >= cfg.connectLimits.dnsGlobal) {
    throw new Error('config.connectLimits: dnsPerTenant must be < dnsGlobal (one tenant must not be able to fill the resolver)');
  }
  if (a.maxInflightBodyBytesPerTenant < 1 || a.maxInflightBodyBytesPerTenant > a.maxInflightBodyBytes) {
    throw new Error('config.anthropicLimits: need 1 <= maxInflightBodyBytesPerTenant <= maxInflightBodyBytes');
  }
  new URL(cfg.upstream);
  return cfg;
}

/** Read the JSON config file, then apply env overrides (NANOGATE_ADMIN_SOCKET, NANOGATE_BIND, *_PORT). */
export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Config {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8')) as Json;
  const listen = { ...((raw.listen as Json) ?? {}) };
  if (env.NANOGATE_ADMIN_SOCKET) listen.adminSocket = env.NANOGATE_ADMIN_SOCKET;
  if (env.NANOGATE_BIND) listen.bind = env.NANOGATE_BIND;
  if (env.NANOGATE_ANTHROPIC_PORT) listen.anthropicPort = Number(env.NANOGATE_ANTHROPIC_PORT);
  if (env.NANOGATE_CONNECT_PORT) listen.connectPort = Number(env.NANOGATE_CONNECT_PORT);
  if (env.NANOGATE_HOST_PORT) listen.hostPort = Number(env.NANOGATE_HOST_PORT);
  return validateConfig({ ...raw, listen });
}

export function readApiKey(file: string): string {
  // The old install stored this secret as an env line (`ANTHROPIC_API_KEY=...`): accept it as well as the raw key.
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.trim()) ?? '';
  const k = line.trim().replace(/^(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*/, '').replace(/^(["'])(.*)\1$/, '$2').trim();
  if (!k) throw new Error('anthropic key file is empty');
  return k;
}
