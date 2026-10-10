/** Health/system data shared by `/health` (owner) and the Mini App «Система». */
import fs from 'node:fs';
import path from 'node:path';

import { getDb } from '../db/connection.js';
import { getActiveContainerCount } from '../container-runner.js';
import { readUpgradeState } from '../upgrade-state.js';
import { nanogateAdmin } from '../gateway-providers/nanogate/index.js';
import { nc, ownerTgId } from './config.js';
import { ownerConnectorStatus } from './connector.js';
import { turnMetrics } from './metrics.js';
import { gateIdOf, listTenants } from './store.js';
import type { SystemView } from './miniapp/types.js';

const SLICE = process.env.NC_SLICE_PATH || '/sys/fs/cgroup/nanoclaw.slice';

function readNumber(file: string): number {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0; // "max" -> 0 (unlimited)
  } catch {
    return 0;
  }
}

function version(): string {
  try {
    return String(
      (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as { version?: string }).version ??
        'unknown',
    );
  } catch {
    return 'unknown';
  }
}

export async function recentErrors(days = 7): Promise<number> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const r = await getDb().get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM nc_audit WHERE action = 'error' AND at >= ?",
    since,
  );
  return r?.n ?? 0;
}

/** Error counts by class (container, gateway, turn, render, update, command...) for the last `days`. */
export async function errorsByClass(days = 7): Promise<Record<string, number>> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await getDb().all<{ cls: string | null; n: number }>(
    "SELECT COALESCE(json_extract(detail, '$.cls'), 'command') AS cls, COUNT(*) AS n FROM nc_audit WHERE action = 'error' AND at >= ? GROUP BY cls",
    since,
  );
  return Object.fromEntries(rows.map((r) => [r.cls ?? 'other', r.n]));
}

export async function lastErrors(
  limit = 5,
): Promise<Array<{ at: string; target: string | null; detail: string | null }>> {
  return getDb().all("SELECT at, target, detail FROM nc_audit WHERE action = 'error' ORDER BY at DESC LIMIT ?", limit);
}

/** Resolve within `ms` or give up with `fallback` (a hung nanogate must not stall /health). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** SystemView plus fields the SPA does not render yet (additive, see integration notes). */
export type SystemViewX = SystemView & {
  buildId?: string;
  deployedAt?: string;
  grafanaUrl?: string;
  /** Last audit rows (no `detail`: it can carry payloads). */
  recentAudit?: Array<{ at: string; actor: string; action: string; target?: string }>;
  errorsByClass: Record<string, number>;
  /** Installation-wide spend this UTC month, as nanogate enforces the global cap. */
  globalUsed?: { micros: number };
  metrics?: import('./metrics.js').TurnMetrics;
};

const SPEND_TIMEOUT_MS = 1500;

export async function recentAudit(limit = 20): Promise<NonNullable<SystemViewX['recentAudit']>> {
  const rows = await getDb()
    .all<{ at: string; actor: string; action: string; target: string | null }>(
      'SELECT at, actor, action, target FROM nc_audit ORDER BY at DESC LIMIT ?',
      limit,
    )
    .catch(() => []);
  return rows.map((r) => ({ at: r.at, actor: r.actor, action: r.action, ...(r.target ? { target: r.target } : {}) }));
}

export async function collectSystem(): Promise<SystemViewX> {
  const gatewayOk = await within(nanogateAdmin.healthz(), SPEND_TIMEOUT_MS, false);
  const spend: SystemView['spendByUser'] = [];
  let globalUsed: { micros: number } | undefined;
  if (gatewayOk) {
    const tenants = (await listTenants()).filter((t) => t.state === 'ready' || t.state === 'paused');
    const rows = await Promise.all(
      tenants.map(async (t) => ({
        t,
        b: await within(
          nanogateAdmin.budget(gateIdOf(t)).catch(() => null),
          SPEND_TIMEOUT_MS,
          null,
        ),
      })),
    );
    for (const { t, b } of rows) if (b) spend.push({ name: t.name, cost: { micros: b.usedMicros } });
    const now = new Date();
    const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const u = await within(
      nanogateAdmin
        .usage({ from, to, groupBy: 'day' })
        .then((r) => r as { rows?: Array<{ cost_micros?: number | null }> })
        .catch(() => null),
      SPEND_TIMEOUT_MS,
      null,
    );
    if (u?.rows) globalUsed = { micros: u.rows.reduce((a, r) => a + (r.cost_micros ?? 0), 0) };
    const listed = spend.reduce((a, r) => a + r.cost.micros, 0);
    if (globalUsed && globalUsed.micros > listed)
      spend.push({ name: 'Прочие (удалённые)', cost: { micros: globalUsed.micros - listed } });
  }
  const owner = ownerTgId();
  const connectors: SystemView['connectors'] = [];
  if (owner && nc.ownerConnectorSocks()) {
    const st = await ownerConnectorStatus();
    connectors.push({
      tenant: `Домашняя сеть · ${nc.ownerName()}`,
      status: st === 'ok' ? 'ok' : st === 'down' ? 'down' : 'not_configured',
    });
  }
  const max = Number.parseInt(process.env.NC_MAX_CONTAINERS ?? '', 10);
  const marker = readUpgradeState();
  const buildId = process.env.NANOCLAW_BUILD_ID?.trim() || marker?.buildId;
  const grafanaUrl = process.env.NC_GRAFANA_URL?.trim();
  return {
    ...(buildId ? { buildId } : {}),
    ...(marker?.updatedAt ? { deployedAt: marker.updatedAt } : {}),
    ...(grafanaUrl && /^https:\/\//.test(grafanaUrl) ? { grafanaUrl } : {}),
    recentAudit: await recentAudit(),
    version: version(),
    uptimeS: Math.round(process.uptime()),
    slice: {
      memUsed: readNumber(path.join(SLICE, 'memory.current')),
      memMax: readNumber(path.join(SLICE, 'memory.max')),
    },
    containers: { running: getActiveContainerCount(), max: Number.isFinite(max) && max > 0 ? max : 0 },
    gateway: gatewayOk ? 'ok' : 'down',
    connectors,
    spendByUser: spend,
    globalCap: { micros: nc.globalCapMicros() },
    errors7d: await recentErrors(),
    errorsByClass: await errorsByClass(),
    ...(globalUsed ? { globalUsed } : {}),
    metrics: await turnMetrics(7).catch(() => undefined),
  };
}

const mb = (n: number): string => `${Math.round(n / 1048576)} МБ`;

export async function healthReport(): Promise<string> {
  const s = await collectSystem();
  const errs = await lastErrors();
  const lines = [
    `**Состояние сервера**`,
    `• Шлюз: ${s.gateway === 'ok' ? '✅ работает' : '⚠️ недоступен'}`,
    `• Контейнеры: ${s.containers.running}${s.containers.max ? ` из ${s.containers.max}` : ''}`,
    `• Память slice: ${s.slice.memUsed ? mb(s.slice.memUsed) : 'нет данных'}${s.slice.memMax ? ` из ${mb(s.slice.memMax)}` : ''}`,
    `• Версия: ${s.version}, работает ${Math.floor(s.uptimeS / 3600)} ч`,
    `• Ошибок за 7 дней: ${s.errors7d}${
      Object.keys(s.errorsByClass).length
        ? ` (${Object.entries(s.errorsByClass)
            .map(([k, n]) => `${k}: ${n}`)
            .join(', ')})`
        : ''
    }`,
  ];
  if (s.connectors.length)
    for (const c of s.connectors)
      lines.push(
        `• ${c.tenant}: ${c.status === 'ok' ? '✅ на связи' : c.status === 'down' ? '⚠️ недоступен' : c.status}`,
      );
  if (s.metrics && s.metrics.turns > 0)
    lines.push(
      `• Ответы за 7 дней: ${s.metrics.turns}, первый ответ p50 ${Math.round(s.metrics.firstPreviewMs.p50 / 100) / 10} с, p95 ${Math.round(s.metrics.firstPreviewMs.p95 / 100) / 10} с`,
    );
  if (errs.length) {
    lines.push('', '**Последние ошибки**');
    for (const e of errs)
      lines.push(
        `• ${e.at.slice(0, 16).replace('T', ' ')} ${(e.target ?? '').replace(/[\\`*_[\]]/g, '')} ${(e.detail ?? '').replace(/[\\`*_[\]<>]/g, '').slice(0, 120)}`,
      );
  }
  return lines.join('\n');
}
