import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './client';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
const me = { userId: '1', name: 'Я', role: 'friend', state: 'ready', lang: 'ru', tz: 'UTC' };
const session = (token: string) => json({ token, expiresAt: new Date(Date.now() + 900_000).toISOString(), me });

describe('api client', () => {
  it('opens a session lazily and sends bearer (+ X-CSRF on mutations)', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      return url === '/api/session' ? session('tok1') : init.method === 'GET' ? json({ ok: 1 }) : new Response(null, { status: 204 });
    });
    const api = createApi({ getInitData: () => 'raw-init', fetchImpl });
    expect(await api.get('/api/home')).toEqual({ ok: 1 });
    await api.post('/api/tasks/1/pause');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ initData: 'raw-init' });
    const h = calls[1].init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer tok1');
    expect(h['X-CSRF']).toBeUndefined();
    const m = calls[2].init.headers as Record<string, string>;
    expect(m.Authorization).toBe('Bearer tok1');
    expect(m['X-CSRF']).toBe('tok1');
    expect(fetchImpl.mock.calls.filter((c) => c[0] === '/api/session')).toHaveLength(1);
  });

  it('on 401 re-creates the session with fresh initData and retries once', async () => {
    let init = 'old';
    let n = 0;
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, o: RequestInit = {}) => {
      if (url === '/api/session') { n++; return session(`tok${n}`); }
      seen.push((o.headers as Record<string, string>).Authorization);
      return seen.length === 1 ? json({ error: { code: 'unauthorized', message: 'x' } }, 401) : json({ done: true });
    });
    const api = createApi({ getInitData: () => init, fetchImpl });
    const p = api.get('/api/home');
    init = 'fresh';
    expect(await p).toEqual({ done: true });
    expect(seen).toEqual(['Bearer tok1', 'Bearer tok2']);
    const bodies = fetchImpl.mock.calls.filter((c) => c[0] === '/api/session').map((c) => JSON.parse(c[1]!.body as string).initData);
    expect(bodies).toEqual(['old', 'fresh']);
  });

  it('does not loop: a second 401 surfaces as ApiError', async () => {
    const fetchImpl = vi.fn(async (url: string) => (url === '/api/session' ? session('t') : json({ error: { code: 'unauthorized', message: 'no' } }, 401)));
    const api = createApi({ getInitData: () => 'x', fetchImpl });
    await expect(api.get('/api/home')).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(fetchImpl.mock.calls.filter((c) => c[0] === '/api/session')).toHaveLength(2);
  });

  it('maps error bodies and network failures', async () => {
    const api = createApi({ getInitData: () => 'x', fetchImpl: async (url) => (url === '/api/session' ? session('t') : json({ error: { code: 'forbidden', message: 'Нельзя' } }, 403)) });
    await expect(api.put('/api/egress', { route: 'direct' })).rejects.toMatchObject({ code: 'forbidden', message: 'Нельзя' });
    const down = createApi({ getInitData: () => 'x', fetchImpl: async () => { throw new TypeError('fail'); } });
    await expect(down.get('/api/home')).rejects.toBeInstanceOf(ApiError);
    await expect(down.get('/api/home')).rejects.toMatchObject({ code: 'network' });
  });

  it('renews an expired token before the call without waiting for a 401', async () => {
    let t = 1_000_000;
    let n = 0;
    const fetchImpl = vi.fn(async (url: string) => (url === '/api/session' ? json({ token: `t${++n}`, expiresAt: new Date(t + 60_000).toISOString(), me }) : json({})));
    const api = createApi({ getInitData: () => 'x', fetchImpl, now: () => t });
    await api.get('/a');
    t += 120_000;
    await api.get('/b');
    expect(n).toBe(2);
  });
});
