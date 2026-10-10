/**
 * Rich-message sending on top of the per-chat scheduler: render, split,
 * send each part, degrade to plain text when Telegram rejects the markup,
 * and treat "uncertain" outcomes (timeout after send) as sent so upstream
 * never double-sends.
 */
import {
  InputFile,
  TelegramError,
  type BotApi,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type InputRichMessage,
} from '../botapi/index.js';
import { LIMITS, renderMarkdown } from '../render/index.js';
import { log } from '../../../log.js';
import { threadParam } from './format.js';
import { blocksToPlainChunks } from './plainblocks.js';
import type { Priority, Scheduler } from './scheduler.js';

export interface ProductButton {
  text: string;
  /** callback_data, must start with 'p:' and be <= 64 bytes. */
  data?: string;
  url?: string;
  /** startapp param -> Mini App deep link. */
  webApp?: string;
}

export interface SendOpts {
  prio: Extract<Priority, 'final' | 'product'>;
  /** true -> disable_notification; false -> explicitly notify; undefined -> Telegram default. */
  silent?: boolean;
  replyTo?: number;
  /** Private-chat topic (`message_thread_id`) the message belongs to. */
  threadId?: number;
  markup?: InlineKeyboardMarkup;
  /** Mutate the rendered messages (details block, budget footer). */
  decorate?: (messages: InputRichMessage[]) => InputRichMessage[];
  /** Resume state: parts already confirmed sent are skipped. Mutated as parts go out. */
  progress?: { ids: number[] };
  /** More than 3 rendered parts -> first part as summary + the full text as answer.md. */
  longAsFile?: boolean;
}

/** Room kept in every part for the details block / budget footer added by `decorate`. */
const DECORATE_RESERVE = { chars: 4000, blocks: 60 };
const FILE_PARTS_THRESHOLD = 3;

/** Markdown that is most likely to be accepted: tables -> lists, <details> flattened. */
export function sanitizeMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|.*\|\s*$/.test(l)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) continue; // separator row
      const cells = l
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
      out.push(`- ${cells.filter(Boolean).join(' — ')}`);
      continue;
    }
    out.push(l.replace(/<\/?(details|summary)[^>]*>/gi, ''));
  }
  return out.join('\n');
}

class RichRejected extends Error {
  constructor(readonly description: string) {
    super(description);
  }
}

export interface SenderDeps {
  api: BotApi;
  sched: Scheduler;
  /** Called on a 403 so the chat can be marked blocked. */
  onForbidden?: (chatId: number, err: TelegramError) => void;
}

export function isForbidden(e: unknown): e is TelegramError {
  return e instanceof TelegramError && e.kind === 'forbidden';
}

export class Sender {
  constructor(private readonly d: SenderDeps) {}

  /** Sends markdown; returns the message ids (0 = outcome unknown, treated as sent). */
  async sendMarkdown(chatId: number, md: string, opts: SendOpts): Promise<number[]> {
    const progress = opts.progress ?? { ids: [] };
    const reserve = opts.decorate ? DECORATE_RESERVE : { chars: 0, blocks: 0 };
    const render = (text: string) =>
      renderMarkdown(text, { maxChars: LIMITS.maxChars - reserve.chars, maxBlocks: LIMITS.maxBlocks - reserve.blocks });
    let source = md;
    let sanitized = false;
    for (;;) {
      const rendered = render(source);
      let messages = rendered.messages;
      const asFile = !!opts.longAsFile && messages.length > FILE_PARTS_THRESHOLD;
      if (asFile) {
        const first = messages[0];
        const blocks = [...(first.blocks ?? [])];
        if (blocks[blocks.length - 1]?.type === 'footer') blocks.pop(); // «продолжение ниже» is wrong here
        messages = [{ ...first, blocks }];
      }
      if (opts.decorate && messages.length > 0) messages = opts.decorate(messages);

      if (messages.length === 0) {
        // Nothing renderable as blocks (e.g. whitespace only, or the decorator had nothing to add).
        if (rendered.plainFallback.length > 0 && progress.ids.length === 0) {
          await this.sendPlain(chatId, rendered.plainFallback, opts, true, progress);
        }
        return progress.ids;
      }
      try {
        for (let i = progress.ids.length; i < messages.length; i++) {
          const isFirst = i === 0;
          const isLast = i === messages.length - 1 && !asFile;
          const id = await this.sendPart(
            chatId,
            messages[i],
            opts,
            isFirst,
            isLast,
            progress.ids.length === 0 && !sanitized && sanitizeMarkdown(source) !== source,
          );
          progress.ids.push(id);
        }
        if (asFile && progress.ids.length === messages.length)
          progress.ids.push(await this.sendAnswerFile(chatId, md, opts));
        return progress.ids;
      } catch (e) {
        if (!(e instanceof RichRejected)) throw e;
        const next = sanitizeMarkdown(source);
        log.warn('render_fallback: rich message rejected, retrying sanitized', { chatId, desc: e.description });
        sanitized = true;
        source = next;
      }
    }
  }

  private async sendAnswerFile(chatId: number, md: string, opts: SendOpts): Promise<number> {
    try {
      const m = await this.d.sched.enqueue(chatId, { prio: opts.prio }, () =>
        this.d.api.sendDocument({
          chat_id: chatId,
          document: new InputFile(Buffer.from(md, 'utf8'), 'answer.md'),
          ...threadParam(opts.threadId),
          ...(opts.silent !== undefined ? { disable_notification: opts.silent } : {}),
          ...(opts.markup ? { reply_markup: opts.markup } : {}),
        }),
      );
      return m.message_id;
    } catch (e) {
      if (e instanceof TelegramError && e.uncertain) return 0;
      throw e;
    }
  }

  private params(chatId: number, opts: SendOpts, isFirst: boolean, isLast: boolean) {
    return {
      chat_id: chatId,
      ...threadParam(opts.threadId),
      ...(opts.silent !== undefined ? { disable_notification: opts.silent } : {}),
      ...(isFirst && opts.replyTo
        ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } }
        : {}),
      ...(isLast && opts.markup ? { reply_markup: opts.markup } : {}),
    };
  }

  private async sendPart(
    chatId: number,
    msg: InputRichMessage,
    opts: SendOpts,
    isFirst: boolean,
    isLast: boolean,
    canSanitize = false,
  ): Promise<number> {
    try {
      const m = await this.d.sched.enqueue(chatId, { prio: opts.prio }, () =>
        this.d.api.sendRichMessage({ ...this.params(chatId, opts, isFirst, isLast), rich_message: msg }),
      );
      return m.message_id;
    } catch (e) {
      if (e instanceof TelegramError) {
        if (e.kind === 'bad_request') {
          if (canSanitize) throw new RichRejected(e.description);
          log.warn('render_fallback: rich message rejected, sending plain text', { chatId, desc: e.description });
          const chunks = blocksToPlainChunks(msg.blocks ?? []);
          const ids = { ids: [] as number[] };
          await this.sendPlain(chatId, chunks.length ? chunks : ['…'], opts, isFirst, ids, isLast);
          return ids.ids[0] ?? 0;
        }
        if (e.kind === 'forbidden') this.d.onForbidden?.(chatId, e);
        else if (e.uncertain) {
          log.warn('Telegram send outcome uncertain; treating as delivered', {
            chatId,
            method: e.method,
            kind: e.kind,
          });
          return 0;
        }
      }
      throw e;
    }
  }

  private async sendPlain(
    chatId: number,
    chunks: string[],
    opts: SendOpts,
    isFirst: boolean,
    progress: { ids: number[] },
    isLast = true,
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      const first = isFirst && i === 0;
      const last = isLast && i === chunks.length - 1;
      try {
        const m = await this.d.sched.enqueue(chatId, { prio: opts.prio }, () =>
          this.d.api.sendMessage({ ...this.params(chatId, opts, first, last), text: chunks[i] }),
        );
        progress.ids.push(m.message_id);
      } catch (e) {
        if (e instanceof TelegramError) {
          if (e.kind === 'forbidden') this.d.onForbidden?.(chatId, e);
          else if (e.uncertain) {
            log.warn('Telegram plain send outcome uncertain; treating as delivered', { chatId, kind: e.kind });
            progress.ids.push(0);
            continue;
          }
        }
        throw e;
      }
    }
  }
}

/** Build an inline keyboard from product buttons. `botUsername` is needed for webApp deep links. */
export function buildKeyboard(
  rows: ProductButton[][] | undefined,
  botUsername: string | undefined,
  miniAppShortName?: string,
  miniAppUrl?: string,
): InlineKeyboardMarkup | undefined {
  if (!rows || rows.length === 0) return undefined;
  const inline_keyboard: InlineKeyboardButton[][] = [];
  for (const row of rows) {
    const out: InlineKeyboardButton[] = [];
    for (const b of row) {
      if (b.data !== undefined) {
        if (!b.data.startsWith('p:')) throw new Error(`product callback data must start with "p:": ${b.data}`);
        if (Buffer.byteLength(b.data, 'utf8') > 64) throw new Error(`callback_data > 64 bytes: ${b.data}`);
        out.push({ text: b.text, callback_data: b.data });
      } else if (b.url) {
        out.push({ text: b.text, url: b.url });
      } else if (b.webApp !== undefined) {
        if (!miniAppShortName && miniAppUrl) {
          // No BotFather «Main Mini App»: a native web_app button works in private chats.
          const sep = miniAppUrl.includes('?') ? '&' : '?';
          out.push({ text: b.text, web_app: { url: `${miniAppUrl}${sep}startapp=${encodeURIComponent(b.webApp)}` } });
          continue;
        }
        if (!botUsername) throw new Error('webApp button requires the bot username (adapter not started)');
        const base = miniAppShortName
          ? `https://t.me/${botUsername}/${miniAppShortName}`
          : `https://t.me/${botUsername}`;
        out.push({ text: b.text, url: `${base}?startapp=${encodeURIComponent(b.webApp)}` });
      } else {
        throw new Error(`product button "${b.text}" has no data/url/webApp`);
      }
    }
    if (out.length) inline_keyboard.push(out);
  }
  return inline_keyboard.length ? { inline_keyboard } : undefined;
}
