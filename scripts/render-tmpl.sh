#!/bin/bash
# Render a *.tmpl file (launchd plists, cmux.json) to stdout or a path.
#   scripts/render-tmpl.sh system/launchd/master-console.plist.tmpl [out]
# Tokens: __HOME__ __REPO__ (REPO env, default this checkout) __NODE_BIN_DIR__
# __VAULT__ __LABEL_PREFIX__ (both from config/zulu.env via scripts/env.sh; env overrides). Secrets are never rendered here: cmux.json's
# "__FROM_data/cmux-socket-password__" is injected by the installer/restore.sh.
# Paths may contain spaces but not '|'.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/env.sh"
[ $# -ge 1 ] || { echo "usage: $0 <file.tmpl> [out]" >&2; exit 2; }
REPO="${REPO:-$ROOT}"
out=$(sed -e "s|__HOME__|$HOME|g" -e "s|__REPO__|$REPO|g" -e "s|__NODE_BIN_DIR__|$NODE_BIN_DIR|g" -e "s|__VAULT__|$VAULT|g" -e "s|__LABEL_PREFIX__|$MC_LABEL_PREFIX|g" "$1")
if grep -Eq '__(HOME|REPO|NODE_BIN_DIR|VAULT|LABEL_PREFIX)__' <<<"$out"; then echo "unrendered token in $1" >&2; exit 1; fi
if [ $# -ge 2 ]; then printf '%s\n' "$out" > "$2"; else printf '%s\n' "$out"; fi
