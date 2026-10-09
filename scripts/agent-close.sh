#!/bin/zsh
# Close a worker's cmux workspace and mark it closed in the directory (history
# is kept). Usage: agent-close.sh <name|title|workspace-uuid>
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/env.sh"   # Node on PATH (nvm pin → newest → Homebrew)
export CMUX_SOCKET_PASSWORD="$(cat "$ROOT/data/cmux-socket-password")" CMUX_QUIET=1
INFO=$(node "$ROOT/scripts/mesh-cli.mjs" resolve "$1")
WS=$(print -r -- "$INFO" | python3 -c "import json,sys;print(json.load(sys.stdin)['workspaceId'] or '')")
NAME=$(print -r -- "$INFO" | python3 -c "import json,sys;print(json.load(sys.stdin)['name'])")
if [[ -n "$WS" ]]; then
  # clear the mesh pills/progress first (Tier 2), then close
  cmux clear-status task --workspace "$WS" >/dev/null 2>&1 || true
  cmux clear-status model --workspace "$WS" >/dev/null 2>&1 || true
  cmux clear-progress --workspace "$WS" >/dev/null 2>&1 || true
  cmux close-workspace --workspace "$WS" || true
fi
node "$ROOT/scripts/mesh-cli.mjs" deregister "$NAME"
curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
  -d "{\"kind\":\"sys\",\"text\":\"Mission Control closed worker: $NAME\"}" >/dev/null || true
