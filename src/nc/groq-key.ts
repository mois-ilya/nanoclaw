/**
 * Groq API keys for voice transcription. Host-only: the Mini App writes them under `<DATA_DIR>/secrets/`, which is
 * never mounted into an agent container. Candidates in order: the user's own key (`secrets/groq/<user_id>`), the
 * shared Mini-App key (the owner's, for everyone), the file named by `NC_GROQ_KEY_FILE` (systemd credential under
 * Nix). Never log the value.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { normalizeTokenFile } from '../env.js';
import { log } from '../log.js';

export const GROQ_KEY_RE = /^gsk_[A-Za-z0-9]{20,200}$/;
const INVALID_MS = 10 * 60_000;

export interface GroqKey {
  key: string;
  source: 'own' | 'miniapp' | 'server';
  savedAt?: string;
}

export function miniappKeyDir(): string {
  return path.join(DATA_DIR, 'secrets');
}
export function miniappKeyPath(): string {
  return path.join(miniappKeyDir(), 'groq_api_key');
}

/** Per-user keys. The user id is reduced to a safe file name (`telegram:123` -> `telegram_123`). */
export function userKeyDir(): string {
  return path.join(miniappKeyDir(), 'groq');
}
export function userKeyPath(userId: string): string {
  return path.join(userKeyDir(), userId.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

/** Atomic 0600 write into a 0700 directory. */
export function writeKeyFile(file: string, key: string): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC, 0o600);
  try {
    fs.writeSync(fd, `${key}\n`);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function deleteUserKey(userId: string): void {
  fs.rmSync(userKeyPath(userId), { force: true });
}

function readKeyFile(file: string): { key: string; mtime: string } | null {
  try {
    const key = normalizeTokenFile(fs.readFileSync(file, 'utf8'));
    return key ? { key, mtime: fs.statSync(file).mtime.toISOString() } : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('nc: cannot read groq key file', { file });
    return null;
  }
}

/** Every distinct configured key: the user's own (when given), then the Mini App one, then the server one. */
export function groqKeyCandidates(userId?: string): GroqKey[] {
  const out: GroqKey[] = [];
  const add = (k: GroqKey): void => {
    if (!out.some((o) => o.key === k.key)) out.push(k);
  };
  if (userId) {
    const own = readKeyFile(userKeyPath(userId));
    if (own) add({ key: own.key, source: 'own', savedAt: own.mtime });
  }
  const mini = readKeyFile(miniappKeyPath());
  if (mini) add({ key: mini.key, source: 'miniapp', savedAt: mini.mtime });
  const f = process.env.NC_GROQ_KEY_FILE?.trim();
  if (f) {
    const srv = readKeyFile(f);
    if (srv) add({ key: srv.key, source: 'server' });
  }
  return out;
}

/** The first configured key (for display), parked or not. */
export function resolveGroqKey(userId?: string): GroqKey | null {
  return groqKeyCandidates(userId)[0] ?? null;
}

/** The first configured key that is not parked after a 401/403: a parked key falls through to the next candidate. */
export function usableGroqKey(userId?: string): GroqKey | null {
  return usableGroqKeys(userId)[0] ?? null;
}

/** Every configured key that is not parked, in order (the transcriber tries them one by one). */
export function usableGroqKeys(userId?: string): GroqKey[] {
  return groqKeyCandidates(userId).filter((k) => !isGroqKeyInvalid(k.key));
}

/** True when some configured key is currently parked. */
export function anyGroqKeyInvalid(userId?: string): boolean {
  return groqKeyCandidates(userId).some((k) => isGroqKeyInvalid(k.key));
}

// A 401/403 from Groq parks that exact key for 10 minutes; a different (re-saved) key is tried at once.
const parked = new Map<string, number>();

export function markGroqKeyInvalid(key: string): void {
  parked.set(key, Date.now() + INVALID_MS);
}
export function isGroqKeyInvalid(key: string): boolean {
  const until = parked.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  parked.delete(key);
  return false;
}
export function resetGroqKeyState(): void {
  parked.clear();
}
