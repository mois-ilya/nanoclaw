import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { InitDataError, validateInitData } from './auth.js';

const TOKEN = '123456:TEST-token';
const NOW = 1_800_000_000_000;

export function signInitData(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const base = (over: Record<string, string> = {}): Record<string, string> => ({
  auth_date: String(NOW / 1000 - 10),
  query_id: 'AAH',
  user: JSON.stringify({ id: 42, first_name: 'Маша', username: 'masha' }),
  ...over,
});

describe('validateInitData', () => {
  it('accepts a correctly signed payload', () => {
    const r = validateInitData(signInitData(base()), TOKEN, { nowMs: NOW });
    expect(r.user.id).toBe(42);
    expect(r.user.first_name).toBe('Маша');
  });

  it('rejects a wrong bot token', () => {
    expect(() => validateInitData(signInitData(base(), 'other:token'), TOKEN, { nowMs: NOW })).toThrow(InitDataError);
  });

  it('rejects tampered fields', () => {
    const raw = signInitData(base());
    const forged = raw.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":1000'));
    expect(forged).not.toBe(raw);
    expect(() => validateInitData(forged, TOKEN, { nowMs: NOW })).toThrow(/signature/);
  });

  it('rejects missing / malformed hash', () => {
    expect(() => validateInitData('auth_date=1&user=%7B%7D', TOKEN, { nowMs: NOW })).toThrow(/hash/);
    expect(() => validateInitData('hash=zz&auth_date=1', TOKEN, { nowMs: NOW })).toThrow(/hash/);
  });

  it('rejects duplicate keys even when the signature is otherwise valid', () => {
    const raw = signInitData(base()) + '&auth_date=1';
    expect(() => validateInitData(raw, TOKEN, { nowMs: NOW })).toThrow(/duplicate/);
  });

  it('rejects expired (>24h) and future auth_date', () => {
    const old = signInitData(base({ auth_date: String(NOW / 1000 - 90_000) }));
    expect(() => validateInitData(old, TOKEN, { nowMs: NOW })).toThrow(/expired/);
    const fut = signInitData(base({ auth_date: String(NOW / 1000 + 3600) }));
    expect(() => validateInitData(fut, TOKEN, { nowMs: NOW })).toThrow(/future/);
  });

  it('rejects bots, bad user JSON and non-string input', () => {
    expect(() =>
      validateInitData(signInitData(base({ user: JSON.stringify({ id: 1, first_name: 'b', is_bot: true }) })), TOKEN, {
        nowMs: NOW,
      }),
    ).toThrow(/bot/);
    expect(() => validateInitData(signInitData(base({ user: 'nope' })), TOKEN, { nowMs: NOW })).toThrow(/user/);
    expect(() =>
      validateInitData(signInitData(base({ user: JSON.stringify({ id: -5, first_name: 'x' }) })), TOKEN, {
        nowMs: NOW,
      }),
    ).toThrow(/user/);
    expect(() => validateInitData(undefined, TOKEN)).toThrow(InitDataError);
    expect(() => validateInitData('x'.repeat(9000), TOKEN)).toThrow(InitDataError);
    expect(() => validateInitData(signInitData(base()), '', { nowMs: NOW })).toThrow(/no_token/);
  });
});
