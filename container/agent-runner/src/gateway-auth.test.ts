import { describe, expect, it } from 'bun:test';

import { withGatewayAuth } from './gateway-auth.js';
import type { McpServerConfig } from './providers/types.js';

const ENV = { NC_MCP_GATEWAY_PREFIX: 'http://nanorelay:8081/mcp/', ANTHROPIC_API_KEY: 'ngs_token' };
const gw: McpServerConfig = { type: 'http', url: 'http://nanorelay:8081/mcp/github-3f9a1c2e', timeout: 420000 };

describe('withGatewayAuth', () => {
  it('adds the session token as a Bearer header for a URL under the gateway prefix', () => {
    expect(withGatewayAuth(gw, ENV)).toEqual({ ...gw, headers: { Authorization: 'Bearer ngs_token' } });
  });

  it('keeps existing headers, and does not mutate the input', () => {
    const input: McpServerConfig = { ...gw, headers: { 'X-Other': '1' } } as McpServerConfig;
    const out = withGatewayAuth(input, ENV);
    expect((out as { headers: Record<string, string> }).headers).toEqual({
      'X-Other': '1',
      Authorization: 'Bearer ngs_token',
    });
    expect((input as { headers: Record<string, string> }).headers).toEqual({ 'X-Other': '1' });
  });

  it('leaves servers outside the prefix, stdio servers and lookalike hosts untouched', () => {
    const other: McpServerConfig = { type: 'http', url: 'https://mcp.example.com/mcp' };
    const lookalike: McpServerConfig = { type: 'http', url: 'http://nanorelay:8081/other/x' };
    const stdio: McpServerConfig = { command: 'bun', args: ['run', 'x'] };
    expect(withGatewayAuth(other, ENV)).toBe(other);
    expect(withGatewayAuth(lookalike, ENV)).toBe(lookalike);
    expect(withGatewayAuth(stdio, ENV)).toBe(stdio);
  });

  it('does nothing without a key or without a prefix', () => {
    expect(withGatewayAuth(gw, { NC_MCP_GATEWAY_PREFIX: ENV.NC_MCP_GATEWAY_PREFIX })).toBe(gw);
    expect(withGatewayAuth(gw, { ...ENV, ANTHROPIC_API_KEY: '' })).toBe(gw);
    expect(withGatewayAuth(gw, { ANTHROPIC_API_KEY: 'ngs_token' })).toBe(gw);
    expect(withGatewayAuth(gw, { ...ENV, NC_MCP_GATEWAY_PREFIX: '' })).toBe(gw);
  });
});
