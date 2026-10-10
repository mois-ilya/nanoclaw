/**
 * Private-chat gate (C7): decides, per tenant state, whether an inbound private
 * message is routed to an agent. The adapter calls it for EVERY private
 * message, before anything is downloaded or routed. Fail-closed: any state we
 * do not recognise is `handled` (never routed).
 */
import { log } from '../log.js';
import { budgetFor, globalCapCopy, globalCapUntil, isExhausted, periodEndLabel } from './budget.js';
import { copy } from './copy.js';
import { DAY_MS, displayName, escapeMd, withLock } from './util.js';
import { nc, ownerTgId } from './config.js';
import type { GateDecision, PrivateUpdateCtx } from './port.js';
import { tg } from './port.js';
import {
  audit,
  createRequest,
  gateIdOf,
  getTenantByTg,
  insertTenantIfAbsent,
  noticeDue,
  retain,
  setRequestCard,
  updateTenant,
  type Tenant,
} from './store.js';

const HANDLED: GateDecision = { action: 'handled' };
const ROUTE: GateDecision = { action: 'route' };

async function say(chatId: number, md: string, buttons?: Parameters<typeof tg.sendProduct>[2]): Promise<void> {
  try {
    await tg.sendProduct(chatId, md, buttons);
  } catch (err) {
    // A failed courtesy reply must not make the adapter retry the whole update.
    log.warn('nc: gate reply failed', { chatId, err });
  }
}

/** Commands the product module itself answers (they bypass the budget wall). */
const PRODUCT_COMMANDS = new Set(['start', 'help', 'menu', 'new', 'stop', 'tasks']);

function commandName(ctx: PrivateUpdateCtx): string | null {
  const m = /^\/(\w+)/.exec(ctx.message?.text ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** A bare «Start» tap: nothing worth keeping or replaying. */
function isBareStart(ctx: PrivateUpdateCtx): boolean {
  return ctx.kind === 'command' && commandName(ctx) === 'start' && !/^\/start\S*\s+\S/.test(ctx.message?.text ?? '');
}

function firstMessageText(ctx: PrivateUpdateCtx): string {
  const m = ctx.message;
  if (isBareStart(ctx)) return '(открыл бота)';
  const text = m?.text ?? m?.caption;
  if (text && text.trim()) return text.trim();
  if (ctx.kind === 'voice') return '[голосовое сообщение]';
  if (ctx.kind === 'media') return '[вложение]';
  return '[сообщение]';
}

async function requestAccess(ctx: PrivateUpdateCtx, existing: boolean): Promise<void> {
  const tgId = ctx.user.id;
  const name = displayName(ctx.user);
  if (existing) {
    await updateTenant(tgId, {
      state: 'pending',
      name,
      username: ctx.user.username ?? null,
      denied_until: null,
      decided_at: null,
    });
  } else {
    await insertTenantIfAbsent({ tgId, name, username: ctx.user.username ?? null, state: 'pending' });
  }
  const first = firstMessageText(ctx);
  const req = await createRequest(tgId, first);
  if (!isBareStart(ctx)) await retain(tgId, JSON.stringify(ctx.update));
  await noticeDue(tgId, 'pending', DAY_MS); // the pending copy below counts as shown
  await audit(`telegram:${tgId}`, 'access_request', `telegram:${tgId}`, { req: req.id });

  const owner = ownerTgId();
  if (owner) {
    const handle = ctx.user.username ? `@${escapeMd(ctx.user.username, 40)}` : 'без username';
    const md =
      `🔔 **Запрос доступа**\n` +
      `**${escapeMd(name, 80)}**  ${handle} · id ${tgId}\n` +
      `Первое сообщение: «${escapeMd(first.slice(0, 200), 200)}»\n` +
      `Язык интерфейса: ${escapeMd(ctx.user.languageCode ?? 'неизвестно', 10)}`;
    try {
      const sent = await tg.sendProduct(owner, md, {
        buttons: [
          [{ text: '✅ Принять', data: `p:ap:${req.id}` }],
          [
            { text: 'Лимит $5', data: `p:al:${req.id}:5` },
            { text: 'Лимит $10', data: `p:al:${req.id}:10` },
            { text: 'Лимит $25', data: `p:al:${req.id}:25` },
          ],
          [{ text: '✖ Отклонить', data: `p:dn:${req.id}` }],
        ],
      });
      if (sent.messageId > 0) await setRequestCard(req.id, sent.messageId);
    } catch (err) {
      log.error('nc: owner access card failed', { err });
    }
  }
  await say(tgId, copy.pendingFirst());
}

async function gateFriend(ctx: PrivateUpdateCtx): Promise<GateDecision> {
  const tgId = ctx.user.id;
  const t: Tenant | undefined = await getTenantByTg(tgId);

  if (!t) {
    await requestAccess(ctx, false);
    return HANDLED;
  }

  switch (t.state) {
    case 'ready': {
      if (!t.agent_group_id) return HANDLED;
      if (ctx.kind === 'command') {
        const cmd = commandName(ctx);
        if (cmd && PRODUCT_COMMANDS.has(cmd)) return ROUTE;
        // Upstream admin commands (/clear, /compact, /cost...) are not for friends. With the budget spent the
        // honest answer is the budget wall, not «такой команды нет» (an unknown slash must never reach the agent).
        const snapCmd = await budgetFor(gateIdOf(t));
        if (isExhausted(snapCmd) && snapCmd) {
          await say(
            tgId,
            copy.budgetExhausted(snapCmd.limitMicros ?? t.limit_usd_micros ?? 0, periodEndLabel(snapCmd)),
            {
              buttons: [[{ text: `Попросить ${nc.ownerNameGen()} поднять`, data: `p:rl:${tgId}` }]],
            },
          );
          return HANDLED;
        }
        await say(tgId, copy.unknownCommand());
        return HANDLED;
      }
      if (globalCapUntil()) {
        await say(tgId, globalCapCopy(false));
        return HANDLED;
      }
      const snap = await budgetFor(gateIdOf(t));
      if (isExhausted(snap) && snap) {
        await say(tgId, copy.budgetExhausted(snap.limitMicros ?? t.limit_usd_micros ?? 0, periodEndLabel(snap)), {
          buttons: [[{ text: `Попросить ${nc.ownerNameGen()} поднять`, data: `p:rl:${tgId}` }]],
        });
        return HANDLED;
      }
      if (!snap && (await noticeDue(tgId, 'svc-down', 10 * 60_000))) {
        // nanogate unreachable: the message is still routed (and stays pending), but say so once.
        await say(tgId, copy.serviceDown());
      }
      return ROUTE;
    }
    case 'paused':
      if (await noticeDue(tgId, 'paused', DAY_MS)) await say(tgId, copy.paused());
      return HANDLED;
    case 'pending':
      if (!isBareStart(ctx)) await retain(tgId, JSON.stringify(ctx.update));
      if (await noticeDue(tgId, 'pending', DAY_MS)) await say(tgId, copy.pendingWaiting());
      return HANDLED;
    case 'provisioning':
    case 'provisioning_failed':
      if (!isBareStart(ctx)) await retain(tgId, JSON.stringify(ctx.update));
      if (await noticeDue(tgId, `prov-${t.state}`, 60 * 60_000)) {
        await say(tgId, t.state === 'provisioning' ? copy.provisioning() : copy.provisioningFailed());
      }
      return HANDLED;
    case 'denied': {
      const until = t.denied_until ? Date.parse(t.denied_until) : 0;
      if (until > Date.now()) return HANDLED; // cooldown: silent
      await requestAccess(ctx, true);
      return HANDLED;
    }
    case 'deleted': {
      const until = t.denied_until ? Date.parse(t.denied_until) : Infinity;
      if (until > Date.now()) {
        if (await noticeDue(tgId, 'closed', DAY_MS)) await say(tgId, copy.closed());
        return HANDLED;
      }
      await requestAccess(ctx, true); // cooldown over or owner reopened: a fresh request, a fresh nanogate tenant id
      return HANDLED;
    }
    default:
      return HANDLED;
  }
}

export async function privateGate(ctx: PrivateUpdateCtx): Promise<GateDecision> {
  const tgId = ctx.user.id;
  // A private chat's id is the user's id; anything else is not a DM we serve.
  if (ctx.chatId !== tgId) return HANDLED;
  const owner = ownerTgId();
  if (owner !== null && tgId === owner) {
    if (ctx.kind !== 'command' && globalCapUntil()) {
      await say(tgId, globalCapCopy(true), { buttons: [[{ text: 'Открыть «Система»', webApp: 'system' }]] });
      return HANDLED;
    }
    return ROUTE;
  }
  try {
    return await withLock(`gate:${tgId}`, () => gateFriend(ctx));
  } catch (err) {
    log.error('nc: gate failed; message not routed', { tgId, err });
    return HANDLED;
  }
}
