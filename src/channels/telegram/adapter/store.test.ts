import { beforeEach, describe, expect, it } from 'vitest';

import { initSqliteTestDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { DbStore } from './store.js';

describe('DbStore (module migration module:tgadapter:init-tables)', () => {
  let s: DbStore;
  beforeEach(async () => {
    const db = await initSqliteTestDb();
    await runMigrations(db, undefined, { mode: 'migrate' });
    s = new DbStore(db);
  });

  it('journals updates idempotently and tracks status/attempts', async () => {
    expect(await s.saveUpdate(5, '{"a":1}', 10)).toBe(true);
    expect(await s.saveUpdate(5, '{"a":1}', 10)).toBe(false);
    expect(await s.maxUpdateId()).toBe(5);
    expect((await s.loadPending()).map((r) => r.update_id)).toEqual([5]);
    expect(await s.beginUpdate(5)).toBe(1);
    await s.setUpdateStatus(5, 'done');
    expect(await s.loadPending()).toEqual([]);
    await s.purgeUpdates(10 + 25 * 3600 * 1000);
    expect(await s.maxUpdateId()).toBeNull();
  });

  it('drafts, callbacks, chats, guest dedupe', async () => {
    await s.saveDraft({
      chat_id: 1,
      draft_id: 2,
      turn_id: 'T',
      session_id: 'S',
      status_message_id: null,
      created_at: 1,
      closed_at: null,
    });
    expect(await s.getOpenDraft(1, 2)).toMatchObject({ turn_id: 'T' });
    await s.closeDraft(1, 2, 5);
    expect(await s.getOpenDraft(1, 2)).toBeUndefined();

    await s.saveCallback({ short_id: 'x', question_id: 'q', value: 'v', chat_id: 1, created_at: 0, expires_at: 100 });
    expect((await s.getCallback('x'))?.value).toBe('v');
    await s.purgeCallbacks(101);
    expect(await s.getCallback('x')).toBeUndefined();

    expect(await s.isBlocked(9)).toBe(false);
    await s.setBlocked(9, true, 1);
    expect(await s.isBlocked(9)).toBe(true);
    await s.setBlocked(9, false, 2);
    expect(await s.isBlocked(9)).toBe(false);

    expect(await s.markGuestSeen('g', 1)).toBe(true);
    expect(await s.markGuestSeen('g', 2)).toBe(false);
  });
});
