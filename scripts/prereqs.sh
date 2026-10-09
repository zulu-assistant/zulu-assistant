#!/bin/bash
# Install the toolchain the agent OS runs on. Shows the plan, asks ONCE, then
# installs only what is missing (idempotent; a re-run installs nothing).
#
#   scripts/prereqs.sh [--yes] [--dry-run]
#   ZULU_SKIP="obsidian codex" scripts/prereqs.sh     leave items out
#
# Items: Homebrew · Node 22 · git/gh/uv · cmux (separate GPL app) · Claude Code CLI ·
# Codex CLI · Graphify (third-party, via uv; pinned) · Obsidian (the vault's app).
# Nothing here logs in to anything — `zulu setup` does that with each tool's own flow.
set -euo pipefail
YES=0 DRY=0
for a in "$@"; do case $a in --yes|-y) YES=1 ;; --dry-run) DRY=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
CLAUDE_MIN=2.1.280
GRAPHIFY_PIN=0.9.83
SKIP=" ${ZULU_SKIP:-} "
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# the same PATH the board and agents use (scripts/env.sh: nvm Node first, then Homebrew),
# so "installed" here means installed for them
. "$ROOT/scripts/env.sh"; export PATH="$PATH:$HOME/.local/bin"

has() { command -v "$1" >/dev/null 2>&1; }
vge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }   # vge have min
skipped() { [[ "$SKIP" == *" $1 "* ]]; }
PLAN=() CMDS=()
add() { skipped "$1" && return 0; PLAN+=("$2"); CMDS+=("$3"); }

[[ "$(uname -s)" == Darwin ]] || { echo "macOS only (launchd, cmux). On other systems: ./install.sh --demo"; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are needed first (git, compilers). A system dialog opens — install, then re-run."
  ((DRY)) || xcode-select --install 2>/dev/null || true
  exit 1
fi

has brew || add brew "Homebrew — package manager (brew.sh)" 'NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
nv=$(node -v 2>/dev/null || true); nmaj=${nv#v}; nmaj=${nmaj%%.*}
[[ -n "$nmaj" && "$nmaj" -ge 22 ]] || add node "Node 22 (runs the board; zero npm dependencies)" 'brew install node@22 && brew link --overwrite --force node@22'
for f in git gh uv; do has "$f" || add "$f" "$f" "brew install $f"; done
[[ -d /Applications/cmux.app ]] || add cmux "cmux — the agent terminal (separate GPL app, used via its CLI)" 'brew install --cask cmux'
cv=$(claude --version 2>/dev/null | awk '{print $1}' || true)
{ [[ -n "$cv" ]] && vge "$cv" "$CLAUDE_MIN"; } || add claude "Claude Code CLI (>= $CLAUDE_MIN)" 'npm install -g @anthropic-ai/claude-code'
has codex || add codex "Codex CLI (OpenAI) — optional engine for Mission Control/workers" 'npm install -g @openai/codex'
has graphify || add graphify "Graphify $GRAPHIFY_PIN — code memory (third-party, via uv)" "uv tool install 'graphifyy[mcp]==$GRAPHIFY_PIN'"
[[ -d /Applications/Obsidian.app ]] || add obsidian "Obsidian — the app for your vault (org memory)" 'brew install --cask obsidian'

if ((${#PLAN[@]} == 0)); then echo "skip   toolchain already installed"; exit 0; fi
echo "The agent OS needs these (nothing else is installed; ZULU_SKIP=\"name …\" leaves items out):"
for p in "${PLAN[@]}"; do echo "  • $p"; done
if ((DRY)); then echo "(dry run — nothing installed)"; exit 0; fi
if ((YES == 0)); then
  [[ -t 0 ]] || { echo "not a terminal — re-run with --yes to install the above"; exit 1; }
  read -r -p "Install them now? [Y/n] " ans || ans=""
  [[ -z "$ans" || "$ans" == y* || "$ans" == Y* ]] || { echo "skipped — the install continues, but missing tools stay missing (re-run any time)"; exit 0; }
fi
fails=0
for i in "${!CMDS[@]}"; do
  echo "→ ${PLAN[$i]}"
  if bash -c "${CMDS[$i]}"; then
    [[ "${PLAN[$i]}" == Homebrew* ]] && eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
    echo "done   ${PLAN[$i]%% —*}"
  else echo "FAIL   ${PLAN[$i]%% —*} (run it by hand: ${CMDS[$i]})"; fails=$((fails + 1)); fi
done
((fails == 0))
