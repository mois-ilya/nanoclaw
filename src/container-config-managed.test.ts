/**
 * Host-managed MCP servers (gateway connectors): merged into container.json AFTER the stored servers are
 * sanitized, so the stored-server URL rules stay strict; config-changed hooks; per-server `timeout`.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { GROUPS_TMP } = vi.hoisted(() => ({
  GROUPS_TMP: `${process.env.TMPDIR ?? '/tmp'}/nc-managed-${process.pid}-${Date.now()}`,
}));
vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  GROUPS_DIR: GROUPS_TMP,
}));
vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  materializeContainerJson,
  notifyConfigChanged,
  parseMcpServerConfig,
  setConfigChangedListener,
  setManagedMcpServersProvider,
} from './container-config.js';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { ensureContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { runMigrations } from './db/migrations/index.js';
import { log } from './log.js';

const GROUP = { id: 'ag-mg', name: 'mg', folder: 'mg', agent_provider: null, created_at: new Date().toISOString() };
const GATEWAY_URL = 'http://nanorelay:8081/mcp/github-3f9a1c2e';
const managed = { type: 'http' as const, url: GATEWAY_URL, timeout: 420000 };

function written(): { mcpServers: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(GROUPS_TMP, 'mg', 'container.json'), 'utf8'));
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup(GROUP);
  await ensureContainerConfig(GROUP.id);
  vi.mocked(log.warn).mockClear();
});
afterEach(async () => {
  setManagedMcpServersProvider(null);
  setConfigChangedListener(null);
  await closeDb();
});
afterEach(() => fs.rmSync(GROUPS_TMP, { recursive: true, force: true }));

describe('managed MCP servers', () => {
  it('are added to container.json, timeout included', async () => {
    setManagedMcpServersProvider(async (id) => (id === GROUP.id ? { github: managed } : ({} as Record<string, never>)));
    const cfg = await materializeContainerJson(GROUP.id);
    expect(cfg.mcpServers.github).toEqual(managed);
    expect(written().mcpServers.github).toEqual(managed);
  });

  it('are merged after sanitize: the stored-server rules still refuse the in-network URL', async () => {
    expect(() => parseMcpServerConfig({ type: 'http', url: GATEWAY_URL })).toThrow(/HTTPS/);
    // A stored entry with that URL is dropped by sanitize; the managed one still arrives.
    await updateContainerConfigJson(GROUP.id, 'mcp_servers', { sneaky: { type: 'http', url: GATEWAY_URL } });
    setManagedMcpServersProvider(async () => ({ github: managed }));
    const servers = (await materializeContainerJson(GROUP.id)).mcpServers;
    expect(Object.keys(servers)).toEqual(['github']);
  });

  it('override a same-named stored server and log a warning', async () => {
    await updateContainerConfigJson(GROUP.id, 'mcp_servers', {
      github: { type: 'http', url: 'https://other.example.com/mcp' },
      keep: { type: 'http', url: 'https://keep.example.com/mcp' },
    });
    setManagedMcpServersProvider(async () => ({ github: managed }));
    const servers = (await materializeContainerJson(GROUP.id)).mcpServers;
    expect(servers.github).toEqual(managed);
    expect(servers.keep).toMatchObject({ url: 'https://keep.example.com/mcp' });
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining('overrides'), expect.anything());
  });

  it('a failing provider or invalid name does not break the spawn', async () => {
    setManagedMcpServersProvider(async () => {
      throw new Error('db down');
    });
    expect((await materializeContainerJson(GROUP.id)).mcpServers).toEqual({});
    setManagedMcpServersProvider(async () => ({ __proto__: managed, 'bad name': managed, ok: managed }));
    expect(Object.keys((await materializeContainerJson(GROUP.id)).mcpServers)).toEqual(['ok']);
  });

  it('nothing changes without a provider', async () => {
    expect((await materializeContainerJson(GROUP.id)).mcpServers).toEqual({});
  });
});

describe('parseMcpServerConfig timeout', () => {
  it('passes a valid http timeout through and rejects bad ones', () => {
    const url = 'https://mcp.example.com/mcp';
    expect(parseMcpServerConfig({ type: 'http', url, timeout: 420000 })).toMatchObject({ timeout: 420000 });
    expect('timeout' in parseMcpServerConfig({ type: 'http', url })).toBe(false);
    for (const bad of [999, 3_600_001, 1.5, '420000', null]) {
      expect(() => parseMcpServerConfig({ type: 'http', url, timeout: bad })).toThrow(/timeout/);
    }
    expect(() => parseMcpServerConfig({ command: 'x', timeout: 5000 })).toThrow(/timeout/);
  });
});

describe('config-changed hook', () => {
  it('calls the listener, and swallows both sync and async listener failures', async () => {
    notifyConfigChanged('g', 'nobody listening');
    const calls: Array<[string, string]> = [];
    setConfigChangedListener((g, r) => void calls.push([g, r]));
    notifyConfigChanged('g1', 'mcp server added');
    expect(calls).toEqual([['g1', 'mcp server added']]);
    setConfigChangedListener(() => {
      throw new Error('sync');
    });
    expect(() => notifyConfigChanged('g1', 'x')).not.toThrow();
    setConfigChangedListener(async () => {
      throw new Error('async');
    });
    expect(() => notifyConfigChanged('g1', 'x')).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(2);
  });
});
