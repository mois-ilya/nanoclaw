import type { InputRichBlock, RichBlockTableCell, RichText } from '../botapi/types.js';
import { measureBlock, measureBlocks, richToPlain, type Measure } from './limits.js';

export interface Budget {
  maxChars: number;
  maxBlocks: number;
}

export const CONTINUATION_TEXT = 'продолжение ниже ↓';
/** Room kept free in every part for the continuation footer. */
export const CONTINUATION_RESERVE = { chars: CONTINUATION_TEXT.length + 8, blocks: 1 };

function fits(m: Pick<Measure, 'blocks' | 'chars'>, b: Budget): boolean {
  return m.blocks <= b.maxBlocks && m.chars <= b.maxChars;
}

/** Split a long string into <= max chunks on line boundaries (hard-splitting over-long lines). */
function chunkLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  const push = () => {
    if (cur !== '') chunks.push(cur);
    cur = '';
  };
  for (let line of text.split('\n')) {
    while (line.length > max) {
      let cut = max;
      const c = line.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
      push();
      chunks.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    if (cur.length + line.length + 1 > max) push();
    cur = cur === '' ? line : `${cur}\n${line}`;
  }
  push();
  return chunks;
}

/** Groups items greedily so each group fits `budget`. */
function groupBy<T>(items: readonly T[], measure: (x: T) => Measure, budget: Budget, extra: Measure): T[][] {
  const groups: T[][] = [];
  let cur: T[] = [];
  let blocks = extra.blocks;
  let chars = extra.chars;
  for (const it of items) {
    const m = measure(it);
    if (cur.length && !fits({ blocks: blocks + m.blocks, chars: chars + m.chars }, budget)) {
      groups.push(cur);
      cur = [];
      blocks = extra.blocks;
      chars = extra.chars;
    }
    cur.push(it);
    blocks += m.blocks;
    chars += m.chars;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Make one top-level block fit `budget`, splitting only as a last resort:
 *  - pre: by lines into several pre blocks;
 *  - list: by items; table: by rows (header repeated) — only when the block alone cannot fit;
 *  - details / blockquote: unwrapped into their children;
 *  - anything else: plain-text paragraphs.
 */
export function explode(block: InputRichBlock, budget: Budget): InputRichBlock[] {
  if (fits(measureBlock(block), budget)) return [block];
  const chunk = Math.max(200, Math.floor(budget.maxChars / 2));

  switch (block.type) {
    case 'pre': {
      const pieces = chunkLines(richToPlain(block.text), chunk);
      return pieces.map((p) =>
        block.language ? { type: 'pre', text: p, language: block.language } : { type: 'pre', text: p },
      );
    }
    case 'list': {
      const groups = groupBy(
        block.items,
        (it) => {
          const m = measureBlocks(it.blocks);
          return { ...m, blocks: m.blocks + 1 };
        },
        budget,
        { blocks: 1, chars: 0, depth: 0 },
      );
      return groups.flatMap((items) => {
        const piece: InputRichBlock = { type: 'list', items };
        return fits(measureBlock(piece), budget) ? [piece] : plainParagraphs(piece, chunk);
      });
    }
    case 'table': {
      const [header, ...body] = block.cells;
      const rowM = (r: RichBlockTableCell[]): Measure => ({
        blocks: 1,
        chars: r.reduce((n, c) => n + (c.text === undefined ? 0 : richToPlain(c.text).length), 0),
        depth: 0,
      });
      const headM = header ? rowM(header) : { blocks: 0, chars: 0, depth: 0 };
      const groups = groupBy(body, rowM, budget, { blocks: 1 + headM.blocks, chars: headM.chars, depth: 0 });
      return groups.map((rows) => ({ ...block, cells: header ? [header, ...rows] : rows }));
    }
    case 'details':
      return [
        { type: 'paragraph', text: { type: 'bold', text: block.summary } } as InputRichBlock,
        ...block.blocks.flatMap((b) => explode(b, budget)),
      ];
    case 'blockquote':
      return block.blocks.flatMap((b) => explode(b, budget));
    default:
      return plainParagraphs(block, chunk);
  }
}

function plainParagraphs(block: InputRichBlock, chunk: number): InputRichBlock[] {
  return chunkLines(blockPlain(block), chunk).map((p): InputRichBlock => ({ type: 'paragraph', text: p }));
}

function blockPlain(b: InputRichBlock): string {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'pre':
    case 'footer':
    case 'thinking':
    case 'expandable_blockquote':
    case 'pullquote':
      return richToPlain(b.text);
    case 'mathematical_expression':
      return b.expression;
    case 'divider':
      return '';
    case 'list':
      return b.items.map((i) => `• ${i.blocks.map(blockPlain).join('\n')}`).join('\n');
    case 'blockquote':
      return b.blocks.map(blockPlain).join('\n');
    case 'details':
      return `${richToPlain(b.summary)}\n${b.blocks.map(blockPlain).join('\n')}`;
    case 'table':
      return b.cells.map((r) => r.map((c) => (c.text === undefined ? '' : richToPlain(c.text))).join(' | ')).join('\n');
    case 'buttons':
      return b.buttons.map((x) => richToPlain(x.text)).join(' ');
  }
}

function sum(ms: Measure[]): Measure {
  return ms.reduce(
    (a, m) => ({ blocks: a.blocks + m.blocks, chars: a.chars + m.chars, depth: Math.max(a.depth, m.depth) }),
    {
      blocks: 0,
      chars: 0,
      depth: 0,
    },
  );
}

/** Greedy in-order packing of pieces into parts. */
function pack(pieces: InputRichBlock[][], budget: Budget): InputRichBlock[][] {
  const parts: InputRichBlock[][] = [];
  let cur: InputRichBlock[] = [];
  let m = { blocks: 0, chars: 0 };
  for (const piece of pieces) {
    const pm = measureBlocks(piece);
    if (cur.length && !fits({ blocks: m.blocks + pm.blocks, chars: m.chars + pm.chars }, budget)) {
      parts.push(cur);
      cur = [];
      m = { blocks: 0, chars: 0 };
    }
    cur.push(...piece);
    m = { blocks: m.blocks + pm.blocks, chars: m.chars + pm.chars };
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function splitAtHeadings(blocks: InputRichBlock[], size: number): InputRichBlock[][] {
  const sections: InputRichBlock[][] = [];
  let cur: InputRichBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'heading' && b.size === size && cur.length) {
      sections.push(cur);
      cur = [];
    }
    cur.push(b);
  }
  if (cur.length) sections.push(cur);
  return sections;
}

function splitLevel(blocks: InputRichBlock[], level: number, budget: Budget): InputRichBlock[][] {
  if (fits(sum(blocks.map(measureBlock)), budget)) return [blocks];
  if (level <= 3) {
    const sections = splitAtHeadings(blocks, level);
    if (sections.length <= 1) return splitLevel(blocks, level + 1, budget);
    return pack(
      sections.flatMap((s) => (fits(measureBlocks(s), budget) ? [s] : splitLevel(s, level + 1, budget))),
      budget,
    );
  }
  return pack(
    blocks.map((b) => [b]),
    budget,
  );
}

/**
 * Split blocks into parts that each fit `budget`: at H2 boundaries first, then
 * H3, then between top-level blocks. Tables, code and details are never cut
 * unless one of them alone exceeds the budget (see explode()).
 */
export function splitBlocks(blocks: InputRichBlock[], budget: Budget): InputRichBlock[][] {
  const units = blocks.flatMap((b) => explode(b, budget));
  return splitLevel(units, 2, budget);
}

export type { RichText };
