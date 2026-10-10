/**
 * Self-modification MCP tools: install_packages, add_mcp_server.
 *
 * Both are fire-and-forget — the tool writes a system action row and returns
 * immediately. The host processes the request (including admin approval)
 * and notifies the agent via a chat message when complete. Admin approval
 * is approval to apply the change: `install_packages` auto-rebuilds the
 * per-agent image and restarts the container; `add_mcp_server` just
 * updates `container.json` and restarts (bun runs TS directly — no build
 * step needed for a pure MCP wiring change).
 *
 * Package names are sanitized here at the tool boundary AND re-validated on
 * the host side (defense in depth).
 */
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const APT_RE = /^[a-z0-9][a-z0-9._+-]*$/;
const NPM_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_PACKAGES = 20;

export const installPackages: McpToolDefinition = {
  tool: {
    name: 'install_packages',
    description:
      'Install apt and/or npm packages into YOUR per-agent container image. Requires admin approval; fire-and-forget. On approval, the image is rebuilt and the container is restarted automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        apt: {
          type: 'array',
          items: { type: 'string' },
          description: 'apt packages to install (names only, no version specs or flags)',
        },
        npm: {
          type: 'array',
          items: { type: 'string' },
          description: 'npm packages to install globally (names only, no version specs)',
        },
        reason: { type: 'string', description: 'Why these packages are needed' },
      },
    },
  },
  async handler(args) {
    const apt = (args.apt as string[]) || [];
    const npm = (args.npm as string[]) || [];
    if (apt.length === 0 && npm.length === 0) return err('At least one apt or npm package is required');
    if (apt.length + npm.length > MAX_PACKAGES) return err(`Maximum ${MAX_PACKAGES} packages per request`);

    const invalidApt = apt.find((p) => !APT_RE.test(p));
    if (invalidApt)
      return err(`Invalid apt package name: "${invalidApt}". Only lowercase letters, digits, and ._+- allowed.`);
    const invalidNpm = npm.find((p) => !NPM_RE.test(p));
    if (invalidNpm) return err(`Invalid npm package name: "${invalidNpm}". No version specs or shell characters.`);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'install_packages',
        apt,
        npm,
        reason: (args.reason as string) || '',
      }),
    });

    log(`install_packages: ${requestId} → apt=[${apt.join(',')}] npm=[${npm.join(',')}]`);
    return ok(`Package install request submitted. You will be notified when admin approves or rejects.`);
  },
};

/**
 * Query keys that name a credential: camelCase-normalized, then matched as
 * whole words between [_.-] separators (`author` never matches `auth`, but
 * `authToken` does) — the URL persists to the container config and renders
 * on the approval card, so secrets must ride via the configured gateway.
 */
const SECRET_QUERY_KEY_RE =
  /(^|[_.-])(o?auth(orization)?|(auth|access|api|session|id)?[_-]?token|secret|passw(or)?d|pwd|api[_-]?key|private[_-]?key|credentials?|bearer|jwt|sig(nature)?)([_.-]|$)/i;

/** camelCase → snake_case before matching, so `authToken` hits the word list. */
const CAMEL_SPLIT_RE = /([a-z0-9])([A-Z])/g;

type ParsedMcpServer = { type: 'http'; url: string };

/**
 * Names reach provider config writers with structural syntax —
 * e.g. mcpAllowPattern (providers/claude.ts) collapses non-[A-Za-z0-9_-] to
 * `_`, so unvalidated names could collide — hence a charset allowlist at
 * every entry point.
 */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Mirrors the host's validateAddMcpServer (src/modules/self-mod/request.ts) — the
 * host re-validates on receipt, but this copy answers the agent instantly.
 * No shared modules across the host/container boundary; keep the two in sync.
 * For now only remote HTTPS MCP servers that need no secrets are accepted:
 * no stdio commands, no env, no headers.
 */
function parseMcpServerInput(args: Record<string, unknown>): { config: ParsedMcpServer } | { error: string } {
  if (args.command !== undefined || args.args !== undefined || args.env !== undefined || args.headers !== undefined) {
    return {
      error:
        'only remote HTTPS MCP servers are supported for now: pass just `name` and `url` (no command, args, env or headers)',
    };
  }
  const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
  if (url === undefined) return { error: 'url is required (an HTTPS Streamable HTTP MCP endpoint)' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: 'url must be a valid HTTPS URL' };
  }
  if (parsed.protocol !== 'https:') return { error: 'url must use HTTPS' };
  if (parsed.username || parsed.password || parsed.hash) {
    return { error: 'url must not contain credentials or fragments; secrets are not supported yet' };
  }
  for (const key of parsed.searchParams.keys()) {
    if (SECRET_QUERY_KEY_RE.test(key.replace(CAMEL_SPLIT_RE, '$1_$2'))) {
      return { error: `url query parameter "${key}" looks like a credential; secrets are not supported yet` };
    }
  }
  return { config: { type: 'http', url } };
}

export const addMcpServer: McpToolDefinition = {
  tool: {
    name: 'add_mcp_server',
    description:
      'Wire an EXISTING remote MCP server (Streamable HTTP, HTTPS `url`, no secrets or headers) into YOUR per-agent runtime config. Requires owner approval; fire-and-forget.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'MCP server name (unique identifier)' },
        url: { type: 'string', description: 'Streamable HTTP MCP endpoint (HTTPS only)' },
      },
      required: ['name', 'url'],
    },
  },
  async handler(args) {
    const name = typeof args.name === 'string' ? args.name : '';
    if (!name) return err('name is required');
    if (!MCP_SERVER_NAME_RE.test(name)) {
      return err('server name must be 1-64 characters of letters, digits, "_" or "-"');
    }
    const parsed = parseMcpServerInput(args);
    if ('error' in parsed) return err(parsed.error);

    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'add_mcp_server',
        name,
        ...parsed.config,
      }),
    });

    log(`add_mcp_server: ${requestId} → "${name}" (HTTP)`);
    return ok(`MCP server request submitted. You will be notified when admin approves or rejects.`);
  },
};

registerTools([installPackages, addMcpServer]);
