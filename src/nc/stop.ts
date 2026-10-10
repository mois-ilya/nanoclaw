/** Stop button / draft stop (C3): cancel the active turn of the chat's own session. */
import { log } from '../log.js';
import { getSession } from '../db/sessions.js';
import { injectChat } from './chat.js';
import { getTenantByTg } from './store.js';

/**
 * The adapter resolves draft -> (chatId, sessionId, turnId). We do not trust
 * the sessionId blindly: it must belong to the agent group of the tenant that
 * owns this chat, otherwise nothing is written.
 */
export async function stopHandler(t: { chatId: number; sessionId: string; turnId: string }): Promise<void> {
  const tenant = await getTenantByTg(t.chatId);
  if (!tenant || tenant.state !== 'ready' || !tenant.agent_group_id) return;
  const session = await getSession(t.sessionId);
  if (!session || session.agent_group_id !== tenant.agent_group_id) {
    log.warn('nc: stop for a session outside the chat tenant ignored', { chatId: t.chatId });
    return;
  }
  await injectChat(session, t.chatId, '/stop');
}
