/**
 * Persistence for the Telegram adapter: raw update journal (offset advance
 * only after persist), draft→turn mapping (stop button), callback shortening
 * and bot-blocked chats. Module migrations `module:tgadapter:*`.
 */
import { registerMigration } from '../../../db/migrations/index.js';
import { getDb } from '../../../db/connection.js';
import type { DbDriver } from '../../../db/driver.js';

registerMigration({
  version: 1,
  name: 'module:tgadapter:init-tables',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS nc_tg_updates (
        update_id   INTEGER PRIMARY KEY,
        json        TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        status      TEXT NOT NULL DEFAULT 'new',
        attempts    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_nc_tg_updates_status ON nc_tg_updates(status, update_id);
      CREATE TABLE IF NOT EXISTS nc_tg_drafts (
        chat_id           INTEGER NOT NULL,
        draft_id          INTEGER NOT NULL,
        turn_id           TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        status_message_id INTEGER,
        created_at        INTEGER NOT NULL,
        closed_at         INTEGER,
        PRIMARY KEY (chat_id, draft_id)
      );
      CREATE TABLE IF NOT EXISTS nc_tg_callbacks (
        short_id    TEXT PRIMARY KEY,
        question_id TEXT NOT NULL,
        value       TEXT NOT NULL,
        chat_id     INTEGER NOT NULL,
        created_at  INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nc_tg_callbacks_expires ON nc_tg_callbacks(expires_at);
      CREATE TABLE IF NOT EXISTS nc_tg_chats (
        chat_id    INTEGER PRIMARY KEY,
        blocked    INTEGER NOT NULL DEFAULT 0,
        blocked_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nc_tg_guest_seen (
        guest_query_id TEXT PRIMARY KEY,
        at             INTEGER NOT NULL
      );
    `);
  },
});

registerMigration({
  version: 2,
  name: 'module:tgadapter:voice-finals',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS nc_tg_voice (
        chat_id    INTEGER NOT NULL,
        msg_id     INTEGER NOT NULL,
        json       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (chat_id, msg_id)
      );
      CREATE TABLE IF NOT EXISTS nc_tg_finals (
        id         TEXT PRIMARY KEY,
        chat_id    INTEGER NOT NULL,
        markdown   TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  },
});

export type UpdateStatus = 'new' | 'processing' | 'done' | 'failed';

export interface StoredUpdate {
  update_id: number;
  json: string;
  attempts: number;
}

export interface DraftRow {
  chat_id: number;
  draft_id: number;
  turn_id: string;
  session_id: string;
  status_message_id: number | null;
  created_at: number;
  closed_at: number | null;
}

export interface CallbackRow {
  short_id: string;
  question_id: string;
  value: string;
  chat_id: number;
  created_at: number;
  expires_at: number;
}

/** Transcript echo for a voice/video-note/audio inbound (see ux §2.4). */
export interface VoiceEcho {
  kind: 'voice' | 'video_note' | 'audio';
  transcript: string;
}

export interface FinalRow {
  id: string;
  chat_id: number;
  markdown: string;
  created_at: number;
}

export const AUX_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const CALLBACK_TTL_MS = 30 * 24 * 3600 * 1000;
/** Done updates carry user text: keep them only briefly. */
export const DONE_UPDATE_RETENTION_MS = 24 * 3600 * 1000;
export const FAILED_UPDATE_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const MAX_UPDATE_ATTEMPTS = 3;

export interface TgStore {
  /** Returns true when the update was new (not yet journaled). */
  saveUpdate(updateId: number, json: string, at: number): Promise<boolean>;
  setUpdateStatus(updateId: number, status: UpdateStatus): Promise<void>;
  /** Marks the update `processing` and bumps attempts; returns the new attempt count. */
  beginUpdate(updateId: number): Promise<number>;
  loadPending(): Promise<StoredUpdate[]>;
  maxUpdateId(): Promise<number | null>;
  purgeUpdates(now: number): Promise<void>;

  saveDraft(row: DraftRow): Promise<void>;
  getOpenDraft(chatId: number, draftId: number): Promise<DraftRow | undefined>;
  setDraftStatusMessage(chatId: number, draftId: number, messageId: number): Promise<void>;
  closeDraft(chatId: number, draftId: number, at: number): Promise<void>;
  /** Draft rows left open by a previous process. */
  closeAllOpenDrafts(at: number): Promise<void>;
  /** Open drafts of a previous process that already have a status card. */
  listOpenStatusCards(): Promise<DraftRow[]>;

  saveVoice(chatId: number, msgId: number, echoes: VoiceEcho[], at: number): Promise<void>;
  /** Returns the echoes for an inbound message and removes them. */
  takeVoice(chatId: number, msgId: number): Promise<VoiceEcho[] | undefined>;
  saveFinal(row: FinalRow): Promise<void>;
  getFinal(id: string): Promise<FinalRow | undefined>;

  saveCallback(row: CallbackRow): Promise<void>;
  getCallback(shortId: string): Promise<CallbackRow | undefined>;
  purgeCallbacks(now: number): Promise<void>;

  setBlocked(chatId: number, blocked: boolean, at: number): Promise<void>;
  isBlocked(chatId: number): Promise<boolean>;

  /** Returns true when first seen. */
  markGuestSeen(guestQueryId: string, at: number): Promise<boolean>;
}

export class DbStore implements TgStore {
  constructor(private readonly db: DbDriver = getDb()) {}

  async saveUpdate(updateId: number, json: string, at: number): Promise<boolean> {
    const r = await this.db.run(
      'INSERT OR IGNORE INTO nc_tg_updates (update_id, json, received_at, status, attempts) VALUES (?, ?, ?, ?, 0)',
      updateId,
      json,
      at,
      'new',
    );
    return r.changes > 0;
  }
  async setUpdateStatus(updateId: number, status: UpdateStatus): Promise<void> {
    await this.db.run('UPDATE nc_tg_updates SET status = ? WHERE update_id = ?', status, updateId);
  }
  async beginUpdate(updateId: number): Promise<number> {
    await this.db.run(
      "UPDATE nc_tg_updates SET status = 'processing', attempts = attempts + 1 WHERE update_id = ?",
      updateId,
    );
    const row = await this.db.get<{ attempts: number }>(
      'SELECT attempts FROM nc_tg_updates WHERE update_id = ?',
      updateId,
    );
    return row?.attempts ?? 1;
  }
  async loadPending(): Promise<StoredUpdate[]> {
    return this.db.all<StoredUpdate>(
      "SELECT update_id, json, attempts FROM nc_tg_updates WHERE status IN ('new','processing') AND attempts < ? ORDER BY update_id",
      MAX_UPDATE_ATTEMPTS,
    );
  }
  async maxUpdateId(): Promise<number | null> {
    const row = await this.db.get<{ m: number | null }>('SELECT MAX(update_id) AS m FROM nc_tg_updates');
    return row?.m ?? null;
  }
  async purgeUpdates(now: number): Promise<void> {
    await this.db.run(
      "DELETE FROM nc_tg_updates WHERE (status = 'done' AND received_at < ?) OR (status = 'failed' AND received_at < ?)",
      now - DONE_UPDATE_RETENTION_MS,
      now - FAILED_UPDATE_RETENTION_MS,
    );
  }

  async saveDraft(row: DraftRow): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO nc_tg_drafts (chat_id, draft_id, turn_id, session_id, status_message_id, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      row.chat_id,
      row.draft_id,
      row.turn_id,
      row.session_id,
      row.status_message_id,
      row.created_at,
      row.closed_at,
    );
  }
  async getOpenDraft(chatId: number, draftId: number): Promise<DraftRow | undefined> {
    return this.db.get<DraftRow>(
      'SELECT * FROM nc_tg_drafts WHERE chat_id = ? AND draft_id = ? AND closed_at IS NULL',
      chatId,
      draftId,
    );
  }
  async setDraftStatusMessage(chatId: number, draftId: number, messageId: number): Promise<void> {
    await this.db.run(
      'UPDATE nc_tg_drafts SET status_message_id = ? WHERE chat_id = ? AND draft_id = ?',
      messageId,
      chatId,
      draftId,
    );
  }
  async closeDraft(chatId: number, draftId: number, at: number): Promise<void> {
    await this.db.run(
      'UPDATE nc_tg_drafts SET closed_at = ? WHERE chat_id = ? AND draft_id = ? AND closed_at IS NULL',
      at,
      chatId,
      draftId,
    );
  }
  async closeAllOpenDrafts(at: number): Promise<void> {
    await this.db.run('UPDATE nc_tg_drafts SET closed_at = ? WHERE closed_at IS NULL', at);
  }

  async listOpenStatusCards(): Promise<DraftRow[]> {
    return this.db.all<DraftRow>(
      'SELECT * FROM nc_tg_drafts WHERE closed_at IS NULL AND status_message_id IS NOT NULL',
    );
  }
  async saveVoice(chatId: number, msgId: number, echoes: VoiceEcho[], at: number): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO nc_tg_voice (chat_id, msg_id, json, created_at) VALUES (?, ?, ?, ?)',
      chatId,
      msgId,
      JSON.stringify(echoes),
      at,
    );
    await this.db.run('DELETE FROM nc_tg_voice WHERE created_at < ?', at - AUX_RETENTION_MS);
  }
  async takeVoice(chatId: number, msgId: number): Promise<VoiceEcho[] | undefined> {
    const row = await this.db.get<{ json: string }>(
      'SELECT json FROM nc_tg_voice WHERE chat_id = ? AND msg_id = ?',
      chatId,
      msgId,
    );
    if (!row) return undefined;
    await this.db.run('DELETE FROM nc_tg_voice WHERE chat_id = ? AND msg_id = ?', chatId, msgId);
    try {
      return JSON.parse(row.json) as VoiceEcho[];
    } catch {
      return undefined;
    }
  }
  async saveFinal(row: FinalRow): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO nc_tg_finals (id, chat_id, markdown, created_at) VALUES (?, ?, ?, ?)',
      row.id,
      row.chat_id,
      row.markdown,
      row.created_at,
    );
    await this.db.run('DELETE FROM nc_tg_finals WHERE created_at < ?', row.created_at - AUX_RETENTION_MS);
  }
  async getFinal(id: string): Promise<FinalRow | undefined> {
    return this.db.get<FinalRow>('SELECT * FROM nc_tg_finals WHERE id = ?', id);
  }

  async saveCallback(row: CallbackRow): Promise<void> {
    await this.db.run(
      'INSERT OR REPLACE INTO nc_tg_callbacks (short_id, question_id, value, chat_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      row.short_id,
      row.question_id,
      row.value,
      row.chat_id,
      row.created_at,
      row.expires_at,
    );
  }
  async getCallback(shortId: string): Promise<CallbackRow | undefined> {
    return this.db.get<CallbackRow>('SELECT * FROM nc_tg_callbacks WHERE short_id = ?', shortId);
  }
  async purgeCallbacks(now: number): Promise<void> {
    await this.db.run('DELETE FROM nc_tg_callbacks WHERE expires_at < ?', now);
  }

  async setBlocked(chatId: number, blocked: boolean, at: number): Promise<void> {
    await this.db.run(
      'INSERT INTO nc_tg_chats (chat_id, blocked, blocked_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id) DO UPDATE SET blocked = excluded.blocked, blocked_at = excluded.blocked_at, updated_at = excluded.updated_at',
      chatId,
      blocked ? 1 : 0,
      blocked ? at : null,
      at,
    );
  }
  async isBlocked(chatId: number): Promise<boolean> {
    const row = await this.db.get<{ blocked: number }>('SELECT blocked FROM nc_tg_chats WHERE chat_id = ?', chatId);
    return row?.blocked === 1;
  }

  async markGuestSeen(guestQueryId: string, at: number): Promise<boolean> {
    const r = await this.db.run(
      'INSERT OR IGNORE INTO nc_tg_guest_seen (guest_query_id, at) VALUES (?, ?)',
      guestQueryId,
      at,
    );
    if (r.changes > 0) {
      await this.db.run('DELETE FROM nc_tg_guest_seen WHERE at < ?', at - 7 * 24 * 3600 * 1000);
    }
    return r.changes > 0;
  }
}

/** In-memory store for tests and as a degraded fallback. */
export class MemoryStore implements TgStore {
  updates = new Map<number, { json: string; at: number; status: UpdateStatus; attempts: number }>();
  drafts = new Map<string, DraftRow>();
  callbacks = new Map<string, CallbackRow>();
  blocked = new Map<number, boolean>();
  guest = new Set<string>();

  async saveUpdate(id: number, json: string, at: number) {
    if (this.updates.has(id)) return false;
    this.updates.set(id, { json, at, status: 'new', attempts: 0 });
    return true;
  }
  async setUpdateStatus(id: number, status: UpdateStatus) {
    const u = this.updates.get(id);
    if (u) u.status = status;
  }
  async beginUpdate(id: number) {
    const u = this.updates.get(id);
    if (!u) return 1;
    u.status = 'processing';
    u.attempts += 1;
    return u.attempts;
  }
  async loadPending() {
    return [...this.updates.entries()]
      .filter(([, u]) => (u.status === 'new' || u.status === 'processing') && u.attempts < MAX_UPDATE_ATTEMPTS)
      .sort((a, b) => a[0] - b[0])
      .map(([update_id, u]) => ({ update_id, json: u.json, attempts: u.attempts }));
  }
  async maxUpdateId() {
    let m: number | null = null;
    for (const k of this.updates.keys()) if (m === null || k > m) m = k;
    return m;
  }
  async purgeUpdates(now: number) {
    for (const [k, u] of this.updates) {
      if (
        (u.status === 'done' && u.at < now - DONE_UPDATE_RETENTION_MS) ||
        (u.status === 'failed' && u.at < now - FAILED_UPDATE_RETENTION_MS)
      )
        this.updates.delete(k);
    }
  }
  private dk(chatId: number, draftId: number) {
    return `${chatId}:${draftId}`;
  }
  async saveDraft(row: DraftRow) {
    this.drafts.set(this.dk(row.chat_id, row.draft_id), { ...row });
  }
  async getOpenDraft(chatId: number, draftId: number) {
    const d = this.drafts.get(this.dk(chatId, draftId));
    return d && d.closed_at === null ? { ...d } : undefined;
  }
  async setDraftStatusMessage(chatId: number, draftId: number, messageId: number) {
    const d = this.drafts.get(this.dk(chatId, draftId));
    if (d) d.status_message_id = messageId;
  }
  async closeDraft(chatId: number, draftId: number, at: number) {
    const d = this.drafts.get(this.dk(chatId, draftId));
    if (d && d.closed_at === null) d.closed_at = at;
  }
  async closeAllOpenDrafts(at: number) {
    for (const d of this.drafts.values()) if (d.closed_at === null) d.closed_at = at;
  }
  voices = new Map<string, VoiceEcho[]>();
  finals = new Map<string, FinalRow>();
  async listOpenStatusCards() {
    return [...this.drafts.values()]
      .filter((d) => d.closed_at === null && d.status_message_id !== null)
      .map((d) => ({ ...d }));
  }
  async saveVoice(chatId: number, msgId: number, echoes: VoiceEcho[]) {
    this.voices.set(`${chatId}:${msgId}`, echoes);
  }
  async takeVoice(chatId: number, msgId: number) {
    const k = `${chatId}:${msgId}`;
    const v = this.voices.get(k);
    this.voices.delete(k);
    return v;
  }
  async saveFinal(row: FinalRow) {
    this.finals.set(row.id, { ...row });
  }
  async getFinal(id: string) {
    const f = this.finals.get(id);
    return f ? { ...f } : undefined;
  }
  async saveCallback(row: CallbackRow) {
    this.callbacks.set(row.short_id, { ...row });
  }
  async getCallback(shortId: string) {
    const c = this.callbacks.get(shortId);
    return c ? { ...c } : undefined;
  }
  async purgeCallbacks(now: number) {
    for (const [k, c] of this.callbacks) if (c.expires_at < now) this.callbacks.delete(k);
  }
  async setBlocked(chatId: number, blocked: boolean, _at?: number) {
    this.blocked.set(chatId, blocked);
  }
  async isBlocked(chatId: number) {
    return this.blocked.get(chatId) === true;
  }
  async markGuestSeen(id: string) {
    if (this.guest.has(id)) return false;
    this.guest.add(id);
    return true;
  }
}
