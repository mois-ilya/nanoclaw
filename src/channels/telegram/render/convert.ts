import type { Definition, PhrasingContent, Table, TableRow } from 'mdast';

import type { InputRichBlock, InputRichBlockListItem, RichBlockTableCell, RichText } from '../botapi/types.js';
import { LIMITS, richToPlain } from './limits.js';
import { groupDetails, parseMarkdown, type DetailsNode, type Item } from './parse.js';

/** Blockquotes longer than this (plain chars) become expandable_blockquote. */
export const LONG_QUOTE_CHARS = 600;

// tg: is deliberately excluded: model-written tg:// links could launch mini
// apps (startapp), add proxies or join chats with one tap.
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Link policy: only http, https, mailto. Anything else (javascript:, data:,
 * relative, scheme-less) is returned as null so the caller emits plain text.
 */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SAFE_SCHEMES.has(parsed.protocol)) return null;
  // new URL() strips tabs/newlines inside the scheme, so also require the
  // trimmed input itself to start with the scheme (no hidden control chars).
  if (!url.toLowerCase().startsWith(parsed.protocol)) return null;
  return url;
}

interface Ctx {
  defs: Map<string, Definition>;
}

/** Merge adjacent strings, drop empties, unwrap singletons. */
export function seq(parts: RichText[]): RichText {
  const out: RichText[] = [];
  for (const p of parts) {
    if (p === '' || (Array.isArray(p) && p.length === 0)) continue;
    const prev = out[out.length - 1];
    if (typeof p === 'string' && typeof prev === 'string') out[out.length - 1] = prev + p;
    else out.push(p);
  }
  if (out.length === 0) return '';
  if (out.length === 1) return out[0];
  return out;
}

/** Plain text of any mdast node. Used for flattening and for length checks. */
export function nodeText(node: Item | PhrasingContent | TableRow | { type: string }): string {
  const n = node as {
    type: string;
    value?: string;
    alt?: string;
    children?: Item[];
    summary?: string;
    label?: string;
  };
  switch (n.type) {
    case 'text':
    case 'inlineCode':
    case 'code':
    case 'inlineMath':
    case 'math':
      return n.value ?? '';
    case 'image':
      return n.alt ?? '';
    case 'break':
      return '\n';
    case 'html':
    case 'definition':
      return '';
    case 'footnoteReference':
      return `[${n.label ?? ''}]`;
    case 'details':
      return `${n.summary ?? ''}\n${(n.children ?? []).map(nodeText).join('\n')}`;
    case 'paragraph':
    case 'heading':
    case 'tableCell':
      return (n.children ?? []).map(nodeText).join('');
    case 'tableRow':
      return (n.children ?? []).map(nodeText).join(' | ');
    default:
      return (n.children ?? []).map(nodeText).join('\n');
  }
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function wrap(type: 'bold' | 'italic' | 'strikethrough' | 'superscript' | 'code', text: RichText): RichText {
  return { type, text };
}

/** Pandoc-style guard so “$5 and $10” is not swallowed as a formula. */
function plausibleInlineMath(value: string, next: PhrasingContent | undefined): boolean {
  if (/^\s|\s$/.test(value)) return false;
  if (/^[\d.,\s]+$/.test(value)) return false;
  if (next?.type === 'text' && /^\d/.test(next.value)) return false;
  return true;
}

function linkRun(url: string, text: RichText): RichText {
  const safe = safeUrl(url);
  if (!safe) return text;
  if (safe.toLowerCase().startsWith('mailto:')) {
    let addr = safe.slice('mailto:'.length).split('?')[0];
    try {
      addr = decodeURIComponent(addr);
    } catch {
      return text;
    }
    return addr ? { type: 'email_address', text, email_address: addr } : text;
  }
  return { type: 'url', text, url: safe };
}

/**
 * budget = remaining nesting levels for inline formatting. When it is used
 * up, the subtree is flattened to plain text (16-level limit).
 */
function inline(nodes: readonly PhrasingContent[], ctx: Ctx, budget: number): RichText {
  const parts: RichText[] = [];
  nodes.forEach((node, i) => {
    switch (node.type) {
      case 'text':
        parts.push(node.value);
        return;
      case 'break':
        parts.push('\n');
        return;
      case 'html': // raw inline HTML is never forwarded
        return;
      case 'inlineCode':
        parts.push(budget >= 1 ? wrap('code', node.value) : node.value);
        return;
      case 'inlineMath':
        if (budget < 1) parts.push(node.value);
        else if (plausibleInlineMath(node.value, nodes[i + 1])) {
          parts.push({ type: 'mathematical_expression', expression: node.value });
        } else {
          parts.push(`$${node.value}$`);
        }
        return;
      case 'footnoteReference':
        parts.push(
          budget >= 1
            ? wrap('superscript', `[${node.label ?? node.identifier}]`)
            : `[${node.label ?? node.identifier}]`,
        );
        return;
      case 'image': {
        // No media blocks from agent output: image becomes a link with the alt text.
        const alt = node.alt || node.url;
        parts.push(budget >= 1 ? linkRun(node.url, alt) : alt);
        return;
      }
      case 'imageReference': {
        const def = ctx.defs.get(node.identifier.toLowerCase());
        const alt = node.alt || def?.url || '';
        parts.push(def && budget >= 1 ? linkRun(def.url, alt) : alt);
        return;
      }
      case 'strong':
      case 'emphasis':
      case 'delete':
      case 'link':
      case 'linkReference': {
        const flat = budget < 1;
        const kids = flat ? nodeText(node) : inline(node.children, ctx, budget - 1);
        if (flat) {
          parts.push(kids);
        } else if (node.type === 'strong') parts.push(wrap('bold', kids));
        else if (node.type === 'emphasis') parts.push(wrap('italic', kids));
        else if (node.type === 'delete') parts.push(wrap('strikethrough', kids));
        else if (node.type === 'link') parts.push(linkRun(node.url, kids === '' ? node.url : kids));
        else {
          const def = ctx.defs.get(node.identifier.toLowerCase());
          parts.push(def ? linkRun(def.url, kids) : kids);
        }
        return;
      }
      default:
        parts.push(nodeText(node));
    }
  });
  return seq(parts);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** Deepest block level we still convert structurally (inline needs >= 1 more). */
const MAX_BLOCK_LEVEL = LIMITS.maxNesting - 1;

function para(text: RichText): InputRichBlock {
  return { type: 'paragraph', text };
}

function flattenToParagraphs(items: readonly Item[]): InputRichBlock[] {
  const out: InputRichBlock[] = [];
  for (const it of items) {
    const t = nodeText(it).trim();
    if (t) out.push(para(t));
  }
  return out;
}

function expandableText(children: readonly Item[], ctx: Ctx, budget: number): RichText {
  const parts: RichText[] = [];
  children.forEach((c, i) => {
    if (i > 0) parts.push('\n');
    if (c.type === 'paragraph') parts.push(inline(c.children, ctx, budget));
    else if (c.type === 'heading')
      parts.push(budget >= 1 ? wrap('bold', inline(c.children, ctx, budget - 1)) : nodeText(c));
    else parts.push(nodeText(c));
  });
  return seq(parts);
}

function convertTable(node: Table, ctx: Ctx, level: number): InputRichBlock[] {
  const budget = Math.max(0, LIMITS.maxNesting - (level + 2));
  const rows = node.children;
  const grid: RichBlockTableCell[][] = rows.map((row, r) =>
    row.children.map((cell, c) => {
      const text = inline(cell.children, ctx, budget);
      // An omitted text means an invisible cell, so empty cells get ' '.
      // align/valign are always sent: the docs do not mark them optional.
      const out: RichBlockTableCell = {
        text: text === '' ? ' ' : text,
        align: node.align?.[c] ?? 'left',
        valign: 'top',
      };
      if (r === 0) out.is_header = true;
      return out;
    }),
  );
  const cols = grid.reduce((n, r) => Math.max(n, r.length), 0);
  if (cols === 0) return [];

  if (cols <= LIMITS.maxTableColumns) {
    return [{ type: 'table', cells: grid, is_bordered: true }];
  }
  if (grid.length <= LIMITS.maxTableColumns) {
    // Too many columns but few rows: transpose (first column becomes the header column).
    const t: RichBlockTableCell[][] = [];
    for (let c = 0; c < cols; c++) {
      t.push(
        grid.map((row, r) => {
          const src = row[c];
          const cell: RichBlockTableCell = { text: src?.text ?? ' ', align: 'left', valign: 'top' };
          if (r === 0) cell.is_header = true;
          return cell;
        }),
      );
    }
    return [{ type: 'table', cells: t, is_bordered: true }];
  }
  // Wide and tall: one list item per data row with “column: value” lines.
  const header = (grid[0] ?? []).map((c) => (c.text === undefined ? '' : richToPlain(c.text)));
  const items: InputRichBlockListItem[] = grid.slice(1).map((row) => {
    const lines: RichText[] = [];
    row.forEach((cell, c) => {
      if (lines.length) lines.push('\n');
      lines.push(`${header[c] || `#${c + 1}`}: `, cell.text ?? '');
    });
    return { blocks: [para(seq(lines))] };
  });
  return items.length ? [{ type: 'list', items }] : [];
}

function convertDetails(node: DetailsNode, ctx: Ctx, level: number): InputRichBlock[] {
  const sumDoc = parseMarkdown(node.summary || ' ').children[0];
  const budget = Math.max(0, LIMITS.maxNesting - (level + 1));
  const summary: RichText =
    sumDoc?.type === 'paragraph' ? inline(sumDoc.children, ctx, budget) : node.summary || 'Details';
  const blocks = convertItems(node.children, ctx, level + 1);
  const out: InputRichBlock = {
    type: 'details',
    summary: summary === '' ? 'Details' : summary,
    blocks: blocks.length ? blocks : [para('—')],
  };
  if (node.open) out.is_open = true;
  return [out];
}

/**
 * Levels: a top-level block sits at level 1; a block at level L has depth
 * L + its own inline nesting. Children of a container sit at level+1
 * (blockquote, details) or level+2 (list -> item -> block). Past
 * MAX_BLOCK_LEVEL a block is emitted as a plain-text paragraph, and a
 * container that would need children below level 16 is flattened itself.
 */
function convertItems(items: readonly Item[], ctx: Ctx, level: number): InputRichBlock[] {
  if (level > MAX_BLOCK_LEVEL) return flattenToParagraphs(items);
  const out: InputRichBlock[] = [];
  const budget = LIMITS.maxNesting - level;

  for (const node of groupDetails(items)) {
    switch (node.type) {
      case 'paragraph': {
        const text = inline(node.children, ctx, budget);
        if (text !== '') out.push(para(text));
        break;
      }
      case 'heading': {
        if (node.depth <= 3) {
          const text = inline(node.children, ctx, budget);
          if (text !== '') out.push({ type: 'heading', text, size: node.depth as 1 | 2 | 3 });
        } else {
          const text = inline(node.children, ctx, budget - 1);
          if (text !== '') out.push(para(budget >= 1 ? wrap('bold', text) : text));
        }
        break;
      }
      case 'code': {
        if (node.lang?.toLowerCase() === 'math') {
          out.push({ type: 'mathematical_expression', expression: node.value });
        } else if (node.value.trim() !== '') {
          const pre: InputRichBlock = { type: 'pre', text: node.value };
          if (node.lang) pre.language = node.lang;
          out.push(pre);
        }
        break;
      }
      case 'math':
        if (node.value.trim()) out.push({ type: 'mathematical_expression', expression: node.value });
        break;
      case 'thematicBreak':
        out.push({ type: 'divider' });
        break;
      case 'list': {
        if (level + 2 > LIMITS.maxNesting) {
          out.push(...flattenToParagraphs([node]));
          break;
        }
        const start = node.start ?? 1;
        const items: InputRichBlockListItem[] = node.children.map((li, i) => {
          const blocks = convertItems(li.children, ctx, level + 2);
          // Empty block text may be rejected; an empty list item shows a space.
          const item: InputRichBlockListItem = { blocks: blocks.length ? blocks : [para(' ')] };
          if (li.checked !== null && li.checked !== undefined) {
            item.has_checkbox = true;
            if (li.checked) item.is_checked = true;
          }
          if (node.ordered) {
            item.value = start + i;
            item.type = '1';
          }
          return item;
        });
        if (items.length) out.push({ type: 'list', items });
        break;
      }
      case 'blockquote': {
        const plain = nodeText(node);
        if (level + 1 > LIMITS.maxNesting) {
          out.push(...flattenToParagraphs([node]));
        } else if (plain.length > LONG_QUOTE_CHARS) {
          out.push({ type: 'expandable_blockquote', text: expandableText(node.children, ctx, budget - 1) });
        } else {
          const blocks = convertItems(node.children, ctx, level + 1);
          if (blocks.length) out.push({ type: 'blockquote', blocks });
        }
        break;
      }
      case 'table':
        if (level + 2 > LIMITS.maxNesting) out.push(...flattenToParagraphs([node]));
        else out.push(...convertTable(node, ctx, level));
        break;
      case 'details':
        if (level + 1 > LIMITS.maxNesting) out.push(...flattenToParagraphs([node]));
        else out.push(...convertDetails(node, ctx, level));
        break;
      case 'footnoteDefinition': {
        const blocks = convertItems(node.children, ctx, level);
        const label = wrap('superscript', `[${node.label ?? node.identifier}] `);
        const first = blocks[0];
        if (first?.type === 'paragraph') out.push(para(seq([label, first.text])), ...blocks.slice(1));
        else out.push(para(label), ...blocks);
        break;
      }
      case 'html': // unreachable: groupDetails() replaced raw HTML by its text
      case 'definition':
        break;
      default:
        break;
    }
  }
  return out;
}

function collectDefinitions(items: readonly Item[], defs: Map<string, Definition>): void {
  for (const n of items) {
    if (n.type === 'definition') defs.set(n.identifier.toLowerCase(), n);
    else if ('children' in n && Array.isArray(n.children)) collectDefinitions(n.children as Item[], defs);
  }
}

/** Markdown (GFM + math) -> InputRichBlock[]. */
export function markdownToBlocks(md: string): InputRichBlock[] {
  const root = parseMarkdown(md);
  const ctx: Ctx = { defs: new Map() };
  collectDefinitions(root.children, ctx.defs);
  return convertItems(root.children, ctx, 1);
}

/** Convert already-parsed top-level nodes (used by the streaming preview). */
export function nodesToBlocks(nodes: readonly Item[], defs: Map<string, Definition> = new Map()): InputRichBlock[] {
  return convertItems(nodes, { defs }, 1);
}

export { inline as inlineToRichText };
export type { Ctx };
