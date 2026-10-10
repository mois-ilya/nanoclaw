import { describe, expect, it } from 'vitest';
import { parseCidr, parseIp, CidrSet } from '../src/cidr.js';
import { periodBounds } from '../src/budget.js';
import { SseUsageParser, normalizeUsage } from '../src/sse-usage.js';
import { costMicros, reserveMicros, serverToolCapMicros, validatePrices } from '../src/pricing.js';
import { normalizePolicy, tailnetAllowed } from '../src/policy.js';
import { parseAuthority } from '../src/connect-proxy.js';
import { hashToken, mintToken, encrypt, decrypt } from '../src/tokens.js';
import { validateConfig, readApiKey } from '../src/config.js';
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
  const start = 'event: message_start\r\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":7,"output_tokens":1}}}\r\n\r\n';
  const delta = 'event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":9,"server_tool_use":{"web_search_requests":1}}}\r\n\r\n';
  it('is chunk-boundary independent, prices flat cache creation as 5m', () => {
    const p = new SseUsageParser();
    const all = Buffer.from(start + delta);
    for (let i = 0; i < all.length; i += 7) p.feed(all.subarray(i, i + 7));
    expect(p.sawDelta).toBe(true);
    expect(p.usage()).toMatchObject({ input: 5, output: 9, cacheCreation5m: 7, cacheCreation1h: 0, serverTools: { web_search: 1 } });
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
    expect(normalizeUsage({ input_tokens: 1, output_tokens: 1 }, { output_tokens: 8, input_tokens: 3 })).toMatchObject({ input: 3, output: 8 });
  });
});

describe('pricing', () => {
  const t = validatePrices(PRICES);
  it('computes cost from the table with 5m/1h split and server tools', () => {
    const u = normalizeUsage({ input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 10 }, server_tool_use: { web_search_requests: 2 } });
    expect(costMicros(t, 'm-1', u)).toBe(21154);
  });
  it('reserve is an over-estimate and server tool cap uses max_uses||10', () => {
    expect(reserveMicros(t, 'm-1', 1000, 300, 0)).toBe(15000 + 6 * 150); // bytes/2, dearest input rate
    expect(serverToolCapMicros(t, [{ type: 'web_search_20250305', max_uses: 3 }, { type: 'web_search_20250305' }, { name: 'x' }])).toBe(13 * 10000);
  });
  it('rejects malformed tables', () => {
    expect(() => validatePrices({ version: 'v', models: { a: { input: 1 } } })).toThrow();
  });
});

describe('policy', () => {
  it('validates and matches tailnetAllow', () => {
    const p = normalizePolicy({ egress: { tailnet: true, tailnetAllow: ['192.168.8.0/24:8123', '100.70.163.88/32:*', 'ha.x.ts.net:8123', '*.y.ts.net:22'] } });
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
    expect(periodBounds('America/New_York', Date.UTC(2026, 9, 15))).toEqual({ start: Date.UTC(2026, 9, 1, 4), end: Date.UTC(2026, 10, 1, 4) });
    expect(periodBounds('Asia/Tokyo', Date.UTC(2026, 11, 31, 16))).toEqual({ start: Date.UTC(2026, 11, 31, 15), end: Date.UTC(2027, 0, 31, 15) });
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
    expect(() => validateConfig({ ...base, connectLimits: { dnsPerTenant: 4, dnsGlobal: 4 } })).toThrow(/dnsPerTenant must be < dnsGlobal/);
    expect(() => validateConfig({ ...base, connectLimits: { dnsPerTenant: 5, dnsGlobal: 4 } })).toThrow(/dnsPerTenant/);
    expect(() => validateConfig({ ...base, connectLimits: { dnsPerTenant: 3, dnsGlobal: 4 } })).not.toThrow();
  });
  it('per-tenant body cap may not exceed the global cap', () => {
    expect(() => validateConfig({ ...base, anthropicLimits: { maxInflightBodyBytes: 100, maxInflightBodyBytesPerTenant: 200 } })).toThrow(/maxInflightBodyBytesPerTenant/);
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
      h: { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01, longContext: { aboveTokens: 100_000, input: 0.5, output: 2.5, cacheWrite5m: 0.625, cacheWrite1h: 1, cacheRead: 0.05 } },
    },
    serverTools: {},
  });
  const u = (input: number, cacheRead = 0) => ({ input, output: 1000, cacheCreation5m: 0, cacheCreation1h: 0, cacheRead, serverTools: {}, serviceTier: null });

  it('uses the base prices up to the threshold and the long-context prices above it (cache reads count)', () => {
    expect(costMicros(t, 'h', u(100_000))).toBe(Math.ceil(100_000 * 0.1 + 1000 * 0.5));
    expect(costMicros(t, 'h', u(60_000, 50_000))).toBe(Math.ceil(60_000 * 0.5 + 50_000 * 0.05 + 1000 * 2.5));
  });

  it('rejects a malformed tier', () => {
    expect(() => validatePrices({ version: 'v', models: { h: { input: 1, output: 1, cacheWrite5m: 1, cacheWrite1h: 1, cacheRead: 1, longContext: { aboveTokens: 0 } } } })).toThrow(/aboveTokens/);
  });

  it('the shipped default price file is valid and covers the default models and tools', () => {
    const file = JSON.parse(fs.readFileSync(new URL('../../nix/default-prices.json', import.meta.url), 'utf8'));
    const p = validatePrices(file);
    for (const m of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) expect(p.models[m]).toBeDefined();
    expect(p.serverTools.web_search).toBe(0.01);
  });
});
