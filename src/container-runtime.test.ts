import { describe, expect, it } from 'vitest';

import { containerRuntimeArgv } from './container-runtime.js';

describe('containerRuntimeArgv', () => {
  it('defaults to plain docker, as upstream', () => {
    expect(containerRuntimeArgv({})).toEqual({ bin: 'docker', prefix: [] });
  });

  it('takes the binary and argv prefix from the environment', () => {
    expect(
      containerRuntimeArgv({
        NANOCLAW_CONTAINER_RUNTIME_BIN: 'podman',
        NANOCLAW_CONTAINER_RUNTIME_ARGS: '--remote --url unix:///run/podman/podman.sock',
      }),
    ).toEqual({ bin: 'podman', prefix: ['--remote', '--url', 'unix:///run/podman/podman.sock'] });
  });
});
