/** Under Nix the bot token only exists as TELEGRAM_BOT_TOKEN_FILE (LoadCredential). */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../container-runner.js', () => ({
  isContainerRunning: vi.fn(() => false),
  getActiveContainerCount: vi.fn(() => 0),
  killContainer: vi.fn(),
}));

import { closeDb } from '../db/index.js';
import { setNanogateAdminForTests } from '../gateway-providers/nanogate/index.js';
import { nc, readBotToken } from './config.js';
import { startMiniAppServer, type RunningMiniApp } from './miniapp/server.js';
import { sessions } from './miniapp/sessions.js';
import { insertTenantIfAbsent, updateTenant } from './store.js';
import { FRIEND_A, OWNER, fakeNanogate, initDataFor, installFakeAdapter, setupDb } from './test-helpers.js';

const TOKEN = '123456:FILE-TOKEN-ABCDEF';
let dir: string;
let app: RunningMiniApp | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-token-'));
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.NC_TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN_FILE = path.join(dir, 'telegram-token');
  fs.writeFileSync(process.env.TELEGRAM_BOT_TOKEN_FILE, `${TOKEN}\n`);
});
afterEach(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN_FILE;
  await app?.close();
  app = undefined;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('bot token resolution', () => {
  it('reads TELEGRAM_BOT_TOKEN_FILE (trimmed) when no env token is set', () => {
    expect(readBotToken()).toBe(TOKEN);
    expect(nc.botToken()).toBe(TOKEN);
  });
  it('an explicit env token wins over the file', () => {
    process.env.TELEGRAM_BOT_TOKEN = '999:DIRECT';
    expect(readBotToken()).toBe('999:DIRECT');
    delete process.env.TELEGRAM_BOT_TOKEN;
  });
  it('a missing file yields an empty token instead of throwing', () => {
    process.env.TELEGRAM_BOT_TOKEN_FILE = path.join(dir, 'nope');
    expect(readBotToken()).toBe('');
  });

  it('the Mini App backend starts with only the _FILE token and validates initData signed with it', async () => {
    process.env.NANOCLAW_OWNER_TELEGRAM_ID = String(OWNER);
    await setupDb();
    installFakeAdapter();
    setNanogateAdminForTests(fakeNanogate());
    await insertTenantIfAbsent({ tgId: FRIEND_A, name: 'Маша', state: 'ready' });
    await updateTenant(FRIEND_A, { agent_group_id: 'ag-1' });
    app = await startMiniAppServer({ port: 0 }); // no botToken override: nc.botToken() is what runs under Nix
    const res = await fetch(`http://127.0.0.1:${app.port}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ initData: initDataFor(FRIEND_A, TOKEN) }),
    });
    expect(res.status).toBe(200);
    sessions.revokeUser(FRIEND_A);
    setNanogateAdminForTests(null);
    await closeDb();
  });
});
