#!/bin/zsh
# Headless Mission Control triage pass (selfheal-wrapped by launchd).
# Bounded by its start line: two tools (Bash, Write), no MCP server, no skills, default permission mode, and an
# allow list of exact calls (scripts/triage-allow.mjs, #588): writes only to data/handoffs/triage-*, the board only
# through scripts/triage-board.sh, one kickstart per job the policy does not list as paid or outbound, one restart
# per container, and a worker only by asking Mission Control when SETTINGS.triage.dispatch is 'ask'. Not bounded
# by the list yet (#588, the sandbox): read-only shell commands, which Claude Code runs without asking.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# the procedure as handed to the engine: the user id written in for <UID> and for the older
# `$(id -u)` (an allow-list refuses a substitution), so an install set up before the
# placeholder is fixed without a hand edit. `--print-prompt` prints it and runs nothing.
# The line <ALLOWED_CALLS> becomes the restarts on the allow list, so the procedure names exactly what
# the pass may run. `--print-allowed` prints the allow list the pass is started with, one entry a line.
# Of the blocks between the lines <IF_ASK> … </IF_ASK> and <IF_SPAWN> … </IF_SPAWN>, the one for this board's
# dispatch (`triage-allow.mjs --dispatch`) is kept, without its marker lines, and the other is dropped.
allowed() { "$NODE_BIN" "$ROOT/scripts/triage-allow.mjs"; }
prompt() {
  local n calls mode; n=$(id -u)
  calls=$(allowed | sed -n -e 's/^Bash(\(launchctl kickstart .*\))$/   - `\1`/p' -e 's/^Bash(\(docker restart .*\))$/   - `\1`/p')
  [ -n "$calls" ] || calls='   - (none: the registry lists nothing the pass may restart)'
  mode=$("$NODE_BIN" "$ROOT/scripts/triage-allow.mjs" --dispatch 2>/dev/null || print spawn)
  # through the environment: awk's -v refuses a value with line breaks
  sed -e "s/<UID>/$n/g" -e "s/\$(id -u)/$n/g" "$1" | CALLS="$calls" MODE="$mode" awk '
    $0 == "<IF_ASK>" { skip = (ENVIRON["MODE"] != "ask"); next }
    $0 == "<IF_SPAWN>" { skip = (ENVIRON["MODE"] == "ask"); next }
    $0 == "</IF_ASK>" || $0 == "</IF_SPAWN>" { skip = 0; next }
    skip { next }
    $0 == "<ALLOWED_CALLS>" { print ENVIRON["CALLS"]; next }
    { print }'
}
case "${1:-}" in
  --print-prompt) . "$ROOT/scripts/env.sh"; prompt "$(mc_resolve config/TRIAGE.md)"; exit 0 ;;
  --print-allowed) . "$ROOT/scripts/env.sh"; allowed; exit 0 ;;
esac
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
  exec codex exec -s workspace-write -c sandbox_workspace_write.network_access=true --skip-git-repo-check -C "$ROOT" ${CODEX_MODEL:+-m "$CODEX_MODEL"} - <<< "$(prompt "$TRIAGE")"
fi
MODEL=$("$ROOT/scripts/worker-model.sh")

# --allowedTools is variadic and consumes every following argument, so the
# prompt MUST arrive via stdin, never as a positional arg
# one entry per argument (scripts/triage-allow.mjs): exact restarts, no free curl, cat or date (#588)
ALLOWED=("${(@f)$(allowed || true)}")
# no list, no pass: an empty --allowedTools would leave only the tools that need no permission, and the procedure
# would fail call by call
if [ "${#ALLOWED[@]}" -eq 0 ] || [ -z "${ALLOWED[1]}" ]; then
  print -r -- "triage: the allow list could not be built (scripts/triage-allow.mjs); no pass" >&2
  exit 1
fi
# the allow list only answers permission asks: tools that need none (helpers, messages, schedules, web reads…)
# stay available unless withheld (#586: the pass held 29 built-in tools and every MCP server of the account).
# --tools names the whole built-in set, --strict-mcp-config with no --mcp-config loads no MCP server, and
# --disable-slash-commands loads no skills. A Claude Code without all three (2.0.1 lacks two of them) starts the
# pass with the allow list alone, and the job's log says so (as in 1.2.3).
# Two tools since #588: the file rule above lets Write create only data/handoffs/triage-*, and with no Read tool
# no existing file can be overwritten through Write at all; reads and cooldowns go through the board script.
TOOLS="Bash,Write"
HELP="$(claude --help 2>/dev/null || true)"
has_flag() { print -r -- "$HELP" | grep -q -e "^  $1[ ,]" -e "^  $1\$"; }
BOUND=()
if has_flag --tools && has_flag --strict-mcp-config && has_flag --disable-slash-commands; then
  BOUND=(--tools "$TOOLS" --strict-mcp-config --disable-slash-commands)
else
  print -r -- "triage: $(claude --version 2>/dev/null || print unknown) does not list --tools, --strict-mcp-config and --disable-slash-commands; the pass starts with the allow list only (every built-in tool, MCP server and skill stays available)" >&2
fi
# default mode, not acceptEdits: a file write outside the one rule needs an answer, and a headless run has none.
# --setting-sources user (#588): the pass runs from the checkout, and a headless run applies the allow rules in the
# checkout's .claude/settings.local.json (probe 5: a curl that no entry here names ran under a saved `Bash(curl *)`).
# Only the user settings are read, which keeps the gate hook (probe 6: refused, hook lines as headless:triage).
claude -p --model "$MODEL" --permission-mode default --setting-sources user \
  "${BOUND[@]}" --allowedTools "${ALLOWED[@]}" <<< "$(prompt "$TRIAGE")"
