/**
 * Hand-written Telegram Bot API 10.3 types: only the methods/objects this
 * channel uses. Every field name and type comes from the local docs cache
 * (~/.claude/skills/telegram-docs/cache/bot-api/<name>.md), not from memory.
 *
 * Documented gaps / ambiguities (also listed in the implementation report):
 *  - Objects that are only referenced, never read or written by us
 *    (BusinessConnection, Poll, MessageReactionUpdated, ChatMemberUpdated, ...)
 *    are typed `unknown` inside `Update`.
 *  - `Message` models a subset of the ~100 documented fields (see message.md).
 *  - `RichBlockTableCell.align` / `valign` have no "Optional." marker in
 *    richblocktablecell.md although every other optional field has one; we
 *    treat them as optional.
 *  - `InputRichBlockList` has no "ordered" flag; ordered-ness is expressed only
 *    through the per-item `value` / `type` fields (inputrichblocklistitem.md).
 *  - `InputRichBlockExpandableBlockQuotation` carries `text: RichText` (inline
 *    only), unlike `InputRichBlockBlockQuotation` which carries `blocks`.
 *  - RichText newlines: docs never say whether "\n" inside a plain string is a
 *    line break (HTML uses <br>); we assume it is.
 *  - `reply_markup` is typed as InlineKeyboardMarkup only; ReplyKeyboardMarkup,
 *    ReplyKeyboardRemove and ForceReply are not modelled.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Envelope of every Bot API response (making-requests.md, responseparameters.md). */
export interface ResponseParameters {
  migrate_to_chat_id?: number;
  retry_after?: number;
}

export type ApiResponse<T> =
  | { ok: true; result: T; description?: string }
  | { ok: false; description?: string; error_code?: number; parameters?: ResponseParameters };

/** Binary upload (inputfile.md): sent as a multipart/form-data part. */
export class InputFile {
  constructor(
    readonly data: Buffer | Uint8Array,
    readonly filename: string,
    readonly contentType?: string,
  ) {}
}

// ---------------------------------------------------------------------------
// Core objects
// ---------------------------------------------------------------------------

export interface User {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: true;
  added_to_attachment_menu?: true;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_guest_queries?: boolean;
  supports_inline_queries?: boolean;
  can_connect_to_business?: boolean;
  has_main_web_app?: boolean;
  has_topics_enabled?: boolean;
  allows_users_to_create_topics?: boolean;
  can_manage_bots?: boolean;
  supports_join_request_queries?: boolean;
}

export interface Chat {
  id: number;
  /** “private”, “group”, “supergroup” or “channel” */
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: true;
  is_direct_messages?: true;
}

export interface MessageEntity {
  /** mention, hashtag, cashtag, bot_command, url, email, ... text_link, text_mention, pre, custom_emoji, date_time, ... */
  type: string;
  /** UTF-16 code units */
  offset: number;
  /** UTF-16 code units */
  length: number;
  url?: string;
  user?: User;
  language?: string;
  custom_emoji_id?: string;
  unix_time?: number;
  date_time_format?: string;
}

export interface PhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface Document {
  file_id: string;
  file_unique_id: string;
  thumbnail?: PhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface File {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/** Incoming rich message (richmessage.md). Blocks (RichBlock) are not modelled. */
export interface RichMessage {
  blocks: unknown[];
  is_rtl?: boolean;
}

/** Subset of message.md. */
export interface Message {
  message_id: number;
  message_thread_id?: number;
  from?: User;
  sender_chat?: Chat;
  date: number;
  /** Set on guest messages; pass to answerGuestQuery. */
  guest_query_id?: string;
  guest_bot_caller_user?: User;
  guest_bot_caller_chat?: Chat;
  business_connection_id?: string;
  chat: Chat;
  is_topic_message?: true;
  reply_to_message?: Message;
  via_bot?: User;
  edit_date?: number;
  media_group_id?: string;
  text?: string;
  entities?: MessageEntity[];
  rich_message?: RichMessage;
  document?: Document;
  photo?: PhotoSize[];
  caption?: string;
  caption_entities?: MessageEntity[];
}

export interface InaccessibleMessage {
  chat: Chat;
  message_id: number;
  /** Always 0 */
  date: 0;
}
export type MaybeInaccessibleMessage = Message | InaccessibleMessage;

export interface CallbackQuery {
  id: string;
  from: User;
  message?: MaybeInaccessibleMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
  game_short_name?: string;
}

/** update.md + messagegenerationstopped.md */
export interface MessageGenerationStopped {
  chat: Chat;
  message_thread_id?: number;
  draft_id: number;
}

export interface Update {
  update_id: number;
  message?: Message;
  edited_message?: Message;
  channel_post?: Message;
  edited_channel_post?: Message;
  business_connection?: unknown;
  business_message?: Message;
  edited_business_message?: Message;
  deleted_business_messages?: unknown;
  guest_message?: Message;
  message_reaction?: unknown;
  message_reaction_count?: unknown;
  inline_query?: unknown;
  chosen_inline_result?: unknown;
  callback_query?: CallbackQuery;
  shipping_query?: unknown;
  pre_checkout_query?: unknown;
  purchased_paid_media?: unknown;
  poll?: unknown;
  poll_answer?: unknown;
  my_chat_member?: unknown;
  chat_member?: unknown;
  chat_join_request?: unknown;
  chat_boost?: unknown;
  removed_chat_boost?: unknown;
  managed_bot?: unknown;
  subscription?: unknown;
  stopped_message_generation?: MessageGenerationStopped;
}

export type UpdateType = Exclude<keyof Update, 'update_id'>;

export interface ReplyParameters {
  message_id?: number;
  chat_id?: number | string;
  ephemeral_message_id?: number;
  allow_sending_without_reply?: boolean;
  quote?: string;
  quote_parse_mode?: string;
  quote_entities?: MessageEntity[];
  quote_position?: number;
  checklist_task_id?: number;
  poll_option_id?: string;
}

export interface LinkPreviewOptions {
  is_disabled?: boolean;
  url?: string;
  prefer_small_media?: boolean;
  prefer_large_media?: boolean;
  show_above_text?: boolean;
}

/** ephemeralmessageparameters.md */
export interface EphemeralMessageParameters {
  receiver_user_id: number;
  callback_query_id?: string;
  replace_callback_query_message?: boolean;
}

// ---------------------------------------------------------------------------
// Keyboards
// ---------------------------------------------------------------------------

export interface WebAppInfo {
  url: string;
}
export interface LoginUrl {
  url: string;
  forward_text?: string;
  bot_username?: string;
  request_write_access?: boolean;
}
export interface SwitchInlineQueryChosenChat {
  query?: string;
  allow_user_chats?: boolean;
  allow_bot_chats?: boolean;
  allow_group_chats?: boolean;
  allow_channel_chats?: boolean;
}
export interface CopyTextButton {
  text: string;
}
/** “Currently holds no information.” */
export type DisabledButton = Record<string, never>;

/** Exactly one of the fields other than text / icon_custom_emoji_id / style must be set. */
export interface InlineKeyboardButton {
  text: string;
  icon_custom_emoji_id?: string;
  /** “danger”, “success” or “primary” */
  style?: 'danger' | 'success' | 'primary';
  url?: string;
  /** 1-64 bytes */
  callback_data?: string;
  web_app?: WebAppInfo;
  login_url?: LoginUrl;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  switch_inline_query_chosen_chat?: SwitchInlineQueryChosenChat;
  copy_text?: CopyTextButton;
  callback_game?: Record<string, never>;
  pay?: boolean;
  disabled?: DisabledButton;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
  force_reply?: boolean;
}

// ---------------------------------------------------------------------------
// Bot commands / menu button
// ---------------------------------------------------------------------------

export interface BotCommand {
  /** 1-32 chars, lowercase letters, digits, underscore */
  command: string;
  /** 1-256 chars */
  description: string;
  is_ephemeral?: boolean;
}

export type BotCommandScope =
  | { type: 'default' }
  | { type: 'all_private_chats' }
  | { type: 'all_group_chats' }
  | { type: 'all_chat_administrators' }
  | { type: 'chat'; chat_id: number | string }
  | { type: 'chat_administrators'; chat_id: number | string }
  | { type: 'chat_member'; chat_id: number | string; user_id: number };

export type MenuButton =
  | { type: 'commands' }
  | { type: 'web_app'; text: string; web_app: WebAppInfo }
  | { type: 'default' };

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/** Only the emoji reaction type is modelled (reactiontypeemoji.md). */
export interface ReactionTypeEmoji {
  type: 'emoji';
  emoji: string;
}
export type ReactionType = ReactionTypeEmoji;

export type ChatAction =
  | 'typing'
  | 'upload_photo'
  | 'record_video'
  | 'upload_video'
  | 'record_voice'
  | 'upload_voice'
  | 'upload_document'
  | 'choose_sticker'
  | 'find_location'
  | 'record_video_note'
  | 'upload_video_note';

// ---------------------------------------------------------------------------
// Rich messages: RichText (richtext*.md)
// ---------------------------------------------------------------------------

export interface RichTextBold {
  type: 'bold';
  text: RichText;
}
export interface RichTextItalic {
  type: 'italic';
  text: RichText;
}
export interface RichTextUnderline {
  type: 'underline';
  text: RichText;
}
export interface RichTextStrikethrough {
  type: 'strikethrough';
  text: RichText;
}
export interface RichTextSpoiler {
  type: 'spoiler';
  text: RichText;
}
export interface RichTextSubscript {
  type: 'subscript';
  text: RichText;
}
export interface RichTextSuperscript {
  type: 'superscript';
  text: RichText;
}
export interface RichTextMarked {
  type: 'marked';
  text: RichText;
}
export interface RichTextCode {
  type: 'code';
  text: RichText;
}
export interface RichTextMathematicalExpression {
  type: 'mathematical_expression';
  /** LaTeX */
  expression: string;
}
export interface RichTextUrl {
  type: 'url';
  text: RichText;
  url: string;
}
export interface RichTextEmailAddress {
  type: 'email_address';
  text: RichText;
  email_address: string;
}

/**
 * String (plain text), array of RichText, or a typed run. The docs list ~26
 * run types; only those we emit are modelled.
 */
export type RichText =
  | string
  | RichText[]
  | RichTextBold
  | RichTextItalic
  | RichTextUnderline
  | RichTextStrikethrough
  | RichTextSpoiler
  | RichTextSubscript
  | RichTextSuperscript
  | RichTextMarked
  | RichTextCode
  | RichTextMathematicalExpression
  | RichTextUrl
  | RichTextEmailAddress;

// ---------------------------------------------------------------------------
// Rich messages: blocks (inputrichblock*.md). Media/anchor/map/collage/
// slideshow blocks are deliberately not modelled: agent output never emits them.
// ---------------------------------------------------------------------------

export interface RichBlockTableCell {
  text?: RichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
}

export interface RichMessageButton {
  /** Plain text, custom emoji and date-time entities only. */
  text: RichText;
  style?: 'danger' | 'success' | 'primary' | 'link';
  /** Exactly one of the following must be set. */
  url?: string;
  callback_data?: string;
  web_app?: WebAppInfo;
  login_url?: LoginUrl;
  switch_inline_query?: string;
  switch_inline_query_current_chat?: string;
  switch_inline_query_chosen_chat?: SwitchInlineQueryChosenChat;
  copy_text?: CopyTextButton;
  disabled?: DisabledButton;
}

export interface InputRichBlockListItem {
  blocks: InputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  /** Ordered lists only. */
  value?: number;
  /** Ordered lists only: “a”, “A”, “i”, “I” or “1”. */
  type?: 'a' | 'A' | 'i' | 'I' | '1';
}

export type InputRichBlock =
  | { type: 'paragraph'; text: RichText }
  | { type: 'heading'; text: RichText; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: 'pre'; text: RichText; language?: string }
  | { type: 'footer'; text: RichText }
  | { type: 'divider' }
  | { type: 'mathematical_expression'; expression: string }
  | { type: 'list'; items: InputRichBlockListItem[] }
  | { type: 'blockquote'; blocks: InputRichBlock[]; credit?: RichText }
  | { type: 'expandable_blockquote'; text: RichText; credit?: RichText }
  | { type: 'pullquote'; text: RichText; credit?: RichText }
  | {
      type: 'table';
      cells: RichBlockTableCell[][];
      is_bordered?: true;
      is_striped?: true;
      is_compact?: true;
      caption?: RichText;
    }
  | { type: 'details'; summary: RichText; blocks: InputRichBlock[]; is_open?: true }
  | { type: 'buttons'; buttons: RichMessageButton[]; align?: 'left' | 'center' | 'right' }
  /** Allowed only in sendRichMessageDraft. */
  | { type: 'thinking'; text: RichText };

/** Exactly one of html / markdown / blocks must be used. */
export interface InputRichMessage {
  blocks?: InputRichBlock[];
  html?: string;
  markdown?: string;
  media?: unknown[];
  is_rtl?: boolean;
  skip_entity_detection?: boolean;
}

// ---------------------------------------------------------------------------
// Guest bots (answerguestquery.md, inlinequeryresultarticle.md, ...)
// ---------------------------------------------------------------------------

export interface InputTextMessageContent {
  message_text: string;
  parse_mode?: string;
  entities?: MessageEntity[];
  link_preview_options?: LinkPreviewOptions;
}
export interface InputRichMessageContent {
  /** Only previously uploaded files may be used. */
  rich_message: InputRichMessage;
}
export type InputMessageContent = InputTextMessageContent | InputRichMessageContent;

export interface InlineQueryResultArticle {
  type: 'article';
  /** 1-64 bytes */
  id: string;
  title: string;
  input_message_content: InputMessageContent;
  reply_markup?: InlineKeyboardMarkup;
  url?: string;
  description?: string;
  thumbnail_url?: string;
  thumbnail_width?: number;
  thumbnail_height?: number;
}
/** answerGuestQuery takes any InlineQueryResult; only article is modelled. */
export type InlineQueryResult = InlineQueryResultArticle;

export interface SentGuestMessage {
  inline_message_id: string;
}

// ---------------------------------------------------------------------------
// Method params
// ---------------------------------------------------------------------------

export type ChatId = number | string;

/** Fields shared by the send* methods (sendmessage.md, sendrichmessage.md, ...). */
export interface SendCommon {
  business_connection_id?: string;
  chat_id: ChatId;
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  ephemeral_message_parameters?: EphemeralMessageParameters;
  disable_notification?: boolean;
  protect_content?: boolean;
  allow_paid_broadcast?: boolean;
  message_effect_id?: string;
  /** SuggestedPostParameters is not modelled. */
  suggested_post_parameters?: Record<string, unknown>;
  reply_parameters?: ReplyParameters;
  reply_markup?: InlineKeyboardMarkup;
}

export interface SendMessageParams extends SendCommon {
  /** 1-4096 characters after entity parsing */
  text: string;
  parse_mode?: string;
  entities?: MessageEntity[];
  link_preview_options?: LinkPreviewOptions;
}

export interface SendRichMessageParams extends SendCommon {
  rich_message: InputRichMessage;
}

export interface SendRichMessageDraftParams {
  /** Private chats only. */
  chat_id: number;
  message_thread_id?: number;
  /** Non-zero; same id animates changes. */
  draft_id: number;
  rich_message: InputRichMessage;
  can_stop?: boolean;
  keep_on_stop?: boolean;
}

/** Private chats only. Empty `text` shows the native «Thinking…» placeholder; the same draft_id animates changes. */
export interface SendMessageDraftParams {
  chat_id: number;
  message_thread_id?: number;
  /** Non-zero; same id animates changes. */
  draft_id: number;
  text?: string;
  can_stop?: boolean;
  keep_on_stop?: boolean;
}

export interface EditMessageTextParams {
  business_connection_id?: string;
  /** Required if inline_message_id is not specified. */
  chat_id?: ChatId;
  message_id?: number;
  inline_message_id?: string;
  /** Required if rich_message isn't specified. */
  text?: string;
  parse_mode?: string;
  entities?: MessageEntity[];
  link_preview_options?: LinkPreviewOptions;
  /** Required if text isn't specified. */
  rich_message?: InputRichMessage;
  reply_markup?: InlineKeyboardMarkup;
}

export interface EditMessageReplyMarkupParams {
  business_connection_id?: string;
  chat_id?: ChatId;
  message_id?: number;
  inline_message_id?: string;
  reply_markup?: InlineKeyboardMarkup;
}

export interface SendDocumentParams extends SendCommon {
  document: InputFile | string;
  thumbnail?: InputFile | string;
  /** 0-1024 characters after entities parsing */
  caption?: string;
  parse_mode?: string;
  caption_entities?: MessageEntity[];
  disable_content_type_detection?: boolean;
}

export interface SendPhotoParams extends SendCommon {
  photo: InputFile | string;
  caption?: string;
  parse_mode?: string;
  caption_entities?: MessageEntity[];
  show_caption_above_media?: boolean;
  has_spoiler?: boolean;
}

export interface Methods {
  getMe: { params: Record<string, never>; result: User };
  getUpdates: {
    params: { offset?: number; limit?: number; timeout?: number; allowed_updates?: UpdateType[] };
    result: Update[];
  };
  getFile: { params: { file_id: string }; result: File };
  sendMessage: { params: SendMessageParams; result: Message };
  sendRichMessage: { params: SendRichMessageParams; result: Message };
  sendRichMessageDraft: { params: SendRichMessageDraftParams; result: true };
  sendMessageDraft: { params: SendMessageDraftParams; result: true };
  editMessageText: { params: EditMessageTextParams; result: Message | true };
  editMessageReplyMarkup: { params: EditMessageReplyMarkupParams; result: Message | true };
  deleteMessage: { params: { chat_id: ChatId; message_id: number }; result: true };
  answerCallbackQuery: {
    params: {
      callback_query_id: string;
      /** 0-200 characters */
      text?: string;
      show_alert?: boolean;
      url?: string;
      cache_time?: number;
    };
    result: true;
  };
  answerGuestQuery: {
    params: { guest_query_id: string; result: InlineQueryResult };
    result: SentGuestMessage;
  };
  setMyCommands: {
    params: { commands: BotCommand[]; scope?: BotCommandScope; language_code?: string };
    result: true;
  };
  getMyCommands: {
    params: { scope?: BotCommandScope; language_code?: string };
    result: BotCommand[];
  };
  /** description: 0-512 characters; empty resets to the default. */
  setMyDescription: { params: { description?: string; language_code?: string }; result: true };
  getMyDescription: { params: { language_code?: string }; result: { description: string } };
  /** short_description: 0-120 characters (shown on the profile and in shares). */
  setMyShortDescription: { params: { short_description?: string; language_code?: string }; result: true };
  getMyShortDescription: { params: { language_code?: string }; result: { short_description: string } };
  setChatMenuButton: {
    params: { chat_id?: number; menu_button?: MenuButton };
    result: true;
  };
  setMessageReaction: {
    params: { chat_id: ChatId; message_id: number; reaction?: ReactionType[]; is_big?: boolean };
    result: true;
  };
  sendChatAction: {
    params: {
      business_connection_id?: string;
      chat_id: ChatId;
      message_thread_id?: number;
      action: ChatAction;
    };
    result: true;
  };
  sendDocument: { params: SendDocumentParams; result: Message };
  sendPhoto: { params: SendPhotoParams; result: Message };
  leaveChat: { params: { chat_id: ChatId }; result: true };
}

export type MethodName = keyof Methods;
