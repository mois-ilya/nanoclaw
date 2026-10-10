import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import type { Ctx } from './context.js';
import { reserveBudget, settle } from './budget.js';
import { checkRequest, isRejection } from './policy.js';
import { costMicros, mediaEstimate, reserveParts, serverToolCapMicros } from './pricing.js';
import { SseUsageParser, normalizeUsage } from './sse-usage.js';
import type { LiveEntry } from './live.js';
import { type TokenKind, authenticate, revalidate } from './tokens.js';

export const MAX_BODY_BYTES = 32 * 1024 * 1024;
/** transient memory of one request being processed, in multiples of its raw body (accounted on top of the raw bytes) */
const PROCESSING_FACTOR = 3;
const OUT_SLACK_BYTES = 64 * 1024;
const MAX_JSON_RESPONSE_BYTES = 16 * 1024 * 1024;

const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection']);

/** Reply and close the connection: used wherever the request body has not been (fully) consumed. */
export function sendErrorClose(res: http.ServerResponse, req: http.IncomingMessage, status: number, type: string, message: string): void {
  if (!res.headersSent) res.setHeader('connection', 'close');
  res.once('finish', () => req.socket.destroy());
  res.once('close', () => req.socket.destroy());
  sendError(res, status, type, message);
}

export function sendError(res: http.ServerResponse, status: number, type: string, message: string, extra?: Record<string, unknown>, headers?: Record<string, string>): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'error', error: { type, message, ...extra } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
  res.end(body);
}

/** Concurrent requests per tenant for host-token callers, outside the tenant's own maxConcurrentRequests. */
const HOST_MAX_CONCURRENT = 2;

class TooLarge extends Error {}
class BodyTimeout extends Error {}
class Busy extends Error {}

interface BodyOpts {
  timeoutMs: number;
  /** account `n` more body bytes against the per-tenant and process-wide caps; false = a cap is reached */
  take(n: number): boolean;
  signal: AbortSignal;
}

function readBody(req: http.IncomingMessage, limit: number, o: BodyOpts): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'] === undefined ? NaN : Number(req.headers['content-length']);
    const hasLen = Number.isFinite(declared) && declared >= 0;
    if (hasLen && declared > limit) return reject(new TooLarge());
    // Bytes are accounted as they arrive, never from the declared length: a client that declares 32 MiB and
    // sends nothing reserves nothing (its slot is bounded by maxConcurrentRequests and the body timeout).
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    const end = (err?: Error, buf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      o.signal.removeEventListener('abort', onAbort);
      req.pause();
      if (err) reject(err);
      else resolve(buf!);
    };
    const onAbort = () => end(new Error('aborted'));
    const timer = setTimeout(() => end(new BodyTimeout()), o.timeoutMs);
    o.signal.addEventListener('abort', onAbort, { once: true });
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) return end(new TooLarge());
      if (!o.take(c.length)) return end(new Busy());
      chunks.push(c);
    });
    req.on('end', () => end(undefined, Buffer.concat(chunks)));
    req.on('error', (e) => end(e));
    req.on('close', () => end(new Error('aborted')));
  });
}

export function extractToken(req: http.IncomingMessage): string | undefined {
  const k = req.headers['x-api-key'];
  if (typeof k === 'string' && k) return k.trim();
  const a = req.headers.authorization;
  if (typeof a === 'string' && /^bearer /i.test(a)) return a.slice(7).trim();
  return undefined;
}

const one = (h: string | string[] | undefined): string | undefined => (Array.isArray(h) ? h[0] : h);
const clip = (s: string | undefined): string | null => (s ? s.slice(0, 128) : null);

export async function handleAnthropic(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, want: TokenKind): Promise<void> {
  const path = (req.url ?? '').split('?')[0];
  const isCount = path === '/anthropic/v1/messages/count_tokens';
  if (req.method !== 'POST' || (path !== '/anthropic/v1/messages' && !isCount)) {
    return sendErrorClose(res, req, 404, 'not_found_error', 'not_found');
  }
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader('x-nanogate-request-id', requestId);

  const a = authenticate(ctx.db, extractToken(req), want);
  if (!a.ok) {
    if (a.reason === 'paused') return sendErrorClose(res, req, 403, 'permission_error', 'tenant_paused');
    return sendErrorClose(res, req, 401, 'authentication_error', 'invalid x-api-key');
  }
  let auth = a.auth;
  const lim = ctx.config.anthropicLimits;

  // Registered synchronously after authentication, before the first await: revoke / session release can abort
  // the request in whatever stage it is (body upload, upstream call) instead of only after it started streaming.
  const ac = new AbortController();
  let upRef: http.ClientRequest | undefined;
  const entry: LiveEntry = {
    tenantId: auth.tenant.id, tokenHash: auth.tokenHash, kind: 'request',
    destroy: () => {
      ac.abort();
      upRef?.destroy();
      req.destroy();
      res.destroy();
    },
  };
  const unregister = ctx.live.add(entry);
  let held = 0; // request-body bytes accounted in ctx.bodyBytes / ctx.tenantBodyBytes
  const giveBack = (n: number) => {
    n = Math.min(n, held);
    if (n <= 0) return;
    ctx.bodyBytes -= n;
    const left = (ctx.tenantBodyBytes.get(auth.tenant.id) ?? n) - n;
    if (left > 0) ctx.tenantBodyBytes.set(auth.tenant.id, left);
    else ctx.tenantBodyBytes.delete(auth.tenant.id);
    held -= n;
  };
  const releaseBody = () => giveBack(held);
  // Every byte held in memory for this request goes through here, against both caps.
  const take = (n: number): boolean => {
    const mine = ctx.tenantBodyBytes.get(auth.tenant.id) ?? 0;
    if (ctx.bodyBytes + n > lim.maxInflightBodyBytes || mine + n > lim.maxInflightBodyBytesPerTenant) return false;
    ctx.bodyBytes += n;
    ctx.tenantBodyBytes.set(auth.tenant.id, mine + n);
    held += n;
    return true;
  };
  // Host-token callers (guest generation, stt, ...) have their own small pool, so a busy owner agent (all of its
  // slots in use) cannot make a summons fail with 429.
  const inflightKey = auth.kind === 'host' ? `host:${auth.tenant.id}` : auth.tenant.id;
  const inflightCap = () => (auth.kind === 'host' ? HOST_MAX_CONCURRENT : auth.tenant.policy.maxConcurrentRequests);
  let counted = false; // holds a maxConcurrentRequests slot
  let reservationId: string | null = null;
  const leave = () => {
    unregister();
    if (counted) {
      counted = false;
      ctx.inflight.set(inflightKey, Math.max(0, (ctx.inflight.get(inflightKey) ?? 1) - 1));
    }
    releaseBody();
  };
  let handedOff = false; // once the upstream request exists, finish() does the cleanup
  try {
    // Refuse before buffering anything: the body has not been read, so close the connection after replying.
    const refuse = (status: number, type: string, message: string) => sendErrorClose(res, req, status, type, message);
    // Every request (count_tokens included) holds a slot from before its body is read until it ends.
    if ((ctx.inflight.get(inflightKey) ?? 0) >= inflightCap()) {
      return refuse(429, 'rate_limit_error', 'too_many_concurrent_requests');
    }
    ctx.inflight.set(inflightKey, (ctx.inflight.get(inflightKey) ?? 0) + 1);
    counted = true;

    let raw: Buffer | null;
    try {
      raw = await readBody(req, MAX_BODY_BYTES, {
        timeoutMs: lim.bodyTimeoutMs, signal: ac.signal, take,
      });
    } catch (e) {
      if (ac.signal.aborted || res.destroyed) return;
      if (e instanceof TooLarge) return refuse(413, 'request_too_large', 'request body too large');
      if (e instanceof BodyTimeout) return refuse(408, 'request_timeout', 'request body not received in time');
      if (e instanceof Busy) return refuse(429, 'rate_limit_error', 'too_many_inflight_bytes');
      return refuse(400, 'invalid_request_error', 'unreadable body');
    }
    // The token may have been revoked / paused / its policy changed while the body was uploading.
    const v = revalidate(ctx.db, auth);
    if (!v.ok) {
      return v.reason === 'paused' ? refuse(403, 'permission_error', 'tenant_paused') : refuse(401, 'authentication_error', 'invalid x-api-key');
    }
    auth = v.auth;
    const tenant = auth.tenant;
    const policy = tenant.policy;

    // Processing makes transient copies (decoded string, parsed tree, re-serialised string, output buffer: up to
    // about 4x the raw size together). Account them before allocating anything, against the same caps.
    const rawLen = raw!.length;
    if (!take(rawLen * PROCESSING_FACTOR)) return refuse(429, 'rate_limit_error', 'too_many_inflight_bytes');
    let parsed: unknown;
    try {
      // Strict: invalid UTF-8 would otherwise turn every bad byte into a 3-byte U+FFFD and inflate the copy.
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw!));
      raw = null; // let the raw buffer go; only the accounted outgoing copy is kept
    } catch (e) {
      return sendError(res, 400, 'invalid_request_error', e instanceof TypeError ? 'body is not valid UTF-8' : 'invalid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return sendError(res, 400, 'invalid_request_error', 'body must be an object');
    }

    const checked = checkRequest(policy, ctx.config.prices, ctx.config.defaultBetas, parsed as Record<string, unknown>, one(req.headers['anthropic-beta']), !isCount, {
      defaultMaxUses: lim.serverToolDefaultMaxUses, maxMaxUses: lim.serverToolMaxUses, maxFetchContentTokens: lim.serverToolResultInputTokens,
    });
    if (isRejection(checked)) return sendError(res, checked.status, checked.type, checked.message);
    for (const b of checked.droppedBetas) {
      if (!ctx.warnedBetas.has(b)) {
        ctx.warnedBetas.add(b);
        ctx.log({ msg: 'beta_dropped', beta: b, tenant: tenant.id });
      }
    }
    const outStr = JSON.stringify(checked.body);
    // Valid UTF-8 re-serialises to no more than it came in (plus the few fields policy injects); refuse anything else.
    if (Buffer.byteLength(outStr, 'utf8') > rawLen + OUT_SLACK_BYTES) return sendError(res, 413, 'request_too_large', 'request body too large');
    let outBody = Buffer.from(outStr, 'utf8');
    // Only the outgoing copy stays held until the upstream write finishes; the transient copies are gone after this.
    giveBack(held - outBody.length);
    const model = checked.model;
    // x-nanogate-turn is an informational label only; no cap depends on it. Purpose never comes from a header:
    // session tokens are 'agent', host tokens carry the purpose they were minted with.
    const turnId = clip(one(req.headers['x-nanogate-turn']));
    const purpose = auth.kind === 'session' ? (auth.purpose === 'task' ? 'task' : 'agent') : auth.purpose;

    // Budget reservation (messages only; count_tokens is free).
    let reserved = 0;
    if (!isCount) {
      const parts = reserveParts(
        ctx.config.prices, model, rawLen,
        serverToolCapMicros(ctx.config.prices, checked.body.tools, model, lim.serverToolResultInputTokens, lim.serverToolDefaultMaxUses, lim.serverToolMaxUses),
        mediaEstimate(checked.body),
      );
      const maxTokens = checked.maxTokens!;
      // Extended thinking needs max_tokens above its budget; never clamp into that.
      const thinking = checked.body.thinking as { type?: unknown; budget_tokens?: unknown } | undefined;
      const thinkingBudget = thinking?.type === 'enabled' && typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : 0;
      const minTokens = Math.min(maxTokens, Math.max(lim.minOutputTokens, thinkingBudget + lim.minOutputTokens));
      reservationId = randomUUID();
      const r = reserveBudget(ctx.db, {
        id: reservationId, tenantId: tenant.id, tokenHash: auth.tokenHash, requestId, model, turnId, sessionKey: auth.sessionKey,
        reserve: Math.ceil(parts.base + parts.perToken * maxTokens),
        clamp: { base: parts.base, perToken: parts.perToken, maxTokens, minTokens },
        limit: tenant.budgetLimitMicros, tz: tenant.periodTz, windowCap: policy.perTurnCapMicros, windowMs: lim.capWindowMinutes * 60_000,
        globalCap: ctx.config.globalCapUsdMicros, now: startedAt,
      });
      if (!r.ok) {
        reservationId = null;
        // busy / global_busy: transient (own requests in flight hold the room); budget / global: final for the period.
        const transient = r.reason === 'budget_busy' || r.reason === 'global_busy';
        const message = r.reason === 'turn' ? 'turn_cap_exceeded' : r.reason === 'global' ? 'global_cap_exceeded' : transient ? 'budget_insufficient_now' : 'budget_exhausted';
        ctx.log({ msg: 'budget_denied', request_id: requestId, tenant: tenant.id, reason: r.reason });
        // A spent budget does not come back by retrying: tell the SDK not to (it would otherwise loop for minutes).
        const retryAfter = String(Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000)));
        const noRetry: Record<string, string> = r.reason === 'turn' ? {} : transient ? { 'retry-after': retryAfter } : { 'x-should-retry': 'false', 'retry-after': retryAfter };
        return sendError(res, 429, 'rate_limit_error', message, { nanogate: { tenantId: tenant.id, resetAt: new Date(r.resetAt).toISOString() } }, { 'x-nanogate-budget': r.reason === 'turn' ? 'turn_cap' : transient ? 'busy' : 'exhausted', ...noRetry });
      }
      reserved = r.reserve;
      if (r.maxTokens !== undefined && r.maxTokens < maxTokens) {
        // Fit the answer into what is left of the budget instead of refusing it.
        checked.body.max_tokens = r.maxTokens;
        const clamped = Buffer.from(JSON.stringify(checked.body), 'utf8');
        giveBack(outBody.length - clamped.length);
        outBody = clamped;
        ctx.log({ msg: 'max_tokens_clamped', request_id: requestId, tenant: tenant.id, from: maxTokens, to: r.maxTokens });
      }
      ctx.activeReservations.add(reservationId);
    }

    let settled = false;
    let headersTimer: NodeJS.Timeout | undefined;
    let idleTimer: NodeJS.Timeout | undefined;
    const finish = (kind: 'reconciled' | 'estimated' | 'free', usage = normalizeUsage(), httpStatus = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(headersTimer);
      clearTimeout(idleTimer);
      leave();
      if (reservationId) ctx.activeReservations.delete(reservationId);
      let cost = 0;
      let status: 'reconciled' | 'estimated' = 'reconciled';
      let resStatus: 'settled' | 'abandoned' = 'settled';
      if (kind === 'reconciled') cost = costMicros(ctx.config.prices, model, usage);
      else if (kind === 'estimated') {
        // Anything that did not end in a final message_delta (client abort, upstream cut, error event, timeout)
        // may still be billed in full upstream: charge the worst case, never less than what was observed.
        cost = Math.max(reserved, costMicros(ctx.config.prices, model, usage));
        status = 'estimated';
        resStatus = 'abandoned';
      }
      if (!isCount) {
        try {
          settle(ctx.db, {
            reservationId, requestId, tenantId: tenant.id, sessionKey: auth.sessionKey, purpose, turnId, model, usage,
            costMicros: cost, prices: ctx.config.prices, status, reservation: resStatus, startedAt,
            limit: tenant.budgetLimitMicros, tz: tenant.periodTz,
          });
        } catch (e) {
          // Metadata only. The reservation stays open and no longer counts as active, so the periodic sweep
          // charges it conservatively at the reserved amount.
          ctx.log({ msg: 'settle_failed', request_id: requestId, tenant: tenant.id, error: (e as Error).message });
        }
      }
      ctx.log({ msg: 'anthropic', request_id: requestId, tenant: tenant.id, model, status: httpStatus, settle: kind, input: usage.input, output: usage.output, cost_micros: cost, latency_ms: Date.now() - startedAt });
    };

    const up = new URL(ctx.config.upstream);
    const lib = up.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = {
      'content-type': 'application/json',
      'content-length': outBody.length,
      'x-api-key': ctx.apiKey,
      'anthropic-version': one(req.headers['anthropic-version']) ?? '2023-06-01',
      'accept-encoding': 'identity',
      'user-agent': 'nanogate',
    };
    const accept = one(req.headers.accept);
    if (accept) headers.accept = accept;
    if (checked.betas) headers['anthropic-beta'] = checked.betas;

    let gotResponse = false;
    let parserRef: SseUsageParser | null = null;
    let upStatus = 0;
    const upReq = lib.request(
      {
        protocol: up.protocol, hostname: up.hostname, port: up.port || undefined, method: 'POST',
        path: `${up.pathname.replace(/\/+$/, '')}/v1/messages${isCount ? '/count_tokens' : ''}`, headers,
      },
      (upRes) => {
        gotResponse = true;
        clearTimeout(headersTimer);
        const status = upRes.statusCode ?? 502;
        upStatus = status;
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k) && v !== undefined) outHeaders[k] = v;
        res.writeHead(status, outHeaders);
        const ok2xx = status >= 200 && status < 300;
        const isSse = String(upRes.headers['content-type'] ?? '').includes('text/event-stream');
        const parser = isSse && ok2xx && !isCount ? new SseUsageParser() : null;
        parserRef = parser;
        const jsonChunks: Buffer[] = [];
        let jsonBytes = 0;
        const collectJson = !isSse && ok2xx && !isCount;
        let ended = false;
        // No bytes from upstream for this long: abort and charge as an unfinished stream.
        idleTimer = setTimeout(() => abortUpstream('upstream_stream_idle'), lim.streamIdleMs);

        upRes.on('data', (c: Buffer) => {
          idleTimer?.refresh();
          parser?.feed(c);
          if (collectJson && jsonBytes <= MAX_JSON_RESPONSE_BYTES) {
            jsonBytes += c.length;
            jsonChunks.push(c);
          }
        });
        upRes.pipe(res);
        upRes.on('end', () => {
          ended = true;
          if (!ok2xx) return finish('free', normalizeUsage(), status);
          if (isCount) return finish('free', normalizeUsage(), status);
          if (parser) {
            if (parser.sawDelta && !parser.sawError) return finish('reconciled', parser.usage(), status);
            return finish('estimated', parser.usage(), status);
          }
          try {
            const u = (JSON.parse(Buffer.concat(jsonChunks).toString('utf8')) as { usage?: Record<string, unknown> }).usage;
            if (u && typeof u === 'object' && jsonBytes <= MAX_JSON_RESPONSE_BYTES) return finish('reconciled', normalizeUsage(u), status);
          } catch {
            // fall through
          }
          finish('estimated', normalizeUsage(), status);
        });
        upRes.on('close', () => {
          if (ended) return;
          finish(ok2xx ? 'estimated' : 'free', parser?.usage() ?? normalizeUsage(), status);
          res.destroy(); // truncated upstream stream: let the client see the break
        });
        upRes.on('error', () => undefined);
      },
    );
    upRef = upReq;
    handedOff = true;
    const abortUpstream = (reason: string) => {
      if (settled) return;
      ctx.log({ msg: 'upstream_timeout', request_id: requestId, tenant: tenant.id, reason });
      finish('estimated', parserRef?.usage() ?? normalizeUsage(), upStatus || 504);
      upReq.destroy();
      if (res.headersSent) res.destroy();
      else sendError(res, 504, 'api_error', reason);
    };
    upReq.on('error', () => {
      if (settled) return;
      if (!res.headersSent) {
        finish('free', normalizeUsage(), 502);
        sendError(res, 502, 'api_error', 'upstream_unreachable');
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
      // Client left before upstream finished: the upstream 'close' handler settles; guard for no-response case.
      if (!gotResponse) finish('estimated', normalizeUsage(), 499); // request may already be billed upstream
    });
    // Streaming responses send headers right away; a non-streaming response only answers when generation is done,
    // so it gets a longer limit (default 10 min, the SDK's own ceiling).
    const isStreamReq = (parsed as { stream?: unknown }).stream === true;
    headersTimer = setTimeout(
      () => abortUpstream('upstream_headers_timeout'),
      isStreamReq ? lim.upstreamHeadersTimeoutMs : lim.upstreamNonStreamTimeoutMs,
    );
    // The request body is on the wire: give the memory budget back now, not when the (possibly minutes-long) stream ends.
    upReq.once('finish', releaseBody);
    upReq.end(outBody);
  } finally {
    if (!handedOff) {
      if (reservationId) ctx.activeReservations.delete(reservationId); // left open: swept as estimated
      leave();
    }
  }
}
