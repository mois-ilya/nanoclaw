/** Test doubles: a recording fake BotApi (no network). Not imported by production code. */
import type { BotApi } from '../botapi/index.js';

export interface Call {
  method: string;
  params: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  at: number;
}

export class FakeApi {
  calls: Call[] = [];
  nextMessageId = 1000;
  /** method -> queue of errors to throw (consumed in order). */
  failures = new Map<string, unknown[]>();
  updates: unknown[][] = [];
  files = new Map<string, { path: string; data: Buffer }>();

  failNext(method: string, err: unknown): void {
    const q = this.failures.get(method) ?? [];
    q.push(err);
    this.failures.set(method, q);
  }

  private async rec<T>(method: string, params: unknown, result: T): Promise<T> {
    this.calls.push({ method, params, at: Date.now() });
    const q = this.failures.get(method);
    if (q?.length) throw q.shift();
    return result;
  }

  of(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** `sendRichMessageDraft` calls that are the «Думаю…» placeholder (a bare thinking block, sent on accept). */
  placeholderDrafts(): Call[] {
    return this.of('sendRichMessageDraft').filter((c) => !JSON.stringify(c.params).includes('Работаю'));
  }

  /** `sendRichMessageDraft` calls made by a running turn («Работаю · …» drafts). */
  turnDrafts(): Call[] {
    return this.of('sendRichMessageDraft').filter((c) => JSON.stringify(c.params).includes('Работаю'));
  }

  getMe() {
    return this.rec('getMe', {}, { id: 1, is_bot: true, first_name: 'Bot', username: 'test_bot' });
  }
  sendRichMessage(p: unknown) {
    return this.rec('sendRichMessage', p, { message_id: this.nextMessageId++ });
  }
  sendMessage(p: unknown) {
    return this.rec('sendMessage', p, { message_id: this.nextMessageId++ });
  }
  sendRichMessageDraft(p: unknown) {
    return this.rec('sendRichMessageDraft', p, true as const);
  }
  sendMessageDraft(p: unknown) {
    return this.rec('sendMessageDraft', p, true as const);
  }
  editMessageText(p: unknown) {
    return this.rec('editMessageText', p, true as const);
  }
  editMessageReplyMarkup(p: unknown) {
    return this.rec('editMessageReplyMarkup', p, true as const);
  }
  setMessageReaction(p: unknown) {
    return this.rec('setMessageReaction', p, true as const);
  }
  sendChatAction(p: unknown) {
    return this.rec('sendChatAction', p, true as const);
  }
  sendPhoto(p: unknown) {
    return this.rec('sendPhoto', p, { message_id: this.nextMessageId++ });
  }
  sendDocument(p: unknown) {
    return this.rec('sendDocument', p, { message_id: this.nextMessageId++ });
  }
  answerCallbackQuery(p: unknown) {
    return this.rec('answerCallbackQuery', p, true as const);
  }
  leaveChat(chat_id: number) {
    return this.rec('leaveChat', { chat_id }, true as const);
  }
  async getFile(file_id: string) {
    const f = this.files.get(file_id);
    return this.rec('getFile', { file_id }, { file_id, file_unique_id: file_id, file_path: f?.path ?? 'x/y' });
  }
  async downloadFile(path: string) {
    const f = [...this.files.values()].find((x) => x.path === path);
    return this.rec('downloadFile', { path }, f?.data ?? Buffer.from('data'));
  }
  /** Behaves like long polling: with nothing queued it blocks until the (fake) timeout or abort. */
  async getUpdates(p: unknown, opts?: { signal?: AbortSignal }) {
    this.calls.push({ method: 'getUpdates', params: p, at: Date.now() });
    const q = this.failures.get('getUpdates');
    if (q?.length) throw q.shift();
    const next = this.updates.shift();
    if (next) return next as never[];
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 50_000);
      opts?.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
    return [] as never[];
  }
  asBotApi(): BotApi {
    return this as unknown as BotApi;
  }
}
