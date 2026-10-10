/** Owner decisions on access requests, shared by the chat buttons and the Mini App. */
import { log } from '../log.js';
import { copy } from './copy.js';
import { ownerTgId } from './config.js';
import { tg } from './port.js';
import { startProvisioning } from './provision.js';
import { audit, clearRetained, decideRequest, getRequest, getTenantByTg, transitionTenant } from './store.js';
import { escapeMd } from './util.js';

export type DecisionResult = 'ok' | 'not_found' | 'already_decided' | 'failed';

async function editOwnerCard(cardMessageId: number | null, md: string): Promise<void> {
  const owner = ownerTgId();
  if (!owner || cardMessageId === null) return;
  await tg
    .editProduct(owner, cardMessageId, md, { buttons: [] })
    .catch((err) => log.warn('nc: owner card edit failed', { err }));
}

export async function approveRequest(
  reqId: string,
  limitMicros: number | null,
  actor: string,
): Promise<DecisionResult> {
  const req = await getRequest(reqId);
  if (!req) return 'not_found';
  if (req.status !== 'pending' || !(await decideRequest(reqId, 'approved'))) return 'already_decided';
  const t = await getTenantByTg(req.tg_id);
  if (!(await startProvisioning(req.tg_id, limitMicros, actor))) return 'failed';
  await editOwnerCard(
    req.card_message_id,
    `⏳ Создаю пространство для **${escapeMd(t?.name ?? String(req.tg_id), 80)}**…`,
  );
  return 'ok';
}

export async function denyRequest(reqId: string, actor: string): Promise<DecisionResult> {
  const req = await getRequest(reqId);
  if (!req) return 'not_found';
  if (req.status !== 'pending' || !(await decideRequest(reqId, 'denied'))) return 'already_decided';
  const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  await transitionTenant(req.tg_id, ['pending'], 'denied', {
    denied_until: until,
    decided_at: new Date().toISOString(),
  });
  await clearRetained(req.tg_id);
  await audit(actor, 'deny', `telegram:${req.tg_id}`);
  const t = await getTenantByTg(req.tg_id);
  await tg.sendProduct(req.tg_id, copy.denied()).catch(() => undefined);
  await editOwnerCard(req.card_message_id, `✖ **${escapeMd(t?.name ?? String(req.tg_id), 80)}** отклонён(а)`);
  return 'ok';
}

/** Owner override of the 30-day cooldown: the user's next message opens a fresh request. */
export async function reopenDenied(tgId: number, actor: string): Promise<boolean> {
  const patch = { denied_until: new Date().toISOString() };
  const ok =
    (await transitionTenant(tgId, ['denied'], 'denied', patch)) ||
    (await transitionTenant(tgId, ['deleted'], 'deleted', patch));
  if (!ok) return false;
  await audit(actor, 'reopen', `telegram:${tgId}`);
  return true;
}
