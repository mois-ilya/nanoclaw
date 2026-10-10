/** Metadata-only turn metrics (ux §7.1 / R18): latency percentiles, cold-start, stop and failure rates, voice share. */
import { randomUUID } from 'node:crypto';

import { getDb } from '../db/connection.js';
import { onHostTurn, type HostTurn } from '../host-errors.js';
import { log } from '../log.js';

const rel = (t: number | undefined, base: number): number | null => (t === undefined ? null : Math.max(0, t - base));

export async function recordTurn(t: HostTurn): Promise<void> {
  await getDb().run(
    'INSERT INTO nc_turn_metrics (id, at, chat_id, outcome, react_ms, first_ms, final_ms, voice, cold_start, stopped) VALUES (?,?,?,?,?,?,?,?,?,?)',
    randomUUID(),
    new Date().toISOString(),
    t.chatId,
    t.outcome,
    rel(t.tReact, t.tInbound),
    rel(t.tFirstPreview, t.tInbound),
    rel(t.tFinal, t.tInbound),
    t.voice ? 1 : 0,
    t.coldStart ? 1 : 0,
    t.stopped || t.outcome === 'cancelled' ? 1 : 0,
  );
  // Keep the table small: 90 days.
  await getDb().run('DELETE FROM nc_turn_metrics WHERE at < ?', new Date(Date.now() - 90 * 86_400_000).toISOString());
}

export interface Pct {
  p50: number;
  p95: number;
}
export interface TurnMetrics {
  turns: number;
  reactMs: Pct;
  firstPreviewMs: Pct;
  finalMs: Pct;
  coldStartRate: number;
  stopRate: number;
  failRate: number;
  voiceShare: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function pct(values: Array<number | null>): Pct {
  const v = values.filter((x): x is number => x !== null).sort((a, b) => a - b);
  return { p50: percentile(v, 50), p95: percentile(v, 95) };
}

export async function turnMetrics(days = 7): Promise<TurnMetrics> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await getDb().all<{
    outcome: string;
    react_ms: number | null;
    first_ms: number | null;
    final_ms: number | null;
    voice: number;
    cold_start: number;
    stopped: number;
  }>(
    'SELECT outcome, react_ms, first_ms, final_ms, voice, cold_start, stopped FROM nc_turn_metrics WHERE at >= ?',
    since,
  );
  const n = rows.length;
  const rate = (f: (r: (typeof rows)[number]) => boolean): number => (n === 0 ? 0 : rows.filter(f).length / n);
  return {
    turns: n,
    reactMs: pct(rows.map((r) => r.react_ms)),
    firstPreviewMs: pct(rows.map((r) => r.first_ms)),
    finalMs: pct(rows.map((r) => r.final_ms)),
    coldStartRate: rate((r) => r.cold_start === 1),
    stopRate: rate((r) => r.stopped === 1),
    failRate: rate((r) => r.outcome === 'failed'),
    voiceShare: rate((r) => r.voice === 1),
  };
}

export function startTurnMetrics(): void {
  onHostTurn((t) => void recordTurn(t).catch((err) => log.debug('nc: turn metric failed', { err })));
}
