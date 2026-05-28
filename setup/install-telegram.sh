#!/usr/bin/env bash
# Setup helper: install-telegram — non-interactive equivalent of the
# /add-telegram skill. Stays in sync with the skill by copying the skill's
# own source files for telegram.ts, telegram-bot-commands.ts, and the drift
# test from .claude/skills/add-telegram/files/. Base files (pairing, sanitize,
# their tests, pair-telegram setup step) come from origin/channels.
#
# Idempotent: every step is safe to re-run.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== NANOCLAW SETUP: INSTALL_TELEGRAM ==="

# Files copied from origin/channels (base components unchanged by our skill).
CHANNEL_FILES=(
  src/channels/telegram-pairing.ts
  src/channels/telegram-pairing.test.ts
  src/channels/telegram-markdown-sanitize.ts
  src/channels/telegram-markdown-sanitize.test.ts
  setup/pair-telegram.ts
)

# Files copied from .claude/skills/add-telegram/files/ (our skill-owned
# augmentations — HTML rendering, setMyCommands, supportsThreads, getMe).
SKILL_FILES=(
  src/channels/telegram.ts
  src/channels/telegram-bot-commands.ts
  src/channels/telegram-bot-commands.test.ts
)

needs_install=false
for f in "${CHANNEL_FILES[@]}" "${SKILL_FILES[@]}"; do
  [[ -f "$f" ]] || needs_install=true
done
grep -q "import './telegram.js';" src/channels/index.ts || needs_install=true
grep -q "'pair-telegram':" setup/index.ts || needs_install=true
grep -q '"@chat-adapter/telegram": "4.27.0"' package.json || needs_install=true
grep -q '^export const ADMIN_COMMANDS' src/command-gate.ts || needs_install=true
[[ -d node_modules/@chat-adapter/telegram ]] || needs_install=true

if ! $needs_install; then
  echo "STATUS: already-installed"
  echo "=== END ==="
  exit 0
fi

echo "STEP: fetch-channels-branch"
git fetch origin channels

echo "STEP: copy-base-files"
for f in "${CHANNEL_FILES[@]}"; do
  git show "origin/channels:$f" > "$f"
done

echo "STEP: copy-skill-files"
for f in "${SKILL_FILES[@]}"; do
  src=".claude/skills/add-telegram/files/$(basename "$f")"
  if [[ ! -f "$src" ]]; then
    echo "STATUS: failed"
    echo "ERROR: missing skill file ${src} — is .claude/skills/add-telegram intact?"
    echo "=== END ==="
    exit 1
  fi
  cp "$src" "$f"
done

echo "STEP: install-container-skill"
mkdir -p container/skills/telegram
cp .claude/skills/add-telegram/files/container-skill.md container/skills/telegram/SKILL.md

echo "STEP: export-admin-commands"
if ! grep -q '^export const ADMIN_COMMANDS' src/command-gate.ts; then
  # Convert `const ADMIN_COMMANDS = ...` → `export const ADMIN_COMMANDS = ...`
  # awk for BSD/GNU portability.
  awk '
    /^const ADMIN_COMMANDS = / { print "export " $0; next }
    { print }
  ' src/command-gate.ts > src/command-gate.ts.tmp \
    && mv src/command-gate.ts.tmp src/command-gate.ts
fi

echo "STEP: register-import"
if ! grep -q "import './telegram.js';" src/channels/index.ts; then
  printf "import './telegram.js';\n" >> src/channels/index.ts
fi

echo "STEP: register-setup-step"
if ! grep -q "'pair-telegram':" setup/index.ts; then
  awk '
    { print }
    /register: \(\) => import/ && !inserted {
      print "  '\''pair-telegram'\'': () => import('\''./pair-telegram.js'\''),"
      inserted = 1
    }
  ' setup/index.ts > setup/index.ts.tmp && mv setup/index.ts.tmp setup/index.ts
fi

echo "STEP: pnpm-install"
pnpm install @chat-adapter/telegram@4.27.0

echo "STEP: pnpm-build"
pnpm run build

echo "STATUS: installed"
echo "=== END ==="
