import { describe, expect, it } from 'vitest';

import { escapeMd, fmtUsd, withLock } from './util.js';
import { renderMarkdown } from '../channels/telegram/render/index.js';

describe('escapeMd', () => {
  it('neutralises markdown, links and html', () => {
    const e = escapeMd('[x](http://evil) **b** <details><summary>s</summary></details> `c`\n# h');
    expect(e).not.toContain('\n');
    const r = renderMarkdown(e);
    const json = JSON.stringify(r.messages);
    expect(json).not.toContain('http://evil"');
    expect(json).not.toContain('"details"');
  });
  it('bounds length', () => {
    expect(escapeMd('a'.repeat(1000), 50).length).toBeLessThanOrEqual(60);
  });
});

describe('misc', () => {
  it('formats money', () => {
    expect(fmtUsd(10_000_000)).toBe('$10');
    expect(fmtUsd(3_100_000)).toBe('$3.10');
  });
  it('serialises per key', async () => {
    const order: number[] = [];
    await Promise.all([
      withLock('k', async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      }),
      withLock('k', async () => {
        order.push(2);
      }),
    ]);
    expect(order).toEqual([1, 2]);
  });
});
