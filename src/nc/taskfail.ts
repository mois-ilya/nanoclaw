/**
 * Failed scheduled runs are never silent (ux §2.6): one «не отработал» message per task per day with
 * [Повторить] [Выключить], and an automatic pause after 5 failures in a row. The runner reports nothing for
 * task runs, so the host sweeps each tenant's live series for a growing trailing-failure streak.
 */
import { log } from '../log.js';
import { readRunLogTail } from '../modules/scheduling/run-log.js';
import { tg } from './port.js';
import { kvDelete, kvGet, kvSet, listTenants } from './store.js';
import { failureStreaks, pauseTask } from './tasks.js';
import { mintTaskToken } from './tasktokens.js';
import { escapeMd } from './util.js';

export const AUTO_PAUSE_AFTER = 5;

async function shortReason(group: string, id: string): Promise<string> {
  try {
    const last = (await readRunLogTail(group, id, 1))[0];
    const note = last
      ?.split(' — ')
      .slice(1)
      .join(' — ')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (note) return note.slice(0, 100);
  } catch {
    /* no log yet */
  }
  return 'ошибка при выполнении';
}

/** One pass over every ready tenant. Returns how many messages were sent. */
export async function sweepTaskFailures(now = new Date()): Promise<number> {
  let sent = 0;
  const day = now.toISOString().slice(0, 10);
  for (const t of await listTenants()) {
    if (t.state !== 'ready' || !t.agent_group_id) continue;
    let streaks;
    try {
      streaks = await failureStreaks(t.agent_group_id);
    } catch (err) {
      log.debug('nc: failure sweep skipped a tenant', { tg: t.tg_id, err });
      continue;
    }
    for (const s of streaks) {
      const seenKey = `taskfail-seen:${s.id}`;
      const seen = Number(await kvGet(seenKey)) || 0;
      if (s.failed === 0) {
        if (seen) await kvDelete(seenKey);
        continue;
      }
      if (s.failed <= seen) continue; // this failure was already handled
      await kvSet(seenKey, String(s.failed));
      const autoPause = s.failed >= AUTO_PAUSE_AFTER && s.status === 'active';
      const dayKey = `taskfail:${s.id}:${day}`;
      if (!autoPause && (await kvGet(dayKey))) continue; // one message per task per day
      await kvSet(dayKey, '1');
      const reason = await shortReason(t.agent_group_id, s.id);
      const name = escapeMd(s.name, 60);
      try {
        if (autoPause) {
          await pauseTask(t.agent_group_id, s.id);
          const tok = await mintTaskToken(t.tg_id, s.id, false);
          await tg.sendProduct(
            t.tg_id,
            `⚠️ «${name}» не отработал ${s.failed} раз подряд (${escapeMd(reason, 100)}). Я его выключил.`,
            {
              buttons: [
                [
                  { text: 'Включить', data: `p:tr:${tok}` },
                  { text: 'Открыть задачи', webApp: 'tasks' },
                ],
              ],
            },
          );
        } else {
          const tok = await mintTaskToken(t.tg_id, s.id, false);
          await tg.sendProduct(t.tg_id, `⚠️ «${name}» не отработал: ${escapeMd(reason, 100)}`, {
            buttons: [
              [
                { text: 'Повторить', data: `p:trun:${tok}` },
                { text: 'Выключить', data: `p:tp:${tok}` },
              ],
            ],
          });
        }
        sent++;
      } catch (err) {
        log.warn('nc: task failure notice failed', { id: s.id, err });
        await kvDelete(seenKey); // try again on the next pass
        await kvDelete(dayKey);
      }
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | undefined;

export function startTaskFailureSweep(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(
    () => void sweepTaskFailures().catch((err) => log.warn('nc: task failure sweep failed', { err })),
    intervalMs,
  );
  timer.unref();
}

export function stopTaskFailureSweep(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
