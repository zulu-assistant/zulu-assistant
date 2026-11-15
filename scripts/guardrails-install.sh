#!/bin/bash
# Install the Guardrails gate hook into the agents' settings (docs/GUARDRAILS.md).
#   scripts/guardrails-install.sh            show what would change (no writes)
#   scripts/guardrails-install.sh --apply    Claude Code: ~/.claude/settings.json (backed up first)
#   scripts/guardrails-install.sh --apply --codex   also ~/.codex/hooks.json
#   scripts/guardrails-install.sh --remove [--codex]   take the hook out again (backed up first)
#   scripts/guardrails-install.sh --apply --allow-older-claude   write although Claude Code is older than the
#                                                              version the entries need (refused without it)
# Sessions load hooks at start: restart an agent (or review /hooks) to pick the change up.
# Editing these files from an agent session is itself gated (class "self"): run this yourself.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/env.sh"
apply=0; codex=0; remove=0; older=0
CLAUDE_HOOK_MIN=2.1.295    # the first Claude Code that knows onFailure on a hook entry
for a in "$@"; do case "$a" in --apply) apply=1 ;; --codex) codex=1 ;; --remove) remove=1 ;; --allow-older-claude) older=1 ;; *) echo "unknown flag $a" >&2; exit 2 ;; esac; done
# The entries carry onFailure, which needs Claude Code $CLAUDE_HOOK_MIN or later. What an older one does with an entry
# that has a key it does not know is not tested: if it drops the entry, nothing is held and nothing says so when a
# call is made. So the version is read BEFORE anything is written, and the write form refuses on an older one.
# (CLAUDE_BIN: tests name a stand-in; env.sh puts the Node folder first on PATH, where the real one lives)
claude_note=''
if [ "$remove" = 0 ]; then
  cv=$("${CLAUDE_BIN:-claude}" --version 2>/dev/null | awk '{print $1}' || true)
  if [ -z "$cv" ]; then claude_note="note   claude is not on PATH here: the field needs Claude Code $CLAUDE_HOOK_MIN or later"
  elif ! printf '%s\n' "$cv" | /usr/bin/grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+'; then claude_note="note   the Claude Code version could not be read here: the field needs Claude Code $CLAUDE_HOOK_MIN or later"
  elif [ "$(printf '%s\n%s\n' "$CLAUDE_HOOK_MIN" "$cv" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" != "$CLAUDE_HOOK_MIN" ]; then
    if [ "$apply" = 1 ] && [ "$older" = 0 ]; then
      echo "REFUSED  Claude Code $cv is older than $CLAUDE_HOOK_MIN, and nothing was written." >&2
      echo "         The gate's hook entries use onFailure, which needs $CLAUDE_HOOK_MIN. It is not tested what an older Claude Code does with such an entry: if it drops it, nothing is held and nothing says so." >&2
      echo "         Update Claude Code (npm i -g @anthropic-ai/claude-code), then run this again." >&2
      echo "         To write anyway: scripts/guardrails-install.sh --apply --allow-older-claude" >&2
      exit 3
    fi
    claude_note="WARN   Claude Code $cv is older than $CLAUDE_HOOK_MIN: it is not tested what it does with onFailure. Update it (npm i -g @anthropic-ai/claude-code)."
    [ "$apply" = 1 ] || claude_note="$claude_note The write form refuses until then (or takes --allow-older-claude)."
  fi
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
targets=("claude:$HOME/.claude/settings.json")
[ "$codex" = 1 ] && targets+=("codex:$HOME/.codex/hooks.json")
for t in "${targets[@]}"; do
  kind="${t%%:*}"; dst="${t#*:}"
  if [ "$remove" = 1 ]; then
    [ -f "$dst" ] || { echo "skip   $dst (absent)"; continue; }
    "$NODE_BIN" "$ROOT/scripts/merge-hooks.mjs" "$dst" --remove 'scripts/gate-hook.sh' $([ "$apply" = 1 ] || echo --dry-run)
    # the settings-change hook that is installed next to it (Claude Code only)
    [ "$kind" = claude ] && "$NODE_BIN" "$ROOT/scripts/merge-hooks.mjs" "$dst" --remove 'scripts/gate-config-hook.sh' $([ "$apply" = 1 ] || echo --dry-run)
    continue
  fi
  REPO="$ROOT" "$ROOT/scripts/render-tmpl.sh" "$ROOT/examples/$kind/guardrails-hooks.json.tmpl" "$tmp/$kind.json"
  mkdir -p "$(dirname "$dst")"
  "$NODE_BIN" "$ROOT/scripts/merge-hooks.mjs" "$tmp/$kind.json" "$dst" --refresh $([ "$apply" = 1 ] || echo --dry-run)
  [ "$kind" = claude ] && wrote_claude=1
done
if [ "$remove" = 0 ] && [ "${wrote_claude:-0}" = 1 ]; then
  # what the field means, said every time the entries are written or shown
  echo 'note   the gate hook and the settings-change hook are registered with onFailure: "block": if their script cannot start or answers late, Claude Code stops the call instead of running it.'
  echo "note   before you move or delete this checkout, take them out first: scripts/guardrails-install.sh --remove --apply (otherwise every tool call is blocked; docs/TROUBLESHOOTING.md)"
  [ -z "$claude_note" ] || echo "$claude_note"
fi
[ "$apply" = 1 ] || echo "(dry run — add --apply to write)"
