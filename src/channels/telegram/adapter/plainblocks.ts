/** Flatten rich blocks to plain text for the sendMessage fallback (UX §3.7). */
import type { InputRichBlock, RichText } from '../botapi/index.js';
import { chunkText } from '../render/plain.js';

export function richTextToPlain(t: RichText | undefined): string {
  if (t === undefined || t === null) return '';
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(richTextToPlain).join('');
  if (t.type === 'mathematical_expression') return t.expression;
  return richTextToPlain((t as { text: RichText }).text);
}

export function blocksToPlain(blocks: readonly InputRichBlock[], indent = ''): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
      case 'footer':
      case 'thinking':
        out.push(indent + richTextToPlain(b.text));
        break;
      case 'heading':
        out.push(indent + richTextToPlain(b.text));
        break;
      case 'pre':
        out.push(indent + richTextToPlain(b.text));
        break;
      case 'divider':
        out.push(indent + '———');
        break;
      case 'mathematical_expression':
        out.push(indent + b.expression);
        break;
      case 'list':
        b.items.forEach((item, i) => {
          const mark = item.has_checkbox
            ? item.is_checked
              ? '☑ '
              : '☐ '
            : item.value !== undefined
              ? `${item.value}. `
              : `${i + 1}. `;
          const inner = blocksToPlain(item.blocks, '').split('\n');
          out.push(indent + (item.has_checkbox || item.value !== undefined ? mark : '• ') + (inner[0] ?? ''));
          for (const line of inner.slice(1)) out.push(indent + '  ' + line);
        });
        break;
      case 'blockquote':
        out.push(blocksToPlain(b.blocks, indent + '> '));
        break;
      case 'expandable_blockquote':
      case 'pullquote':
        out.push(indent + '> ' + richTextToPlain(b.text));
        break;
      case 'table':
        for (const row of b.cells) out.push(indent + row.map((c) => richTextToPlain(c.text)).join(' | '));
        break;
      case 'details':
        out.push(indent + richTextToPlain(b.summary));
        out.push(blocksToPlain(b.blocks, indent + '  '));
        break;
      case 'buttons':
        break;
    }
  }
  return out.join('\n');
}

export function blocksToPlainChunks(blocks: readonly InputRichBlock[], max = 4096): string[] {
  const text = blocksToPlain(blocks).trim();
  return text ? chunkText(text, max) : [];
}
