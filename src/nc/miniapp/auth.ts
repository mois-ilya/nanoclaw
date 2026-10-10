/**
 * Telegram Mini App `initData` validation (HMAC method).
 *   secret = HMAC_SHA256(key = "WebAppData", msg = bot_token)
 *   hash   = HMAC_SHA256(key = secret, msg = data_check_string)
 * The data-check-string is every received field except `hash`, as `key=value`
 * (values URL-decoded), sorted by key, joined with "\n". Compared in constant time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface InitUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitData {
  user: InitUser;
  authDate: number;
  startParam?: string;
}

export class InitDataError extends Error {
  constructor(readonly reason: string) {
    super(`invalid initData: ${reason}`);
  }
}

export const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;
const MAX_RAW = 8192;
const FUTURE_SKEW_S = 60;

export function validateInitData(
  raw: unknown,
  botToken: string,
  opts: { nowMs?: number; maxAgeS?: number } = {},
): InitData {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_RAW) throw new InitDataError('shape');
  if (!botToken) throw new InitDataError('no_token');

  const fields = new Map<string, string>();
  for (const [k, v] of new URLSearchParams(raw)) {
    if (fields.has(k)) throw new InitDataError('duplicate_key');
    fields.set(k, v);
  }
  const hash = fields.get('hash');
  if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) throw new InitDataError('hash');
  fields.delete('hash');

  const dataCheck = [...fields.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(dataCheck).digest();
  const given = Buffer.from(hash, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new InitDataError('signature');

  const authRaw = fields.get('auth_date');
  if (!authRaw || !/^\d{1,12}$/.test(authRaw)) throw new InitDataError('auth_date');
  const authDate = Number(authRaw);
  const nowS = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  if (authDate > nowS + FUTURE_SKEW_S) throw new InitDataError('auth_date_future');
  if (nowS - authDate > (opts.maxAgeS ?? INIT_DATA_MAX_AGE_S)) throw new InitDataError('expired');

  let user: unknown;
  try {
    user = JSON.parse(fields.get('user') ?? '');
  } catch {
    throw new InitDataError('user');
  }
  const u = user as Partial<InitUser> & { is_bot?: boolean };
  if (
    !u ||
    typeof u !== 'object' ||
    !Number.isSafeInteger(u.id) ||
    (u.id as number) <= 0 ||
    typeof u.first_name !== 'string'
  ) {
    throw new InitDataError('user');
  }
  if (u.is_bot === true) throw new InitDataError('bot');
  return {
    user: {
      id: u.id as number,
      first_name: u.first_name,
      last_name: typeof u.last_name === 'string' ? u.last_name : undefined,
      username: typeof u.username === 'string' ? u.username : undefined,
      language_code: typeof u.language_code === 'string' ? u.language_code : undefined,
    },
    authDate,
    startParam: fields.get('start_param'),
  };
}
