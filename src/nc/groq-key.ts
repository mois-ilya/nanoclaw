/**
 * Groq API key for voice transcription. Host-only: the Mini App writes it under `<DATA_DIR>/secrets/`, which is
 * never mounted into an agent container. Resolution: Mini-App file, then the file named by `NC_GROQ_KEY_FILE`
 * (systemd credential under Nix), else none. Never log the value.
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
  source: 'miniapp' | 'server';
  savedAt?: string;
}

export function miniappKeyDir(): string {
  return path.join(DATA_DIR, 'secrets');
}
export function miniappKeyPath(): string {
  return path.join(miniappKeyDir(), 'groq_api_key');
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

/** Every configured key, Mini App first. */
export function groqKeyCandidates(): GroqKey[] {
  const out: GroqKey[] = [];
  const mini = readKeyFile(miniappKeyPath());
  if (mini) out.push({ key: mini.key, source: 'miniapp', savedAt: mini.mtime });
  const f = process.env.NC_GROQ_KEY_FILE?.trim();
  if (f) {
    const srv = readKeyFile(f);
    if (srv && srv.key !== mini?.key) out.push({ key: srv.key, source: 'server' });
  }
  return out;
}

/** The first configured key (for display), parked or not. */
export function resolveGroqKey(): GroqKey | null {
  return groqKeyCandidates()[0] ?? null;
}

/** The first configured key that is not parked after a 401/403: a parked Mini App key falls through to the server key. */
export function usableGroqKey(): GroqKey | null {
  return groqKeyCandidates().find((k) => !isGroqKeyInvalid(k.key)) ?? null;
}

/** True when some configured key is currently parked. */
export function anyGroqKeyInvalid(): boolean {
  return groqKeyCandidates().some((k) => isGroqKeyInvalid(k.key));
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
