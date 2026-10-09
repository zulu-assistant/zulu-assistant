#!/bin/zsh
# Launch Mission Control — the owner's master orchestration agent (models.json `master`).
# Run inside the pinned "⌘ MISSION CONTROL" cmux workspace.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CMUX_SOCKET_PASSWORD="$(cat "$ROOT/data/cmux-socket-password")" CMUX_QUIET=1
# durable mesh address = slug of this workspace's title (fallback: mission-control)
. "$ROOT/scripts/env.sh"   # Node/claude on PATH (nvm pin → newest → Homebrew)
TITLE=$(cmux workspace list --id-format both 2>/dev/null | grep -F "${CMUX_WORKSPACE_ID:-none}" | sed -E 's/^[* ]*workspace:[0-9]+ +[0-9A-F-]{36} +//; s/ +\[selected\]$//')
MESHNAME=$(node "$ROOT/scripts/mesh-cli.mjs" slug "${TITLE:-mission-control}")
MASTER=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['master'])" "$(mc_resolve config/models.json)")
CONTRACT="$(mc_resolve MISSION-CONTROL.md)"   # overlay/MISSION-CONTROL.md (examples/ twin in a public checkout)
mkdir -p "$ROOT/data/handoffs"
# Pre-approve the Master's routine instruments only (board reads, cmux socket,
# its own helper scripts, state/handoff files). Everything else — git, launchctl,
# arbitrary shell — still prompts the owner via the cmux Feed.
ALLOWED="Read,Write,Edit,Bash(curl:*),Bash(cat:*),Bash(ls:*),Bash(cmux:*),Bash(scripts/worker-model.sh:*),Bash(scripts/agent-spawn.sh:*),Bash(scripts/resident-launch.sh:*),Bash(scripts/agent-close.sh:*),Bash(scripts/task.sh:*),Bash(scripts/agent-send.sh:*),Bash(node scripts/mesh-cli.mjs:*)"
# Engine (config/models.json engine.master — scripts/engine.mjs). Codex has no
# --append-system-prompt-file or per-tool allowlist: it gets the contract as its
# first instruction and runs in its workspace-write sandbox with on-request
# approvals (network on: the board is on localhost). AGENTS.md rules apply too.
ENGINE=$(node "$ROOT/scripts/engine.mjs" master)
if [ "$ENGINE" = codex ]; then
  [ -n "${MC_RESUME:-}" ] && exec codex resume "$MC_RESUME"
  CODEX_MODEL=$(python3 -c "import json,sys;print((json.load(open(sys.argv[1])).get('codex') or {}).get('model') or '')" "$(mc_resolve config/models.json)")
  exec codex -s workspace-write -c sandbox_workspace_write.network_access=true -a on-request ${CODEX_MODEL:+-m "$CODEX_MODEL"} \
    "You are Mission Control, the owner's master agent (mesh address: $MESHNAME). Your operating contract is $CONTRACT — read it fully first and follow it. Then read data/MISSION-STATE.md if it exists, check the board (curl -s localhost:3210/api/status) and cmux list-workspaces, and give the owner a one-paragraph fleet + workforce status."
fi
# --allowedTools is variadic: another flag must follow it, or it swallows the
# initial prompt argument (learned twice — triage.sh has the same guard)
if [ -n "${MC_RESUME:-}" ]; then
  exec claude --allowedTools "$ALLOWED" --name "$MESHNAME" --model "$MASTER" \
    --append-system-prompt-file "$CONTRACT" --resume "$MC_RESUME"
fi
exec claude --allowedTools "$ALLOWED" \
  --name "$MESHNAME" \
  --model "$MASTER" \
  --append-system-prompt-file "$CONTRACT" \
  "Read data/MISSION-STATE.md if it exists, then check the board (curl -s localhost:3210/api/status) and cmux list-workspaces, and give the owner a one-paragraph fleet + workforce status."
