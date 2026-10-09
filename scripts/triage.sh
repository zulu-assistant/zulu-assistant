#!/bin/zsh
# Headless Mission Control triage pass (selfheal-wrapped by launchd).
# Hard-bounded: the --allowedTools list IS the policy enforcement — the model
# cannot run anything outside it.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CMUX_SOCKET_PASSWORD="$(cat "$ROOT/data/cmux-socket-password")" CMUX_QUIET=1
. "$ROOT/scripts/env.sh"   # Node/claude on PATH (nvm pin → newest → Homebrew)
mkdir -p "$ROOT/data/handoffs"
TRIAGE="$(mc_resolve config/TRIAGE.md)"
# engine: config/models.json engine.triage (scripts/engine.mjs). Codex has no per-tool
# allowlist: its pass runs in the workspace-write sandbox (writes only inside this
# repo), approvals off (headless), network on for the board on localhost.
if [ "$(node "$ROOT/scripts/engine.mjs" triage)" = codex ]; then
  CODEX_MODEL=$(python3 -c "import json,sys;c=json.load(open(sys.argv[1])).get('codex') or {};print(c.get('workerModel') or c.get('model') or '')" "$(mc_resolve config/models.json)")
  exec codex exec -s workspace-write -c sandbox_workspace_write.network_access=true --skip-git-repo-check -C "$ROOT" ${CODEX_MODEL:+-m "$CODEX_MODEL"} - < "$TRIAGE"
fi
MODEL=$("$ROOT/scripts/worker-model.sh")

# --allowedTools is variadic and consumes every following argument, so the
# prompt MUST arrive via stdin, never as a positional arg
ALLOWED="Read,Write,Edit,Bash(curl:*),Bash(cat:*),Bash(date:*),Bash(launchctl kickstart:*),Bash(docker restart:*),Bash(cmux notify:*),Bash(cmux list-workspaces:*),Bash(cmux read-screen:*),Bash(scripts/agent-spawn.sh:*)"
claude -p --model "$MODEL" --permission-mode acceptEdits \
  --allowedTools "$ALLOWED" < "$TRIAGE"
