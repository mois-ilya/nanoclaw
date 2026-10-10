/**
 * Adapter extension API (integration contract C1). The product module
 * (src/nc) registers its behaviour here; the adapter never imports it.
 */
import type { CallbackQuery, Message, Update } from '../botapi/index.js';
import type { ProductButton } from './sender.js';

export type { BotApi } from '../botapi/index.js';

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

/**
 * Shallow-merged over the inbound content the adapter built (so `text`,
 * `attachments`, ... can be replaced or extended). Never touches `senderId`.
 */
export type InboundContentPatch = Record<string, unknown>;

export type GateDecision =
  | { action: 'route' }
  | { action: 'handled' }
  | { action: 'route-with-content'; content: InboundContentPatch };

export type TranscribeResult =
  | { text: string; lang?: string; confidence?: number }
  | { error: 'too_long' | 'empty' | 'failed' | 'budget' };

export type PrivateGate = (ctx: PrivateUpdateCtx) => Promise<GateDecision>;
export type CommandHandler = (ctx: PrivateUpdateCtx, command: string, args: string) => Promise<boolean>;
export type ProductCallbackHandler = (q: CallbackQuery, data: string) => Promise<{ toast?: string } | void>;
export type Transcriber = (
  audio: Buffer,
  meta: { mime: string; durationS: number; userId: number },
) => Promise<TranscribeResult>;
export type GuestHandler = (msg: Message) => Promise<void>;
export type StopHandler = (t: { chatId: number; sessionId: string; turnId: string }) => Promise<void>;

export interface UserPrefsView {
  showSteps: boolean;
  /** «Ночью не беспокоить», "HH:MM" local time in `tz`. Absent/null = off. */
  quietHours?: { from: string; to: string } | null;
  /** IANA time zone of the user. */
  tz?: string;
}
/** W2 provides it; falls back to `getUserPrefs` exported by src/nc (see turns.ts). */
export type UserPrefsProvider = (chatId: number) => UserPrefsView | undefined | Promise<UserPrefsView | undefined>;
/** Returns (and consumes) a one-line note to append to the next final, e.g. the 80% budget line. */
export interface BudgetNoteView {
  text: string;
  /** e.g. {text: 'Подробнее', webApp: 'usage'} -> attached under the last part of the final. */
  button?: ProductButton;
}
export type BudgetNoteProvider = (
  chatId: number,
) => string | BudgetNoteView | null | undefined | Promise<string | BudgetNoteView | null | undefined>;

/** Mints a `p:*` task button token bound to (chat, series) — owned by the product module. */
export type TaskTokenProvider = (chatId: number, seriesId: string) => Promise<string>;

interface HookState {
  gate?: PrivateGate;
  command?: CommandHandler;
  productCallback?: ProductCallbackHandler;
  transcriber?: Transcriber;
  guest?: GuestHandler;
  stop?: StopHandler;
  prefs?: UserPrefsProvider;
  budgetNote?: BudgetNoteProvider;
  taskToken?: TaskTokenProvider;
}

const state: HookState = {};

export function setPrivateGate(fn: PrivateGate): void {
  state.gate = fn;
}
export function setCommandHandler(fn: CommandHandler): void {
  state.command = fn;
}
export function setProductCallbackHandler(fn: ProductCallbackHandler): void {
  state.productCallback = fn;
}
export function setTranscriber(fn: Transcriber): void {
  state.transcriber = fn;
}
export function setGuestHandler(fn: GuestHandler): void {
  state.guest = fn;
}
export function setStopHandler(fn: StopHandler): void {
  state.stop = fn;
}
export function setUserPrefsProvider(fn: UserPrefsProvider): void {
  state.prefs = fn;
}
export function setBudgetNoteProvider(fn: BudgetNoteProvider): void {
  state.budgetNote = fn;
}

export function setTaskTokenProvider(fn: TaskTokenProvider): void {
  state.taskToken = fn;
}

/** Adapter-internal accessors. */
export function getHooks(): Readonly<HookState> {
  return state;
}

/** Test helper: clear every registered hook. */
export function resetHooks(): void {
  for (const k of Object.keys(state) as Array<keyof HookState>) delete state[k];
}
