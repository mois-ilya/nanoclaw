import { afterEach, expect, it } from 'bun:test';

import { contentForLog, logContentEnabled } from './log-policy.js';

afterEach(() => {
  delete process.env.NANOCLAW_LOG_CONTENT;
});

it('logs content by default (upstream behaviour) and truncates', () => {
  expect(logContentEnabled()).toBe(true);
  expect(contentForLog('abcdef', 3)).toBe('abc…');
});

it('NANOCLAW_LOG_CONTENT=0 hides content, keeping only the length', () => {
  process.env.NANOCLAW_LOG_CONTENT = '0';
  expect(logContentEnabled()).toBe(false);
  expect(contentForLog('secret text', 200)).toBe('[content hidden, 11 chars]');
});
