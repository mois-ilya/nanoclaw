// nanoclaw-fork: remembers which inbound messages already got a chat reply delivered, so a crash
// retry does not re-run the turn and send the same <message> blocks again.
//
// In-memory on purpose: it only has to bridge "delivered during the crashed attempt" to the sweep's
// reset a few seconds later. After a host restart the retry falls back to the (capped) re-run.
const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const delivered = new Map<string, number>();

const keyOf = (sessionId: string, messageId: string): string => `${sessionId}\u0000${messageId}`;

export function noteReplyDelivered(sessionId: string, inReplyTo: string | null | undefined, now = Date.now()): void {
  if (!inReplyTo) return;
  delivered.set(keyOf(sessionId, inReplyTo), now);
  if (delivered.size > MAX_ENTRIES) {
    for (const [k, at] of delivered) {
      if (now - at > TTL_MS || delivered.size > MAX_ENTRIES) delivered.delete(k);
      else break;
    }
  }
}

export function hasReplyDelivered(sessionId: string, messageId: string, now = Date.now()): boolean {
  const at = delivered.get(keyOf(sessionId, messageId));
  if (at === undefined) return false;
  if (now - at > TTL_MS) {
    delivered.delete(keyOf(sessionId, messageId));
    return false;
  }
  return true;
}

export function _resetReplyLedgerForTesting(): void {
  delivered.clear();
}
