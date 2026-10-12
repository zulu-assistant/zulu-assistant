#!/bin/bash
# Zulu Assistant installer. Idempotent; every step says what it did or skipped.
#
#   ./install.sh [--yes]          full install: toolchain → init → scripts/bootstrap.sh install → brain → zulu setup
#   ./install.sh --dry-run        show what the full install would do, write nothing
#   ./install.sh setup            the guided part: your accounts, engine choice, what to watch, alerts, vault …
#   ./install.sh doctor           write a redacted diagnostic bundle (attach it to a beta-feedback issue)
#   ./install.sh init             copy examples/ → overlay/ (never overwrites your files)
#   ./install.sh --demo           board with synthetic data on :3210 — Node 22 only, no launchd/cmux
#   ./install.sh --demo --cmux    …plus a ZULU DEMO window in cmux: fake agent panes, live sidebar chrome
#   ./install.sh demo-stop        stop the demo board (and close the ZULU DEMO window)
#   ./install.sh --brain          Claude skills + graphify hooks into ~/.claude; prints the Graphify install line
#   ./install.sh mission-control  open the Mission Control workspace in cmux
#   ./install.sh star             star the repo on GitHub (asks first; your own gh login)
#   ./install.sh check | verify   pass through to scripts/bootstrap.sh
#
# The star prompt (full install and --demo, last step): asked ONCE, default No,
# only in an interactive terminal, skipped silently when gh is not logged in,
# never repeated, never tied to any feature. Only an explicit "y" stars, via
# `gh api -X PUT /user/starred/<owner>/<repo>` under YOUR gh login. The answer
# is kept in data/star-prompt.json.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
. "$ROOT/scripts/env.sh"
PORT="${MC_PORT:-3210}"
GRAPHIFY_PIN=0.9.83
STAR_FILE="$ROOT/data/star-prompt.json"

say() { printf '%-6s %s\n' "$1" "$2"; }
has() { command -v "$1" >/dev/null 2>&1; }

need_node() {
  local v; v=$("$NODE_BIN" -v 2>/dev/null || true)
  [[ "$v" == v2[2-9].* || "$v" == v[3-9][0-9].* ]] && return 0
  say FAIL "Node >= 22 required (found: ${v:-none}). brew install node@22, or nvm install 22"; exit 1
}

# the public repo, from the registry's SETTINGS.repoUrl (single source of truth)
repo_url() { "$NODE_BIN" -e "import('./src/config.mjs').then((m) => console.log(m.SETTINGS.repoUrl || ''))" 2>/dev/null || true; }

do_init() {
  local dry="${1:-}" n=0
  mkdir -p data logs
  while IFS= read -r f; do
    local rel="${f#examples/}" dst="overlay/${f#examples/}"
    [[ "$rel" == vault/* || "$rel" == claude/* ]] && continue      # brain templates: see --brain / docs/BRAIN.md
    if [[ -e "$dst" ]]; then continue; fi
    n=$((n + 1))
    if [[ -n "$dry" ]]; then say would "create $dst"; else mkdir -p "$(dirname "$dst")"; cp "$f" "$dst"; say done "create $dst"; fi
  done < <(find examples -type f | sort)
  [[ $n -eq 0 ]] && say skip "overlay/ already has every example file (yours are never overwritten)"
  return 0
}

star_record() {  # star_record <answer y|n>
  "$NODE_BIN" -e '
    const fs = require("fs"); const f = process.argv[1];
    let d = {}; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
    d.installer = { answer: process.argv[2], at: Date.now() };
    fs.writeFileSync(f, JSON.stringify(d, null, 1));' "$STAR_FILE" "$1"
}

star_prompt() {  # star_prompt ask|explicit
  local mode="$1" url slug ans
  url=$(repo_url); slug="${url#https://github.com/}"
  if [[ -z "$url" || "$slug" == "$url" ]]; then
    [[ "$mode" == explicit ]] && say skip "no public repo configured (SETTINGS.repoUrl in your registry)"
    return 0
  fi
  if [[ "$mode" == ask ]]; then
    [[ -t 0 && -t 1 ]] || return 0                                            # never ask a pipe / CI
    "$NODE_BIN" -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(d.installer?.answer?0:1)' "$STAR_FILE" 2>/dev/null && return 0   # asked before
    has gh && gh auth status >/dev/null 2>&1 || return 0                      # no gh login: skip silently
  else
    if ! { has gh && gh auth status >/dev/null 2>&1; }; then
      say info "gh is not logged in — star it in the browser instead: $url"; return 0
    fi
  fi
  echo
  read -r -p "Star ${slug##*/} on GitHub? [y/N] " ans || ans=""
  if [[ "$ans" == y || "$ans" == Y || "$ans" == yes ]]; then
    if gh api -X PUT "/user/starred/$slug" --silent; then say done "starred $slug as $(gh api user -q .login 2>/dev/null) — thank you"; star_record y
    else say warn "GitHub refused the star; nothing recorded — try later with ./install.sh star"; fi
  else
    star_record n
    [[ "$mode" == ask ]] && say ok "not starring — you won't be asked again (./install.sh star if you change your mind)"
  fi
}

demo_up() { curl -s -o /dev/null -m 2 -w '%{http_code}' "http://localhost:$PORT/api/status" 2>/dev/null | grep -q 200; }

do_demo() {
  need_node
  mkdir -p data logs
  if demo_up; then say skip "something already answers on :$PORT (demo-stop, or MC_PORT=... in data/local.env)"
  else
    # own session (setsid): closing this terminal must not take the demo with it
    MC_DEMO=1 MC_PORT="$PORT" nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$NODE_BIN" "$ROOT/server.mjs" > "$ROOT/logs/demo.log" 2>&1 &
    echo $! > data/demo.pid
    for _ in $(seq 1 40); do demo_up && break; sleep 0.25; done
    demo_up || { say FAIL "demo board did not start — see logs/demo.log"; exit 1; }
    say done "demo board (synthetic data, nothing real is touched) → http://localhost:$PORT"
    say info "stop it with ./install.sh demo-stop"
  fi
  [[ "${1:-}" == --cmux ]] && demo_cmux
  star_prompt ask
}

# The cmux half: a separate "ZULU DEMO" window with fake agent panes; the demo
# board writes chrome ONLY to those panes (src/demo-cmux.mjs). No cmux → the
# board-only demo still runs.
demo_cmux() {
  if ! has cmux; then
    say skip "cmux not found — board-only demo (brew install --cask cmux, then ./install.sh --demo --cmux)"; return
  fi
  local out
  if out=$("$NODE_BIN" "$ROOT/src/demo-cmux.mjs" up --port "$PORT" 2>&1); then
    say done "ZULU DEMO window open in cmux: 6 fake agents, one will ask for input"
    say next "show the phosphor sidebar in that window (your call; the demo never switches it):"
    printf '         %s\n' "$(printf '%s' "$out" | sed -n 's/.*"hint":"\([^"]*\)".*/\1/p')"
  else
    say skip "cmux demo not started: $(printf '%s' "$out" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p') — board-only demo"
  fi
}

do_demo_stop() {
  if [[ -f data/demo-cmux-state.json ]] && has cmux; then
    say done "$("$NODE_BIN" "$ROOT/src/demo-cmux.mjs" down 2>&1 | sed -n 's/.*"msg":"\([^"]*\)".*/cmux: \1/p')"
  fi
  local pid; pid=$(cat data/demo.pid 2>/dev/null || true)
  if [[ -n "$pid" ]] && ps -p "$pid" -o command= 2>/dev/null | grep -q server.mjs; then kill "$pid"; say done "demo stopped (pid $pid)"
  else say skip "no demo running"; fi
  rm -f data/demo.pid
}

do_brain() {
  local skills="$HOME/.claude/skills" settings="$HOME/.claude/settings.json"
  mkdir -p "$skills"
  for s in examples/claude/skills/*/; do
    [[ -d "$s" ]] || continue
    local name; name=$(basename "$s")
    if [[ -e "$skills/$name" ]]; then say skip "skill $name already installed"
    else cp -R "$s" "$skills/$name"; say done "skill $name → $skills/$name"; fi
  done
  if [[ -f examples/claude/settings.json ]]; then
    "$NODE_BIN" "$ROOT/scripts/merge-hooks.mjs" examples/claude/settings.json "$settings"
  fi
  if has graphify; then say ok "graphify $(graphify --version 2>/dev/null | tail -1)"
  else
    say info "Graphify (code memory) is third-party and not bundled. Install it with:"
    echo "         uv tool install graphifyy==$GRAPHIFY_PIN   # then: graphify update .  (in each repo)"
  fi
  say info "vault templates: examples/vault/ — docs/BRAIN.md explains the three memories"
}

do_mission_control() {
  has cmux || { say FAIL "cmux not found — brew install --cask cmux (docs/CMUX-SETUP.md)"; exit 1; }
  if [[ -n "${CMUX_WORKSPACE_ID:-}" ]]; then exec "$ROOT/scripts/mission-control.sh"; fi
  local pw; pw=$(cat data/cmux-socket-password 2>/dev/null || true)
  CMUX_SOCKET_PASSWORD="$pw" cmux new-workspace --name "⌘ MISSION CONTROL" --cwd "$ROOT" --command "$ROOT/scripts/mission-control.sh"
  say done "Mission Control workspace opened in cmux (pin it; docs/MISSION-CONTROL.md)"
}

do_full() {
  local dry="" yes="" a; local -a pass=()
  for a in "$@"; do case $a in --dry-run) dry=1 ;; --yes|-y) yes=1 ;; *) pass+=("$a") ;; esac; done
  [[ "$(uname -s)" == Darwin ]] || { say FAIL "macOS only (launchd, cmux). Try ./install.sh --demo to look around."; exit 1; }
  echo "━━ 1/4 toolchain"
  "$ROOT/scripts/prereqs.sh" ${dry:+--dry-run} ${yes:+--yes} || say warn "some tools failed to install — the steps below say what is missing"
  unset NODE_BIN_DIR; . "$ROOT/scripts/env.sh"        # a freshly installed Node is found now
  need_node
  echo "━━ 2/4 your config (overlay/)"
  do_init "$dry"
  echo "━━ 3/4 the agent OS (board, triage, cmux, brain)"
  if [[ -n "$dry" ]]; then "$ROOT/scripts/bootstrap.sh" install --dry-run; return; fi
  "$ROOT/scripts/bootstrap.sh" install ${pass[@]+"${pass[@]}"} || say warn "bootstrap reported problems above — zulu setup and ./install.sh check pick them up"
  do_brain
  # setup state = this install was made by install.sh → the board shows a setup card until done
  [[ -f data/setup-state.json ]] || "$NODE_BIN" -e 'import("./src/setup.mjs").then((m) => m.writeState({ installedAt: Date.now(), steps: {}, answers: {} }))'
  # `zulu <command>` from anywhere (bin/zulu → this installer)
  mkdir -p "$HOME/.local/bin"
  if [[ ! -e "$HOME/.local/bin/zulu" ]]; then ln -s "$ROOT/bin/zulu" "$HOME/.local/bin/zulu"; say done "linked ~/.local/bin/zulu"; fi
  [[ ":$PATH:" == *":$HOME/.local/bin:"* ]] || say note "add ~/.local/bin to your PATH for the zulu command (or use ./install.sh <command>)"
  echo "━━ 4/4 connect your accounts and config"
  say next "board: http://localhost:$PORT (a setup card shows what is left)"
  if [[ -t 0 && -t 1 ]]; then
    read -r -p "Run the guided setup now (accounts, engines, what to watch)? [Y/n] " a || a=""
    [[ -z "$a" || "$a" == y* || "$a" == Y* ]] && "$NODE_BIN" "$ROOT/scripts/setup.mjs" || say next "later: zulu setup"
  else say next "run in a terminal: zulu setup"; fi
  star_prompt ask
}

do_doctor() { exec "$NODE_BIN" "$ROOT/scripts/doctor.mjs" "$@"; }

case "${1:-}" in
  init) do_init "${2:-}" ;;
  --demo|demo) do_demo "${2:-}" ;;
  demo-stop) do_demo_stop ;;
  --brain|brain) do_brain ;;
  mission-control) do_mission_control ;;
  star) star_prompt explicit ;;
  check|verify) exec "$ROOT/scripts/bootstrap.sh" "$@" ;;
  setup) shift; need_node; exec "$NODE_BIN" "$ROOT/scripts/setup.mjs" "$@" ;;
  doctor) shift; need_node; do_doctor "$@" ;;
  -h|--help|help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' ;;
  ""|--dry-run|--yes|-y|--force|--deadman|--sandbox) do_full "$@" ;;
  *) echo "unknown command: $1 (./install.sh --help)"; exit 2 ;;
esac
