// nanoclaw-fork: runner -> host UI telemetry (turn / preview / progress).
//
// Contract C3 of the nanoclaw fork: the runner writes `kind:'system'` outbound
// rows with `action` in {turn, preview, progress}; the host registers an
// unguarded delivery action per name and drives the Telegram live draft from
// them. Everything here is best-effort UI sugar: a failed write is logged and
// dropped, never allowed to fail the turn.
//
//   turn     {action, turnId, state: started|finished|cancelled|failed, at}
//   preview  {action, turnId, seq, text}   cumulative text of the current <message> block
//   progress {action, turnId, seq, step: {id, label, state, ms?}}
//
// `turnId` is the id of the first inbound row of the batch. `at` is epoch ms.
import { findByName } from './destinations.js';
import { writeMessageOut } from './db/messages-out.js';
import type { RoutingContext } from './formatter.js';
import { stripHarnessTagArtifacts } from './harness-tag-strip.js';
import { OVERLOAD_PROGRESS_LABEL } from './failure-class.js';

function log(msg: string): void {
  console.error(`[turn-telemetry] ${msg}`);
}

/** At most one preview row per window; the latest text is flushed at the window end. */
export const PREVIEW_INTERVAL_MS = 700;
/** Preview text cap (Telegram message limit is 4096; keep the tail, it is what the user is reading). */
export const PREVIEW_MAX_CHARS = 3800;
/** Hard bound on progress steps per turn. */
export const MAX_STEPS_PER_TURN = 60;
/** A `stopped` partial older than this is not attached to a later /stop. */
const STOPPED_TTL_MS = 30_000;

// ── Preview extraction ──

const INTERNAL_SPAN_RE = /<internal\b[\s\S]*?<\/internal>/gi;
const OPEN_INTERNAL_RE = /<internal\b/i;
const MESSAGE_OPEN_RE = /<message\s+to="([^"]+)"\s*>/g;
const CLOSE_TAG = '</message>';

export interface ExtractedPreview {
  /** User-visible text of the current origin-addressed block, wrapper tags stripped. */
  text: string;
  /** The block's `</message>` has been seen, i.e. the mid-turn door has delivered it already. */
  closed: boolean;
}

/**
 * Extract the preview from the text streamed so far in the current assistant
 * message. Picks the LAST `<message to="X">` block whose X resolves to the
 * origin chat, takes everything after its open tag up to `</message>` (or the
 * end, for a block still streaming), drops `<internal>` spans and a trailing
 * partial `</message` tag. Returns null when there is no such block yet.
 */
export function extractPreview(accumulated: string, isOrigin: (name: string) => boolean): ExtractedPreview | null {
  // Complete internal spans are scratchpad; an unclosed one hides the rest.
  let visible = accumulated.replace(INTERNAL_SPAN_RE, '');
  const openInternal = OPEN_INTERNAL_RE.exec(visible);
  if (openInternal) visible = visible.slice(0, openInternal.index);

  let best: { bodyStart: number } | null = null;
  MESSAGE_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MESSAGE_OPEN_RE.exec(visible)) !== null) {
    if (isOrigin(m[1])) best = { bodyStart: m.index + m[0].length };
  }
  if (!best) return null;

  const rest = visible.slice(best.bodyStart);
  const closeAt = rest.indexOf(CLOSE_TAG);
  let body: string;
  let closed = false;
  if (closeAt !== -1) {
    body = rest.slice(0, closeAt);
    closed = true;
  } else {
    body = rest;
    // A partially streamed "</mess" must not flash in the preview.
    for (let k = Math.min(CLOSE_TAG.length - 1, body.length); k >= 1; k--) {
      if (body.endsWith(CLOSE_TAG.slice(0, k))) {
        body = body.slice(0, body.length - k);
        break;
      }
    }
  }
  let text = stripHarnessTagArtifacts(body).trim();
  if (text.length > PREVIEW_MAX_CHARS) text = '…' + text.slice(text.length - PREVIEW_MAX_CHARS + 1);
  return { text, closed };
}

// ── Progress labels ──

function basename(p: unknown): string {
  if (typeof p !== 'string' || !p) return '';
  return p.split(/[\\/]/).filter(Boolean).pop() ?? '';
}

/** Single-line, bounded, printable-only: labels travel to a chat. */
function sanitize(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

function hostOf(url: unknown): string {
  if (typeof url !== 'string') return '';
  try {
    return new URL(url).hostname.slice(0, 60);
  } catch {
    return '';
  }
}

const BROWSER_CMD_RE = /\bagent-browser\b/;
const URL_IN_CMD_RE = /https?:\/\/[^\s'"`<>|;&]+/;
const NCL_TASKS_RE = /\bncl\s+tasks\b/;

/**
 * Fixed Russian label for a tool call, or null when the tool is not surfaced.
 * Never echoes raw arguments: only a hostname, a file basename, or a
 * truncated search query make it through.
 */
export function labelForTool(toolName: string, toolInput: unknown): string | null {
  const input = (toolInput && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  switch (toolName) {
    case 'WebFetch': {
      const host = hostOf(input.url);
      return host ? `Открываю страницу ${host}` : 'Открываю страницу';
    }
    case 'WebSearch': {
      const q = typeof input.query === 'string' ? sanitize(input.query, 40) : '';
      return q ? `Ищу: ${q}` : 'Ищу в интернете';
    }
    case 'Read': {
      const b = sanitize(basename(input.file_path), 60);
      return b ? `Читаю ${b}` : 'Читаю файл';
    }
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const b = sanitize(basename(input.file_path ?? input.notebook_path), 60);
      return b ? `Пишу ${b}` : 'Пишу файл';
    }
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (NCL_TASKS_RE.test(cmd)) return 'Планирую задачу';
      if (BROWSER_CMD_RE.test(cmd)) {
        const host = hostOf(URL_IN_CMD_RE.exec(cmd)?.[0]);
        return host ? `Открываю страницу ${host}` : 'Открываю страницу';
      }
      return 'Выполняю команду';
    }
    case 'Task':
    case 'Agent':
      return 'Подзадача';
    default: {
      if (toolName.startsWith('mcp__')) {
        const short = sanitize(toolName.split('__').slice(2).join('__') || toolName, 40).replace(/[^\w.\- ]/g, '');
        return `Инструмент ${short}`;
      }
      return null;
    }
  }
}

// ── Telemetry ──

export type TurnEndState = 'finished' | 'cancelled' | 'failed';

interface ActiveTurn {
  turnId: string;
  routing: RoutingContext;
  startedAt: number;
  previewSeq: number;
  progressSeq: number;
  steps: Map<string, { at: number; label: string }>; // tool_use_id -> running step
  stepCount: number;
  accum: string;
  lastEmittedText: string | null;
  lastEmitAt: number;
  /** Latest extracted preview (emitted or still pending the throttle). */
  latest: ExtractedPreview | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** The «модель перегружена» step is currently shown as running. */
  retrying: boolean;
}

export interface StoppedTurn {
  routing: RoutingContext;
  /** Text of a block that was still streaming when the turn was cancelled ('' when none). */
  partial: string;
  at: number;
}

export interface TurnTelemetryDeps {
  now?: () => number;
  write?: (row: { kind: string; platform_id: string | null; channel_type: string | null; thread_id: string | null; in_reply_to: string | null; content: string }) => Promise<unknown>;
  isOriginDestination?: (name: string, routing: RoutingContext) => boolean;
  previewIntervalMs?: number;
}

let idCounter = 0;
function generateId(): string {
  return `tm-${Date.now()}-${(idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function defaultIsOrigin(name: string, routing: RoutingContext): boolean {
  const dest = findByName(name);
  return !!dest && dest.type === 'channel' && dest.channelType === routing.channelType && dest.platformId === routing.platformId;
}

export class TurnTelemetry {
  // Off until the runner entry point enables it (index.ts), so library/test
  // callers of processQuery see no extra outbound rows.
  private enabled = false;
  private cur: ActiveTurn | null = null;
  private stopped: StoppedTurn | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly write: NonNullable<TurnTelemetryDeps['write']>;
  private readonly isOrigin: NonNullable<TurnTelemetryDeps['isOriginDestination']>;
  private readonly previewInterval: number;

  constructor(deps: TurnTelemetryDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.write =
      deps.write ??
      ((row) =>
        writeMessageOut({
          id: generateId(),
          in_reply_to: row.in_reply_to,
          kind: row.kind,
          platform_id: row.platform_id,
          channel_type: row.channel_type,
          thread_id: row.thread_id,
          content: row.content,
        }));
    this.isOrigin = deps.isOriginDestination ?? defaultIsOrigin;
    this.previewInterval = deps.previewIntervalMs ?? PREVIEW_INTERVAL_MS;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.dropActive();
  }

  /** Resolves when every row queued so far has been written (tests, shutdown). */
  flush(): Promise<void> {
    return this.chain.then(
      () => undefined,
      () => undefined,
    );
  }

  get activeTurnId(): string | null {
    return this.cur?.turnId ?? null;
  }

  private emit(turn: ActiveTurn, payload: Record<string, unknown>): void {
    const row = {
      kind: 'system',
      platform_id: turn.routing.platformId,
      channel_type: turn.routing.channelType,
      thread_id: turn.routing.threadId,
      in_reply_to: turn.routing.inReplyTo,
      content: JSON.stringify({ ...payload, turnId: turn.turnId }),
    };
    this.chain = this.chain
      .then(() => this.write(row))
      .catch((err) => log(`write failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * Open a turn. No-op (telemetry off for this turn) for task runs and for
   * batches without a chat route: there is no one to draw a draft for.
   */
  beginTurn(turnId: string | undefined, routing: RoutingContext): void {
    this.dropActive();
    this.stopped = null;
    if (!this.enabled || !turnId || routing.taskRun || !routing.platformId || !routing.channelType) return;
    const turn: ActiveTurn = {
      turnId,
      routing: { ...routing },
      startedAt: this.now(),
      previewSeq: 0,
      progressSeq: 0,
      steps: new Map(),
      stepCount: 0,
      accum: '',
      lastEmittedText: null,
      lastEmitAt: 0,
      latest: null,
      timer: null,
      retrying: false,
    };
    this.cur = turn;
    this.emit(turn, { action: 'turn', state: 'started', at: turn.startedAt });
  }

  private dropActive(): void {
    if (this.cur?.timer) clearTimeout(this.cur.timer);
    this.cur = null;
  }

  /** A new assistant message started streaming: delta accumulation restarts. */
  onDeltaReset(): void {
    if (this.cur) this.cur.accum = '';
  }

  /** The SDK is retrying an overloaded API call: show it as a progress step (once per outage). */
  apiRetry(): void {
    const turn = this.cur;
    if (!turn || turn.retrying) return;
    turn.retrying = true;
    this.emit(turn, {
      action: 'progress',
      seq: ++turn.progressSeq,
      step: { id: 'api-retry', label: OVERLOAD_PROGRESS_LABEL, state: 'running' },
    });
  }

  private clearRetry(turn: ActiveTurn): void {
    if (!turn.retrying) return;
    turn.retrying = false;
    this.emit(turn, {
      action: 'progress',
      seq: ++turn.progressSeq,
      step: { id: 'api-retry', label: OVERLOAD_PROGRESS_LABEL, state: 'done' },
    });
  }

  onDelta(text: string): void {
    const turn = this.cur;
    if (!turn || !text) return;
    this.clearRetry(turn); // the model answers again: the outage is over
    turn.accum += text;
    // Bounded: a single message cannot usefully exceed this for a preview.
    if (turn.accum.length > PREVIEW_MAX_CHARS * 4) turn.accum = turn.accum.slice(-PREVIEW_MAX_CHARS * 3);
    const extracted = extractPreview(turn.accum, (name) => this.isOrigin(name, turn.routing));
    if (!extracted) return;
    turn.latest = extracted;
    if (!extracted.text || extracted.text === turn.lastEmittedText) return;
    this.schedulePreview(turn);
  }

  private schedulePreview(turn: ActiveTurn): void {
    if (turn.timer) return; // the pending flush will pick up the latest text
    const wait = Math.max(0, turn.lastEmitAt + this.previewInterval - this.now());
    if (wait === 0) {
      this.emitPreview(turn);
      return;
    }
    turn.timer = setTimeout(() => {
      turn.timer = null;
      if (this.cur === turn) this.emitPreview(turn);
    }, wait);
    (turn.timer as { unref?: () => void }).unref?.();
  }

  private emitPreview(turn: ActiveTurn): void {
    const text = turn.latest?.text;
    if (!text || text === turn.lastEmittedText) return;
    turn.lastEmittedText = text;
    turn.lastEmitAt = this.now();
    this.emit(turn, { action: 'preview', seq: ++turn.previewSeq, text });
  }

  toolStart(toolUseId: string | undefined, toolName: string, toolInput: unknown): void {
    const turn = this.cur;
    if (!turn || !toolUseId || turn.steps.has(toolUseId)) return;
    this.clearRetry(turn);
    if (turn.stepCount >= MAX_STEPS_PER_TURN) return;
    const label = labelForTool(toolName, toolInput);
    if (!label) return;
    turn.stepCount++;
    turn.steps.set(toolUseId, { at: this.now(), label });
    this.emit(turn, { action: 'progress', seq: ++turn.progressSeq, step: { id: toolUseId, label, state: 'running' } });
  }

  toolEnd(toolUseId: string | undefined, ok: boolean, durationMs?: number): void {
    const turn = this.cur;
    if (!turn || !toolUseId) return;
    const step = turn.steps.get(toolUseId);
    if (!step) return;
    const { label } = step;
    turn.steps.delete(toolUseId);
    const ms = typeof durationMs === 'number' && durationMs >= 0 ? Math.round(durationMs) : this.now() - step.at;
    this.emit(turn, {
      action: 'progress',
      seq: ++turn.progressSeq,
      step: { id: toolUseId, label, state: ok ? 'done' : 'failed', ms },
    });
  }

  /** Close the active turn. A cancelled turn remembers its unfinished block for /stop. */
  endTurn(state: TurnEndState): void {
    const turn = this.cur;
    if (!turn) return;
    if (turn.timer) clearTimeout(turn.timer);
    turn.timer = null;
    if (state === 'cancelled') {
      this.stopped = {
        routing: turn.routing,
        partial: turn.latest && !turn.latest.closed ? turn.latest.text : '',
        at: this.now(),
      };
    }
    this.cur = null;
    this.emit(turn, { action: 'turn', state, at: this.now() });
  }

  /** The cancelled turn's unfinished text, for the /stop chat row. Single use; expires. */
  takeStopped(): StoppedTurn | null {
    const s = this.stopped;
    this.stopped = null;
    if (!s || this.now() - s.at > STOPPED_TTL_MS) return null;
    return s;
  }
}

export const turnTelemetry = new TurnTelemetry();
