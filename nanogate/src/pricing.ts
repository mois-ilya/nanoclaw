// Cost computation. This file contains NO prices: the table comes from config.

export interface BasePrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

export interface ModelPrice extends BasePrice {
  /**
   * Prompt-length tier (e.g. Claude Haiku 5.5): a request whose prompt (input + cache reads + cache writes) is over
   * `aboveTokens` pays these prices for all of its tokens instead.
   */
  longContext?: { aboveTokens: number } & BasePrice;
}

export interface PriceTable {
  version: string;
  models: Record<string, ModelPrice>;
  /** USD per use, keyed by server-tool name (web_search, web_fetch, ...). */
  serverTools: Record<string, number>;
}

export interface Usage {
  input: number;
  output: number;
  cacheCreation5m: number;
  cacheCreation1h: number;
  cacheRead: number;
  /** tool name -> number of uses */
  serverTools: Record<string, number>;
  serviceTier: string | null;
}

const PRICE_KEYS: (keyof BasePrice)[] = ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'];

/** Throws on a malformed table. A zero price is valid (the table is filled at deploy time). */
export function validatePrices(t: unknown): PriceTable {
  const o = t as PriceTable;
  if (!o || typeof o.version !== 'string' || !o.version) throw new Error('prices.version required');
  if (!o.models || typeof o.models !== 'object') throw new Error('prices.models required');
  for (const [name, p] of Object.entries(o.models)) {
    for (const k of PRICE_KEYS) {
      if (typeof p?.[k] !== 'number' || !Number.isFinite(p[k]) || p[k] < 0) {
        throw new Error(`prices.models.${name}.${k} must be a non-negative number`);
      }
    }
    if (p.longContext !== undefined) {
      const lc = p.longContext;
      if (!lc || typeof lc.aboveTokens !== 'number' || !Number.isInteger(lc.aboveTokens) || lc.aboveTokens <= 0) {
        throw new Error(`prices.models.${name}.longContext.aboveTokens must be a positive integer`);
      }
      for (const k of PRICE_KEYS) {
        if (typeof lc[k] !== 'number' || !Number.isFinite(lc[k]) || lc[k] < 0) {
          throw new Error(`prices.models.${name}.longContext.${k} must be a non-negative number`);
        }
      }
    }
  }
  const st = o.serverTools ?? {};
  for (const [name, v] of Object.entries(st)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`prices.serverTools.${name} invalid`);
  }
  return { version: o.version, models: o.models, serverTools: st };
}

export function priceFor(t: PriceTable, model: string): ModelPrice | null {
  return Object.prototype.hasOwnProperty.call(t.models, model) ? t.models[model]! : null;
}

/** USD per million tokens == micro-USD per token, so tokens * price is already in micros. */
export function serverToolMicros(t: PriceTable, name: string): number {
  // Usage names ("web_search") map to price keys with the same prefix rule as request types ("web_search_2025..."),
  // in either direction, so a versioned price key still settles what the reservation counted.
  const key = Object.prototype.hasOwnProperty.call(t.serverTools, name)
    ? name
    : Object.keys(t.serverTools).find((k) => name.startsWith(k) || k.startsWith(name));
  return (key === undefined ? 0 : t.serverTools[key]!) * 1_000_000;
}

export function costMicros(t: PriceTable, model: string, u: Usage): number {
  const base = priceFor(t, model);
  if (!base) return 0;
  const prompt = u.input + u.cacheRead + u.cacheCreation5m + u.cacheCreation1h;
  const p: BasePrice = base.longContext && prompt > base.longContext.aboveTokens ? base.longContext : base;
  let c =
    u.input * p.input +
    u.output * p.output +
    u.cacheCreation5m * p.cacheWrite5m +
    u.cacheCreation1h * p.cacheWrite1h +
    u.cacheRead * p.cacheRead;
  for (const [name, n] of Object.entries(u.serverTools)) c += n * serverToolMicros(t, name);
  return Math.ceil(c);
}

/** Worst-case cost of a request, used for the budget reservation. */
export function reserveMicros(
  t: PriceTable,
  model: string,
  maxTokens: number,
  bodyBytes: number,
  serverToolCap: number,
  media: MediaEstimate = { bytes: 0, tokens: 0 },
): number {
  const r = reserveParts(t, model, bodyBytes, serverToolCap, media);
  return Math.ceil(r.base + r.perToken * maxTokens);
}

/** The reserve split into what does not depend on max_tokens (input, server tools) and the price per output token. */
export function reserveParts(
  t: PriceTable,
  model: string,
  bodyBytes: number,
  serverToolCap: number,
  media: MediaEstimate = { bytes: 0, tokens: 0 },
): { base: number; perToken: number } {
  const base0 = priceFor(t, model);
  if (!base0) return { base: 0, perToken: 0 };
  // The bytes/2 estimate already overshoots real prompt length, so a prompt near the threshold reserves at the
  // long-context prices (worst case); settlement prices the real usage.
  const p0 = base0;
  // bytes/2: JSON, code and non-Latin text tokenise far denser than the usual ~4 bytes per token.
  // Base64 media is billed by pixels / pages, not by size: its bytes are replaced by a per-item ceiling.
  const estInput = Math.ceil(Math.max(0, bodyBytes - media.bytes) / 2) + media.tokens;
  const p: BasePrice = p0.longContext && estInput > p0.longContext.aboveTokens ? p0.longContext : p0;
  // Input may be billed as a cache write, which costs more than plain input: reserve the dearest rate.
  const inRate = Math.max(p.input, p.cacheWrite5m, p.cacheWrite1h);
  return { base: inRate * estInput + serverToolCap, perToken: p.output };
}

/** Tool families whose schema takes max_uses (checkRequest injects / clamps it). Every other server tool ignores a client max_uses here. */
export const MAX_USES_FAMILIES = ['web_search', 'web_fetch'];

/** Per-item reservation ceilings for base64 media (billed by pixels / pages, so size says little). */
export const IMAGE_TOKEN_CEILING = 4800;
export const PDF_PAGE_TOKENS = 3000;
export const PDF_MAX_PAGES = 600;
const PDF_MIN_BYTES_PER_PAGE = 50;

export interface MediaEstimate {
  /** base64 payload characters that the ceilings replace in the bytes/2 estimate */
  bytes: number;
  /** token ceiling for all images / PDF pages */
  tokens: number;
}

/** Pages of a base64 PDF: counted from /Type /Page objects; when that is unreliable, bounded by size and the page limit. */
function pdfPages(b64: string): number {
  const bytes = Math.floor((b64.length * 3) / 4);
  const bySize = Math.min(PDF_MAX_PAGES, Math.max(1, Math.ceil(bytes / PDF_MIN_BYTES_PER_PAGE)));
  let text: string;
  try {
    text = Buffer.from(b64, 'base64').toString('latin1');
  } catch {
    return bySize;
  }
  const counted = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  // Compressed object streams hide page objects from a byte scan: fall back to the size bound.
  if (counted === 0 || text.includes('/ObjStm')) return Math.max(counted, bySize);
  return Math.min(PDF_MAX_PAGES, counted);
}

/** Walk content blocks (message content, system, tool_result.content, document content sources); never tool inputs. */
export function mediaEstimate(body: Record<string, unknown>): MediaEstimate {
  const out: MediaEstimate = { bytes: 0, tokens: 0 };
  const stack: unknown[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) for (const b of v) stack.push(b);
  };
  if (Array.isArray(body.messages)) for (const m of body.messages) push((m as { content?: unknown } | null)?.content);
  push(body.system);
  while (stack.length) {
    const b = stack.pop() as { type?: unknown; source?: { type?: unknown; data?: unknown; media_type?: unknown; content?: unknown }; content?: unknown } | null;
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'tool_result') push(b.content);
    else if (b.type === 'image' || b.type === 'document') {
      const src = b.source;
      if (src?.type === 'content') push(src.content);
      else if (src?.type === 'base64' && typeof src.data === 'string') {
        out.bytes += src.data.length;
        if (b.type === 'image') out.tokens += IMAGE_TOKEN_CEILING;
        else if (src.media_type === 'application/pdf') out.tokens += pdfPages(src.data) * PDF_PAGE_TOKENS;
        else out.bytes -= src.data.length; // other documents (text/plain base64): plain bytes/2 applies
      }
    }
  }
  return out;
}

/** Key of prices.serverTools that a request tool type belongs to (prefix match), or undefined if unpriced. */
export function serverToolKey(t: PriceTable, type: string): string | undefined {
  return Object.keys(t.serverTools).find((k) => type.startsWith(k));
}

/**
 * Cap on server-tool spend: sum(uses) * (unit price + per-use result input allowance), for each tool in the request.
 * Only the MAX_USES_FAMILIES have a client max_uses that checkRequest has clamped; it is honoured there. Any other
 * priced server tool ignores max_uses and reserves `worstUses` (the server loop's iteration allowance, not a client
 * value). Results (search hits, fetched pages) are billed as input tokens that are not in the request body, so each
 * use reserves `resultInputTokens` at the model's dearest input rate.
 */
export function serverToolCapMicros(t: PriceTable, tools: unknown, model?: string, resultInputTokens = 0, defaultUses = 10, worstUses = defaultUses): number {
  if (!Array.isArray(tools)) return 0;
  const p = model ? priceFor(t, model) : null;
  const inRate = p ? Math.max(p.input, p.cacheWrite5m, p.cacheWrite1h) : 0;
  let cap = 0;
  for (const tool of tools) {
    const type = (tool as { type?: unknown })?.type;
    if (typeof type !== 'string') continue;
    const key = serverToolKey(t, type);
    if (!key) continue;
    let uses = Math.max(defaultUses, worstUses);
    if (MAX_USES_FAMILIES.some((f) => type.startsWith(f))) {
      const mu = (tool as { max_uses?: unknown }).max_uses;
      uses = typeof mu === 'number' && Number.isInteger(mu) && mu > 0 ? Math.min(mu, worstUses) : defaultUses;
    }
    cap += uses * (serverToolMicros(t, key) + resultInputTokens * inRate);
  }
  return Math.ceil(cap);
}
