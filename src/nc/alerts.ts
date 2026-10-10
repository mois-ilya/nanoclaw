/**
 * Owner alerts and the error record behind /health.
 *  - `recordError` keeps metadata-only rows (class, target, short detail; never message content);
 *  - a 60 s watcher reports nanogate / home-connector transitions (with hysteresis) to the owner;
 *  - repeated container start failures are alerted at most once per hour per session.
 * Alerts go to the owner's Telegram chat and, when `NC_ALERT_COMMAND` is set, to that executable
 * (e.g. a pulse-notify wrapper) as its single argument.
 */
import { execFile } from 'node:child_process';

import { emitHostError, onHostError, type HostErrorClass } from '../host-errors.js';
import { nanogateAdmin } from '../gateway-providers/nanogate/index.js';
import { log } from '../log.js';
import { ownerConnectorStatus, syncOwnerConnector } from './connector.js';
import { nc, ownerTgId } from './config.js';
import { tg } from './port.js';
import { audit, kvGet, kvSet } from './store.js';
import { withLock } from './util.js';

export { emitHostError };

export async function recordError(cls: HostErrorClass | string, target: string, detail?: string): Promise<void> {
  await audit('system', 'error', `${cls}:${target}`.slice(0, 120), { cls, detail: detail?.slice(0, 200) });
}

const HOUR = 60 * 60_000;

/** Send `md` to the owner unless the same `key` was sent within `throttleMs`. */
export function alertOwner(
  key: string,
  md: string,
  opts: { throttleMs?: number; silent?: boolean } = {},
): Promise<boolean> {
  // Serialised per key: concurrent callers must not all pass the throttle check before the first one records.
  return withLock(`alert:${key}`, () => sendAlert(key, md, opts));
}

async function sendAlert(key: string, md: string, opts: { throttleMs?: number; silent?: boolean }): Promise<boolean> {
  const throttle = opts.throttleMs ?? HOUR;
  const k = `alert:${key}`;
  const last = Number(await kvGet(k));
  if (throttle > 0 && Number.isFinite(last) && Date.now() - last < throttle) return false;
  await kvSet(k, String(Date.now()));
  const owner = ownerTgId();
  const cmd = process.env.NC_ALERT_COMMAND?.trim();
  if (cmd) {
    execFile(cmd, [md.replace(/\*\*/g, '')], { timeout: 10_000 }, (err) => {
      if (err) log.warn('nc: alert command failed', { err: err.message });
    });
  }
  if (owner !== null) {
    await tg
      .sendProduct(owner, md, { silent: opts.silent ?? false })
      .catch((err) => log.warn('nc: owner alert failed', { err }));
  }
  return true;
}

// ---------- container start failures ----------

const wakeFails = new Map<string, number[]>();
const WAKE_FAIL_WINDOW_MS = 10 * 60_000;
const WAKE_FAIL_LIMIT = 3;

async function onError(e: { cls: HostErrorClass; target: string; detail?: string }): Promise<void> {
  await recordError(e.cls, e.target, e.detail).catch(() => undefined);
  if (e.cls !== 'container') return;
  const now = Date.now();
  const list = (wakeFails.get(e.target) ?? []).filter((t) => now - t < WAKE_FAIL_WINDOW_MS);
  list.push(now);
  wakeFails.set(e.target, list);
  if (list.length >= WAKE_FAIL_LIMIT) {
    await alertOwner(
      `wake:${e.target}`,
      '⚠️ Контейнер ассистента не запускается (3 раза за 10 минут). Подробности: /health.',
    );
  }
}

// ---------- watcher ----------

let timer: NodeJS.Timeout | undefined;
let gatewayDown = false;
let gatewayFails = 0;
let connectorDown = false;

export async function watchOnce(): Promise<void> {
  const ok = await nanogateAdmin.healthz().catch(() => false);
  if (ok) {
    gatewayFails = 0;
    if (gatewayDown) {
      gatewayDown = false;
      await alertOwner('gateway-up', '✅ Шлюз снова работает.', { throttleMs: 0, silent: true });
    }
  } else if (++gatewayFails >= 2 && !gatewayDown) {
    gatewayDown = true;
    await recordError('gateway', 'nanogate', 'healthz failed');
    await alertOwner(
      'gateway-down',
      '⚠️ Шлюз (nanogate) недоступен: сообщения сохраняются, но ассистент не отвечает.',
      { throttleMs: 0 },
    );
  }

  if (nc.ownerConnectorSocks()) {
    const st = await ownerConnectorStatus(true);
    if (st === 'down' && !connectorDown) {
      connectorDown = true;
      await recordError('gateway', 'connector', 'home exit down');
      await alertOwner('connector-down', '⚠️ Домашний выход недоступен: запросы «Через дом» не пройдут.', {
        throttleMs: 0,
      });
    } else if (st === 'ok' && connectorDown) {
      connectorDown = false;
      await alertOwner('connector-up', '✅ Домашний выход снова доступен.', { throttleMs: 0, silent: true });
    }
    if (ok) await syncOwnerConnector().catch(() => false); // keeps nanogate's connector status truthful
  }
}

export function startAlerts(intervalMs = 60_000): void {
  if (timer) return;
  onHostError((e) => void onError(e));
  timer = setInterval(() => void watchOnce().catch((err) => log.warn('nc: watcher failed', { err })), intervalMs);
  timer.unref();
}

export function stopAlerts(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
