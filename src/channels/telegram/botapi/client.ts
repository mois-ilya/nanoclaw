import { FileTooLargeError, TelegramError, type TelegramErrorKind } from './errors.js';
import {
  InputFile,
  type ApiResponse,
  type BotCommand,
  type BotCommandScope,
  type ChatAction,
  type ChatId,
  type EditMessageReplyMarkupParams,
  type EditMessageTextParams,
  type File,
  type InlineQueryResult,
  type MenuButton,
  type Message,
  type MethodName,
  type Methods,
  type ReactionType,
  type SendDocumentParams,
  type SendMessageParams,
  type SendPhotoParams,
  type SendRichMessageDraftParams,
  type SendRichMessageParams,
  type SentGuestMessage,
  type Update,
  type User,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.telegram.org';
const DEFAULT_TIMEOUT_MS = 30_000;
/** getFile.md: “bots can download files of up to 20MB”. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Node/undici error codes that prove nothing was sent yet. */
const PRE_SEND_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

export interface BotApiOptions {
  token: string;
  /** Default https://api.telegram.org (e.g. a local Bot API server). */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request timeout. For getUpdates the long-poll `timeout` is added on top. */
  timeoutMs?: number;
}

export interface CallOptions {
  /** Overrides the client timeout for this call. */
  timeoutMs?: number;
  /** Caller-side cancellation (not classified as timeout). */
  signal?: AbortSignal;
}

function containsInputFile(params: object): boolean {
  return Object.values(params).some((v) => v instanceof InputFile);
}

function classify(status: number): TelegramErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status >= 500) return 'server';
  return 'bad_request';
}

export class BotApi {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: BotApiOptions) {
    if (!opts.token) throw new Error('BotApi: token is required');
    this.token = opts.token;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Never include the token in anything that leaves this class. */
  private redact(text: string): string {
    if (!text) return text;
    return text.split(this.token).join('<token>');
  }

  private buildBody(params: object): { body: string | FormData; headers: Record<string, string> } {
    if (!containsInputFile(params)) {
      return { body: JSON.stringify(params), headers: { 'content-type': 'application/json' } };
    }
    // multipart/form-data: scalars as strings, objects/arrays JSON-serialised,
    // InputFile as a file part. Content-Type (with boundary) is set by fetch.
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (value instanceof InputFile) {
        form.append(
          key,
          new Blob([new Uint8Array(value.data)], value.contentType ? { type: value.contentType } : {}),
          value.filename,
        );
      } else if (typeof value === 'object') {
        form.append(key, JSON.stringify(value));
      } else {
        form.append(key, String(value));
      }
    }
    return { body: form, headers: {} };
  }

  /**
   * Run fetch with our timer + optional caller signal, then `consume` the
   * response while the timer and signal are still attached: a body that stalls
   * or breaks after the headers arrived is a timeout/network error too (and
   * uncertain, since Telegram may already have run the method).
   */
  private async doFetch<T>(
    method: string,
    url: string,
    init: RequestInit,
    opts: CallOptions,
    timeoutMs: number,
    consume: (res: Response) => Promise<T>,
  ): Promise<T> {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, timeoutMs);
    const onCallerAbort = () => ctrl.abort();
    opts.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (opts.signal?.aborted) ctrl.abort();
    let res: Response;
    try {
      try {
        res = await this.fetchFn(url, { ...init, signal: ctrl.signal });
      } catch (e) {
        throw this.fetchFailure(method, e, timedOut, timeoutMs, opts, false);
      }
      // Real fetch aborts the body stream with the signal; racing it also
      // covers fetch implementations that don't.
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(ctrl.signal.reason ?? new Error('aborted'));
        if (ctrl.signal.aborted) onAbort();
        else ctrl.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        return await Promise.race([consume(res), aborted]);
      } catch (e) {
        if (e instanceof TelegramError || e instanceof FileTooLargeError) throw e;
        throw this.fetchFailure(method, e, timedOut, timeoutMs, opts, true);
      } finally {
        ctrl.signal.removeEventListener('abort', onAbort);
        aborted.catch(() => {});
        if (ctrl.signal.aborted) void res.body?.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private fetchFailure(
    method: string,
    e: unknown,
    timedOut: boolean,
    timeoutMs: number,
    opts: CallOptions,
    afterHeaders: boolean,
  ): unknown {
    if (timedOut) {
      return new TelegramError({
        method,
        kind: 'timeout',
        code: 0,
        description: afterHeaders
          ? `response body not received within ${timeoutMs}ms`
          : `no response within ${timeoutMs}ms`,
      });
    }
    if (opts.signal?.aborted) return e;
    const err = e as { message?: string; cause?: { code?: string; message?: string } };
    const code = err.cause?.code;
    const msg = this.redact(`${err.message ?? 'fetch failed'}${err.cause?.message ? `: ${err.cause.message}` : ''}`);
    const te = new TelegramError({
      method,
      kind: 'network',
      code: 0,
      description: `${afterHeaders ? 'response body failed: ' : ''}${code ? `${code} ${msg}` : msg}`,
    });
    te.preSend = !afterHeaders && code !== undefined && PRE_SEND_CODES.has(code);
    return te;
  }

  async call<M extends MethodName>(
    method: M,
    params: Methods[M]['params'],
    opts: CallOptions = {},
  ): Promise<Methods[M]['result']> {
    const { body, headers } = this.buildBody(params as object);
    let timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    if (method === 'getUpdates' && opts.timeoutMs === undefined) {
      timeoutMs += ((params as Methods['getUpdates']['params']).timeout ?? 0) * 1000;
    }
    return this.doFetch(
      method,
      `${this.baseUrl}/bot${this.token}/${method}`,
      { method: 'POST', headers, body },
      opts,
      timeoutMs,
      async (res) => {
        // Body read errors propagate to doFetch (timeout/network, uncertain).
        const raw = await res.text();
        let payload: ApiResponse<Methods[M]['result']> | undefined;
        try {
          payload = JSON.parse(raw) as ApiResponse<Methods[M]['result']>;
        } catch {
          // Non-JSON body (proxy error page, truncated response).
        }
        if (payload && payload.ok === true) return payload.result;

        if (res.ok && !(payload && payload.ok === false)) {
          // 2xx means Telegram ran the method; an unparseable body leaves the
          // outcome unknown, never a definite failure.
          throw new TelegramError({
            method,
            kind: 'network',
            code: 0,
            description: `unparseable ${res.status} response: ${this.redact(raw.slice(0, 120)) || 'empty body'}`,
          });
        }
        const code = (payload && payload.ok === false && payload.error_code) || res.status;
        const description = this.redact(
          (payload && payload.ok === false && payload.description) ||
            raw.slice(0, 200) ||
            res.statusText ||
            'unknown error',
        );
        const parameters = payload && payload.ok === false ? payload.parameters : undefined;
        throw new TelegramError({
          method,
          kind: classify(code),
          code,
          description,
          retryAfter: parameters?.retry_after,
          migrateToChatId: parameters?.migrate_to_chat_id,
        });
      },
    );
  }

  /** Download by `file_path` from getFile. Rejects bodies larger than maxBytes (default 20 MB). */
  async downloadFile(filePath: string, opts: CallOptions & { maxBytes?: number } = {}): Promise<Buffer> {
    const maxBytes = opts.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES;
    const method = 'downloadFile';
    return this.doFetch(
      method,
      `${this.baseUrl}/file/bot${this.token}/${filePath.replace(/^\/+/, '')}`,
      { method: 'GET' },
      opts,
      opts.timeoutMs ?? this.timeoutMs,
      async (res) => {
        if (!res.ok) {
          const text = this.redact((await res.text().catch(() => '')).slice(0, 200));
          throw new TelegramError({
            method,
            kind: classify(res.status),
            code: res.status,
            description: text || res.statusText,
          });
        }
        const declared = Number(res.headers.get('content-length') ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) {
          await res.body?.cancel().catch(() => {});
          throw new FileTooLargeError(maxBytes, declared);
        }
        if (!res.body) return Buffer.alloc(0);
        const chunks: Buffer[] = [];
        let total = 0;
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => {});
            throw new FileTooLargeError(maxBytes, total);
          }
          chunks.push(Buffer.from(value));
        }
        return Buffer.concat(chunks);
      },
    );
  }

  // ---- typed wrappers ------------------------------------------------------

  getMe(): Promise<User> {
    return this.call('getMe', {});
  }
  getUpdates(params: Methods['getUpdates']['params'] = {}, opts?: CallOptions): Promise<Update[]> {
    return this.call('getUpdates', params, opts);
  }
  getFile(file_id: string): Promise<File> {
    return this.call('getFile', { file_id });
  }
  sendMessage(params: SendMessageParams): Promise<Message> {
    return this.call('sendMessage', params);
  }
  sendRichMessage(params: SendRichMessageParams): Promise<Message> {
    return this.call('sendRichMessage', params);
  }
  sendRichMessageDraft(params: SendRichMessageDraftParams): Promise<true> {
    return this.call('sendRichMessageDraft', params);
  }
  editMessageText(params: EditMessageTextParams): Promise<Message | true> {
    return this.call('editMessageText', params);
  }
  editMessageReplyMarkup(params: EditMessageReplyMarkupParams): Promise<Message | true> {
    return this.call('editMessageReplyMarkup', params);
  }
  deleteMessage(chat_id: ChatId, message_id: number): Promise<true> {
    return this.call('deleteMessage', { chat_id, message_id });
  }
  answerCallbackQuery(params: Methods['answerCallbackQuery']['params']): Promise<true> {
    return this.call('answerCallbackQuery', params);
  }
  answerGuestQuery(guest_query_id: string, result: InlineQueryResult): Promise<SentGuestMessage> {
    return this.call('answerGuestQuery', { guest_query_id, result });
  }
  setMyCommands(
    commands: BotCommand[],
    extra: { scope?: BotCommandScope; language_code?: string } = {},
  ): Promise<true> {
    return this.call('setMyCommands', { commands, ...extra });
  }
  getMyCommands(extra: { scope?: BotCommandScope; language_code?: string } = {}): Promise<BotCommand[]> {
    return this.call('getMyCommands', extra);
  }
  setMyDescription(params: Methods['setMyDescription']['params']): Promise<true> {
    return this.call('setMyDescription', params);
  }
  getMyDescription(params: Methods['getMyDescription']['params'] = {}): Promise<{ description: string }> {
    return this.call('getMyDescription', params);
  }
  setMyShortDescription(params: Methods['setMyShortDescription']['params']): Promise<true> {
    return this.call('setMyShortDescription', params);
  }
  getMyShortDescription(
    params: Methods['getMyShortDescription']['params'] = {},
  ): Promise<{ short_description: string }> {
    return this.call('getMyShortDescription', params);
  }
  setChatMenuButton(params: { chat_id?: number; menu_button?: MenuButton } = {}): Promise<true> {
    return this.call('setChatMenuButton', params);
  }
  setMessageReaction(params: {
    chat_id: ChatId;
    message_id: number;
    reaction?: ReactionType[];
    is_big?: boolean;
  }): Promise<true> {
    return this.call('setMessageReaction', params);
  }
  sendChatAction(params: {
    chat_id: ChatId;
    action: ChatAction;
    message_thread_id?: number;
    business_connection_id?: string;
  }): Promise<true> {
    return this.call('sendChatAction', params);
  }
  sendDocument(params: SendDocumentParams, opts?: CallOptions): Promise<Message> {
    return this.call('sendDocument', params, opts);
  }
  sendPhoto(params: SendPhotoParams, opts?: CallOptions): Promise<Message> {
    return this.call('sendPhoto', params, opts);
  }
  leaveChat(chat_id: ChatId): Promise<true> {
    return this.call('leaveChat', { chat_id });
  }
}
