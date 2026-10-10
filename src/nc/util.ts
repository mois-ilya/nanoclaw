/** Small shared helpers: escaping untrusted text for markdown, money, locks. */

/**
 * Neutralise untrusted text (names, usernames, first messages) before it is
 * interpolated into a product markdown message: control chars and newlines
 * collapse to spaces, then every ASCII punctuation char is backslash-escaped
 * (CommonMark allows escaping any of them), so no link, emphasis, html or
 * `<details>` can be injected.
 */
// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]+', 'g');

export function escapeMd(s: string, max = 200): string {
  const flat = s.replace(CONTROL, ' ').trim();
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return cut.replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

/** "$3.10" from USD micros. */
export function fmtUsd(micros: number): string {
  const usd = micros / 1_000_000;
  return `$${usd.toFixed(2).replace(/\.00$/, '')}`;
}

export function displayName(u: { firstName: string; lastName?: string }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').slice(0, 100) || 'без имени';
}

const chains = new Map<string, Promise<unknown>>();

/** Serialise async work per key (per-user gate decisions, provisioning). */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(key, tail);
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
