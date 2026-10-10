// nanoclaw-fork: privacy switch for runner logs.
//
// NANOCLAW_LOG_CONTENT=0 keeps user/agent content out of the logs (result
// text, scratchpad, inbound text). Default (unset or anything else) is the
// upstream behaviour: content is logged.
export function logContentEnabled(): boolean {
  return process.env.NANOCLAW_LOG_CONTENT !== '0';
}

/** `text` truncated to `max` chars when content logging is on, else a length-only placeholder. */
export function contentForLog(text: string, max: number): string {
  if (!logContentEnabled()) return `[content hidden, ${text.length} chars]`;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
