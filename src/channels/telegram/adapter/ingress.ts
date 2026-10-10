/**
 * Inbound side (contract C6): update journal, idempotent processing, private
 * message pipeline (dedupe → gate → ack → download/transcribe → onInbound),
 * callbacks, guest messages, stop button, my_chat_member.
 */
import { FileTooLargeError, TelegramError, type CallbackQuery, type Message, type Update } from '../botapi/index.js';
import { log } from '../../../log.js';
import type { ChannelSetup } from '../../adapter.js';
import { COPY } from './copy.js';
import type { VoiceEcho } from './store.js';
import { getHooks, type GateDecision, type PrivateUpdateCtx, type TgUser } from './hooks.js';
import { saveRetryPrompt, type TelegramRuntime } from './runtime.js';

export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'callback_query',
  'guest_message',
  'stopped_message_generation',
  'my_chat_member',
] as const;

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_VOICE_S = 300;
/** Audio files may report duration 0; a file this big cannot be a ≤5-minute clip. */
const MAX_UNTIMED_AUDIO_BYTES = 5 * 1024 * 1024;
const TYPING_REFRESH_MS = 4000;
const MEDIA_GROUP_DEBOUNCE_MS = 1500;
const PRODUCT_COMMANDS = new Set(['start', 'stop', 'friends', 'guest', 'health', 'tasks', 'help', 'new', 'menu']);

/** Message fields the botapi lib does not model. */
interface MediaFields {
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  video_note?: { file_id: string; duration: number; file_size?: number };
  audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string; file_size?: number };
  video?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  animation?: { file_id: string; mime_type?: string; file_name?: string; file_size?: number };
  forward_origin?: {
    type: string;
    sender_user?: { first_name: string; last_name?: string; username?: string };
    sender_user_name?: string;
    chat?: { title?: string; username?: string };
    sender_chat?: { title?: string; username?: string };
  };
}
type Msg = Message & MediaFields;

interface Attachment {
  name: string;
  type: 'image' | 'video' | 'document';
  mimeType: string;
  size: number;
  data: string;
}

export function toTgUser(u: NonNullable<Message['from']>): TgUser {
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    languageCode: u.language_code,
  };
}

function displayName(u: TgUser): string {
  const full = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  return full || u.username || String(u.id);
}

export function classify(m: Msg): PrivateUpdateCtx['kind'] {
  if (m.text && m.entities?.some((e) => e.type === 'bot_command' && e.offset === 0)) return 'command';
  if (m.voice || m.video_note || m.audio) return 'voice';
  if (m.photo || m.document || m.video || m.animation) return 'media';
  if (m.text) return 'text';
  return 'other';
}

export function parseCommand(text: string): { command: string; args: string } | null {
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { command: m[1].toLowerCase(), args: (m[2] ?? '').trim() };
}

function safeName(raw: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const base = raw
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .slice(0, 100)
    .trim();
  return base || fallback;
}

class UserFacingError extends Error {}

/** name.ext, name-2.ext, name-3.ext ... unique within one inbound batch. */
export function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  if (used.has(candidate.toLowerCase())) {
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) {
      candidate = `${base}-${n}${ext}`;
      if (!used.has(candidate.toLowerCase())) break;
    }
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function forwardedFrom(m: Msg): string | undefined {
  const o = m.forward_origin;
  if (!o) return undefined;
  const u = o.sender_user;
  if (u) return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'неизвестного';
  return o.sender_user_name || o.chat?.title || o.sender_chat?.title || o.chat?.username || 'неизвестного';
}

interface GroupBuf {
  chatId: number;
  items: Array<{ msg: Msg; ctx: PrivateUpdateCtx; patch?: Record<string, unknown> }>;
  gateChain: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
}

export class Ingress {
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly left = new Set<number>();
  private readonly groups = new Map<string, GroupBuf>();
  private readonly chains = new Map<number, Promise<unknown>>();
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(
    private readonly rt: TelegramRuntime,
    private readonly host: ChannelSetup,
  ) {}

  /** Serialise per chat; media-group members bypass the chain (they must reach the buffer together). */
  dispatch(updateId: number, update: Update): Promise<void> {
    const msg = update.message;
    const chatKey =
      msg?.chat.id ?? update.callback_query?.message?.chat.id ?? update.stopped_message_generation?.chat.id ?? 0;
    const run = async () => {
      const attempts = await this.rt.store.beginUpdate(updateId).catch(() => 1);
      try {
        await this.process(update);
        await this.rt.store.setUpdateStatus(updateId, 'done').catch(() => {});
      } catch (err) {
        log.error('Update processing failed', { updateId, attempts, err });
        await this.rt.store.setUpdateStatus(updateId, 'failed').catch(() => {});
      }
    };
    let p: Promise<void>;
    const stopNow =
      !!update.stopped_message_generation || (!!msg?.text && /^\/stop(@\w+)?(\s|$)/i.test(msg.text.trim()));
    // Stop must not wait behind a voice transcription / file download of the same chat,
    // and drafts must not come back while the runner winds down.
    if (stopNow) this.rt.turns.disableDrafts(chatKey);
    if (msg?.media_group_id || stopNow) p = run();
    else {
      const prev = this.chains.get(chatKey) ?? Promise.resolve();
      p = prev.then(run);
      this.chains.set(chatKey, p);
      void p.finally(() => {
        if (this.chains.get(chatKey) === p) this.chains.delete(chatKey);
      });
    }
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
    return p;
  }

  async drain(timeoutMs = 5000): Promise<void> {
    await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  shutdown(): void {
    for (const g of this.groups.values()) if (g.timer) clearTimeout(g.timer);
    this.groups.clear();
  }

  async process(update: Update): Promise<void> {
    if (update.message) return this.onMessage(update, update.message as Msg);
    if (update.callback_query) return this.onCallback(update.callback_query);
    if (update.guest_message) return this.onGuest(update.guest_message);
    if (update.stopped_message_generation) return this.onStopped(update.stopped_message_generation);
    if (update.my_chat_member) return this.onMyChatMember(update.my_chat_member);
    // edited_message: ignored in v1.
  }

  // ---- messages ----------------------------------------------------------

  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.seenOrder.push(key);
    while (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
    return true;
  }

  /** Re-run a retained private message through the normal pipeline (the duplicate filter already saw it once). */
  replay(update: Update): Promise<void> {
    const msg = update.message as Msg | undefined;
    if (!msg) return Promise.resolve();
    const chatKey = msg.chat.id;
    const prev = this.chains.get(chatKey) ?? Promise.resolve();
    const p = prev.then(() => this.onMessage(update, msg, true));
    this.chains.set(
      chatKey,
      p.catch(() => undefined),
    );
    return p;
  }

  private async onMessage(update: Update, msg: Msg, replay = false): Promise<void> {
    if (msg.chat.type !== 'private') {
      await this.leave(msg.chat.id, 'message in non-private chat');
      return;
    }
    if (!msg.from || msg.from.is_bot) return;
    const chatId = msg.chat.id;
    if (!this.remember(`${chatId}:${msg.message_id}`) && !replay) return;

    if (await this.rt.store.isBlocked(chatId)) this.rt.markBlocked(chatId, false);

    const user = toTgUser(msg.from);
    const ctx: PrivateUpdateCtx = { update, user, chatId, message: msg, kind: classify(msg) };

    if (msg.media_group_id) return this.onGrouped(msg, ctx);

    const decision = await this.runGate(ctx);
    if (!decision) return;
    if (await this.runCommand(ctx)) return;
    this.rt.turns.noteInbound(chatId, msg.message_id);
    await this.routeMessages([{ msg, ctx, patch: decision.patch }]);
  }

  private async runGate(ctx: PrivateUpdateCtx): Promise<{ patch?: Record<string, unknown> } | null> {
    const hooks = getHooks();
    let d: GateDecision;
    try {
      d = hooks.gate
        ? await hooks.gate(ctx)
        : // No product module: owner only.
          ctx.user.id === this.rt.ownerId
          ? { action: 'route' }
          : { action: 'handled' };
    } catch (err) {
      log.error('private gate threw; dropping message', { chatId: ctx.chatId, err });
      return null;
    }
    if (d.action === 'handled') return null;
    return d.action === 'route-with-content' ? { patch: d.content } : {};
  }

  private async runCommand(ctx: PrivateUpdateCtx): Promise<boolean> {
    if (ctx.kind !== 'command' || !ctx.message?.text) return false;
    const parsed = parseCommand(ctx.message.text);
    const h = getHooks().command;
    if (!parsed || !h || !PRODUCT_COMMANDS.has(parsed.command)) return false;
    try {
      return await h(ctx, parsed.command, parsed.args);
    } catch (err) {
      log.error('command handler threw', { command: parsed.command, err });
      return true;
    }
  }

  // ---- media groups ------------------------------------------------------

  private async onGrouped(msg: Msg, ctx: PrivateUpdateCtx): Promise<void> {
    const key = `${ctx.chatId}:${msg.media_group_id}`;
    let g = this.groups.get(key);
    if (!g) {
      g = { chatId: ctx.chatId, items: [], gateChain: Promise.resolve() };
      this.groups.set(key, g);
    }
    const buf = g;
    // The gate sees every message, but never concurrently for one album.
    const next = buf.gateChain.then(() => this.runGate(ctx));
    buf.gateChain = next;
    const decision = await next;
    if (!decision) return;
    this.rt.turns.noteInbound(ctx.chatId, msg.message_id);
    buf.items.push({ msg, ctx, patch: decision.patch });
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      this.groups.delete(key);
      const p = this.routeMessages(buf.items).catch((err: unknown) => log.error('media group routing failed', { err }));
      this.inflight.add(p);
      void p.finally(() => this.inflight.delete(p));
    }, MEDIA_GROUP_DEBOUNCE_MS);
  }

  // ---- build + route -----------------------------------------------------

  private async download(fileId: string, size?: number): Promise<Buffer> {
    if (size !== undefined && size > MAX_FILE_BYTES) throw new UserFacingError(COPY.fileTooBig);
    try {
      const f = await this.rt.api.getFile(fileId);
      if (!f.file_path) throw new Error('getFile returned no file_path');
      return await this.rt.api.downloadFile(f.file_path, { maxBytes: MAX_FILE_BYTES });
    } catch (e) {
      if (e instanceof FileTooLargeError) throw new UserFacingError(COPY.fileTooBig);
      if (e instanceof TelegramError && e.kind === 'bad_request' && /too big/i.test(e.description)) {
        throw new UserFacingError(COPY.fileTooBig);
      }
      log.warn('file download failed', { err: e });
      throw new UserFacingError(COPY.fileFailed);
    }
  }

  private async reject(chatId: number, msgs: Msg[], text: string): Promise<void> {
    for (const m of msgs) this.rt.turns.releaseInbound(chatId, m.message_id);
    await this.replyTo(chatId, msgs[0]?.message_id, text);
  }

  private async replyTo(chatId: number, messageId: number | undefined, text: string): Promise<void> {
    await this.rt.sender
      .sendMarkdown(chatId, text, { prio: 'product', replyTo: messageId })
      .catch((err: unknown) => log.warn('reply failed', { err }));
  }

  private async routeMessages(items: GroupBuf['items']): Promise<void> {
    const sorted = [...items].sort((a, b) => a.msg.message_id - b.msg.message_id);
    const first = sorted[0];
    const chatId = first.ctx.chatId;
    const msgs = sorted.map((i) => i.msg);
    const user = first.ctx.user;
    const attachments: Attachment[] = [];
    const usedNames = new Set<string>();
    const notes: string[] = [];
    const markers: string[] = [];
    const echoes: VoiceEcho[] = [];
    let caption = '';
    let hasContent = false;
    let voice: { durationS: number; transcript: string; lang?: string } | undefined;

    const attach = (a: Omit<Attachment, 'name'> & { name: string }): string => {
      const name = uniqueName(a.name, usedNames);
      attachments.push({ ...a, name });
      return name;
    };
    // Only the failing item is skipped; the rest of the album goes through.
    const media = async (
      m: Msg,
      label: string,
      fileId: string,
      size: number | undefined,
      build: (buf: Buffer) => void,
    ) => {
      try {
        build(await this.download(fileId, size));
      } catch (err) {
        if (!(err instanceof UserFacingError)) throw err;
        notes.push(COPY.notFetched(label, err.message === COPY.fileTooBig ? COPY.tooBigShort : COPY.failedShort));
        await this.replyTo(chatId, m.message_id, err.message);
      }
    };

    const typing = setInterval(() => this.rt.turns.sendTyping(chatId), TYPING_REFRESH_MS);
    try {
      for (const m of msgs) {
        const fwd = forwardedFrom(m);
        const t = m.text ?? m.caption ?? '';
        if (t && !caption) {
          caption = fwd ? `${COPY.forwardedText(fwd)}\n${t}` : t;
          hasContent = true;
        }

        const audio = m.voice ?? m.video_note ?? m.audio;
        if (audio) {
          const kind = m.voice ? 'voice' : m.video_note ? 'video_note' : 'audio';
          const dur = audio.duration ?? 0;
          if (dur > MAX_VOICE_S || (dur <= 0 && (audio.file_size ?? 0) > MAX_UNTIMED_AUDIO_BYTES))
            throw new UserFacingError(COPY.voiceTooLong);
          const tr = getHooks().transcriber;
          if (!tr) throw new UserFacingError(COPY.voiceUnsupported);
          const buf = await this.download(audio.file_id, audio.file_size);
          const mime =
            (audio as { mime_type?: string }).mime_type ??
            (m.voice ? 'audio/ogg' : m.video_note ? 'video/mp4' : 'audio/mpeg');
          const r = await tr(buf, { mime, durationS: dur, userId: user.id });
          if ('error' in r) {
            throw new UserFacingError(
              r.error === 'too_long'
                ? COPY.voiceTooLong
                : r.error === 'empty'
                  ? COPY.voiceEmpty
                  : r.error === 'budget'
                    ? COPY.voiceBudget
                    : COPY.voiceFailed,
            );
          }
          if (!r.text.trim()) throw new UserFacingError(COPY.voiceEmpty);
          voice = { durationS: dur, transcript: r.text, lang: r.lang };
          const label = fwd
            ? (m.voice ? COPY.forwardedVoice : m.video_note ? COPY.forwardedVideoNote : COPY.forwardedAudio)(
                fwd,
                dur,
              ).slice(1, -1)
            : `${m.voice ? 'голосовое' : m.video_note ? 'кружок' : 'аудио'}${dur > 0 ? `, ${dur} с` : ''}`;
          markers.push(`[${label}] ${r.text}`);
          echoes.push({ kind, transcript: r.text.trim() });
          hasContent = true;
          continue;
        }
        if (m.photo?.length) {
          const best = m.photo[m.photo.length - 1];
          const name = `photo-${m.message_id}.jpg`;
          await media(m, name, best.file_id, best.file_size, (buf) => {
            attach({ name, type: 'image', mimeType: 'image/jpeg', size: buf.length, data: buf.toString('base64') });
            hasContent = true;
          });
        } else if (m.document) {
          const name = safeName(m.document.file_name ?? '', `file-${m.message_id}`);
          const mimeType = m.document.mime_type ?? 'application/octet-stream';
          await media(m, name, m.document.file_id, m.document.file_size, (buf) => {
            attach({
              name,
              type: mimeType.startsWith('image/') ? 'image' : 'document',
              mimeType,
              size: buf.length,
              data: buf.toString('base64'),
            });
            hasContent = true;
          });
        } else if (m.video || m.animation) {
          const v = (m.video ?? m.animation)!;
          const name = safeName(v.file_name ?? '', `video-${m.message_id}.mp4`);
          await media(m, name, v.file_id, v.file_size, (buf) => {
            attach({
              name,
              type: 'video',
              mimeType: v.mime_type ?? 'video/mp4',
              size: buf.length,
              data: buf.toString('base64'),
            });
            hasContent = true;
          });
        }
      }
    } catch (err) {
      if (err instanceof UserFacingError) {
        await this.reject(chatId, msgs, err.message);
        return;
      }
      throw err;
    } finally {
      clearInterval(typing);
    }

    if (!hasContent) {
      log.debug('inbound without text or attachments; ignored', { chatId });
      for (const m of msgs) this.rt.turns.releaseInbound(chatId, m.message_id);
      return;
    }

    // Replying to an earlier photo/document: hand the agent that file too.
    const r = first.msg.reply_to_message as Msg | undefined;
    let replyAttachment: string | undefined;
    if (r && (r.photo?.length || r.document)) {
      const best = r.photo?.length ? r.photo[r.photo.length - 1] : undefined;
      const fileId = best?.file_id ?? r.document!.file_id;
      const size = best ? best.file_size : r.document!.file_size;
      if (size === undefined || size <= MAX_FILE_BYTES) {
        try {
          const buf = await this.download(fileId, size);
          const mimeType = best ? 'image/jpeg' : (r.document!.mime_type ?? 'application/octet-stream');
          replyAttachment = attach({
            name: best ? `photo-${r.message_id}.jpg` : safeName(r.document!.file_name ?? '', `file-${r.message_id}`),
            type: best || mimeType.startsWith('image/') ? 'image' : 'document',
            mimeType,
            size: buf.length,
            data: buf.toString('base64'),
          });
        } catch (err) {
          log.debug('reply attachment not fetched', { chatId, err });
        }
      }
    }

    const text = [caption, ...markers, ...notes].filter(Boolean).join('\n');
    if (echoes.length) await this.rt.turns.noteVoice(chatId, first.msg.message_id, echoes);

    const senderName = displayName(user);
    const content: Record<string, unknown> = {
      text,
      senderId: `telegram:${user.id}`,
      sender: senderName,
      senderName,
      ...(r
        ? {
            replyTo: {
              id: `tg:${chatId}:${r.message_id}`,
              ...(r.text || r.caption ? { text: (r.text ?? r.caption)!.slice(0, 1000) } : {}),
              ...(replyAttachment ? { attachment: { name: replyAttachment } } : {}),
            },
          }
        : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(voice ? { voice } : {}),
      nc: { tgMessageId: first.msg.message_id, chatId },
    };
    for (const it of sorted) {
      if (it.patch) {
        const p = { ...it.patch };
        delete p.senderId;
        Object.assign(content, p);
      }
    }
    const platformId = `telegram:${chatId}`;
    this.host.onMetadata(platformId, senderName, false);
    // [Повторить] after a failure re-runs exactly this prompt.
    await saveRetryPrompt(
      this.rt.store,
      chatId,
      `tg:${chatId}:${first.msg.message_id}`,
      String(content.text ?? ''),
    ).catch((err: unknown) => log.debug('retry prompt not saved', { err }));
    await this.host.onInbound(platformId, null, {
      id: `tg:${chatId}:${first.msg.message_id}`,
      kind: 'chat',
      content,
      timestamp: new Date(first.msg.date * 1000).toISOString(),
      isMention: true,
      isGroup: false,
    });
  }

  // ---- callbacks ---------------------------------------------------------

  private async answer(q: CallbackQuery, text?: string): Promise<void> {
    await this.rt.api
      .answerCallbackQuery({ callback_query_id: q.id, ...(text ? { text: text.slice(0, 200) } : {}) })
      .catch((err: unknown) => log.debug('answerCallbackQuery failed', { err }));
  }

  private async onCallback(q: CallbackQuery): Promise<void> {
    const data = q.data ?? '';
    const chat = q.message?.chat;
    if (chat && chat.type !== 'private') {
      await this.answer(q);
      return;
    }
    if (data.startsWith('p:rs:')) {
      const row = await this.rt.store.getFinal(data.slice(5));
      if (!row || (chat && chat.id !== row.chat_id)) {
        await this.answer(q, COPY.resendGone);
        return;
      }
      await this.answer(q);
      await this.rt.sender
        .sendMarkdown(row.chat_id, row.markdown, { prio: 'product', longAsFile: true })
        .catch((err: unknown) => log.warn('resend failed', { err }));
      return;
    }
    if (data.startsWith('p:stop:')) {
      // [⏹ Остановить] under the status card; same path as the native Stop button.
      await this.answer(q);
      const draftId = Number(data.slice(7));
      if (chat && Number.isFinite(draftId)) await this.stopDraft(chat.id, draftId);
      return;
    }
    if (data.startsWith('p:')) {
      const h = getHooks().productCallback;
      let toast: string | undefined;
      try {
        const r = h ? await h(q, data) : undefined;
        toast = r?.toast;
      } catch (err) {
        log.error('product callback threw', { err });
      }
      await this.answer(q, toast);
      return;
    }
    if (data.startsWith('q:')) {
      const row = await this.rt.store.getCallback(data.slice(2));
      if (!row || row.expires_at < Date.now() || (chat && chat.id !== row.chat_id)) {
        await this.answer(q, COPY.staleButton);
        return;
      }
      await this.answer(q, COPY.accepted);
      this.rt.turns.noteQuestionAnswered(row.chat_id);
      this.host.onAction(row.question_id, row.value, `telegram:${q.from.id}`, {
        messageId: q.message ? String(q.message.message_id) : undefined,
        platformId: `telegram:${row.chat_id}`,
        threadId: null,
      });
      return;
    }
    await this.answer(q);
  }

  // ---- guest / stop / membership ------------------------------------------

  private async onGuest(msg: Message): Promise<void> {
    const id = msg.guest_query_id;
    if (!id) return;
    if (!(await this.rt.store.markGuestSeen(id, Date.now()))) return;
    const h = getHooks().guest;
    if (!h) return;
    try {
      await h(msg);
    } catch (err) {
      log.error('guest handler threw', { err });
    }
  }

  private async onStopped(s: NonNullable<Update['stopped_message_generation']>): Promise<void> {
    await this.stopDraft(s.chat.id, s.draft_id);
  }

  private async stopDraft(chatId: number, draftId: number): Promise<void> {
    let target = this.rt.turns.turnForDraft(chatId, draftId);
    this.rt.turns.disableDrafts(chatId);
    if (!target) {
      const row = await this.rt.store.getOpenDraft(chatId, draftId);
      if (row && row.chat_id === chatId) target = { sessionId: row.session_id, turnId: row.turn_id };
    }
    const h = getHooks().stop;
    if (!target || !h) return;
    try {
      await h({ chatId, sessionId: target.sessionId, turnId: target.turnId });
    } catch (err) {
      log.error('stop handler threw', { err });
    }
  }

  private async onMyChatMember(raw: unknown): Promise<void> {
    const u = raw as { chat?: { id: number; type: string }; new_chat_member?: { status?: string } };
    if (!u.chat || !u.new_chat_member?.status) return;
    const status = u.new_chat_member.status;
    if (u.chat.type === 'private') {
      if (status === 'kicked' || status === 'left') this.rt.markBlocked(u.chat.id, true);
      else if (status === 'member') this.rt.markBlocked(u.chat.id, false);
      return;
    }
    if (status === 'member' || status === 'administrator' || status === 'restricted') {
      await this.leave(u.chat.id, 'added to non-private chat');
    }
  }

  private async leave(chatId: number, why: string): Promise<void> {
    if (this.left.has(chatId)) return;
    this.left.add(chatId);
    log.warn('Leaving non-private chat', { chatId, why });
    await this.rt.api.leaveChat(chatId).catch((err: unknown) => log.warn('leaveChat failed', { chatId, err }));
  }
}
