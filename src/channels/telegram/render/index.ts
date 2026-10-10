/**
 * Agent Markdown -> Telegram rich messages (`blocks` form).
 *
 * Escaping: the `blocks` form is structured JSON; text is never parsed for
 * markup by Telegram, so there is nothing to escape. That is also the safety
 * property: raw HTML / `<tg-button>` / `javascript:` links in model output can
 * only ever become literal text or be dropped, never buttons or web_app links.
 * (The `markdown`/`html` fields would parse model-injected tags; we never use them.)
 */
import type { InputRichBlock, InputRichMessage } from '../botapi/types.js';
import { buttonsBlock, replyMarkup, type ButtonSpec } from './buttons.js';
import { markdownToBlocks } from './convert.js';
import { LIMITS, PLAIN_CHUNK, measureBlocks } from './limits.js';
import { chunkText, plainText } from './plain.js';
import { CONTINUATION_RESERVE, CONTINUATION_TEXT, splitBlocks } from './split.js';
import { renderStreamingPreview } from './streaming.js';

export interface RenderOptions {
  /** Default 32768 (rich message limit). */
  maxChars?: number;
  /** Default 500 (rich message limit). */
  maxBlocks?: number;
}

export interface RenderResult {
  messages: InputRichMessage[];
  /** Plain-text chunks (<= 4096) for sendMessage, used when a rich send is rejected. */
  plainFallback: string[];
  stats: { blocks: number; chars: number; parts: number };
}

export function renderMarkdown(md: string, opts: RenderOptions = {}): RenderResult {
  const maxChars = opts.maxChars ?? LIMITS.maxChars;
  const maxBlocks = opts.maxBlocks ?? LIMITS.maxBlocks;
  const blocks = markdownToBlocks(md);
  const plainFallback = chunkText(plainText(md), PLAIN_CHUNK);
  if (blocks.length === 0) {
    return { messages: [], plainFallback, stats: { blocks: 0, chars: 0, parts: 0 } };
  }

  const total = measureBlocks(blocks);
  let parts: InputRichBlock[][];
  if (total.blocks <= maxBlocks && total.chars <= maxChars) {
    parts = [blocks];
  } else {
    // Every part must leave room for the continuation footer.
    parts = splitBlocks(blocks, {
      maxChars: Math.max(1, maxChars - CONTINUATION_RESERVE.chars),
      maxBlocks: Math.max(1, maxBlocks - CONTINUATION_RESERVE.blocks),
    });
  }

  const messages = parts.map((part, i): InputRichMessage => {
    const isLast = i === parts.length - 1;
    return { blocks: isLast ? part : [...part, { type: 'footer', text: CONTINUATION_TEXT }] };
  });
  const stats = messages.reduce(
    (acc, m) => {
      const mm = measureBlocks(m.blocks ?? []);
      return { blocks: acc.blocks + mm.blocks, chars: acc.chars + mm.chars, parts: acc.parts + 1 };
    },
    { blocks: 0, chars: 0, parts: 0 },
  );
  return { messages, plainFallback, stats };
}

/**
 * Append a collapsed `details` block (summary + Markdown body) to a message,
 * e.g. the host-built “Что я сделал” section. `summary` is plain text from the
 * host, not Markdown. Returns a new message; the input is not mutated.
 */
export function appendDetails(msg: InputRichMessage, summary: string, markdownBody: string): InputRichMessage {
  if (!msg.blocks) throw new Error('appendDetails: message must use the blocks form');
  const body = markdownToBlocks(markdownBody);
  const details: InputRichBlock = {
    type: 'details',
    summary,
    blocks: body.length ? body : [{ type: 'paragraph', text: '—' }],
  };
  return { ...msg, blocks: [...msg.blocks, details] };
}

export { buttonsBlock, replyMarkup, plainText, renderStreamingPreview, markdownToBlocks, measureBlocks, LIMITS };
export type { ButtonSpec };
