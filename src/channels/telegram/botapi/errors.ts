export type TelegramErrorKind =
  | 'rate_limit'
  | 'bad_request'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'server'
  | 'network'
  | 'timeout';

export interface TelegramErrorInit {
  method: string;
  kind: TelegramErrorKind;
  code: number;
  description: string;
  retryAfter?: number;
  migrateToChatId?: number;
}

/**
 * Error from a Bot API call. `code` is the HTTP/`error_code` status, or 0 for
 * network/timeout failures that never produced a response. Messages never
 * contain the bot token (the client redacts it before constructing this).
 */
export class TelegramError extends Error {
  readonly method: string;
  readonly kind: TelegramErrorKind;
  readonly code: number;
  readonly description: string;
  readonly retryAfter?: number;
  readonly migrateToChatId?: number;

  constructor(init: TelegramErrorInit) {
    super(`Telegram ${init.method} failed: ${init.kind} (${init.code}) ${init.description}`);
    this.name = 'TelegramError';
    this.method = init.method;
    this.kind = init.kind;
    this.code = init.code;
    this.description = init.description;
    this.retryAfter = init.retryAfter;
    this.migrateToChatId = init.migrateToChatId;
  }

  /**
   * True when the request may have reached Telegram and taken effect (timeout
   * after send, or a connection dropped mid-flight). Callers must treat the
   * outcome as unknown and must not blindly retry non-idempotent sends.
   * 5xx counts too: Telegram's front end can return 500/502/504 after the
   * backend already processed the request.
   */
  get uncertain(): boolean {
    return this.kind === 'timeout' || this.kind === 'server' || (this.kind === 'network' && !this.preSend);
  }

  /** Set by the client for network failures known to happen before any byte was sent. */
  preSend = false;
}

/** Thrown by downloadFile when the file exceeds the size guard. */
export class FileTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly actualBytes?: number,
  ) {
    super(`Telegram file exceeds maxBytes=${maxBytes}${actualBytes ? ` (size ${actualBytes})` : ''}`);
    this.name = 'FileTooLargeError';
  }
}
