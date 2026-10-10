import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import type { Message } from '../channels/telegram/botapi/index.js';
import { publishDraft, putDraft, setGuestEnabled } from './guest-store.js';
import { guestHandler, resetGuestCacheForTests } from './guest.js';
import { OWNER, fakeNanogate, installFakeAdapter, setupDb } from './test-helpers.js';

vi.mock('./templates.js', async (orig) => ({
  ...(await orig<typeof import('./templates.js')>()),
  guestSystemTemplate: () => {
    throw new Error('nc: templates directory not found');
  },
}));

let fake: ReturnType<typeof installFakeAdapter>;

beforeEach(async () => {
  process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
  delete process.env.NC_GUEST_PLACEHOLDER;
  resetGuestCacheForTests();
  await setupDb();
  fake = installFakeAdapter();
  setNanogateAdminForTests(fakeNanogate());
  await putDraft('Илья живёт в Тбилиси.');
  await publishDraft('owner');
  await setGuestEnabled(true);
});
afterEach(async () => {
  setNanogateAdminForTests(null);
  await closeDb();
  delete process.env.NC_GUEST_PLACEHOLDER;
});

const msg = (): Message =>
  ({
    message_id: 1,
    date: 1,
    chat: { id: -100, type: 'group', title: 'Семья' },
    from: { id: OWNER, is_bot: false, first_name: 'Илья' },
    guest_query_id: 'gq1',
    text: '@bot подскажи',
  }) as Message;

it('a failing guest template yields the error copy (direct mode), not a throw', async () => {
  const f = vi.fn() as unknown as typeof fetch;
  await expect(guestHandler(msg(), f)).resolves.toBeUndefined();
  expect(f).not.toHaveBeenCalled();
  expect(JSON.stringify(fake.api.answerGuestQuery.mock.calls[0][1])).toContain('Не удалось');
});

it('a failing guest template yields the error copy (placeholder mode)', async () => {
  process.env.NC_GUEST_PLACEHOLDER = '1';
  const f = vi.fn() as unknown as typeof fetch;
  await expect(guestHandler(msg(), f)).resolves.toBeUndefined();
  expect(JSON.stringify(fake.api.editMessageText.mock.calls.at(-1))).toContain('Не удалось');
});
