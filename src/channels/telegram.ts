/**
 * Telegram channel adapter (v2) — uses Chat SDK bridge, with a pairing
 * interceptor wrapped around onInbound to verify chat ownership before
 * registration. See telegram-pairing.ts for the why.
 *
 * This adapter ships as the unified /add-telegram skill: it folds in
 * HTML message rendering (parse_mode=HTML via direct Bot API, bypassing
 * the chat-sdk adapter's hardcoded MarkdownV2), forum-topic awareness
 * (supportsThreads=true → per-topic sessions), and a setMyCommands push
 * at startup driven by the TELEGRAM_BOT_COMMANDS manifest.
 */
import { createTelegramAdapter } from '@chat-adapter/telegram';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { createMessagingGroup, getMessagingGroupByPlatform, updateMessagingGroup } from '../db/messaging-groups.js';
import { grantRole, hasAnyOwner } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import { createChatSdkBridge, splitForLimit, type ReplyContext } from './chat-sdk-bridge.js';
import { sanitizeTelegramLegacyMarkdown } from './telegram-markdown-sanitize.js';
import { registerChannelAdapter } from './channel-registry.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage } from './adapter.js';
import { tryConsume } from './telegram-pairing.js';
import { TELEGRAM_BOT_COMMANDS, type TelegramBotCommand } from './telegram-bot-commands.js';

/**
 * Retry a one-shot operation that can fail on transient network errors at
 * cold-start (DNS hiccups, brief upstream outages). Exponential backoff capped
 * at 5 attempts — if the network is truly down we surface it instead of
 * hanging the service indefinitely.
 */
async function withRetry<T>(fn: () => Promise<T>, label: string, maxAttempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts) break;
      const delay = Math.min(16000, 1000 * 2 ** (attempt - 1));
      log.warn('Telegram setup failed, retrying', { label, attempt, delayMs: delay, err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.reply_to_message) return null;
  const reply = raw.reply_to_message;
  return {
    text: reply.text || reply.caption || '',
    sender: reply.from?.first_name || reply.from?.username || 'Unknown',
  };
}

/** Bot identity from getMe. The display name `first_name` is whatever the
 *  operator set in BotFather — we surface it to callers (init-first-agent,
 *  startup log) so nothing hardcodes a persona name. */
export interface TelegramBotIdentity {
  id: number;
  first_name: string;
  username: string;
}

/** Fetch the bot identity via Telegram getMe; null on failure. */
async function fetchBotIdentity(token: string): Promise<TelegramBotIdentity | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok: boolean; result?: TelegramBotIdentity };
    return json.ok && json.result ? json.result : null;
  } catch (err) {
    log.warn('Telegram getMe failed', { err });
    return null;
  }
}

/**
 * Push the bot's command menu via setMyCommands. Scope precedence in
 * Telegram is first-match-with-no-merge: if we set `default` only, group
 * users see those; if we set `all_private_chats` only, DM users see those
 * but group users fall through to the default (which would be empty).
 * Setting both with the same list guarantees every user sees the same menu.
 *
 * Fire-and-forget at startup — never block adapter setup on this.
 */
async function pushTelegramBotCommands(token: string, commands: readonly TelegramBotCommand[]): Promise<void> {
  const scopes = [{ type: 'default' }, { type: 'all_private_chats' }];
  for (const scope of scopes) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ commands, scope }),
      });
      const json = (await res.json()) as { ok: boolean; description?: string };
      if (!json.ok) {
        log.warn('Telegram setMyCommands non-OK', { scope: scope.type, error: json.description });
      }
    } catch (err) {
      log.warn('Telegram setMyCommands failed', { scope: scope.type, err });
    }
  }
}

/**
 * Decode `message_thread_id` from the adapter's encoded threadId.
 * Format: `telegram:<chatId>:<messageThreadId>` if topic, else
 * `telegram:<chatId>`. The third segment, if present and numeric, is the
 * forum-topic id that goes into the Bot API request as `message_thread_id`.
 */
function parseEncodedMessageThreadId(threadId: string | null): number | null {
  if (!threadId) return null;
  const parts = threadId.split(':');
  if (parts.length < 3) return null;
  const n = parseInt(parts[2], 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse the reply target written by the container's send_message tool.
 *
 * The container resolves the agent's `reply_to_seq` via getMessageIdBySeq,
 * which returns the inbound message's primary key. For Telegram inbound
 * that's `"<chatId>:<msgId>:<agent-group-id>"` (3+ segments). The second
 * segment is the Telegram-side message_id that goes into `reply_parameters`.
 *
 * Returns null for any value that can't be parsed (missing, non-numeric,
 * single-segment) — the caller treats null as "send without reply".
 */
function parseReplyToMessageId(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw);
  const parts = s.split(':');
  const msgIdStr = parts.length >= 2 ? parts[1] : parts[0];
  const n = parseInt(msgIdStr, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Send a plain text / HTML message via Telegram Bot API directly, bypassing
 * the Chat SDK adapter's hardcoded MarkdownV2. Splits at 4096 chars
 * (Telegram per-message cap). Returns the first chunk's message id in the
 * same `<chatId>:<msgId>` form the adapter uses elsewhere.
 *
 * Topic-aware: if `threadId` decodes to a forum-topic id, every chunk lands
 * in that topic via the `message_thread_id` request field.
 *
 * Link-preview is OFF by default. The literal token `[[link-preview]]`
 * anywhere in the input opts in to a preview for the FIRST chunk only;
 * subsequent chunks never preview. The token is stripped before sending.
 *
 * Native reply attaches to the FIRST chunk only. If `replyQuoteText` is set,
 * it's passed as `reply_parameters.quote` so Telegram highlights a specific
 * fragment of the target message (Bot API 7.0+). The quote must be an exact
 * substring of the target message — Telegram validates server-side and returns
 * 400 `MESSAGE_QUOTE_INVALID` (or similar) if not. We retry once without the
 * quote on that error so the reply still goes out without the highlight.
 */
async function sendTelegramHtml(
  token: string,
  chatId: string,
  messageThreadId: number | null,
  replyToMessageId: number | null,
  replyQuoteText: string | null,
  text: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string }> {
  const TELEGRAM_TEXT_LIMIT = 4096;
  const enablePreview = text.includes('[[link-preview]]');
  const cleaned = enablePreview ? text.replace(/\[\[link-preview\]\]/g, '').trimStart() : text;
  const chunks = cleaned.length > TELEGRAM_TEXT_LIMIT ? splitForLimit(cleaned, TELEGRAM_TEXT_LIMIT) : [cleaned];
  let firstId: string | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const buildBody = (withQuote: boolean): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: chunks[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: !(enablePreview && i === 0) },
      };
      if (messageThreadId !== null) body.message_thread_id = messageThreadId;
      if (replyToMessageId !== null && i === 0) {
        const rp: Record<string, unknown> = { message_id: replyToMessageId };
        if (withQuote && replyQuoteText) rp.quote = replyQuoteText;
        body.reply_parameters = rp;
      }
      return body;
    };

    const post = async (withQuote: boolean) => {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildBody(withQuote)),
      });
      const json = (await res.json()) as {
        ok: boolean;
        result?: { message_id: number };
        description?: string;
      };
      return { res, json };
    };

    try {
      const hasQuote = i === 0 && replyToMessageId !== null && replyQuoteText !== null;
      let { res, json } = await post(hasQuote);
      // If the quote text didn't match the target message, drop the quote and
      // resend the same reply so the message still lands — just without the
      // highlight. Telegram error description for a bad quote contains the
      // word "quote", which is enough of a signal.
      if (!json.ok && hasQuote && typeof json.description === 'string' && /quote/i.test(json.description)) {
        log.warn('Telegram quote rejected, retrying without quote', { description: json.description });
        ({ res, json } = await post(false));
      }
      if (!json.ok || json.result?.message_id == null) {
        return { ok: false, error: json.description ?? `HTTP ${res.status}` };
      }
      if (firstId === null) firstId = `${chatId}:${json.result.message_id}`;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, messageId: firstId ?? '' };
}

function isGroupPlatformId(platformId: string): boolean {
  // platformId is "telegram:<chatId>". Negative chat IDs are groups/channels.
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

interface InboundFields {
  text: string;
  authorUserId: string | null;
}

function readInboundFields(message: InboundMessage): InboundFields {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') {
    return { text: '', authorUserId: null };
  }
  const c = message.content as { text?: string; author?: { userId?: string } };
  return { text: c.text ?? '', authorUserId: c.author?.userId ?? null };
}

/**
 * Send a one-shot confirmation back to the paired chat. Best-effort —
 * failures are logged but never propagated, so a Telegram outage can't undo
 * a successful pairing or trigger the interceptor's fail-open path.
 */
async function sendPairingConfirmation(token: string, platformId: string): Promise<void> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: 'Pairing success! Head back to the NanoClaw installer to finish setup.',
      }),
    });
    if (!res.ok) {
      log.warn('Telegram pairing confirmation non-OK', { status: res.status });
    }
  } catch (err) {
    log.warn('Telegram pairing confirmation failed', { err });
  }
}

/**
 * Build an onInbound interceptor that consumes pairing codes before they
 * reach the router. On match: records the chat + its paired user, promotes
 * the user to owner if the instance has no owner yet, and short-circuits.
 * On miss: forwards to the host.
 */
function createPairingInterceptor(
  botIdentityPromise: Promise<TelegramBotIdentity | null>,
  hostOnInbound: ChannelSetup['onInbound'],
  token: string,
): ChannelSetup['onInbound'] {
  return async (platformId, threadId, message) => {
    try {
      const identity = await botIdentityPromise;
      const botUsername = identity?.username ?? null;
      if (!botUsername) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const { text, authorUserId } = readInboundFields(message);
      if (!text) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      const consumed = await tryConsume({
        text,
        botUsername,
        platformId,
        isGroup: isGroupPlatformId(platformId),
        adminUserId: authorUserId,
      });
      if (!consumed) {
        hostOnInbound(platformId, threadId, message);
        return;
      }
      // Pairing matched — record the chat and short-circuit so the
      // code-bearing message never reaches an agent. Privilege is now a
      // property of the paired user, not the chat: upsert the user, and if
      // this instance has no owner yet, promote them to owner.
      const existing = getMessagingGroupByPlatform('telegram', platformId);
      if (existing) {
        updateMessagingGroup(existing.id, {
          is_group: consumed.consumed!.isGroup ? 1 : 0,
        });
      } else {
        createMessagingGroup({
          id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          channel_type: 'telegram',
          platform_id: platformId,
          name: consumed.consumed!.name,
          is_group: consumed.consumed!.isGroup ? 1 : 0,
          unknown_sender_policy: 'strict',
          created_at: new Date().toISOString(),
        });
      }

      const pairedUserId = `telegram:${consumed.consumed!.adminUserId}`;
      upsertUser({
        id: pairedUserId,
        kind: 'telegram',
        display_name: null,
        created_at: new Date().toISOString(),
      });

      let promotedToOwner = false;
      if (!hasAnyOwner()) {
        grantRole({
          user_id: pairedUserId,
          role: 'owner',
          agent_group_id: null,
          granted_by: null,
          granted_at: new Date().toISOString(),
        });
        promotedToOwner = true;
      }

      log.info('Telegram pairing accepted — chat registered', {
        platformId,
        pairedUser: pairedUserId,
        promotedToOwner,
        intent: consumed.intent,
      });

      await sendPairingConfirmation(token, platformId);
    } catch (err) {
      log.error('Telegram pairing interceptor error', { err });
      // Fail open: pass through so a pairing bug doesn't break normal traffic.
      hostOnInbound(platformId, threadId, message);
    }
  };
}

registerChannelAdapter('telegram', {
  factory: () => {
    const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
    if (!env.TELEGRAM_BOT_TOKEN) return null;
    const token = env.TELEGRAM_BOT_TOKEN;
    const telegramAdapter = createTelegramAdapter({
      botToken: token,
      mode: 'polling',
    });
    const bridge = createChatSdkBridge({
      adapter: telegramAdapter,
      concurrency: 'concurrent',
      extractReplyContext,
      supportsThreads: true,
      transformOutboundText: sanitizeTelegramLegacyMarkdown,
      maxTextLength: 4000,
    });

    const botIdentityPromise = fetchBotIdentity(token);
    botIdentityPromise.then((id) => {
      if (id) {
        log.info('Telegram bot connected', {
          username: `@${id.username}`,
          firstName: id.first_name,
          botId: id.id,
        });
      }
    });

    const wrapped: ChannelAdapter = {
      ...bridge,
      async deliver(platformId, threadId, message) {
        const content = (message.content ?? {}) as Record<string, unknown>;
        const isCard = content.type === 'ask_question' || content.type === 'card';
        const isOp = content.operation === 'edit' || content.operation === 'reaction';
        const hasFiles = Array.isArray(message.files) && message.files.length > 0;
        const text = (content.markdown as string) || (content.text as string) || '';
        // Only the plain text/markdown path goes through HTML — cards, ops, and
        // file-bearing messages still go through the SDK bridge (where
        // attachments are handled). HTML failure (e.g. malformed tags) falls
        // back to the bridge so the user gets *something*.
        if (isCard || isOp || hasFiles || !text) {
          return bridge.deliver(platformId, threadId, message);
        }
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return bridge.deliver(platformId, threadId, message);
        const messageThreadId = parseEncodedMessageThreadId(threadId);
        const replyToMessageId = parseReplyToMessageId(content.reply_to_message_id);
        const replyQuoteText =
          typeof content.reply_quote_text === 'string' && content.reply_quote_text.length > 0
            ? content.reply_quote_text
            : null;
        const sent = await sendTelegramHtml(token, chatId, messageThreadId, replyToMessageId, replyQuoteText, text);
        if (sent.ok) return sent.messageId;
        log.warn('Telegram HTML send failed, falling back to bridge', { error: sent.error });
        return bridge.deliver(platformId, threadId, message);
      },
      resolveChannelName: async (platformId: string) => {
        const chatId = platformId.split(':').slice(1).join(':');
        if (!chatId) return null;
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId }),
          });
          const data = (await res.json()) as { ok?: boolean; result?: { title?: string } };
          return data.ok ? (data.result?.title ?? null) : null;
        } catch {
          return null;
        }
      },
      async setup(hostConfig: ChannelSetup) {
        const intercepted: ChannelSetup = {
          ...hostConfig,
          onInbound: createPairingInterceptor(botIdentityPromise, hostConfig.onInbound, token),
        };
        // Push bot command menu — fire-and-forget so a Telegram outage at
        // startup doesn't block adapter setup.
        pushTelegramBotCommands(token, TELEGRAM_BOT_COMMANDS).catch((err) => {
          log.warn('Telegram setMyCommands at startup failed', { err });
        });
        return withRetry(() => bridge.setup(intercepted), 'bridge.setup');
      },
    };
    return wrapped;
  },
});
