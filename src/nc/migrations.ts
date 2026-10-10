import { registerMigration } from '../db/migrations/index.js';

registerMigration({
  version: 1,
  name: 'module:nc:init',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS nc_tenants (
        user_id          TEXT PRIMARY KEY,
        tg_id            INTEGER NOT NULL UNIQUE,
        name             TEXT NOT NULL,
        username         TEXT,
        state            TEXT NOT NULL,
        agent_group_id   TEXT,
        epoch            INTEGER NOT NULL DEFAULT 1,
        limit_usd_micros INTEGER,
        egress           TEXT NOT NULL DEFAULT 'direct',
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        decided_at       TEXT,
        denied_until     TEXT
      );
      CREATE TABLE IF NOT EXISTS nc_requests (
        id              TEXT PRIMARY KEY,
        tg_id           INTEGER NOT NULL,
        first_message   TEXT NOT NULL,
        card_message_id INTEGER,
        status          TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_nc_requests_tg ON nc_requests(tg_id, status);
      CREATE TABLE IF NOT EXISTS nc_retained (
        tg_id       INTEGER NOT NULL,
        seq         INTEGER NOT NULL,
        update_json TEXT NOT NULL,
        PRIMARY KEY (tg_id, seq)
      );
      CREATE TABLE IF NOT EXISTS nc_prefs (
        user_id    TEXT PRIMARY KEY,
        lang       TEXT NOT NULL DEFAULT 'ru',
        tz         TEXT NOT NULL DEFAULT 'Europe/Moscow',
        preset     TEXT NOT NULL DEFAULT 'normal',
        quiet_from TEXT,
        quiet_to   TEXT,
        show_steps INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS nc_audit (
        id     TEXT PRIMARY KEY,
        at     TEXT NOT NULL,
        actor  TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS nc_guest (
        version      INTEGER PRIMARY KEY,
        markdown     TEXT NOT NULL,
        published_at TEXT NOT NULL,
        published_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nc_guest_draft (
        id       INTEGER PRIMARY KEY CHECK (id = 1),
        markdown TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nc_guest_log (
        id                TEXT PRIMARY KEY,
        at                TEXT NOT NULL,
        chat_title        TEXT NOT NULL,
        query             TEXT NOT NULL,
        answer            TEXT NOT NULL,
        status            TEXT NOT NULL,
        inline_message_id TEXT
      );
      CREATE TABLE IF NOT EXISTS nc_jobs (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL,
        tenant     TEXT NOT NULL,
        step       TEXT NOT NULL,
        status     TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nc_notices (
        tg_id INTEGER NOT NULL,
        kind  TEXT NOT NULL,
        at    TEXT NOT NULL,
        PRIMARY KEY (tg_id, kind)
      );
      CREATE TABLE IF NOT EXISTS nc_usage_voice (
        id        TEXT PRIMARY KEY,
        user_id   TEXT NOT NULL,
        at        TEXT NOT NULL,
        seconds   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nc_kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  },
});

registerMigration({
  version: 2,
  name: 'module:nc:turn-metrics',
  up: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS nc_turn_metrics (
        id             TEXT PRIMARY KEY,
        at             TEXT NOT NULL,
        chat_id        INTEGER NOT NULL,
        outcome        TEXT NOT NULL,
        react_ms       INTEGER,
        first_ms       INTEGER,
        final_ms       INTEGER,
        voice          INTEGER NOT NULL DEFAULT 0,
        cold_start     INTEGER NOT NULL DEFAULT 0,
        stopped        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_nc_turn_metrics_at ON nc_turn_metrics(at);
    `);
  },
});
