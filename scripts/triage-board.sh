#!/bin/sh
# The scheduled triage pass's only way to the board (#588): scripts/triage-board.mjs does the work.
# A settings file's env block reaches this shell, so the system folders come first and Node's preload
# and loader variables are cleared before Node starts. Node is the one scripts/triage.sh resolved before
# the pass started (NODE_BIN); a hand run without it resolves Node the usual way.
PATH="/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"; export PATH
unset NODE_OPTIONS NODE_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CDPATH
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
case "${NODE_BIN:-}" in /*) [ -x "$NODE_BIN" ] || . "$ROOT/scripts/env.sh" ;; *) . "$ROOT/scripts/env.sh" ;; esac
exec "$NODE_BIN" "$ROOT/scripts/triage-board.mjs" "$@"
