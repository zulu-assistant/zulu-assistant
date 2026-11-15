#!/bin/bash
# The anchor: register the Guardrails gate hook in Claude Code's MANAGED settings (docs/GUARDRAILS.md).
#   scripts/guardrails-anchor.sh            show the file and the one line to type (writes only a staged copy in data/)
#   scripts/guardrails-anchor.sh --check    is it anchored? exit 0 = yes, 3 = no
#   scripts/guardrails-anchor.sh --remove   show the line that takes it out again
# Nothing here runs with administrator rights. The line it prints is for the owner to type, in a
# terminal of their own: writing to the managed settings folder from an agent session is gated.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/env.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
REPO="$ROOT" "$ROOT/scripts/render-tmpl.sh" "$ROOT/examples/claude/guardrails-hooks.json.tmpl" "$tmp/claude.json"
"$NODE_BIN" "$ROOT/scripts/guardrails-anchor.mjs" "$tmp/claude.json" "$@"
