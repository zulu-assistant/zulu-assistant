#!/bin/zsh
# Reach any agent in the directory (config/agents.json) from any shell.
#   agent-send.sh <name|title|workspace> "<one-line message>" [--task <id>] [--wake] [--as <your-name>]
# The board records the message on the task, then types it into the target's
# cmux pane if that pane is ready — never into a permission dialog or a
# half-typed draft (those queue and retry each minute for 24h). --wake also
# delivers into a busy session (Claude/Codex queue it for their next turn).
# Claude targets require --task. Claude callers can use SendMessage for the
# wake instead, after writing the task.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/env.sh"   # Node on PATH (nvm pin → newest → Homebrew)
exec node "$ROOT/scripts/mesh-cli.mjs" send "$@"
