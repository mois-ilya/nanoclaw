import type { Definition } from 'mdast';

import type { InputRichBlock, InputRichMessage } from '../botapi/types.js';
import { nodesToBlocks } from './convert.js';
import { LIMITS } from './limits.js';
import { plainTail } from './plain.js';
import { groupDetails, parseMarkdown, type Item } from './parse.js';
import { CONTINUATION_RESERVE, splitBlocks } from './split.js';

/** Placeholder shown before the first complete block exists. */
export const THINKING_TEXT = 'Думаю…';

/**
 * Line scan: drop everything from the first construct that is still open at the
 * end of the stream — an unclosed ``` / ~~~ fence, an unclosed `$$` block, or
 * an unclosed `<details>` (outermost opener wins).
 */
export function cutUnclosed(md: string): string {
  const lines = md.split('\n');
  let fence: { char: string; len: number; at: number } | null = null;
  let mathAt: number | null = null;
  const detailsOpen: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      // Lenient close: fences inside list items are indented.
      const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
      continue;
    }
    if (mathAt !== null) {
      if (line.trim().endsWith('$$')) mathAt = null;
      continue;
    }
    // Fence openers, also inside list items (`- ```py`, `1. ````).
    const f = /^\s*(?:(?:[-*+]|\d{1,9}[.)])\s+)*(`{3,}|~{3,})/.exec(line);
    if (f) {
      fence = { char: f[1][0], len: f[1].length, at: i };
      continue;
    }
    const t = line.trim();
    if (t.startsWith('$$') && !(t.length > 2 && t.endsWith('$$'))) {
      mathAt = i;
      continue;
    }
    // An HTML block opener must start the line (CommonMark); `<details>` in
    // prose or an inline code span is just text. Closers count anywhere
    // outside code spans while a details block is open.
    const bare = line.replace(/(`+)[^`]*?\1/g, '');
    for (const m of bare.matchAll(/<details\b[^>]*>|<\/details\s*>/gi)) {
      if (m[0][1] === '/') detailsOpen.pop();
      else if (detailsOpen.length > 0 || /^\s{0,3}$/.test(bare.slice(0, m.index))) detailsOpen.push(i);
    }
  }
  const cutAt = [fence?.at, mathAt ?? undefined, detailsOpen[0]].filter((x): x is number => x !== undefined);
  if (cutAt.length === 0) return md;
  return lines.slice(0, Math.min(...cutAt)).join('\n');
}

function collectDefs(items: readonly Item[], defs: Map<string, Definition>): void {
  for (const n of items) {
    if (n.type === 'definition') defs.set(n.identifier.toLowerCase(), n);
    else if ('children' in n && Array.isArray(n.children)) collectDefs(n.children as Item[], defs);
  }
}

/**
 * Render a partial Markdown stream for sendRichMessageDraft.
 *
 * Only complete top-level blocks are rendered as rich blocks. The tail (the
 * last block, when the stream does not end in a blank line) is shown as plain
 * text, because half-written markup would flicker; an unclosed code fence,
 * math block or details block, or a table still receiving rows, is withheld
 * entirely. The result always respects the rich message limits (keeps the
 * newest part if the draft is already huge). Pass `{draft: false}` when the
 * preview is sent with editMessageText rather than sendRichMessageDraft.
 */
export function renderStreamingPreview(mdSoFar: string, opts: { draft?: boolean } = {}): InputRichMessage {
  const stable = cutUnclosed(mdSoFar);
  const endsClean = /\n[ \t]*\n[ \t]*$/.test(stable) || stable.trim() === '';
  const root = parseMarkdown(stable);
  const defs = new Map<string, Definition>();
  collectDefs(root.children, defs);

  const nodes = groupDetails(root.children);
  const tail = endsClean ? undefined : nodes[nodes.length - 1];
  let head: Item[] = endsClean ? nodes : nodes.slice(0, -1);
  const extra: InputRichBlock[] = [];

  if (tail) {
    switch (tail.type) {
      case 'table':
        break; // may still receive rows: withheld
      case 'details':
      case 'code':
      case 'math':
        head = [...head, tail]; // unclosed ones were already cut by cutUnclosed()
        break;
      case 'list': {
        const last = tail.children[tail.children.length - 1];
        const done = tail.children.slice(0, -1);
        if (done.length) head = [...head, { ...tail, children: done }];
        const text = last ? plainTail(last.children) : '';
        if (text) extra.push({ type: 'paragraph', text });
        break;
      }
      default: {
        const text = plainTail([tail]);
        if (text) extra.push({ type: 'paragraph', text });
      }
    }
  }

  const blocks = [...nodesToBlocks(head, defs), ...extra];
  if (blocks.length === 0) {
    // `thinking` is valid only in sendRichMessageDraft; editMessageText previews get a paragraph.
    return opts.draft === false
      ? { blocks: [{ type: 'paragraph', text: THINKING_TEXT }] }
      : { blocks: [{ type: 'thinking', text: THINKING_TEXT }] };
  }

  const parts = splitBlocks(blocks, {
    maxChars: LIMITS.maxChars - CONTINUATION_RESERVE.chars,
    maxBlocks: LIMITS.maxBlocks - CONTINUATION_RESERVE.blocks,
  });
  return { blocks: parts[parts.length - 1] };
}
