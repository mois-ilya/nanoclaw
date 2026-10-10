/**
 * Product module (W2): tenants, onboarding gate, provisioning, lifecycle,
 * budget events, voice, guest mode and the Mini App backend.
 *
 * Self-registers at import (appended to `src/modules/index.ts`): the migration,
 * the nanogate tenant resolver, the Telegram adapter hooks, and the host
 * start/shutdown callbacks.
 */
import { onHostPrepare, onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { log } from '../log.js';
import { bindAdapter } from './bind.js';
import { alertOwner, recordError, startAlerts, stopAlerts } from './alerts.js';
import { maybeSendDigest } from './digest.js';
import { startBudgetPolling, stopBudgetPolling } from './budget.js';
import { syncOwnerConnector } from './connector.js';
import { ownerTgId, nc } from './config.js';
import { prewarmGuestToken, recoverGuestPlaceholders } from './guest.js';
import { purgeDueTrash } from './lifecycle.js';
import { startMiniAppServer, type RunningMiniApp } from './miniapp/server.js';
import './migrations.js';
import { startTurnMetrics } from './metrics.js';
import { installPlatformLayer } from './platform.js';
import { startTaskFailureSweep, stopTaskFailureSweep } from './taskfail.js';
import { resumeProvisioning } from './provision.js';
import { setChatSurface, syncBotProfile } from './surface.js';
import { bootstrapOwner, closeOrphanSessions, installResolver, loadTenantMap } from './tenants.js';

export { consumeBudgetNote } from './budget.js';

export { getUserPrefs } from './prefs.js';

installResolver();
installPlatformLayer();
startTurnMetrics();
bindAdapter();

let miniapp: RunningMiniApp | undefined;
let purgeTimer: NodeJS.Timeout | undefined;
let retryTimer: NodeJS.Timeout | undefined;

let prepared: { nanogateOk: boolean } | undefined;

// Running sessions are adopted right after this: nanogate must already know which tenant each agent group is.
// The owner bootstrap (agent group + DM wiring) also runs here: inbound routing is released right after prepare, and the
// owner's earliest messages (replayed from the update journal) must find their wiring instead of the channel-approval flow.
onHostPrepare(async () => {
  await loadTenantMap();
  try {
    prepared = await bootstrapOwner();
    await closeOrphanSessions();
  } catch (err) {
    log.error('nc: owner bootstrap failed before inbound release; retrying at host start', { err });
  }
});

onHostStart(async () => {
  await loadTenantMap();
  const { nanogateOk } = prepared ?? (await bootstrapOwner());
  prepared = undefined;
  const bootNanogate = async (): Promise<boolean> => {
    const r = await bootstrapOwner();
    if (r.nanogateOk) await syncOwnerConnector();
    return r.nanogateOk;
  };
  if (!nanogateOk) {
    // nanogate may still be starting: keep trying without blocking host startup.
    retryTimer = setInterval(() => {
      void bootNanogate()
        .then((done) => {
          if (done && retryTimer) clearInterval(retryTimer);
        })
        .catch(() => undefined);
    }, 30_000);
    retryTimer.unref();
  } else {
    await syncOwnerConnector();
  }

  const owner = ownerTgId();
  if (owner) await setChatSurface(owner, true).catch((err) => log.warn('nc: owner chat surface failed', { err }));
  void syncBotProfile().catch((err) => log.warn('nc: bot profile sync failed', { err }));
  // Friends' menu button / command list are re-synced on every start (a hiccup at provisioning, or a new release's commands).
  void (async () => {
    const { listTenants } = await import('./store.js');
    for (const t of await listTenants()) {
      if (t.state !== 'ready' || t.tg_id === owner) continue;
      await setChatSurface(t.tg_id, false).catch((err) =>
        log.warn('nc: friend chat surface failed', { tgId: t.tg_id, err }),
      );
      await new Promise((r) => setTimeout(r, 300));
    }
  })().catch(() => undefined);
  void prewarmGuestToken();
  await recoverGuestPlaceholders().catch((err) => log.warn('nc: guest recovery failed', { err }));
  startBudgetPolling();
  startAlerts();
  startTaskFailureSweep();
  // Non-critical steps never take the whole host down (a bound port is not a reason to stop answering chats).
  await resumeProvisioning().catch((err) => log.error('nc: resuming provisioning failed', { err }));

  if (nc.botToken()) {
    try {
      miniapp = await startMiniAppServer();
    } catch (err) {
      log.error('nc: Mini App backend failed to start; Кабинет is unavailable', { err });
      void recordError('other', 'miniapp', err instanceof Error ? err.message : String(err)).catch(() => undefined);
      void alertOwner(
        'miniapp-start',
        '⚠️ Не запустился бэкенд «Кабинета»; чат работает. Подробности в журнале.',
      ).catch(() => undefined);
    }
  } else {
    // Enabled (a URL is configured) but no token: every Mini App button would be dead.
    const msg = 'nc: no bot token (TELEGRAM_BOT_TOKEN / TELEGRAM_BOT_TOKEN_FILE); Mini App backend not started';
    if (nc.miniappUrl()) log.error(msg);
    else log.warn(msg);
  }
  const hourly = (): void => {
    void purgeDueTrash().catch((err) => log.warn('nc: trash purge failed', { err }));
    void maybeSendDigest().catch((err) => log.warn('nc: digest failed', { err }));
  };
  purgeTimer = setInterval(hourly, 60 * 60 * 1000);
  purgeTimer.unref();
});

onHostShutdown(async () => {
  stopBudgetPolling();
  stopAlerts();
  stopTaskFailureSweep();
  if (purgeTimer) clearInterval(purgeTimer);
  if (retryTimer) clearInterval(retryTimer);
  await miniapp?.close();
});
