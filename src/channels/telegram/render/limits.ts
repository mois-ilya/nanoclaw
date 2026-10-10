import type { InputRichBlock, RichText } from '../botapi/types.js';

/** Rich message limits (rich-message-formatting-options.md, “Rich Message Limits”). */
export const LIMITS = {
  /** “Up to 32768 UTF-8 characters”; we count UTF-16 code units (>= code points, so conservative). */
  maxChars: 32768,
  /** “Up to 500 blocks, including nested blocks, list items, ... table rows, quotation blocks, and details blocks.” */
  maxBlocks: 500,
  /** “Up to 16 levels of nested formatting and blocks.” */
  maxNesting: 16,
  /** “Up to 20 columns in a table.” */
  maxTableColumns: 20,
} as const;

/** sendMessage text limit (sendmessage.md): 1-4096 characters. */
export const PLAIN_CHUNK = 4096;

export function richLen(t: RichText): number {
  if (typeof t === 'string') return t.length;
  if (Array.isArray(t)) return t.reduce((n, x) => n + richLen(x), 0);
  if (t.type === 'mathematical_expression') return t.expression.length;
  return richLen(t.text);
}

export function richDepth(t: RichText): number {
  if (typeof t === 'string') return 0;
  if (Array.isArray(t)) return t.reduce((n, x) => Math.max(n, richDepth(x)), 0);
  if (t.type === 'mathematical_expression') return 1;
  return 1 + richDepth(t.text);
}

export function richToPlain(t: RichText): string {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(richToPlain).join('');
  if (t.type === 'mathematical_expression') return t.expression;
  return richToPlain(t.text);
}

export interface Measure {
  blocks: number;
  chars: number;
  /** Nesting levels, blocks and inline formatting together. */
  depth: number;
}

export function measureBlock(b: InputRichBlock): Measure {
  switch (b.type) {
    case 'paragraph':
    case 'heading':
    case 'pre':
    case 'footer':
    case 'thinking':
    case 'expandable_blockquote':
    case 'pullquote':
      return { blocks: 1, chars: richLen(b.text), depth: 1 + richDepth(b.text) };
    case 'divider':
      return { blocks: 1, chars: 0, depth: 1 };
    case 'mathematical_expression':
      return { blocks: 1, chars: b.expression.length, depth: 1 };
    case 'list': {
      let blocks = 1;
      let chars = 0;
      let depth = 0;
      for (const item of b.items) {
        const m = measureBlocks(item.blocks);
        blocks += 1 + m.blocks;
        chars += m.chars;
        depth = Math.max(depth, m.depth);
      }
      return { blocks, chars, depth: 2 + depth };
    }
    case 'blockquote': {
      const m = measureBlocks(b.blocks);
      return { blocks: 1 + m.blocks, chars: m.chars, depth: 1 + m.depth };
    }
    case 'details': {
      const m = measureBlocks(b.blocks);
      return {
        blocks: 1 + m.blocks,
        chars: m.chars + richLen(b.summary),
        depth: 1 + Math.max(m.depth, richDepth(b.summary)),
      };
    }
    case 'table': {
      let chars = 0;
      let depth = 0;
      for (const row of b.cells) {
        for (const c of row) {
          if (c.text === undefined) continue;
          chars += richLen(c.text);
          depth = Math.max(depth, richDepth(c.text));
        }
      }
      return { blocks: 1 + b.cells.length, chars, depth: 3 + depth };
    }
    case 'buttons':
      return { blocks: 1, chars: b.buttons.reduce((n, x) => n + richLen(x.text), 0), depth: 1 };
  }
}

export function measureBlocks(bs: readonly InputRichBlock[]): Measure {
  const total: Measure = { blocks: 0, chars: 0, depth: 0 };
  for (const b of bs) {
    const m = measureBlock(b);
    total.blocks += m.blocks;
    total.chars += m.chars;
    total.depth = Math.max(total.depth, m.depth);
  }
  return total;
}
