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
