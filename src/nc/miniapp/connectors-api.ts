/**
 * Mini App routes of the MCP connectors (`/api/connectors*`). Owner-only in Stage 1; the tenant always comes from the
 * session and a connector id is accepted only if that tenant owns it. Key values are write-only: they never appear in
 * a response, an audit row or a log line.
 */
import { CATALOG } from '../mcp-catalog.js';
import {
  ConnectorError,
  connectorCalls,
  connectorView,
  connectorViews,
  createConnector,
  ownedConnector,
  removeConnector,
  removeConnectorKey,
  saveConnectorKey,
  updateConnector,
  type ConnectorPatch,
} from '../mcp-connectors.js';
import { ApiError, bad, conflict, notFound } from './errors.js';
import type { Ctx, Handler, Route } from './api.js';
import type { CatalogItem, ConnectorsView } from './types.js';

const ID = /^[a-z0-9-]{3,64}$/;

function idOf(c: Ctx): string {
  const id = decodeURIComponent(c.m[1] ?? '');
  if (!ID.test(id)) throw notFound('Коннектор не найден');
  return id;
}

/** Domain errors become the Mini App's `{error:{code,message}}` with the status the contract names. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ConnectorError)) throw e;
    if (e.code === 'not_found') throw notFound(e.message);
    if (e.code === 'conflict') throw conflict(e.message);
    throw new ApiError('invalid', e.message); // invalid, key_rejected -> 400
  }
}

const catalog: CatalogItem[] = CATALOG.map((c) => ({
  id: c.id,
  title: c.title,
  description: c.description,
  keyLabel: c.keyLabel,
  keyHelp: c.keyHelp,
  keyUrl: c.keyUrl,
}));

const list: Handler = async ({ tenant }) => {
  const view: ConnectorsView = { catalog, connectors: await connectorViews(tenant) };
  return { json: view };
};

const create: Handler = async ({ tenant, body }) =>
  mapped(async () => {
    if (typeof body.catalogId !== 'string') throw bad('catalogId');
    const row = await createConnector(tenant.user_id, body.catalogId);
    return { json: await connectorView(tenant, row) };
  });

function parsePatch(body: Record<string, unknown>): ConnectorPatch {
  const patch: ConnectorPatch = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw bad('enabled');
    patch.enabled = body.enabled;
  }
  if (body.readOnly !== undefined) {
    if (typeof body.readOnly !== 'boolean') throw bad('readOnly');
    patch.readOnly = body.readOnly;
  }
  if (body.toolPolicy !== undefined) {
    const tp = body.toolPolicy;
    if (!tp || typeof tp !== 'object' || Array.isArray(tp)) throw bad('toolPolicy');
    const out: Record<string, 'ask' | 'auto' | null> = {};
    for (const [k, v] of Object.entries(tp)) {
      if (v !== 'ask' && v !== 'auto' && v !== null) throw bad('toolPolicy: ask, auto или null');
      out[k] = v;
    }
    patch.toolPolicy = out;
  }
  return patch;
}

const patch: Handler = async (c) =>
  mapped(async () => {
    const id = idOf(c);
    const row = await updateConnector(c.tenant, id, parsePatch(c.body));
    return { json: await connectorView(c.tenant, row) };
  });

const putKey: Handler = async (c) =>
  mapped(async () => {
    const id = idOf(c);
    const saved = await saveConnectorKey(c.tenant, id, c.body.value);
    return { json: await connectorView(c.tenant, saved.row, saved.warning) };
  });

const deleteKey: Handler = async (c) =>
  mapped(async () => {
    const row = await removeConnectorKey(c.tenant, idOf(c));
    return { json: await connectorView(c.tenant, row) };
  });

const remove: Handler = async (c) =>
  mapped(async () => {
    await removeConnector(c.tenant, idOf(c));
    return { status: 204 };
  });

const calls: Handler = async (c) =>
  mapped(async () => {
    const row = await ownedConnector(c.tenant, idOf(c));
    return { json: await connectorCalls(c.tenant, row) };
  });

const seg = '([^/]+)';

export const connectorRoutes: Route[] = [
  { method: 'GET', re: /^\/api\/connectors$/, handler: list, owner: true },
  { method: 'POST', re: /^\/api\/connectors$/, handler: create, owner: true },
  { method: 'PATCH', re: new RegExp(`^/api/connectors/${seg}$`), handler: patch, owner: true },
  { method: 'PUT', re: new RegExp(`^/api/connectors/${seg}/key$`), handler: putKey, owner: true },
  { method: 'DELETE', re: new RegExp(`^/api/connectors/${seg}/key$`), handler: deleteKey, owner: true },
  { method: 'DELETE', re: new RegExp(`^/api/connectors/${seg}$`), handler: remove, owner: true },
  { method: 'GET', re: new RegExp(`^/api/connectors/${seg}/calls$`), handler: calls, owner: true },
];
