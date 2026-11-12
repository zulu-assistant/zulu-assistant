#!/bin/zsh
# Headless Mission Control triage pass (selfheal-wrapped by launchd).
# Bounded by its start line: four tools, no MCP server and no skills where this Claude Code
# can withhold them, plus --allowedTools for its shell commands.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export CMUX_SOCKET_PASSWORD="$(cat "$ROOT/data/cmux-socket-password")" CMUX_QUIET=1
. "$ROOT/scripts/env.sh"   # Node/claude on PATH (nvm pin → newest → Homebrew)
mkdir -p "$ROOT/data/handoffs"
# the gate knows this headless pass as headless:triage (no workspace to resolve; scripts/gate-hook.mjs passes it on)
export MESH_GATE_IDENTITY=triage
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
# the allow list only answers permission asks: tools that need none (helpers, messages, schedules, web reads…)
# stay available unless withheld (1.2.3: probed on 2.1.321, the pass held 29 built-in tools and every MCP
# server of the account). --tools names the whole built-in set, --strict-mcp-config with no --mcp-config loads
# no MCP server, and --disable-slash-commands loads no skills. A Claude Code without all three (2.0.1 lacks two
# of them) starts the pass as before, and the job's log says so.
TOOLS="Bash,Read,Write,Edit"
HELP="$(claude --help 2>/dev/null || true)"
has_flag() { print -r -- "$HELP" | grep -q -e "^  $1[ ,]" -e "^  $1\$"; }
BOUND=()
if has_flag --tools && has_flag --strict-mcp-config && has_flag --disable-slash-commands; then
  BOUND=(--tools "$TOOLS" --strict-mcp-config --disable-slash-commands)
else
  print -r -- "triage: $(claude --version 2>/dev/null || print unknown) does not list --tools, --strict-mcp-config and --disable-slash-commands; the pass starts with the allow list only (every built-in tool, MCP server and skill stays available)" >&2
fi
claude -p --model "$MODEL" --permission-mode acceptEdits \
  "${BOUND[@]}" --allowedTools "$ALLOWED" < "$TRIAGE"
