// Tee-parser for Anthropic SSE streams: extracts usage only, never retains content.
// Field names (docs: Messages streaming):
//   message_start.message.usage: input_tokens, output_tokens, cache_creation_input_tokens,
//     cache_read_input_tokens, [cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens], [service_tier]
//   message_delta.usage: cumulative output_tokens (+ input/cache totals), server_tool_use.{web_search_requests,...}
import { StringDecoder } from 'node:string_decoder';
import type { Usage } from './pricing.js';

export const MAX_EVENT_BYTES = 1024 * 1024;

type Raw = Record<string, unknown> | undefined | null;

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

/**
 * Merge usage objects, later ones override earlier ones field by field (message_delta carries
 * cumulative totals and wins over message_start). Cache creation without the 5m/1h split is priced as 5m.
 */
export function normalizeUsage(...parts: Raw[]): Usage {
  const u: Usage = {
    input: 0,
    output: 0,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheRead: 0,
    serverTools: {},
    serviceTier: null,
  };
  let flat: number | undefined;
  for (const p of parts) {
    if (!p) continue;
    u.input = num(p.input_tokens) ?? u.input;
    u.output = num(p.output_tokens) ?? u.output;
    u.cacheRead = num(p.cache_read_input_tokens) ?? u.cacheRead;
    flat = num(p.cache_creation_input_tokens) ?? flat;
    const cc = p.cache_creation as Record<string, unknown> | null | undefined;
    if (cc && typeof cc === 'object') {
      u.cacheCreation5m = num(cc.ephemeral_5m_input_tokens) ?? u.cacheCreation5m;
      u.cacheCreation1h = num(cc.ephemeral_1h_input_tokens) ?? u.cacheCreation1h;
    }
    const st = p.server_tool_use as Record<string, unknown> | null | undefined;
    if (st && typeof st === 'object') {
      for (const [k, v] of Object.entries(st)) {
        const n = num(v);
        if (n !== undefined) u.serverTools[k.replace(/_requests$/, '')] = n;
      }
    }
    if (typeof p.service_tier === 'string') u.serviceTier = p.service_tier;
  }
  if (u.cacheCreation5m + u.cacheCreation1h === 0 && flat) u.cacheCreation5m = flat;
  return u;
}

export class SseUsageParser {
  private readonly decoder = new StringDecoder('utf8');
  private buf = '';
  private skipping = false;
  private start: Raw;
  private delta: Raw;
  sawStart = false;
  sawDelta = false;
  sawError = false;

  feed(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    let s = this.buf + text;
    let nl: number;
    while ((nl = s.indexOf('\n')) >= 0) {
      const line = s.slice(0, nl);
      s = s.slice(nl + 1);
      if (this.skipping) this.skipping = false;
      else this.line(line);
    }
    if (s.length > MAX_EVENT_BYTES) {
      // Oversized event: drop it, resync at the next newline.
      s = '';
      this.skipping = true;
    }
    this.buf = s;
  }

  private line(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trimStart();
    if (!data.includes('message_start') && !data.includes('message_delta') && !data.includes('"error"')) return;
    let ev: { type?: string; message?: { usage?: Raw }; usage?: Raw };
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === 'message_start') {
      this.start = ev.message?.usage;
      this.sawStart = true;
    }
    else if (ev.type === 'message_delta') {
      this.delta = { ...(this.delta ?? {}), ...(ev.usage ?? {}) };
      this.sawDelta = true;
    } else if (ev.type === 'error') this.sawError = true;
  }

  /** Usage as seen so far; only trustworthy for billing when `sawDelta` is true. */
  usage(): Usage {
    return normalizeUsage(this.start, this.delta);
  }
}
