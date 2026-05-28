/**
 * Telegram bot menu manifest. Pushed via setMyCommands when the adapter
 * connects.
 *
 * Source of truth: `src/command-gate.ts` ADMIN_COMMANDS. This list is a
 * curated subset of those — the commands that are useful to surface in
 * the blue-button menu users see when they type `/`.
 *
 * Maintenance contract:
 *   - Every entry's `command` MUST match (without leading slash) an entry
 *     in `ADMIN_COMMANDS` from `command-gate.ts`. The companion test
 *     `telegram-bot-commands.test.ts` enforces this — CI fails if drift.
 *   - Adding a new command: add to ADMIN_COMMANDS in command-gate.ts
 *     first, then add the manifest entry here, then restart the host —
 *     setMyCommands runs at adapter setup() and reflects the new list.
 *   - Removing: drop the entry here (command-gate keeps its gate),
 *     restart, the command vanishes from the menu but still works if
 *     typed manually.
 *
 * Telegram constraints (Bot API as of 2026-05): each `command` 1-32
 * chars, [a-z0-9_]; each `description` 1-256 chars; ≤100 entries total.
 */

export interface TelegramBotCommand {
  command: string;
  description: string;
}

export const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommand[] = [
  { command: 'clear', description: 'Start a fresh conversation' },
  { command: 'compact', description: 'Compress context to save tokens' },
  { command: 'cost', description: 'Show token usage so far' },
];
