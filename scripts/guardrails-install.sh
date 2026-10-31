#!/bin/bash
# Install the Guardrails gate hook into the agents' settings (docs/GUARDRAILS.md).
#   scripts/guardrails-install.sh            show what would change (no writes)
#   scripts/guardrails-install.sh --apply    Claude Code: ~/.claude/settings.json (backed up first)
#   scripts/guardrails-install.sh --apply --codex   also ~/.codex/hooks.json
#   scripts/guardrails-install.sh --remove [--codex]   take the hook out again (backed up first)
# Sessions load hooks at start: restart an agent (or review /hooks) to pick the change up.
# Editing these files from an agent session is itself gated (class "self"): run this yourself.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/env.sh"
apply=0; codex=0; remove=0
for a in "$@"; do case "$a" in --apply) apply=1 ;; --codex) codex=1 ;; --remove) remove=1 ;; *) echo "unknown flag $a" >&2; exit 2 ;; esac; done
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
targets=("claude:$HOME/.claude/settings.json")
[ "$codex" = 1 ] && targets+=("codex:$HOME/.codex/hooks.json")
for t in "${targets[@]}"; do
  kind="${t%%:*}"; dst="${t#*:}"
  if [ "$remove" = 1 ]; then
    [ -f "$dst" ] || { echo "skip   $dst (absent)"; continue; }
    "$NODE_BIN" "$ROOT/scripts/merge-hooks.mjs" "$dst" --remove 'scripts/gate-hook.sh' $([ "$apply" = 1 ] || echo --dry-run)
    continue
  fi
  REPO="$ROOT" "$ROOT/scripts/render-tmpl.sh" "$ROOT/examples/$kind/guardrails-hooks.json.tmpl" "$tmp/$kind.json"
  mkdir -p "$(dirname "$dst")"
  "$NODE_BIN" "$ROOT/scripts/merge-hooks.mjs" "$tmp/$kind.json" "$dst" $([ "$apply" = 1 ] || echo --dry-run)
done
[ "$apply" = 1 ] || echo "(dry run — add --apply to write)"
