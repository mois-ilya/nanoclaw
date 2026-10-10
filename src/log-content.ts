// nanoclaw-fork: privacy switch for host logs (mirror of the runner's log-policy.ts).
//
// NANOCLAW_LOG_CONTENT=0 keeps user/agent content out of the logs: container
// stderr lines (the runner logs result text and scratchpad there) and stderr
// tails. Unset (or anything else) is the upstream behaviour. The host forwards
// the variable into the container so the runner applies the same policy.
export function logContentEnabled(): boolean {
  return process.env.NANOCLAW_LOG_CONTENT !== '0';
}
