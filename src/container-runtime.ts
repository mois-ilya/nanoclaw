/**
 * Container runtime constants.
 *
 * This file used to claim that "all runtime-specific logic lives here so
 * swapping runtimes means changing one file" while the actual runtime logic —
 * spawn argv, mounts, hardening, kill/stop, orphan reaping — lived in
 * `container-runner.ts` and the egress module. That logic now lives behind the
 * driver seam (`src/drivers/`), which is what makes the claim true.
 *
 * What is left is the binary name, still needed by the few paths that shell
 * Docker for something that is not a session: per-group image builds and the
 * egress lockdown network.
 */

/**
 * nanoclaw-fork: the runtime binary and a fixed argv prefix are configurable so
 * the residual non-session helpers (image inspect/build) can target a remote
 * Podman. Both default to plain `docker`, byte-identical to upstream.
 * `NANOCLAW_CONTAINER_RUNTIME_BIN=podman`,
 * `NANOCLAW_CONTAINER_RUNTIME_ARGS="--remote --url unix:///run/podman/podman.sock"`.
 */
export function containerRuntimeArgv(env: NodeJS.ProcessEnv = process.env): { bin: string; prefix: string[] } {
  const bin = env.NANOCLAW_CONTAINER_RUNTIME_BIN?.trim() || 'docker';
  const prefix = env.NANOCLAW_CONTAINER_RUNTIME_ARGS?.trim().split(/\s+/).filter(Boolean) ?? [];
  return { bin, prefix };
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = containerRuntimeArgv().bin;

/** Binary plus argv prefix as one shell-ready string, for the `exec`-style helpers. */
export const CONTAINER_RUNTIME_CMD = [CONTAINER_RUNTIME_BIN, ...containerRuntimeArgv().prefix].join(' ');
