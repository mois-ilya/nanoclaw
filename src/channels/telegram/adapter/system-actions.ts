/** Runner → host UI telemetry (contract C3): turn / preview / progress. */
import { registerDeliveryAction } from '../../../delivery.js';
import { getMessagingGroup } from '../../../db/messaging-groups.js';
import { unguarded } from '../../../guard/types.js';
import { log } from '../../../log.js';
import type { Session } from '../../../types.js';
import { chatIdFromPlatformId, parseThreadId } from './format.js';
import { getRuntime } from './runtime.js';

async function chatFor(session: Session): Promise<number | null> {
  if (!session.messaging_group_id) return null;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg || mg.channel_type !== 'telegram') return null;
  return chatIdFromPlatformId(mg.platform_id);
}

export type TelemetryAction = 'turn' | 'preview' | 'progress';

export async function handleTelemetry(
  action: TelemetryAction,
  c: Record<string, unknown>,
  session: Session,
): Promise<void> {
  const rt = getRuntime();
  if (!rt) return;
  try {
    const chatId = await chatFor(session);
    if (chatId === null || typeof c.turnId !== 'string') return;
    // A per-thread DM session is one private-chat topic; the general conversation has no thread.
    const base = { chatId, threadId: parseThreadId(session.thread_id), turnId: c.turnId, sessionId: session.id };
    if (action === 'turn') {
      const state = c.state;
      if (state === 'started' || state === 'finished' || state === 'cancelled' || state === 'failed') {
        rt.turns.onTurn({ ...base, state });
      }
    } else if (action === 'preview') {
      if (typeof c.seq === 'number' && typeof c.text === 'string')
        rt.turns.onPreview({ ...base, seq: c.seq, text: c.text });
    } else {
      const s = c.step as { id?: unknown; label?: unknown; state?: unknown; ms?: unknown } | undefined;
      if (typeof c.seq === 'number' && s && typeof s.id === 'string' && typeof s.label === 'string') {
        const state = s.state === 'done' || s.state === 'failed' ? s.state : 'running';
        rt.turns.onProgress({
          ...base,
          seq: c.seq,
          step: { id: s.id, label: s.label.slice(0, 120), state, ...(typeof s.ms === 'number' ? { ms: s.ms } : {}) },
        });
      }
    }
  } catch (err) {
    // UI telemetry must never fail a delivery batch.
    log.warn('telegram telemetry handler failed', { action, err });
  }
}

for (const action of ['turn', 'preview', 'progress'] as const) {
  registerDeliveryAction(
    action,
    (content, session) => handleTelemetry(action, content, session),
    unguarded('ui telemetry'),
  );
}
