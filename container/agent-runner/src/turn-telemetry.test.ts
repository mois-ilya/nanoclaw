// nanoclaw-fork tests: preview extraction, progress labels, coalescing, /stop.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery, runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';
import {
  extractPreview,
  labelForTool,
  MAX_STEPS_PER_TURN,
  PREVIEW_INTERVAL_MS,
  TurnTelemetry,
  turnTelemetry,
} from './turn-telemetry.js';

const origin = (name: string) => name === 'main';

describe('extractPreview', () => {
  it('returns null until an origin-addressed block opens', () => {
    expect(extractPreview('thinking out loud', origin)).toBeNull();
    expect(extractPreview('<message to="other">hi', origin)).toBeNull();
    expect(extractPreview('<message to="main', origin)).toBeNull();
  });
  it('strips the wrapper and returns the streaming body', () => {
    expect(extractPreview('<message to="main">Привет, ми', origin)).toEqual({ text: 'Привет, ми', closed: false });
  });
  it('hides a partially streamed close tag', () => {
    expect(extractPreview('<message to="main">Done</mess', origin)?.text).toBe('Done');
    expect(extractPreview('<message to="main">a < b', origin)?.text).toBe('a < b');
  });
  it('marks a closed block and ignores trailing text', () => {
    expect(extractPreview('<message to="main">Done</message> tail', origin)).toEqual({ text: 'Done', closed: true });
  });
  it('takes the last origin block, skipping other destinations', () => {
    const t = '<message to="main">one</message><message to="other">x</message><message to="main">two';
    expect(extractPreview(t, origin)).toEqual({ text: 'two', closed: false });
  });
  it('drops <internal> spans, complete or still open', () => {
    expect(extractPreview('<message to="main">a<internal>secret</internal>b', origin)?.text).toBe('ab');
    expect(extractPreview('<message to="main">a<internal>sec', origin)?.text).toBe('a');
  });
  it('caps very long text keeping the tail', () => {
    const r = extractPreview(`<message to="main">${'x'.repeat(10000)}END`, origin)!;
    expect(r.text.length).toBeLessThanOrEqual(3800);
    expect(r.text.endsWith('END')).toBe(true);
  });
});

describe('labelForTool', () => {
  it('maps tools to fixed Russian labels without raw args', () => {
    expect(labelForTool('WebFetch', { url: 'https://example.com/a?token=secret' })).toBe('Открываю страницу example.com');
    expect(labelForTool('WebSearch', { query: 'q'.repeat(100) })).toBe(`Ищу: ${'q'.repeat(39)}…`);
    expect(labelForTool('Read', { file_path: '/workspace/agent/notes.md' })).toBe('Читаю notes.md');
    expect(labelForTool('Edit', { file_path: '/a/b/c.ts' })).toBe('Пишу c.ts');
    expect(labelForTool('Bash', { command: 'cat /etc/secret' })).toBe('Выполняю команду');
    expect(labelForTool('Bash', { command: 'ncl tasks create --prompt x' })).toBe('Планирую задачу');
    expect(labelForTool('Bash', { command: 'agent-browser open https://news.site/x?y=1' })).toBe('Открываю страницу news.site');
    expect(labelForTool('Task', {})).toBe('Подзадача');
    expect(labelForTool('mcp__server__do_thing', {})).toBe('Инструмент do_thing');
    expect(labelForTool('TodoWrite', {})).toBeNull();
  });
});

const ROUTING = { platformId: 'c1', channelType: 'slack', threadId: null, inReplyTo: 'm1', taskRun: false };

function harness() {
  let t = 1_000;
  const rows: Array<Record<string, unknown>> = [];
  const tm = new TurnTelemetry({
    now: () => t,
    write: async (row) => {
      rows.push(JSON.parse(row.content));
    },
    isOriginDestination: (n) => n === 'main',
  });
  tm.setEnabled(true);
  return { tm, rows, advance: (ms: number) => (t += ms) };
}

describe('TurnTelemetry', () => {
  it('is inert until enabled and for task runs', async () => {
    const rows: unknown[] = [];
    const tm = new TurnTelemetry({ write: async (r) => void rows.push(r) });
    tm.beginTurn('m1', ROUTING);
    expect(tm.activeTurnId).toBeNull();
    tm.setEnabled(true);
    tm.beginTurn('m1', { ...ROUTING, taskRun: true });
    await tm.flush();
    expect(rows).toEqual([]);
  });

  it('coalesces previews to one per window and flushes the latest at the window end', async () => {
    const { tm, rows, advance } = harness();
    tm.beginTurn('m1', ROUTING);
    tm.onDeltaReset();
    tm.onDelta('<message to="main">He');
    advance(100);
    tm.onDelta('llo');
    advance(100);
    tm.onDelta(' wor');
    await tm.flush();
    const previews = () => rows.filter((r) => r.action === 'preview');
    expect(previews()).toEqual([{ action: 'preview', turnId: 'm1', seq: 1, text: 'He' }]);
    // The pending timer fires after the window and carries the cumulative text.
    await new Promise((r) => setTimeout(r, PREVIEW_INTERVAL_MS + 100));
    await tm.flush();
    expect(previews().map((r) => [r.seq, r.text])).toEqual([
      [1, 'He'],
      [2, 'Hello wor'],
    ]);
    tm.endTurn('finished');
    await tm.flush();
    expect(rows.map((r) => r.action === 'turn' ? r.state : r.action)).toEqual(['started', 'preview', 'preview', 'finished']);
  });

  it('emits progress running -> done/failed once per tool, bounded', async () => {
    const { tm, rows, advance } = harness();
    tm.beginTurn('m1', ROUTING);
    tm.toolStart('t1', 'Read', { file_path: '/x/a.txt' });
    tm.toolStart('t1', 'Read', { file_path: '/x/a.txt' }); // duplicate hook call
    advance(250);
    tm.toolEnd('t1', true);
    tm.toolStart('t2', 'Bash', { command: 'ls' });
    tm.toolEnd('t2', false, 12);
    tm.toolStart('t3', 'TodoWrite', {}); // unmapped
    for (let i = 0; i < MAX_STEPS_PER_TURN + 10; i++) tm.toolStart(`b${i}`, 'Bash', {});
    await tm.flush();
    const progress = rows.filter((r) => r.action === 'progress') as Array<{ seq: number; step: Record<string, unknown> }>;
    expect(progress.slice(0, 4).map((p) => [p.seq, p.step])).toEqual([
      [1, { id: 't1', label: 'Читаю a.txt', state: 'running' }],
      [2, { id: 't1', label: 'Читаю a.txt', state: 'done', ms: 250 }],
      [3, { id: 't2', label: 'Выполняю команду', state: 'running' }],
      [4, { id: 't2', label: 'Выполняю команду', state: 'failed', ms: 12 }],
    ]);
    expect(progress.length).toBe(4 + (MAX_STEPS_PER_TURN - 2));
  });

  it('remembers only an unfinished block as the stopped partial', async () => {
    const a = harness();
    a.tm.beginTurn('m1', ROUTING);
    a.tm.onDelta('<message to="main">half an ans');
    a.tm.endTurn('cancelled');
    expect(a.tm.takeStopped()?.partial).toBe('half an ans');
    expect(a.tm.takeStopped()).toBeNull();

    const b = harness();
    b.tm.beginTurn('m1', ROUTING);
    b.tm.onDelta('<message to="main">complete</message>');
    b.tm.endTurn('cancelled');
    expect(b.tm.takeStopped()?.partial).toBe('');
  });

  it('drops a stale stopped partial', async () => {
    const { tm, advance } = harness();
    tm.beginTurn('m1', ROUTING);
    tm.onDelta('<message to="main">x');
    tm.endTurn('cancelled');
    advance(31_000);
    expect(tm.takeStopped()).toBeNull();
  });
});

// ── runner integration: real poll loop + provider that honours abort() ──

function insertChat(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, 'channel-1', 'slack', NULL, ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify({ text }));
}

async function waitFor(predicate: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const systemRows = () =>
  getUndeliveredMessages()
    .filter((r) => r.kind === 'system')
    .map((r) => JSON.parse(r.content));

describe('runner integration', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb().exec(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
    );
    turnTelemetry.setEnabled(true);
  });
  afterEach(() => {
    turnTelemetry.setEnabled(false);
    closeSessionDb();
  });

  it('processQuery: started -> preview -> finished around a streamed answer', async () => {
    insertChat('m1', 'hi');
    const events: ProviderEvent[] = [
      { type: 'init', continuation: 's1' },
      { type: 'delta_reset' },
      { type: 'delta', text: '<message to="main">Hel' },
      { type: 'delta', text: 'lo</message>' },
      { type: 'text', text: '<message to="main">Hello</message>' },
      { type: 'result', text: '<message to="main">Hello</message>' },
    ];
    const query: AgentQuery = {
      push: () => {},
      end: () => {},
      abort: () => {},
      events: (async function* () {
        for (const e of events) yield e;
      })(),
    };
    await processQuery(query, { ...ROUTING, platformId: 'channel-1' }, ['m1'], 'mock', undefined, 'hi', undefined, true);
    await turnTelemetry.flush();
    const rows = systemRows();
    expect(rows.map((r) => (r.action === 'turn' ? `turn:${r.state}` : r.action))).toEqual([
      'turn:started',
      'preview',
      'turn:finished',
    ]);
    expect(rows[1]).toMatchObject({ turnId: 'm1', seq: 1, text: 'Hel' });
    expect(typeof rows[0].at).toBe('number');
  });

  it('/stop aborts the active query, cancels the turn and persists the partial', async () => {
    insertChat('m1', 'tell me a long story');
    const controller = new AbortController();
    let release: () => void = () => {};
    const aborted = new Promise<void>((r) => (release = r));
    let abortCalls = 0;
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: () => ({
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'keep-me' };
          yield { type: 'delta_reset' };
          yield { type: 'delta', text: '<message to="main">Once upon' };
          insertChat('stop-1', '/stop');
          await aborted; // a hung generation: only a real abort frees it
        })(),
        push: () => {},
        end: () => {},
        abort: () => {
          abortCalls++;
          release();
        },
      }),
    };
    const loop = runPollLoop({
      provider,
      providerContract: { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } },
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
    try {
      await waitFor(() => getUndeliveredMessages().some((r) => r.kind === 'chat'));
    } finally {
      controller.abort();
      await loop;
    }
    await turnTelemetry.flush();
    expect(abortCalls).toBeGreaterThanOrEqual(1);
    const states = systemRows()
      .filter((r) => r.action === 'turn')
      .map((r) => r.state);
    expect(states).toEqual(['started', 'cancelled']);
    const chat = getUndeliveredMessages().filter((r) => r.kind === 'chat');
    expect(chat).toHaveLength(1);
    expect(JSON.parse(chat[0].content)).toEqual({
      markdown: 'Once upon\n\n⏹ Остановлено — ответ неполный',
      nc: { stopped: true },
    });
    // The continuation survives (not /clear).
    const { getContinuation } = await import('./db/session-state.js');
    expect(getContinuation('mock')).toBe('keep-me');
  });

  it('/stop while nothing is being answered is completed without aborting the idle query', async () => {
    let aborts = 0;
    let release: () => void = () => {};
    const park = new Promise<void>((r) => (release = r));
    const query: AgentQuery = {
      push: () => {},
      end: () => {},
      abort: () => {
        aborts++;
        release();
      },
      events: (async function* (): AsyncGenerator<ProviderEvent> {
        await park;
      })(),
    };
    // Pre-warmed query: empty initial prompt, no turn in flight.
    const run = processQuery(query, { ...ROUTING, platformId: 'channel-1' }, [], 'mock', undefined, '', undefined, true);
    insertChat('stop-idle', '/stop');
    await new Promise((r) => setTimeout(r, 1200));
    const stillPending = getPendingMessages().some((m) => m.id === 'stop-idle');
    const abortsSeen = aborts;
    release();
    await run;
    expect(abortsSeen).toBe(0);
    expect(stillPending).toBe(false); // acknowledged, not left for a respawned query
  });

  it('/stop that aborts a turn tells the user about follow-ups queued behind it', async () => {
    insertChat('m1', 'long task');
    let release: () => void = () => {};
    const aborted = new Promise<void>((r) => (release = r));
    const controller = new AbortController();
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: () => ({
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'k' };
          yield { type: 'delta_reset' };
          yield { type: 'delta', text: '<message to="main">Working' };
          insertChat('m2', 'and also this'); // acknowledged and pushed into the running query
          await new Promise((r) => setTimeout(r, 900));
          insertChat('stop-2', '/stop');
          await aborted;
        })(),
        push: () => {},
        end: () => {},
        abort: () => release(),
      }),
    };
    const loop = runPollLoop({
      provider,
      providerContract: { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } },
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
    try {
      await waitFor(() => getUndeliveredMessages().some((r) => r.kind === 'chat' && String(r.content).includes('не успел обработать')));
    } finally {
      controller.abort();
      await loop;
    }
    const texts = getUndeliveredMessages()
      .filter((r) => r.kind === 'chat')
      .map((r) => JSON.parse(r.content).text ?? JSON.parse(r.content).markdown);
    expect(texts.some((t: string) => t.includes('Остановлено'))).toBe(true);
    expect(texts.some((t: string) => t.includes('пришли их ещё раз'))).toBe(true);
  });
});
