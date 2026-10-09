#!/bin/zsh
# Spawn an ephemeral worker in a fresh cmux workspace.
# Usage: agent-spawn.sh "<workspace name>" "<cwd>" <promptfile> [model]
#   env MESH_TASK=<id>   attach the worker to an existing ledger task
#                        (default: a new task is created for the brief)
# Appends the report-back + mesh footer to the promptfile, resolves the worker
# model, registers the worker in config/agents.json (address = slug of the
# workspace name), launches claude with --name (durable across --resume and
# cmux restore), then submits the brief with a readiness check.
#
# Why no prompt argument: on Claude Code 2.1.280 a prompt passed as the CLI
# argument sometimes landed in the input box without being submitted. The kick
# waits for a ready input box, types a one-line pointer to the brief, and
# verifies the session went busy — re-pressing Enter if it did not.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="$1"; WCWD="$2"; PROMPTFILE="$3"
PW_FILE="$ROOT/data/cmux-socket-password"
export CMUX_SOCKET_PASSWORD="$(cat "$PW_FILE")" CMUX_QUIET=1
. "$ROOT/scripts/env.sh"   # Node/claude on PATH (nvm pin → newest → Homebrew)
MESH="$ROOT/scripts/mesh-cli.mjs"
# engine for workers (config/models.json `engine.worker`: claude | codex — scripts/engine.mjs);
# the Claude model is probed by worker-model.sh, Codex uses models.json codex.* or its own default
ENGINE=$(node "$ROOT/scripts/engine.mjs" worker)
MODEL="${4:-}"
[[ -z "$MODEL" && "$ENGINE" == claude ]] && MODEL=$("$ROOT/scripts/worker-model.sh")
SLUG=$(node "$MESH" slug "$NAME")
CHECKS=$(node "$MESH" checklist)      # the configured close checklist, in words
PROMPTFILE="$(cd "$(dirname "$PROMPTFILE")" && pwd)/$(basename "$PROMPTFILE")"

REPORT="$ROOT/data/handoffs/$(basename "${PROMPTFILE%.*}").report.md"

# one ledger task per spawn (skipped with a warning if the board is down)
TASK="${MESH_TASK:-}"
if [[ -z "$TASK" ]]; then
  TASK=$(node "$MESH" task create "$NAME" --as mission-control --handoff "$REPORT" --repo "$WCWD" \
          --body "Worker brief: $PROMPTFILE" 2>/dev/null | sed -n 's/^#\([0-9]*\).*/\1/p' | head -1) || true
fi
TASKLINE="(no ledger task — board was unreachable at spawn)"
[[ -n "$TASK" ]] && TASKLINE="Your ledger task is #$TASK. First action: \`$ROOT/scripts/task.sh claim $TASK\`."

cat >> "$PROMPTFILE" <<EOF

---
Agent Mesh: you are the worker "$SLUG" (address = slug of your workspace
name). $TASKLINE
Rules: $ROOT/AGENT-MESH.md — look up owners with \`$ROOT/scripts/mesh-cli.mjs agents\`;
cross-agent asks are tasks (\`task.sh create ... --owner <agent>\`), never free-form;
anything paid/outward/destructive → \`task.sh approve-request $TASK --policy "<POLICY.md line>"\` and wait.

Report-back protocol (required): when the task is done or you are blocked,
(1) write a concise report to "$REPORT" (outcome first, then what changed,
then anything needing the owner);
(2) completion = $CHECKS — then close the task with the checklist:
  $ROOT/scripts/task.sh close $TASK --checklist all --handoff "$REPORT" "<one-line outcome>"
(if blocked instead: \`task.sh block $TASK --on owner "<why>"\`);
(3) run:
  cmux set-status result done --icon checkmark   # or: result blocked
  cmux notify --title 'Worker: $NAME' --body '<one-line outcome>'
Your report is read by Mission Control — plain facts, no flourish.
EOF

# --id-format both: cmux prints the new UUID itself, so no listing lookup can
# race the creation; workspace-id falls back to a retried listing
# and a unique title match. The launch command comes from the engine layer
# (scripts/engine.mjs: claude | codex per config/models.json engine.worker).
OUT=$(cmux --id-format both new-workspace --name "$NAME" --cwd "$WCWD" --focus false \
  --command "export CMUX_SOCKET_PASSWORD=\"\$(cat '$PW_FILE')\" CMUX_QUIET=1; $(node "$ROOT/scripts/engine.mjs" cmd worker --name "$SLUG" ${MODEL:+--model "$MODEL"})")
REF=$(print -r -- "$OUT" | grep -o 'workspace:[0-9]*' | head -1)
WSID=$(node "$MESH" workspace-id "$OUT" --title "$NAME")
node "$MESH" register --workspace "$WSID" --title "$NAME" --kind worker --repo "$WCWD" --vendor "$ENGINE" >/dev/null
# sidebar pills (Tier 2): the task pill is re-derived from the ledger by the
# board once the worker claims; the model pill is static for the session
[[ -n "$TASK" ]] && cmux set-status task "#$TASK OPEN" --icon circle --color "#157A15" --priority 60 --workspace "$WSID" >/dev/null || true
cmux set-status model "${${MODEL#claude-}:-$ENGINE}" --icon cpu --color "#00A600" --priority 10 --workspace "$WSID" >/dev/null || true

KICK=$(node "$MESH" kick --workspace "$WSID" --file "$PROMPTFILE" --name "$SLUG" 2>&1) || true
curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
  -d "{\"kind\":\"sys\",\"text\":\"Mission Control spawned worker: $SLUG ($MODEL)${TASK:+ task #$TASK} — ${KICK//\"/}\"}" >/dev/null || true
echo "spawned: $SLUG ($MODEL) in $WCWD — $REF $WSID${TASK:+ — task #$TASK}"
echo "$KICK"
