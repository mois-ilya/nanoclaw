import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nanogatePolicy } from './tenants.js';
import { OWNER } from './test-helpers.js';

beforeEach(() => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
});
afterEach(() => {
  for (const k of [
    'NC_OWNER_TAILNET_ALLOW',
    'NC_OWNER_TAILNET_CIDRS',
    'NC_MODEL_GUEST',
    'NC_MODEL_FAST',
    'NC_MODEL_NORMAL',
    'NC_MODEL_SMALL',
  ])
    delete process.env[k];
});

describe('nanogate tenant policy', () => {
  it('owner: the configured Home Assistant / LAN allowlist is pushed, and tailnet is on only when it is non-empty', () => {
    expect(nanogatePolicy('owner', 'direct').egress).toMatchObject({ tailnet: false, tailnetAllow: [] });
    process.env.NC_OWNER_TAILNET_ALLOW = '192.168.8.0/24:8123, homeassistant:8123';
    const eg = nanogatePolicy('owner', 'residential').egress;
    expect(eg).toMatchObject({
      route: 'connector',
      tailnet: true,
      tailnetAllow: ['192.168.8.0/24:8123', 'homeassistant:8123'],
    });
  });

  it('friend «через дом» uses the OWNER connector (otherwise nanogate answers 502 connector_down), with no tailnet', () => {
    const eg = nanogatePolicy('friend', 'residential').egress as Record<string, unknown>;
    expect(eg.route).toBe('connector');
    expect(eg.connectorTenant).toBe(`telegram:${OWNER}`);
    expect(eg.tailnet).toBe(false);
    expect(eg.tailnetAllow).toBeUndefined();
    expect((nanogatePolicy('friend', 'direct').egress as Record<string, unknown>).connectorTenant).toBeUndefined();
  });

  it('friend connectorTenant follows the owner gate id passed by the caller (epoch-aware)', () => {
    const eg = nanogatePolicy('friend', 'residential', `telegram:${OWNER}.e2`).egress as Record<string, unknown>;
    expect(eg.connectorTenant).toBe(`telegram:${OWNER}.e2`);
  });

  it('owner gets a rolling-window spend cap ($15 by default), friends none', () => {
    expect(nanogatePolicy('owner', 'direct').perTurnCapMicros).toBe(15_000_000);
    expect(nanogatePolicy('friend', 'direct').perTurnCapMicros).toBeUndefined();
  });

  it('the guest model is allowed for the owner even when it is not one of the preset models', () => {
    process.env.NC_MODEL_GUEST = 'claude-guest-x';
    process.env.NC_MODEL_FAST = 'claude-sonnet-5-5';
    expect(nanogatePolicy('owner', 'direct').models).toContain('claude-guest-x');
    expect(nanogatePolicy('friend', 'direct').models).not.toContain('claude-guest-x');
  });

  it('the small model (WebFetch, Explore subagents) is allowed for owner and friends, and follows NC_MODEL_SMALL', () => {
    expect(nanogatePolicy('owner', 'direct').models).toContain('claude-haiku-5-5');
    expect(nanogatePolicy('friend', 'direct').models).toContain('claude-haiku-5-5');
    process.env.NC_MODEL_SMALL = 'claude-haiku-x';
    expect(nanogatePolicy('friend', 'direct').models).toContain('claude-haiku-x');
  });
});
