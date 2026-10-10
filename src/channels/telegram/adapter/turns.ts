/**
 * Turn UX (contract C4): 👀 reaction + typing on accept, a draft after 2.5 s,
 * a silent status card after 45 s, the final with «Что я сделал», then the
 * cleanup (reaction off, card → «Готово», draft dropped). Everything leaves
 * through the per-chat scheduler, so ordering and rate limits are one policy.
 */
import { TelegramError, type BotApi, type InputRichBlock, type InputRichMessage } from '../botapi/index.js';
import { appendDetails, renderStreamingPreview } from '../render/index.js';
import { log } from '../../../log.js';
import { COPY } from './copy.js';
import { baseTurnId, draftIdFor, escapeMd, fmtClock, fmtDuration, messageIdFromTurnId, stepsWord } from './format.js';
import type { BudgetNoteView, UserPrefsView } from './hooks.js';
import { isForbidden, type ProductButton, type Sender } from './sender.js';
import type { Scheduler } from './scheduler.js';
import type { TgStore, VoiceEcho } from './store.js';
import type { InlineKeyboardMarkup } from '../botapi/index.js';

export interface TurnConfig {
  /** NC_STOP_ENABLED=1: show the native Stop button on drafts. */
  stopEnabled: boolean;
  draftDelayMs: number;
  draftThrottleMs: number;
  heartbeatMs: number;
  statusDelayMs: number;
  statusEditMinMs: number;
  detailsMinSteps: number;
  detailsMinMs: number;
  notifyAfterMs: number;
  maxVisibleSteps: number;
  /** No runner event / delivery for this long -> the turn is considered dead (§2.9). */
  idleTimeoutMs: number;
  /** A tool step still 'running' keeps the turn alive this long from its start (the runner has its own turn limit). */
  runningStepGraceMs: number;
  /** A pending question card keeps the turn alive this long. */
  questionGraceMs: number;
}

export const DEFAULT_TURN_CONFIG: TurnConfig = {
  stopEnabled: false,
  draftDelayMs: 2500,
  draftThrottleMs: 700,
  heartbeatMs: 15_000,
  statusDelayMs: 45_000,
  statusEditMinMs: 5000,
  detailsMinSteps: 3,
  detailsMinMs: 20_000,
  notifyAfterMs: 90_000,
  maxVisibleSteps: 8,
  idleTimeoutMs: 5 * 60_000,
  runningStepGraceMs: 40 * 60_000,
  questionGraceMs: 2 * 60 * 60_000,
};

export interface Step {
  id: string;
  label: string;
  state: 'running' | 'done' | 'failed';
  ms?: number;
}

export type CloseReason = 'final' | 'finished' | 'cancelled' | 'failed' | 'superseded';

/** A file waiting for the turn's answer text to go out first (§2.5: answer, then files). */
export interface PendingFile {
  filename: string;
  data: Buffer;
  caption?: string;
}

/** The last message a turn delivered; «Что я сделал» is attached to it when the turn finishes. */
export interface LastOut {
  messageId: number;
  /** Rendered last part, as sent (no details yet). */
  message: InputRichMessage;
  markup?: InlineKeyboardMarkup;
}

export interface Turn {
  chatId: number;
  turnId: string;
  sessionId: string;
  startedAt: number;
  draftId: number;
  steps: Map<string, Step>;
  previewText: string;
  lastPreviewSeq: number;
  lastProgressSeq: number;
  /** User messages carrying 👀 when this turn started. */
  ackIds: number[];
  closed: boolean;
  draftActive: boolean;
  draftsDisabled: boolean;
  draftPersisted: boolean;
  lastDraftAt: number;
  draftStartTimer?: ReturnType<typeof setTimeout>;
  draftTimer?: ReturnType<typeof setTimeout>;
  heartbeatTimer?: ReturnType<typeof setTimeout>;
  statusStartTimer?: ReturnType<typeof setTimeout>;
  statusEditTimer?: ReturnType<typeof setTimeout>;
  statusSend?: Promise<number | undefined>;
  statusMessageId?: number;
  statusLastEditAt: number;
  statusDirty: boolean;
  statusEditInFlight: boolean;
  pendingFiles: PendingFile[];
  lastOut?: LastOut;
  /** Something user-visible was delivered while the turn was open. */
  delivered: boolean;
  /** The final went out inline (details already attached). */
  inlineFinal: boolean;
  noticed: boolean;
  /** An ask_user_question card is waiting for the user (the runner is silent meanwhile). */
  questionSince?: number;
  /** Text of the last interim message delivered: a late preview of it must not come back into the draft. */
  lastDeliveredText?: string;
  idleTimer?: ReturnType<typeof setTimeout>;
  echoLoaded?: Promise<VoiceEcho[]>;
}

export interface FinalContext {
  chatId: number;
  turn?: Turn;
  elapsedMs: number;
  silent?: boolean;
  details?: { summary: string; body: string };
}

export interface TurnDeps {
  api: BotApi;
  sched: Scheduler;
  sender: Sender;
  store: TgStore;
  cfg?: Partial<TurnConfig>;
  onForbidden?: (chatId: number) => void;
  getPrefs?: (chatId: number) => Promise<UserPrefsView | undefined> | UserPrefsView | undefined;
  /** Returns (and consumes) the budget note for the next final. */
  getBudgetNote?: (chatId: number) => Promise<BudgetNoteView | null>;
  buildKeyboard?: (rows: ProductButton[][]) => InlineKeyboardMarkup | undefined;
}

export type FileSender = (chatId: number, files: PendingFile[]) => Promise<void>;

/** «🎤 Расшифровка: «…»» block(s) for the top of the reply (ux §2.4). */
export function echoBlocks(echoes: VoiceEcho[]): InputRichBlock[] {
  return echoes.map((e): InputRichBlock => {
    const icon = e.kind === 'video_note' ? '🎥' : e.kind === 'audio' ? '🎧' : '🎤';
    const text = `${icon} ${COPY.echoVoice}: «${e.transcript.trim()}»`;
    return e.transcript.length > 60
      ? { type: 'expandable_blockquote', text }
      : { type: 'blockquote', blocks: [{ type: 'paragraph', text }] };
  });
}

const FINISHED_MEMORY = 300;
const ACK_TTL_MS = 30 * 60 * 1000;

export class TurnManager {
  private readonly cfg: TurnConfig;
  private readonly active = new Map<number, Turn>();
  private readonly acks = new Map<number, Map<number, number>>(); // chat -> messageId -> at
  private readonly finished: string[] = [];
  private readonly finishedSet = new Set<string>();
  private readonly voices = new Map<string, VoiceEcho[]>();
  private fileSender?: FileSender;

  constructor(private readonly d: TurnDeps) {
    this.cfg = { ...DEFAULT_TURN_CONFIG, ...d.cfg };
  }

  setFileSender(fn: FileSender): void {
    this.fileSender = fn;
  }

  // ---- ingress side ------------------------------------------------------

  /** Transcript(s) of a voice/video note/audio inbound; shown atop the reply for that turn (ux §2.4). */
  async noteVoice(chatId: number, messageId: number, echoes: VoiceEcho[]): Promise<void> {
    if (echoes.length === 0) return;
    this.voices.set(`${chatId}:${messageId}`, echoes);
    await this.d.store
      .saveVoice(chatId, messageId, echoes, Date.now())
      .catch((err: unknown) => log.warn('saveVoice failed', { err }));
  }

  /** Echo for the turn's inbound message, once. */
  async takeEcho(t: Turn): Promise<VoiceEcho[]> {
    const mid = messageIdFromTurnId(t.turnId);
    if (mid === null) return [];
    const key = `${t.chatId}:${mid}`;
    const mem = this.voices.get(key);
    if (mem) {
      this.voices.delete(key);
      await this.d.store.takeVoice(t.chatId, mid).catch(() => undefined);
      return mem;
    }
    return (await this.d.store.takeVoice(t.chatId, mid).catch(() => undefined)) ?? [];
  }

  activeTurn(chatId: number): Turn | undefined {
    const t = this.active.get(chatId);
    return t && !t.closed ? t : undefined;
  }

  hasActiveTurn(chatId: number): boolean {
    return !!this.activeTurn(chatId);
  }

  /** Stop was requested: drafts must not come back while the runner winds down. */
  disableDrafts(chatId: number): void {
    const t = this.active.get(chatId);
    if (!t || t.closed) return;
    t.draftsDisabled = true;
    for (const timer of [t.draftStartTimer, t.draftTimer, t.heartbeatTimer]) if (timer) clearTimeout(timer);
    t.draftStartTimer = t.draftTimer = t.heartbeatTimer = undefined;
    this.d.sched.cancel(chatId, 'draft');
  }

  /** The agent reacted to this user message itself (👍 = silent action done): keep it. */
  noteAgentReaction(chatId: number, messageId: number): void {
    this.acks.get(chatId)?.delete(messageId);
    const t = this.active.get(chatId);
    if (t) t.ackIds = t.ackIds.filter((id) => id !== messageId);
  }

  /** The container of this session is gone (exit, OOM, kill, pause): fail its open turn at once. */
  failTurnsForSession(sessionId: string, opts?: { quiet?: boolean }): void {
    for (const t of [...this.active.values()]) {
      if (t.sessionId !== sessionId || t.closed) continue;
      this.close(t, 'failed');
      // quiet: the host retries the same batch, which carries the same turnId — it must be able to start again.
      if (opts?.quiet) this.forgetFinished(t.turnId);
      // quiet: the host retries the batch once or says «не смог обработать» itself (single owner of the copy).
      if (!opts?.quiet) this.notifyFailure(t);
    }
  }

  /** Delivery bookkeeping for a chat row that belongs to an open turn (interim message). */
  noteInterim(t: Turn, out?: LastOut, deliveredText?: string): void {
    t.delivered = true;
    if (out) t.lastOut = out;
    // The draft showed this text as the preview; it is a real message now. The runner sends no empty
    // preview when a <message> block closes, so drop it here or the draft repeats what was just sent.
    t.previewText = '';
    if (deliveredText?.trim()) t.lastDeliveredText = deliveredText.trim();
    this.armIdle(t);
    // A real message makes Telegram drop the draft: bring it back (after a beat: this may be the final).
    if (t.draftActive && !t.draftsDisabled && !t.draftTimer) {
      t.draftTimer = setTimeout(() => {
        t.draftTimer = undefined;
        this.requestDraft(t);
      }, 1500);
    }
  }

  queueFile(t: Turn, f: PendingFile): void {
    t.pendingFiles.push(f);
  }

  /** An ask_user_question card went out: the runner is silent until the user answers — not a dead turn. */
  noteQuestion(chatId: number): void {
    const t = this.active.get(chatId);
    if (!t || t.closed) return;
    t.questionSince = Date.now();
    this.armIdle(t);
  }

  /** The user answered the card (or it was resolved): the idle clock runs normally again. */
  noteQuestionAnswered(chatId: number): void {
    const t = this.active.get(chatId);
    if (!t || t.closed) return;
    t.questionSince = undefined;
    this.armIdle(t);
  }

  /** 👀 + typing immediately; both skip the spacing so the user sees life at once. */
  noteInbound(chatId: number, messageId: number): void {
    const now = Date.now();
    let m = this.acks.get(chatId);
    if (!m) {
      m = new Map();
      this.acks.set(chatId, m);
    }
    for (const [id, at] of m) if (now - at > ACK_TTL_MS) m.delete(id);
    m.set(messageId, now);
    this.fire(
      this.d.sched.enqueue(chatId, { prio: 'final', spaced: false }, () =>
        this.d.api.setMessageReaction({
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: 'emoji', emoji: '👀' }],
        }),
      ),
      'ack reaction',
      chatId,
    );
    this.sendTyping(chatId);
  }

  /** Clear the 👀 of a message without waiting for a turn (e.g. media rejected). */
  releaseInbound(chatId: number, messageId: number): void {
    this.acks.get(chatId)?.delete(messageId);
    this.clearReactions(chatId, [messageId]);
  }

  hasActiveDraft(chatId: number): boolean {
    const t = this.active.get(chatId);
    return !!t && !t.closed && t.draftActive;
  }

  sendTyping(chatId: number): void {
    if (this.hasActiveDraft(chatId)) return;
    this.fire(
      this.d.sched.enqueue(chatId, { prio: 'draft', spaced: false, key: 'typing' }, () =>
        this.d.api.sendChatAction({ chat_id: chatId, action: 'typing' }),
      ),
      'typing',
      chatId,
    );
  }

  // ---- runner events -----------------------------------------------------

  onTurn(e: {
    chatId: number;
    turnId: string;
    sessionId: string;
    state: 'started' | 'finished' | 'cancelled' | 'failed';
  }): void {
    if (e.state === 'started') {
      this.start(e.chatId, e.turnId, e.sessionId);
      return;
    }
    const t = this.active.get(e.chatId);
    if (t && t.turnId === e.turnId) {
      this.close(t, e.state);
      return;
    }
    if (this.finishedSet.has(e.turnId)) return;
    // Terminal event for a turn we never saw (restart): just release the 👀s.
    if (!t) {
      this.clearAllAcks(e.chatId);
      const mid = messageIdFromTurnId(e.turnId);
      if (mid !== null) this.clearReactions(e.chatId, [mid]);
    }
  }

  onPreview(e: { chatId: number; turnId: string; sessionId: string; seq: number; text: string }): void {
    const t = this.ensure(e.chatId, e.turnId, e.sessionId);
    if (!t || e.seq <= t.lastPreviewSeq) return;
    this.armIdle(t);
    t.lastPreviewSeq = e.seq;
    // A throttled preview of a block that was already delivered can trail its chat row.
    if (t.lastDeliveredText !== undefined && e.text.trim() === t.lastDeliveredText) return;
    t.previewText = e.text;
    this.requestDraft(t);
  }

  onProgress(e: { chatId: number; turnId: string; sessionId: string; seq: number; step: Step }): void {
    const t = this.ensure(e.chatId, e.turnId, e.sessionId);
    if (!t || e.seq <= t.lastProgressSeq) return;
    this.armIdle(t);
    t.lastProgressSeq = e.seq;
    // «Модель перегружена, пробую снова…» is a transient notice, not a step of the work.
    if (e.step.id === 'api-retry' && e.step.state !== 'running') t.steps.delete(e.step.id);
    else {
      const prev = t.steps.get(e.step.id);
      t.steps.set(e.step.id, { ...prev, ...e.step });
    }
    this.requestDraft(t);
    this.scheduleStatusEdit(t);
  }

  /** Active turn for a stopped_message_generation update (memory first). */
  turnForDraft(chatId: number, draftId: number): { sessionId: string; turnId: string } | undefined {
    const t = this.active.get(chatId);
    if (t && !t.closed && t.draftId === draftId) return { sessionId: t.sessionId, turnId: t.turnId };
    return undefined;
  }

  // ---- final -------------------------------------------------------------

  async beginFinal(chatId: number, opts: { failure?: boolean } = {}): Promise<FinalContext> {
    const turn = this.active.get(chatId);
    const ctx: FinalContext = { chatId, turn, elapsedMs: turn ? Date.now() - turn.startedAt : 0 };
    if (!turn || opts.failure) return ctx;
    ctx.details = await this.computeDetails(turn);
    if (ctx.elapsedMs > this.cfg.notifyAfterMs) ctx.silent = false;
    return ctx;
  }

  private async computeDetails(turn: Turn): Promise<FinalContext['details']> {
    const elapsedMs = Date.now() - turn.startedAt;
    const steps = [...turn.steps.values()];
    let showSteps = true;
    try {
      showSteps = (await this.d.getPrefs?.(turn.chatId))?.showSteps ?? true;
    } catch (err) {
      log.warn('getUserPrefs failed; defaulting showSteps', { err });
    }
    if (
      showSteps &&
      steps.length > 0 &&
      (steps.length >= this.cfg.detailsMinSteps || elapsedMs > this.cfg.detailsMinMs)
    ) {
      return {
        summary: `Что я сделал (${stepsWord(steps.length)}, ${fmtDuration(elapsedMs)})`,
        body: steps
          .map((s) => {
            const tail = s.state === 'failed' ? ' — не удалось' : s.ms !== undefined ? ` (${fmtDuration(s.ms)})` : '';
            return `- ${escapeMd(s.label)}${tail}`;
          })
          .join('\n'),
      };
    }
    return undefined;
  }

  /** Details block as a decorator for Sender.sendMarkdown. */
  detailsDecorator(
    ctx: FinalContext,
    note?: string | null,
    echo?: VoiceEcho[],
  ): (m: InputRichMessage[]) => InputRichMessage[] {
    return (messages) => {
      const out = [...messages];
      if (echo?.length) out[0] = { ...out[0], blocks: [...echoBlocks(echo), ...(out[0].blocks ?? [])] };
      let last = out[out.length - 1];
      if (ctx.details) last = appendDetails(last, ctx.details.summary, ctx.details.body);
      if (note) last = { ...last, blocks: [...(last.blocks ?? []), { type: 'footer', text: note }] };
      out[out.length - 1] = last;
      return out;
    };
  }

  /** Call after Telegram confirmed the final. */
  endFinal(ctx: FinalContext, reason: 'final' | 'failed' | 'cancelled' = 'final'): void {
    if (ctx.turn && !ctx.turn.closed) {
      ctx.turn.inlineFinal = true;
      this.close(ctx.turn, reason);
    } else if (!ctx.turn) this.clearAllAcks(ctx.chatId);
  }

  // ---- watchdog / failure ------------------------------------------------

  /**
   * Silence is not death: a question card waits for a human, and one Bash/browser step can run for
   * minutes without any runner event. Those defer the watchdog (bounded); a crashed container is
   * caught by failTurnsForSession, the runner's own turn limit by its timeout notice.
   */
  private idleDeferred(t: Turn, now: number): boolean {
    if (t.questionSince !== undefined && now - t.questionSince < this.cfg.questionGraceMs) return true;
    for (const s of t.steps.values()) {
      if (s.state === 'running' && now - t.startedAt < this.cfg.runningStepGraceMs) return true;
    }
    return false;
  }

  private armIdle(t: Turn): void {
    if (t.closed) return;
    if (t.idleTimer) clearTimeout(t.idleTimer);
    t.idleTimer = setTimeout(() => {
      t.idleTimer = undefined;
      if (t.closed) return;
      if (this.idleDeferred(t, Date.now())) {
        this.armIdle(t);
        return;
      }
      log.warn('Turn idle too long; closing', { chatId: t.chatId, turnId: t.turnId, delivered: t.delivered });
      if (t.delivered) {
        this.close(t, 'finished'); // an answer went out; the terminal event just never came
        return;
      }
      this.close(t, 'failed');
      this.notifyFailure(t);
    }, this.cfg.idleTimeoutMs);
    t.idleTimer.unref?.();
  }

  /** §2.9 «Что-то сломалось…» + [Повторить], without waiting for the runner. */
  private notifyFailure(t: Turn): void {
    if (t.noticed) return;
    t.noticed = true;
    const markup = this.d.buildKeyboard?.([[{ text: COPY.retry, data: `p:rty:${baseTurnId(t.turnId)}` }]]);
    void (async () => {
      const echo = await this.takeEcho(t).catch(() => []);
      await this.d.sender.sendMarkdown(t.chatId, COPY.failGeneric, {
        prio: 'final',
        markup,
        decorate: echo.length
          ? (ms) => [{ ...ms[0], blocks: [...echoBlocks(echo), ...(ms[0].blocks ?? [])] }, ...ms.slice(1)]
          : undefined,
      });
    })().catch((err: unknown) => log.warn('failure notice failed', { chatId: t.chatId, err }));
  }

  /** On finish: «Что я сделал» + budget note go onto the last message the turn delivered. */
  private async finishDeferred(t: Turn, how: CloseReason): Promise<void> {
    const out = t.lastOut;
    if (out && !t.inlineFinal && (how === 'finished' || how === 'cancelled')) {
      const details = await this.computeDetails(t);
      const note = how === 'finished' ? await this.d.getBudgetNote?.(t.chatId).catch(() => null) : null;
      if (details || note) {
        let msg = out.message;
        if (details) msg = appendDetails(msg, details.summary, details.body);
        if (note) msg = { ...msg, blocks: [...(msg.blocks ?? []), { type: 'footer', text: note.text }] };
        const markup = note?.button ? (this.d.buildKeyboard?.([[note.button]]) ?? out.markup) : out.markup;
        try {
          await this.d.sched.enqueue(t.chatId, { prio: 'final', maxRateRetries: 3 }, () =>
            this.d.api.editMessageText({
              chat_id: t.chatId,
              message_id: out.messageId,
              rich_message: msg,
              ...(markup ? { reply_markup: markup } : {}),
            }),
          );
        } catch (err) {
          if (isForbidden(err)) this.d.onForbidden?.(t.chatId);
          else {
            log.warn('details edit failed; sending a small reply', { chatId: t.chatId, err });
            const tail = msg.blocks?.slice(out.message.blocks?.length ?? 0) ?? [];
            if (tail.length) {
              await this.d.sched
                .enqueue(t.chatId, { prio: 'final' }, () =>
                  this.d.api.sendRichMessage({
                    chat_id: t.chatId,
                    rich_message: { blocks: tail },
                    reply_parameters: { message_id: out.messageId, allow_sending_without_reply: true },
                  }),
                )
                .catch((e2: unknown) => log.warn('details reply failed', { e2 }));
            }
          }
        }
      }
    }
    if (t.pendingFiles.length && this.fileSender) {
      const files = t.pendingFiles;
      t.pendingFiles = [];
      await this.fileSender(t.chatId, files);
    }
  }

  // ---- internals ---------------------------------------------------------

  private start(chatId: number, turnId: string, sessionId: string): Turn | undefined {
    const existing = this.active.get(chatId);
    if (existing && existing.turnId === turnId) return existing;
    if (this.finishedSet.has(turnId)) return undefined;
    if (existing) this.close(existing, 'superseded');
    const t: Turn = {
      chatId,
      turnId,
      sessionId,
      startedAt: Date.now(),
      draftId: draftIdFor(turnId),
      steps: new Map(),
      previewText: '',
      lastPreviewSeq: 0,
      lastProgressSeq: 0,
      ackIds: [...(this.acks.get(chatId)?.keys() ?? [])],
      pendingFiles: [],
      delivered: false,
      inlineFinal: false,
      noticed: false,
      closed: false,
      draftActive: false,
      draftsDisabled: false,
      draftPersisted: false,
      lastDraftAt: -Infinity,
      statusLastEditAt: -Infinity,
      statusDirty: false,
      statusEditInFlight: false,
    };
    // turnId is the inbound row id: after a host restart the 👀 can still be found and cleared.
    const mid = messageIdFromTurnId(turnId);
    if (mid !== null && !t.ackIds.includes(mid)) t.ackIds.push(mid);
    this.active.set(chatId, t);
    this.armIdle(t);
    t.draftStartTimer = setTimeout(() => this.startDraft(t), this.cfg.draftDelayMs);
    t.statusStartTimer = setTimeout(() => this.showStatus(t), this.cfg.statusDelayMs);
    return t;
  }

  /** Lenient: a preview/progress for an unseen turn starts it (e.g. after a host restart). */
  private ensure(chatId: number, turnId: string, sessionId: string): Turn | undefined {
    const t = this.active.get(chatId);
    if (t && t.turnId === turnId) return t.closed ? undefined : t;
    if (this.finishedSet.has(turnId)) return undefined;
    return this.start(chatId, turnId, sessionId);
  }

  private startDraft(t: Turn): void {
    t.draftStartTimer = undefined;
    if (t.closed || t.draftsDisabled) return;
    t.draftActive = true;
    if (!t.draftPersisted) {
      t.draftPersisted = true;
      this.d.store
        .saveDraft({
          chat_id: t.chatId,
          draft_id: t.draftId,
          turn_id: t.turnId,
          session_id: t.sessionId,
          status_message_id: null,
          created_at: Date.now(),
          closed_at: null,
        })
        .catch((err: unknown) => log.warn('saveDraft failed', { err }));
    }
    this.requestDraft(t);
  }

  private requestDraft(t: Turn): void {
    if (t.closed || !t.draftActive || t.draftsDisabled || t.draftTimer) return;
    const wait = t.lastDraftAt + this.cfg.draftThrottleMs - Date.now();
    if (wait > 0) {
      t.draftTimer = setTimeout(() => {
        t.draftTimer = undefined;
        this.sendDraft(t);
      }, wait);
      return;
    }
    this.sendDraft(t);
  }

  private sendDraft(t: Turn): void {
    if (t.closed || t.draftsDisabled) return;
    t.lastDraftAt = Date.now();
    if (t.heartbeatTimer) clearTimeout(t.heartbeatTimer);
    t.heartbeatTimer = setTimeout(() => {
      t.heartbeatTimer = undefined;
      this.requestDraft(t);
    }, this.cfg.heartbeatMs);
    const p = this.d.sched.enqueue(t.chatId, { prio: 'draft', key: 'draft', maxRateRetries: 1 }, async () => {
      if (t.closed || t.draftsDisabled) return;
      await this.d.api.sendRichMessageDraft({
        chat_id: t.chatId,
        draft_id: t.draftId,
        rich_message: { blocks: this.draftBlocks(t) },
        ...(this.cfg.stopEnabled ? { can_stop: true } : {}),
      });
    });
    p.catch((err: unknown) => {
      if (err instanceof TelegramError) {
        if (err.kind === 'forbidden') {
          this.d.onForbidden?.(t.chatId);
          t.draftsDisabled = true;
          return;
        }
        if (err.kind === 'bad_request') {
          log.warn('Draft rejected; disabling drafts for this turn', { chatId: t.chatId, desc: err.description });
          t.draftsDisabled = true;
          return;
        }
      }
      log.debug('Draft send failed', { chatId: t.chatId, err });
    });
  }

  private stepLines(t: Turn): InputRichBlock[] {
    const steps = [...t.steps.values()];
    const hidden = Math.max(0, steps.length - this.cfg.maxVisibleSteps);
    const out: InputRichBlock[] = [];
    if (hidden > 0) out.push({ type: 'paragraph', text: `… ещё ${hidden} выполнено` });
    for (const s of steps.slice(hidden)) {
      const icon = s.state === 'done' ? '✅' : s.state === 'failed' ? '⚠️' : '⏳';
      out.push({ type: 'paragraph', text: `${icon} ${s.label}` });
    }
    return out;
  }

  private draftBlocks(t: Turn): InputRichBlock[] {
    const elapsed = Date.now() - t.startedAt;
    const blocks: InputRichBlock[] = [
      { type: 'paragraph', text: { type: 'bold', text: `Работаю · ${fmtClock(elapsed)}` } },
      ...this.stepLines(t),
    ];
    const preview = t.previewText.trim() ? (renderStreamingPreview(t.previewText).blocks ?? []) : [];
    const content = preview.filter((b) => b.type !== 'thinking');
    if (content.length > 0) {
      blocks.push({ type: 'divider' }, ...content);
    } else if (t.steps.size === 0) {
      blocks.push({ type: 'thinking', text: 'Думаю…' });
    }
    return blocks;
  }

  // ---- status card -------------------------------------------------------

  private statusMessage(t: Turn): InputRichMessage {
    const elapsed = Date.now() - t.startedAt;
    return {
      blocks: [
        { type: 'paragraph', text: { type: 'bold', text: `⏳ Работаю · ${fmtClock(elapsed)}` } },
        { type: 'paragraph', text: COPY.statusHint },
        ...this.stepLines(t),
      ],
    };
  }

  /** [⏹ Остановить] under the card while the turn can be stopped. */
  private statusMarkup(t: Turn): InlineKeyboardMarkup | undefined {
    if (!this.cfg.stopEnabled) return undefined;
    return this.d.buildKeyboard?.([[{ text: COPY.stopBtn, data: `p:stop:${t.draftId}` }]]);
  }

  private showStatus(t: Turn): void {
    t.statusStartTimer = undefined;
    if (t.closed || t.statusSend) return;
    t.statusSend = this.d.sched
      .enqueue(t.chatId, { prio: 'status', key: 'status:send' }, async () => {
        if (t.closed) return undefined;
        const m = await this.d.api.sendRichMessage({
          chat_id: t.chatId,
          disable_notification: true,
          rich_message: this.statusMessage(t),
          ...(this.statusMarkup(t) ? { reply_markup: this.statusMarkup(t) } : {}),
        });
        return m.message_id;
      })
      .then((id) => {
        if (id !== undefined) {
          t.statusMessageId = id;
          t.statusLastEditAt = Date.now();
          this.d.store.setDraftStatusMessage(t.chatId, t.draftId, id).catch(() => {});
          // A real message makes Telegram drop the draft: bring it back.
          if (!t.closed) this.requestDraft(t);
          if (t.statusDirty && !t.closed) this.scheduleStatusEdit(t);
        }
        return id;
      })
      .catch((err: unknown) => {
        if (isForbidden(err)) this.d.onForbidden?.(t.chatId);
        else log.warn('Status card send failed', { chatId: t.chatId, err });
        return undefined;
      });
  }

  private scheduleStatusEdit(t: Turn): void {
    if (t.closed) return;
    if (t.statusMessageId === undefined) {
      if (t.statusSend) t.statusDirty = true; // applied once the card exists
      return;
    }
    if (t.statusEditTimer) return;
    if (t.statusEditInFlight) {
      t.statusDirty = true; // re-evaluated when the running edit settles
      return;
    }
    t.statusDirty = false;
    const wait = t.statusLastEditAt + this.cfg.statusEditMinMs - Date.now();
    if (wait > 0) {
      t.statusEditTimer = setTimeout(() => {
        t.statusEditTimer = undefined;
        this.editStatus(t);
      }, wait);
      return;
    }
    this.editStatus(t);
  }

  private editStatus(t: Turn): void {
    if (t.closed || t.statusMessageId === undefined) return;
    const messageId = t.statusMessageId;
    t.statusEditInFlight = true;
    const p = this.d.sched.enqueue(t.chatId, { prio: 'status', key: 'status:edit', maxRateRetries: 1 }, async () => {
      if (t.closed) return;
      t.statusLastEditAt = Date.now();
      await this.d.api.editMessageText({
        chat_id: t.chatId,
        message_id: messageId,
        rich_message: this.statusMessage(t),
        ...(this.statusMarkup(t) ? { reply_markup: this.statusMarkup(t) } : {}),
      });
    });
    this.fire(p, 'status edit', t.chatId);
    void p
      .catch(() => {})
      .finally(() => {
        t.statusEditInFlight = false;
        if (t.statusDirty && !t.closed) this.scheduleStatusEdit(t);
      });
  }

  private terminalText(how: CloseReason, elapsedMs: number): string {
    switch (how) {
      case 'final':
        return `✓ Готово · ${fmtClock(elapsedMs)} · ответ ниже`;
      case 'cancelled':
        return '⏹ Остановлено';
      case 'failed':
        return '⚠️ Ошибка';
      case 'superseded':
        return `✓ Готово · ${fmtClock(elapsedMs)}`;
      default:
        return `✓ Готово · ${fmtClock(elapsedMs)}`;
    }
  }

  // ---- close -------------------------------------------------------------

  private close(t: Turn, how: CloseReason): void {
    if (t.closed) return;
    t.closed = true;
    const elapsed = Date.now() - t.startedAt;
    for (const timer of [
      t.draftStartTimer,
      t.draftTimer,
      t.heartbeatTimer,
      t.statusStartTimer,
      t.statusEditTimer,
      t.idleTimer,
    ]) {
      if (timer) clearTimeout(timer);
    }
    t.draftStartTimer =
      t.draftTimer =
      t.heartbeatTimer =
      t.statusStartTimer =
      t.statusEditTimer =
      t.idleTimer =
        undefined;
    if (this.active.get(t.chatId) === t) this.active.delete(t.chatId);
    this.rememberFinished(t.turnId);
    this.d.sched.cancel(t.chatId, 'draft');
    this.d.sched.cancel(t.chatId, 'status:edit');
    this.d.sched.cancel(t.chatId, 'status:send');
    this.d.store.closeDraft(t.chatId, t.draftId, Date.now()).catch(() => {});

    // 👀 off for every message this turn answered.
    const m = this.acks.get(t.chatId);
    for (const id of t.ackIds) m?.delete(id);
    this.clearReactions(t.chatId, t.ackIds);

    // Terminal state for the status card (after a still-pending send resolves).
    const text = this.terminalText(how, elapsed);
    const finalizeCard = (id: number | undefined) => {
      if (id === undefined) return;
      this.fire(
        this.d.sched.enqueue(t.chatId, { prio: 'status', key: 'status:final', maxRateRetries: 3 }, () =>
          this.d.api.editMessageText({
            chat_id: t.chatId,
            message_id: id,
            rich_message: { blocks: [{ type: 'paragraph', text }] },
          }),
        ),
        'status terminal edit',
        t.chatId,
      );
    };
    if (t.statusMessageId !== undefined) finalizeCard(t.statusMessageId);
    else if (t.statusSend) void t.statusSend.then(finalizeCard);

    if (!t.inlineFinal) {
      this.finishDeferred(t, how).catch((err: unknown) =>
        log.warn('deferred finish failed', { chatId: t.chatId, err }),
      );
    }
  }

  private forgetFinished(turnId: string): void {
    if (!this.finishedSet.delete(turnId)) return;
    const i = this.finished.indexOf(turnId);
    if (i >= 0) this.finished.splice(i, 1);
  }

  private rememberFinished(turnId: string): void {
    if (this.finishedSet.has(turnId)) return;
    this.finished.push(turnId);
    this.finishedSet.add(turnId);
    while (this.finished.length > FINISHED_MEMORY) this.finishedSet.delete(this.finished.shift()!);
  }

  private clearAllAcks(chatId: number): void {
    const m = this.acks.get(chatId);
    if (!m || m.size === 0) return;
    const ids = [...m.keys()];
    m.clear();
    this.clearReactions(chatId, ids);
  }

  private clearReactions(chatId: number, ids: number[]): void {
    for (const id of ids) {
      this.fire(
        this.d.sched.enqueue(chatId, { prio: 'final', spaced: false }, () =>
          this.d.api.setMessageReaction({ chat_id: chatId, message_id: id, reaction: [] }),
        ),
        'clear reaction',
        chatId,
      );
    }
  }

  private fire(p: Promise<unknown>, what: string, chatId: number): void {
    p.catch((err: unknown) => {
      if (isForbidden(err)) this.d.onForbidden?.(chatId);
      else log.debug(`Telegram ${what} failed`, { chatId, err });
    });
  }

  /** Teardown: stop every timer; pending work is dropped by the scheduler. */
  shutdown(): void {
    for (const t of this.active.values()) {
      t.closed = true;
      for (const timer of [
        t.draftStartTimer,
        t.draftTimer,
        t.heartbeatTimer,
        t.statusStartTimer,
        t.statusEditTimer,
        t.idleTimer,
      ]) {
        if (timer) clearTimeout(timer);
      }
    }
    this.active.clear();
  }
}
