/**
 * nanoclaw-fork: product MCP tools that make the host render buttons.
 *
 * The model never writes button markup (ux §3.2). It asks for buttons through
 * these structured tools; the Telegram adapter renders them:
 *
 *   suggest_replies   non-blocking follow-up buttons on the turn's final answer
 *                     (stamped as `content.nc.suggest` by writeMessageOut)
 *   send_reminder     a fired reminder with [Сделано] [Отложить на час]
 *                     (`content.nc.reminder = {seriesId}`)
 *   send_task_created the confirmation of a created task/reminder with
 *                     [Отменить] [Изменить время] (`content.nc.taskCreated = {seriesId}`)
 */
import { getCurrentInReplyTo, setPendingSuggestions } from '../db/session-state.js';
import { writeMessageOut } from '../db/messages-out.js';
import { destinationList, resolveRouting } from './core.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

export const MAX_SUGGESTIONS = 3;
export const MAX_SUGGESTION_CHARS = 40;

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

/** Trim, drop empties and duplicates, cap the count and the label length. */
export function normalizeSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    // eslint-disable-next-line no-control-regex
    const label = item.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!label || label.length > MAX_SUGGESTION_CHARS || out.includes(label)) continue;
    out.push(label);
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

export const suggestReplies: McpToolDefinition = {
  tool: {
    name: 'suggest_replies',
    description:
      'Attach up to 3 tap-to-send follow-up buttons to the final answer of this turn. Call it BEFORE your final answer; it returns immediately and does not wait. A tap sends the button text back to you as the user\'s next message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        replies: {
          type: 'array',
          items: { type: 'string' },
          maxItems: MAX_SUGGESTIONS,
          description: `1-${MAX_SUGGESTIONS} short labels (max ${MAX_SUGGESTION_CHARS} chars) in the user's language, phrased as the user would say them (e.g. "Сделай план").`,
        },
      },
      required: ['replies'],
    },
  },
  async handler(args) {
    const replies = normalizeSuggestions(args.replies ?? args.options);
    if (replies.length === 0) {
      return err(`replies must be 1-${MAX_SUGGESTIONS} non-empty strings of at most ${MAX_SUGGESTION_CHARS} chars`);
    }
    setPendingSuggestions(replies);
    log(`suggest_replies: ${replies.length} button(s)`);
    return ok(`${replies.length} suggestion button(s) will be attached to your next message to the user.`);
  },
};

async function sendMarked(
  tool: string,
  marker: 'reminder' | 'taskCreated',
  args: Record<string, unknown>,
) {
  const to = args.to as string;
  const text = args.text as string;
  const seriesId = args.seriesId as string;
  if (!to) return err(`to is required. Options: ${destinationList()}`);
  if (!text) return err('text is required');
  if (!seriesId || typeof seriesId !== 'string') return err('seriesId is required (the id of the task from `ncl tasks`)');

  const routing = resolveRouting(to);
  if ('error' in routing) return err(routing.error);

  const seq = await writeMessageOut({
    id: generateId(),
    in_reply_to: getCurrentInReplyTo(),
    kind: 'chat',
    platform_id: routing.platform_id,
    channel_type: routing.channel_type,
    thread_id: routing.thread_id,
    content: JSON.stringify({ text, nc: { [marker]: { seriesId } } }),
  });
  log(`${tool}: #${seq} → ${routing.resolvedName}`);
  return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
}

const MARKED_SCHEMA = {
  type: 'object' as const,
  properties: {
    to: { type: 'string', description: 'Destination name (the user\'s chat).' },
    text: { type: 'string', description: 'Message text.' },
    seriesId: { type: 'string', description: 'Task id from `ncl tasks create` / `ncl tasks list`.' },
  },
  required: ['to', 'text', 'seriesId'],
};

export const sendReminder: McpToolDefinition = {
  tool: {
    name: 'send_reminder',
    description:
      'Deliver a fired reminder to the user with [Сделано] and [Отложить на час] buttons. Use it instead of send_message when a scheduled reminder task runs.',
    inputSchema: MARKED_SCHEMA,
  },
  handler: (args) => sendMarked('send_reminder', 'reminder', args),
};

export const sendTaskCreated: McpToolDefinition = {
  tool: {
    name: 'send_task_created',
    description:
      'Confirm a just-created reminder or scheduled task to the user with [Отменить] and [Изменить время] buttons. Use it instead of send_message for the creation confirmation.',
    inputSchema: MARKED_SCHEMA,
  },
  handler: (args) => sendMarked('send_task_created', 'taskCreated', args),
};

registerTools([suggestReplies, sendReminder, sendTaskCreated]);
