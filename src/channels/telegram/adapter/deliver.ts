/** ChannelAdapter.deliver() mapping (contract C5, upstream-map §1.5). */
import { TelegramError, InputFile, type InlineKeyboardMarkup, type InputRichMessage } from '../botapi/index.js';
import { plainText, renderMarkdown } from '../render/index.js';
import { log } from '../../../log.js';
import type { OutboundFile, OutboundMessage } from '../../adapter.js';
import { normalizeOptions, type NormalizedOption, type RawOption } from '../../ask-question.js';
import { resolveQuestionRender } from '../../question-render-registry.js';
import { COPY } from './copy.js';
import { baseTurnId, chatIdFromPlatformId, classifyFailure, escapeMd, shortId } from './format.js';
import { CALLBACK_TTL_MS, type VoiceEcho } from './store.js';
import {
  deliveryKey,
  editRich,
  inQuietHours,
  resolveBudgetNote,
  resolvePrefs,
  type TelegramRuntime,
} from './runtime.js';
import { buildKeyboard, isForbidden, type ProductButton } from './sender.js';
import { getHooks } from './hooks.js';
import { mapReaction } from './reactions.js';
import type { BudgetNoteView } from './hooks.js';
import type { LastOut, PendingFile } from './turns.js';

type Content = Record<string, unknown>;

const PHOTO_EXT = /\.(png|jpe?g|webp)$/i;
const PHOTO_MAX = 10 * 1024 * 1024;
const DOC_MAX = 50 * 1024 * 1024;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;

interface Attempt {
  at: number;
  progress: { ids: number[] };
  filesSent: number;
  note?: BudgetNoteView | null;
  echo?: VoiceEcho[];
  /** Suggestion / reminder / task buttons, minted once per row (retries must not mint new ones). */
  extra?: ProductButton[][];
}

/** `nc` block the runner may put on a chat row (see crossDirRequests). */
interface NcMeta {
  turnId?: string;
  /** Last chat row of the turn (carries «Что я сделал»). */
  final?: boolean;
  /** 'task' = scheduled-task output: never part of a user turn. */
  source?: string;
  stopped?: boolean;
  /** Timeout notice: `markdown` already holds the partial result. */
  timeout?: boolean;
  /** suggest_replies: up to 3 tap-to-send follow-ups for this row. */
  suggest?: string[];
  /** Fired reminder: [Сделано] [Отложить на час]. */
  reminder?: { seriesId?: string };
  /** Task/reminder just created: [Отменить] [Изменить время]. */
  taskCreated?: { seriesId?: string };
}

export type FailureClass = 'internal' | 'overload' | 'budget' | 'busy' | 'turn_cap' | 'global_cap' | 'timeout';
const FAILURE_CLASSES = new Set<string>([
  'internal',
  'overload',
  'budget',
  'busy',
  'turn_cap',
  'global_cap',
  'timeout',
]);

/** The runner's `failureClass` wins; older hosts' text is only a fallback. */
export function failureClassOf(c: Content, nc: NcMeta, rawText: string): FailureClass {
  if (typeof c.failureClass === 'string' && FAILURE_CLASSES.has(c.failureClass)) return c.failureClass as FailureClass;
  if (nc.timeout === true) return 'timeout';
  switch (classifyFailure(rawText)) {
    case 'overload':
      return 'overload';
    case 'budget':
      return 'budget';
    case 'busy':
      return 'busy';
    case 'turn_cap':
      return 'turn_cap';
    case 'global_cap':
      return 'global_cap';
    case 'timeout':
      return 'timeout';
    default:
      return 'internal';
  }
}

const NET_RETRY_MS = [1000, 2000, 4000, 8000, 16_000, 30_000];
const UPLOAD_ACTION_MS = 4000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function failureCopy(cls: FailureClass): string {
  switch (cls) {
    case 'overload':
      return COPY.failOverload;
    case 'budget':
      return COPY.failBudget;
    case 'busy':
      return COPY.failBusy;
    case 'turn_cap':
      return COPY.failTurnCap;
    case 'global_cap':
      return COPY.failGlobalCap;
    case 'timeout':
      return COPY.failTimeout;
    default:
      return COPY.failGeneric;
  }
}

/** "123" or an inbound row id "tg:<chat>:<mid>[:suffix]" -> message id. */
export function parseMessageId(raw: unknown): number | null {
  const s = String(raw ?? '');
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^tg:-?\d+:(\d+)/.exec(s);
  return m ? Number(m[1]) : null;
}

export class Deliverer {
  private readonly attempts = new Map<string, Attempt>();

  constructor(private readonly rt: TelegramRuntime) {
    rt.turns.setFileSender((chatId, files) => this.sendQueuedFiles(chatId, files));
  }

  private kb(rows: ProductButton[][]): InlineKeyboardMarkup | undefined {
    return buildKeyboard(rows, this.rt.botUsername, this.rt.miniAppShortName, this.rt.miniAppUrl);
  }

  /** Pre-send network failures and 429s are retried here with backoff; everything else goes upstream. */
  private async retrying<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof TelegramError) || e.kind !== 'network' || e.uncertain || i >= NET_RETRY_MS.length) throw e;
        log.warn('Telegram unreachable; retrying delivery', { attempt: i + 1, desc: e.description });
        await sleep(NET_RETRY_MS[i]);
      }
    }
  }

  async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
    const chatId = chatIdFromPlatformId(platformId);
    if (chatId === null) throw new Error(`telegram: bad platform id ${platformId}`);
    const c = (message.content ?? {}) as Content;
    try {
      if (await this.rt.store.isBlocked(chatId)) {
        log.info('Skipping delivery: chat blocked the bot', { chatId });
        this.rt.turns.endFinal({ chatId, elapsedMs: 0 });
        return undefined;
      }
      if (c.operation === 'edit' && c.messageId !== undefined) return await this.edit(chatId, c);
      if (c.operation === 'reaction' && c.messageId !== undefined && typeof c.emoji === 'string') {
        return await this.reaction(chatId, c);
      }
      if (c.type === 'ask_question' && c.questionId && Array.isArray(c.options)) return await this.ask(chatId, c);
      if (c.type === 'card' && c.card) return await this.card(chatId, c);
      return await this.chat(chatId, c, message.files);
    } catch (e) {
      if (isForbidden(e)) {
        this.rt.markBlocked(chatId, true);
        this.rt.turns.endFinal({ chatId, elapsedMs: 0 });
        return undefined;
      }
      throw e;
    }
  }

  // ---- edit / reaction ---------------------------------------------------

  private async edit(chatId: number, c: Content): Promise<undefined> {
    const mid = parseMessageId(c.messageId);
    if (mid === null) {
      log.warn('edit: unparseable message id', { chatId });
      return undefined;
    }
    let md = '';
    const tc = c.terminalCard as { title?: string; question?: string; resolution?: string } | undefined;
    if (tc) {
      md = [`**${escapeMd(tc.title ?? '')}**`, tc.question ?? '', tc.resolution ? `✔ ${tc.resolution}` : '']
        .filter(Boolean)
        .join('\n\n');
    } else md = typeof c.markdown === 'string' ? c.markdown : typeof c.text === 'string' ? c.text : '';
    const r = renderMarkdown(md);
    try {
      await editRich(this.rt, chatId, mid, r.messages[0], r.plainFallback[0], undefined);
    } catch (e) {
      if (e instanceof TelegramError && e.kind === 'bad_request') {
        log.warn('edit rejected by Telegram; dropping', { chatId, desc: e.description });
        return undefined;
      }
      throw e;
    }
    return undefined;
  }

  private async reaction(chatId: number, c: Content): Promise<undefined> {
    const mid = parseMessageId(c.messageId);
    if (mid === null) return undefined;
    const emoji = mapReaction(c.emoji as string);
    try {
      await this.rt.sched.enqueue(chatId, { prio: 'product', spaced: false }, () =>
        this.rt.api.setMessageReaction({
          chat_id: chatId,
          message_id: mid,
          reaction: [{ type: 'emoji', emoji }],
        }),
      );
      // The agent's reaction is the user's only acknowledgement: the turn cleanup must not wipe it.
      this.rt.turns.noteAgentReaction(chatId, mid);
    } catch (e) {
      if (e instanceof TelegramError && (e.kind === 'bad_request' || e.uncertain)) {
        log.warn('reaction not applied', { chatId, kind: e.kind, desc: e.description });
        return undefined;
      }
      throw e;
    }
    return undefined;
  }

  // ---- ask_question ------------------------------------------------------

  private async ask(chatId: number, c: Content): Promise<string | undefined> {
    const questionId = String(c.questionId);
    const render = await resolveQuestionRender(questionId).catch(() => undefined);
    if (c.requirePresentation === true && !render) {
      throw new Error(`ask_question ${questionId}: requirePresentation but no render resolvable`);
    }
    const title = render?.title ?? String(c.title ?? '');
    const question = render?.question ?? String(c.question ?? '');
    const options: NormalizedOption[] = render?.options?.length
      ? render.options
      : normalizeOptions(c.options as RawOption[]);
    if (!title && !question) {
      log.error('ask_question without title/question; dropping', { questionId });
      return undefined;
    }
    const now = Date.now();
    const rows: InlineKeyboardMarkup['inline_keyboard'] = [];
    const short = options.length <= 2 && options.every((o) => o.label.length <= 16);
    for (const o of options) {
      const id = shortId();
      await this.rt.store.saveCallback({
        short_id: id,
        question_id: questionId,
        value: o.value,
        chat_id: chatId,
        created_at: now,
        expires_at: now + CALLBACK_TTL_MS,
      });
      const btn = {
        text: o.label,
        callback_data: `q:${id}`,
        ...(o.style === 'primary'
          ? { style: 'primary' as const }
          : o.style === 'danger'
            ? { style: 'danger' as const }
            : {}),
      };
      if (short && rows.length) rows[0].push(btn);
      else rows.push([btn]);
    }
    const md = [title ? `**${escapeMd(title)}**` : '', question].filter(Boolean).join('\n\n');
    const ids = await this.rt.sender.sendMarkdown(chatId, md, { prio: 'product', markup: { inline_keyboard: rows } });
    // The runner stays silent until the answer arrives: the idle watchdog must not call that a dead turn.
    this.rt.turns.noteQuestion(chatId);
    return ids.find((i) => i > 0)?.toString();
  }

  // ---- card --------------------------------------------------------------

  private async card(chatId: number, c: Content): Promise<string | undefined> {
    const card = c.card as {
      title?: string;
      description?: string;
      children?: Array<string | { text?: string }>;
      actions?: Array<{ label?: string; url?: string; style?: string }>;
    };
    const parts: string[] = [];
    if (card.title) parts.push(`**${escapeMd(card.title)}**`);
    if (card.description) parts.push(card.description);
    for (const ch of card.children ?? []) {
      const t = typeof ch === 'string' ? ch : ch?.text;
      if (t) parts.push(t);
    }
    const buttons = (card.actions ?? [])
      .filter((a) => a.label && typeof a.url === 'string' && /^https?:\/\//i.test(a.url))
      .map((a) => [{ text: a.label!, url: a.url! }]);
    const md = parts.join('\n\n') || (typeof c.fallbackText === 'string' ? c.fallbackText : '');
    if (!md.trim()) return undefined;
    const ids = await this.rt.sender.sendMarkdown(chatId, md, {
      prio: 'product',
      markup: buttons.length ? { inline_keyboard: buttons } : undefined,
    });
    return ids.find((i) => i > 0)?.toString();
  }

  // ---- chat ---------------------------------------------------------------
  //
  // A chat row inside an open user turn is an INTERIM message unless the runner
  // marks it final (`nc.final`) or it is a failure/stop notice: it is delivered,
  // 👀 and the draft stay, and the turn closes only on the runner's terminal
  // event, which then attaches «Что я сделал» to the last delivered message.
  // Rows of scheduled tasks (`nc.source === 'task'`) or of another turn
  // (`nc.turnId` mismatch) never touch the user's turn.

  private cleanAttempts(now: number): void {
    for (const [k, a] of this.attempts) if (now - a.at > ATTEMPT_TTL_MS) this.attempts.delete(k);
  }

  private async chat(chatId: number, c: Content, files: OutboundFile[] | undefined): Promise<string | undefined> {
    const nc = (c.nc && typeof c.nc === 'object' ? c.nc : {}) as NcMeta;
    const rawText = typeof c.markdown === 'string' ? c.markdown : typeof c.text === 'string' ? c.text : '';
    const failure = c.failureNotice === true;
    const stopped = nc.stopped === true;
    const task = nc.source === 'task';
    const fc = failure ? failureClassOf(c, nc, rawText) : undefined;
    // A timeout keeps the runner's text: it already carries the partial result (§2.9 row 3).
    const keepRunnerText =
      fc === 'timeout' && (c.failureClass === 'timeout' || nc.timeout === true) && rawText.trim() !== '';
    const text = fc ? (keepRunnerText ? rawText : failureCopy(fc)) : rawText;
    const now = Date.now();
    this.cleanAttempts(now);
    // Retries of the same row must not resend parts that already went out.
    const key = deliveryKey(chatId, { c, files: files?.map((f) => [f.filename, f.data.length]) });
    let attempt = this.attempts.get(key);
    if (!attempt) {
      attempt = { at: now, progress: { ids: [] }, filesSent: 0 };
      this.attempts.set(key, attempt);
    }

    const turns = this.rt.turns;
    const active = turns.activeTurn(chatId);
    const linked = !!active && !task && (!nc.turnId || baseTurnId(nc.turnId) === baseTurnId(active.turnId));
    const standalone = task || (!!active && !linked);
    const terminal = failure || stopped || nc.final === true;
    const interim = linked && !terminal;
    const turn = linked ? active : undefined;

    const ctx = standalone
      ? { chatId, elapsedMs: 0, silent: undefined as boolean | undefined }
      : interim && turn
        ? { chatId, turn, elapsedMs: now - turn.startedAt, silent: undefined as boolean | undefined }
        : await turns.beginFinal(chatId, { failure: failure || stopped });
    const withTurn = !standalone && !!turn;
    if (standalone || !active) {
      // Scheduled/proactive output: quiet hours mean «без звука».
      const prefs = await resolvePrefs(chatId).catch(() => undefined);
      if (inQuietHours(prefs, now)) ctx.silent = true;
    }
    if (withTurn && attempt.echo === undefined) attempt.echo = await turns.takeEcho(turn!).catch(() => []);
    if (attempt.note === undefined) {
      attempt.note = failure || stopped || interim || standalone ? null : await resolveBudgetNote(chatId);
    }

    if (attempt.extra === undefined) attempt.extra = failure || stopped ? [] : await this.extraButtons(chatId, nc);
    const retryTurnId = nc.turnId ?? active?.turnId;
    let rows: ProductButton[][] | undefined;
    if (fc) rows = this.failureButtons(chatId, fc, retryTurnId);
    else if (stopped)
      rows = [
        [
          { text: COPY.cont, data: 'p:cont' },
          { text: COPY.fresh, data: 'p:new' },
        ],
      ];
    else {
      rows = [...attempt.extra, ...(attempt.note?.button ? [[attempt.note.button]] : [])];
      if (rows.length === 0) rows = undefined;
    }
    const markup = rows ? this.kb(rows) : undefined;

    // One short line + exactly one file -> caption on the file (§2.5).
    const own = files ?? [];
    const oneLine = text.trim() && !text.trim().includes('\n') && plainText(text).length <= 1024;
    const captionMode =
      own.length === 1 &&
      !!oneLine &&
      !ctx.details &&
      !attempt.note &&
      !attempt.echo?.length &&
      !failure &&
      !stopped &&
      !markup;
    const caption = captionMode ? plainText(text).trim() : undefined;

    let captured: { count: number; last: InputRichMessage } | undefined;
    if (text.trim() && !captionMode) {
      const deco = turns.detailsDecorator(ctx, interim ? null : attempt.note?.text, attempt.echo);
      await this.retrying(() =>
        this.rt.sender.sendMarkdown(chatId, text, {
          prio: 'final',
          silent: ctx.silent,
          markup,
          // One row that renders to many parts becomes a short summary + answer.md, interim or not.
          longAsFile: true,
          decorate: (ms) => {
            const out = deco(ms);
            captured = { count: out.length, last: out[out.length - 1] };
            return out;
          },
          progress: attempt.progress,
        }),
      );
      if (!failure && attempt.progress.ids.includes(0)) await this.offerResend(chatId, text);
    }

    if (interim && turn) {
      // The answer text goes first, its files right after it, before this row is acknowledged: a restart or a
      // send failure then leaves the row retryable instead of losing an already-acked file.
      for (let i = attempt.filesSent; i < own.length; i++) {
        await this.retrying(() => this.sendFile(chatId, own[i], caption));
        attempt.filesSent = i + 1;
      }
      let out: LastOut | undefined;
      const id = captured ? attempt.progress.ids[captured.count - 1] : undefined;
      if (captured && id && id > 0) out = { messageId: id, message: captured.last, markup };
      this.attempts.delete(key);
      turns.noteInterim(turn, out, rawText);
      return attempt.progress.ids.find((i) => i > 0)?.toString();
    }

    const queued: PendingFile[] = turn ? turn.pendingFiles : [];
    const all: PendingFile[] = [...queued, ...own.map((f) => ({ ...f, caption }))];
    for (let i = attempt.filesSent; i < all.length; i++) {
      await this.retrying(() => this.sendFile(chatId, all[i], all[i].caption));
      attempt.filesSent = i + 1;
    }
    if (turn) turn.pendingFiles = [];
    this.attempts.delete(key);
    if (!standalone) turns.endFinal(ctx, failure ? 'failed' : stopped ? 'cancelled' : 'final');
    return attempt.progress.ids.find((i) => i > 0)?.toString();
  }

  /** §2.9: which buttons follow which failure. */
  private failureButtons(chatId: number, cls: FailureClass, turnId: string | undefined): ProductButton[][] | undefined {
    switch (cls) {
      case 'timeout':
        return [
          [
            { text: COPY.cont, data: 'p:cont' },
            { text: COPY.fresh, data: 'p:new' },
          ],
        ];
      case 'budget':
        return [[{ text: COPY.raiseLimit, data: `p:rl:${chatId}` }], [{ text: COPY.usageBtn, webApp: 'usage' }]];
      case 'turn_cap':
        return [[{ text: COPY.fresh, data: 'p:new' }]];
      case 'global_cap':
        return undefined;
      default:
        return turnId ? [[{ text: COPY.retry, data: `p:rty:${baseTurnId(turnId)}` }]] : undefined;
    }
  }

  /** suggest_replies chips, reminder and task-created buttons carried by the runner in `content.nc`. */
  private async extraButtons(chatId: number, nc: NcMeta): Promise<ProductButton[][]> {
    const rows: ProductButton[][] = [];
    const now = Date.now();
    try {
      for (const label of (nc.suggest ?? []).slice(0, 3)) {
        if (typeof label !== 'string' || !label.trim()) continue;
        const id = shortId();
        await this.rt.store.saveCallback({
          short_id: id,
          question_id: 'sr',
          value: label,
          chat_id: chatId,
          created_at: now,
          expires_at: now + CALLBACK_TTL_MS,
        });
        rows.push([{ text: label.slice(0, 40), data: `p:sr:${id}` }]);
      }
      const mint = getHooks().taskToken;
      const reminder = nc.reminder?.seriesId;
      const created = nc.taskCreated?.seriesId;
      if (mint && typeof reminder === 'string' && reminder) {
        rows.push([
          { text: COPY.reminderDone, data: `p:rd:${await mint(chatId, reminder)}` },
          { text: COPY.reminderSnooze, data: `p:sz:${await mint(chatId, reminder)}` },
        ]);
      }
      if (mint && typeof created === 'string' && created) {
        rows.push([
          { text: COPY.taskCancel, data: `p:tc:${await mint(chatId, created)}` },
          { text: COPY.taskReschedule, data: `p:tt:${await mint(chatId, created)}` },
        ]);
      }
    } catch (err) {
      log.warn('extra buttons not rendered', { chatId, err });
    }
    return rows;
  }

  /** The outcome of the final is unknown (timeout/5xx): keep the text and offer to show it again. */
  private async offerResend(chatId: number, md: string): Promise<void> {
    const id = shortId();
    try {
      await this.rt.store.saveFinal({ id, chat_id: chatId, markdown: md, created_at: Date.now() });
      await this.rt.sender.sendMarkdown(chatId, COPY.resendNotice, {
        prio: 'product',
        markup: this.kb([[{ text: COPY.resendBtn, data: `p:rs:${id}` }]]),
      });
    } catch (err) {
      log.warn('resend offer failed', { chatId, err });
    }
  }

  private async sendQueuedFiles(chatId: number, files: PendingFile[]): Promise<void> {
    for (const f of files) {
      try {
        await this.retrying(() => this.sendFile(chatId, f, f.caption));
      } catch (err) {
        log.warn('queued file send failed', { chatId, file: f.filename, err });
      }
    }
  }

  private async sendFile(chatId: number, f: OutboundFile, caption?: string): Promise<void> {
    const size = f.data.length;
    if (size > DOC_MAX) {
      await this.rt.sender.sendMarkdown(chatId, COPY.fileTooBigOut(f.filename), { prio: 'final' });
      return;
    }
    const file = new InputFile(f.data, f.filename);
    // 30 s + 2 s/MB, at least 120 s above 10 MB.
    const mb = size / (1024 * 1024);
    const timeoutMs = Math.max(30_000 + Math.round(mb * 2000), size > 10 * 1024 * 1024 ? 120_000 : 30_000);
    const cap = caption ? { caption: caption.slice(0, 1024) } : {};
    const run = async (kind: 'photo' | 'document') => {
      const action = kind === 'photo' ? 'upload_photo' : 'upload_document';
      const ping = () => void this.rt.api.sendChatAction({ chat_id: chatId, action }).catch(() => undefined);
      ping();
      const timer = setInterval(ping, UPLOAD_ACTION_MS);
      try {
        // A timeout without any response most likely means the body never finished uploading
        // (a slow link): the file is not at Telegram yet, so try once more with twice the time.
        for (let attempt = 0; ; attempt++) {
          const t = timeoutMs * (attempt + 1);
          try {
            await this.rt.sched.enqueue(chatId, { prio: 'final' }, () =>
              kind === 'photo'
                ? this.rt.api.sendPhoto({ chat_id: chatId, photo: file, ...cap }, { timeoutMs: t })
                : this.rt.api.sendDocument({ chat_id: chatId, document: file, ...cap }, { timeoutMs: t }),
            );
            return;
          } catch (e) {
            if (!(e instanceof TelegramError) || !e.uncertain) throw e;
            if (e.kind === 'timeout' && attempt < 1) {
              log.warn('file upload timed out; retrying with a longer limit', { chatId, kind, desc: e.description });
              continue;
            }
            if (e.kind === 'timeout') {
              log.warn('file upload timed out twice; asking the user to check', { chatId, kind });
              await this.rt.sender
                .sendMarkdown(chatId, COPY.fileMaybeLost(f.filename), { prio: 'final' })
                .catch((err: unknown) => log.warn('file notice failed', { err }));
              return;
            }
            log.warn('file send outcome uncertain; treating as delivered', { chatId, kind: e.kind });
            return;
          }
        }
      } finally {
        clearInterval(timer);
      }
    };
    if (PHOTO_EXT.test(f.filename) && size <= PHOTO_MAX) {
      try {
        await run('photo');
        return;
      } catch (e) {
        if (!(e instanceof TelegramError && e.kind === 'bad_request')) throw e;
      }
    }
    await run('document');
  }
}
