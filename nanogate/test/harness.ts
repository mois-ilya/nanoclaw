import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { type Config, validateConfig } from '../src/config.js';
import type { Resolver } from '../src/context.js';
import { type Nanogate, type NanogateOptions, startNanogate } from '../src/server.js';

export const PRICES = {
  version: 'test-1',
  models: {
    'm-1': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
    'm-unpriced-allowed': { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1 },
  },
  serverTools: { web_search: 0.01, web_fetch: 0 },
};

export interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, any>;
}

/** Fake Anthropic. Behaviour is chosen by the first user message text. */
export async function fakeUpstream() {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push({ path: req.url!, headers: req.headers, body });
      const mode = String(body.messages?.[0]?.content ?? '');
      const startEv = `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'm-1', usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 60, cache_read_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 10 }, service_tier: 'standard' } } })}\n\n`;
      const delta = `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 2 } } })}\n\n`;
      const text = `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })}\n\n`;
      if (req.url!.endsWith('/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end('{"input_tokens":7}');
      }
      if (mode === '529') {
        res.writeHead(529, { 'content-type': 'application/json' });
        return void res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
      }
      if (mode === 'json' || mode === 'slow') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void setTimeout(
          () =>
            res.end(
              JSON.stringify({
                id: 'msg_2',
                usage: {
                  input_tokens: 10,
                  output_tokens: 20,
                  cache_creation_input_tokens: 4,
                  cache_read_input_tokens: 0,
                },
              }),
            ),
          mode === 'slow' ? 150 : 0,
        );
      }
      if (mode === 'abort') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(startEv + text);
        return void setTimeout(() => res.destroy(), 30);
      }
      const delay = mode === 'hang' ? 5000 : 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(startEv + text);
      // split the final event across writes to exercise the line buffer
      setTimeout(() => {
        res.write(delta.slice(0, 20));
        res.write(delta.slice(20));
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, delay);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    server,
    seen,
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export async function makeGate(over: Record<string, unknown> = {}, resolver?: Resolver, opts: NanogateOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-'));
  const up = await fakeUpstream();
  fs.writeFileSync(path.join(dir, 'key'), 'sk-ant-REAL-KEY\n');
  fs.writeFileSync(path.join(dir, 'enc'), 'a'.repeat(64));
  const config: Config = validateConfig({
    anthropicKeyFile: path.join(dir, 'key'),
    encryptionKeyFile: path.join(dir, 'enc'),
    stateDir: path.join(dir, 'state'),
    upstream: `http://127.0.0.1:${up.port}`,
    prices: PRICES,
    listen: {
      bind: '127.0.0.1',
      anthropicPort: 0,
      connectPort: 0,
      hostPort: 0,
      mcpPort: 0,
      adminSocket: path.join(dir, 'a.sock'),
    },
    ...over,
  });
  const gate: Nanogate = await startNanogate(config, {
    log: () => undefined,
    ...(resolver ? { resolver } : {}),
    ...opts,
  });

  const admin = (method: string, p: string, body?: unknown) =>
    new Promise<{ status: number; json: any; raw: string }>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const r = http.request(
        {
          socketPath: gate.adminSocket,
          method,
          path: p,
          headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
        },
        (res) => {
          const cs: Buffer[] = [];
          res.on('data', (c) => cs.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(cs).toString();
            resolve({ status: res.statusCode!, raw, json: raw ? JSON.parse(raw) : null });
          });
        },
      );
      r.on('error', reject);
      r.end(data);
    });

  const defaultPolicy = {
    models: ['m-1', 'm-unpriced-allowed', 'm-not-priced'],
    maxTokens: 2000,
    betas: ['beta-x'],
    serverTools: ['web_search'],
    maxConcurrentRequests: 50,
    egress: { route: 'direct', ports: [443] },
  };
  const tenant = async (id: string, over: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) => {
    const r = await admin('PUT', `/tenants/${id}`, {
      kind: 'friend',
      policy: { ...defaultPolicy, ...policy },
      budgetLimitMicros: null,
      periodTz: 'UTC',
      ...over,
    });
    if (r.status !== 200) throw new Error(`tenant: ${r.raw}`);
  };
  const session = async (tenantId: string, sessionKey = `s-${tenantId}`) =>
    (await admin('POST', '/sessions/ensure', { tenantId, sessionKey, runtimeIdentity: 'rt', disposition: 'create' }))
      .json.token as string;

  const messages = async (
    token: string,
    content: string,
    extra: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    port = gate.ports.anthropic,
    p = '/anthropic/v1/messages',
  ) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': token,
          'anthropic-version': '2023-06-01',
          ...headers,
        },
        body: JSON.stringify({ model: 'm-1', max_tokens: 100, messages: [{ role: 'user', content }], ...extra }),
      });
      const text = await res.text().catch(() => '[aborted]');
      return { status: res.status, headers: res.headers, text };
    } catch (e) {
      return { status: 0, headers: new Headers(), text: String(e) };
    }
  };

  const usageRows = () => gate.ctx.db.prepare('SELECT * FROM usage ORDER BY id').all() as any[];
  return {
    gate,
    up,
    dir,
    admin,
    tenant,
    session,
    messages,
    usageRows,
    async close() {
      await gate.close();
      await up.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Gate = Awaited<ReturnType<typeof makeGate>>;

export function echoServer(): Promise<{ port: number; close(): void }> {
  return new Promise((resolve) => {
    const socks = new Set<net.Socket>();
    const s = net.createServer((c) => {
      socks.add(c);
      c.on('close', () => socks.delete(c));
      c.on('error', () => undefined);
      c.pipe(c);
    });
    s.listen(0, '127.0.0.1', () =>
      resolve({
        port: (s.address() as net.AddressInfo).port,
        close: () => {
          socks.forEach((c) => c.destroy());
          s.close();
        },
      }),
    );
  });
}

/** Minimal SOCKS5 server that records the requested target and always connects to `to`. */
export function fakeSocks(to: { host: string; port: number }) {
  const targets: { atyp: number; host: string; port: number }[] = [];
  const socks = new Set<net.Socket>();
  const server = net.createServer((c) => {
    socks.add(c);
    c.on('error', () => undefined);
    c.once('data', () => {
      c.write(Buffer.from([5, 0]));
      c.once('data', (d) => {
        const atyp = d[3]!;
        let host: string;
        let off: number;
        if (atyp === 1) {
          host = [...d.subarray(4, 8)].join('.');
          off = 8;
        } else if (atyp === 3) {
          host = d.subarray(5, 5 + d[4]!).toString();
          off = 5 + d[4]!;
        } else {
          host = d.subarray(4, 20).toString('hex');
          off = 20;
        }
        targets.push({ atyp, host, port: d.readUInt16BE(off) });
        const up = net.connect(to.port, to.host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          c.pipe(up);
          up.pipe(c);
        });
        up.on('error', () => c.destroy());
        c.on('close', () => up.destroy());
      });
    });
  });
  return new Promise<{ addr: string; targets: typeof targets; close(): void }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        addr: `127.0.0.1:${(server.address() as net.AddressInfo).port}`,
        targets,
        close: () => {
          socks.forEach((c) => c.destroy());
          server.close();
        },
      }),
    ),
  );
}

/** Raw CONNECT; resolves with the status line, headers and the (open) socket. */
export function proxyConnect(
  port: number,
  authority: string,
  auth?: string,
): Promise<{ status: number; reason: string | undefined; socket: net.Socket; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let buf = Buffer.alloc(0);
    s.on('error', reject);
    s.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      s.removeListener('data', onData);
      const head = buf.subarray(0, i).toString();
      const reason = /x-nanogate-reason: (\S+)/i.exec(head)?.[1];
      resolve({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(head)![1]), reason, socket: s, rest: buf.subarray(i + 4) });
    });
    s.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`,
    );
  });
}

export const basic = (token: string) => `Basic ${Buffer.from(`x:${token}`).toString('base64')}`;

export function readN(s: net.Socket, n: number): Promise<string> {
  return new Promise((resolve) => {
    let b = '';
    s.on('data', (d) => {
      b += d.toString();
      if (b.length >= n) resolve(b);
    });
  });
}

/** CONNECT that also resolves when the proxy just closes the socket (no status line). */
export function rawConnect(port: number, authority: string, auth?: string) {
  const socket = net.connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  let buf = '';
  socket.on('data', (d) => (buf += d.toString()));
  const closed = new Promise<string>((resolve) => socket.on('close', () => resolve(buf)));
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`,
  );
  return {
    socket,
    closed,
    status: () => Number(/^HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0),
    reason: () => /x-nanogate-reason: (\S+)/i.exec(buf)?.[1],
  };
}

/** POST that lets the test control body timing. Resolves with the response, or status 0 if the socket dies. */
export function slowPost(
  port: number,
  token: string,
  headers: Record<string, string | number> = {},
  path = '/anthropic/v1/messages',
) {
  let resolveRes!: (v: { status: number; text: string }) => void;
  const result = new Promise<{ status: number; text: string }>((r) => (resolveRes = r));
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: { 'x-api-key': token, 'content-type': 'application/json', ...headers },
    },
    (res) => {
      const cs: Buffer[] = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => resolveRes({ status: res.statusCode!, text: Buffer.concat(cs).toString() }));
      res.on('error', () => resolveRes({ status: 0, text: '' }));
    },
  );
  req.on('error', () => resolveRes({ status: 0, text: '' }));
  return { req, result };
}
