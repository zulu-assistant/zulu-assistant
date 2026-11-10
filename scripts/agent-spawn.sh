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

# worker limit (SETTINGS.workers.max, default 3): a warning on the way in, never a refusal
CAPLINE=$(node "$MESH" worker-count 2>/dev/null || true)
if [[ -n "$CAPLINE" ]]; then
  echo "⚠ $CAPLINE" >&2
  curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
    -d "{\"kind\":\"sys\",\"text\":\"${CAPLINE//\"/}\"}" >/dev/null || true
fi

# one ledger task per spawn (skipped with a warning if the board is down)
TASK="${MESH_TASK:-}"
if [[ -z "$TASK" ]]; then
  TASK=$(node "$MESH" task create "$NAME" --as mission-control --handoff "$REPORT" --repo "$WCWD" \
          --body "Worker brief: $PROMPTFILE" 2>/dev/null | sed -n 's/^#\([0-9]*\).*/\1/p' | head -1) || true
fi
TASKLINE="(no ledger task — board was unreachable at spawn)"
[[ -n "$TASK" ]] && TASKLINE="Your ledger task is #$TASK. First action: \`$ROOT/scripts/task.sh claim $TASK\`."

# worktree-per-task (SETTINGS.worktrees, src/worktree.mjs; MESH_WORKTREE=0|1 overrides): the worker
# codes in its own <repo-parent>/wt-<task> on task/<task>-<slug>. The directory keeps the real repo.
REPO_DIR="$WCWD"
WTLINE=""
WTMODE=$(node "$MESH" worktree-mode worker "$SLUG" 2>/dev/null || echo off)
REPO_ABS="${WCWD/#\~/$HOME}"   # a quoted "~/x" cwd is not expanded by the shell
if [[ -n "$TASK" && "$WTMODE" != off ]] && git -C "$REPO_ABS" rev-parse --git-dir >/dev/null 2>&1; then
  if [[ "$WTMODE" == on ]]; then
    if WT=$(node "$MESH" task worktree "$TASK" --repo "$REPO_ABS" --as mission-control); then
      WCWD="$WT"
      WTLINE="You work in the git worktree \"$WT\" (its own branch, from the remote's main). Commit there, push the branch, open a PR — never edit \"$REPO_DIR\"'s own checkout. Ignored files (data/, .env*) are NOT in the worktree and must never be copied in; if you need them, block and say so. After the PR merges: \`$ROOT/scripts/task.sh worktree-clean $TASK\`."
    else
      echo "worktree: not created for #$TASK — the worker runs in $WCWD" >&2
    fi
  else
    curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
      -d "{\"kind\":\"sys\",\"text\":\"worktree (observe): would create wt-$TASK for $SLUG from ${REPO_DIR//\"/}\"}" >/dev/null || true
  fi
fi

cat >> "$PROMPTFILE" <<EOF

---
Agent Mesh: you are the worker "$SLUG" (address = slug of your workspace
name). $TASKLINE
$WTLINE
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
node "$MESH" register --workspace "$WSID" --title "$NAME" --kind worker --repo "$REPO_DIR" --vendor "$ENGINE" ${TASK:+--task "$TASK"} >/dev/null
# a task Mission Control owns (MESH_TASK) goes to the worker now, so its `task.sh claim` works;
# quiet: no "assigned" wake is typed into the pane (the brief says it). Anyone else's task is left alone.
[[ -n "$TASK" ]] && { node "$MESH" task adopt "$TASK" "$SLUG" --as mission-control >&2 || echo "spawn: #$TASK was not reassigned to $SLUG — assign it by hand" >&2; }
# sidebar pills (Tier 2): the task pill is re-derived from the ledger by the
# board once the worker claims; the model pill is static for the session
[[ -n "$TASK" ]] && cmux set-status task "#$TASK OPEN" --icon circle --color "#157A15" --priority 60 --workspace "$WSID" >/dev/null || true
cmux set-status model "${${MODEL#claude-}:-$ENGINE}" --icon cpu --color "#00A600" --priority 10 --workspace "$WSID" >/dev/null || true

KICK=$(node "$MESH" kick --workspace "$WSID" --file "$PROMPTFILE" --name "$SLUG" 2>&1) || true
curl -s -m 5 -X POST localhost:3210/api/event -H 'content-type: application/json' \
  -d "{\"kind\":\"sys\",\"text\":\"Mission Control spawned worker: $SLUG ($MODEL)${TASK:+ task #$TASK} — ${KICK//\"/}\"}" >/dev/null || true
echo "spawned: $SLUG ($MODEL) in $WCWD — $REF $WSID${TASK:+ — task #$TASK}"
echo "$KICK"
