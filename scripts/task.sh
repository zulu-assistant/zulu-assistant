#!/bin/zsh
# Agent Mesh task ledger CLI (Claude, Codex, cron). Every cross-agent request
# is a task: ledger first, the message is only the wake. See AGENT-MESH.md.
#   task.sh create "<title>" --owner <agent> [--body ..] | claim | comment | block
#           | approve-request | approved-in-pane | check | close | list | show | mine   (task.sh help)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/env.sh"   # Node on PATH (nvm pin → newest → Homebrew)
exec node "$ROOT/scripts/mesh-cli.mjs" task "$@"
