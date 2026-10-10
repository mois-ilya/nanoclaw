import type { Definition } from 'mdast';

import { PLAIN_CHUNK } from './limits.js';
import { groupDetails, parseMarkdown, type Item } from './parse.js';

function inlinePlain(node: Item | { type: string }, defs: Map<string, Definition>): string {
  const n = node as {
    type: string;
    value?: string;
    alt?: string;
    url?: string;
    identifier?: string;
    label?: string;
    children?: Item[];
  };
  switch (n.type) {
    case 'text':
    case 'inlineCode':
    case 'inlineMath':
      return n.value ?? '';
    case 'break':
      return '\n';
    case 'html':
      return '';
    case 'image':
      return n.alt || n.url || '';
    case 'imageReference':
      return n.alt || '';
    case 'footnoteReference':
      return `[${n.label ?? n.identifier}]`;
    case 'link': {
      const text = (n.children ?? []).map((c) => inlinePlain(c, defs)).join('');
      return !n.url || text === n.url || text === '' ? n.url || text : `${text} (${n.url})`;
    }
    case 'linkReference': {
      const text = (n.children ?? []).map((c) => inlinePlain(c, defs)).join('');
      const url = defs.get((n.identifier ?? '').toLowerCase())?.url;
      return url && text !== url ? `${text} (${url})` : text;
    }
    default:
      return (n.children ?? []).map((c) => inlinePlain(c, defs)).join('');
  }
}

function blocksPlain(items: readonly Item[], defs: Map<string, Definition>, indent: string): string[] {
  const out: string[] = [];
  for (const node of groupDetails(items)) {
    switch (node.type) {
      case 'paragraph':
      case 'heading':
        out.push(indent + inlinePlain(node, defs).split('\n').join(`\n${indent}`));
        break;
      case 'code':
        out.push(node.value);
        break;
      case 'math':
        out.push(node.value);
        break;
      case 'thematicBreak':
        out.push('———');
        break;
      case 'list': {
        const start = node.start ?? 1;
        const lines = node.children.map((li, i) => {
          const marker =
            li.checked === true ? '☑ ' : li.checked === false ? '☐ ' : node.ordered ? `${start + i}. ` : '• ';
          const inner = blocksPlain(li.children, defs, '').join('\n');
          const pad = ' '.repeat(marker.length);
          return indent + marker + inner.split('\n').join(`\n${indent}${pad}`);
        });
        out.push(lines.join('\n'));
        break;
      }
      case 'blockquote':
        out.push(
          blocksPlain(node.children, defs, '')
            .join('\n\n')
            .split('\n')
            .map((l) => `${indent}> ${l}`)
            .join('\n'),
        );
        break;
      case 'table':
        out.push(
          node.children.map((row) => indent + row.children.map((c) => inlinePlain(c, defs)).join(' | ')).join('\n'),
        );
        break;
      case 'details':
        out.push(indent + node.summary.replace(/<[^>]*>/g, '').trim());
        out.push(...blocksPlain(node.children, defs, indent));
        break;
      case 'footnoteDefinition':
        out.push(`[${node.label ?? node.identifier}] ${blocksPlain(node.children, defs, '').join(' ')}`);
        break;
      default:
        break; // html, definition: dropped
    }
  }
  return out.filter((s) => s.trim() !== '');
}

function collectDefs(items: readonly Item[], defs: Map<string, Definition>): void {
  for (const n of items) {
    if (n.type === 'definition') defs.set(n.identifier.toLowerCase(), n);
    else if ('children' in n && Array.isArray(n.children)) collectDefs(n.children as Item[], defs);
  }
}

/** Markdown -> readable plain text (no markup, links as `text (url)`). */
export function plainText(md: string): string {
  const root = parseMarkdown(md);
  const defs = new Map<string, Definition>();
  collectDefs(root.children, defs);
  return blocksPlain(root.children, defs, '').join('\n\n');
}

/** Cut at a code-point boundary: never between the halves of a surrogate pair. */
function safeCut(s: string, at: number): number {
  if (at > 0 && at < s.length) {
    const c = s.charCodeAt(at - 1);
    if (c >= 0xd800 && c <= 0xdbff) return at - 1;
  }
  return at;
}

/** Split text into chunks of at most `max` chars, preferring paragraph, line, then word boundaries. */
export function chunkText(text: string, max = PLAIN_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max / 2) cut = window.lastIndexOf('\n');
    if (cut < max / 2) cut = window.lastIndexOf(' ');
    if (cut < max / 2) cut = safeCut(rest, max);
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c !== '');
}

/** Plain text of already-parsed nodes (no reference definitions available). */
export function plainFromNodes(nodes: readonly Item[]): string {
  return blocksPlain(nodes, new Map(), '').join('\n\n');
}

/**
 * Plain text of a still-growing tail for the streaming preview. Complete
 * markup has already been consumed by the parser, so any marker left over is
 * unpaired (the stream has not closed it yet) and is hidden to avoid flicker.
 */
export function plainTail(nodes: readonly Item[]): string {
  return plainFromNodes(nodes)
    .replace(/\*\*|~~|`/g, '')
    .replace(/\*(?=\S)(?![^*]*\*)/g, '')
    .replace(/\]\([^)\s]*$/, ']')
    .replace(/\[(?![^\]]*\])/g, '');
}
