import { afterAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const optionsSeen: Record<string, unknown>[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    optionsSeen.push(options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-config-'));
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = configDir;
afterAll(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
});

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { TOOL_ALLOWLIST, SDK_DISALLOWED_TOOLS } = await import('./claude-config.js');

describe('Claude query options', () => {
  it('passes explicit built-in tools, the installed skills (read per query) and strictMcpConfig', () => {
    optionsSeen.length = 0;
    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

    provider.query({ prompt: 'first', cwd: '/workspace/agent' });
    fs.mkdirSync(path.join(configDir, 'skills', 'authored'), { recursive: true });
    provider.query({ prompt: 'second', cwd: '/workspace/agent' });

    expect(optionsSeen[0]!.tools).toEqual(TOOL_ALLOWLIST);
    expect(optionsSeen[0]!.skills).toEqual([]);
    expect(optionsSeen[1]!.skills).toEqual(['authored']);
    expect(optionsSeen[0]!.strictMcpConfig).toBe(true);
    expect(optionsSeen[0]!.disallowedTools).toEqual(SDK_DISALLOWED_TOOLS);
  });
});
