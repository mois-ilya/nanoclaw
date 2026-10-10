/** In-memory Mini App bearer sessions: random tokens, 15-minute TTL. */
import { randomBytes } from 'node:crypto';

export const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_PER_USER = 8;
const MAX_TOTAL = 5000;

export interface AppSession {
  token: string;
  tgId: number;
  userId: string;
  /** Tenant epoch at login: a bump (re-approval / delete) invalidates the session. */
  epoch: number;
  expiresAt: number;
}

export class SessionStore {
  private readonly byToken = new Map<string, AppSession>();

  constructor(private readonly now: () => number = Date.now) {}

  create(s: { tgId: number; userId: string; epoch: number }): AppSession {
    this.sweep();
    const mine = [...this.byToken.values()].filter((x) => x.tgId === s.tgId).sort((a, b) => a.expiresAt - b.expiresAt);
    while (mine.length >= MAX_PER_USER) this.byToken.delete(mine.shift()!.token);
    if (this.byToken.size >= MAX_TOTAL) {
      const oldest = [...this.byToken.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0];
      if (oldest) this.byToken.delete(oldest.token);
    }
    const session: AppSession = {
      token: randomBytes(32).toString('base64url'),
      tgId: s.tgId,
      userId: s.userId,
      epoch: s.epoch,
      expiresAt: this.now() + SESSION_TTL_MS,
    };
    this.byToken.set(session.token, session);
    return session;
  }

  get(token: string): AppSession | null {
    const s = this.byToken.get(token);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.byToken.delete(token);
      return null;
    }
    return s;
  }

  revokeUser(tgId: number): number {
    let n = 0;
    for (const [tok, s] of this.byToken) {
      if (s.tgId === tgId) {
        this.byToken.delete(tok);
        n++;
      }
    }
    return n;
  }

  sweep(): void {
    const t = this.now();
    for (const [tok, s] of this.byToken) if (s.expiresAt <= t) this.byToken.delete(tok);
  }

  get size(): number {
    return this.byToken.size;
  }
}

export const sessions = new SessionStore();
