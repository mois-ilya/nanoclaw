import { afterEach, expect, it, vi } from 'vitest';

import { registerHooks } from './bind.js';
import type { AdapterHooks } from './port.js';

const hooks = (): AdapterHooks =>
  ({
    setPrivateGate: vi.fn(),
    setCommandHandler: vi.fn(),
    setProductCallbackHandler: vi.fn(),
    setTranscriber: vi.fn(),
    setGuestHandler: vi.fn(),
    setStopHandler: vi.fn(),
  }) as unknown as AdapterHooks;

afterEach(() => {
  delete process.env.NC_STT_URL;
});

it('registers no transcriber when NC_STT_URL is unset (voice gets the «не включена» copy)', () => {
  delete process.env.NC_STT_URL;
  const h = hooks();
  registerHooks(h);
  expect(h.setTranscriber).not.toHaveBeenCalled();
  expect(h.setPrivateGate).toHaveBeenCalled();
});

it('registers the transcriber when NC_STT_URL is set', () => {
  process.env.NC_STT_URL = 'http://127.0.0.1:8178';
  const h = hooks();
  registerHooks(h);
  expect(h.setTranscriber).toHaveBeenCalledTimes(1);
});
