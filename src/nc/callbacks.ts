/**
 * Product callbacks (`p:*` callback_data). SECURITY: every owner action is
 * re-checked here against the configured owner id AND the chat the button was
 * pressed in; the friend-side actions (`rl`, `cap`, task buttons) check that
 * the presser is the tenant the button belongs to. callback_data is
 * attacker-controllable (anyone can replay a button they can see).
 */
import { log } from '../log.js';
import type { CallbackQuery } from '../channels/telegram/botapi/index.js';
import { invalidateBudget } from './budget.js';
import { copy } from './copy.js';
import { nc, ownerTgId, USD } from './config.js';
import { deleteFriend, LifecycleError, pauseFriend, resumeFriend } from './lifecycle.js';
import { activeTurn, buttonValue, clearButtons, retryPrompt, tg } from './port.js';
import { dmSession, injectChat } from './chat.js';
import { isContainerRunning } from '../container-runner.js';
import { approveRequest, denyRequest, reopenDenied } from './decisions.js';
import { retryProvisioning } from './provision.js';
import { audit, gateIdOf, getTenantByTg, noticeDue, updateTenant, type Tenant } from './store.js';
import type { Session } from '../types.js';
import { pushTenant } from './tenants.js';
import { budgetBlock, callbackThread, handleTaskCallback } from './commands.js';
import { escapeMd, fmtUsd } from './util.js';

type Result = { toast?: string } | void;

/** True only for the owner pressing a button in the owner's own private chat. */
export function isOwnerPress(q: CallbackQuery): boolean {
  const owner = ownerTgId();
  if (owner === null || q.from.id !== owner) return false;
  const chat = q.message?.chat.id;
  return chat === owner;
}

function parse(data: string): string[] {
  return data.split(':'); // ['p', op, ...args]
}

function int(s: string | undefined): number | null {
  return s !== undefined && /^\d{1,15}$/.test(s) ? Number(s) : null;
}

async function editCard(
  q: CallbackQuery,
  md: string,
  buttons: Parameters<typeof tg.editProduct>[3] = { buttons: [] },
): Promise<void> {
  const m = q.message;
  if (!m) return;
  try {
    await tg.editProduct(m.chat.id, m.message_id, md, buttons);
  } catch (err) {
    log.warn('nc: card edit failed', { err });
  }
}

async function onApprove(q: CallbackQuery, reqId: string, limit: number): Promise<Result> {
  const r = await approveRequest(reqId, limit, `telegram:${q.from.id}`);
  if (r === 'ok') return { toast: 'Принято' };
  if (r === 'failed') return { toast: 'Не удалось начать: статус изменился' };
  return { toast: 'Уже обработано' };
}

async function onDeny(q: CallbackQuery, reqId: string): Promise<Result> {
  const r = await denyRequest(reqId, `telegram:${q.from.id}`);
  return { toast: r === 'ok' ? 'Отклонено' : 'Уже обработано' };
}

async function onLimitMenu(q: CallbackQuery, tgId: number): Promise<Result> {
  const t = await getTenantByTg(tgId);
  if (!t || t.state === 'deleted') return { toast: 'Не найдено' };
  await tg.sendProduct(
    q.from.id,
    `Лимит для **${escapeMd(t.name, 80)}** (сейчас ${t.limit_usd_micros === null ? 'без лимита' : fmtUsd(t.limit_usd_micros)}/мес):`,
    {
      buttons: [
        [
          { text: '$5', data: `p:ls:${tgId}:5` },
          { text: '$10', data: `p:ls:${tgId}:10` },
          { text: '$25', data: `p:ls:${tgId}:25` },
        ],
      ],
    },
  );
}

export async function setFriendLimit(tgId: number, limitMicros: number | null, actor: string): Promise<boolean> {
  const t = await getTenantByTg(tgId);
  if (!t || tgId === ownerTgId() || (t.state !== 'ready' && t.state !== 'paused')) return false;
  await updateTenant(tgId, { limit_usd_micros: limitMicros });
  await pushTenant((await getTenantByTg(tgId))!, t.state === 'paused' ? 'paused' : 'active');
  invalidateBudget(gateIdOf(t));
  await audit(actor, 'set_limit', t.user_id, { limitMicros });
  return true;
}

async function onSetLimit(q: CallbackQuery, tgId: number, usd: number): Promise<Result> {
  if (![5, 10, 25].includes(usd)) return { toast: 'Неверное значение' };
  if (!(await setFriendLimit(tgId, usd * USD, `telegram:${q.from.id}`))) return { toast: 'Не найдено' };
  await editCard(q, `Лимит обновлён: ${fmtUsd(usd * USD)}/мес`);
  return { toast: 'Готово' };
}

async function onRaiseRequest(q: CallbackQuery, tgId: number): Promise<Result> {
  // Friend-side: only the tenant itself can ask, and only while ready.
  if (q.from.id !== tgId) return { toast: 'Недоступно' };
  const t = await getTenantByTg(tgId);
  const owner = ownerTgId();
  if (!t || t.state !== 'ready' || owner === null) return { toast: 'Недоступно' };
  if (!(await noticeDue(tgId, 'raise', 6 * 60 * 60 * 1000))) return { toast: 'Запрос уже отправлен' };
  const used = t.limit_usd_micros === null ? '' : ` (${fmtUsd(t.limit_usd_micros)} исчерпан)`;
  await tg.sendProduct(owner, `**${escapeMd(t.name, 80)}** просит поднять лимит${used}.`, {
    buttons: [
      [
        // The raise is permanent (the monthly limit itself changes), so the buttons say the new limit.
        {
          text: t.limit_usd_micros === null ? '+$5' : `Лимит → ${fmtUsd(t.limit_usd_micros + 5 * USD)}`,
          data: `p:ra:${tgId}:5`,
        },
        {
          text: t.limit_usd_micros === null ? '+$10' : `Лимит → ${fmtUsd(t.limit_usd_micros + 10 * USD)}`,
          data: `p:ra:${tgId}:10`,
        },
        { text: 'Отказать', data: `p:rx:${tgId}` },
      ],
    ],
  });
  await tg.sendProduct(tgId, copy.raiseAsked()).catch(() => undefined);
  return { toast: 'Передал' };
}

async function onRaiseGrant(q: CallbackQuery, tgId: number, addUsd: number): Promise<Result> {
  if (![5, 10].includes(addUsd)) return { toast: 'Неверное значение' };
  const t = await getTenantByTg(tgId);
  if (!t || t.state !== 'ready' || t.limit_usd_micros === null) return { toast: 'Не найдено' };
  const next = t.limit_usd_micros + addUsd * USD;
  await setFriendLimit(tgId, next, `telegram:${q.from.id}`);
  await tg.sendProduct(tgId, copy.raiseGranted(next)).catch(() => undefined);
  await editCard(q, `✅ Лимит **${escapeMd(t.name, 80)}** теперь ${fmtUsd(next)}/мес (постоянно)`);
  return { toast: 'Готово' };
}

async function onRaiseDeny(q: CallbackQuery, tgId: number): Promise<Result> {
  const t = await getTenantByTg(tgId);
  if (!t) return { toast: 'Не найдено' };
  await tg.sendProduct(tgId, copy.raiseDenied()).catch(() => undefined);
  await editCard(q, `✖ Просьба **${escapeMd(t.name, 80)}** отклонена`);
  return { toast: 'Отказано' };
}

async function lifecycleCall(fn: () => Promise<void>, ok: string): Promise<Result> {
  try {
    await fn();
    return { toast: ok };
  } catch (err) {
    if (err instanceof LifecycleError) return { toast: err.message.slice(0, 150) };
    log.error('nc: lifecycle callback failed', { err });
    return { toast: 'Ошибка' };
  }
}

// ---------- chat-side buttons: retry / continue / new / suggested replies ----------

const RETRY_GUARD_MS = 2 * 60 * 1000;
const recentRetry = new Map<string, number>();

export function resetRetryGuardForTests(): void {
  recentRetry.clear();
}

/** Telegram topic (message_thread_id) of the message the button sits under; undefined = general conversation. */
function topicNumber(q: CallbackQuery): number | undefined {
  const th = callbackThread(q);
  return th === null ? undefined : Number(th);
}

/** The presser's own ready tenant and DM session; a toast when there is none. */
async function ownChat(q: CallbackQuery): Promise<{ tenant: Tenant; session: Session } | { toast: string }> {
  const chatId = q.message?.chat.id;
  if (chatId === undefined || chatId !== q.from.id) return { toast: 'Недоступно' };
  const tenant = await getTenantByTg(q.from.id);
  if (!tenant || tenant.state !== 'ready' || !tenant.agent_group_id) return { toast: 'Недоступно' };
  const session = await dmSession(tenant, true, callbackThread(q));
  if (!session) return { toast: 'Недоступно' };
  return { tenant, session };
}

/** The button was used: it must not be tapped twice. */
async function spent(q: CallbackQuery): Promise<void> {
  if (q.message) await clearButtons(q.message.chat.id, q.message.message_id);
}

/** [Повторить]: the original prompt goes in again — once per failure, however often the button is tapped. */
async function onRetry(q: CallbackQuery, turnId: string): Promise<Result> {
  const own = await ownChat(q);
  if ('toast' in own) return own;
  const chatId = q.from.id;
  if (!/^[\w:-]{1,60}$/.test(turnId)) return { toast: 'Неверные данные' };
  const base = /^tg:-?\d+:\d+/.exec(turnId)?.[0] ?? turnId;
  const last = recentRetry.get(base);
  if (last !== undefined && Date.now() - last < RETRY_GUARD_MS) return { toast: 'Уже запускаю' };
  if (activeTurn(chatId, topicNumber(q)) === true) return { toast: 'Я ещё отвечаю — подожди' };
  const blocked = await budgetBlock(own.tenant);
  if (blocked) return { toast: blocked };
  const prompt = await retryPrompt(chatId, turnId);
  if (!prompt) return { toast: 'Не нашёл исходное сообщение — пришли его ещё раз' };
  recentRetry.set(base, Date.now());
  for (const [k, at] of recentRetry) if (Date.now() - at > RETRY_GUARD_MS) recentRetry.delete(k);
  // Same base id as the failed turn: a second failure keeps its working [Повторить].
  await injectChat(own.session, chatId, prompt, { sender: own.tenant.name, id: `${base}:r${Date.now().toString(36)}` });
  await spent(q);
  return { toast: 'Повторяю' };
}

/** [Продолжить] after a stop or timeout. */
async function onContinue(q: CallbackQuery): Promise<Result> {
  const own = await ownChat(q);
  if ('toast' in own) return own;
  if (activeTurn(q.from.id, topicNumber(q)) === true) return { toast: 'Я ещё отвечаю — подожди' };
  const blocked = await budgetBlock(own.tenant);
  if (blocked) return { toast: blocked };
  await injectChat(own.session, q.from.id, 'продолжай', { sender: own.tenant.name });
  await spent(q);
  return { toast: 'Продолжаю' };
}

/** [Начать заново] = /new. */
async function onNewConversation(q: CallbackQuery): Promise<Result> {
  const own = await ownChat(q);
  if ('toast' in own) return own;
  await injectChat(own.session, q.from.id, '/clear', { silent: true, wake: isContainerRunning(own.session.id) });
  await spent(q);
  await tg.sendProduct(q.from.id, copy.newConversation(), { silent: true, threadId: topicNumber(q) });
  return;
}

/** A suggested-reply chip: its text goes in as the user's own next message. */
async function onSuggestion(q: CallbackQuery, shortId: string): Promise<Result> {
  const own = await ownChat(q);
  if ('toast' in own) return own;
  const text = await buttonValue(q.from.id, shortId, 'sr');
  if (!text) return { toast: 'Кнопка устарела' };
  const blocked = await budgetBlock(own.tenant);
  if (blocked) return { toast: blocked };
  await injectChat(own.session, q.from.id, text, { sender: own.tenant.name });
  await spent(q);
  return;
}

const OWNER_OPS = new Set(['ap', 'al', 'dn', 'lim', 'ls', 'ra', 'rx', 'rt', 'fp', 'fr', 'fd', 'fdc', 'fdx', 'ro']);

export async function productCallback(q: CallbackQuery, data: string): Promise<Result> {
  const parts = parse(data);
  if (parts[0] !== 'p' || parts.length < 2) return { toast: 'Неизвестная кнопка' };
  const op = parts[1];
  const actor = `telegram:${q.from.id}`;

  if (OWNER_OPS.has(op)) {
    if (!isOwnerPress(q)) {
      log.warn('nc: non-owner pressed an owner button', { from: q.from.id, op });
      return { toast: 'Недоступно' };
    }
    switch (op) {
      case 'ap':
        return onApprove(q, parts[2] ?? '', nc.defaultLimitMicros());
      case 'al': {
        const usd = int(parts[3]) ?? 5;
        if (![5, 10, 25].includes(usd)) return { toast: 'Неверное значение' };
        return onApprove(q, parts[2] ?? '', usd * USD);
      }
      case 'ro': {
        const id = int(parts[2]);
        if (id === null) return { toast: 'Неверные данные' };
        return { toast: (await reopenDenied(id, actor)) ? 'Доступ можно запросить снова' : 'Не найдено' };
      }
      case 'dn':
        return onDeny(q, parts[2] ?? '');
      case 'lim': {
        const id = int(parts[2]);
        return id === null ? { toast: 'Неверные данные' } : onLimitMenu(q, id);
      }
      case 'ls': {
        const id = int(parts[2]);
        const usd = int(parts[3]);
        return id === null || usd === null ? { toast: 'Неверные данные' } : onSetLimit(q, id, usd);
      }
      case 'ra': {
        const id = int(parts[2]);
        const usd = int(parts[3]);
        return id === null || usd === null ? { toast: 'Неверные данные' } : onRaiseGrant(q, id, usd);
      }
      case 'rx': {
        const id = int(parts[2]);
        return id === null ? { toast: 'Неверные данные' } : onRaiseDeny(q, id);
      }
      case 'rt': {
        const id = int(parts[2]);
        if (id === null) return { toast: 'Неверные данные' };
        return { toast: (await retryProvisioning(id)) ? 'Повторяю' : 'Нечего повторять' };
      }
      case 'fp': {
        const id = int(parts[2]);
        return id === null
          ? { toast: 'Неверные данные' }
          : lifecycleCall(() => pauseFriend(id, actor), 'Приостановлен');
      }
      case 'fr': {
        const id = int(parts[2]);
        return id === null ? { toast: 'Неверные данные' } : lifecycleCall(() => resumeFriend(id, actor), 'Возобновлён');
      }
      case 'fd': {
        // First tap only asks; deletion needs the explicit second button.
        const id = int(parts[2]);
        if (id === null) return { toast: 'Неверные данные' };
        const t = await getTenantByTg(id);
        if (!t) return { toast: 'Не найдено' };
        await editCard(q, `Удалить **${escapeMd(t.name, 80)}** вместе с данными? Это необратимо (30 дней в корзине).`, {
          buttons: [
            [
              { text: '🗑 Удалить', data: `p:fdc:${id}` },
              { text: 'Отмена', data: `p:fdx:${id}` },
            ],
          ],
        });
        return;
      }
      case 'fdc': {
        const id = int(parts[2]);
        return id === null ? { toast: 'Неверные данные' } : lifecycleCall(() => deleteFriend(id, actor), 'Удалён');
      }
      case 'fdx':
        await editCard(q, 'Отменено.');
        return;
    }
  }

  switch (op) {
    case 'rl': {
      const id = int(parts[2]);
      return id === null ? { toast: 'Неверные данные' } : onRaiseRequest(q, id);
    }
    case 'cap': {
      const t = await getTenantByTg(q.from.id);
      if (!t || t.state !== 'ready') return { toast: 'Недоступно' };
      await tg.sendProduct(q.from.id, copy.help());
      return;
    }
    case 'rty':
    case 'retry':
      return onRetry(q, parts.slice(2).join(':'));
    case 'cont':
      return onContinue(q);
    case 'new':
      return onNewConversation(q);
    case 'sr':
      return onSuggestion(q, parts[2] ?? '');
    case 'tp':
    case 'tc':
    case 'tcc':
    case 'tcx':
    case 'tr':
    case 'trun':
    case 'rd':
    case 'sz':
    case 'tt':
      return handleTaskCallback(q, op, parts[2] ?? '');
    default:
      return { toast: 'Неизвестная кнопка' };
  }
}
