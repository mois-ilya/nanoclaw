import { describe, expect, test } from 'vitest';

import { ADMIN_COMMANDS } from '../command-gate.js';
import { TELEGRAM_BOT_COMMANDS } from './telegram-bot-commands.js';

describe('Telegram bot menu manifest', () => {
  test('every menu entry exists in command-gate ADMIN_COMMANDS', () => {
    for (const entry of TELEGRAM_BOT_COMMANDS) {
      expect(ADMIN_COMMANDS.has(`/${entry.command}`)).toBe(true);
    }
  });

  test('command names obey Telegram constraints (1-32 chars, [a-z0-9_])', () => {
    const re = /^[a-z0-9_]{1,32}$/;
    for (const entry of TELEGRAM_BOT_COMMANDS) {
      expect(entry.command).toMatch(re);
    }
  });

  test('descriptions are within Telegram length limits (1-256 chars)', () => {
    for (const entry of TELEGRAM_BOT_COMMANDS) {
      expect(entry.description.length).toBeGreaterThanOrEqual(1);
      expect(entry.description.length).toBeLessThanOrEqual(256);
    }
  });

  test('manifest size is within Telegram limit of 100 entries', () => {
    expect(TELEGRAM_BOT_COMMANDS.length).toBeLessThanOrEqual(100);
  });
});
