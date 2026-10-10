/**
 * Task button tokens: `p:tp:<tok>` etc. bind (presser, series) and survive restarts
 * (kv `ttok:<tok>`, 30 days). The presser/group binding is re-checked on every press.
 */
import { randomBytes } from 'node:crypto';

import { kvDelete, kvGet, kvSet } from './store.js';
import { getDb } from '../db/connection.js';

export const TASK_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PER_USER = 300;

export interface TaskTokenEntry {
  tgId: number;
  seriesId: string;
  exp: number;
  /** Pressed on the `/tasks` list message: re-render it after the action. */
  list?: boolean;
}

export async function mintTaskToken(tgId: number, seriesId: string, list = false): Promise<string> {
  const db = getDb();
  const now = Date.now();
  const rows = await db.all<{ key: string; value: string }>("SELECT key, value FROM nc_kv WHERE key LIKE 'ttok:%'");
  let mine = 0;
  for (const r of rows) {
    try {
      const e = JSON.parse(r.value) as TaskTokenEntry;
      if (e.exp < now) await kvDelete(r.key);
      else if (e.tgId === tgId) mine++;
    } catch {
      await kvDelete(r.key);
    }
  }
  if (mine > MAX_PER_USER) {
    // A runaway list view: drop this user's oldest tokens rather than grow without bound.
    for (const r of rows) {
      try {
        if ((JSON.parse(r.value) as TaskTokenEntry).tgId === tgId) await kvDelete(r.key);
      } catch {
        /* already handled above */
      }
    }
  }
  const tok = randomBytes(5).toString('hex');
  await kvSet(
    `ttok:${tok}`,
    JSON.stringify({
      tgId,
      seriesId,
      exp: now + TASK_TOKEN_TTL_MS,
      ...(list ? { list: true } : {}),
    } satisfies TaskTokenEntry),
  );
  return tok;
}

export async function lookupTaskToken(tok: string): Promise<TaskTokenEntry | undefined> {
  if (!/^[0-9a-f]{10}$/.test(tok)) return undefined;
  const raw = await kvGet(`ttok:${tok}`);
  if (!raw) return undefined;
  try {
    const e = JSON.parse(raw) as TaskTokenEntry;
    return e.exp >= Date.now() ? e : undefined;
  } catch {
    return undefined;
  }
}
