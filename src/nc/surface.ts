/** Per-chat Telegram surface: menu button + command list (UX §4). */
import { nc } from './config.js';
import { tg } from './port.js';

const FRIEND_COMMANDS = [
  { command: 'menu', description: 'Кабинет' },
  { command: 'new', description: 'Новый разговор' },
  { command: 'stop', description: 'Остановить текущую задачу' },
  { command: 'tasks', description: 'Мои напоминания и задачи' },
  { command: 'help', description: 'Что я умею' },
];

const OWNER_EXTRA = [
  { command: 'friends', description: 'Друзья: статус и расход' },
  { command: 'guest', description: 'Гостевой контекст' },
  { command: 'health', description: 'Статус сервера' },
];

export async function setChatSurface(tgId: number, owner: boolean): Promise<void> {
  const api = tg.api();
  const url = nc.miniappUrl();
  if (url) {
    await api.setChatMenuButton({ chat_id: tgId, menu_button: { type: 'web_app', text: 'Кабинет', web_app: { url } } });
  }
  await api.setMyCommands(owner ? [...FRIEND_COMMANDS, ...OWNER_EXTRA] : FRIEND_COMMANDS, {
    scope: { type: 'chat', chat_id: tgId },
  });
}

/** Remove a deleted/paused user's chat-scoped surface. */
export async function clearChatSurface(tgId: number): Promise<void> {
  const api = tg.api();
  await api.setChatMenuButton({ chat_id: tgId, menu_button: { type: 'default' } });
  await api.setMyCommands([], { scope: { type: 'chat', chat_id: tgId } });
}

// ---------- bot profile (shown on the bot's page before /start) ----------

const DESCRIPTION_MAX = 512;
const SHORT_MAX = 120;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/** Russian description / short description from NC_BOT_NAME and NC_OWNER_NAME. */
export function botProfileTexts(): { description: string; short: string } {
  const gen = nc.ownerNameGen();
  const named = nc.botName() !== 'ассистент';
  const lead = named ? `${nc.botName()} — личный ассистент ${gen}.` : `Личный ассистент ${gen}.`;
  return {
    description: clip(
      `${lead} Доступ даёт ${nc.ownerName()} лично: напиши сюда — я передам запрос. Умею искать в интернете, работать с файлами и фото, помнить важное, ставить напоминания и понимать голосовые.`,
      DESCRIPTION_MAX,
    ),
    short: clip(
      named ? `${nc.botName()}: личный ассистент ${gen}` : `Личный ассистент ${gen}: поиск, файлы, напоминания`,
      SHORT_MAX,
    ),
  };
}

const sameCommands = (a: Array<{ command: string; description: string }>, b: typeof a): boolean =>
  a.length === b.length && a.every((c, i) => c.command === b[i].command && c.description === b[i].description);

/**
 * Idempotent (reads before writing, so a restart loop does not trip Telegram's limits): bot description, short
 * description, and the default-scope command list that every chat without its own list (pending / unknown users) sees.
 */
export async function syncBotProfile(): Promise<void> {
  const api = tg.api();
  const { description, short } = botProfileTexts();
  if ((await api.getMyDescription()).description !== description) await api.setMyDescription({ description });
  if ((await api.getMyShortDescription()).short_description !== short)
    await api.setMyShortDescription({ short_description: short });
  const current = await api.getMyCommands({ scope: { type: 'default' } });
  if (!sameCommands(current, FRIEND_COMMANDS)) await api.setMyCommands(FRIEND_COMMANDS, { scope: { type: 'default' } });
}
