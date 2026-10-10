/** Native Telegram channel: registration. Token via TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN_FILE or .env. */
import fs from 'fs';

import { normalizeTokenFile, readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { registerChannelAdapter } from '../channel-registry.js';
import { TELEGRAM_DEFAULTS, createTelegramAdapter } from './adapter/index.js';

function readToken(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN.trim();
  const file = process.env.TELEGRAM_BOT_TOKEN_FILE;
  if (file) {
    try {
      const t = normalizeTokenFile(fs.readFileSync(file, 'utf-8'));
      if (t) return t;
    } catch (err) {
      log.error('Cannot read TELEGRAM_BOT_TOKEN_FILE', { err });
    }
  }
  return readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
}

registerChannelAdapter('telegram', {
  defaults: TELEGRAM_DEFAULTS,
  factory: () => {
    const token = readToken();
    if (!token) {
      log.warn('Telegram: no bot token, skipping');
      return null;
    }
    const owner = Number(process.env.NANOCLAW_OWNER_TELEGRAM_ID);
    return createTelegramAdapter({
      token,
      baseUrl: process.env.TELEGRAM_API_BASE_URL || undefined,
      ownerId: Number.isFinite(owner) && owner > 0 ? owner : undefined,
      miniAppShortName: process.env.NC_MINIAPP_SHORTNAME || undefined,
    });
  },
});
