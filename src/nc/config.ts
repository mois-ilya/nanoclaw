/**
 * Product-module settings. Everything is read lazily (process.env, then `.env`)
 * so tests can set env per case and the Nix unit can inject values.
 */
import fs from 'node:fs';

import { normalizeTokenFile, readEnvFile } from '../env.js';
import { log } from '../log.js';

function setting(key: string): string {
  return process.env[key]?.trim() || readEnvFile([key])[key]?.trim() || '';
}

const fileCache = new Map<string, string>();

/**
 * Bot token, same resolution order as the Telegram channel (src/channels/telegram/index.ts):
 * env, then `TELEGRAM_BOT_TOKEN_FILE` (systemd LoadCredential under Nix), then `.env`.
 * `NC_TELEGRAM_BOT_TOKEN` stays an explicit override.
 */
export function readBotToken(): string {
  const direct = setting('NC_TELEGRAM_BOT_TOKEN') || process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (direct) return direct;
  const file = process.env.TELEGRAM_BOT_TOKEN_FILE?.trim();
  if (file) {
    const hit = fileCache.get(file);
    if (hit) return hit;
    try {
      const t = normalizeTokenFile(fs.readFileSync(file, 'utf8'));
      if (t) {
        fileCache.set(file, t);
        return t;
      }
    } catch (err) {
      log.error('nc: cannot read TELEGRAM_BOT_TOKEN_FILE', { err });
    }
  }
  return readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN?.trim() || '';
}

function intSetting(key: string, fallback: number): number {
  const n = Number.parseInt(setting(key), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Owner's numeric Telegram id (`NANOCLAW_OWNER_TELEGRAM_ID`); null if unset (module stays inert for owner paths). */
export function ownerTgId(): number | null {
  const n = Number.parseInt(setting('NANOCLAW_OWNER_TELEGRAM_ID'), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const userIdOf = (tgId: number): string => `telegram:${tgId}`;
export const platformIdOf = (tgId: number): string => `telegram:${tgId}`;

export function tgIdOfUserId(userId: string): number | null {
  const m = /^telegram:(\d{1,15})(?:\.e\d{1,4})?$/.exec(userId);
  return m ? Number(m[1]) : null;
}

export const USD = 1_000_000;

export const nc = {
  miniappPort: () => intSetting('NC_MINIAPP_PORT', 8095),
  /** Public Mini App origin (https), used for the chat menu button. */
  miniappUrl: () => setting('NC_MINIAPP_URL'),
  /** Directory with the built SPA (`miniapp/dist`). */
  miniappStaticDir: () => setting('NC_MINIAPP_STATIC_DIR'),
  botToken: readBotToken,
  sttUrl: () => setting('NC_STT_URL'),
  guestPlaceholder: () => setting('NC_GUEST_PLACEHOLDER') === '1',
  nanogateHostUrl: () => setting('NC_NANOGATE_HOST_URL') || 'http://127.0.0.1:8090',
  ownerName: () => setting('NC_OWNER_NAME') || 'Илья',
  ownerNameGen: () => setting('NC_OWNER_NAME_GEN') || (nc.ownerName() === 'Илья' ? 'Ильи' : nc.ownerName()),
  botName: () => setting('NC_BOT_NAME') || 'ассистент',
  defaultTz: () => setting('NC_DEFAULT_TZ') || 'Europe/Moscow',
  /** Per-turn wall-clock limit passed to the runner (NC_TURN_TIMEOUT_MS): friend 10 min, owner 30 min. */
  turnTimeoutMs: (owner: boolean) =>
    owner ? intSetting('NC_TURN_TIMEOUT_OWNER_MS', 30 * 60_000) : intSetting('NC_TURN_TIMEOUT_FRIEND_MS', 10 * 60_000),
  defaultLimitMicros: () => intSetting('NC_FRIEND_LIMIT_USD', 10) * USD,
  globalCapMicros: () => intSetting('NC_GLOBAL_CAP_USD', 100) * USD,
  ownerConnectorSocks: () => setting('NC_OWNER_CONNECTOR_SOCKS'),
  ownerTailnetCidrs: () =>
    setting('NC_OWNER_TAILNET_CIDRS')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  /** Allowlist for tailnet / home-LAN destinations the owner's agent may reach (`host:port`, `cidr:port`, `*.ts.net:port`). */
  ownerTailnetAllow: () =>
    setting('NC_OWNER_TAILNET_ALLOW')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  /** Exit node the home connector uses (empty when none is configured). */
  ownerExitNode: () => setting('NC_OWNER_EXIT_NODE'),
  templatesDir: () => setting('NC_TEMPLATES_DIR'),
  models: () => ({
    fast: setting('NC_MODEL_FAST') || 'claude-sonnet-5-5',
    normal: setting('NC_MODEL_NORMAL') || 'claude-sonnet-5-5',
    deep: setting('NC_MODEL_DEEP') || 'claude-opus-5-5',
    guest: setting('NC_MODEL_GUEST') || 'claude-sonnet-5-5',
    /** Claude Code's small/fast model: WebFetch post-processing and Explore subagents. Must be allowed + priced in nanogate. */
    small: setting('NC_MODEL_SMALL') || 'claude-haiku-5-5',
  }),
};

export type Preset = 'fast' | 'normal' | 'deep';

/** Model + effort for a settings preset (UX §6). */
export function presetConfig(preset: Preset): { model: string; effort: string } {
  const m = nc.models();
  if (preset === 'fast') return { model: m.fast, effort: 'low' };
  if (preset === 'deep') return { model: m.deep, effort: 'high' };
  return { model: m.normal, effort: 'medium' };
}
