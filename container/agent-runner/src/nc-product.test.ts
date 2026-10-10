/**
 * nanoclaw-fork: product behaviour of the runner — suggested-reply buttons,
 * reminder/task markers, localized /clear, failure taxonomy, turn timeout, and
 * the host-injected DM line in task runs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { classifyFailure, FAILURE_COPY, isOverloadStatus } from './failure-class.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { MAX_SUGGESTIONS, normalizeSuggestions, sendReminder, sendTaskCreated, suggestReplies } from './mcp-tools/product.js';
import { clearConfirmation, processQuery } from './poll-loop.js';
import type { MessageInRow } from './db/messages-in.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => {
  delete process.env.NC_TURN_TIMEOUT_MS;
  delete process.env.NANOCLAW_CLEAR_TEXT;
  closeSessionDb();
});

function seedDest(name = 'dm', channelType = 'telegram', platformId = '42'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function publishRoute(platformId = '42', channelType = 'telegram'): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(
      'current_reply_route',
      JSON.stringify({ inReplyTo: 'm1', channelType, platformId, threadId: null }),
      new Date().toISOString(),
    );
}

const ROUTING = { platformId: '42', channelType: 'telegram', threadId: null, inReplyTo: 'm1' };

function stubQuery(events: AsyncGenerator<ProviderEvent>, onAbort?: () => void): AgentQuery {
  return { push: () => {}, end: () => {}, events, abort: () => onAbort?.() };
}

describe('suggest_replies', () => {
  it('normalizes: trims, dedups, caps count and label length', () => {
    expect(normalizeSuggestions(['  Сделай  план ', 'Сделай план', '', 7, 'x'.repeat(41), 'a', 'b', 'c'])).toEqual([
      'Сделай план',
      'a',
      'b',
    ]);
    expect(normalizeSuggestions('nope')).toEqual([]);
    expect(normalizeSuggestions(['1', '2', '3', '4']).length).toBe(MAX_SUGGESTIONS);
  });

  it('rejects an empty list', async () => {
    const r = await suggestReplies.handler({ replies: [] });
    expect(r.isError).toBe(true);
  });

  it('stamps the next user-visible chat row once, as nc.suggest', async () => {
    seedDest();
    publishRoute();
    const r = await suggestReplies.handler({ replies: ['Подробнее про B', 'Сделай план'] });
    expect(r.isError).not.toBe(true);

    await writeMessageOut({
      id: 'o1',
      kind: 'chat',
      platform_id: '42',
      channel_type: 'telegram',
      thread_id: null,
      content: JSON.stringify({ text: 'Вот ответ' }),
    });
    await writeMessageOut({
      id: 'o2',
      kind: 'chat',
      platform_id: '42',
      channel_type: 'telegram',
      thread_id: null,
      content: JSON.stringify({ text: 'Второе' }),
    });
    const rows = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(rows[0].nc.suggest).toEqual(['Подробнее про B', 'Сделай план']);
    expect(rows[1].nc).toEqual({ turnId: 'm1' }); // stamped with its turn, but no second suggestion
  });

  it('is not consumed by a failure notice or a row for another chat', async () => {
    seedDest();
    publishRoute();
    await suggestReplies.handler({ replies: ['Да'] });
    await writeMessageOut({
      id: 'f1',
      kind: 'chat',
      platform_id: '42',
      channel_type: 'telegram',
      thread_id: null,
      content: JSON.stringify({ text: 'oops', failureNotice: true }),
    });
    await writeMessageOut({
      id: 'x1',
      kind: 'chat',
      platform_id: '999',
      channel_type: 'telegram',
      thread_id: null,
      content: JSON.stringify({ text: 'elsewhere' }),
    });
    await writeMessageOut({
      id: 'o1',
      kind: 'chat',
      platform_id: '42',
      channel_type: 'telegram',
      thread_id: null,
      content: JSON.stringify({ text: 'answer' }),
    });
    const rows = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(rows[0].nc).toBeUndefined();
    expect(rows[1].nc).toBeUndefined();
    expect(rows[2].nc.suggest).toEqual(['Да']);
  });
});

describe('send_reminder / send_task_created', () => {
  it('write a chat row carrying the nc marker with the series id', async () => {
    seedDest();
    publishRoute();
    await sendReminder.handler({ to: 'dm', text: '⏰ Пора', seriesId: 'task-1' });
    await sendTaskCreated.handler({ to: 'dm', text: 'Ок', seriesId: 'task-2' });
    const rows = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(rows[0]).toEqual({ text: '⏰ Пора', nc: { turnId: 'm1', reminder: { seriesId: 'task-1' } } });
    expect(rows[1]).toEqual({ text: 'Ок', nc: { turnId: 'm1', taskCreated: { seriesId: 'task-2' } } });
  });

  it('require a series id', async () => {
    seedDest();
    const r = await sendReminder.handler({ to: 'dm', text: 'x' });
    expect(r.isError).toBe(true);
  });

  it('a pending suggestion does not leak onto a reminder row', async () => {
    seedDest();
    publishRoute();
    await suggestReplies.handler({ replies: ['Ок'] });
    await sendReminder.handler({ to: 'dm', text: '⏰', seriesId: 's' });
    const row = JSON.parse(getUndeliveredMessages()[0].content);
    expect(row.nc.suggest).toBeUndefined();
  });
});

describe('turn stamps on chat rows', () => {
  const write = (id: string, content: object, platform = '42') =>
    writeMessageOut({ id, kind: 'chat', platform_id: platform, channel_type: 'telegram', thread_id: null, content: JSON.stringify(content) });
  const rowsOut = () => getUndeliveredMessages().map((m) => JSON.parse(m.content));

  it('a chat turn stamps nc.turnId (the first inbound row of the batch) on its rows', async () => {
    publishRoute();
    await write('o1', { text: 'a' });
    await write('o2', { markdown: 'b' });
    expect(rowsOut().map((r) => r.nc)).toEqual([{ turnId: 'm1' }, { turnId: 'm1' }]);
  });

  it('a scheduled-task run stamps nc.source=task and the series, never a turn id', async () => {
    getOutboundDb()
      .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(
        'current_reply_route',
        JSON.stringify({ inReplyTo: 't1', channelType: 'telegram', platformId: '42', threadId: null, taskRun: true, seriesId: 'task-9' }),
        new Date().toISOString(),
      );
    await write('o1', { text: '⏰' });
    expect(rowsOut()[0].nc).toEqual({ source: 'task', seriesId: 'task-9' });
  });

  it('leaves stop notes, failure notices and rows for other chats alone', async () => {
    publishRoute();
    await write('s1', { markdown: 'partial', nc: { stopped: true } });
    await write('f1', { text: 'oops', failureNotice: true, failureClass: 'internal', nc: { turnId: 'm0' } });
    await write('e1', { operation: 'edit', messageId: '1', text: 'x' });
    await write('x1', { text: 'elsewhere' }, '999');
    const rows = rowsOut();
    expect(rows[0].nc).toEqual({ stopped: true });
    expect(rows[1].nc).toEqual({ turnId: 'm0' }); // the notice names the failed turn itself
    expect(rows[2].nc).toBeUndefined();
    expect(rows[3].nc).toBeUndefined();
  });
});

describe('/clear confirmation', () => {
  const row = (content: object) => ({ content: JSON.stringify(content) }) as MessageInRow;
  it('is silent for a host-originated /clear', () => {
    expect(clearConfirmation(row({ text: '/clear', nc: { silent: true } }))).toBeNull();
  });
  it('uses NANOCLAW_CLEAR_TEXT; empty means none', () => {
    process.env.NANOCLAW_CLEAR_TEXT = 'Начинаю заново';
    expect(clearConfirmation(row({ text: '/clear' }))).toBe('Начинаю заново');
    process.env.NANOCLAW_CLEAR_TEXT = ' ';
    expect(clearConfirmation(row({ text: '/clear' }))).toBeNull();
  });
  it('keeps the upstream text when nothing is configured', () => {
    expect(clearConfirmation(row({ text: '/clear' }))).toBe('Session cleared.');
  });
});

describe('failure taxonomy', () => {
  it('classifies by nanogate tokens and HTTP status', () => {
    expect(classifyFailure('429 global_cap_exceeded')).toBe('global_cap');
    expect(classifyFailure('429 {"error":"budget_exhausted"}')).toBe('budget');
    expect(classifyFailure('turn_cap_exceeded')).toBe('turn_cap');
    expect(classifyFailure('429 budget_insufficient_now')).toBe('busy');
    expect(classifyFailure('x-nanogate-budget: exhausted')).toBe('budget');
    expect(FAILURE_COPY.busy).toMatch(/параллельн/);
    expect(classifyFailure('API Error: 529 overloaded_error')).toBe('overload');
    expect(classifyFailure('rate_limit_error')).toBe('overload');
    expect(classifyFailure('boom', undefined, null)).toBe('internal');
    expect(isOverloadStatus(529)).toBe(true);
    expect(isOverloadStatus(400)).toBe(false);
  });

  it('writes fixed copy with the class, never the raw error', async () => {
    const raw = 'SECRET upstream text budget_exhausted';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's' };
      yield { type: 'result', text: null, isError: true, error: raw };
    }
    await processQuery(stubQuery(events()), ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const c = JSON.parse(out[0].content);
    expect(c).toMatchObject({ failureNotice: true, failureClass: 'budget', text: FAILURE_COPY.budget, nc: { turnId: 'm1' } });
    expect(out[0].content).not.toContain('SECRET');
  });

  it('prefers the provider failureClass', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's' };
      yield { type: 'result', text: null, isError: true, error: 'x', failureClass: 'global_cap' };
    }
    await processQuery(stubQuery(events()), ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    expect(JSON.parse(getUndeliveredMessages()[0].content).failureClass).toBe('global_cap');
  });
});

describe('turn wall-clock timeout', () => {
  it('aborts a runaway turn and reports a timeout with the continuation kept', async () => {
    process.env.NC_TURN_TIMEOUT_MS = '40';
    let aborted = false;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'keep-me' };
      while (!aborted) await new Promise((r) => setTimeout(r, 5));
    }
    const res = await processQuery(
      stubQuery(events(), () => {
        aborted = true;
      }),
      ROUTING,
      ['m1'],
      'claude',
      undefined,
      'prompt',
      undefined,
    );
    expect(aborted).toBe(true);
    expect(res.continuation).toBe('keep-me');
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    const c = JSON.parse(out[0].content);
    expect(c.failureNotice).toBe(true);
    expect(c.failureClass).toBe('timeout');
    expect(c.markdown).toContain('Задача шла слишком долго');
    expect(c.nc).toMatchObject({ turnId: 'm1', timeout: true });
  });

  it('does nothing when the turn finishes in time', async () => {
    process.env.NC_TURN_TIMEOUT_MS = '5000';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's' };
      yield { type: 'result', text: '<message to="dm">ok</message>' };
    }
    seedDest();
    await processQuery(stubQuery(events()), ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);
    const rows = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(rows.some((r) => r.failureClass)).toBe(false);
  });
});

describe('task-run prompt', () => {
  it('names the single DM destination as the delivery target', () => {
    seedDest('dm');
    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'rem-1' });
    expect(prompt).toContain('send_message({ to: "dm"');
    expect(prompt).toContain('send_reminder');
  });

  it('adds no delivery line when there is no channel destination', () => {
    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'rem-1' });
    expect(prompt).not.toContain('send_reminder');
  });

  it('chat prompt forbids acknowledgments', () => {
    seedDest('dm');
    const prompt = buildSystemPromptAddendum('Casa');
    expect(prompt).toContain('Do not send acknowledgments');
    expect(prompt).not.toContain('quick acknowledgment');
  });
});
