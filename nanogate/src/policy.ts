import { MAX_USES_FAMILIES, type PriceTable, priceFor, serverToolKey } from './pricing.js';
import { parseCidr, parseIp, cidrContains } from './cidr.js';

export interface TailnetAllowEntry {
  /** exact lower-case hostname, "*.suffix" wildcard, or an IP/CIDR */
  host: string;
  cidr: ReturnType<typeof parseCidr>;
  port: number | '*';
}

export interface EgressPolicy {
  route: 'direct' | 'connector';
  fallbackDirect: boolean;
  /** public ports allowed */
  ports: number[];
  /** allow tailnet destinations via the tenant's OWN connector (still needs a tailnetAllow match) */
  tailnet: boolean;
  /** "<cidr|ip|hostname|*.suffix>:<port|*>" */
  tailnetAllow: string[];
  /** tenant whose connector carries this tenant's public route:'connector' traffic (default: self) */
  connectorTenant?: string;
}

export interface TenantPolicy {
  models: string[];
  maxTokens: number;
  allowServiceTiers: string[];
  betas: string[];
  serverTools: string[];
  allowSpeed: boolean;
  egress: EgressPolicy;
  maxConcurrentRequests: number;
  perTurnCapMicros: number | null;
}

const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function parseTailnetAllow(entry: string): TailnetAllowEntry | null {
  const i = entry.lastIndexOf(':');
  if (i <= 0) return null;
  const host = entry.slice(0, i).toLowerCase();
  const p = entry.slice(i + 1);
  let port: number | '*';
  if (p === '*') port = '*';
  else if (/^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535) port = Number(p);
  else return null;
  const cidr = parseIp(host.replace(/\/\d+$/, '')) ? parseCidr(host) : null;
  if (parseIp(host.replace(/\/\d+$/, '')) && !cidr) return null;
  // Names are tailnet names only: MagicDNS FQDNs (*.ts.net, optionally "*.x.ts.net") or single labels. Anything
  // else would never be routed through a connector, so it is a configuration mistake, not an allowlist entry.
  if (!cidr) {
    const name = host.startsWith('*.') ? host.slice(2) : host;
    const label = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;
    const fqdn = name.endsWith('.ts.net') && name.slice(0, -'.ts.net'.length).split('.').every((l) => label.test(l));
    const single = !host.startsWith('*.') && label.test(name);
    if (!fqdn && !single) return null;
  }
  return { host, cidr, port };
}

/** Models Claude Code actually calls: haiku for WebFetch/subagents, sonnet for chat, opus for deep. */
export const DEFAULT_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

/** Validate + fill defaults. Throws Error with a message on bad input. */
export function normalizePolicy(raw: unknown): TenantPolicy {
  const r = (raw ?? {}) as Record<string, unknown>;
  const e = (r.egress ?? {}) as Record<string, unknown>;
  const ports = e.ports ?? [443, 80];
  if (!Array.isArray(ports) || ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error('policy.egress.ports must be ports');
  }
  const allow = e.tailnetAllow ?? [];
  if (!isStrArr(allow)) throw new Error('policy.egress.tailnetAllow must be string[]');
  for (const a of allow) if (!parseTailnetAllow(a)) throw new Error(`policy.egress.tailnetAllow: bad entry ${a}`);
  const route = e.route ?? 'direct';
  if (route !== 'direct' && route !== 'connector') throw new Error('policy.egress.route invalid');
  if (e.connectorTenant !== undefined && (typeof e.connectorTenant !== 'string' || !e.connectorTenant)) {
    throw new Error('policy.egress.connectorTenant must be a tenant id');
  }
  const models = r.models ?? DEFAULT_MODELS;
  const betas = r.betas ?? [];
  const serverTools = r.serverTools ?? [];
  const tiers = r.allowServiceTiers ?? ['standard'];
  if (!isStrArr(models) || !isStrArr(betas) || !isStrArr(serverTools) || !isStrArr(tiers)) {
    throw new Error('policy models/betas/serverTools/allowServiceTiers must be string[]');
  }
  const maxTokens = r.maxTokens ?? 4096;
  const conc = r.maxConcurrentRequests ?? 4;
  const turnCap = r.perTurnCapMicros ?? null;
  if (!Number.isInteger(maxTokens) || (maxTokens as number) < 1) throw new Error('policy.maxTokens invalid');
  if (!Number.isInteger(conc) || (conc as number) < 1) throw new Error('policy.maxConcurrentRequests invalid');
  if (turnCap !== null && (!Number.isInteger(turnCap) || (turnCap as number) < 0)) {
    throw new Error('policy.perTurnCapMicros invalid');
  }
  return {
    models,
    maxTokens: maxTokens as number,
    allowServiceTiers: tiers,
    betas,
    serverTools,
    allowSpeed: r.allowSpeed === true,
    egress: {
      route,
      fallbackDirect: e.fallbackDirect === true,
      ports: ports as number[],
      tailnet: e.tailnet === true,
      tailnetAllow: allow,
      ...(e.connectorTenant ? { connectorTenant: e.connectorTenant as string } : {}),
    },
    maxConcurrentRequests: conc as number,
    perTurnCapMicros: turnCap as number | null,
  };
}

/** Does (host or ip, port) match a tailnetAllow entry? Routes membership is checked by the caller. */
export function tailnetAllowed(policy: TenantPolicy, host: string, ip: ReturnType<typeof parseIp>, port: number): boolean {
  for (const raw of policy.egress.tailnetAllow) {
    const a = parseTailnetAllow(raw)!;
    if (a.port !== '*' && a.port !== port) continue;
    if (ip) {
      if (a.cidr && cidrContains(a.cidr, ip)) return true;
    } else if (!a.cidr) {
      if (a.host === host) return true;
      if (a.host.startsWith('*.') && host.endsWith(a.host.slice(1)) && host.length > a.host.length - 1) return true;
    }
  }
  return false;
}

export interface Rejection {
  status: number;
  type: string;
  message: string;
}

export interface ServerToolLimits {
  /** max_uses injected when the client omits it (or sends junk) */
  defaultMaxUses: number;
  /** ceiling for a client-supplied max_uses */
  maxMaxUses: number;
  /** web_fetch: max_content_tokens injected when absent / ceiling when present (the reservation's per-use allowance) */
  maxFetchContentTokens: number;
}

/** Anthropic-defined tools that the client executes: no server-side cost, no price entry, no policy entry needed. */
const CLIENT_EXECUTED_FAMILIES = ['bash_', 'text_editor_', 'memory_', 'computer_'];

/**
 * Content fetched by Anthropic from a URL / Files API id is billed as input but is not in the request body, so
 * the body-size reservation cannot bound it. Refused outright. Only content-block positions are inspected
 * (message content, system, tool_result.content, document content sources): the arguments of a tool_use are the
 * model's / the client tool's own JSON and may legitimately contain a {source:{type:'url'}} shape.
 */
function hasRemoteSource(v: unknown): boolean {
  const stack: unknown[] = Array.isArray(v) ? [...v] : [];
  while (stack.length) {
    const b = stack.pop() as { type?: unknown; source?: { type?: unknown; content?: unknown }; content?: unknown } | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
    if (b.type === 'container_upload') return true;
    if (b.type === 'tool_result') {
      if (Array.isArray(b.content)) stack.push(...b.content);
    } else if (b.type === 'image' || b.type === 'document') {
      const src = b.source;
      if (!src || typeof src !== 'object') continue;
      if (src.type === 'url' || src.type === 'file') return true;
      if (src.type === 'content' && Array.isArray(src.content)) stack.push(...src.content);
    }
  }
  return false;
}

/** messages[].content and system are the content-block positions. */
function requestHasRemoteSource(out: Record<string, unknown>): boolean {
  if (Array.isArray(out.messages)) {
    for (const m of out.messages) if (hasRemoteSource((m as { content?: unknown } | null)?.content)) return true;
  }
  return hasRemoteSource(out.system);
}

export interface CheckedRequest {
  body: Record<string, unknown>;
  model: string;
  maxTokens: number | null;
  betas: string | undefined;
  droppedBetas: string[];
}

/**
 * Apply tenant policy to a parsed Messages request. Returns the (possibly rewritten) body and the
 * filtered anthropic-beta header, or a rejection.
 */
export function checkRequest(
  policy: TenantPolicy,
  prices: PriceTable,
  defaultBetas: string[],
  body: Record<string, unknown>,
  betaHeader: string | undefined,
  needMaxTokens: boolean,
  toolLimits: ServerToolLimits = { defaultMaxUses: 5, maxMaxUses: 10, maxFetchContentTokens: 25_000 },
): CheckedRequest | Rejection {
  const model = body.model;
  if (typeof model !== 'string' || !policy.models.includes(model) || !priceFor(prices, model)) {
    return { status: 400, type: 'invalid_request_error', message: 'model_not_allowed' };
  }
  const out: Record<string, unknown> = { ...body };
  let maxTokens: number | null = null;
  if (needMaxTokens) {
    const mt = out.max_tokens;
    if (typeof mt !== 'number' || !Number.isInteger(mt) || mt < 1) {
      return { status: 400, type: 'invalid_request_error', message: 'max_tokens must be a positive integer' };
    }
    maxTokens = Math.min(mt, policy.maxTokens);
    out.max_tokens = maxTokens;
  }
  // Request values are "auto" | "standard_only". Priority capacity needs an explicit grant
  // ("priority"/"auto" in allowServiceTiers); otherwise always pin to standard, even if the client omitted it.
  const mayPriority = policy.allowServiceTiers.includes('priority') || policy.allowServiceTiers.includes('auto');
  if (!mayPriority) out.service_tier = 'standard_only';
  if (!policy.allowSpeed) delete out.speed;

  if (requestHasRemoteSource(out)) {
    return { status: 400, type: 'invalid_request_error', message: 'remote_source_not_allowed: use base64 sources' };
  }

  if (out.tools !== undefined) {
    if (!Array.isArray(out.tools)) return { status: 400, type: 'invalid_request_error', message: 'tools must be an array' };
    const tools: unknown[] = [];
    for (const t of out.tools) {
      const type = (t as { type?: unknown } | null)?.type;
      if (type === undefined || type === 'custom' || (typeof type === 'string' && CLIENT_EXECUTED_FAMILIES.some((f) => type.startsWith(f)))) {
        tools.push(t);
        continue;
      }
      if (typeof type !== 'string' || !policy.serverTools.some((p) => type.startsWith(p))) {
        return { status: 400, type: 'invalid_request_error', message: 'tool_not_allowed' };
      }
      // Fail closed: a tool with no price would reserve and cost 0.
      if (!serverToolKey(prices, type)) {
        return { status: 400, type: 'invalid_request_error', message: `server_tool_unpriced: ${type}` };
      }
      // max_uses (and for web_fetch max_content_tokens) bound both the reservation and what Anthropic can bill:
      // inject, clamp. Only the families whose schema has the field get it.
      if (needMaxTokens && MAX_USES_FAMILIES.some((f) => type.startsWith(f))) {
        const nt: Record<string, unknown> = { ...(t as object) };
        const mu = nt.max_uses;
        nt.max_uses = typeof mu === 'number' && Number.isInteger(mu) && mu >= 1 ? Math.min(mu, toolLimits.maxMaxUses) : toolLimits.defaultMaxUses;
        if (type.startsWith('web_fetch')) {
          const mc = nt.max_content_tokens;
          nt.max_content_tokens = typeof mc === 'number' && Number.isInteger(mc) && mc >= 1 ? Math.min(mc, toolLimits.maxFetchContentTokens) : toolLimits.maxFetchContentTokens;
        }
        tools.push(nt);
      } else {
        // The schema of every other server tool has no max_uses: a client value is never trusted for them. Refuse.
        if (!MAX_USES_FAMILIES.some((f) => type.startsWith(f)) && (t as { max_uses?: unknown }).max_uses !== undefined) {
          return { status: 400, type: 'invalid_request_error', message: `max_uses_not_supported: ${type}` };
        }
        tools.push(t);
      }
    }
    out.tools = tools;
  }

  const allowed = new Set([...policy.betas, ...defaultBetas]);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const b of (betaHeader ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    (allowed.has(b) ? kept : dropped).push(b);
  }
  return { body: out, model, maxTokens, betas: kept.length ? kept.join(',') : undefined, droppedBetas: dropped };
}

export function isRejection(x: CheckedRequest | Rejection): x is Rejection {
  return 'status' in x;
}

