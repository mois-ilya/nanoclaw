---
name: remove-telegram
description: Cleanly remove the unified Telegram adapter installed by /add-telegram.
---

# Remove Telegram

Reverses every change `/add-telegram` made: source files, command-gate export, package, barrel imports, setup step. The user's `.env` token stays put (it's their property; deleting it would surprise the next install).

## Pre-flight (idempotent skip)

```bash
test -f src/channels/telegram.ts || echo "nothing to remove"
```

If the file doesn't exist, the rest is likely also clean — but run the steps anyway, each is a no-op if its target is missing.

## Step 1 — Stop the service (if running)

```bash
launchctl list 2>/dev/null | grep -q nanoclaw && \
  launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null || true
```

Linux/systemd users: `systemctl --user stop nanoclaw` (or your install's unit name).

## Step 2 — Delete source files

```bash
rm -f src/channels/telegram.ts \
      src/channels/telegram-pairing.ts \
      src/channels/telegram-pairing.test.ts \
      src/channels/telegram-markdown-sanitize.ts \
      src/channels/telegram-markdown-sanitize.test.ts \
      src/channels/telegram-bot-commands.ts \
      src/channels/telegram-bot-commands.test.ts \
      setup/pair-telegram.ts
rm -rf container/skills/telegram
```

## Step 3 — Revert the `command-gate.ts` export

Use the Edit tool. Skip if the `const` form is already there.

**old_string**:

```ts
export const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);
```

**new_string**:

```ts
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);
```

## Step 4 — Strip self-registration import

In `src/channels/index.ts`. Skip if not present.

**old_string**:

```ts
import './cli.js';
import './telegram.js';
```

**new_string**:

```ts
import './cli.js';
```

## Step 5 — Unregister the `pair-telegram` setup step

In `setup/index.ts`. Skip if not present.

**old_string**:

```ts
  register: () => import('./register.js'),
  'pair-telegram': () => import('./pair-telegram.js'),
  groups: () => import('./groups.js'),
```

**new_string**:

```ts
  register: () => import('./register.js'),
  groups: () => import('./groups.js'),
```

## Step 6 — Uninstall the adapter package

```bash
pnpm remove @chat-adapter/telegram
```

## Step 7 — Verify zero state

```bash
ls src/channels/ | grep -c '^telegram'        # → 0
test ! -d container/skills/telegram && echo 'container skill: removed' || echo 'still present'
grep -c "import './telegram.js'" src/channels/index.ts   # → 0
grep -c "'pair-telegram':" setup/index.ts     # → 0
grep -c '"@chat-adapter/telegram"' package.json    # → 0
grep -c '^export const ADMIN_COMMANDS' src/command-gate.ts    # → 0
pnpm run build                                # must succeed
```

All five counters must be `0` and the build must pass. If any non-zero, repeat the corresponding step.

## What stays

- `.env` `TELEGRAM_BOT_TOKEN` — preserved (it's the user's secret, not the skill's).
- `data/env/env` — preserved (same reason).
- Any agent groups, sessions, or messaging_groups created during pairing — preserved (data tier, not code tier).
