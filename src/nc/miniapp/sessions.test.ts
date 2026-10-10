import { describe, expect, it } from 'vitest';

import { SESSION_TTL_MS, SessionStore } from './sessions.js';

describe('SessionStore', () => {
  it('issues random tokens that expire after 15 minutes', () => {
    let t = 1000;
    const s = new SessionStore(() => t);
    const a = s.create({ tgId: 1, userId: 'telegram:1', epoch: 1 });
    const b = s.create({ tgId: 1, userId: 'telegram:1', epoch: 1 });
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(40);
    expect(s.get(a.token)?.tgId).toBe(1);
    t += SESSION_TTL_MS + 1;
    expect(s.get(a.token)).toBeNull();
  });

  it('revokes all sessions of a user only', () => {
    const s = new SessionStore();
    const a = s.create({ tgId: 1, userId: 'telegram:1', epoch: 1 });
    const b = s.create({ tgId: 2, userId: 'telegram:2', epoch: 1 });
    expect(s.revokeUser(1)).toBe(1);
    expect(s.get(a.token)).toBeNull();
    expect(s.get(b.token)).not.toBeNull();
  });

  it('caps sessions per user', () => {
    const s = new SessionStore();
    const toks = Array.from({ length: 12 }, () => s.create({ tgId: 1, userId: 'telegram:1', epoch: 1 }).token);
    expect(s.get(toks[0])).toBeNull();
    expect(s.get(toks[11])).not.toBeNull();
  });
});
