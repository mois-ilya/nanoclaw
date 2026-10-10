// nanoclaw-fork tests: delta events, tool hooks -> progress, and a real abort.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

let script: unknown[] = [];
let lastOptions: Record<string, any> | undefined;
let hang: Promise<void> | null = null;
const calls = { interrupt: 0, close: 0 };

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    lastOptions = args.options;
    const gen = (async function* () {
      for (const m of script) yield m;
      if (hang) await hang; // a turn that never produces another message by itself
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        calls.interrupt++;
      },
      close: () => {
        calls.close++;
      },
    });
  },
}));

process.env.NANOCLAW_ABORT_GRACE_MS = '50';
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { turnTelemetry } = await import('../turn-telemetry.js');

let tmp: string;
let prevHome: string | undefined;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-tt-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  script = [];
  hang = null;
  calls.interrupt = 0;
  calls.close = 0;
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function start() {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'hi', cwd: tmp });
}

const streamEvent = (event: unknown, parent: string | null = null) => ({
  type: 'stream_event',
  event,
  parent_tool_use_id: parent,
  uuid: 'u',
  session_id: 's',
});

describe('stream_event -> delta events', () => {
  it('surfaces top-level text deltas and message_start; ignores thinking, tool JSON and subagent text', async () => {
    script = [
      { type: 'system', subtype: 'init', session_id: 's' },
      streamEvent({ type: 'message_start', message: {} }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{' } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'SUB' } }, 'toolu_1'),
    ];
    const out: Array<{ type: string; text?: string }> = [];
    for await (const e of start().events) out.push(e as { type: string; text?: string });
    expect(out.filter((e) => e.type === 'delta' || e.type === 'delta_reset')).toEqual([
      { type: 'delta_reset' },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
    ]);
  });
});

describe('tool hooks -> progress', () => {
  it('PreToolUse/PostToolUse drive running/done; failure drives failed', async () => {
    const rows: Array<Record<string, any>> = [];
    const { TurnTelemetry } = await import('../turn-telemetry.js');
    const tm = new TurnTelemetry({ write: async (r) => void rows.push(JSON.parse(r.content)) });
    // Swap the singleton's behaviour: enable it and capture its writes.
    const spy = (turnTelemetry as any);
    const orig = { toolStart: spy.toolStart, toolEnd: spy.toolEnd };
    tm.setEnabled(true);
    tm.beginTurn('m1', { platformId: 'c', channelType: 'slack', threadId: null, inReplyTo: 'm1', taskRun: false });
    spy.toolStart = tm.toolStart.bind(tm);
    spy.toolEnd = tm.toolEnd.bind(tm);
    try {
      start();
      const pre = lastOptions!.hooks.PreToolUse[0].hooks[0];
      const post = lastOptions!.hooks.PostToolUse[0].hooks[0];
      const fail = lastOptions!.hooks.PostToolUseFailure[0].hooks[0];
      await pre({ tool_name: 'Read', tool_input: { file_path: '/a/b.md' }, tool_use_id: 't1' });
      await post({ tool_name: 'Read', tool_use_id: 't1', duration_ms: 40 });
      await pre({ tool_name: 'WebFetch', tool_input: { url: 'https://x.org/p' }, tool_use_id: 't2' });
      await fail({ tool_name: 'WebFetch', tool_use_id: 't2', duration_ms: 7 });
      await tm.flush();
      const steps = rows.filter((r) => r.action === 'progress').map((r) => r.step);
      expect(steps).toEqual([
        { id: 't1', label: 'Читаю b.md', state: 'running' },
        { id: 't1', label: 'Читаю b.md', state: 'done', ms: 40 },
        { id: 't2', label: 'Открываю страницу x.org', state: 'running' },
        { id: 't2', label: 'Открываю страницу x.org', state: 'failed', ms: 7 },
      ]);
    } finally {
      spy.toolStart = orig.toolStart;
      spy.toolEnd = orig.toolEnd;
    }
  });
});

describe('abort()', () => {
  it('ends the event stream at once even when the SDK is hung, interrupts, then closes the process', async () => {
    let release: () => void = () => {};
    hang = new Promise<void>((r) => (release = r));
    script = [{ type: 'system', subtype: 'init', session_id: 's' }];
    const q = start();
    const seen: string[] = [];
    const drained = (async () => {
      for await (const e of q.events) seen.push(e.type);
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toContain('init');
    const t0 = Date.now();
    q.abort();
    await drained; // would hang forever if abort() only ended the input stream
    expect(Date.now() - t0).toBeLessThan(500);
    expect(calls.interrupt).toBe(1);
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.close).toBe(1); // hard stop after the grace window
    release();
  });

  it('is idempotent', async () => {
    hang = new Promise<void>(() => {});
    const q = start();
    q.abort();
    q.abort();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls.interrupt).toBe(1);
    expect(calls.close).toBe(1);
  });
});
