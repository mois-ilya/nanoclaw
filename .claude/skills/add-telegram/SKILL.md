---
name: add-telegram
description: Install Telegram bot adapter with HTML rendering, forum-topic awareness, setMyCommands menu, and getMe-driven identity.
---

# Add Telegram Channel

Install and wire the Telegram bot adapter for NanoClaw. Single skill covering:

1. **HTML message rendering** (`parse_mode=HTML` via direct Bot API, bypassing the chat-sdk adapter's hardcoded MarkdownV2)
2. **Forum-topic awareness** (`supportsThreads=true` → per-topic NanoClaw sessions in supergroups with topics enabled)
3. **Bot command menu** (`setMyCommands` populated at startup from a manifest)
4. **Bot identity via `getMe`** (no hardcoded display name — the bot announces itself by whatever you set in BotFather)
5. **Pairing flow** (proves chat ownership before registration, promotes first paired user to owner)

Everything in this skill is idempotent — rerunning it on an already-installed setup is safe and a no-op.

## Pre-flight (idempotent skip)

Run all checks. If every condition holds, skip the install phase and jump to **Credentials**.

```bash
# Source files present
test -f src/channels/telegram.ts && \
test -f src/channels/telegram-pairing.ts && \
test -f src/channels/telegram-bot-commands.ts && \
test -f setup/pair-telegram.ts

# Container skill present (loaded into every agent container at runtime)
test -f container/skills/telegram/SKILL.md

# Self-registration import wired
grep -q "import './telegram.js';" src/channels/index.ts

# Setup step registered
grep -q "'pair-telegram':" setup/index.ts

# Package installed at pinned version
grep -q '"@chat-adapter/telegram": "4.27.0"' package.json

# command-gate exports ADMIN_COMMANDS (drift test depends on this)
grep -q 'export const ADMIN_COMMANDS' src/command-gate.ts
```

If any condition fails, install proceeds. Each step below tolerates already-applied state.

## Install

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy adapter base files from `origin/channels`

These are unchanged base components (pairing logic, markdown sanitizer, their tests, and the setup-step entry):

```bash
git show origin/channels:src/channels/telegram-pairing.ts                > src/channels/telegram-pairing.ts
git show origin/channels:src/channels/telegram-pairing.test.ts           > src/channels/telegram-pairing.test.ts
git show origin/channels:src/channels/telegram-markdown-sanitize.ts      > src/channels/telegram-markdown-sanitize.ts
git show origin/channels:src/channels/telegram-markdown-sanitize.test.ts > src/channels/telegram-markdown-sanitize.test.ts
git show origin/channels:setup/pair-telegram.ts                          > setup/pair-telegram.ts
```

### 3. Copy our skill-owned files into `src/channels/`

`telegram.ts` here is our augmented version (HTML deliver + setMyCommands + supportsThreads + getMe identity + reply_parameters); `telegram-bot-commands.ts` is the menu manifest; the `.test.ts` enforces the manifest-vs-command-gate drift contract.

```bash
cp .claude/skills/add-telegram/files/telegram.ts                      src/channels/telegram.ts
cp .claude/skills/add-telegram/files/telegram-bot-commands.ts         src/channels/telegram-bot-commands.ts
cp .claude/skills/add-telegram/files/telegram-bot-commands.test.ts    src/channels/telegram-bot-commands.test.ts
```

### 3a. Install the container-side skill

`container/skills/telegram/SKILL.md` ships into every agent container at runtime. It teaches the agent the Telegram-specific output rules (HTML tags only, `[[link-preview]]` opt-in, when to use `reply_to_seq` for native replies). Generic for any install — not per-group.

```bash
mkdir -p container/skills/telegram
cp .claude/skills/add-telegram/files/container-skill.md container/skills/telegram/SKILL.md
```

### 4. Export `ADMIN_COMMANDS` from `command-gate.ts`

The drift test imports it. Use the Edit tool — skip if `export const ADMIN_COMMANDS` is already there.

**old_string**:

```ts
const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);
```

**new_string**:

```ts
export const ADMIN_COMMANDS = new Set(['/clear', '/compact', '/context', '/cost', '/files']);
```

### 5. Wire the self-registration import in `src/channels/index.ts`

Use the Edit tool to append `import './telegram.js';` after the existing imports. Skip if already present.

**old_string** (current state — only `cli.js`):

```ts
import './cli.js';
```

**new_string**:

```ts
import './cli.js';
import './telegram.js';
```

### 6. Register the `pair-telegram` setup step

In `setup/index.ts`, add the entry to the `STEPS` map right after `register`. Skip if already present.

**old_string**:

```ts
  register: () => import('./register.js'),
  groups: () => import('./groups.js'),
```

**new_string**:

```ts
  register: () => import('./register.js'),
  'pair-telegram': () => import('./pair-telegram.js'),
  groups: () => import('./groups.js'),
```

### 7. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/telegram@4.27.0
```

### 8. Build and run the drift test

```bash
pnpm run build
pnpm exec vitest run src/channels/telegram-bot-commands.test.ts
```

Both must pass. If the drift test fails, the manifest contains a command that's not in `ADMIN_COMMANDS` — fix one or the other.

## Credentials

### Q1: Bot token

Ask the user (plain text, NOT `AskUserQuestion` — the token is a secret and free-text input is the right shape):

> Do you already have a Telegram bot token from @BotFather? If yes, paste it. If no, here's how to create one:
>
> 1. Open Telegram and message `@BotFather`
> 2. Send `/newbot`
> 3. Choose a name (any text — this is what `getMe` will return as `first_name`, and it's what your users see in chat headers and notifications)
> 4. Choose a username ending in `bot` (e.g. `mois_nanoclaw_bot`)
> 5. Paste the token here (looks like `123456:ABC-DEF1234...`)

Wait for the token. Then add to `.env` (overwriting if `TELEGRAM_BOT_TOKEN=` is already present):

```bash
grep -q '^TELEGRAM_BOT_TOKEN=' .env && \
  sed -i.bak "s|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=<the-token>|" .env && rm -f .env.bak || \
  echo "TELEGRAM_BOT_TOKEN=<the-token>" >> .env
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`.

### Q2: Group support (Group Privacy)

Ask via `AskUserQuestion`:

- **Question**: "Will this bot be used in group chats, not just direct messages?"
- **Header**: "Bot scope"
- Options:
  1. **Groups too** — "I'll use the bot in at least one group chat in addition to DMs."
  2. **DM only** — "Only direct messages. No group chats."

If **Groups too**: tell the user (plain text):

> By default Telegram bots in groups only see @mentions and commands. To let the bot see all group messages (required for NanoClaw to route to it):
>
> 1. Message `@BotFather` → `/mybots`
> 2. Pick your bot → **Bot Settings** → **Group Privacy** → **Turn off**
>
> Let me know when done.

Wait for confirmation. If **DM only**: skip the Group Privacy step.

### Q3: Forum topics (per-topic sessions)

Ask via `AskUserQuestion`:

- **Question**: "Will any of your group chats use Telegram forum topics (the tabbed-topics feature)?"
- **Header**: "Forum topics"
- Options:
  1. **Yes / maybe** — "At least one group has forum topics enabled, or might in the future."
  2. **No** — "All groups are flat (no topics) and will stay that way."

The adapter is configured with `supportsThreads: true` regardless — it costs nothing if no topics exist (messages without `message_thread_id` route to the chat's general session). The question is purely informational so the user knows what to expect.

If **Yes / maybe**: explain (plain text):

> Forum topics are enabled by a chat admin in Telegram's group settings — **the bot cannot enable them itself** via the Bot API. To enable for a group:
>
> 1. Open the group in Telegram → tap the group name → **Edit** (pencil icon)
> 2. Toggle **Topics** on
> 3. Telegram converts the group; existing messages move into a "General" topic
>
> Once enabled, every non-General topic in that group becomes its own NanoClaw session (separate context, separate container instance). Messages in the General topic share the chat's main session.

If **No**: skip the explanation.

## Service restart (only if running)

```bash
launchctl list 2>/dev/null | grep -q nanoclaw && \
  launchctl kickstart -k "gui/$(id -u)/$(. setup/lib/install-slug.sh 2>/dev/null && launchd_label 2>/dev/null || echo com.nanoclaw)"
```

If the service isn't running, skip — it'll pick up the new adapter on next start.

## Verification

Run `VERIFY.md` checks. Key signals:

1. Build succeeds.
2. `telegram-bot-commands.test.ts` passes.
3. If the token is set and the service is running: `getMyCommands` returns the manifest list (proves `setMyCommands` ran at startup).

## Next steps

If you're in the middle of `/setup`, return to the setup flow.

Otherwise, run `/init-first-agent` to wire the bot to a NanoClaw agent. The adapter exports `fetchBotIdentity(token)` (`src/channels/telegram.ts`) — any caller that wants the bot's BotFather-configured display name can call it instead of asking the user. The `init-first-agent` skill currently asks for the agent persona name; a follow-up will wire it to use `getMe.first_name` by default.

## Maintenance: keeping the bot menu in sync

The menu lives in **`src/channels/telegram-bot-commands.ts`**. To add a command:

1. Add the command (with leading slash) to `ADMIN_COMMANDS` in `src/command-gate.ts` first. The host gates inbound slashes against this set, so menu entries that aren't gated are misleading.
2. Add a `{ command, description }` entry to `TELEGRAM_BOT_COMMANDS` in the manifest file (without leading slash, lowercase `[a-z0-9_]`, ≤32 chars; description ≤256 chars).
3. Restart the host — `setMyCommands` fires inside `adapter.setup()` at every service start, so the menu refreshes automatically.

The drift test `src/channels/telegram-bot-commands.test.ts` fails CI if the manifest references a command that isn't in `ADMIN_COMMANDS`, so the two cannot silently fall out of sync.

To remove a command from the menu: drop the entry from the manifest. The command itself still works if typed (the gate decides that, not the menu).

## Channel Info

- **type**: `telegram`
- **terminology**: "groups" (multi-member) vs "chats" (DM with the bot). Forum topics in groups behave like sub-chats — each becomes its own NanoClaw session.
- **how-to-find-id**: do NOT ask the user for a chat ID. Use the pairing flow: `pnpm exec tsx setup/index.ts --step pair-telegram -- --intent <main|wire-to:folder|new-agent:folder>`. Show the 4-digit `CODE` from the `PAIR_TELEGRAM_ISSUED` block, tell the user to send the digits in the target chat (or `@<botname> CODE` in groups with Group Privacy on). On `PAIR_TELEGRAM STATUS=success` the response includes `PLATFORM_ID`, `IS_GROUP`, and `ADMIN_USER_ID`. The service must be running for this — pairing relies on the live polling loop. Pairing also promotes the first paired user to owner if no owner exists.
- **supports-threads**: **yes** (forum topics in supergroups). Inbound `message_thread_id` becomes part of the encoded thread ID; outbound delivery (HTML and Markdown paths) propagates it back.
- **typical-use**: interactive chat — DMs or small-to-medium groups.
- **default-isolation**: same agent group if you're the only participant across multiple chats. Separate agent group if different people are in different groups.
