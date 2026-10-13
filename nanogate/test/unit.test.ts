import { describe, expect, it } from 'vitest';
import { parseCidr, parseIp, CidrSet } from '../src/cidr.js';
import { periodBounds } from '../src/budget.js';
import { SseUsageParser, normalizeUsage } from '../src/sse-usage.js';
import { costMicros, reserveMicros, serverToolCapMicros, validatePrices } from '../src/pricing.js';
import { checkRequest, isRejection, normalizePolicy, tailnetAllowed } from '../src/policy.js';
import { parseAuthority } from '../src/connect-proxy.js';
import { hashToken, mintToken, encrypt, decrypt } from '../src/tokens.js';
import { validateConfig, readApiKey } from '../src/config.js';
import { argFields } from '../src/mcp-approvals.js';
import { classify, parseRpc } from '../src/mcp-proxy.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRICES } from './harness.js';

describe('cidr', () => {
  it('folds IPv4-mapped IPv6 into IPv4', () => {
    expect(parseIp('::ffff:127.0.0.1')).toEqual(parseIp('127.0.0.1'));
    expect(parseIp('::ffff:7f00:1')).toEqual(parseIp('127.0.0.1'));
    expect(new CidrSet(['127.0.0.0/8']).matches('::ffff:127.0.0.1')).toBe(true);
  });
  it('matches v4 and v6 ranges and rejects junk', () => {
    expect(new CidrSet(['10.0.0.0/8', 'fc00::/7']).matches('10.255.0.1')).toBe(true);
    expect(new CidrSet(['10.0.0.0/8', 'fc00::/7']).matches('fd12::1')).toBe(true);
    expect(new CidrSet(['10.0.0.0/8']).matches('11.0.0.1')).toBe(false);
    expect(parseIp('1.2.3')).toBeNull();
    expect(parseIp('01.2.3.4')).toBeNull();
    expect(parseCidr('1.2.3.4/33')).toBeNull();
    expect(parseIp('1::2::3')).toBeNull();
  });
});

describe('authority parsing', () => {
  it('normalises hosts and rejects bad ones', () => {
    expect(parseAuthority('Example.COM.:443')).toEqual({ host: 'example.com', port: 443, isIp: false });
    expect(parseAuthority('0x7f.1:443')).toMatchObject({ host: '127.0.0.1', isIp: true });
    expect(parseAuthority('2130706433:80')).toMatchObject({ host: '127.0.0.1', isIp: true });
    expect(parseAuthority('[::1]:443')).toMatchObject({ host: '::1', isIp: true });
    expect(parseAuthority('bücher.de:443')?.host).toBe('xn--bcher-kva.de');
    expect(parseAuthority('a.com')).toBeNull();
    expect(parseAuthority('a.com:0')).toBeNull();
    expect(parseAuthority('a.com:70000')).toBeNull();
    expect(parseAuthority('a.com..:443')).toBeNull();
    expect(parseAuthority('user@a.com:443')).toBeNull();
  });
});

describe('sse usage parser', () => {
  const start =
    'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":7,"output_tokens":1}}}\r\n\r\n';
  const delta =
    'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":9,"server_tool_use":{"web_search_requests":1}}}\r\n\r\n';
  it('is chunk-boundary independent, prices flat cache creation as 5m', () => {
    const p = new SseUsageParser();
    const all = Buffer.from(start + delta);
    for (let i = 0; i < all.length; i += 7) p.feed(all.subarray(i, i + 7));
    expect(p.sawDelta).toBe(true);
    expect(p.usage()).toMatchObject({
      input: 5,
      output: 9,
      cacheCreation5m: 7,
      cacheCreation1h: 0,
      serverTools: { web_search: 1 },
    });
  });
  it('drops oversized events without losing the following ones', () => {
    const p = new SseUsageParser();
    p.feed('data: ' + 'x'.repeat(2 * 1024 * 1024));
    p.feed('\n' + start + delta);
    expect(p.sawDelta).toBe(true);
  });
  it('is not fooled by message_delta inside text', () => {
    const p = new SseUsageParser();
    p.feed('data: {"type":"content_block_delta","delta":{"text":"message_delta message_start"}}\n');
    expect(p.sawDelta).toBe(false);
  });
  it('normalizeUsage lets the later object win', () => {
    expect(normalizeUsage({ input_tokens: 1, output_tokens: 1 }, { output_tokens: 8, input_tokens: 3 })).toMatchObject({
      input: 3,
      output: 8,
    });
  });
});

describe('pricing', () => {
  const t = validatePrices(PRICES);
  it('computes cost from the table with 5m/1h split and server tools', () => {
    const u = normalizeUsage({
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 20,
      cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 10 },
      server_tool_use: { web_search_requests: 2 },
    });
    expect(costMicros(t, 'm-1', u)).toBe(21154);
  });
  it('reserve is an over-estimate and server tool cap uses max_uses||10', () => {
    expect(reserveMicros(t, 'm-1', 1000, 300, 0)).toBe(15000 + 6 * 150); // bytes/2, dearest input rate
    expect(
      serverToolCapMicros(t, [
        { type: 'web_search_20250305', max_uses: 3 },
        { type: 'web_search_20250305' },
        { name: 'x' },
      ]),
    ).toBe(13 * 10000);
  });
  it('rejects malformed tables', () => {
    expect(() => validatePrices({ version: 'v', models: { a: { input: 1 } } })).toThrow();
  });
});

describe('policy', () => {
  it('validates and matches tailnetAllow', () => {
    const p = normalizePolicy({
      egress: {
        tailnet: true,
        tailnetAllow: ['192.168.8.0/24:8123', '100.70.163.88/32:*', 'ha.x.ts.net:8123', '*.y.ts.net:22'],
      },
    });
    expect(tailnetAllowed(p, '192.168.8.5', parseIp('192.168.8.5'), 8123)).toBe(true);
    expect(tailnetAllowed(p, '192.168.8.5', parseIp('192.168.8.5'), 22)).toBe(false);
    expect(tailnetAllowed(p, '100.70.163.88', parseIp('100.70.163.88'), 9999)).toBe(true);
    expect(tailnetAllowed(p, 'ha.x.ts.net', null, 8123)).toBe(true);
    expect(tailnetAllowed(p, 'ha.x.ts.net', null, 22)).toBe(false);
    expect(tailnetAllowed(p, 'a.y.ts.net', null, 22)).toBe(true);
    expect(() => normalizePolicy({ egress: { tailnetAllow: ['nope'] } })).toThrow();
  });
});

describe('budget period', () => {
  it('uses the tenant timezone', () => {
    expect(periodBounds('America/New_York', Date.UTC(2026, 9, 15))).toEqual({
      start: Date.UTC(2026, 9, 1, 4),
      end: Date.UTC(2026, 10, 1, 4),
    });
    expect(periodBounds('Asia/Tokyo', Date.UTC(2026, 11, 31, 16))).toEqual({
      start: Date.UTC(2026, 11, 31, 15),
      end: Date.UTC(2027, 0, 31, 15),
    });
  });
});

describe('tokens', () => {
  it('are opaque ngs_/ngh_ and never look like sk- keys or JWTs', () => {
    const t = mintToken('session');
    expect(t).toMatch(/^ngs_[A-Za-z0-9_-]{43}$/);
    expect(mintToken('host')).toMatch(/^ngh_/);
    expect(t.includes('.')).toBe(false);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('AES-GCM round trips and rejects tampering', () => {
    const k = Buffer.alloc(32, 7);
    const e = encrypt(k, 'secret');
    expect(decrypt(k, e)).toBe('secret');
    const b = Buffer.from(e, 'base64');
    b[b.length - 1]! ^= 1;
    expect(() => decrypt(k, b.toString('base64'))).toThrow();
  });
});

describe('defaults', () => {
  it('policy admits the models Claude Code uses when none are listed', () => {
    expect(normalizePolicy({}).models).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']);
  });
  it('tunnel caps fit a real browser', () => {
    const c = validateConfig({ anthropicKeyFile: '/k', encryptionKeyFile: '/e', stateDir: '/s', prices: PRICES });
    expect(c.connectLimits.maxTunnelsPerTenant).toBeGreaterThanOrEqual(64);
    expect(c.connectLimits.maxTunnelsGlobal).toBeGreaterThan(c.connectLimits.maxTunnelsPerTenant);
  });
});

describe('config validation', () => {
  const base = { anthropicKeyFile: '/k', encryptionKeyFile: '/e', stateDir: '/s', prices: PRICES };
  it('dnsPerTenant must be below dnsGlobal', () => {
    expect(() => validateConfig({ ...base, connectLimits: { dnsPerTenant: 4, dnsGlobal: 4 } })).toThrow(
      /dnsPerTenant must be < dnsGlobal/,
    );
    expect(() => validateConfig({ ...base, connectLimits: { dnsPerTenant: 5, dnsGlobal: 4 } })).toThrow(/dnsPerTenant/);
    expect(() => validateConfig({ ...base, connectLimits: { dnsPerTenant: 3, dnsGlobal: 4 } })).not.toThrow();
  });
  it('per-tenant body cap may not exceed the global cap', () => {
    expect(() =>
      validateConfig({ ...base, anthropicLimits: { maxInflightBodyBytes: 100, maxInflightBodyBytesPerTenant: 200 } }),
    ).toThrow(/maxInflightBodyBytesPerTenant/);
  });
});

describe('readApiKey', () => {
  it('accepts a raw key and the old ANTHROPIC_API_KEY= env line', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-key-'));
    const f = path.join(d, 'k');
    fs.writeFileSync(f, 'sk-ant-raw\n');
    expect(readApiKey(f)).toBe('sk-ant-raw');
    fs.writeFileSync(f, 'ANTHROPIC_API_KEY=sk-ant-raw\n');
    expect(readApiKey(f)).toBe('sk-ant-raw');
    fs.rmSync(d, { recursive: true });
  });
});

describe('prompt-length price tiers', () => {
  const t = validatePrices({
    version: 'v',
    models: {
      h: {
        input: 0.1,
        output: 0.5,
        cacheWrite5m: 0.125,
        cacheWrite1h: 0.2,
        cacheRead: 0.01,
        longContext: {
          aboveTokens: 100_000,
          input: 0.5,
          output: 2.5,
          cacheWrite5m: 0.625,
          cacheWrite1h: 1,
          cacheRead: 0.05,
        },
      },
    },
    serverTools: {},
  });
  const u = (input: number, cacheRead = 0) => ({
    input,
    output: 1000,
    cacheCreation5m: 0,
    cacheCreation1h: 0,
    cacheRead,
    serverTools: {},
    serviceTier: null,
  });

  it('uses the base prices up to the threshold and the long-context prices above it (cache reads count)', () => {
    expect(costMicros(t, 'h', u(100_000))).toBe(Math.ceil(100_000 * 0.1 + 1000 * 0.5));
    expect(costMicros(t, 'h', u(60_000, 50_000))).toBe(Math.ceil(60_000 * 0.5 + 50_000 * 0.05 + 1000 * 2.5));
  });

  it('rejects a malformed tier', () => {
    expect(() =>
      validatePrices({
        version: 'v',
        models: {
          h: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, longContext: { aboveTokens: 0 } },
        },
      }),
    ).toThrow(/aboveTokens/);
  });

  it('the shipped default price file is valid and covers the default models and tools', () => {
    const file = JSON.parse(fs.readFileSync(new URL('../../nix/default-prices.json', import.meta.url), 'utf8'));
    const p = validatePrices(file);
    for (const m of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) expect(p.models[m]).toBeDefined();
    expect(p.serverTools.web_search).toBe(0.01);
  });
});

describe('Claude Code tool search and 1h cache request shape', () => {
  // Captured from Claude Code 2.1.280 with ENABLE_TOOL_SEARCH=true + CLAUDE_CODE_PROMPT_CACHE_TTL=1h against a
  // non-first-party ANTHROPIC_BASE_URL: ToolSearch is a custom tool (no `type`), deferred tools carry
  // defer_loading:true, and the ToolSearch result is a tool_result holding tool_reference blocks.
  const cfg = validateConfig({ anthropicKeyFile: '/k', encryptionKeyFile: '/e', stateDir: '/s', prices: PRICES });
  const policy = normalizePolicy({ models: ['m-1'] });
  const cc = { type: 'ephemeral', ttl: '1h' };
  const body = () => ({
    model: 'm-1',
    max_tokens: 1024,
    system: [{ type: 'text', text: 'You are a Claude agent.', cache_control: cc }],
    tools: [
      { name: 'Bash', description: 'd', input_schema: { type: 'object', properties: {} } },
      { name: 'ToolSearch', description: 'd', input_schema: { type: 'object', properties: {} } },
      {
        name: 'mcp__ext__ping',
        description: 'd',
        input_schema: { type: 'object', properties: {} },
        defer_loading: true,
      },
    ],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'ToolSearch',
            input: { query: 'select:mcp__ext__ping' },
            cache_control: cc,
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'tool_reference', tool_name: 'mcp__ext__ping' }],
          },
          { type: 'text', text: 'Tool loaded.' },
        ],
      },
    ],
  });
  const betas =
    'claude-code-20250219,advanced-tool-use-2025-11-20,extended-cache-ttl-2025-04-11,mid-conversation-system-2026-04-07';

  it('passes the request unchanged and keeps the tool-search and 1h-cache betas', () => {
    const r = checkRequest(policy, PRICES, cfg.defaultBetas, body(), betas, true);
    expect(isRejection(r)).toBe(false);
    if (isRejection(r)) return;
    expect(r.body.tools).toEqual(body().tools);
    expect(r.body.messages).toEqual(body().messages);
    expect(r.betas).toBe('claude-code-20250219,advanced-tool-use-2025-11-20,extended-cache-ttl-2025-04-11');
    expect(r.droppedBetas).toEqual(['mid-conversation-system-2026-04-07']);
  });

  it('also keeps the fallback tool-search beta name', () => {
    const r = checkRequest(policy, PRICES, cfg.defaultBetas, body(), 'tool-search-tool-2025-10-19', true);
    expect(isRejection(r) ? null : r.betas).toBe('tool-search-tool-2025-10-19');
  });

  it('prices 1h cache writes at the 1h rate, not the 5m rate', () => {
    const u = normalizeUsage({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 },
    });
    expect(costMicros(PRICES as never, 'm-1', u)).toBe(1000 * 6);
  });
});

describe('mcp classify (asks)', () => {
  it('unknown and non-read-only tools ask; read-only passes; policy overrides either way', () => {
    expect(classify({}, 't', undefined)).toBe(true);
    expect(classify({}, 't', false)).toBe(true);
    expect(classify({}, 't', true)).toBe(false);
    expect(classify({ t: 'ask' }, 't', true)).toBe(true);
    expect(classify({ t: 'auto' }, 't', false)).toBe(false);
    expect(classify({ t: 'auto' }, 't', undefined)).toBe(false);
    expect(classify({ other: 'auto' }, 't', false)).toBe(true);
    // inherited property names are not policy entries
    expect(classify({}, 'constructor', true)).toBe(false);
    expect(classify({}, '__proto__', undefined)).toBe(true);
  });
});

describe('mcp card fields', () => {
  it('one field per top-level argument; strings as-is, the rest as JSON; short text, longer long_text', () => {
    expect(argFields({ title: 'hi', n: 3, flag: true, list: [1, 2], none: null })).toEqual([
      { label: 'title', type: 'text', value: 'hi' },
      { label: 'n', type: 'text', value: '3' },
      { label: 'flag', type: 'text', value: 'true' },
      { label: 'list', type: 'text', value: '[1,2]' },
      { label: 'none', type: 'text', value: 'null' },
    ]);
    const f = argFields({ body: 'x'.repeat(81) })[0]!;
    expect(f.type).toBe('long_text');
    expect(argFields(undefined)).toEqual([]);
    expect(argFields(null)).toEqual([]);
  });

  it('truncates with an explicit marker: 1200 for long_text (and never past the host validator limits)', () => {
    const f = argFields({ body: 'y'.repeat(5000) })[0]!;
    expect(f.value).toBe(`${'y'.repeat(1200)}… (+3800 симв.)`);
    expect(f.value.length).toBeLessThan(32768);
    const long = argFields({ k: 'z'.repeat(81) })[0]!;
    expect(long.value.length).toBe(81);
    const label = argFields({ ['l'.repeat(500)]: 1 })[0]!.label;
    expect(label.length).toBeLessThan(200); // gatewayApprovalPresentation: label <= 200
  });

  it('masks secret-named fields at any depth and keeps the rest', () => {
    const f = argFields({
      token: 'a',
      Password: 'b',
      api_key: 'c',
      Authorization: 'd',
      client_secret: 'e',
      cfg: { nested: { accessToken: 'f', keep: 'visible' }, list: [{ secret: 'g', ok: 1 }] },
    });
    const all = JSON.stringify(f);
    for (const leak of ['"a"', '"b"', '"c"', '"d"', '"e"', '"f"', '"g"']) expect(all).not.toContain(leak);
    for (const name of ['token', 'Password', 'api_key', 'Authorization', 'client_secret'])
      expect(f.find((x) => x.label === name)!.value).toBe('•••');
    expect(all).toContain('visible');
    expect(all).toContain('•••');
  });

  it('does not show a subtree that is too deep to check', () => {
    let deep: unknown = { password: 'hunter2' };
    for (let i = 0; i < 12; i++) deep = { n: deep };
    expect(JSON.stringify(argFields({ cfg: deep }))).not.toContain('hunter2');
  });

  it('caps at 12 fields with a trailing "ещё N полей" field', () => {
    const args = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    const f = argFields(args);
    expect(f).toHaveLength(12);
    expect(f[10]!.label).toBe('k10');
    expect(f[11]).toEqual({ label: '…', type: 'text', value: 'ещё 9 полей' });
    expect(argFields(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])))).toHaveLength(12);
    expect(argFields({ a: 1 })).toHaveLength(1);
  });
});

describe('mcp parseRpc', () => {
  it('reads JSON and SSE bodies and skips junk', () => {
    expect(parseRpc('application/json', '{"id":1,"result":{}}')).toEqual([{ id: 1, result: {} }]);
    expect(
      parseRpc('text/event-stream', 'event: message\ndata: {"id":2}\n\n: ping\n\ndata: nope\n\ndata: {"id":3}\n\n'),
    ).toEqual([{ id: 2 }, { id: 3 }]);
    expect(parseRpc('application/json', 'garbage')).toEqual([]);
  });
});

describe('mcp config', () => {
  it('has defaults, validates, and mcpPort follows listen', () => {
    const base = {
      anthropicKeyFile: 'k',
      stateDir: 's',
      encryptionKeyFile: 'e',
      prices: { version: 'v', models: {}, serverTools: {} },
    };
    const c = validateConfig(base);
    expect(c.listen.mcpPort).toBe(8081);
    expect(c.mcp).toEqual({
      holdMs: 300000,
      upstreamTimeoutMs: 60000,
      maxPendingPerTenant: 4,
      maxPendingTotal: 16,
      maxBodyBytes: 1048576,
      maxListBytes: 8388608,
      socketIdleMs: 600000,
      callsRetentionDays: 30,
    });
    expect(() => validateConfig({ ...base, mcp: { holdMs: -1 } })).toThrow(/mcp.holdMs/);
    expect(() => validateConfig({ ...base, mcp: { maxPendingPerTenant: 9, maxPendingTotal: 3 } })).toThrow(
      /maxPendingPerTenant/,
    );
  });
});
