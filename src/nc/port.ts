/**
 * Local declarations of the Telegram adapter's extension API (integration
 * contract C1, owned by W1: `src/channels/telegram/adapter/hooks.ts`).
 *
 * The product module codes against these interfaces only. `bindAdapter()` in
 * `bind.ts` connects them to W1's real exports at runtime; tests inject fakes.
 */
import type { BotApi, CallbackQuery, Message, Update } from '../channels/telegram/botapi/index.js';

export interface TgUser {
  id: number;
  firstName: string;
  lastName?: string;
  username?: string;
  languageCode?: string;
}

export interface PrivateUpdateCtx {
  update: Update;
  user: TgUser;
  chatId: number;
  message?: Message;
  kind: 'text' | 'voice' | 'media' | 'command' | 'other';
}

export interface InboundContentPatch {
  text?: string;
  [k: string]: unknown;
}

export type GateDecision =
  | { action: 'route' }
  | { action: 'handled' }
  | { action: 'route-with-content'; content: InboundContentPatch };

export type TranscribeResult =
  | { text: string; lang?: string; confidence?: number }
  | { error: 'too_long' | 'empty' | 'failed' | 'budget' };

export interface AdapterHooks {
  setPrivateGate(fn: (ctx: PrivateUpdateCtx) => Promise<GateDecision>): void;
  setCommandHandler(fn: (ctx: PrivateUpdateCtx, command: string, args: string) => Promise<boolean>): void;
  setProductCallbackHandler(fn: (q: CallbackQuery, data: string) => Promise<{ toast?: string } | void>): void;
  setTranscriber(
    fn: (audio: Buffer, meta: { mime: string; durationS: number; userId: number }) => Promise<TranscribeResult>,
  ): void;
  setGuestHandler(fn: (msg: Message) => Promise<void>): void;
  setStopHandler(fn: (t: { chatId: number; sessionId: string; turnId: string }) => Promise<void>): void;
}

export interface ProductButton {
  text: string;
  /** 'p:...' <= 64 bytes */
  data?: string;
  url?: string;
  /** startapp param -> Mini App deep link */
  webApp?: string;
}

export interface AdapterSend {
  sendProduct(
    chatId: number,
    md: string,
    opts?: { buttons?: ProductButton[][]; silent?: boolean; replyTo?: number },
  ): Promise<{ messageId: number }>;
  editProduct(chatId: number, messageId: number, md: string, opts?: { buttons?: ProductButton[][] }): Promise<void>;
  react(chatId: number, messageId: number, emoji: string | null): Promise<void>;
  api(): BotApi;
  /**
   * Optional: feed a stored private update back through the adapter's normal ingress (download, transcribe,
   * onInbound). Present once the adapter exports `replayPrivateUpdate`.
   */
  replay?(update: Update): Promise<void>;
  /** Optional: the user's original prompt of a failed turn (for [Повторить]); undefined when unknown. */
  retryPrompt?(chatId: number, turnId: string): Promise<string | undefined>;
  /** Optional: the value behind a `p:<op>:<shortId>` button (suggested replies). */
  buttonValue?(chatId: number, shortId: string, kind: string): Promise<string | undefined>;
  /** Optional: remove the inline keyboard from a message. */
  clearButtons?(chatId: number, messageId: number): Promise<void>;
  /** Optional: whether a turn is in flight for this private chat (live state of the adapter's turn manager). */
  hasActiveTurn?(chatId: number): boolean | undefined;
}

let send: AdapterSend | null = null;

/** Set by bind.ts (or by tests). */
export function setAdapterSend(next: AdapterSend | null): void {
  send = next;
}

function need(): AdapterSend {
  if (!send) throw new Error('nc: Telegram adapter send API is not bound');
  return send;
}

/** Late-bound facade over W1's product send API. */
export const tg: AdapterSend = {
  sendProduct: (c, md, o) => need().sendProduct(c, md, o),
  editProduct: (c, m, md, o) => need().editProduct(c, m, md, o),
  react: (c, m, e) => need().react(c, m, e),
  api: () => need().api(),
  replay: (u) => {
    const r = need().replay;
    if (!r) return Promise.reject(new Error('replay_unsupported'));
    return r.call(need(), u);
  },
};

export const retryPrompt = (chatId: number, turnId: string): Promise<string | undefined> =>
  send?.retryPrompt ? send.retryPrompt(chatId, turnId) : Promise.resolve(undefined);
export const buttonValue = (chatId: number, shortId: string, kind: string): Promise<string | undefined> =>
  send?.buttonValue ? send.buttonValue(chatId, shortId, kind) : Promise.resolve(undefined);
export const clearButtons = (chatId: number, messageId: number): Promise<void> =>
  send?.clearButtons ? send.clearButtons(chatId, messageId).catch(() => undefined) : Promise.resolve();

/** Whether the adapter can replay a stored update through its own pipeline. */
export function canReplay(): boolean {
  return send?.replay !== undefined;
}

/** True/false when the adapter can tell, undefined when it cannot. */
export function activeTurn(chatId: number): boolean | undefined {
  return send?.hasActiveTurn?.(chatId);
}

export function adapterBound(): boolean {
  return send !== null;
}
