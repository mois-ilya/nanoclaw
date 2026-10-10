/** Guest context storage: draft -> publish (versioned), enabled flag, invocation log. */
import { randomUUID } from 'node:crypto';

import { getDb } from '../db/connection.js';
import { kvGet, kvSet } from './store.js';

export const GUEST_MAX_CHARS = 8000;

export interface PublishedGuest {
  version: number;
  markdown: string;
  publishedAt: string;
}

export async function getPublished(): Promise<PublishedGuest | null> {
  const r = await getDb().get<{ version: number; markdown: string; published_at: string }>(
    'SELECT version, markdown, published_at FROM nc_guest ORDER BY version DESC LIMIT 1',
  );
  return r ? { version: r.version, markdown: r.markdown, publishedAt: r.published_at } : null;
}

export async function getDraft(): Promise<string> {
  return (await getDb().get<{ markdown: string }>('SELECT markdown FROM nc_guest_draft WHERE id = 1'))?.markdown ?? '';
}

export async function putDraft(markdown: string): Promise<void> {
  if (markdown.length > GUEST_MAX_CHARS) throw new Error('too_long');
  await getDb().run(
    'INSERT INTO nc_guest_draft (id, markdown) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown',
    markdown,
  );
}

export async function publishDraft(by: string): Promise<PublishedGuest> {
  const draft = await getDraft();
  const cur = await getPublished();
  const version = (cur?.version ?? 0) + 1;
  const publishedAt = new Date().toISOString();
  await getDb().run(
    'INSERT INTO nc_guest (version, markdown, published_at, published_by) VALUES (?,?,?,?)',
    version,
    draft,
    publishedAt,
    by,
  );
  return { version, markdown: draft, publishedAt };
}

export async function guestEnabled(): Promise<boolean> {
  return (await kvGet('guest:enabled')) === '1';
}

export async function setGuestEnabled(on: boolean): Promise<void> {
  await kvSet('guest:enabled', on ? '1' : '0');
}

export interface GuestLogRow {
  id: string;
  at: string;
  chat_title: string;
  query: string;
  answer: string;
  status: 'placeholder' | 'done' | 'failed';
  inline_message_id: string | null;
}

export async function logGuest(row: Omit<GuestLogRow, 'id' | 'at'>): Promise<string> {
  const id = randomUUID();
  await getDb().run(
    'INSERT INTO nc_guest_log (id, at, chat_title, query, answer, status, inline_message_id) VALUES (?,?,?,?,?,?,?)',
    id,
    new Date().toISOString(),
    row.chat_title.slice(0, 200),
    row.query.slice(0, 1000),
    row.answer.slice(0, 2000),
    row.status,
    row.inline_message_id,
  );
  return id;
}

export async function updateGuestLog(
  id: string,
  patch: { answer?: string; status?: GuestLogRow['status'] },
): Promise<void> {
  await getDb().run(
    'UPDATE nc_guest_log SET answer = COALESCE(?, answer), status = COALESCE(?, status) WHERE id = ?',
    patch.answer?.slice(0, 2000) ?? null,
    patch.status ?? null,
    id,
  );
}

export async function recentGuest(
  limit = 20,
): Promise<Array<{ at: string; chatTitle: string; query: string; answer: string }>> {
  const rows = await getDb().all<GuestLogRow>('SELECT * FROM nc_guest_log ORDER BY at DESC LIMIT ?', limit);
  return rows.map((r) => ({ at: r.at, chatTitle: r.chat_title, query: r.query, answer: r.answer }));
}

/** Placeholder rows; with `before`, only those created before that ISO time (so live summonses are left alone). */
export async function pendingPlaceholders(before?: string): Promise<GuestLogRow[]> {
  return before
    ? getDb().all<GuestLogRow>("SELECT * FROM nc_guest_log WHERE status = 'placeholder' AND at < ?", before)
    : getDb().all<GuestLogRow>("SELECT * FROM nc_guest_log WHERE status = 'placeholder'");
}
