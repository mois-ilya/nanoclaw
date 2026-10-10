/**
 * Mini App HTTP server: `node:http` on 127.0.0.1 (a reverse proxy terminates TLS).
 * JSON API under /api, static SPA for everything else. Body limit 64 KB,
 * per-user rate limit, bearer + CSRF header on mutations, initData HMAC at login.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

import { log } from '../../log.js';
import { nc, ownerTgId } from '../config.js';
import { getTenantByTg, type Tenant } from '../store.js';
import { meOf, routes, type Ctx, type Route } from './api.js';
import { InitDataError, validateInitData } from './auth.js';
import { ApiError, bad, forbidden } from './errors.js';
import { SessionStore, sessions as defaultSessions, type AppSession } from './sessions.js';
import type { ApiErrorBody, SessionResponse } from './types.js';

export const BODY_LIMIT = 64 * 1024;
const USER_LIMIT = { max: 120, windowMs: 60_000 };
const LOGIN_LIMIT = { max: 30, windowMs: 60_000 };
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

export interface ServerOptions {
  botToken?: () => string;
  now?: () => number;
  staticDir?: string;
  store?: SessionStore;
}

class RateLimiter {
  private readonly hits = new Map<string, { n: number; reset: number }>();
  constructor(private readonly now: () => number) {}
  allow(key: string, max: number, windowMs: number): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.reset <= t) {
      if (this.hits.size > 10_000) this.hits.clear();
      this.hits.set(key, { n: 1, reset: t + windowMs });
      return true;
    }
    h.n++;
    return h.n <= max;
  }
}

function sendJson(res: http.ServerResponse, status: number, body?: unknown): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(status === 204 ? {} : { 'content-length': Buffer.byteLength(payload) }),
  });
  res.end(status === 204 ? undefined : payload);
}

function sendError(res: http.ServerResponse, e: ApiError): void {
  const body: ApiErrorBody = { error: { code: e.code, message: e.message } };
  sendJson(res, e.status, body);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > BODY_LIMIT) throw new ApiError('invalid', 'Слишком большой запрос', 413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > BODY_LIMIT) {
      req.destroy();
      throw new ApiError('invalid', 'Слишком большой запрос', 413);
    }
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  if (
    !String(req.headers['content-type'] ?? '')
      .toLowerCase()
      .startsWith('application/json')
  ) {
    throw new ApiError('invalid', 'Ожидается application/json', 415);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw bad('Неверный JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('Ожидается объект');
  return parsed as Record<string, unknown>;
}

function constantEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'";

function serveStatic(staticDir: string, pathname: string, res: http.ServerResponse): void {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.includes('\0') || rel.includes('\\')) {
    res.writeHead(400).end();
    return;
  }
  const root = path.resolve(staticDir);
  let file = path.resolve(root, `.${path.posix.normalize(`/${rel}`)}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(file);
  } catch {
    st = undefined;
  }
  if (!st || !st.isFile()) {
    // SPA fallback only for extension-less routes.
    if (path.extname(rel)) {
      res.writeHead(404).end();
      return;
    }
    file = path.join(root, 'index.html');
    try {
      st = fs.statSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': st.size,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  fs.createReadStream(file).pipe(res);
}

export function createMiniAppHandler(
  opts: ServerOptions = {},
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  const now = opts.now ?? Date.now;
  const store = opts.store ?? defaultSessions;
  const limiter = new RateLimiter(now);
  const botToken = opts.botToken ?? ((): string => nc.botToken());
  const staticDir = opts.staticDir ?? (nc.miniappStaticDir() || path.join(process.cwd(), 'miniapp', 'dist'));

  async function login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const peer = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
      .split(',')
      .pop()!
      .trim();
    if (!limiter.allow(`login-ip:${peer}`, LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs))
      throw new ApiError('rate_limited', 'Слишком часто');
    const body = await readBody(req);
    let init;
    try {
      init = validateInitData(body.initData, botToken(), { nowMs: now() });
    } catch (e) {
      if (e instanceof InitDataError) throw new ApiError('unauthorized', 'Не удалось подтвердить Telegram');
      throw e;
    }
    if (!limiter.allow(`login-user:${init.user.id}`, LOGIN_LIMIT.max, LOGIN_LIMIT.windowMs))
      throw new ApiError('rate_limited', 'Слишком часто');
    const tenant = await getTenantByTg(init.user.id);
    // Same answer for unknown / pending / denied / deleted: no state oracle for strangers.
    if (!tenant || (tenant.state !== 'ready' && tenant.state !== 'paused')) throw forbidden('Нет доступа');
    const s = store.create({ tgId: tenant.tg_id, userId: tenant.user_id, epoch: tenant.epoch });
    const isOwner = tenant.tg_id === ownerTgId() && tenant.state === 'ready';
    const out: SessionResponse = {
      token: s.token,
      expiresAt: new Date(s.expiresAt).toISOString(),
      me: await meOf(tenant, isOwner),
    };
    sendJson(res, 200, out);
  }

  async function authenticate(req: http.IncomingMessage): Promise<{ s: AppSession; tenant: Tenant }> {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer (\S+)$/.exec(h) : null;
    if (!m || !TOKEN_RE.test(m[1])) throw new ApiError('unauthorized', 'Нужна авторизация');
    const s = store.get(m[1]);
    if (!s) throw new ApiError('unauthorized', 'Сессия истекла');
    const tenant = await getTenantByTg(s.tgId);
    if (!tenant || tenant.epoch !== s.epoch) {
      store.revokeUser(s.tgId);
      throw new ApiError('unauthorized', 'Сессия недействительна');
    }
    if (req.method !== 'GET' && !constantEq(String(req.headers['x-csrf'] ?? ''), s.token)) {
      throw forbidden('Неверный CSRF-токен');
    }
    return { s, tenant };
  }

  async function api(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
    query: URLSearchParams,
  ): Promise<void> {
    if (pathname === '/api/session') {
      if (req.method !== 'POST') throw new ApiError('invalid', 'Метод не поддерживается', 405);
      return login(req, res);
    }
    const route: Route | undefined = routes.find((r) => r.method === req.method && r.re.test(pathname));
    // Authenticate before revealing whether a route exists.
    const { s, tenant } = await authenticate(req);
    if (!limiter.allow(`user:${s.tgId}`, USER_LIMIT.max, USER_LIMIT.windowMs))
      throw new ApiError('rate_limited', 'Слишком часто');
    if (!route) throw new ApiError('not_found', 'Не найдено');

    // Re-check state and role on EVERY call.
    if (tenant.state === 'paused') {
      if (!route.pausedOk) throw forbidden('Доступ приостановлен');
    } else if (tenant.state !== 'ready') {
      throw forbidden('Нет доступа');
    }
    const isOwner = tenant.tg_id === ownerTgId() && tenant.state === 'ready';
    if (route.owner && !isOwner) throw forbidden();

    const body = req.method === 'GET' ? {} : await readBody(req);
    const ctx: Ctx = { tenant, isOwner, q: query, body, m: pathname.match(route.re)! };
    const out = await route.handler(ctx);
    if (!out) return sendJson(res, 204);
    sendJson(res, out.status ?? 200, out.json);
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await api(req, res, url.pathname, url.searchParams);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405).end();
        return;
      }
      serveStatic(staticDir, url.pathname, res);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (e instanceof ApiError) return sendError(res, e);
      log.error('nc: miniapp handler failed', { err: e instanceof Error ? e.message : String(e) });
      sendError(res, new ApiError('internal', 'Что-то пошло не так'));
    }
  };
}

export interface RunningMiniApp {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/** Listen on 127.0.0.1 only. `port` 0 picks a free port (tests). */
export async function startMiniAppServer(opts: ServerOptions & { port?: number } = {}): Promise<RunningMiniApp> {
  const handler = createMiniAppHandler(opts);
  const server = http.createServer((req, res) => void handler(req, res));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? nc.miniappPort(), '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  log.info('nc: Mini App listening', { port });
  return {
    server,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
