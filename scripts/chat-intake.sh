#!/bin/bash
# Chat intake (team chat → ledger) LaunchAgent entry point — see scripts/chat-intake.mjs.
# Idles (no connection) until SLACK_APP_TOKEN + SLACK_BOT_TOKEN are in data/secrets.env.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

. "$DIR/scripts/env.sh"   # sets NODE_BIN (nvm pin → newest nvm → Homebrew)

exec "$NODE_BIN" "$DIR/scripts/chat-intake.mjs" "$@"
