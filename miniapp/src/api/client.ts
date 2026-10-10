import type { ApiErrorBody, ApiErrorCode, Me, SessionResponse } from './types';

export class ApiError extends Error {
  constructor(
    public code: ApiErrorCode | 'network',
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Fresh raw initData; read on every (re-)session, because Telegram may refresh it. */
  getInitData: () => string;
  now?: () => number;
}

export interface Api {
  session(): Promise<Me>;
  get<T>(path: string): Promise<T>;
  post<T = void>(path: string, body?: unknown): Promise<T>;
  put<T = void>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body?: unknown): Promise<T>;
  del<T = void>(path: string, body?: unknown): Promise<T>;
}

const SKEW_MS = 20_000;

export function createApi(opts: ApiOptions): Api {
  const base = opts.baseUrl ?? '';
  const doFetch: FetchLike = opts.fetchImpl ?? ((i, n) => fetch(i, n));
  const now = opts.now ?? Date.now;
  let token: string | null = null;
  let expiresAt = 0;
  let inflight: Promise<Me> | null = null;

  async function raw(method: string, path: string, body: unknown, auth: boolean): Promise<Response> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && token) {
      headers.Authorization = `Bearer ${token}`;
      if (method !== 'GET') headers['X-CSRF'] = token;
    }
    try {
      return await doFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch {
      throw new ApiError('network', 'Нет связи с сервером');
    }
  }

  async function fail(res: Response): Promise<never> {
    let code: ApiErrorCode = 'internal';
    let message = 'Что-то пошло не так';
    try {
      const j = (await res.json()) as ApiErrorBody;
      if (j?.error) {
        code = j.error.code;
        message = j.error.message || message;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(code, message, res.status);
  }

  function session(): Promise<Me> {
    // Coalesce parallel 401s into one /api/session call.
    inflight ??= (async () => {
      try {
        const res = await raw('POST', '/api/session', { initData: opts.getInitData() }, false);
        if (!res.ok) return await fail(res);
        const s = (await res.json()) as SessionResponse;
        token = s.token;
        expiresAt = Date.parse(s.expiresAt);
        return s.me;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!token || now() > expiresAt - SKEW_MS) await session();
    let res = await raw(method, path, body, true);
    if (res.status === 401) {
      await session();
      res = await raw(method, path, body, true);
    }
    if (!res.ok) return fail(res);
    if (res.status === 204 || res.status === 202) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    return (await res.json()) as T;
  }

  return {
    session,
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    put: (p, b) => call('PUT', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p, b) => call('DELETE', p, b),
  };
}
