/**
 * Adaptive model/effort tier selection for inbound messages.
 *
 * Looks at the user-typed text of a pending message batch and picks a tier
 * by matching trigger phrases. Higher tiers override lower ones (so
 * "ультрадумай" beats "подумай"). No-match leaves model/effort undefined,
 * which keeps the provider's constructor defaults.
 *
 * Triggers are case-insensitive and matched anywhere in the message text.
 */
import type { MessageInRow } from './db/messages-in.js';

export interface Tier {
  /** Short label for logs. */
  name: 'quick' | 'default' | 'think' | 'deep';
  /** Model override (alias `sonnet`/`opus`/`haiku` or full id). Undefined = use constructor default. */
  model?: string;
  /** Effort override (`low`/`medium`/`high`). Undefined = use constructor default. */
  effort?: string;
}

// Word-boundary delimiters that respect Unicode letters/digits — JavaScript's
// `\b` is ASCII-only, so `\bподумай\b` would silently never match Cyrillic
// input. Lookarounds with `\p{L}` handle Cyrillic + Latin uniformly. The `u`
// flag on each regex is required for `\p{L}` to mean "any unicode letter".
const W_BEFORE = '(?<![\\p{L}\\p{N}_])';
const W_AFTER = '(?![\\p{L}\\p{N}_])';
const wb = (inner: string): RegExp => new RegExp(`${W_BEFORE}(?:${inner})${W_AFTER}`, 'iu');

const TIERS: { tier: Tier; patterns: RegExp[] }[] = [
  // tier 4 — deep: explicit ask for the heaviest model. Order matters; this
  // runs first because it'd otherwise be shadowed by the broader Tier 3 match.
  {
    tier: { name: 'deep', model: 'opus', effort: 'high' },
    patterns: [
      wb('ultrathink'),
      wb('ультрадумай'),
      wb('опус'),
      wb('opus'),
      wb('глубоко\\s+(?:под|разбер|анализ)\\p{L}*'),
      wb('спроектируй'),
      wb('прорешай'),
      wb('architect'),
    ],
  },
  // tier 3 — think: user wants real reasoning, but Sonnet is enough.
  {
    tier: { name: 'think', model: 'sonnet', effort: 'high' },
    patterns: [
      wb('подумай'),
      wb('обдумай'),
      wb('тщательно'),
      wb('think\\s+hard'),
      wb('think\\s+carefully'),
      wb('step\\s+by\\s+step'),
      wb('шаг\\s+за\\s+шагом'),
    ],
  },
  // tier 1 — quick: trivial request, cheapest fast model.
  {
    tier: { name: 'quick', model: 'haiku', effort: undefined },
    patterns: [
      wb('быстро'),
      wb('кратко'),
      wb('coротко'),
      wb('сжато'),
      wb('tldr'),
      wb('tl;dr'),
    ],
  },
];

const DEFAULT_TIER: Tier = { name: 'default', model: undefined, effort: undefined };

function extractText(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string; markdown?: string };
    return parsed.text ?? parsed.markdown ?? '';
  } catch {
    return content;
  }
}

/**
 * Pick the model/effort tier for a batch of inbound messages.
 *
 * Concatenates message text across the batch so a triggering phrase in any
 * single message in the batch escalates the whole turn. Batched messages
 * are processed as one query at the SDK level — we couldn't route them to
 * two different models even if we wanted to.
 */
export function detectTier(messages: MessageInRow[]): Tier {
  const text = messages.map((m) => extractText(m.content)).join('\n');
  for (const { tier, patterns } of TIERS) {
    if (patterns.some((re) => re.test(text))) {
      return tier;
    }
  }
  return DEFAULT_TIER;
}
