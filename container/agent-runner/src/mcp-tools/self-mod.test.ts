import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { addMcpServer } from './self-mod.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('add_mcp_server', () => {
  it('submits HTTPS MCP config through the existing approval action', async () => {
    const result = await addMcpServer.handler({ name: 'remote', url: 'https://mcp.example.com/mcp' });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toEqual({
      action: 'add_mcp_server',
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
    });
  });

  it('accepts non-secret query params', async () => {
    for (const url of [
      'https://mcp.datadoghq.com/v1/mcp?toolsets=apm,llmobs',
      'https://mcp.example.com/mcp?author=jane',
    ]) {
      const result = await addMcpServer.handler({ name: 'remote', url });
      expect(result.isError).not.toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(2);
  });

  it('rejects insecure or credential-bearing URLs before requesting approval', async () => {
    for (const url of [
      'http://mcp.example.com/mcp',
      'http://localhost.evil.com/mcp',
      'http://localhost:8080/mcp',
      'http://host.docker.internal:8080/mcp',
      'https://mcp.example.com/mcp?api_key=secret',
      'https://mcp.example.com/mcp?authorization=x',
      'https://mcp.example.com/mcp?authToken=x',
      'https://mcp.example.com/mcp#secret',
    ]) {
      const result = await addMcpServer.handler({ name: 'remote', url });
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects names that could carry config syntax', async () => {
    for (const args of [
      { name: 'docs] [mcp_servers.evil]', url: 'https://mcp.example.com/mcp' },
      { name: 'x'.repeat(65), url: 'https://mcp.example.com/mcp' },
    ]) {
      const result = await addMcpServer.handler(args);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('rejects stdio commands, env and headers, and a missing url', async () => {
    for (const args of [
      { name: 'remote', command: 'server' },
      { name: 'remote', command: 'server', url: 'https://mcp.example.com/mcp' },
      { name: 'remote', url: 'https://mcp.example.com/mcp', env: { FOO: 'bar' } },
      { name: 'remote', url: 'https://mcp.example.com/mcp', args: ['x'] },
      { name: 'remote', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'x' } },
      { name: 'remote' },
    ]) {
      const result = await addMcpServer.handler(args);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
