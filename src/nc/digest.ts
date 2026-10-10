/** Weekly owner digest (ux §7.1): Monday 09:00 in the owner's timezone, one silent message, sent at most once per week. */
import { nanogateAdmin } from '../gateway-providers/nanogate/index.js';
import { log } from '../log.js';
import { errorsByClass } from './health.js';
import { nc, ownerTgId } from './config.js';
import { turnMetrics } from './metrics.js';
import { tg } from './port.js';
import { gateIdOf, getPrefs, kvGet, kvSet, listPendingRequests, listTenants } from './store.js';
import { escapeMd, fmtUsd } from './util.js';

const LAST_KEY = 'digest:last';

function localParts(tz: string, now: Date): { date: string; weekday: string; hour: number } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, hour: Number(p.hour) % 24 };
}

async function weekSpend(userId: string): Promise<number> {
  try {
    const r = (await nanogateAdmin.usage({
      tenantId: userId,
      from: Date.now() - 7 * 86_400_000,
      to: Date.now() + 60_000,
      groupBy: 'day',
    })) as {
      rows?: Array<{ cost_micros?: number | null }>;
    };
    return (r.rows ?? []).reduce((a, x) => a + (x.cost_micros ?? 0), 0);
  } catch {
    return 0;
  }
}

export async function buildDigest(): Promise<string> {
  const lines = ['**Неделя в цифрах**'];
  let total = 0;
  const people: string[] = [];
  for (const t of await listTenants()) {
    if (t.state !== 'ready' && t.state !== 'paused') continue;
    const micros = await weekSpend(gateIdOf(t));
    total += micros;
    people.push(`• ${escapeMd(t.name, 60)} — ${fmtUsd(micros)}`);
  }
  lines.push(`Расход за 7 дней: ${fmtUsd(total)}`, ...people);
  const errs = await errorsByClass(7).catch(() => ({}) as Record<string, number>);
  const nErr = Object.values(errs).reduce((a, b) => a + b, 0);
  lines.push(
    nErr
      ? `Ошибок: ${nErr} (${Object.entries(errs)
          .map(([k, n]) => `${k}: ${n}`)
          .join(', ')})`
      : 'Ошибок не было.',
  );
  const m = await turnMetrics(7).catch(() => null);
  if (m && m.turns > 0) {
    lines.push(
      `Ответов: ${m.turns}, первый ответ p50 ${(m.firstPreviewMs.p50 / 1000).toFixed(1)} с / p95 ${(m.firstPreviewMs.p95 / 1000).toFixed(1)} с, ошибок в ответах ${Math.round(m.failRate * 100)} %, голосовых ${Math.round(m.voiceShare * 100)} %`,
    );
  }
  const pending = (await listPendingRequests()).length;
  if (pending) lines.push(`Ждут решения: ${pending}`);
  return lines.join('\n');
}

/** Sends the digest if it is due. Returns whether one was sent. */
export async function maybeSendDigest(now = new Date()): Promise<boolean> {
  const owner = ownerTgId();
  if (owner === null) return false;
  const prefs = await getPrefs(`telegram:${owner}`, { tz: nc.defaultTz() });
  let local;
  try {
    local = localParts(prefs.tz, now);
  } catch {
    local = localParts(nc.defaultTz(), now);
  }
  if (local.weekday !== 'Mon' || local.hour < 9) return false;
  if ((await kvGet(LAST_KEY)) === local.date) return false;
  await kvSet(LAST_KEY, local.date); // claim first: a failed send is not retried every hour
  try {
    await tg.sendProduct(owner, await buildDigest(), {
      silent: true,
      buttons: [[{ text: 'Открыть «Система»', webApp: 'system' }]],
    });
    return true;
  } catch (err) {
    log.warn('nc: weekly digest failed', { err });
    return false;
  }
}
