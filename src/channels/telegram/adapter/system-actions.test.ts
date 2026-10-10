import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) =>
    id === 'mg-tg'
      ? { id, channel_type: 'telegram', platform_id: 'telegram:42' }
      : { id, channel_type: 'slack', platform_id: 'slack:1' },
}));

import { getDeliveryAction } from '../../../delivery.js';
import type { Session } from '../../../types.js';
import { FakeApi } from './fakes.js';
import { resetHooks, setUserPrefsProvider } from './hooks.js';
import { createRuntime, setRuntime, type TelegramRuntime } from './runtime.js';
import { MemoryStore } from './store.js';
import './system-actions.js';

const session = (mg: string | null): Session => ({ id: 'S', agent_group_id: 'ag', messaging_group_id: mg }) as Session;
let api: FakeApi;
let rt: TelegramRuntime;

beforeEach(() => {
  vi.useFakeTimers();
  resetHooks();
  setUserPrefsProvider(() => ({ showSteps: true }));
  api = new FakeApi();
  rt = createRuntime({ api: api.asBotApi(), store: new MemoryStore() });
  setRuntime(rt);
});
afterEach(() => {
  rt.turns.shutdown();
  rt.sched.stop();
  setRuntime(undefined);
  vi.useRealTimers();
});

describe('runner → host telemetry actions', () => {
  it('registers turn/preview/progress', () => {
    for (const a of ['turn', 'preview', 'progress']) expect(getDeliveryAction(a)).toBeTypeOf('function');
  });

  it('drives a turn for a telegram session; ignores other channels and malformed rows', async () => {
    const turn = getDeliveryAction('turn')!;
    const prog = getDeliveryAction('progress')!;
    const prev = getDeliveryAction('preview')!;
    await turn({ action: 'turn', turnId: 'T', state: 'started' }, session('mg-tg'));
    await prog(
      { action: 'progress', turnId: 'T', seq: 1, step: { id: 's', label: 'Читаю a.md', state: 'running' } },
      session('mg-tg'),
    );
    await prev({ action: 'preview', turnId: 'T', seq: 1, text: 'Привет' }, session('mg-tg'));
    await vi.advanceTimersByTimeAsync(2600);
    // the draft goes out at turn start; progress / preview refresh it
    const d = api.of('sendRichMessageDraft');
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(d[d.length - 1].params)).toContain('Читаю a.md');
    expect(JSON.stringify(d[d.length - 1].params)).toContain('Привет');

    await turn({ action: 'turn', turnId: 'X', state: 'started' }, session('mg-slack'));
    await turn({ action: 'turn', turnId: 5, state: 'started' } as never, session('mg-tg'));
    await turn({ action: 'turn', turnId: 'Y', state: 'weird' }, session('mg-tg'));
    await prog({ action: 'progress', turnId: 'T', seq: 'x' } as never, session('mg-tg'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.of('sendRichMessageDraft').every((c) => c.params.chat_id === 42)).toBe(true);
  });
});
