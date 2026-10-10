/**
 * Friend provisioning: an idempotent, durable job (`nc_jobs`, kind `provision`).
 * Steps follow upstream-map §2. A partial failure never routes to another
 * group and never loses the retained first message (it is only deleted at
 * replay, one row at a time, right before it is routed).
 */
import { randomUUID } from 'node:crypto';

import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { updateContainerConfigJson, updateContainerConfigScalars } from '../db/container-configs.js';
import { groupFolderExistsOnDisk } from '../group-folder.js';
import { initGroupFilesystem } from '../group-init.js';
import { log } from '../log.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { routeInbound } from '../router.js';
import type { Message, Update } from '../channels/telegram/botapi/index.js';
import type { AgentGroup } from '../types.js';
import { copy } from './copy.js';
import { nc, ownerTgId, platformIdOf, presetConfig, userIdOf } from './config.js';
import { canReplay, tg } from './port.js';
import {
  audit,
  clearRetainedOne,
  getPrefs,
  getTenantByTg,
  kvGet,
  kvSet,
  listJobs,
  patchJob,
  putPrefs,
  takeRetained,
  transitionTenant,
  updateTenant,
  upsertJob,
  type Job,
  type Tenant,
} from './store.js';
import { ensureDmWiring, pushTenant, rememberGroupTenant } from './tenants.js';
import { friendPersona } from './templates.js';
import { escapeMd, fmtUsd, withLock } from './util.js';
import { setChatSurface } from './surface.js';

const STEPS = [
  'user',
  'group',
  'fs',
  'config',
  'member',
  'wiring',
  'nanogate',
  'menu',
  'ready',
  'welcome',
  'replay',
  'card',
] as const;
type Step = (typeof STEPS)[number];

async function mustTenant(tgId: number): Promise<Tenant> {
  const t = await getTenantByTg(tgId);
  if (!t) throw new Error(`tenant ${tgId} vanished`);
  return t;
}

async function pickFolder(tgId: number): Promise<string> {
  const base = `f-${tgId}`;
  for (let n = 0; n < 50; n++) {
    const cand = n === 0 ? base : `${base}-${n + 1}`;
    if (!(await getAgentGroupByFolder(cand)) && !groupFolderExistsOnDisk(cand)) return cand;
  }
  throw new Error('no free folder for agent group');
}

async function stepGroup(t: Tenant): Promise<AgentGroup> {
  if (t.agent_group_id) {
    const existing = await getAgentGroup(t.agent_group_id);
    if (existing) return existing;
  }
  const ag: AgentGroup = {
    id: `ag-${randomUUID()}`,
    name: t.name,
    folder: await pickFolder(t.tg_id),
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  await createAgentGroup(ag);
  await updateTenant(t.tg_id, { agent_group_id: ag.id });
  return ag;
}

/** Text of a retained update, if it has any. */
function messageText(m: Message): string | null {
  const text = m.text ?? m.caption;
  return text && text.trim() ? text : null;
}

/** Retained updates the friend sent before access: voice, photos, files and albums need the adapter's own pipeline. */
export async function replayRetained(t: Tenant): Promise<number> {
  let replayed = 0;
  let lost = 0;
  for (const json of await takeRetained(t.tg_id)) {
    // Claim first: exactly-once beats at-least-once for a user-visible replay.
    if (!(await clearRetainedOne(t.tg_id, json))) continue;
    let update: Update | undefined;
    let m: Message | undefined;
    try {
      update = JSON.parse(json) as Update;
      m = (update as { message?: Message }).message;
    } catch {
      continue;
    }
    if (!m) continue;
    const text = messageText(m);
    // A bare «Start» tap carries nothing to answer.
    if (text && /^\/start(@\w+)?$/i.test(text.trim())) continue;
    if (canReplay() && update) {
      // download -> transcribe -> onInbound, with the 👀 / typing / attachments of a live message.
      try {
        await tg.replay!(update);
        replayed++;
      } catch (err) {
        log.warn('nc: replay through the adapter failed', { tgId: t.tg_id, err });
        lost++;
      }
      continue;
    }
    if (!text) {
      lost++; // no adapter pipeline available for non-text
      continue;
    }
    await routeInbound({
      channelType: 'telegram',
      platformId: platformIdOf(t.tg_id),
      threadId: null,
      message: {
        id: `tg:${t.tg_id}:${m.message_id}`,
        kind: 'chat',
        content: JSON.stringify({
          text,
          senderId: userIdOf(t.tg_id),
          sender: t.name,
          senderName: t.name,
          nc: { tgMessageId: m.message_id, chatId: t.tg_id },
        }),
        timestamp: new Date(m.date * 1000).toISOString(),
        isMention: true,
        isGroup: false,
      },
    });
    replayed++;
  }
  if (lost > 0) {
    await tg
      .sendProduct(
        t.tg_id,
        'Часть того, что ты прислал до подключения (голосовое, фото или файл), не дошла. Пришли, пожалуйста, ещё раз.',
      )
      .catch(() => undefined);
  }
  return replayed;
}

async function runStep(step: Step, tgId: number): Promise<void> {
  const t = await mustTenant(tgId);
  switch (step) {
    case 'user':
      await upsertUser({ id: t.user_id, kind: 'telegram', display_name: t.name, created_at: new Date().toISOString() });
      return;
    case 'group':
      await stepGroup(t);
      return;
    case 'fs': {
      const ag = await stepGroup(t);
      const prefs = await getPrefs(t.user_id, { tz: nc.defaultTz() });
      await initGroupFilesystem(ag, { instructions: friendPersona({ name: t.name, tz: prefs.tz }) });
      return;
    }
    case 'config': {
      const ag = await stepGroup(t);
      const prefs = await getPrefs(t.user_id, { tz: nc.defaultTz() });
      const p = presetConfig(prefs.preset);
      await updateContainerConfigScalars(ag.id, {
        // M9: group-scoped CLI (tasks only matter for friends); never global.
        cli_scope: 'group',
        model: p.model,
        effort: p.effort,
        timezone: prefs.tz,
        assistant_name: nc.botName(),
      });
      await updateContainerConfigJson(ag.id, 'skills', ['agent-browser']);
      await putPrefs(t.user_id, prefs);
      return;
    }
    case 'member': {
      const ag = await stepGroup(t);
      await addMember({
        user_id: t.user_id,
        agent_group_id: ag.id,
        added_by: null,
        added_at: new Date().toISOString(),
      });
      return;
    }
    case 'wiring': {
      const ag = await stepGroup(t);
      await ensureDmWiring(tgId, t.name, ag);
      return;
    }
    case 'nanogate': {
      const ag = await stepGroup(t);
      await pushTenant(await mustTenant(tgId));
      rememberGroupTenant(ag.id, tgId, tgId === ownerTgId() ? 'owner' : 'friend', (await mustTenant(tgId)).epoch);
      return;
    }
    case 'menu':
      await setChatSurface(tgId, false).catch((err) => log.warn('nc: menu/commands setup failed', { tgId, err }));
      return;
    case 'ready':
      await transitionTenant(tgId, ['provisioning', 'provisioning_failed'], 'ready');
      return;
    case 'welcome': {
      const key = `welcomed:${tgId}:${t.epoch}`;
      if (await kvGet(key)) return;
      await tg.sendProduct(tgId, copy.welcome(t.name), {
        buttons: [
          [
            { text: 'Что ты умеешь?', data: 'p:cap' },
            { text: 'Открыть кабинет', webApp: '' },
          ],
        ],
      });
      await kvSet(key, '1');
      return;
    }
    case 'replay':
      await replayRetained(await mustTenant(tgId));
      return;
    case 'card':
      await finalizeCard(await mustTenant(tgId));
      return;
  }
}

/** Edit the owner's request card to its terminal approved state. */
export async function finalizeCard(t: Tenant): Promise<void> {
  const owner = ownerTgId();
  if (!owner) return;
  const { getDb } = await import('../db/connection.js');
  const req = await getDb().get<{ id: string; card_message_id: number | null }>(
    "SELECT id, card_message_id FROM nc_requests WHERE tg_id = ? AND status = 'approved' ORDER BY created_at DESC LIMIT 1",
    t.tg_id,
  );
  if (!req?.card_message_id) return;
  const limit = t.limit_usd_micros === null ? 'без лимита' : `лимит ${fmtUsd(t.limit_usd_micros)}/мес`;
  await tg
    .editProduct(owner, req.card_message_id, `✅ **${escapeMd(t.name)}** принят(а) · ${limit}`, {
      buttons: [
        [
          { text: 'Изменить лимит', data: `p:lim:${t.tg_id}` },
          { text: 'Кабинет', webApp: 'friends' },
        ],
      ],
    })
    .catch((err) => log.warn('nc: request card edit failed', { err }));
}

const running = new Set<string>();

/** Run (or resume) a provision job to completion. Never throws. */
export async function runProvisionJob(job: Job): Promise<boolean> {
  const tgId = Number(job.tenant);
  return withLock(`prov:${tgId}`, async () => {
    if (running.has(job.id)) return false;
    running.add(job.id);
    try {
      const startAt = Math.max(0, STEPS.indexOf(job.step as Step));
      await patchJob(job.id, { status: 'running', attempts: job.attempts + 1 });
      for (let i = startAt; i < STEPS.length; i++) {
        const step = STEPS[i];
        await patchJob(job.id, { step });
        await runStep(step, tgId);
      }
      await patchJob(job.id, { status: 'done', step: 'done', last_error: null });
      await audit('system', 'provisioned', userIdOf(tgId));
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error('nc: provisioning failed', { tgId, step: job.step, err });
      await patchJob(job.id, { status: 'failed', last_error: reason.slice(0, 500) });
      const t = await getTenantByTg(tgId);
      if (t && t.state === 'provisioning') await transitionTenant(tgId, ['provisioning'], 'provisioning_failed');
      const owner = ownerTgId();
      if (owner && t) {
        await tg
          .sendProduct(owner, copy.provisionFailedOwner(t.name, reason), {
            buttons: [[{ text: 'Повторить', data: `p:rt:${tgId}` }]],
          })
          .catch(() => undefined);
      }
      return false;
    } finally {
      running.delete(job.id);
    }
  });
}

/** Approve (owner callback or Mini App). Idempotent against double taps. */
export async function startProvisioning(tgId: number, limitMicros: number | null, actor: string): Promise<boolean> {
  const t = await getTenantByTg(tgId);
  if (!t) return false;
  const ok = await transitionTenant(tgId, ['pending', 'denied'], 'provisioning', {
    limit_usd_micros: limitMicros,
    decided_at: new Date().toISOString(),
    denied_until: null,
  });
  if (!ok) return false;
  await audit(actor, 'approve', t.user_id, { limitMicros });
  const job = await upsertJob('provision', String(tgId));
  void runProvisionJob(job);
  return true;
}

/**
 * Retry a failed provisioning from its recorded step. Works whatever the tenant state: a failure AFTER the
 * `ready` step (welcome, replay, card) leaves the tenant ready but the job failed, and must still be retryable.
 */
export async function retryProvisioning(tgId: number): Promise<boolean> {
  const t = await getTenantByTg(tgId);
  if (!t) return false;
  if (t.state === 'provisioning_failed') {
    await transitionTenant(tgId, ['provisioning_failed'], 'provisioning');
  } else if (t.state !== 'provisioning') {
    const failed = (await listJobs(['failed'])).some((j) => j.kind === 'provision' && j.tenant === String(tgId));
    if (!failed) return false;
  }
  const job = await upsertJob('provision', String(tgId));
  void runProvisionJob(job);
  return true;
}

/** Host start: resume jobs that were mid-flight. */
export async function resumeProvisioning(): Promise<void> {
  for (const job of await listJobs(['pending', 'running', 'failed'])) {
    if (job.kind !== 'provision') continue;
    // A failed job of a tenant that is already ready (failed at welcome/replay/card) is picked up again too.
    if (job.status === 'failed') {
      const t = await getTenantByTg(Number(job.tenant));
      if (!t || t.state !== 'ready') continue; // provisioning_failed waits for the owner's «Повторить»
    }
    void runProvisionJob(job);
  }
}
