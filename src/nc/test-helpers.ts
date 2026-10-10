/** Shared fakes for the nc tests. Not a test file. */
import { vi } from 'vitest';

import type { BotApi } from '../channels/telegram/botapi/index.js';
import type { NanogateAdmin } from '../gateway-providers/nanogate/index.js';
import { setAdapterSend, type AdapterSend, type ProductButton } from './port.js';

export const OWNER = 1000;
export const FRIEND_A = 2001;
export const FRIEND_B = 2002;

export interface Sent {
  chatId: number;
  md: string;
  buttons?: ProductButton[][];
  messageId: number;
}

export function installFakeAdapter(
  opts: {
    replay?: (u: unknown) => Promise<void>;
    hasActiveTurn?: (chatId: number) => boolean | undefined;
    retryPrompt?: (chatId: number, turnId: string) => Promise<string | undefined>;
    buttonValue?: (chatId: number, shortId: string, kind: string) => Promise<string | undefined>;
  } = {},
): {
  sent: Sent[];
  edited: Array<{ chatId: number; messageId: number; md: string; buttons?: ProductButton[][] }>;
  cleared: Array<{ chatId: number; messageId: number }>;
  api: Record<string, ReturnType<typeof vi.fn>>;
} {
  const sent: Sent[] = [];
  const edited: Array<{ chatId: number; messageId: number; md: string; buttons?: ProductButton[][] }> = [];
  const cleared: Array<{ chatId: number; messageId: number }> = [];
  let nextId = 100;
  const api: Record<string, ReturnType<typeof vi.fn>> = {
    setChatMenuButton: vi.fn(async () => true),
    setMyCommands: vi.fn(async () => true),
    getMyCommands: vi.fn(async () => []),
    setMyDescription: vi.fn(async () => true),
    getMyDescription: vi.fn(async () => ({ description: '' })),
    setMyShortDescription: vi.fn(async () => true),
    getMyShortDescription: vi.fn(async () => ({ short_description: '' })),
    answerGuestQuery: vi.fn(async () => ({ inline_message_id: 'inline-1' })),
    editMessageText: vi.fn(async () => true),
  };
  const impl: AdapterSend = {
    async sendProduct(chatId, md, opts) {
      const messageId = nextId++;
      sent.push({ chatId, md, buttons: opts?.buttons, messageId });
      return { messageId };
    },
    async editProduct(chatId, messageId, md, opts) {
      edited.push({ chatId, messageId, md, buttons: opts?.buttons });
    },
    async react() {},
    api: () => api as unknown as BotApi,
    ...(opts.replay ? { replay: opts.replay as never } : {}),
    ...(opts.hasActiveTurn ? { hasActiveTurn: opts.hasActiveTurn } : {}),
    ...(opts.retryPrompt ? { retryPrompt: opts.retryPrompt } : {}),
    ...(opts.buttonValue ? { buttonValue: opts.buttonValue } : {}),
    async clearButtons(chatId, messageId) {
      cleared.push({ chatId, messageId });
    },
  };
  setAdapterSend(impl);
  return { sent, edited, cleared, api };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fakeNanogate(over: Partial<Record<keyof NanogateAdmin, unknown>> = {}): any {
  const base: Record<string, unknown> = {
    healthz: vi.fn(async () => true),
    putTenant: vi.fn(async () => undefined),
    pauseTenant: vi.fn(async () => undefined),
    resumeTenant: vi.fn(async () => undefined),
    revokeTenant: vi.fn(async () => undefined),
    budget: vi.fn(async () => ({
      limitMicros: 10_000_000,
      usedMicros: 1_000_000,
      reservedMicros: 0,
      periodStart: Date.UTC(2026, 9, 1),
      periodEnd: Date.UTC(2026, 10, 1),
      status: 'ok',
    })),
    usage: vi.fn(async () => ({ rows: [] })),
    events: vi.fn(async () => []),
    ackEvents: vi.fn(async () => undefined),
    listSecrets: vi.fn(async () => []),
    putSecret: vi.fn(async () => undefined),
    deleteSecret: vi.fn(async () => undefined),
    putConnector: vi.fn(async () => undefined),
    deleteConnector: vi.fn(async () => undefined),
    probeConnector: vi.fn(async () => true),
    mintHostToken: vi.fn(async () => ({ token: 'ngh_testtoken', hashPrefix: 'abcdef012345' })),
    ...over,
  };
  return base;
}

export function groupUpdate(
  chatId: number,
  text: string,
  messageId = 1,
): import('../channels/telegram/botapi/index.js').Update {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1_800_000_000,
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'Маша' },
      text,
    },
  } as never;
}

import { initTestDb, runMigrations } from '../db/index.js';
import './migrations.js';

/** Fresh in-memory DB with core + nc migrations applied. */
export async function setupDb(): Promise<void> {
  const db = await initTestDb();
  await runMigrations(db);
}

import { createHmac } from 'node:crypto';

export function signInitData(fields: Record<string, string>, token: string): string {
  const check = Object.entries(fields)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

export function initDataFor(userId: number, token: string, authDate = Math.floor(Date.now() / 1000)): string {
  return signInitData(
    { auth_date: String(authDate), user: JSON.stringify({ id: userId, first_name: `U${userId}` }) },
    token,
  );
}
