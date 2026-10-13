// /mcp/:id: authenticated, key-injecting proxy to a remote MCP server (Streamable HTTP), with owner approval for
// tools that may change data. The agent holds only its session token; the connector's key never leaves nanogate.
import crypto from 'node:crypto';
import http from 'node:http';
import type { Ctx } from './context.js';
import {
  type McpConnectorRow,
  type McpToolPolicy,
  finishMcpCall,
  getMcpConnector,
  insertEvent,
  insertMcpCall,
  listMcpTools,
  upsertMcpTools,
} from './db.js';
import { argFields, callId } from './mcp-approvals.js';
import { UpstreamError, type UpstreamResponse, upstreamRequest } from './mcp-upstream.js';
import { type Auth, authenticate, getSecret, revalidate } from './tokens.js';

const PATH = /^\/mcp\/([a-z0-9-]{3,64})$/;
export const SESSION_TTL_MS = 24 * 3600_000;
export const MAX_SESSIONS = 2048;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_PROBE_PAGES = 5;

/** What the agent is told (HTTP 200 + isError, so the model reads the reason). */
const TEXT = {
  denied: (t: string) => `Владелец отклонил вызов ${t}. Не повторяй его, пока пользователь сам не попросит.`,
  expired: (t: string) =>
    `Нет подтверждения за 5 минут — вызов ${t} не выполнен. Скажи пользователю, что ждёшь подтверждения, и повтори только по его просьбе.`,
  unavailable:
    'Подтверждение сейчас недоступно (перезапуск или сбой доставки) — вызов не выполнен. Можно повторить позже.',
  disabled: 'Коннектор выключен или сессия отозвана — вызов не выполнен.',
  changed: 'Настройки коннектора изменились, пока вызов ждал подтверждения — вызов не выполнен. Повтори его.',
  cancelled: 'Вызов отменён.',
  unknown: (title: string) =>
    `Результат неизвестен: ${title} мог выполнить действие. Не повторяй автоматически — сначала проверь состояние.`,
  unreachable: (title: string) => `${title} сейчас недоступен — вызов не выполнен.`,
  keyRejected: (title: string) => `${title} не принял ключ — обновите его в Кабинете.`,
  noKey: 'Ключ не задан — добавьте его в Кабинете.',
  tooMany: 'Слишком много вызовов ждут подтверждения. Повтори позже.',
};

/** asks(tool) = policy 'ask', or no 'auto' override and the tool is not known read-only (unknown = dangerous). */
export function classify(policy: McpToolPolicy, tool: string, readOnly: boolean | undefined): boolean {
  const p = Object.hasOwn(policy, tool) ? policy[tool] : undefined;
  return p === 'ask' || (p !== 'auto' && readOnly !== true);
}

// ---- JSON / SSE bodies ----------------------------------------------------------------------------------------

type Rpc = { jsonrpc?: string; id?: unknown; method?: string; params?: any; result?: any; error?: any };

/** JSON-RPC messages out of a JSON or SSE body; unparseable parts are skipped. */
export function parseRpc(contentType: string | undefined, text: string): Rpc[] {
  const out: Rpc[] = [];
  const push = (s: string): void => {
    try {
      const v = JSON.parse(s) as unknown;
      for (const m of Array.isArray(v) ? v : [v]) if (m && typeof m === 'object') out.push(m as Rpc);
    } catch {
      // not JSON
    }
  };
  if (/text\/event-stream/i.test(contentType ?? '')) {
    for (const ev of text.split(/\r?\n\r?\n/)) {
      const data = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''));
      if (data.length) push(data.join('\n'));
    }
  } else push(text);
  return out;
}

interface ToolRow {
  name: string;
  readOnly: boolean;
  title: string | null;
}

function toolRows(result: any): ToolRow[] {
  if (!result || !Array.isArray(result.tools)) return [];
  const rows: ToolRow[] = [];
  for (const t of result.tools) {
    if (!t || typeof t.name !== 'string' || !t.name) continue;
    const title =
      typeof t.annotations?.title === 'string' ? t.annotations.title : typeof t.title === 'string' ? t.title : null;
    // The only source of "safe": the upstream says readOnlyHint === true.
    rows.push({ name: t.name, readOnly: t.annotations?.readOnlyHint === true, title });
  }
  return rows;
}

async function readAll(s: http.IncomingMessage, cap: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let n = 0;
  try {
    for await (const c of s) {
      n += (c as Buffer).length;
      if (n > cap) {
        s.destroy();
        return null;
      }
      chunks.push(c as Buffer);
    }
  } catch {
    return null;
  }
  return s.complete === false ? null : Buffer.concat(chunks).toString('utf8');
}

// ---- gateway MCP sessions -------------------------------------------------------------------------------------

export function resetMcpSessions(ctx: Ctx, connectorId: string): number {
  let n = 0;
  for (const [sid, b] of [...ctx.mcpSessions]) {
    if (b.connectorId !== connectorId) continue;
    ctx.mcpSessions.delete(sid);
    n++;
  }
  return n;
}

function bindSession(ctx: Ctx, tokenHash: string, connectorId: string, upstreamSid: string | null): string {
  const now = Date.now();
  for (const [sid, b] of ctx.mcpSessions) if (now - b.lastUsed > SESSION_TTL_MS) ctx.mcpSessions.delete(sid);
  while (ctx.mcpSessions.size >= MAX_SESSIONS) ctx.mcpSessions.delete(ctx.mcpSessions.keys().next().value!);
  const sid = `mcps_${crypto.randomBytes(18).toString('base64url')}`;
  ctx.mcpSessions.set(sid, { tokenHash, connectorId, upstreamSid, lastUsed: now });
  return sid;
}

function lookupSession(ctx: Ctx, sid: string | undefined, auth: Auth, connectorId: string) {
  if (!sid) return null;
  const b = ctx.mcpSessions.get(sid);
  if (!b || b.tokenHash !== auth.tokenHash || b.connectorId !== connectorId || Date.now() - b.lastUsed > SESSION_TTL_MS)
    return null;
  // touch: Map order is the eviction order (oldest first)
  ctx.mcpSessions.delete(sid);
  b.lastUsed = Date.now();
  ctx.mcpSessions.set(sid, b);
  return b;
}

// ---- upstream plumbing ----------------------------------------------------------------------------------------

const VISIBLE = /^[\x20-\x7e]*$/;

function upstreamHeaders(
  src: http.IncomingHttpHeaders,
  c: McpConnectorRow,
  key: string,
  upstreamSid: string | null,
  body?: Buffer,
): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v !== 'string' || !VISIBLE.test(v)) continue;
    // Nothing else of the agent's reaches the upstream: no authorization, cookie, x-forwarded-*, last-event-id.
    if (k === 'content-type' || k === 'accept' || (k.startsWith('mcp-') && k !== 'mcp-session-id')) h[k] = v;
  }
  h.accept ??= 'application/json, text/event-stream';
  for (const [k, v] of Object.entries(c.extraHeaders)) h[k.toLowerCase()] = v;
  if (upstreamSid) h['mcp-session-id'] = upstreamSid;
  h.authorization = `Bearer ${key}`;
  h['user-agent'] = 'nanogate';
  if (body) h['content-length'] = String(body.length);
  return h;
}

function readKey(ctx: Ctx, c: McpConnectorRow): string | null {
  try {
    return getSecret(ctx.db, ctx.encKey, c.tenantId, c.secretName);
  } catch {
    return null;
  }
}

function jsonReply(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent || res.destroyed) return;
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
  res.end(s);
}

function toolError(res: http.ServerResponse, id: unknown, text: string): void {
  jsonReply(res, 200, { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text }] } });
}

/** Error before the request body was read: answer and drop the connection. */
function failClose(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  status: number,
  code: string,
  headers: Record<string, string> = {},
): void {
  if (!res.headersSent) res.setHeader('connection', 'close');
  res.once('finish', () => req.socket.destroy());
  jsonReply(res, status, { error: code }, headers);
}

class TooLarge extends Error {}
class BodyTimeout extends Error {}

function readBody(req: http.IncomingMessage, limit: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new TooLarge());
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    const end = (err?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.pause();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => end(new BodyTimeout()), timeoutMs);
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) return end(new TooLarge());
      chunks.push(c);
    });
    req.on('end', () => end());
    req.on('error', () => end(new Error('aborted')));
    req.on('close', () => end(new Error('aborted')));
  });
}

// ---- the proxy ------------------------------------------------------------------------------------------------

interface Call {
  id: string;
  ctx: Ctx;
  auth: Auth;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  connector: McpConnectorRow;
  msg: Rpc;
  body: Buffer;
  /** gateway session id (null for initialize) */
  gwSid: string | null;
  upstreamSid: string | null;
  /** aborts the upstream exchange: the agent's connection went away, or the token / tenant was revoked */
  ac: AbortController;
  startedAt: number;
  tool?: string;
  /** decision to record on completion */
  decision: string;
  tracked: boolean;
  /** the live registry killed this call (token revoked, session released, tenant revoked) */
  revoked: boolean;
}

function finishCall(k: Call, status: string | null, httpStatus: number | null, decision?: string): void {
  if (decision) k.decision = decision;
  if (k.tracked) {
    try {
      finishMcpCall(k.ctx.db, k.id, { decision: k.decision, status, httpStatus });
    } catch (e) {
      k.ctx.log({ msg: 'mcp_call_log_error', error: (e as Error).message });
    }
    k.ctx.log({
      msg: 'mcp_call',
      tenant: k.auth.tenant.id,
      connector: k.connector.id,
      tool: k.tool,
      decision: k.decision,
      status,
      ms: Date.now() - k.startedAt,
    });
  }
}

/** per gateway instance: one mcp_key_rejected event per connector per 30 s */
const lastKeyEvent = new WeakMap<Ctx, Map<string, number>>();

function keyRejected(k: Call): void {
  const now = Date.now();
  let seen = lastKeyEvent.get(k.ctx);
  if (!seen) lastKeyEvent.set(k.ctx, (seen = new Map()));
  if (now - (seen.get(k.connector.id) ?? 0) < 30_000) return;
  seen.set(k.connector.id, now);
  try {
    insertEvent(k.ctx.db, k.auth.tenant.id, 'mcp_key_rejected', { connectorId: k.connector.id });
  } catch (e) {
    k.ctx.log({ msg: 'mcp_event_error', error: (e as Error).message });
  }
}

/** Send one request upstream and stream the answer back. Used for plain calls, approved calls and everything else. */
async function forward(k: Call, key: string): Promise<void> {
  const { ctx, res, connector } = k;
  const isCall = k.msg.method === 'tools/call';
  const isList = k.msg.method === 'tools/list';
  let up: UpstreamResponse;
  try {
    up = await upstreamRequest(ctx, k.auth.tenant.id, connector.url, {
      method: 'POST',
      headers: upstreamHeaders(k.req.headers, connector, key, k.upstreamSid, k.body),
      body: k.body,
      signal: k.ac.signal,
    });
  } catch (e) {
    const err = e as UpstreamError;
    if (err.kind === 'aborted')
      return void finishCall(k, err.sent ? 'unknown' : null, null, k.revoked ? 'revoked' : 'disconnected');
    const unknown = isCall && err.sent && (err.kind === 'timeout' || err.kind === 'network');
    finishCall(k, unknown ? 'unknown' : 'upstream_error', null);
    if (isCall)
      return toolError(res, k.msg.id, unknown ? TEXT.unknown(connector.title) : TEXT.unreachable(connector.title));
    return jsonReply(res, 502, { error: 'upstream_unreachable' });
  }

  if (up.status === 401 || up.status === 403) {
    up.stream.destroy();
    keyRejected(k);
    finishCall(k, 'upstream_error', up.status);
    if (isCall) return toolError(res, k.msg.id, TEXT.keyRejected(connector.title));
    return jsonReply(res, 502, { error: 'upstream_rejected_key' });
  }

  const headers: Record<string, string> = {};
  for (const n of ['content-type', 'mcp-protocol-version', 'cache-control']) {
    const v = up.headers[n];
    if (typeof v === 'string') headers[n] = v;
  }
  const isInit = k.msg.method === 'initialize';
  if (isInit && up.status >= 200 && up.status < 300) {
    const us = up.headers['mcp-session-id'];
    headers['mcp-session-id'] = bindSession(
      ctx,
      k.auth.tokenHash,
      connector.id,
      typeof us === 'string' && us ? us : null,
    );
  }

  const cap = ctx.config.mcp.maxListBytes;
  const tee: Buffer[] = [];
  let teeBytes = 0;
  let teeOverflow = false;
  const wantTee = (isCall || isList) && up.status >= 200 && up.status < 300;

  res.writeHead(up.status, headers);
  res.flushHeaders();
  res.on('drain', () => up.stream.resume());
  up.stream.on('data', (c: Buffer) => {
    if (wantTee && !teeOverflow) {
      teeBytes += c.length;
      if (teeBytes > cap) {
        teeOverflow = true;
        tee.length = 0;
      } else tee.push(c);
    }
    if (!res.write(c)) up.stream.pause();
  });
  await new Promise<void>((resolve) => {
    up.stream.once('close', resolve);
    if (up.stream.destroyed) resolve();
  });

  if (!up.stream.complete) {
    // cut short (upstream died, deadline hit, or the agent left): the agent must not see a truncated message as complete
    res.destroy();
    return void finishCall(k, isCall ? 'unknown' : 'upstream_error', up.status);
  }
  res.end();

  let status: string | null = up.status < 300 ? 'ok' : 'upstream_error';
  if (wantTee && !teeOverflow) {
    const msgs = parseRpc(headers['content-type'], Buffer.concat(tee).toString('utf8'));
    const mine = msgs.find((m) => m.id === k.msg.id && (m.result !== undefined || m.error !== undefined));
    if (isCall && mine && (mine.error !== undefined || mine.result?.isError === true)) status = 'tool_error';
    if (isList && mine?.result) {
      try {
        // A first page with no continuation is the whole inventory: tools gone from it lose their old read-only mark.
        const complete = !k.msg.params?.cursor && !mine.result.nextCursor;
        upsertMcpTools(ctx.db, connector.id, toolRows(mine.result), complete);
      } catch (e) {
        ctx.log({ msg: 'mcp_tools_error', error: (e as Error).message });
      }
    }
  }
  finishCall(k, status, up.status);
}

/** Dangerous call: hold it open until the owner decides, then forward once or refuse. */
async function holdAndForward(k: Call): Promise<void> {
  const { ctx, res, connector, auth } = k;
  const tool = k.tool!;
  // First the row: if the insert throws, no card and no live entry exist yet to be left without a caller.
  insertMcpCall(ctx.db, {
    id: k.id,
    tenantId: auth.tenant.id,
    connectorId: connector.id,
    sessionKey: auth.sessionKey ?? '',
    tool,
    dangerous: true,
    decision: 'pending',
    startedAt: k.startedAt,
  });
  k.tracked = true;
  const live = {
    tenantId: auth.tenant.id,
    tokenHash: auth.tokenHash,
    kind: 'request' as const,
    destroy: () => undefined as void,
  };
  const unreg = ctx.live.add(live);
  const held = ctx.mcpApprovals.hold(
    {
      tenantId: auth.tenant.id,
      sessionKey: auth.sessionKey ?? '',
      connectorId: connector.id,
      connectorTitle: connector.title,
      tool,
      args: argFields(k.msg.params?.arguments),
      holdMs: ctx.config.mcp.holdMs,
      gwSid: k.gwSid!,
      rpcId: k.msg.id as string | number,
    },
    k.id,
  );
  live.destroy = () => held.release('revoked');
  k.decision = 'pending';
  // Gone before an answer = refusal (§11.1: res 'close' before the response finished, never req 'close').
  const onClose = (): void => {
    if (!res.writableFinished) held.release('disconnected');
  };
  res.on('close', onClose);

  const outcome = await held.outcome;
  res.off('close', onClose);
  const refuse = (decision: string, text: string): void => {
    unreg();
    finishCall(k, null, null, decision);
    toolError(res, k.msg.id, text);
  };

  switch (outcome) {
    case 'disconnected':
      unreg();
      return void finishCall(k, null, null, 'disconnected');
    case 'cancelled':
      return refuse('disconnected', TEXT.cancelled);
    case 'expired':
      return refuse('expired', TEXT.expired(tool));
    case 'deny':
      return refuse('denied', TEXT.denied(tool));
    case 'unavailable':
      return refuse('unavailable', TEXT.unavailable);
    case 'revoked':
      return refuse('revoked', TEXT.disabled);
    case 'disabled':
      return refuse('disabled', TEXT.disabled);
    case 'approve':
      break;
  }

  // Approved: everything may have changed while it waited. Re-check, then send exactly once.
  const v = revalidate(ctx.db, auth);
  if (!v.ok) return refuse('revoked', TEXT.disabled);
  const fresh = getMcpConnector(ctx.db, connector.id);
  if (!fresh || !fresh.enabled || fresh.tenantId !== auth.tenant.id) return refuse('disabled', TEXT.disabled);
  if (fresh.rev !== connector.rev) return refuse('revoked', TEXT.changed);
  const freshKey = readKey(ctx, fresh);
  if (!freshKey) return refuse('disabled', TEXT.noKey);
  if (res.destroyed) {
    unreg();
    return void finishCall(k, null, null, 'disconnected');
  }
  k.connector = fresh;
  k.decision = 'approved';
  live.destroy = () => {
    k.revoked = true;
    k.ac.abort();
    res.destroy();
  };
  res.on('close', () => {
    if (!res.writableFinished) k.ac.abort();
  });
  try {
    await forward(k, freshKey);
  } finally {
    unreg();
  }
}

async function handleMcp(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mcp');
  const m = PATH.exec(url.pathname);
  if (!m) return failClose(req, res, 404, 'not_found');
  const connectorId = m[1]!;

  // 401 deliberately has no WWW-Authenticate: the client must not start OAuth discovery.
  const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''));
  const a = authenticate(ctx.db, bearer?.[1]?.trim(), 'session');
  if (!a.ok)
    return a.reason === 'paused' ? failClose(req, res, 403, 'tenant_paused') : failClose(req, res, 401, 'unauthorized');
  const auth = a.auth;

  // Somebody else's connector looks exactly like a missing one.
  const connector = getMcpConnector(ctx.db, connectorId);
  if (!connector || connector.tenantId !== auth.tenant.id || !connector.enabled)
    return failClose(req, res, 404, 'not_found');

  const sidHeader = typeof req.headers['mcp-session-id'] === 'string' ? req.headers['mcp-session-id'] : undefined;

  if (req.method === 'GET') {
    // Streams are not resumable (no Last-Event-ID) and there is no standalone server->client stream.
    return failClose(req, res, 405, 'method_not_allowed', { allow: 'POST, DELETE' });
  }

  if (req.method === 'DELETE') {
    const b = lookupSession(ctx, sidHeader, auth, connectorId);
    if (!b) return failClose(req, res, 404, 'session_not_found');
    ctx.mcpSessions.delete(sidHeader!);
    ctx.mcpApprovals.cancelSession(sidHeader!);
    const key = readKey(ctx, connector);
    if (key && b.upstreamSid) {
      const ac = new AbortController();
      req.once('close', () => ac.abort());
      try {
        const up = await upstreamRequest(ctx, auth.tenant.id, connector.url, {
          method: 'DELETE',
          headers: upstreamHeaders(req.headers, connector, key, b.upstreamSid),
          signal: ac.signal,
        });
        up.stream.resume();
      } catch {
        // the session is gone on our side either way
      }
    }
    res.writeHead(204);
    return void res.end();
  }

  if (req.method !== 'POST') return failClose(req, res, 405, 'method_not_allowed', { allow: 'POST, DELETE' });

  let body: Buffer;
  try {
    body = await readBody(req, ctx.config.mcp.maxBodyBytes, ctx.config.anthropicLimits.bodyTimeoutMs);
  } catch (e) {
    if (e instanceof TooLarge) return failClose(req, res, 413, 'too_large');
    if (e instanceof BodyTimeout) return failClose(req, res, 408, 'body_timeout');
    return void req.socket.destroy();
  }
  let msg: Rpc;
  try {
    const parsed = JSON.parse(body.toString('utf8')) as unknown;
    if (Array.isArray(parsed)) return jsonReply(res, 400, { error: 'batch_unsupported' });
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    msg = parsed as Rpc;
  } catch {
    return jsonReply(res, 400, { error: 'invalid_json' });
  }
  // What we decide on must be what the upstream executes. A decoder that matches keys case-insensitively (Go's
  // encoding/json) could read `Method` / `Name` / `Arguments` differently from JS, so such messages are refused, and
  // the canonical re-serialization (one value per key) is what goes upstream instead of the caller's bytes.
  if (hasShadowKey(msg, RPC_KEYS) || hasShadowKey(msg.params, PARAM_KEYS))
    return jsonReply(res, 400, { error: 'ambiguous_keys' });
  body = Buffer.from(JSON.stringify(msg));
  const method = typeof msg.method === 'string' ? msg.method : undefined;

  let binding: ReturnType<typeof lookupSession> = null;
  if (method !== 'initialize') {
    binding = lookupSession(ctx, sidHeader, auth, connectorId);
    // No such session (never issued, other token, or the process restarted): the client re-initializes.
    if (!binding) return jsonReply(res, 404, { error: 'session_not_found' });
  }

  if (method === 'notifications/cancelled' && ctx.mcpApprovals.cancel(sidHeader!, msg.params?.requestId)) {
    res.writeHead(202);
    return void res.end();
  }

  const k: Call = {
    id: callId(),
    ctx,
    auth,
    req,
    res,
    connector,
    msg,
    body,
    gwSid: sidHeader ?? null,
    upstreamSid: binding?.upstreamSid ?? null,
    ac: new AbortController(),
    startedAt: Date.now(),
    decision: 'auto',
    tracked: false,
    revoked: false,
  };

  if (method === 'tools/call') {
    if (typeof msg.params?.name !== 'string' || !msg.params.name || msg.id === undefined || msg.id === null)
      return jsonReply(res, 400, { error: 'bad_tool_call' });
    const tool: string = msg.params.name;
    k.tool = tool;
    const known = listMcpTools(ctx.db, connectorId).find((t) => t.name === tool);
    const asks = classify(connector.toolPolicy, tool, known?.readOnly);
    const key = readKey(ctx, connector);
    const record = (decision: string): void => {
      insertMcpCall(ctx.db, {
        id: k.id,
        tenantId: auth.tenant.id,
        connectorId,
        sessionKey: auth.sessionKey ?? '',
        tool,
        dangerous: asks,
        decision,
        startedAt: k.startedAt,
      });
      k.tracked = true;
      k.decision = decision;
    };
    if (!key) {
      record('unavailable');
      finishCall(k, null, null);
      return toolError(res, msg.id, TEXT.noKey);
    }
    if (asks) {
      if (
        ctx.mcpApprovals.count(auth.tenant.id) >= ctx.config.mcp.maxPendingPerTenant ||
        ctx.mcpApprovals.count() >= ctx.config.mcp.maxPendingTotal
      ) {
        record('unavailable');
        finishCall(k, null, null);
        return toolError(res, msg.id, TEXT.tooMany);
      }
      return holdAndForward(k);
    }
    record('auto');
    return run(k, key);
  }

  const key = readKey(ctx, connector);
  if (!key) return jsonReply(res, 503, { error: 'no_key' });
  return run(k, key);
}

const RPC_KEYS = ['jsonrpc', 'id', 'method', 'params'];
const PARAM_KEYS = ['name', 'arguments', '_meta'];

/** True when `o` has a key that equals a known one only ignoring case. */
function hasShadowKey(o: unknown, known: string[]): boolean {
  if (!o || typeof o !== 'object') return false;
  return Object.keys(o).some((key) => !known.includes(key) && known.includes(key.toLowerCase()));
}

/** Forward with the request registered as live work (revoke / pause / session release abort it). */
async function run(k: Call, key: string): Promise<void> {
  const { res } = k;
  const unreg = k.ctx.live.add({
    tenantId: k.auth.tenant.id,
    tokenHash: k.auth.tokenHash,
    kind: 'request',
    destroy: () => {
      k.revoked = true;
      k.ac.abort();
      res.destroy();
    },
  });
  const onClose = (): void => {
    if (!res.writableFinished) k.ac.abort();
  };
  res.on('close', onClose);
  try {
    await forward(k, key);
  } finally {
    res.off('close', onClose);
    unreg();
  }
}

export function createMcpServer(ctx: Ctx): http.Server {
  const server = http.createServer((req, res) => {
    req.socket.setNoDelay(true);
    handleMcp(ctx, req, res).catch((e: Error) => {
      ctx.log({ msg: 'mcp_error', error: e.message });
      if (!res.headersSent) failClose(req, res, 500, 'internal');
      else res.destroy();
    });
  });
  server.on('clientError', (_e, sock) => sock.destroy());
  return server;
}

// ---- key probe --------------------------------------------------------------------------------------------------

export type ProbeResult =
  | { ok: true; tools: number }
  | { ok: false; error: 'no_key' | 'key_rejected' | 'upstream_unreachable' | 'upstream_error'; status?: number };

/**
 * initialize -> notifications/initialized -> tools/list (paged) -> DELETE, with the stored key or, to vet a new one
 * before anything is written, an in-memory candidate. On success the tool inventory is replaced.
 */
export async function probeConnector(ctx: Ctx, c: McpConnectorRow, candidateKey?: string): Promise<ProbeResult> {
  const key = candidateKey ?? readKey(ctx, c);
  if (!key) return { ok: false, error: 'no_key' };
  const cap = ctx.config.mcp.maxListBytes;
  const base = { 'content-type': 'application/json' };
  const call = async (payload: unknown, sid: string | null, version: string | null) => {
    const body = Buffer.from(JSON.stringify(payload));
    const hdrs: http.IncomingHttpHeaders = { ...base, ...(version ? { 'mcp-protocol-version': version } : {}) };
    const up = await upstreamRequest(ctx, c.tenantId, c.url, {
      method: 'POST',
      headers: upstreamHeaders(hdrs, c, key, sid, body),
      body,
    });
    const text = await readAll(up.stream, cap);
    return {
      status: up.status,
      headers: up.headers,
      msgs: text === null ? null : parseRpc(up.headers['content-type'], text),
    };
  };
  const bad = (status: number): ProbeResult =>
    status === 401 || status === 403
      ? { ok: false, error: 'key_rejected', status }
      : { ok: false, error: 'upstream_error', status };
  let sid: string | null = null;
  try {
    const init = await call(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'nanogate', version: '1' } },
      },
      null,
      null,
    );
    if (init.status < 200 || init.status >= 300) return bad(init.status);
    const initMsg = init.msgs?.find((m) => m.id === 1);
    if (!initMsg?.result) return { ok: false, error: 'upstream_error', status: init.status };
    const version =
      typeof initMsg.result.protocolVersion === 'string' ? initMsg.result.protocolVersion : PROTOCOL_VERSION;
    const us = init.headers['mcp-session-id'];
    sid = typeof us === 'string' && us ? us : null;

    const note = await call({ jsonrpc: '2.0', method: 'notifications/initialized' }, sid, version);
    if (note.status === 401 || note.status === 403) return bad(note.status);

    const tools: ToolRow[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await call(
        { jsonrpc: '2.0', id: 2 + pages, method: 'tools/list', ...(cursor ? { params: { cursor } } : {}) },
        sid,
        version,
      );
      if (page.status < 200 || page.status >= 300) return bad(page.status);
      const pm = page.msgs?.find((m) => m.id === 2 + pages);
      if (!pm?.result) return { ok: false, error: 'upstream_error', status: page.status };
      tools.push(...toolRows(pm.result));
      cursor = typeof pm.result.nextCursor === 'string' && pm.result.nextCursor ? pm.result.nextCursor : undefined;
      pages++;
    } while (cursor && pages < MAX_PROBE_PAGES);
    upsertMcpTools(ctx.db, c.id, tools, !cursor);
    return { ok: true, tools: tools.length };
  } catch (e) {
    if (!(e instanceof UpstreamError)) throw e;
    return e.kind === 'redirect' || e.kind === 'not_https'
      ? { ok: false, error: 'upstream_error' }
      : { ok: false, error: 'upstream_unreachable' };
  } finally {
    if (sid) {
      // best effort: the session is of no further use
      await upstreamRequest(ctx, c.tenantId, c.url, {
        method: 'DELETE',
        headers: upstreamHeaders(base, c, key, sid),
      }).then(
        (r) => r.stream.resume(),
        () => undefined,
      );
    }
  }
}
