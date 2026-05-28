---
name: verify-telegram
description: Post-install validation for the unified /add-telegram skill.
---

# Verify Telegram

Run these in order. Stop at the first failure and fix the corresponding install step before continuing.

## 1. Static structure

```bash
echo '=== source files ==='
ls src/channels/telegram*.ts setup/pair-telegram.ts

echo '=== imports & registrations ==='
grep -q "import './telegram.js';" src/channels/index.ts && echo "  barrel: OK"   || echo "  barrel: MISSING"
grep -q "'pair-telegram':" setup/index.ts                && echo "  setup step: OK" || echo "  setup step: MISSING"

echo '=== package ==='
grep '"@chat-adapter/telegram"' package.json

echo '=== command-gate export ==='
grep -q '^export const ADMIN_COMMANDS' src/command-gate.ts && echo "  OK" || echo "  command-gate.ts not patched"
```

Every check must report OK / a real line. No `MISSING` allowed.

## 2. Build

```bash
pnpm run build
```

Must succeed without errors. TypeScript errors mean a patch did not apply correctly — check `src/channels/telegram.ts` and `src/channels/telegram-bot-commands.ts`.

## 3. Drift test (manifest vs. command-gate)

```bash
pnpm exec vitest run src/channels/telegram-bot-commands.test.ts
```

All four assertions must pass. If `every menu entry exists in command-gate ADMIN_COMMANDS` fails, the manifest references a slash the gate doesn't know — either add it to `ADMIN_COMMANDS` in `command-gate.ts` or remove the manifest entry.

## 4. Live API checks (require TELEGRAM_BOT_TOKEN in .env and service running)

```bash
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | sed 's/^TELEGRAM_BOT_TOKEN=//')
test -n "$TOKEN" || { echo "no token in .env — skipping live checks"; exit 0; }

echo '=== getMe (bot identity) ==='
curl -s "https://api.telegram.org/bot${TOKEN}/getMe" | jq '.result | {id, username, first_name}'

echo '=== getMyCommands (default scope) ==='
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/getMyCommands" \
  -H 'content-type: application/json' \
  -d '{"scope":{"type":"default"}}' | jq '.result'

echo '=== getMyCommands (all_private_chats scope) ==='
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/getMyCommands" \
  -H 'content-type: application/json' \
  -d '{"scope":{"type":"all_private_chats"}}' | jq '.result'
```

- `getMe` should return non-null `username` and `first_name` — these will populate the welcome flow and chat headers.
- Both `getMyCommands` calls should return an array matching `TELEGRAM_BOT_COMMANDS` (currently `clear`, `compact`, `cost`). If either is `[]`, `setMyCommands` didn't run — check `logs/nanoclaw.log` for `Telegram setMyCommands` warnings and confirm the service has restarted since install.

## 5. End-to-end (manual)

Send the bot a message in Telegram. Three things to verify:

- **Bot menu**: in the chat input, type `/` — a popup should show the three commands.
- **HTML rendering**: if you've wired an agent that emits HTML (`<b>`, `<i>`, `<code>`, etc.), tags should render — not appear as literal `&lt;b&gt;`.
- **Forum topics** (only if you have a forum chat): post in two different topics; each should produce a separate session (`pnpm exec tsx scripts/q.ts data/v2.db "SELECT thread_id, count(*) FROM sessions GROUP BY thread_id"` shows distinct rows).

If all five pass, the install is good.
