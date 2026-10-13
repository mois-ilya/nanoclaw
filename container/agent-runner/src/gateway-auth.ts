/**
 * Session auth for gateway-hosted MCP servers.
 *
 * `container.json` is shared by every session of an agent group, so it cannot carry a session token. nanogate
 * serves connectors at `NC_MCP_GATEWAY_PREFIX<id>` and wants the session's own token as a Bearer header; the
 * host puts that token in ANTHROPIC_API_KEY. The header is added here, in memory, and never logged.
 */
import type { McpServerConfig } from './providers/types.js';

/** Returns `server` with an Authorization header when it is an http server under the gateway prefix. */
export function withGatewayAuth(
  server: McpServerConfig,
  env: Record<string, string | undefined> = process.env,
): McpServerConfig {
  const prefix = env.NC_MCP_GATEWAY_PREFIX;
  const key = env.ANTHROPIC_API_KEY;
  if (!prefix || !key || server.type !== 'http' || !server.url.startsWith(prefix)) return server;
  return { ...server, headers: { ...server.headers, Authorization: `Bearer ${key}` } };
}
