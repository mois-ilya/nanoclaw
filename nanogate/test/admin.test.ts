import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Gate, makeGate } from './harness.js';

let g: Gate;
beforeEach(async () => {
  g = await makeGate();
  await g.tenant('t1');
});
afterEach(async () => g.close());

const ensure = (disposition: string, sessionKey = 'sess-1', tenantId = 't1') =>
  g.admin('POST', '/sessions/ensure', { tenantId, sessionKey, runtimeIdentity: 'rt-1', disposition });

describe('admin socket', () => {
  it('is mode 0600 and healthz reports key + db', async () => {
    expect(fs.statSync(g.gate.adminSocket).mode & 0o777).toBe(0o600);
    const h = await g.admin('GET', '/healthz');
    expect(h.json).toEqual({ ok: true, upstreamKeyReadable: true, dbWritable: true });
    fs.rmSync(`${g.dir}/key`);
    const h2 = await g.admin('GET', '/healthz');
    expect(h2.status).toBe(503);
    expect(h2.json).toMatchObject({ ok: false, upstreamKeyReadable: false });
  });

  it('unknown routes 404, wrong method 405, bad JSON 400', async () => {
    expect((await g.admin('GET', '/nope')).status).toBe(404);
    expect((await g.admin('DELETE', '/sessions')).status).toBe(405);
    expect((await g.admin('PUT', '/tenants/bad%20id', { kind: 'friend' })).status).toBe(400);
  });
});

describe('sessions', () => {
  it('create is idempotent and returns the same token; tokens are opaque', async () => {
    const a = await ensure('create');
    const b = await ensure('create');
    expect(a.json.created).toBe(true);
    expect(b.json.created).toBe(false);
    expect(b.json.token).toBe(a.json.token);
    expect(a.json.token).toMatch(/^ngs_/);
    expect(a.json.token).not.toMatch(/^sk-/);
    const row = g.gate.ctx.db.prepare('SELECT hash, enc FROM tokens').get() as any;
    expect(row.hash).not.toContain(a.json.token);
    expect(row.enc).not.toContain(a.json.token);
  });

  it('adopt returns the existing token and NEVER mints', async () => {
    const miss = await ensure('adopt');
    expect(miss.status).toBe(409);
    expect(miss.json.error).toBe('no_session_token');
    expect((await g.admin('GET', '/sessions')).json.sessions).toEqual([]);
    expect((g.gate.ctx.db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as any).n).toBe(0);
    const created = await ensure('create');
    const adopted = await ensure('adopt');
    expect(adopted.json).toEqual({ token: created.json.token, created: false });
  });

  it('adopt after session-ended release does not resurrect the token', async () => {
    const t = (await ensure('create')).json.token;
    expect((await g.admin('POST', '/sessions/release', { sessionKey: 'sess-1', kind: 'host-detached' })).json.revoked).toBe(0);
    expect((await g.messages(t, 'json')).status).toBe(200);
    expect((await g.admin('POST', '/sessions/release', { sessionKey: 'sess-1', kind: 'session-ended' })).json.revoked).toBe(1);
    expect((await g.messages(t, 'json')).status).toBe(401);
    expect((await ensure('adopt')).status).toBe(409);
    const fresh = (await ensure('create')).json;
    expect(fresh.created).toBe(true);
    expect(fresh.token).not.toBe(t);
  });

  it('reconcile revokes sessions missing from the live list', async () => {
    const t1 = (await ensure('create', 'k1')).json.token;
    const t2 = (await ensure('create', 'k2')).json.token;
    const r = await g.admin('POST', '/sessions/reconcile', { liveSessionKeys: ['k1'] });
    expect(r.json.revoked).toEqual(['k2']);
    expect((await g.messages(t1, 'json')).status).toBe(200);
    expect((await g.messages(t2, 'json')).status).toBe(401);
    expect((await g.admin('GET', '/sessions')).json.sessions).toEqual([{ sessionKey: 'k1', tenantId: 't1', runtimeIdentity: 'rt-1' }]);
  });

  it('a session key cannot be shared across tenants; unknown tenants 404', async () => {
    await g.tenant('t2');
    await ensure('create');
    expect((await ensure('create', 'sess-1', 't2')).status).toBe(409);
    expect((await ensure('create', 'x', 'ghost')).status).toBe(404);
  });

  it('revoked tenant: tokens die, status is permanent, cannot be re-PUT', async () => {
    const t = (await ensure('create')).json.token;
    await g.admin('POST', '/tenants/t1/revoke');
    expect((await g.messages(t, 'json')).status).toBe(401);
    expect((await g.admin('POST', '/tenants/t1/resume')).status).toBe(409);
    const put = await g.admin('PUT', '/tenants/t1', { kind: 'friend', policy: {}, budgetLimitMicros: null });
    expect(put.status).toBe(409);
  });
});

describe('host tokens', () => {
  it('mints ngh_ tokens, revocable by hash prefix', async () => {
    const r = await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'miniapp' });
    expect(r.json.token).toMatch(/^ngh_/);
    expect((await g.messages(r.json.token, 'json', {}, {}, g.gate.ports.host)).status).toBe(200);
    expect((await g.admin('DELETE', `/host-tokens/${r.json.hashPrefix}`)).status).toBe(200);
    expect((await g.messages(r.json.token, 'json', {}, {}, g.gate.ports.host)).status).toBe(401);
    expect((await g.admin('DELETE', '/host-tokens/deadbeef00')).status).toBe(404);
    expect((await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'nope' })).status).toBe(400);
  });
});

describe('secrets', () => {
  it('are write-only: GET lists names and timestamps, never values; stored encrypted', async () => {
    expect((await g.admin('PUT', '/secrets/t1/tailscale_authkey', { value: 'tskey-SUPERSECRET' })).status).toBe(200);
    const list = await g.admin('GET', '/secrets/t1');
    expect(list.raw).not.toContain('SUPERSECRET');
    expect(list.json.secrets).toEqual([{ name: 'tailscale_authkey', updatedAt: expect.any(Number) }]);
    expect((await g.admin('GET', '/secrets/t1/tailscale_authkey')).raw).not.toContain('SUPERSECRET');
    const enc = (g.gate.ctx.db.prepare('SELECT enc FROM secrets').get() as any).enc as string;
    expect(enc).not.toContain('SUPERSECRET');
    await g.admin('DELETE', '/secrets/t1/tailscale_authkey');
    expect((await g.admin('GET', '/secrets/t1')).json.secrets).toEqual([]);
  });
});

describe('usage', () => {
  it('aggregates by model/purpose/session/day', async () => {
    const t = (await ensure('create')).json.token;
    await g.messages(t, 'json');
    const host = (await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'stt' })).json.token;
    await g.messages(host, 'sse', {}, {}, g.gate.ports.host);
    const byModel = (await g.admin('GET', '/usage?tenantId=t1&groupBy=model')).json.rows;
    expect(byModel).toHaveLength(1);
    expect(byModel[0]).toMatchObject({ key: 'm-1', requests: 2 });
    expect((await g.admin('GET', '/usage?groupBy=purpose')).json.rows.map((r: any) => r.key)).toEqual(['agent', 'stt']);
    expect((await g.admin('GET', '/usage?groupBy=session')).json.rows.map((r: any) => r.key)).toEqual(['', 'sess-1']); // '' = the host token
    expect((await g.admin('GET', '/usage?groupBy=day')).json.rows[0].key).toMatch(/^\d{4}-\d\d-\d\d$/);
    expect((await g.admin('GET', '/usage?groupBy=zzz')).status).toBe(400);
    expect((await g.admin('GET', '/usage')).json.rows[0].requests).toBe(2);
  });
});

describe('tenant validation', () => {
  it('rejects bad policy / budget / tz', async () => {
    const put = (o: any) => g.admin('PUT', '/tenants/x', { kind: 'friend', policy: {}, budgetLimitMicros: null, periodTz: 'UTC', ...o });
    expect((await put({ kind: 'god' })).status).toBe(400);
    expect((await put({ budgetLimitMicros: -1 })).status).toBe(400);
    expect((await put({ periodTz: 'Mars/Base' })).status).toBe(400);
    expect((await put({ policy: { egress: { tailnetAllow: ['nope'] } } })).status).toBe(400);
    expect((await put({ status: 'revoked' })).status).toBe(400);
    expect((await put({ policy: { egress: { route: 'connector', connectorTenant: 'ghost' } } })).status).toBe(400);
    expect((await put({ policy: { egress: { route: 'connector', connectorTenant: 't1' } } })).status).toBe(200);
    expect((await put({})).status).toBe(200);
  });
});
