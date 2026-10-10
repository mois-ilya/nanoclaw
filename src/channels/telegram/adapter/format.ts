import { createHash, randomBytes } from 'crypto';

/** `m:ss` — status card / draft header clock. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** «45 с», «1 мин 12 с», «3 мин». */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} с`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m} мин` : `${m} мин ${s} с`;
}

/** Russian plural for «шаг»: 1 шаг, 2–4 шага, 5–20 шагов, 21 шаг … */
export function stepsWord(n: number): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} шагов`;
  if (mod10 === 1) return `${n} шаг`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} шага`;
  return `${n} шагов`;
}

/** Stable non-zero int31 draft id derived from the turn id. */
export function draftIdFor(turnId: string): number {
  const h = createHash('sha1').update(turnId).digest();
  const n = h.readUInt32BE(0) & 0x7fffffff;
  return n === 0 ? 1 : n;
}

/** Escape characters that would turn host-provided labels into Markdown. */
export function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()<>#+\-.!|~$]/g, '\\$&');
}

export function shortId(): string {
  // 8 base36 chars; callback_data ("q:" + id) stays far below 64 bytes.
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += (bytes[i] % 36).toString(36);
  return out;
}

export function chatIdFromPlatformId(platformId: string): number | null {
  const m = /^telegram:(-?\d+)$/.exec(platformId);
  if (!m) return null;
  return Number(m[1]);
}

/** Inbound row / turn id "tg:<chat>:<mid>[:suffix]" -> user message id. */
export function messageIdFromTurnId(turnId: string): number | null {
  // `<orig>:echo:<session>` is a cross-session copy of ANOTHER conversation's message: not this turn's message.
  if (turnId.includes(':echo:')) return null;
  const m = /^tg:-?\d+:(\d+)/.exec(turnId);
  return m ? Number(m[1]) : null;
}

/** Overload / budget / timeout / other, from whatever text the runner put in a failure notice. */
export function classifyFailure(
  text: string,
): 'overload' | 'budget' | 'busy' | 'turn_cap' | 'global_cap' | 'timeout' | 'generic' {
  const t = text.toLowerCase();
  if (/global.?cap|общего лимита/.test(t)) return 'global_cap';
  if (/turn_cap|слишком дорогой запрос/.test(t)) return 'turn_cap';
  if (/budget_insufficient_now|параллельный запрос/.test(t)) return 'busy';
  if (/overload|\b429\b|\b529\b|rate.?limit|перегруж/.test(t)) return 'overload';
  if (/budget|\b402\b|limit exceeded|spend|лимит/.test(t)) return 'budget';
  if (/timed? ?out|timeout|wall.?clock|too long|слишком долго/.test(t)) return 'timeout';
  return 'generic';
}

/** "tg:<chat>:<mid>[:suffix]" -> "tg:<chat>:<mid>" (fits callback_data). */
export function baseTurnId(turnId: string): string {
  const m = /^tg:-?\d+:\d+/.exec(turnId);
  return m ? m[0] : turnId;
}

/**
 * Router thread id ("7") -> Telegram `message_thread_id`. Only plain positive integers are real topics:
 * reserved ids ('system:tasks:…', 'task:…') and anything else never reach Telegram as a thread.
 */
export function parseThreadId(raw: string | number | null | undefined): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  if (typeof raw !== 'string' || !/^\d{1,15}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 ? n : undefined;
}

/** Spreadable `message_thread_id` for any send* / sendChatAction / draft call. */
export function threadParam(threadId: number | undefined): { message_thread_id?: number } {
  return threadId !== undefined ? { message_thread_id: threadId } : {};
}

/** Key of one conversation of a private chat: the chat itself ('general') or one topic of it. */
export function convKey(chatId: number, threadId: number | undefined): string {
  return threadId === undefined ? `${chatId}` : `${chatId}#${threadId}`;
}

/**
 * Draft id of the turn answering this inbound row. The «Thinking…» placeholder (sent on accept, before the turn
 * exists) and the turn's own rich draft both use it, so Telegram animates one into the other.
 */
export function turnDraftId(turnId: string): number {
  // An echo id must not share the draft id of the original message it copies.
  return draftIdFor(turnId.includes(':echo:') ? turnId : baseTurnId(turnId));
}
