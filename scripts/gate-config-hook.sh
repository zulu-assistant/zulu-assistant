#!/bin/sh
# Guardrails settings-change hook — Claude Code ConfigChange. docs/GUARDRAILS.md.
# A settings file changed while a session runs. A change that switches hooks off, that steers the
# gate hook through an env block, or that takes the gate hook out of the user settings, is BLOCKED
# for the running session, and the board is told. Any other change passes with no output.
# gate-config-hook.mjs decides: its exit 3 means "let it apply"; exit 0 must carry a decision.
# Anything else — a crash, no Node, silence, or no answer within the deadline — BLOCKS the change
# (fail closed): a settings change nobody could read is not applied to a session that is running.
#
# Two things seen live (Claude Code 2.1.321, docs/GUARDRAILS.md "The gate checks itself") shape this file:
# - A hook that answers after its registered time limit lets the change APPLY. So the Node step
#   runs under a deadline of this script's own (8 s, far below the registered 30 s), and when it
#   passes, this script answers "blocked" itself.
# - A settings file's env block reaches this process. So nothing here is taken from the session's
#   environment that can change which program runs: the system folders come first on PATH, and
#   the variables that make a shell or Node load other code are cleared.
PATH="/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"; export PATH
unset NODE_OPTIONS NODE_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CDPATH
DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
# `--deadline <seconds>` (tests): an argument, never the environment. The rest goes to the Node step.
deadline=8
if [ "$1" = "--deadline" ]; then deadline=$2; shift 2; fi
blocked() {
  echo "GATE: the settings-change check $1 (fail closed): this change is not applied to the running session." >&2
  exit 2
}
in=$(cat)
# managed policy cannot be blocked by a hook, so there is nothing to decide
case "$in" in *'"source":"policy_settings"'*|*'"source": "policy_settings"'*) exit 0 ;; esac
# The Node step under the deadline. Its answer and then its exit code travel through one pipe, as two
# lines, never through a file another process could write. A timer sleeps beside the step: the step
# stops the timer when it is done; a timer that ends by itself means the deadline passed, and then
# "late" is written in place of the exit code and the step is killed. The reader takes two lines and
# stops, so nothing a hung step left behind can keep this script waiting.
{
  exec 2>/dev/null
  sleep "$deadline" >/dev/null &
  timer=$!
  { printf '%s' "$in" | "${GATE_NODE:-node}" "$DIR/scripts/gate-config-hook.mjs" "$@"; printf '\n%s\n' "$?"; kill "$timer"; } &
  step=$!
  if wait "$timer"; then printf '\n%s\n' late; pkill -9 -P "$step"; kill -9 "$step"; fi
} | {
  IFS= read -r out
  IFS= read -r code
  [ "$code" = 3 ] && exit 0
  if [ "$code" = 0 ] && [ -n "$out" ]; then printf '%s' "$out"; exit 0; fi
  [ "$code" = late ] && blocked "did not answer in ${deadline} s"
  blocked "failed"
}
exit $?
