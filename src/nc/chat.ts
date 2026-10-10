/** Host-side writes into a tenant's own session (never into anyone else's). */
import { randomUUID } from 'node:crypto';

import { getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { killContainer } from '../container-runner.js';
import { requestWake } from '../request-wake.js';
import { resolveSession, writeSessionMessage } from '../session-manager.js';
import type { Session } from '../types.js';
import { platformIdOf } from './config.js';
import type { Tenant } from './store.js';

/** The tenant's DM session (created on first use, like a routed message would). */
export async function dmSession(
  t: Pick<Tenant, 'tg_id' | 'agent_group_id'>,
  create = false,
): Promise<Session | undefined> {
  if (!t.agent_group_id) return undefined;
  const mg = await getMessagingGroupByPlatform('telegram', platformIdOf(t.tg_id));
  if (!mg) return undefined;
  if (create) return (await resolveSession(t.agent_group_id, mg.id, null, 'shared')).session;
  const { findSessionForAgent } = await import('../db/sessions.js');
  return findSessionForAgent(t.agent_group_id, mg.id, null);
}

/**
 * Write a host-originated chat row (`/clear`, `/stop`, "forget" requests) into
 * the tenant's DM session and wake it. These rows bypass the router's command
 * gate on purpose: they are product actions of the tenant on their OWN session.
 */
export async function injectChat(
  session: Session,
  tgId: number,
  text: string,
  opts: { sender?: string; silent?: boolean; wake?: boolean; id?: string } = {},
): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: opts.id ?? `nc-${Date.now()}-${randomUUID().slice(0, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: platformIdOf(tgId),
    channelType: 'telegram',
    threadId: null,
    content: JSON.stringify({
      text,
      sender: opts.sender ?? 'nanoclaw',
      senderId: `telegram:${tgId}`,
      senderName: opts.sender ?? 'nanoclaw',
      // The runner skips its own English «Session cleared.» when the host already confirmed in Russian.
      ...(opts.silent ? { nc: { silent: true } } : {}),
    }),
    // A non-waking row rides along (trigger=0) with the user's next message instead of cold-starting a container.
    trigger: opts.wake !== false,
  });
  if (opts.wake !== false) await requestWake(session, 'inbound-message');
}

/** Stop every running container of an agent group (pause/delete). */
export async function killGroupContainers(agentGroupId: string, reason: string): Promise<number> {
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  for (const s of sessions) killContainer(s.id, reason);
  return sessions.length;
}
