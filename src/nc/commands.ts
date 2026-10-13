/** Private `/commands` owned by the product module. */
import { log } from '../log.js';
import type { CallbackQuery } from '../channels/telegram/botapi/index.js';
import { budgetFor, isExhausted, periodEndLabel } from './budget.js';
import { copy } from './copy.js';
import { dmSession, injectChat } from './chat.js';
import { ownerTgId } from './config.js';
import { healthReport } from './health.js';
import type { PrivateUpdateCtx, ProductButton } from './port.js';
import { activeTurn, clearButtons, tg } from './port.js';
import { recordError } from './alerts.js';
import { gateIdOf, getTenantByTg, listPendingRequests, listTenants, type Tenant } from './store.js';
import { deleteTask, getTaskDetail, listTasks, pauseTask, resumeTask, runTaskNow } from './tasks.js';
import { resolveGroupTimezone } from '../container-config.js';
import { createScheduledTask, prepareScheduledTask } from '../modules/scheduling/create.js';
import { lookupTaskToken, mintTaskToken } from './tasktokens.js';
import { isContainerRunning } from '../container-runner.js';
import { withExistingMailboxSession } from '../session-manager.js';
import { escapeMd, fmtUsd, topicThreadId } from './util.js';

export async function hasProcessingClaim(s: { id: string; agent_group_id: string }): Promise<boolean> {
  return withExistingMailboxSession(s.agent_group_id, s.id, (m) => m.getProcessingClaims().length > 0)
    .then((r) => r === true)
    .catch(() => false);
}

// ---------- topics ----------

/** Topic of the private chat the command / button came from; null = the general conversation. */
function ctxThread(ctx: PrivateUpdateCtx): string | null {
  return topicThreadId(ctx.message);
}

/** Reply into the conversation the command came from (topic or general). */
function say(ctx: PrivateUpdateCtx, md: string, opts: Parameters<typeof tg.sendProduct>[2] = {}) {
  const th = ctxThread(ctx);
  return tg.sendProduct(ctx.chatId, md, th === null ? opts : { ...opts, threadId: Number(th) });
}

// ---------- task list + buttons ----------

const LIST_MAX = 8;

/** Numbered list; the buttons carry the same numbers so a row maps to its task unambiguously. */
export async function renderTaskList(
  tgId: number,
  agentGroupId: string,
): Promise<{ md: string; buttons: ProductButton[][] }> {
  const tasks = await listTasks(agentGroupId);
  if (tasks.length === 0) {
    return {
      md: 'Напоминаний и задач пока нет. Скажи, например: «напоминай каждый понедельник в 9 проверить почту».',
      buttons: [],
    };
  }
  const shown = tasks.slice(0, LIST_MAX);
  const lines = shown.map(
    (x, i) =>
      `${i + 1}. **${escapeMd(x.name, 60)}** — ${escapeMd(x.scheduleHuman, 80)}${x.status === 'paused' ? ' (на паузе)' : ''}`,
  );
  if (tasks.length > shown.length) lines.push(`…и ещё ${tasks.length - shown.length} — в кабинете.`);
  const buttons: ProductButton[][] = [];
  for (const [i, x] of shown.entries()) {
    const tok = await mintTaskToken(tgId, x.id, true);
    const n = i + 1;
    buttons.push([
      x.status === 'paused' ? { text: `▶️ ${n}`, data: `p:tr:${tok}` } : { text: `⏸ ${n}`, data: `p:tp:${tok}` },
      { text: `✖ ${n}`, data: `p:tc:${tok}` },
    ]);
  }
  buttons.push([{ text: 'Открыть кабинет', webApp: 'tasks' }]);
  return { md: `**Мои задачи**\n${lines.join('\n')}`, buttons };
}

async function rerenderList(q: CallbackQuery, tgId: number, groupId: string): Promise<void> {
  const m = q.message;
  if (!m) return;
  try {
    const v = await renderTaskList(tgId, groupId);
    await tg.editProduct(m.chat.id, m.message_id, v.md, { buttons: v.buttons });
  } catch (err) {
    log.warn('nc: task list refresh failed', { err });
  }
}

/** Task buttons: the token binds (presser, series); the series is then only looked up inside the presser's own group. */
export async function handleTaskCallback(q: CallbackQuery, op: string, token: string): Promise<{ toast?: string }> {
  const entry = await lookupTaskToken(token);
  if (!entry || entry.tgId !== q.from.id) return { toast: 'Кнопка устарела' };
  const t = await getTenantByTg(q.from.id);
  if (!t || t.state !== 'ready' || !t.agent_group_id) return { toast: 'Недоступно' };
  const group = t.agent_group_id;
  try {
    if (op === 'tp') {
      const ok = (await pauseTask(group, entry.seriesId)) > 0;
      if (entry.list) await rerenderList(q, q.from.id, group);
      return { toast: ok ? 'Приостановлено' : 'Не найдено' };
    }
    if (op === 'tr') {
      const blocked = await budgetBlock(t);
      if (blocked) return { toast: blocked };
      const ok = (await resumeTask(group, entry.seriesId)) > 0;
      if (entry.list) await rerenderList(q, q.from.id, group);
      return { toast: ok ? 'Возобновлено' : 'Не найдено' };
    }
    if (op === 'tc') {
      // Two-step: deletion also removes the run history.
      const name = (await listTasks(group)).find((x) => x.id === entry.seriesId)?.name;
      if (!name) return { toast: 'Не найдено' };
      const yes = await mintTaskToken(q.from.id, entry.seriesId, entry.list);
      const no = await mintTaskToken(q.from.id, entry.seriesId, entry.list);
      if (q.message) {
        await tg.editProduct(
          q.message.chat.id,
          q.message.message_id,
          `Удалить «${escapeMd(name, 60)}»? Вместе с историей запусков.`,
          {
            buttons: [
              [
                { text: '🗑 Да, удалить', data: `p:tcc:${yes}` },
                { text: 'Нет', data: `p:tcx:${no}` },
              ],
            ],
          },
        );
      }
      return {};
    }
    if (op === 'tcc') {
      const ok = await deleteTask(group, entry.seriesId);
      if (entry.list) await rerenderList(q, q.from.id, group);
      return { toast: ok ? 'Удалено' : 'Не найдено' };
    }
    if (op === 'tcx') {
      if (entry.list) await rerenderList(q, q.from.id, group);
      return { toast: 'Отменено' };
    }
    if (op === 'rd') {
      // [Сделано] under a fired reminder: the message becomes a checked line, the buttons go.
      if (q.message) {
        const said = ('text' in q.message ? (q.message.text ?? '') : '').replace(/\s+/g, ' ').trim();
        await tg.editProduct(q.message.chat.id, q.message.message_id, said ? `✔ ${escapeMd(said, 300)}` : '✔ Сделано', {
          buttons: [],
        });
      }
      return { toast: 'Отмечено' };
    }
    if (op === 'sz') {
      // [Отложить на час]: the same prompt once more, one hour from now.
      // A one-shot that has just fired is no longer a live task: fall back to the text of the reminder itself.
      const detail = await getTaskDetail(group, entry.seriesId);
      const said =
        q.message && 'text' in q.message ? (q.message.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
      if (!detail && !said) return { toast: 'Не найдено' };
      const blocked = await budgetBlock(t);
      if (blocked) return { toast: blocked };
      const session = await dmSession(t, true, callbackThread(q));
      const prepared = prepareScheduledTask({
        name: (detail?.name ?? said).slice(0, 50),
        prompt: detail?.prompt ?? `Напомни пользователю: ${said}`,
        processAfter: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        timezone: await resolveGroupTimezone(group),
      });
      await createScheduledTask(group, prepared, { originSessionId: session?.id ?? null });
      if (q.message) await clearButtons(q.message.chat.id, q.message.message_id);
      return { toast: 'Напомню через час' };
    }
    if (op === 'tt') {
      // [Изменить время]: the agent asks when and moves it.
      const name = (await listTasks(group)).find((x) => x.id === entry.seriesId)?.name;
      if (!name) return { toast: 'Не найдено' };
      const session = await dmSession(t, true, callbackThread(q));
      if (!session) return { toast: 'Недоступно' };
      await injectChat(
        session,
        q.from.id,
        `Хочу изменить время задачи «${name}» (id: ${entry.seriesId}). Спроси, на когда её перенести, и перенеси.`,
        { sender: t.name },
      );
      return { toast: 'Спрашиваю' };
    }
    if (op === 'trun') {
      const ok = (await runTaskNow(group, entry.seriesId)) > 0;
      return { toast: ok ? 'Запускаю' : 'Не удалось запустить' };
    }
  } catch (err) {
    if (err instanceof Error && err.message === 'task_running') return { toast: 'Задача сейчас выполняется' };
    log.warn('nc: task button failed', { err });
  }
  return { toast: 'Ошибка' };
}

/** Topic of the message a button sits under (null = general conversation). */
export function callbackThread(q: CallbackQuery): string | null {
  return topicThreadId(q.message as { message_thread_id?: number; is_topic_message?: boolean } | undefined);
}

/** Why a task cannot be resumed right now (budget exhausted), or null. */
export async function budgetBlock(t: Tenant): Promise<string | null> {
  const snap = await budgetFor(gateIdOf(t));
  if (isExhausted(snap) && snap) return `Лимит исчерпан — задача включится сама ${periodEndLabel(snap)}`;
  return null;
}

// ---------- commands ----------

async function activeTenant(ctx: PrivateUpdateCtx): Promise<Tenant | undefined> {
  const t = await getTenantByTg(ctx.user.id);
  return t && t.state === 'ready' && t.agent_group_id ? t : undefined;
}

async function cmdTasks(ctx: PrivateUpdateCtx, t: Tenant): Promise<void> {
  const v = await renderTaskList(ctx.user.id, t.agent_group_id!);
  await say(ctx, v.md, v.buttons.length ? { buttons: v.buttons } : undefined);
}

const STATE_LABEL: Record<string, string> = {
  ready: '🟢 активен',
  paused: '⏸ на паузе',
  provisioning: '⏳ создаётся',
  provisioning_failed: '⚠️ не создан',
};

async function cmdFriends(ctx: PrivateUpdateCtx): Promise<void> {
  const owner = ownerTgId();
  const all = (await listTenants()).filter((t) => t.tg_id !== owner);
  const friends = all.filter((t) => STATE_LABEL[t.state]);
  const pending = await listPendingRequests();
  const denied = all.filter((t) => t.state === 'denied' || t.state === 'deleted');
  if (friends.length === 0 && pending.length === 0 && denied.length === 0) {
    await say(ctx, 'Друзей пока нет.', {
      buttons: [[{ text: 'Открыть кабинет', webApp: 'requests' }]],
    });
    return;
  }
  if (pending.length) {
    await say(ctx, '**Запросы**', { silent: true });
    for (const r of pending.slice(0, 10)) {
      const t = await getTenantByTg(r.tg_id);
      await say(ctx, `**${escapeMd(t?.name ?? String(r.tg_id), 80)}** · ⏳ ждёт решения`, {
        silent: true,
        buttons: [
          [
            { text: '✅ Принять', data: `p:ap:${r.id}` },
            { text: '✖ Отклонить', data: `p:dn:${r.id}` },
          ],
        ],
      });
    }
  }
  if (friends.length) await say(ctx, '**Друзья**', { silent: true });
  for (const f of friends.slice(0, 10)) {
    const b = f.state === 'ready' || f.state === 'paused' ? await budgetFor(gateIdOf(f)) : null;
    const spend = b ? `${fmtUsd(b.usedMicros)} из ${b.limitMicros === null ? '∞' : fmtUsd(b.limitMicros)}` : '—';
    const buttons =
      f.state === 'paused'
        ? [
            [
              { text: '▶️ Возобновить', data: `p:fr:${f.tg_id}` },
              { text: '🗑 Удалить', data: `p:fd:${f.tg_id}` },
            ],
          ]
        : f.state === 'ready'
          ? [
              [
                { text: '⏸ Приостановить', data: `p:fp:${f.tg_id}` },
                { text: '🗑 Удалить', data: `p:fd:${f.tg_id}` },
              ],
            ]
          : f.state === 'provisioning_failed'
            ? [[{ text: 'Повторить', data: `p:rt:${f.tg_id}` }]]
            : [];
    await say(ctx, `**${escapeMd(f.name, 80)}** · ${STATE_LABEL[f.state]} · ${spend}`, {
      buttons,
      silent: true,
    });
  }
  if (denied.length) {
    await say(ctx, '**Отклонённые и удалённые** — можно открыть доступ снова:', {
      silent: true,
      buttons: denied
        .slice(0, 8)
        .map((d) => [{ text: `Открыть снова: ${d.name.slice(0, 24)}`, data: `p:ro:${d.tg_id}` }]),
    });
  }
  await say(ctx, 'Подробности и лимиты — в кабинете.', {
    buttons: [[{ text: 'Открыть кабинет', webApp: 'friends' }]],
    silent: true,
  });
}

/** Normalised command name without slash / @bot suffix, lowercase. */
function norm(command: string): string {
  return command.replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
}

export async function commandHandler(ctx: PrivateUpdateCtx, command: string, _args: string): Promise<boolean> {
  const cmd = norm(command);
  const owner = ownerTgId();
  const isOwner = owner !== null && ctx.user.id === owner;
  const OWNER_ONLY = new Set(['friends', 'guest', 'health']);
  const OURS = new Set(['start', 'help', 'menu', 'new', 'stop', 'tasks', ...OWNER_ONLY]);
  if (!OURS.has(cmd)) return false;

  // Owner-only commands never fall through to the agent for anyone else.
  if (OWNER_ONLY.has(cmd) && !isOwner) return true;

  const t = isOwner ? await getTenantByTg(ctx.user.id) : await activeTenant(ctx);
  if (!t || !t.agent_group_id) {
    if (cmd === 'help' || cmd === 'start') await say(ctx, copy.help(isOwner));
    return true;
  }
  try {
    switch (cmd) {
      case 'start':
      case 'help':
        await say(ctx, copy.help(isOwner));
        return true;
      case 'menu':
        await say(ctx, '**Кабинет**: расход, память, задачи и настройки.', {
          buttons: [
            [{ text: 'Открыть кабинет', webApp: '' }],
            [
              { text: 'Мои задачи', webApp: 'tasks' },
              { text: 'Расход', webApp: 'usage' },
              isOwner ? { text: 'Запросы', webApp: 'requests' } : { text: 'Память', webApp: 'memory' },
            ],
          ],
        });
        return true;
      case 'new': {
        const s = await dmSession(t, true, ctxThread(ctx));
        // The Russian line below is the only confirmation; a cold container is not started just to forget.
        if (s) await injectChat(s, ctx.user.id, '/clear', { silent: true, wake: isContainerRunning(s.id) });
        await say(ctx, copy.newConversation(), { silent: true });
        return true;
      }
      case 'stop': {
        const s = await dmSession(t, false, ctxThread(ctx));
        // Nothing can be running without a container or an in-flight turn: answer at once, never cold-start one.
        const th = ctxThread(ctx);
        const turn = activeTurn(ctx.user.id, th === null ? undefined : Number(th));
        // The adapter may have lost the turn (host restart with an adopted container): a claimed inbound row still counts.
        const claimed = !!s && turn === false && isContainerRunning(s.id) && (await hasProcessingClaim(s));
        if (!s || !isContainerRunning(s.id) || (turn === false && !claimed)) {
          await say(ctx, copy.nothingToStop(), { silent: true });
          return true;
        }
        await injectChat(s, ctx.user.id, '/stop');
        return true;
      }
      case 'tasks':
        await cmdTasks(ctx, t);
        return true;
      case 'friends':
        await cmdFriends(ctx);
        return true;
      case 'guest':
        await say(ctx, 'Гостевой контекст — в кабинете.', {
          buttons: [[{ text: 'Открыть «Гость»', webApp: 'guest' }]],
        });
        return true;
      case 'health':
        await say(ctx, await healthReport());
        return true;
    }
  } catch (err) {
    log.error('nc: command failed', { cmd, err });
    await recordError('command', cmd, err instanceof Error ? err.message : String(err)).catch(() => undefined);
    if (cmd === 'health')
      await say(ctx, '⚠️ Не удалось собрать статус сервера. Подробности в журнале.').catch(() => undefined);
  }
  return true;
}
