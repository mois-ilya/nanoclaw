import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { markGroupConfigDirty, groupApplying } = vi.hoisted(() => ({
  markGroupConfigDirty: vi.fn(async () => undefined),
  groupApplying: vi.fn(async () => false),
}));
vi.mock('./config-apply.js', () => ({ markGroupConfigDirty, groupApplying }));

import { INSTALL_SLUG } from '../config.js';
import { closeDb, createAgentGroup } from '../db/index.js';
import { getDb } from '../db/connection.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import {
  ConnectorError,
  connectorCalls,
  connectorView,
  connectorViews,
  createConnector,
  deleteConnectorsOfUser,
  getConnector,
  listConnectors,
  managedServersFor,
  markKeyRejected,
  parsePolicy,
  pushConnector,
  removeConnector,
  removeConnectorKey,
  saveConnectorKey,
  syncAllConnectors,
  updateConnector,
} from './mcp-connectors.js';
import { gateIdOf, getTenantByTg, insertTenantIfAbsent, updateTenant, type Tenant } from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, setupDb } from './test-helpers.js';

const PAT = `ghp_${'a1B2'.repeat(9)}`;
let ng: ReturnType<typeof fakeNanogate>;
let owner: Tenant;

async function mkTenant(tgId: number, folder: string): Promise<Tenant> {
  const gid = `ag-${folder}`;
  await createAgentGroup({ id: gid, name: folder, folder, agent_provider: null, created_at: new Date().toISOString() });
  await insertTenantIfAbsent({ tgId, name: folder, state: 'ready' });
  await updateTenant(tgId, { agent_group_id: gid });
  return (await getTenantByTg(tgId))!;
}

const OWN_TAG = createHash('sha1').update(INSTALL_SLUG).digest('hex').slice(0, 4);

/** What nanogate's probe of the candidate key finds at the upstream. */
function upstream(status: number | 'offline') {
  ng.probeMcpConnector.mockResolvedValue(
    status === 'offline'
      ? { ok: false, error: 'upstream_unreachable' }
      : status === 401
        ? { ok: false, error: 'key_rejected', status }
        : { ok: true, tools: 3 },
  );
  return ng.probeMcpConnector;
}

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  vi.clearAllMocks();
  await setupDb();
  ng = fakeNanogate();
  setNanogateAdminForTests(ng);
  owner = await mkTenant(OWNER, 'owner');
});
afterEach(async () => {
  vi.restoreAllMocks();
  setNanogateAdminForTests(null);
  await closeDb();
});

describe('connector rows', () => {
  it('creates a disabled connector without a key; a repeat is a conflict; unknown catalog id is invalid', async () => {
    const row = await createConnector(owner.user_id, 'github');
    expect(row).toMatchObject({
      catalog_id: 'github',
      url: 'https://api.githubcopilot.com/mcp/',
      enabled: 0,
      key_saved_at: null,
      key_status: null,
      rev: 1,
    });
    expect(row.id).toMatch(new RegExp(`^github-${OWN_TAG}[0-9a-f]{8}$`));
    expect(row.secret_name).toBe(`mcp.${row.id}`);
    await expect(createConnector(owner.user_id, 'github')).rejects.toMatchObject({ code: 'conflict' });
    await expect(createConnector(owner.user_id, 'nope')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('another tenant cannot touch the connector: it looks missing', async () => {
    const row = await createConnector(owner.user_id, 'github');
    const friend = await mkTenant(FRIEND_A, 'fa');
    await expect(updateConnector(friend, row.id, { readOnly: true })).rejects.toMatchObject({ code: 'not_found' });
    await expect(saveConnectorKey(friend, row.id, PAT)).rejects.toMatchObject({ code: 'not_found' });
    await expect(removeConnector(friend, row.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(ng.putSecret).not.toHaveBeenCalled();
  });
});

describe('key', () => {
  it('first key: verified, written only to nanogate, switches the connector on and marks the group', async () => {
    const f = upstream(200);
    const row0 = await createConnector(owner.user_id, 'github');
    const { row, warning } = await saveConnectorKey(owner, row0.id, `  ${PAT}  `);
    expect(warning).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith(row0.id, PAT); // the candidate goes to nanogate's in-memory probe, trimmed
    expect(ng.putSecret).toHaveBeenCalledWith(gateIdOf(owner), row0.secret_name, PAT);
    expect(row).toMatchObject({ enabled: 1, key_status: 'ok', rev: 2 });
    expect(row.key_saved_at).toBeTruthy();
    // pushed with the current gate id, enabled, then probed to fill the tool list
    expect(ng.putMcpConnector).toHaveBeenLastCalledWith(
      row0.id,
      expect.objectContaining({ tenantId: gateIdOf(owner), enabled: true, secretName: row0.secret_name }),
    );
    expect(markGroupConfigDirty).toHaveBeenCalledWith('ag-owner', 'connector key set');
    // the value is nowhere in the row, the view or the audit trail
    const dump = JSON.stringify([
      await getDb().all('SELECT * FROM nc_mcp_connectors'),
      await getDb().all('SELECT * FROM nc_audit'),
      await connectorView(owner, row),
    ]);
    expect(dump).not.toContain(PAT);
  });

  it('a rejected candidate leaves the old key in place and writes nothing', async () => {
    upstream(200);
    const row0 = await createConnector(owner.user_id, 'github');
    await saveConnectorKey(owner, row0.id, PAT);
    ng.putSecret.mockClear();
    ng.deleteSecret.mockClear();
    markGroupConfigDirty.mockClear();
    upstream(401);
    await expect(saveConnectorKey(owner, row0.id, `ghp_${'Z9y8'.repeat(9)}`)).rejects.toMatchObject({
      code: 'key_rejected',
      message: 'GitHub не принял ключ',
    });
    expect(ng.putSecret).not.toHaveBeenCalled();
    expect(ng.deleteSecret).not.toHaveBeenCalled();
    expect(markGroupConfigDirty).not.toHaveBeenCalled();
    expect(await getConnector(row0.id)).toMatchObject({ key_status: 'ok', enabled: 1, rev: 2 });
  });

  it('a malformed token never reaches the upstream', async () => {
    const f = upstream(200);
    const row0 = await createConnector(owner.user_id, 'github');
    await expect(saveConnectorKey(owner, row0.id, 'not-a-token')).rejects.toBeInstanceOf(ConnectorError);
    await expect(saveConnectorKey(owner, row0.id, 42)).rejects.toMatchObject({ code: 'invalid' });
    expect(f).not.toHaveBeenCalled();
  });

  it('an unreachable upstream keeps the key as unverified with a warning', async () => {
    upstream('offline');
    const row0 = await createConnector(owner.user_id, 'github');
    const { row, warning } = await saveConnectorKey(owner, row0.id, PAT);
    expect(row).toMatchObject({ key_status: 'unverified', enabled: 1 });
    expect(warning).toMatch(/не проверен/);
    expect((await connectorView(owner, row)).status).toBe('upstream_error');
  });

  it('a probe that cannot reach nanogate or the upstream still saves the key as unverified', async () => {
    upstream(200);
    ng.probeMcpConnector.mockRejectedValueOnce(new Error('down'));
    const row0 = await createConnector(owner.user_id, 'github');
    const { row, warning } = await saveConnectorKey(owner, row0.id, PAT);
    expect(row.key_status).toBe('unverified');
    expect(warning).toMatch(/не проверен/);
  });

  it('a new key does not re-enable a connector the owner switched off', async () => {
    upstream(200);
    const row0 = await createConnector(owner.user_id, 'github');
    await saveConnectorKey(owner, row0.id, PAT);
    await updateConnector(owner, row0.id, { enabled: false });
    const { row } = await saveConnectorKey(owner, row0.id, `ghp_${'Q1w2'.repeat(9)}`);
    expect(row.enabled).toBe(0);
  });

  it('deleting the key removes the secret, switches the connector off and drops the server from container.json', async () => {
    upstream(200);
    const row0 = await createConnector(owner.user_id, 'github');
    await saveConnectorKey(owner, row0.id, PAT);
    expect(await managedServersFor('ag-owner')).toHaveProperty('github');
    markGroupConfigDirty.mockClear();
    const row = await removeConnectorKey(owner, row0.id);
    expect(ng.deleteSecret).toHaveBeenCalledWith(gateIdOf(owner), row0.secret_name);
    expect(row).toMatchObject({ enabled: 0, key_saved_at: null, key_status: null });
    expect(await managedServersFor('ag-owner')).toEqual({});
    expect(markGroupConfigDirty).toHaveBeenCalledWith('ag-owner', 'connector key removed');
  });
});

describe('enable / policy', () => {
  it('cannot be enabled without a key', async () => {
    const row = await createConnector(owner.user_id, 'github');
    await expect(updateConnector(owner, row.id, { enabled: true })).rejects.toMatchObject({
      code: 'conflict',
      message: 'Сначала добавьте ключ',
    });
  });

  it('managedServersFor yields the entry only for enabled + keyed connectors, with no secrets in it', async () => {
    upstream(200);
    const row = await createConnector(owner.user_id, 'github');
    expect(await managedServersFor('ag-owner')).toEqual({});
    await saveConnectorKey(owner, row.id, PAT);
    expect(await managedServersFor('ag-owner')).toEqual({
      github: { type: 'http', url: `http://nanorelay:8081/mcp/${row.id}`, timeout: 420000 },
    });
    await updateConnector(owner, row.id, { enabled: false });
    expect(await managedServersFor('ag-owner')).toEqual({});
    expect(await managedServersFor('ag-unknown')).toEqual({});
  });

  it('toggle and read-only restart running sessions; a tool policy does not', async () => {
    upstream(200);
    const row = await createConnector(owner.user_id, 'github');
    await saveConnectorKey(owner, row.id, PAT);
    markGroupConfigDirty.mockClear();
    await updateConnector(owner, row.id, { toolPolicy: { create_issue: 'auto' } });
    expect(markGroupConfigDirty).not.toHaveBeenCalled();
    const ro = await updateConnector(owner, row.id, { readOnly: true });
    expect(markGroupConfigDirty).toHaveBeenCalledTimes(1);
    expect(ng.putMcpConnector).toHaveBeenLastCalledWith(
      row.id,
      expect.objectContaining({ extraHeaders: { 'X-MCP-Readonly': 'true' }, toolPolicy: { create_issue: 'auto' } }),
    );
    await updateConnector(owner, row.id, { enabled: false });
    expect(markGroupConfigDirty).toHaveBeenCalledTimes(2);
    expect(ro.rev).toBeGreaterThan(row.rev);
  });

  it('merges tool policy; null removes an override; bad input is rejected', async () => {
    const row = await createConnector(owner.user_id, 'github');
    await updateConnector(owner, row.id, { toolPolicy: { a: 'ask', b: 'auto' } });
    await updateConnector(owner, row.id, { toolPolicy: { a: null, c: 'ask' } });
    expect(parsePolicy((await getConnector(row.id))!.tool_policy)).toEqual({ b: 'auto', c: 'ask' });
    await expect(updateConnector(owner, row.id, { toolPolicy: { 'bad name!': 'ask' } })).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      updateConnector(owner, row.id, { toolPolicy: { a: 'maybe' as unknown as 'ask' } }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('a failed push keeps the change and shows a warning; the next sync repairs it', async () => {
    const row = await createConnector(owner.user_id, 'github');
    ng.putMcpConnector.mockRejectedValueOnce(new Error('socket gone'));
    const r = await updateConnector(owner, row.id, { toolPolicy: { x: 'ask' } });
    expect(r.tool_policy).toContain('"x":"ask"');
    expect((await connectorView(owner, r)).warning).toMatch(/шлюзом/);
    await syncAllConnectors();
    expect((await connectorView(owner, (await getConnector(row.id))!)).warning).toBeUndefined();
  });
});

describe('views', () => {
  it('classifies tools: policy wins, otherwise a tool asks unless it is read-only', async () => {
    const row = await createConnector(owner.user_id, 'github');
    await updateConnector(owner, row.id, { toolPolicy: { get_me: 'ask', create_issue: 'auto' } });
    ng.listMcpConnectors.mockResolvedValue([
      {
        id: row.id,
        tenantId: gateIdOf(owner),
        enabled: false,
        toolsSeenAt: 1,
        tools: [
          { name: 'list_issues', readOnly: true, title: 'List issues' },
          { name: 'get_me', readOnly: true },
          { name: 'create_issue', readOnly: false },
          { name: 'merge_pull_request', readOnly: false },
        ],
      },
    ]);
    const [v] = await connectorViews(owner);
    expect(v.tools).toEqual([
      { name: 'list_issues', title: 'List issues', readOnly: true, policy: null, asks: false },
      { name: 'get_me', readOnly: true, policy: 'ask', asks: true },
      { name: 'create_issue', readOnly: false, policy: 'auto', asks: false },
      { name: 'merge_pull_request', readOnly: false, policy: null, asks: true },
    ]);
    expect(ng.listMcpConnectors).toHaveBeenCalledWith(gateIdOf(owner));
    expect(v.status).toBe('no_key');
  });

  it('status follows key and switch; applying comes from the group', async () => {
    upstream(200);
    const row = await createConnector(owner.user_id, 'github');
    expect((await connectorView(owner, row)).status).toBe('no_key');
    const { row: keyed } = await saveConnectorKey(owner, row.id, PAT);
    groupApplying.mockResolvedValue(true);
    expect(await connectorView(owner, keyed)).toMatchObject({ status: 'ok', applying: true, enabled: true });
    const off = await updateConnector(owner, row.id, { enabled: false });
    expect((await connectorView(owner, off)).status).toBe('disabled');
    await markKeyRejected(row.id);
    expect((await connectorView(owner, (await getConnector(row.id))!)).status).toBe('key_rejected');
  });

  it('calls are mapped with a duration', async () => {
    const row = await createConnector(owner.user_id, 'github');
    ng.mcpCalls.mockResolvedValue([
      {
        id: 'mc_1',
        connectorId: row.id,
        tool: 'create_issue',
        dangerous: true,
        decision: 'approved',
        status: 'ok',
        startedAt: 1000,
        finishedAt: 1750,
      },
      {
        id: 'mc_2',
        connectorId: row.id,
        tool: 'x',
        dangerous: true,
        decision: 'pending',
        status: null,
        startedAt: 2000,
        finishedAt: null,
      },
    ]);
    const calls = await connectorCalls(owner, row);
    expect(ng.mcpCalls).toHaveBeenCalledWith({ tenantId: gateIdOf(owner), connectorId: row.id, limit: 20 });
    expect(calls[0]).toEqual({
      at: new Date(1000).toISOString(),
      tool: 'create_issue',
      dangerous: true,
      decision: 'approved',
      status: 'ok',
      durationMs: 750,
    });
    expect(calls[1]).not.toHaveProperty('durationMs');
  });
});

describe('sync with nanogate', () => {
  it('pushes every row with the current gate id (epoch aware)', async () => {
    const row = await createConnector(owner.user_id, 'github');
    await updateTenant(OWNER, { epoch: 2 });
    const r = await syncAllConnectors();
    expect(r).toMatchObject({ pushed: 1, removed: 0, failed: 0 });
    expect(ng.putMcpConnector).toHaveBeenLastCalledWith(
      row.id,
      expect.objectContaining({ tenantId: `${owner.user_id}.e2` }),
    );
  });

  it('is a full replace: what the host does not know is deleted with its secret', async () => {
    const row = await createConnector(owner.user_id, 'github');
    ng.listMcpConnectors.mockResolvedValue([
      { id: row.id, tenantId: gateIdOf(owner), enabled: false, tools: [], toolsSeenAt: null },
      { id: `github-${OWN_TAG}deadbeef`, tenantId: 'telegram:777', enabled: true, tools: [], toolsSeenAt: null },
    ]);
    const r = await syncAllConnectors();
    expect(r.removed).toBe(1);
    expect(ng.deleteMcpConnector).toHaveBeenCalledWith(`github-${OWN_TAG}deadbeef`);
    expect(ng.deleteMcpConnector).not.toHaveBeenCalledWith(row.id);
  });

  it('a push sends the row as it is now, and pushes of one connector keep their order', async () => {
    const row = await createConnector(owner.user_id, 'github');
    await saveConnectorKey(owner, row.id, PAT);
    ng.putMcpConnector.mockClear();
    const stale = (await getConnector(row.id))!; // snapshot taken before the change below
    const sent: boolean[] = [];
    ng.putMcpConnector.mockImplementation(async (_id: string, b: { enabled: boolean }) => {
      await new Promise((r) => setTimeout(r, 5));
      sent.push(b.enabled);
    });
    const a = pushConnector(stale);
    await updateConnector(owner, row.id, { enabled: false });
    await a;
    expect(sent.at(-1)).toBe(false);
    expect(sent.length).toBe(2);
  });

  it('connectors of another install on a shared nanogate are left alone', async () => {
    ng.listMcpConnectors.mockResolvedValue([
      { id: 'github-ffffdeadbeef', tenantId: gateIdOf(owner), enabled: true, tools: [], toolsSeenAt: null },
    ]);
    const r = await syncAllConnectors();
    expect(r.removed).toBe(0);
    expect(ng.deleteMcpConnector).not.toHaveBeenCalled();
  });

  it('a failed removal is counted and retried by the next pass', async () => {
    ng.listMcpConnectors.mockResolvedValue([
      { id: `github-${OWN_TAG}deadbeef`, tenantId: 't', enabled: true, tools: [], toolsSeenAt: null },
    ]);
    ng.deleteMcpConnector.mockRejectedValueOnce(new Error('down'));
    expect((await syncAllConnectors()).failed).toBe(1);
    expect((await syncAllConnectors()).removed).toBe(1);
  });

  it('survives nanogate being down', async () => {
    await createConnector(owner.user_id, 'github');
    ng.putMcpConnector.mockRejectedValue(new Error('down'));
    ng.listMcpConnectors.mockRejectedValue(new Error('down'));
    const r = await syncAllConnectors();
    expect(r.pushed).toBe(0);
    expect(r.failed).toBeGreaterThan(0);
  });

  it('rows of a deleted tenant are not pushed', async () => {
    const friend = await mkTenant(FRIEND_A, 'fa');
    await createConnector(friend.user_id, 'github');
    await updateTenant(FRIEND_A, { state: 'deleted' });
    expect((await syncAllConnectors()).pushed).toBe(0);
  });

  it('pushConnector throws unless quiet', async () => {
    const row = await createConnector(owner.user_id, 'github');
    ng.putMcpConnector.mockRejectedValue(new Error('x'));
    await expect(pushConnector(row)).rejects.toThrow('x');
    expect(await pushConnector(row, true)).toBe(false);
  });
});

describe('removal', () => {
  it('deleting removes the nanogate copy, the secret and the row, and marks the group', async () => {
    const row = await createConnector(owner.user_id, 'github');
    await removeConnector(owner, row.id);
    expect(ng.deleteMcpConnector).toHaveBeenCalledWith(row.id);
    expect(ng.deleteSecret).toHaveBeenCalledWith(gateIdOf(owner), row.secret_name);
    expect(await getConnector(row.id)).toBeUndefined();
    expect(markGroupConfigDirty).toHaveBeenCalledWith('ag-owner', 'connector removed');
  });

  it('the row goes even when nanogate is unreachable (sync cleans the copy later)', async () => {
    const row = await createConnector(owner.user_id, 'github');
    ng.deleteMcpConnector.mockRejectedValue(new Error('down'));
    await removeConnector(owner, row.id);
    expect(await getConnector(row.id)).toBeUndefined();
  });

  it('tenant deletion drops all rows of the user', async () => {
    const row = await createConnector(owner.user_id, 'github');
    expect(await deleteConnectorsOfUser(owner.user_id)).toEqual([row.id]);
    expect(await listConnectors(owner.user_id)).toEqual([]);
  });
});
