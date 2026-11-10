#!/bin/zsh
# Close a worker's cmux workspace and mark it closed in the directory (history
# is kept). Usage: agent-close.sh <name|title|workspace-uuid> [--override "<why>"]
#
# Refuses while the agent still has live tasks or open PRs (its own tasks plus the
# task it was spawned on) and lists them. --override "<why>" closes anyway; the
# reason goes to the ticker. If the board cannot be asked, that is a refusal too.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/env.sh"   # Node on PATH (nvm pin → newest → Homebrew)
MESH="$ROOT/scripts/mesh-cli.mjs"
TARGET=""; OVERRIDE=""; WHY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --override) OVERRIDE=1; if [[ $# -gt 1 && "$2" != --* ]]; then WHY="$2"; shift; fi ;;
    *) [[ -z "$TARGET" ]] && TARGET="$1" ;;
  esac
  shift
done
[[ -n "$TARGET" ]] || { echo "usage: agent-close.sh <name|title|workspace-uuid> [--override \"<why>\"]" >&2; exit 2; }
export CMUX_SOCKET_PASSWORD="$(cat "$ROOT/data/cmux-socket-password")" CMUX_QUIET=1
INFO=$(node "$MESH" resolve "$TARGET")
WS=$(print -r -- "$INFO" | python3 -c "import json,sys;print(json.load(sys.stdin)['workspaceId'] or '')")
NAME=$(print -r -- "$INFO" | python3 -c "import json,sys;print(json.load(sys.stdin)['name'])")

# before anything is closed: the agent's live tasks and open PRs
if BLOCKERS=$(node "$MESH" close-check "$NAME" 2>&1); then :; else
  if [[ -z "$OVERRIDE" ]]; then
    echo "agent-close: $NAME is not closed — it still has:" >&2
    print -r -- "$BLOCKERS" | sed 's/^/  /' >&2
    echo "close or reassign these first, or close anyway with: agent-close.sh \"$TARGET\" --override \"<why>\"" >&2
    exit 3
  fi
  echo "agent-close: closing $NAME despite:" >&2
  print -r -- "$BLOCKERS" | sed 's/^/  /' >&2
  N=$(print -r -- "$BLOCKERS" | grep -c '^\(live task\|open PR\)' || true)
  SAFE_WHY="${WHY//\"/}"; SAFE_WHY="${SAFE_WHY//\\/}"
  curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
    -d "{\"kind\":\"bad\",\"text\":\"agent-close: $NAME closed with $N open item(s) left (override${SAFE_WHY:+: $SAFE_WHY})\"}" >/dev/null || true
fi

if [[ -n "$WS" ]]; then
  # clear the mesh pills/progress first (Tier 2), then close
  cmux clear-status task --workspace "$WS" >/dev/null 2>&1 || true
  cmux clear-status model --workspace "$WS" >/dev/null 2>&1 || true
  cmux clear-progress --workspace "$WS" >/dev/null 2>&1 || true
  # cmux ≥0.65 refuses to close a workspace with a live process (the worker's
  # own agent session) without --force; the caller has already read the pane.
  cmux close-workspace --workspace "$WS" --force || true
fi
# worktree-per-task: once the worker's session is gone, remove its tasks' worktrees — only the safe
# ones (worktree-clean refuses on uncommitted files, a live process, unpushed commits; never forces).
# The sweep covers the worker's own tasks and the task it was spawned on (also when Mission Control
# still owns that one). A refusal is reported and the worktree stays; the close goes ahead either way.
sleep 2
node "$MESH" task worktree-clean --owner "$NAME" --as mission-control || \
  echo "agent-close: a worktree of $NAME was left in place (see the task comment)" >&2
node "$MESH" deregister "$NAME"
curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
  -d "{\"kind\":\"sys\",\"text\":\"Mission Control closed worker: $NAME\"}" >/dev/null || true
