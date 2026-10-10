import crypto from 'node:crypto';
import fs from 'node:fs';
import { type Db, type TenantRow, getTenant } from './db.js';

export type TokenKind = 'session' | 'host';

/** Opaque on purpose: must not resemble `sk-...` keys or JWTs. */
export function mintToken(kind: TokenKind): string {
  return (kind === 'session' ? 'ngs_' : 'ngh_') + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function loadEncryptionKey(file: string): Buffer {
  const s = fs.readFileSync(file, 'utf8').trim();
  const key = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes (hex or base64)');
  return key;
}

/** AES-256-GCM; output base64(iv | tag | ciphertext). */
export function encrypt(key: Buffer, plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(key: Buffer, enc: string): string {
  const b = Buffer.from(enc, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}

export interface Auth {
  tokenHash: string;
  kind: TokenKind;
  tenant: TenantRow;
  sessionKey: string | null;
  purpose: string | null;
}

export type AuthResult = { ok: true; auth: Auth } | { ok: false; reason: 'invalid' | 'paused' };

/** Identity comes only from the token. The hash lookup is the constant-time-safe comparison. */
export function authenticate(db: Db, raw: string | undefined, want: TokenKind): AuthResult {
  if (!raw || raw.length > 256) return { ok: false, reason: 'invalid' };
  return lookupToken(db, hashToken(raw), want);
}

/**
 * Re-check an already authenticated token against current state (revoked, tenant paused/revoked, epoch) and
 * return fresh tenant data. Called right before dialling / forwarding, after awaits during which an admin
 * may have revoked or paused.
 */
export function revalidate(db: Db, auth: Auth): AuthResult {
  return lookupToken(db, auth.tokenHash, auth.kind);
}

function lookupToken(db: Db, hash: string, want: TokenKind): AuthResult {
  const row = db
    .prepare('SELECT tenant_id, kind, session_key, purpose, epoch FROM tokens WHERE hash = ? AND revoked_at IS NULL')
    .get(hash) as { tenant_id: string; kind: TokenKind; session_key: string | null; purpose: string | null; epoch: number } | undefined;
  if (!row || row.kind !== want) return { ok: false, reason: 'invalid' };
  const tenant = getTenant(db, row.tenant_id);
  if (!tenant || tenant.status === 'revoked' || tenant.epoch !== row.epoch) return { ok: false, reason: 'invalid' };
  if (tenant.status !== 'active') return { ok: false, reason: 'paused' };
  return { ok: true, auth: { tokenHash: hash, kind: row.kind, tenant, sessionKey: row.session_key, purpose: row.purpose } };
}

export function insertToken(
  db: Db,
  p: { token: string; kind: TokenKind; tenantId: string; epoch: number; enc?: string; sessionKey?: string; purpose?: string; runtimeIdentity?: string },
): string {
  const hash = hashToken(p.token);
  db.prepare(
    `INSERT INTO tokens(hash, enc, kind, tenant_id, session_key, purpose, runtime_identity, epoch, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(hash, p.enc ?? null, p.kind, p.tenantId, p.sessionKey ?? null, p.purpose ?? null, p.runtimeIdentity ?? null, p.epoch, Date.now());
  return hash;
}

/** Revoke by predicate; returns the revoked rows so callers can kill live work. */
export function revokeTokens(db: Db, where: string, ...args: unknown[]): { hash: string; session_key: string | null }[] {
  const rows = db
    .prepare(`SELECT hash, session_key FROM tokens WHERE revoked_at IS NULL AND (${where})`)
    .all(...args) as { hash: string; session_key: string | null }[];
  const upd = db.prepare('UPDATE tokens SET revoked_at = ? WHERE hash = ?');
  const now = Date.now();
  for (const r of rows) upd.run(now, r.hash);
  return rows;
}
