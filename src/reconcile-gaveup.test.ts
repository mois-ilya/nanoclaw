import { describe, expect, it, vi } from 'vitest';

vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(async (id: string) =>
    id === 'mg-1' ? { id: 'mg-1', channel_type: 'telegram', platform_id: 'telegram:42' } : undefined,
  ),
}));

import { noticeGaveUp } from './reconcile-session.js';
import type { Session } from './types.js';

const session = (over: Partial<Session> = {}): Session => ({
  id: 's1',
  agent_group_id: 'ag',
  messaging_group_id: 'mg-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: new Date().toISOString(),
  ...over,
});

describe('noticeGaveUp', () => {
  it('tells the user in their chat that a message was given up', async () => {
    const writeDirect = vi.fn(async () => undefined);
    await noticeGaveUp({ writeDirect } as never, session(), 2);
    expect(writeDirect).toHaveBeenCalledTimes(1);
    const m = writeDirect.mock.calls[0] as unknown as [
      { kind: string; platformId: string; channelType: string; content: string },
    ];
    expect(m[0]).toMatchObject({ kind: 'chat', platformId: 'telegram:42', channelType: 'telegram' });
    expect(JSON.parse(m[0].content).text).toContain('Пришли его ещё раз');
  });

  it('says nothing when nothing failed, for task threads, or when the chat is unknown', async () => {
    const writeDirect = vi.fn(async () => undefined);
    await noticeGaveUp({ writeDirect } as never, session(), 0);
    await noticeGaveUp({ writeDirect } as never, session({ thread_id: 'system:tasks:abc' }), 1);
    await noticeGaveUp({ writeDirect } as never, session({ messaging_group_id: 'mg-x' }), 1);
    await noticeGaveUp({ writeDirect } as never, session({ messaging_group_id: null }), 1);
    expect(writeDirect).not.toHaveBeenCalled();
  });

  it('a failing write never throws into the sweep', async () => {
    const writeDirect = vi.fn(async () => {
      throw new Error('db down');
    });
    await expect(noticeGaveUp({ writeDirect } as never, session(), 1)).resolves.toBeUndefined();
  });
});
