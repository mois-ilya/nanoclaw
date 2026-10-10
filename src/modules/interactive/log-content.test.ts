import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { info } = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn(), fatal: vi.fn() } }));
vi.mock('../../db/connection.js', () => ({ getDb: vi.fn(), hasTable: vi.fn(async () => true) }));
vi.mock('../../db/sessions.js', () => ({
  getPendingQuestion: vi.fn(async () => ({
    session_id: 's1',
    platform_id: 'p',
    channel_type: 'telegram',
    thread_id: null,
  })),
  getSession: vi.fn(async () => ({ id: 's1', agent_group_id: 'ag' })),
  deletePendingQuestion: vi.fn(async () => undefined),
}));
vi.mock('../../session-manager.js', () => ({ writeSessionMessage: vi.fn(async () => undefined) }));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => undefined) }));

import { getResponseHandlers } from '../../response-registry.js';
import './index.js';

const payload = {
  questionId: 'q1',
  value: 'Удалить все письма',
  userId: 'telegram:1',
  channelType: 'telegram',
  platformId: 'p',
  threadId: null,
};

beforeEach(() => info.mockClear());
afterEach(() => delete process.env.NANOCLAW_LOG_CONTENT);

describe('interactive response log', () => {
  it('logs the selected option by default', async () => {
    for (const h of getResponseHandlers()) if (await h(payload)) break;
    expect(info.mock.calls.find((c) => c[0] === 'Question response routed')?.[1]).toMatchObject({
      selectedOption: 'Удалить все письма',
    });
  });

  it('keeps the option text out of the log with NANOCLAW_LOG_CONTENT=0', async () => {
    process.env.NANOCLAW_LOG_CONTENT = '0';
    for (const h of getResponseHandlers()) if (await h(payload)) break;
    const fields = info.mock.calls.find((c) => c[0] === 'Question response routed')?.[1];
    expect(fields).toMatchObject({ questionId: 'q1', sessionId: 's1' });
    expect(JSON.stringify(fields)).not.toContain('Удалить');
  });
});
