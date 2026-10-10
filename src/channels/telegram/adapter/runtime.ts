/** Assembled adapter state (one per process) + the product send API (contract C1). */
import { createHash } from 'crypto';

import { BotApi, TelegramError, type InputRichMessage, type Update } from '../botapi/index.js';
import { renderMarkdown } from '../render/index.js';
import { log } from '../../../log.js';
import { Scheduler } from './scheduler.js';
import { Sender, buildKeyboard, isForbidden, type ProductButton } from './sender.js';
import { CALLBACK_TTL_MS, type TgStore } from './store.js';
import { baseTurnId } from './format.js';
import { TurnManager, type TurnConfig } from './turns.js';
import { getHooks, type BudgetNoteView, type UserPrefsView } from './hooks.js';

export interface TelegramRuntime {
  api: BotApi;
  store: TgStore;
  sched: Scheduler;
  sender: Sender;
  turns: TurnManager;
  ownerId?: number;
  botUsername?: string;
  miniAppShortName?: string;
  /** NC_MINIAPP_URL: native web_app buttons when no BotFather main Mini App is configured. */
  miniAppUrl?: string;
  markBlocked(chatId: number, blocked: boolean): void;
}

export interface RuntimeOptions {
  api: BotApi;
  store: TgStore;
  ownerId?: number;
  botUsername?: string;
  miniAppShortName?: string;
  miniAppUrl?: string;
  turnCfg?: Partial<TurnConfig>;
  sched?: Scheduler;
}

/** Optional hook-less fallbacks into src/nc (resolved lazily, never a static dependency). */
let ncModule: Record<string, unknown> | null | undefined;
async function loadNc(): Promise<Record<string, unknown> | null> {
  if (ncModule !== undefined) return ncModule;
  try {
    const spec = '../../../nc/index.js';
    ncModule = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
  } catch {
    ncModule = null;
  }
  return ncModule;
}

function toNote(v: unknown): BudgetNoteView | null {
  if (!v) return null;
  if (typeof v === 'string') return { text: v };
  const o = v as BudgetNoteView;
  return typeof o.text === 'string' && o.text ? o : null;
}

export async function resolveBudgetNote(chatId: number): Promise<BudgetNoteView | null> {
  const h = getHooks().budgetNote;
  try {
    if (h) return toNote(await h(chatId));
    const fn = (await loadNc())?.consumeBudgetNote;
    if (typeof fn === 'function') return toNote(await (fn as (c: number) => unknown)(chatId));
  } catch (err) {
    log.warn('budget note provider failed', { err });
  }
  return null;
}

export async function resolvePrefs(chatId: number): Promise<UserPrefsView | undefined> {
  const h = getHooks().prefs;
  try {
    if (h) return await h(chatId);
    const fn = (await loadNc())?.getUserPrefs;
    if (typeof fn === 'function') {
      const p = (await (fn as (c: number) => unknown)(chatId)) as
        | (Partial<UserPrefsView> & { quiet?: UserPrefsView['quietHours'] })
        | undefined;
      if (p && typeof p.showSteps === 'boolean') {
        return { showSteps: p.showSteps, quietHours: p.quietHours ?? p.quiet ?? null, tz: p.tz };
      }
    }
  } catch (err) {
    log.warn('getUserPrefs failed', { err });
  }
  return undefined;
}

/** True when `now` falls inside the user's quiet-hours window (local time in `tz`). */
export function inQuietHours(prefs: UserPrefsView | undefined, now = Date.now()): boolean {
  const q = prefs?.quietHours;
  if (!q) return false;
  const parse = (s: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const from = parse(q.from);
  const to = parse(q.to);
  if (from === null || to === null || from === to) return false;
  let minutes: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: prefs?.tz || 'UTC',
    }).formatToParts(new Date(now));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    minutes = h * 60 + m;
  } catch {
    return false;
  }
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

export function createRuntime(o: RuntimeOptions): TelegramRuntime {
  const sched = o.sched ?? new Scheduler();
  const rt: TelegramRuntime = {
    api: o.api,
    store: o.store,
    sched,
    ownerId: o.ownerId,
    botUsername: o.botUsername,
    miniAppShortName: o.miniAppShortName,
    miniAppUrl: o.miniAppUrl ?? (process.env.NC_MINIAPP_URL || undefined),
    markBlocked(chatId, blocked) {
      o.store.setBlocked(chatId, blocked, Date.now()).catch((err: unknown) => log.warn('setBlocked failed', { err }));
    },
    sender: undefined as unknown as Sender,
    turns: undefined as unknown as TurnManager,
  };
  const onForbidden = (chatId: number) => {
    log.warn('Telegram chat blocked the bot', { chatId });
    rt.markBlocked(chatId, true);
  };
  rt.sender = new Sender({ api: o.api, sched, onForbidden });
  rt.turns = new TurnManager({
    api: o.api,
    sched,
    sender: rt.sender,
    store: o.store,
    cfg: { stopEnabled: process.env.NC_STOP_ENABLED === '1', ...o.turnCfg },
    onForbidden,
    getPrefs: resolvePrefs,
    getBudgetNote: resolveBudgetNote,
    buildKeyboard: (rows) => buildKeyboard(rows, rt.botUsername, rt.miniAppShortName, rt.miniAppUrl),
  });
  return rt;
}

let current: TelegramRuntime | undefined;
export function setRuntime(rt: TelegramRuntime | undefined): void {
  current = rt;
}
export function getRuntime(): TelegramRuntime | undefined {
  return current;
}

/**
 * Host-side session-terminal hook (container exited / was killed / host-sweep):
 * closes the session's active turn as failed and tells the user right away.
 * Safe to call when the adapter is not running.
 */
export function failTurnsForSession(sessionId: string, opts?: { quiet?: boolean }): void {
  current?.turns.failTurnsForSession(sessionId, opts);
}

// ---- product-callback helpers (used by src/nc through the port) ------------

/** Callback-store key of the prompt behind a turn's [Повторить]. */
export function retryKey(turnId: string): string {
  return `rty_${createHash('sha1').update(baseTurnId(turnId)).digest('hex').slice(0, 12)}`;
}

/** Remember what the user sent for a turn, so [Повторить] can run it again. */
export async function saveRetryPrompt(store: TgStore, chatId: number, turnId: string, text: string): Promise<void> {
  if (!text.trim()) return;
  const now = Date.now();
  await store.saveCallback({
    short_id: retryKey(turnId),
    question_id: 'retry',
    value: text.slice(0, 20_000),
    chat_id: chatId,
    created_at: now,
    expires_at: now + CALLBACK_TTL_MS,
  });
}

/** The user's original prompt for a failed turn; undefined when unknown, expired or not this chat's. */
export async function retryPrompt(chatId: number, turnId: string): Promise<string | undefined> {
  const row = await current?.store.getCallback(retryKey(turnId));
  return row && row.chat_id === chatId && row.question_id === 'retry' && row.expires_at > Date.now()
    ? row.value
    : undefined;
}

/** The value behind a `p:<op>:<shortId>` button of this chat (suggested replies etc.). */
export async function buttonValue(chatId: number, shortId: string, kind: string): Promise<string | undefined> {
  const row = await current?.store.getCallback(shortId);
  return row && row.chat_id === chatId && row.question_id === kind && row.expires_at > Date.now()
    ? row.value
    : undefined;
}

/** Drop the inline keyboard of a message (a button was used; it must not be tapped twice). */
export async function clearButtons(chatId: number, messageId: number): Promise<void> {
  const rt = need();
  await rt.sched
    .enqueue(chatId, { prio: 'product', spaced: false }, () =>
      rt.api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    )
    .catch((err: unknown) => log.debug('clearButtons failed', { chatId, messageId, err }));
}

let replayHandler: ((update: Update) => Promise<void>) | undefined;
export function setReplayHandler(fn: ((update: Update) => Promise<void>) | undefined): void {
  replayHandler = fn;
}

/**
 * Feed a stored private update (retained before approval) through the normal ingress:
 * download, transcribe, 👀 / typing and onInbound. Bypasses the duplicate filter on purpose.
 */
export async function replayPrivateUpdate(update: Update): Promise<void> {
  if (!replayHandler) throw new Error('Telegram adapter is not running');
  await replayHandler(update);
}

function need(): TelegramRuntime {
  if (!current) throw new Error('Telegram adapter is not running');
  return current;
}

// ---- product send API ------------------------------------------------------

export function api(): BotApi {
  return need().api;
}

export async function sendProduct(
  chatId: number,
  md: string,
  opts: { buttons?: ProductButton[][]; silent?: boolean; replyTo?: number } = {},
): Promise<{ messageId: number }> {
  const rt = need();
  const markup = buildKeyboard(opts.buttons, rt.botUsername, rt.miniAppShortName, rt.miniAppUrl);
  const ids = await rt.sender.sendMarkdown(chatId, md, {
    prio: 'product',
    silent: opts.silent,
    replyTo: opts.replyTo,
    markup,
  });
  return { messageId: ids[0] ?? 0 };
}

/** Edits the first rendered part. Omitting `buttons` removes any keyboard. A no-op edit is not an error. */
export async function editProduct(
  chatId: number,
  messageId: number,
  md: string,
  opts: { buttons?: ProductButton[][] } = {},
): Promise<void> {
  const rt = need();
  const r = renderMarkdown(md);
  const msg: InputRichMessage | undefined = r.messages[0];
  const markup = buildKeyboard(opts.buttons, rt.botUsername, rt.miniAppShortName, rt.miniAppUrl);
  await editRich(rt, chatId, messageId, msg, r.plainFallback[0], markup);
}

export async function editRich(
  rt: TelegramRuntime,
  chatId: number,
  messageId: number,
  msg: InputRichMessage | undefined,
  plain: string | undefined,
  markup: ReturnType<typeof buildKeyboard>,
): Promise<void> {
  if (!msg && !plain) return;
  try {
    await rt.sched.enqueue(chatId, { prio: 'product' }, () =>
      rt.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        ...(msg ? { rich_message: msg } : { text: plain! }),
        ...(markup ? { reply_markup: markup } : {}),
      }),
    );
  } catch (e) {
    if (e instanceof TelegramError) {
      if (e.kind === 'bad_request' && /not modified/i.test(e.description)) return;
      if (e.kind === 'bad_request' && msg && plain) {
        // Markup rejected: retry once as plain text.
        await rt.sched.enqueue(chatId, { prio: 'product' }, () =>
          rt.api.editMessageText({
            chat_id: chatId,
            message_id: messageId,
            text: plain,
            ...(markup ? { reply_markup: markup } : {}),
          }),
        );
        return;
      }
      if (isForbidden(e)) rt.markBlocked(chatId, true);
      if (e.uncertain) {
        log.warn('Telegram edit outcome uncertain; treating as applied', { chatId, messageId });
        return;
      }
    }
    throw e;
  }
}

export async function react(chatId: number, messageId: number, emoji: string | null): Promise<void> {
  const rt = need();
  await rt.sched.enqueue(chatId, { prio: 'product', spaced: false }, () =>
    rt.api.setMessageReaction({
      chat_id: chatId,
      message_id: messageId,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }),
  );
}

export function deliveryKey(chatId: number, content: unknown): string {
  return `${chatId}:${createHash('sha1')
    .update(JSON.stringify(content) ?? '')
    .digest('hex')}`;
}
