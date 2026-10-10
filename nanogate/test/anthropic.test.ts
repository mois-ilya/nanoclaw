import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Gate, makeGate } from './harness.js';

let g: Gate;
afterEach(async () => g.close());

describe('auth and routing', () => {
  beforeEach(async () => {
    g = await makeGate();
    await g.tenant('t1');
  });

  it('401 for unknown token, 404 for other paths, healthz without auth', async () => {
    const bad = await g.messages('ngs_nope', 'sse');
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.text)).toMatchObject({ type: 'error', error: { type: 'authentication_error' } });
    const tok = await g.session('t1');
    expect((await g.messages(tok, 'sse', {}, {}, g.gate.ports.anthropic, '/anthropic/v1/other')).status).toBe(404);
    expect((await g.messages(tok, 'sse', {}, {}, g.gate.ports.anthropic, '/anthropic/v1/messages/')).status).toBe(404);
    const h = await fetch(`http://127.0.0.1:${g.gate.ports.anthropic}/healthz`);
    expect(await h.json()).toEqual({ ok: true });
  });

  it('accepts Authorization: Bearer and ignores client tenant headers', async () => {
    const tok = await g.session('t1');
    const r = await g.messages('x', 'json', {}, { authorization: `Bearer ${tok}`, 'x-api-key': '', 'x-tenant': 'other' });
    expect(r.status).toBe(200);
    expect(g.usageRows()[0].tenant_id).toBe('t1');
  });

  it('paused tenant gets 403 tenant_paused; resume restores', async () => {
    const tok = await g.session('t1');
    await g.admin('POST', '/tenants/t1/pause');
    const r = await g.messages(tok, 'sse');
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error).toMatchObject({ type: 'permission_error', message: 'tenant_paused' });
    await g.admin('POST', '/tenants/t1/resume');
    expect((await g.messages(tok, 'json')).status).toBe(200);
  });

  it('session tokens only work on :8080, host tokens only on the host port', async () => {
    const tok = await g.session('t1');
    const host = (await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'stt' })).json.token;
    expect((await g.messages(tok, 'json', {}, {}, g.gate.ports.host)).status).toBe(401);
    expect((await g.messages(host, 'json', {}, {}, g.gate.ports.anthropic)).status).toBe(401);
    expect((await g.messages(host, 'json', {}, {}, g.gate.ports.host)).status).toBe(200);
    expect(g.usageRows()[0].purpose).toBe('stt');
  });
});

describe('policy', () => {
  beforeEach(async () => {
    g = await makeGate();
    await g.tenant('t1');
  });

  it('rejects disallowed, unknown and unpriced models', async () => {
    const tok = await g.session('t1');
    for (const model of ['claude-other', 'm-not-priced']) {
      const r = await g.messages(tok, 'sse', { model });
      expect(r.status).toBe(400);
      expect(JSON.parse(r.text).error).toMatchObject({ type: 'invalid_request_error', message: 'model_not_allowed' });
    }
    expect(g.up.seen).toHaveLength(0);
  });

  it('clamps max_tokens, swaps the key, filters betas, pins service_tier, drops speed', async () => {
    const tok = await g.session('t1');
    const r = await g.messages(tok, 'json', { max_tokens: 99999, service_tier: 'auto', speed: 'fast' }, { 'anthropic-beta': 'beta-x, evil-beta ,claude-code-20250219', 'x-nanogate-turn': 'turn-1' });
    expect(r.status).toBe(200);
    const s = g.up.seen[0]!;
    expect(s.body.max_tokens).toBe(2000);
    expect(s.body.service_tier).toBe('standard_only');
    expect(s.body.speed).toBeUndefined();
    expect(s.headers['x-api-key']).toBe('sk-ant-REAL-KEY');
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers['anthropic-beta']).toBe('beta-x,claude-code-20250219');
    expect(s.path).toBe('/v1/messages');
    expect(g.usageRows()[0].turn_id).toBe('turn-1');
  });

  it('always pins service_tier to standard_only unless priority is granted, injecting it when absent', async () => {
    const tok = await g.session('t1');
    await g.messages(tok, 'json');
    expect(g.up.seen[0]!.body.service_tier).toBe('standard_only');
    await g.tenant('t2', {}, { allowServiceTiers: ['standard', 'auto'] });
    const tok2 = await g.session('t2');
    await g.messages(tok2, 'json', { service_tier: 'auto' });
    expect(g.up.seen[1]!.body.service_tier).toBe('auto');
    await g.messages(tok2, 'json');
    expect(g.up.seen[2]!.body.service_tier).toBeUndefined();
  });

  it('omits anthropic-beta entirely when nothing survives', async () => {
    const tok = await g.session('t1');
    await g.messages(tok, 'json', {}, { 'anthropic-beta': 'evil' });
    expect(g.up.seen[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('server tools need policy.serverTools; custom tools pass', async () => {
    const tok = await g.session('t1');
    const bad = await g.messages(tok, 'json', { tools: [{ type: 'code_execution_20250522', name: 'code_execution' }] });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).error.message).toBe('tool_not_allowed');
    const ok1 = await g.messages(tok, 'json', { tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }, { name: 'mine', input_schema: { type: 'object' } }, { type: 'custom', name: 'c', input_schema: {} }] });
    expect(ok1.status).toBe(200);
  });

  it('rejects invalid JSON and missing max_tokens', async () => {
    const tok = await g.session('t1');
    const r = await fetch(`http://127.0.0.1:${g.gate.ports.anthropic}/anthropic/v1/messages`, { method: 'POST', headers: { 'x-api-key': tok }, body: '{nope' });
    expect(r.status).toBe(400);
    const r2 = await g.messages(tok, 'json', { max_tokens: undefined });
    expect(r2.status).toBe(400);
  });
});

describe('metering', () => {
  beforeEach(async () => {
    g = await makeGate();
    await g.tenant('t1', { budgetLimitMicros: 10_000_000 });
  });

  it('streams SSE through untouched and reconciles usage from message_start + message_delta', async () => {
    const tok = await g.session('t1');
    const r = await g.messages(tok, 'sse', {}, { 'x-nanogate-purpose': 'stt' });
    expect(r.status).toBe(200);
    expect(r.text).toContain('event: message_stop');
    expect(r.text).toContain('"output_tokens":40');
    const [u] = g.usageRows();
    expect(u).toMatchObject({ status: 'reconciled', input_tokens: 100, output_tokens: 40, cache_creation_5m: 50, cache_creation_1h: 10, cache_read: 20, cost_micros: 21154, price_version: 'test-1', purpose: 'agent', service_tier: 'standard' });
    expect(JSON.parse(u.server_tool_json)).toEqual({ web_search: 2 });
    const open = g.gate.ctx.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status='open'").get() as any;
    expect(open.n).toBe(0);
    const b = (await g.admin('GET', '/budget/t1')).json;
    expect(b).toMatchObject({ limitMicros: 10_000_000, usedMicros: 21154, reservedMicros: 0, status: 'ok' });
  });

  it('meters non-streaming responses (flat cache_creation priced as 5m)', async () => {
    const tok = await g.session('t1');
    await g.messages(tok, 'json');
    expect(g.usageRows()[0]).toMatchObject({ status: 'reconciled', cost_micros: Math.ceil(10 * 3 + 20 * 15 + 4 * 3.75) });
  });

  it('upstream 529 passes through and charges nothing', async () => {
    const tok = await g.session('t1');
    const r = await g.messages(tok, '529');
    expect(r.status).toBe(529);
    expect(r.text).toContain('overloaded_error');
    expect(g.usageRows()[0]).toMatchObject({ cost_micros: 0 });
    const res = g.gate.ctx.db.prepare('SELECT status FROM reservations').get() as any;
    expect(res.status).toBe('settled');
  });

  it('mid-stream abort after message_start is charged the FULL reservation (observed tokens still recorded)', async () => {
    const tok = await g.session('t1');
    await g.messages(tok, 'abort');
    await new Promise((r) => setTimeout(r, 100));
    const res = g.gate.ctx.db.prepare('SELECT status, reserved_micros FROM reservations').get() as any;
    expect(res.status).toBe('abandoned');
    // observed would be input 100*3 + output 1*15 + 50*3.75 + 10*6 + 20*0.3 = 569; a hostile client that closes
    // before message_delta must not get away with that while Anthropic bills the full output.
    expect(res.reserved_micros).toBeGreaterThan(569);
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: res.reserved_micros, input_tokens: 100, output_tokens: 1 });
  });

  it('client closing the connection mid-stream is charged the full reservation', async () => {
    const tok = await g.session('t1');
    g.up.server.removeAllListeners('request');
    g.up.server.on('request', (_q, r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      r.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`);
    });
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${g.gate.ports.anthropic}/anthropic/v1/messages`, {
      method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json', 'x-api-key': tok },
      body: JSON.stringify({ model: 'm-1', max_tokens: 100, messages: [{ role: 'user', content: 'x' }] }),
    });
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    await vi.waitFor(() => expect(g.usageRows()).toHaveLength(1), { timeout: 5000 });
    const r = g.gate.ctx.db.prepare('SELECT reserved_micros FROM reservations').get() as any;
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: r.reserved_micros });
  });

  it('an upstream error event after partial output is charged the full reservation', async () => {
    const tok = await g.session('t1');
    g.up.server.removeAllListeners('request');
    g.up.server.on('request', (_q, r) => {
      r.writeHead(200, { 'content-type': 'text/event-stream' });
      r.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`);
      r.end('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n');
    });
    await g.messages(tok, 'x');
    await new Promise((r) => setTimeout(r, 50));
    const r = g.gate.ctx.db.prepare('SELECT reserved_micros FROM reservations').get() as any;
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: r.reserved_micros, input_tokens: 10 });
  });

  it('stream that ends with nothing seen is charged the reservation', async () => {
    const tok = await g.session('t1');
    g.up.server.removeAllListeners('request');
    g.up.server.on('request', (_q, r) => { r.writeHead(200, { 'content-type': 'text/event-stream' }); r.write('event: ping\ndata: {}\n\n'); setTimeout(() => r.destroy(), 20); });
    await g.messages(tok, 'x');
    await new Promise((r) => setTimeout(r, 100));
    const res = g.gate.ctx.db.prepare('SELECT reserved_micros FROM reservations').get() as any;
    expect(g.usageRows()[0]).toMatchObject({ status: 'estimated', cost_micros: res.reserved_micros });
  });

  it('count_tokens is free: no usage, no reservation, but model is checked', async () => {
    const tok = await g.session('t1');
    const r = await g.messages(tok, 'x', {}, {}, g.gate.ports.anthropic, '/anthropic/v1/messages/count_tokens');
    expect(r.status).toBe(200);
    expect(g.up.seen[0]!.path).toBe('/v1/messages/count_tokens');
    expect(g.usageRows()).toHaveLength(0);
    expect((g.gate.ctx.db.prepare('SELECT COUNT(*) AS n FROM reservations').get() as any).n).toBe(0);
    const bad = await g.messages(tok, 'x', { model: 'nope' }, {}, g.gate.ports.anthropic, '/anthropic/v1/messages/count_tokens');
    expect(bad.status).toBe(400);
  });

  it('revoking the tenant aborts in-flight proxied requests', async () => {
    const tok = await g.session('t1');
    const p = g.messages(tok, 'hang');
    await new Promise((r) => setTimeout(r, 100));
    await g.admin('POST', '/tenants/t1/revoke');
    const r = await p;
    expect(r.status === 0 || r.text.includes('[aborted]') || r.status === 200).toBe(true);
    expect((await g.messages(tok, 'json')).status).toBe(401);
  });
});

describe('budgets', () => {
  it('20 parallel requests against a small limit never overspend by more than one reservation', async () => {
    g = await makeGate();
    // reserve per request ~ 15*1000 + 6*ceil(bytes/3) ~ 15.3k; limit fits exactly 6
    await g.tenant('t1', { budgetLimitMicros: 100_000 });
    const tok = await g.session('t1');
    const rs = await Promise.all(Array.from({ length: 20 }, () => g.messages(tok, 'slow', { max_tokens: 1000 })));
    const okN = rs.filter((r) => r.status === 200).length;
    const denied = rs.filter((r) => r.status === 429);
    expect(okN).toBe(6);
    expect(denied).toHaveLength(14);
    // Refused while the tenant's own requests are in flight: transient, retryable, not the hard stop.
    expect(JSON.parse(denied[0]!.text).error).toMatchObject({ type: 'rate_limit_error', message: 'budget_insufficient_now', nanogate: { tenantId: 't1' } });
    expect(denied[0]!.headers.get('x-nanogate-budget')).toBe('busy');
    expect(denied[0]!.headers.get('x-should-retry')).toBeNull();
    expect((await g.admin('GET', '/budget/t1')).json.status).not.toBe('exhausted');
    const used = (await g.admin('GET', '/budget/t1')).json.usedMicros;
    expect(used).toBeLessThanOrEqual(100_000);
  });

  it('fires budget_80 and budget_100 once each per period', async () => {
    g = await makeGate();
    await g.tenant('t1', { budgetLimitMicros: 50_000 });
    const tok = await g.session('t1');
    for (let i = 0; i < 3; i++) expect((await g.messages(tok, 'sse')).status).toBe(200);
    expect((await g.messages(tok, 'sse')).status).toBe(429);
    const ev = (await g.admin('GET', '/events')).json.events as any[];
    expect(ev.map((e) => e.type)).toEqual(['budget_80', 'budget_100']);
    expect(ev[0].tenantId).toBe('t1');
    await g.admin('POST', '/events/ack', { upTo: ev[0].id });
    expect(((await g.admin('GET', '/events')).json.events as any[]).map((e) => e.type)).toEqual(['budget_100']);
    expect((await g.admin('GET', '/budget/t1')).json.status).toBe('exhausted');
  });

  it('a refusal on the worst-case reserve raises budget_100, reports exhausted, and tells the SDK not to retry', async () => {
    g = await makeGate();
    // one request reserves ~15k+; settled spend stays far below the limit when the next one is refused
    await g.tenant('t1', { budgetLimitMicros: 30_000 });
    const tok = await g.session('t1');
    expect((await g.messages(tok, 'sse', { max_tokens: 1000 })).status).toBe(200);
    expect((await g.admin('GET', '/budget/t1')).json.status).not.toBe('exhausted');
    const r = await g.messages(tok, 'sse', { max_tokens: 1000 });
    expect(r.status).toBe(429);
    expect(r.headers.get('x-should-retry')).toBe('false');
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    const types = ((await g.admin('GET', '/events')).json.events as any[]).map((e) => e.type);
    expect(types).toContain('budget_100');
    expect(types.filter((t) => t === 'budget_100')).toHaveLength(1);
    expect((await g.admin('GET', '/budget/t1')).json.status).toBe('exhausted');
    // raising the limit clears it
    await g.tenant('t1', { budgetLimitMicros: 10_000_000 });
    expect((await g.admin('GET', '/budget/t1')).json.status).not.toBe('exhausted');
  });

  it('task sessions are recorded with purpose task, other sessions as agent', async () => {
    g = await makeGate();
    await g.tenant('t1');
    const tok = await g.session('t1');
    const task = (await g.admin('POST', '/sessions/ensure', { tenantId: 't1', sessionKey: 'task-1', runtimeIdentity: 'rt', disposition: 'create', purpose: 'task' })).json.token as string;
    await g.messages(tok, 'json');
    await g.messages(task, 'json');
    expect(g.usageRows().map((u) => u.purpose).sort()).toEqual(['agent', 'task']);
    expect((await g.admin('POST', '/sessions/ensure', { tenantId: 't1', sessionKey: 'x', runtimeIdentity: 'rt', disposition: 'create', purpose: 'bogus' })).status).toBe(400);
  });

  it('host-token calls do not use the tenant session concurrency slots', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { maxConcurrentRequests: 1 });
    const tok = await g.session('t1');
    const h = (await g.admin('POST', '/host-tokens', { tenantId: 't1', purpose: 'guest' })).json.token as string;
    const slow = g.messages(tok, 'slow');
    await new Promise((r) => setTimeout(r, 50));
    expect((await g.messages(tok, 'json')).status).toBe(429);
    expect((await g.messages(h, 'json', {}, {}, g.gate.ports.host)).status).toBe(200);
    await slow;
  });

  it('global cap blocks all tenants and raises one global_cap event', async () => {
    g = await makeGate({ globalCapUsdMicros: 10_000 });
    await g.tenant('a');
    const tok = await g.session('a');
    expect((await g.messages(tok, 'sse', { max_tokens: 1000 })).status).toBe(429);
    expect((await g.messages(tok, 'sse', { max_tokens: 1000 })).status).toBe(429);
    const ev = (await g.admin('GET', '/events')).json.events as any[];
    expect(ev.filter((e) => e.type === 'global_cap')).toHaveLength(1);
  });

  it('the per-session window cap cannot be reset by omitting or randomising x-nanogate-turn', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { perTurnCapMicros: 16_000 }); // one 15.3k reservation fits, two do not
    const tok = await g.session('t1');
    const first = g.messages(tok, 'slow', { max_tokens: 1000 }, { 'x-nanogate-turn': 'A' });
    await vi.waitFor(() => expect((g.gate.ctx.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status='open'").get() as any).n).toBe(1));
    for (const h of [{ 'x-nanogate-turn': 'B' }, {}] as Record<string, string>[]) {
      const r = await g.messages(tok, 'json', { max_tokens: 1000 }, h);
      expect(r.status).toBe(429);
      expect(JSON.parse(r.text).error.message).toBe('turn_cap_exceeded');
    }
    expect((await first).status).toBe(200);
    // once settled (~0.4k used) the window has room again
    expect((await g.messages(tok, 'json', { max_tokens: 1000 }, { 'x-nanogate-turn': 'C' })).status).toBe(200);
    expect(g.usageRows().map((u) => u.turn_id)).toEqual(['A', 'C']); // the label is still recorded
  });

  it('the window counts only recent spend of this session, not other sessions or old usage', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { perTurnCapMicros: 16_000 });
    const tok = await g.session('t1');
    const ins = { run: (id: string, session: string, cost: number, at: number) =>
      g.gate.ctx.db.prepare("INSERT INTO usage(request_id, tenant_id, session_key, model, input_tokens, output_tokens, cache_creation_5m, cache_creation_1h, cache_read, server_tool_json, cost_micros, price_version, status, started_at, ended_at) VALUES (?,'t1',?,'m-1',0,0,0,0,0,'{}',?,'v','reconciled',?,?)").run(id, session, cost, at, at) };
    ins.run('old', 's-t1', 1_000_000, Date.now() - 20 * 60_000);
    ins.run('other', 'someone-else', 1_000_000, Date.now() - 60_000);
    expect((await g.messages(tok, 'json', { max_tokens: 1000 })).status).toBe(200);
    ins.run('recent', 's-t1', 1_000_000, Date.now() - 60_000);
    expect((await g.messages(tok, 'json', { max_tokens: 1000 })).status).toBe(429);
  });

  it('maxConcurrentRequests is enforced', async () => {
    g = await makeGate();
    await g.tenant('t1', {}, { maxConcurrentRequests: 2 });
    const tok = await g.session('t1');
    const rs = await Promise.all([1, 2, 3, 4].map(() => g.messages(tok, 'slow')));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(2);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(2);
  });

  it('open reservations from a dead process are charged as estimated on start', async () => {
    g = await makeGate();
    await g.tenant('t1');
    g.gate.ctx.db.prepare("INSERT INTO reservations(id,tenant_id,token_hash,request_id,model,reserved_micros,status,created_at) VALUES ('r','t1','h','req-x','m-1',777,'open',?)").run(Date.now());
    const { sweepOpenReservations } = await import('../src/budget.js');
    expect(sweepOpenReservations(g.gate.ctx.db, g.gate.ctx.config.prices)).toBe(1);
    expect(g.usageRows()[0]).toMatchObject({ request_id: 'req-x', status: 'estimated', cost_micros: 777 });
  });
});
