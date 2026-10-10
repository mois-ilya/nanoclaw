import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { openLink } from './tg';

// Raw HTML in the source is dropped (renderer returns '' for html tokens); the result is then sanitized anyway.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html: () => '',
    image: ({ text }) => (text ? `<span>${text.replace(/[<>&]/g, '')}</span>` : ''),
  },
});

let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });
}

export function renderMarkdown(src: string): string {
  hook();
  const html = md.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'input'],
    ALLOWED_ATTR: ['href', 'rel', 'target', 'type', 'checked', 'disabled'],
    ALLOWED_URI_REGEXP: /^(?:https?:|tg:|mailto:)/i,
  });
}

/** Delegated click handler: external links go through Telegram.WebApp.openLink. */
export function interceptLinks(e: MouseEvent): void {
  const a = (e.target as HTMLElement | null)?.closest?.('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href) openLink(href);
}

/** Splits a leading YAML frontmatter block (OKF memory notes) from the body; `title` is its `title:` value if any. */
export function splitFrontmatter(src: string): { title?: string; body: string } {
  const m = src.match(/^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { body: src };
  const t = m[1].match(/^title:[ \t]*(.+?)[ \t]*$/m);
  const title = t ? t[1].replace(/^(["'])(.*)\1$/, '$2').trim() : '';
  return { title: title || undefined, body: src.slice(m[0].length) };
}

/** Display title and body of a memory note: frontmatter `title:`, else the leading H1, else the file name. */
export function memoryDoc(src: string, path: string): { title: string; body: string } {
  const { title: fm, body } = splitFrontmatter(src);
  const h1 = body.match(/^\s*#\s+(.+)\n?/);
  const title = fm || (h1 ? h1[1].trim() : '') || path.split('/').pop()!.replace(/\.md$/, '');
  return { title, body: h1 ? body.slice(h1[0].length) : body };
}
