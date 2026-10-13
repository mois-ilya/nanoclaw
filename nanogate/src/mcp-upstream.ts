// HTTPS client for MCP upstreams. Public addresses only (resolved, vetted and pinned), no redirects, and one
// ABSOLUTE deadline over DNS, connect, response headers and the whole body.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { parseIp } from './cidr.js';
import { checkPublicAddresses } from './connect-proxy.js';
import type { Ctx } from './context.js';

export type UpstreamErrorKind = 'not_https' | 'denied' | 'dns' | 'timeout' | 'network' | 'redirect' | 'aborted';

export class UpstreamError extends Error {
  constructor(
    public kind: UpstreamErrorKind,
    /** the request was fully written to the socket: the upstream may have acted on it */
    public sent: boolean,
  ) {
    super(kind);
  }
}

export interface UpstreamInit {
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
  /** the caller (e.g. the agent's connection) is gone: abort everything */
  signal?: AbortSignal;
}

export interface UpstreamResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body. Reading past the deadline or after `signal` aborts ends in an 'error' event. */
  stream: http.IncomingMessage;
}

export async function upstreamRequest(
  ctx: Ctx,
  tenantId: string,
  urlStr: string,
  init: UpstreamInit,
): Promise<UpstreamResponse> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new UpstreamError('not_https', false);
  }
  if (u.protocol !== 'https:' || u.username || u.password) throw new UpstreamError('not_https', false);
  const host = u.hostname.replace(/^\[|\]$/g, '');

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, ctx.config.mcp.upstreamTimeoutMs);
  const onExternal = (): void => ac.abort();
  if (init.signal?.aborted) onExternal();
  else init.signal?.addEventListener('abort', onExternal, { once: true });
  const cleanup = (): void => {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', onExternal);
  };
  const failure = (sent: boolean, fallback: UpstreamErrorKind): UpstreamError =>
    new UpstreamError(timedOut ? 'timeout' : ac.signal.aborted ? 'aborted' : fallback, sent);

  try {
    let ips: string[];
    if (net.isIP(host)) {
      const ip = parseIp(host);
      if (!ip || ctx.denySet.matches(ip)) throw new UpstreamError('denied', false);
      ips = [host];
    } else {
      const checked = await Promise.race([
        checkPublicAddresses(ctx, host, tenantId),
        new Promise<never>((_, reject) =>
          ac.signal.addEventListener('abort', () => reject(failure(false, 'dns')), { once: true }),
        ),
      ]);
      if ('deny' in checked) throw new UpstreamError(checked.reason === 'denied_address' ? 'denied' : 'dns', false);
      ips = checked.ips;
    }
    if (ac.signal.aborted) throw failure(false, 'dns');

    return await new Promise<UpstreamResponse>((resolve, reject) => {
      let sent = false;
      const pinned = ips.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
      const req = https.request(
        {
          host,
          port: u.port ? Number(u.port) : 443,
          path: `${u.pathname}${u.search}`,
          method: init.method,
          headers: init.headers,
          servername: net.isIP(host) ? undefined : host,
          agent: false,
          signal: ac.signal,
          ...(ctx.mcpUpstreamCa ? { ca: ctx.mcpUpstreamCa } : {}),
          // The only name resolution of this request: connect to what was vetted, whatever DNS says now.
          lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) =>
            o?.all ? cb(null, pinned) : cb(null, pinned[0]!.address, pinned[0]!.family)) as never,
        },
        (res) => {
          if (res.statusCode! >= 300 && res.statusCode! < 400) {
            res.destroy();
            cleanup();
            return reject(new UpstreamError('redirect', false));
          }
          res.once('close', cleanup);
          res.on('error', () => undefined);
          resolve({ status: res.statusCode!, headers: res.headers, stream: res });
        },
      );
      req.once('finish', () => {
        sent = true;
      });
      req.once('error', () => reject(failure(sent, 'network')));
      req.end(init.body);
    });
  } catch (e) {
    cleanup();
    throw e instanceof UpstreamError ? e : failure(false, 'network');
  }
}
