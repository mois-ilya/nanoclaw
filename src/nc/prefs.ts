import { nc, userIdOf } from './config.js';
import { getPrefs } from './store.js';

/** «Ночью не беспокоить» default window (ux §6), local time in the user's tz. */
export const DEFAULT_QUIET_FROM = '23:00';
export const DEFAULT_QUIET_TO = '08:00';

/** null = never set -> default window; '' = switched off in the Mini App. */
export function quietOf(p: {
  quiet_from: string | null;
  quiet_to: string | null;
}): { from: string; to: string } | null {
  if (p.quiet_from === '' || p.quiet_to === '') return null;
  return { from: p.quiet_from ?? DEFAULT_QUIET_FROM, to: p.quiet_to ?? DEFAULT_QUIET_TO };
}

/** For the adapter's final-answer logic (C4 step 5): per-chat display preferences. */
export async function getUserPrefs(chatId: number): Promise<{
  showSteps: boolean;
  lang: 'ru' | 'en';
  tz: string;
  quietHours: { from: string; to: string } | null;
}> {
  const p = await getPrefs(userIdOf(chatId), { tz: nc.defaultTz() });
  return { showSteps: p.show_steps, lang: p.lang, tz: p.tz, quietHours: quietOf(p) };
}
