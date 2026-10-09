#!/bin/bash
# Start the Ops Board (LaunchAgent entry point). Node is
# resolved by scripts/env.sh so launchd (no shell profile) finds the same Node
# the interactive shell uses.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

. "$DIR/scripts/env.sh"   # sets NODE_BIN (nvm pin → newest nvm → Homebrew)

exec "$NODE_BIN" "$DIR/server.mjs"
