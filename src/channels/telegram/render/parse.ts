import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { mathFromMarkdown } from 'mdast-util-math';
import { gfm } from 'micromark-extension-gfm';
import { math } from 'micromark-extension-math';
import type { Root, RootContent } from 'mdast';

/**
 * Synthetic node produced by groupDetails(): a `<details><summary>S</summary>
 * body</details>` pattern whose body has been parsed as Markdown.
 */
export interface DetailsNode {
  type: 'details';
  summary: string;
  open: boolean;
  children: Item[];
}
export type Item = RootContent | DetailsNode;

/** GFM (tables, task lists, strikethrough, autolinks, footnotes) + `$..$` / `$$..$$` math. */
export function parseMarkdown(md: string): Root {
  return fromMarkdown(md, {
    extensions: [gfm(), math({ singleDollarTextMath: true })],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
}

const HEAD_RE = /^\s*<details((?:\s[^>]*)?)>\s*(?:<summary[^>]*>([\s\S]*?)<\/summary>)?([\s\S]*)$/i;
const TOKEN_RE = /<details\b[^>]*>|<\/details\s*>/gi;

interface Closure {
  /** Text before the closing tag that brings depth to 0, or null if not closed in this string. */
  before: string | null;
  /** Text after that closing tag (CommonMark keeps it in the same html node up to a blank line). */
  after: string;
}

/** Scan `text` starting at nesting `depth`; return text before the tag that closes depth to 0. */
function scanClose(text: string, depth: number): Closure & { depth: number } {
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(text))) {
    if (m[0][1] === '/') depth--;
    else depth++;
    if (depth === 0) return { before: text.slice(0, m.index), after: text.slice(m.index + m[0].length), depth };
  }
  return { before: null, after: '', depth };
}

/**
 * Non-whitelisted raw HTML keeps its text: tags are stripped and the rest is
 * parsed as Markdown (an HTML block swallows the following lines up to a blank
 * line, so dropping the node would drop the user's text too). Leftover `<` is
 * escaped so the re-parse cannot yield another html node.
 */
function htmlText(value: string): Item[] {
  const text = value.replace(/<[^>]*>/g, '').replace(/</g, '&lt;');
  return parseBody(text);
}

function parseBody(md: string): Item[] {
  if (!md.trim()) return [];
  return groupDetails(parseMarkdown(md).children);
}

/**
 * Collapse html-node runs of the whitelisted details pattern into DetailsNode.
 * Every other `html` node is replaced by its text content (see htmlText).
 */
export function groupDetails(nodes: readonly Item[]): Item[] {
  const out: Item[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type !== 'html') {
      out.push(node);
      continue;
    }
    const head = HEAD_RE.exec(node.value);
    if (!head) {
      out.push(...htmlText(node.value));
      continue;
    }
    const open = /\bopen\b/i.test(head[1] ?? '');
    const summary = (head[2] ?? '').trim();
    const rest = head[3] ?? '';

    const sameNode = scanClose(rest, 1);
    if (sameNode.before !== null) {
      out.push({ type: 'details', summary, open, children: parseBody(sameNode.before) });
      out.push(...groupDetails(parseBody(sameNode.after)));
      continue;
    }

    // Body continues in following sibling nodes until the matching </details>.
    const children: Item[] = parseBody(rest);
    let depth = sameNode.depth;
    let after: Item[] = [];
    let j = i + 1;
    for (; j < nodes.length; j++) {
      const sib = nodes[j];
      if (sib.type === 'html') {
        const closed = scanClose(sib.value, depth);
        if (closed.before !== null) {
          children.push(...parseBody(closed.before));
          after = parseBody(closed.after);
          break;
        }
        depth = closed.depth;
      }
      children.push(sib);
    }
    out.push({ type: 'details', summary, open, children: groupDetails(children) });
    out.push(...groupDetails(after));
    i = j; // j === nodes.length when never closed: details extends to the end
  }
  return out;
}
