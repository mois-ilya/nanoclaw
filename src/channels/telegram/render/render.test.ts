import { describe, expect, it } from 'vitest';

import type { InputRichBlock, InputRichMessage } from '../botapi/types.js';
import {
  LIMITS,
  appendDetails,
  buttonsBlock,
  markdownToBlocks,
  measureBlocks,
  plainText,
  renderMarkdown,
  renderStreamingPreview,
  replyMarkup,
} from './index.js';

const blocks = (md: string) => markdownToBlocks(md);

describe('mapping goldens', () => {
  it('headings: h1-h3 -> heading, deeper -> bold paragraph', () => {
    expect(blocks('# A\n\n## B\n\n### C\n\n#### D')).toEqual([
      { type: 'heading', text: 'A', size: 1 },
      { type: 'heading', text: 'B', size: 2 },
      { type: 'heading', text: 'C', size: 3 },
      { type: 'paragraph', text: { type: 'bold', text: 'D' } },
    ]);
  });

  it('paragraph inline runs', () => {
    expect(blocks('a **b** _c_ ~~d~~ `e` [f](https://x.org/p) g')).toEqual([
      {
        type: 'paragraph',
        text: [
          'a ',
          { type: 'bold', text: 'b' },
          ' ',
          { type: 'italic', text: 'c' },
          ' ',
          { type: 'strikethrough', text: 'd' },
          ' ',
          { type: 'code', text: 'e' },
          ' ',
          { type: 'url', text: 'f', url: 'https://x.org/p' },
          ' g',
        ],
      },
    ]);
  });

  it('nested emphasis', () => {
    expect(blocks('**a _b_**')).toEqual([
      { type: 'paragraph', text: { type: 'bold', text: ['a ', { type: 'italic', text: 'b' }] } },
    ]);
  });

  it('unordered, ordered and task lists', () => {
    expect(blocks('- a\n- b')).toEqual([
      {
        type: 'list',
        items: [{ blocks: [{ type: 'paragraph', text: 'a' }] }, { blocks: [{ type: 'paragraph', text: 'b' }] }],
      },
    ]);
    expect(blocks('3. x\n4. y')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: 'x' }], value: 3, type: '1' },
          { blocks: [{ type: 'paragraph', text: 'y' }], value: 4, type: '1' },
        ],
      },
    ]);
    expect(blocks('- [ ] todo\n- [x] done')).toEqual([
      {
        type: 'list',
        items: [
          { blocks: [{ type: 'paragraph', text: 'todo' }], has_checkbox: true },
          { blocks: [{ type: 'paragraph', text: 'done' }], has_checkbox: true, is_checked: true },
        ],
      },
    ]);
  });

  it('nested list', () => {
    const [list] = blocks('- a\n  - b\n    - c');
    expect(list).toMatchObject({
      type: 'list',
      items: [
        {
          blocks: [
            { type: 'paragraph', text: 'a' },
            { type: 'list', items: [{ blocks: [{ text: 'b' }, { type: 'list' }] }] },
          ],
        },
      ],
    });
  });

  it('fenced code with language', () => {
    expect(blocks('```python\nprint(1)\n```')).toEqual([{ type: 'pre', text: 'print(1)', language: 'python' }]);
    expect(blocks('```\nplain\n```')).toEqual([{ type: 'pre', text: 'plain' }]);
  });

  it('blockquote short vs long', () => {
    expect(blocks('> hi')).toEqual([{ type: 'blockquote', blocks: [{ type: 'paragraph', text: 'hi' }] }]);
    const long = blocks(`> ${'word '.repeat(150)}\n>\n> tail **b**`);
    expect(long).toHaveLength(1);
    expect(long[0].type).toBe('expandable_blockquote');
    expect(JSON.stringify(long[0])).toContain('"bold"');
  });

  it('table with alignment and header', () => {
    expect(blocks('| a | b |\n|:--|--:|\n| 1 | **2** |')).toEqual([
      {
        type: 'table',
        is_bordered: true,
        cells: [
          [
            { text: 'a', is_header: true, align: 'left', valign: 'top' },
            { text: 'b', is_header: true, align: 'right', valign: 'top' },
          ],
          [
            { text: '1', align: 'left', valign: 'top' },
            { text: { type: 'bold', text: '2' }, align: 'right', valign: 'top' },
          ],
        ],
      },
    ]);
  });

  it('table with >20 columns and <=20 rows is transposed', () => {
    const cols = 25;
    const row = (f: (i: number) => string) => `| ${Array.from({ length: cols }, (_, i) => f(i)).join(' | ')} |`;
    const md = [row((i) => `h${i}`), row(() => '---'), row((i) => `v${i}`)].join('\n');
    const [t] = blocks(md);
    expect(t.type).toBe('table');
    if (t.type !== 'table') return;
    expect(t.cells).toHaveLength(cols);
    expect(t.cells[0]).toEqual([
      { text: 'h0', is_header: true, align: 'left', valign: 'top' },
      { text: 'v0', align: 'left', valign: 'top' },
    ]);
    expect(Math.max(...t.cells.map((r) => r.length))).toBeLessThanOrEqual(LIMITS.maxTableColumns);
  });

  it('table with >20 columns and >20 rows becomes a list of "col: value" lines', () => {
    const cols = 22;
    const row = (f: (i: number) => string) => `| ${Array.from({ length: cols }, (_, i) => f(i)).join(' | ')} |`;
    const lines = [row((i) => `h${i}`), row(() => '---')];
    for (let r = 0; r < 25; r++) lines.push(row((i) => `r${r}c${i}`));
    const [l] = blocks(lines.join('\n'));
    expect(l.type).toBe('list');
    if (l.type !== 'list') return;
    expect(l.items).toHaveLength(25);
    const first = l.items[0].blocks[0];
    expect(first).toEqual({ type: 'paragraph', text: expect.stringContaining('h0: r0c0\nh1: r0c1') });
  });

  it('thematic break and math', () => {
    expect(blocks('---')).toEqual([{ type: 'divider' }]);
    expect(blocks('$$\nE = mc^2\n$$')).toEqual([{ type: 'mathematical_expression', expression: 'E = mc^2' }]);
    expect(blocks('```math\nx^2\n```')).toEqual([{ type: 'mathematical_expression', expression: 'x^2' }]);
    expect(blocks('so $x^2$ ok')).toEqual([
      { type: 'paragraph', text: ['so ', { type: 'mathematical_expression', expression: 'x^2' }, ' ok'] },
    ]);
  });

  it('money amounts are not math', () => {
    expect(blocks('costs $5 and $10 total')).toEqual([{ type: 'paragraph', text: 'costs $5 and $10 total' }]);
  });

  it('images become links with alt text, no media blocks', () => {
    expect(blocks('![cat](https://x.org/c.png)')).toEqual([
      { type: 'paragraph', text: { type: 'url', text: 'cat', url: 'https://x.org/c.png' } },
    ]);
    expect(blocks('![cat](javascript:alert(1))')).toEqual([{ type: 'paragraph', text: 'cat' }]);
  });

  it('link schemes: http/https/mailto only', () => {
    expect(blocks('[a](mailto:me@x.org)')).toEqual([
      { type: 'paragraph', text: { type: 'email_address', text: 'a', email_address: 'me@x.org' } },
    ]);
    expect(blocks('[a](mailto:me%40x.org)')).toEqual([
      { type: 'paragraph', text: { type: 'email_address', text: 'a', email_address: 'me@x.org' } },
    ]);
    for (const bad of [
      'tg://resolve?domain=x&startapp=y',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      '/relative',
      'ftp://x.org',
      'java%0Ascript:alert(1)',
    ]) {
      expect(blocks(`[a](${bad})`)).toEqual([{ type: 'paragraph', text: 'a' }]);
    }
  });

  it('reference-style links resolve', () => {
    expect(blocks('[a][r]\n\n[r]: https://x.org')).toEqual([
      { type: 'paragraph', text: { type: 'url', text: 'a', url: 'https://x.org' } },
    ]);
  });

  it('details: whitelisted pattern with recursive markdown', () => {
    const md = '<details>\n<summary>Why **so**</summary>\n\n- one\n- two\n\n```js\nx\n```\n\n</details>';
    const [d] = blocks(md);
    expect(d).toEqual({
      type: 'details',
      summary: ['Why ', { type: 'bold', text: 'so' }],
      blocks: [
        {
          type: 'list',
          items: [{ blocks: [{ type: 'paragraph', text: 'one' }] }, { blocks: [{ type: 'paragraph', text: 'two' }] }],
        },
        { type: 'pre', text: 'x', language: 'js' },
      ],
    });
  });

  it('details on a single html node, with open attribute', () => {
    expect(blocks('<details open><summary>S</summary>body *i*</details>')).toEqual([
      {
        type: 'details',
        summary: 'S',
        is_open: true,
        blocks: [{ type: 'paragraph', text: ['body ', { type: 'italic', text: 'i' }] }],
      },
    ]);
  });

  it('nested details', () => {
    const md =
      '<details><summary>A</summary>\n\n<details><summary>B</summary>\n\ninner\n\n</details>\n\nafter\n\n</details>';
    const [d] = blocks(md);
    expect(d).toMatchObject({
      type: 'details',
      summary: 'A',
      blocks: [
        { type: 'details', summary: 'B', blocks: [{ type: 'paragraph', text: 'inner' }] },
        { type: 'paragraph', text: 'after' },
      ],
    });
  });
});

describe('raw HTML never reaches the output', () => {
  const hostile = [
    '<tg-button type="web_app" url="https://evil.example">pay</tg-button>',
    '<tg-button-row><tg-button type="callback_data" data="x">x</tg-button></tg-button-row>',
    '<a href="javascript:alert(1)">click</a>',
    '[click](javascript:alert(1))',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'text <tg-button type="url" url="https://e.x">b</tg-button> text',
    '<details><summary>ok</summary><tg-button type="url" url="https://e.x">b</tg-button></details>',
    '<tg-math-block>x</tg-math-block>',
    '<iframe src="https://evil"></iframe>',
  ];
  it.each(hostile)('%s', (md) => {
    const json = JSON.stringify(renderMarkdown(md).messages);
    for (const needle of [
      'tg-button',
      'tg-math',
      '<script',
      '<iframe',
      '<img',
      'javascript:',
      'onerror=',
      'web_app',
      'callback_data',
      '"buttons"',
      '<a ',
    ]) {
      expect(json).not.toContain(needle);
    }
  });

  it('uses only the blocks form', () => {
    const { messages } = renderMarkdown('# hi\n\n<b>x</b>');
    for (const m of messages) {
      expect(Object.keys(m)).toEqual(['blocks']);
    }
  });
});

describe('nesting limit', () => {
  it('deeply nested lists / quotes / emphasis stay within 16 levels', () => {
    let md = '';
    for (let i = 0; i < 30; i++) md += `${'  '.repeat(i)}- item ${i}\n`;
    let quote = '';
    for (let i = 0; i < 30; i++) quote += `${'>'.repeat(i + 1)} q${i}\n`;
    const emph = `${'*a **b '.repeat(10)}x${' b** a*'.repeat(10)}`;
    for (const src of [md, quote, emph]) {
      const bs = blocks(src);
      expect(measureBlocks(bs).depth).toBeLessThanOrEqual(LIMITS.maxNesting);
    }
    expect(JSON.stringify(blocks(md))).toContain('item 29');
    expect(JSON.stringify(blocks(quote))).toContain('q29');
  });
});

const BIG_ANSWER = `# Quarterly report

Intro with **bold**, _italic_, \`code\` and a [link](https://example.com). Euler: $e^{i\\pi}+1=0$.

## Metrics

| id | name | q1 | q2 | q3 | q4 |
|----|:-----|---:|---:|---:|---:|
| 1 | alpha | 10 | 20 | 30 | 40 |
| 2 | beta | 11 | 21 | 31 | 41 |

## Steps

1. First
   - nested a
   - nested b
     - deeper
2. Second
   - [x] done
   - [ ] todo

\`\`\`ts
export const x: number = 1;
\`\`\`

> A short quote.

<details>
<summary>Что я сделал</summary>

- read files
- ran tests

</details>

$$
\\int_0^1 x\\,dx = \\tfrac12
$$

---

Done.
`;

describe('large realistic answer', () => {
  it('maps every construct and stays in one message', () => {
    const r = renderMarkdown(BIG_ANSWER);
    expect(r.messages).toHaveLength(1);
    const types = (r.messages[0].blocks ?? []).map((b) => b.type);
    expect(types).toEqual([
      'heading',
      'paragraph',
      'heading',
      'table',
      'heading',
      'list',
      'pre',
      'blockquote',
      'details',
      'mathematical_expression',
      'divider',
      'paragraph',
    ]);
    const table = (r.messages[0].blocks ?? []).find((b) => b.type === 'table');
    expect(table && table.type === 'table' && table.cells[0]).toHaveLength(6);
    expect(r.stats.parts).toBe(1);
    expect(r.stats.blocks).toBeGreaterThan(15);
    expect(r.plainFallback.every((c) => c.length <= 4096)).toBe(true);
    expect(r.plainFallback.join('\n')).toContain('Что я сделал');
  });
});

function section(i: number, words = 300): string {
  return `## Section ${i}\n\n${'lorem ipsum '.repeat(words)}\n\n### Sub ${i}\n\nsub text ${i}\n`;
}

describe('splitting', () => {
  const textOf = (m: InputRichMessage) => JSON.stringify(m.blocks);
  const fitsLimits = (m: InputRichMessage) => {
    const mm = measureBlocks(m.blocks ?? []);
    return mm.blocks <= LIMITS.maxBlocks && mm.chars <= LIMITS.maxChars && mm.depth <= LIMITS.maxNesting;
  };

  it('keeps one message when it fits (no continuation footer)', () => {
    const r = renderMarkdown('# a\n\nb');
    expect(r.messages).toHaveLength(1);
    expect(textOf(r.messages[0])).not.toContain('продолжение');
  });

  it('splits a 40k-char answer at H2 boundaries and marks continuation', () => {
    const md = Array.from({ length: 12 }, (_, i) => section(i)).join('\n');
    expect(md.length).toBeGreaterThan(40_000);
    const r = renderMarkdown(md);
    expect(r.messages.length).toBeGreaterThan(1);
    r.messages.forEach((m, i) => {
      expect(fitsLimits(m)).toBe(true);
      const last = m.blocks![m.blocks!.length - 1];
      if (i < r.messages.length - 1) expect(last).toEqual({ type: 'footer', text: 'продолжение ниже ↓' });
      else expect(textOf(m)).not.toContain('продолжение');
      // each part (after the first) starts at a section heading
      const first = m.blocks![0];
      expect(first.type).toBe('heading');
    });
    // nothing lost
    const all = r.messages.map(textOf).join('');
    for (let i = 0; i < 12; i++) expect(all).toContain(`Section ${i}`);
    expect(r.stats.parts).toBe(r.messages.length);
  });

  it('splits 600+ blocks into parts of <= 500 blocks', () => {
    const md = Array.from({ length: 650 }, (_, i) => `para ${i}`).join('\n\n');
    const r = renderMarkdown(md);
    expect(r.messages).toHaveLength(2);
    r.messages.forEach((m) => expect(fitsLimits(m)).toBe(true));
    expect(r.stats.blocks).toBeGreaterThanOrEqual(650);
  });

  it('falls back to H3 when a single H2 section is too big', () => {
    const subs = Array.from({ length: 8 }, (_, i) => `### Sub ${i}\n\n${'x y '.repeat(2000)}\n`).join('\n');
    const r = renderMarkdown(`## Only section\n\n${subs}`);
    expect(r.messages.length).toBeGreaterThan(1);
    r.messages.slice(1).forEach((m) => {
      const first = m.blocks![0];
      expect(first.type === 'heading' && first.size === 3).toBe(true);
    });
  });

  it('splits one giant code block by lines into several pre blocks', () => {
    const code = Array.from({ length: 6000 }, (_, i) => `line ${i} ${'x'.repeat(10)}`).join('\n');
    const r = renderMarkdown(`before\n\n\`\`\`ts\n${code}\n\`\`\`\n\nafter`);
    expect(r.messages.length).toBeGreaterThan(1);
    const pres = r.messages
      .flatMap((m) => m.blocks!)
      .filter((b): b is Extract<InputRichBlock, { type: 'pre' }> => b.type === 'pre');
    expect(pres.length).toBeGreaterThan(1);
    expect(pres.every((p) => p.language === 'ts')).toBe(true);
    expect(pres.map((p) => p.text).join('\n')).toBe(code);
    r.messages.forEach((m) => expect(fitsLimits(m)).toBe(true));
  });

  it('never cuts inside a table or details block that fits', () => {
    const table = `| a | b |\n|---|---|\n${Array.from({ length: 100 }, (_, i) => `| r${i} | ${'v'.repeat(100)} |`).join('\n')}`;
    const details = `<details><summary>D</summary>\n\n${'detail text. '.repeat(500)}\n\n</details>`;
    const filler = Array.from({ length: 4 }, () => 'filler '.repeat(1800)).join('\n\n');
    const r = renderMarkdown(`${filler}\n\n${table}\n\n${filler}\n\n${details}\n\n${filler}`);
    expect(r.messages.length).toBeGreaterThan(1);
    const all = r.messages.flatMap((m) => m.blocks!);
    expect(all.filter((b) => b.type === 'table')).toHaveLength(1);
    expect(all.filter((b) => b.type === 'details')).toHaveLength(1);
  });

  it('honours custom maxChars / maxBlocks', () => {
    const r = renderMarkdown(Array.from({ length: 30 }, (_, i) => `p${i}`).join('\n\n'), { maxBlocks: 10 });
    expect(r.messages.length).toBeGreaterThanOrEqual(3);
    r.messages.forEach((m) => expect(measureBlocks(m.blocks!).blocks).toBeLessThanOrEqual(10));
  });

  it('empty input yields no messages', () => {
    expect(renderMarkdown('   ')).toMatchObject({ messages: [], plainFallback: [], stats: { parts: 0 } });
  });
});

describe('plain fallback', () => {
  it('chunks <= 4096 even for one huge paragraph and a huge code block', () => {
    const md = `${'word '.repeat(5000)}\n\n\`\`\`\n${'y'.repeat(9000)}\n\`\`\``;
    const r = renderMarkdown(md);
    expect(r.plainFallback.length).toBeGreaterThan(3);
    for (const c of r.plainFallback) expect(c.length).toBeLessThanOrEqual(4096);
  });

  it('does not split surrogate pairs', () => {
    const r = renderMarkdown('😀'.repeat(5000));
    for (const c of r.plainFallback) {
      expect(c.length).toBeLessThanOrEqual(4096);
      expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(c)).toBe(false);
    }
  });

  it('plainText strips formatting', () => {
    const t = plainText(
      '# T\n\n**b** and [l](https://x.org) and ![a](https://i.org/a.png)\n\n- [x] a\n- b\n\n1. one\n2. two\n\n| h | i |\n|--|--|\n| 1 | 2 |\n\n> q\n\n<b>raw</b>\n\n```js\ncode\n```',
    );
    expect(t).toBe(
      'T\n\nb and l (https://x.org) and a\n\n☑ a\n• b\n\n1. one\n2. two\n\nh | i\n1 | 2\n\n> q\n\nraw\n\ncode',
    );
  });
});

describe('streaming preview', () => {
  const types = (m: InputRichMessage) => (m.blocks ?? []).map((b) => b.type);

  it('empty -> thinking placeholder', () => {
    expect(types(renderStreamingPreview(''))).toEqual(['thinking']);
  });

  it('complete blocks are rendered, trailing paragraph is plain text', () => {
    const m = renderStreamingPreview('# Title\n\nFirst para.\n\nSecond **par');
    expect(m.blocks).toEqual([
      { type: 'heading', text: 'Title', size: 1 },
      { type: 'paragraph', text: 'First para.' },
      { type: 'paragraph', text: 'Second par' },
    ]);
  });

  it('a closed trailing paragraph (blank line after) is rendered as rich', () => {
    const m = renderStreamingPreview('Hello **x**\n\n');
    expect(m.blocks).toEqual([{ type: 'paragraph', text: ['Hello ', { type: 'bold', text: 'x' }] }]);
  });

  it('withholds an unclosed code fence', () => {
    const m = renderStreamingPreview('Intro.\n\n```ts\nconst a = 1;\nconst b');
    expect(JSON.stringify(m)).not.toContain('const');
    expect(types(m)).toEqual(['paragraph']);
  });

  it('keeps a closed code fence', () => {
    const m = renderStreamingPreview('Intro.\n\n```ts\nconst a = 1;\n```');
    expect(types(m)).toEqual(['paragraph', 'pre']);
  });

  it('withholds a table that is still receiving rows, shows it once closed', () => {
    const open = renderStreamingPreview('Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(types(open)).toEqual(['paragraph']);
    const closed = renderStreamingPreview('Before.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAfter');
    expect(types(closed)).toEqual(['paragraph', 'table', 'paragraph']);
  });

  it('withholds an unclosed details block', () => {
    const m = renderStreamingPreview('Intro.\n\n<details>\n<summary>S</summary>\n\nbody so far');
    expect(types(m)).toEqual(['paragraph']);
    const done = renderStreamingPreview('Intro.\n\n<details>\n<summary>S</summary>\n\nbody\n\n</details>');
    expect(types(done)).toEqual(['paragraph', 'details']);
  });

  it('withholds an unclosed $$ block', () => {
    const m = renderStreamingPreview('Intro.\n\n$$\nx^2 +');
    expect(types(m)).toEqual(['paragraph']);
  });

  it('list: finished items rich, last item as plain text', () => {
    const m = renderStreamingPreview('- one\n- two\n- thr **ee');
    expect(types(m)).toEqual(['list', 'paragraph']);
    expect(m.blocks![1]).toEqual({ type: 'paragraph', text: 'thr ee' });
  });

  it('never exceeds limits for a huge draft', () => {
    const md = Array.from({ length: 900 }, (_, i) => `para ${i}`).join('\n\n');
    const mm = measureBlocks(renderStreamingPreview(md).blocks!);
    expect(mm.blocks).toBeLessThanOrEqual(LIMITS.maxBlocks);
  });
});

describe('appendDetails / buttons', () => {
  it('appends a details block built from markdown', () => {
    const base = renderMarkdown('hello').messages[0];
    const out = appendDetails(base, 'Что я сделал', '- a\n- b');
    expect(base.blocks).toHaveLength(1); // immutable
    expect(out.blocks![1]).toMatchObject({ type: 'details', summary: 'Что я сделал', blocks: [{ type: 'list' }] });
  });

  it('buttonsBlock emits one buttons block per row, validating callback_data', () => {
    expect(
      buttonsBlock([
        [
          { text: 'Yes', callbackData: 'y' },
          { text: 'No', callbackData: 'n' },
        ],
        [{ text: 'Later', callbackData: 'l' }],
      ]),
    ).toEqual([
      {
        type: 'buttons',
        buttons: [
          { text: 'Yes', callback_data: 'y' },
          { text: 'No', callback_data: 'n' },
        ],
      },
      { type: 'buttons', buttons: [{ text: 'Later', callback_data: 'l' }] },
    ]);
    expect(() => buttonsBlock([[{ text: 'x', callbackData: 'я'.repeat(33) }]])).toThrow(/64 bytes/);
    expect(() => replyMarkup([[{ text: 'x', callbackData: '' }]])).toThrow();
    expect(replyMarkup([[{ text: 'x', callbackData: 'a' }]])).toEqual({
      inline_keyboard: [[{ text: 'x', callback_data: 'a' }]],
    });
  });

  it('splits rows wider than 8 buttons', () => {
    const row = Array.from({ length: 10 }, (_, i) => ({ text: `${i}`, callbackData: `${i}` }));
    const out = buttonsBlock([row]);
    expect(out).toHaveLength(2);
  });
});

describe('review regressions', () => {
  const allText = (md: string) => JSON.stringify(blocks(md));

  it('keeps markdown right after </details> in the same html block', () => {
    expect(allText('<details><summary>S</summary>\n\nbody\n\n</details>\nNext **important** paragraph')).toContain(
      'important',
    );
    expect(allText('<details><summary>S</summary>body</details>\nMore text here')).toContain('More text here');
  });

  it('keeps the text of non-whitelisted html blocks', () => {
    expect(allText('<br>\nImportant line')).toContain('Important line');
    expect(renderMarkdown('<br>\nImportant line').messages).toHaveLength(1);
    expect(allText('<div>\n<script>alert(1)</script>\nok')).not.toContain('<script');
  });

  it('streaming preview ignores <details> in prose and code spans', () => {
    const p = renderStreamingPreview('Use the `<details>` tag.\n\nSecond paragraph\n\nThird');
    expect(JSON.stringify(p)).toContain('Second paragraph');
    const q = renderStreamingPreview('Say <details> inline.\n\nAfter\n\n');
    expect(JSON.stringify(q)).toContain('After');
  });

  it('streaming preview withholds an unclosed fence inside a list item', () => {
    const p = renderStreamingPreview('Intro\n\n- ```py\n  x = 1\n\n  y = 2');
    expect(JSON.stringify(p)).not.toContain('y = 2');
  });

  it('empty table cells are visible, empty list items are not empty strings', () => {
    const [t] = blocks('| a | b |\n|---|---|\n| 1 |  |');
    if (t.type !== 'table') throw new Error('expected table');
    expect(t.cells[1][1].text).toBe(' ');
    expect(allText('-\n- a')).not.toContain('"text":""');
  });

  it('non-draft preview placeholder is not a thinking block', () => {
    expect(renderStreamingPreview('', { draft: false }).blocks?.[0].type).toBe('paragraph');
    expect(renderStreamingPreview('').blocks?.[0].type).toBe('thinking');
  });
});
