// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('markdown', () => {
  it('drops raw html and script, javascript: links', () => {
    const out = renderMarkdown('hi <script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) **b**');
    expect(out).not.toMatch(/<script|onerror|javascript:/i);
    expect(out).toContain('<strong>b</strong>');
  });
  it('keeps safe links with noopener', () => {
    expect(renderMarkdown('[a](https://example.com)')).toMatch(/href="https:\/\/example.com"[^>]*rel="noopener noreferrer"|rel="noopener noreferrer"[^>]*href/);
  });
});

describe('memory frontmatter', () => {
  const note = '---\ntype: person\ntitle: Аня\nupdated: 2026-10-01\n---\n# Аня\n\nДР 14 марта.';
  it('splits frontmatter and reads title', async () => {
    const { splitFrontmatter, memoryDoc, renderMarkdown } = await import('./markdown');
    expect(splitFrontmatter(note)).toEqual({ title: 'Аня', body: '# Аня\n\nДР 14 марта.' });
    expect(splitFrontmatter('# Просто')).toEqual({ body: '# Просто' });
    expect(memoryDoc(note, 'people/anya.md')).toEqual({ title: 'Аня', body: '\nДР 14 марта.' });
    expect(memoryDoc('---\ntype: x\n---\n# Заголовок\nтекст', 'a/b.md').title).toBe('Заголовок');
    expect(memoryDoc('без заголовка', 'a/b.md').title).toBe('b');
    expect(renderMarkdown(splitFrontmatter(note).body)).not.toContain('type: person');
  });
});
