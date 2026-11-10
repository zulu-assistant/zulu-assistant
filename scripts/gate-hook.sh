#!/bin/sh
# Guardrails gate hook — Claude Code / Codex PreToolUse (+ PostToolUse for dry runs).
# docs/GUARDRAILS.md. Fast path: a tool call that hits no trigger exits 0 with no
# output in a few ms. A hit goes to gate-hook.mjs, which asks the board. Its exit 3 means
# "not gated"; exit 0 must carry a decision. Anything else on a hit — a crash, a timeout,
# silence, or no answer within this script's own deadline — DENIES the call (fail closed).
# A PostToolUse call never is: it has already run.
#
# The session's environment is not believed. A settings file's env block reaches every hook
# process (seen live on Claude Code 2.1.321), so the system folders come first on PATH (cat, sed,
# dirname, sleep and the tools the Node step starts are the system's own) and the variables that
# make a shell or Node load other code are cleared before anything runs.
PATH="/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"; export PATH
unset NODE_OPTIONS NODE_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH LD_PRELOAD LD_LIBRARY_PATH BASH_ENV ENV CDPATH
DIR=$(cd -- "$(dirname -- "$0")/.." && pwd)
# `--deadline <seconds>` (tests): an argument, never the environment. The rest goes to the Node step.
deadline=12
if [ "$1" = "--deadline" ]; then deadline=$2; shift 2; fi
in=$(cat)
T="$DIR/data/guardrails/triggers"
[ -r "$T" ] || T="$DIR/scripts/gate-triggers.default"
# the system grep, not whatever a profile or alias puts first (one grep build rejected the trigger file)
G=/usr/bin/grep; [ -x "$G" ] || G=grep
printf '%s' "$in" | sed -e 's/\\[nt]/ /g' -e 's/["`\\]//g' -e "s/'//g" -e 's#/\(\./\)\{1,\}#/#g' -e 's#\([^:/]\)//*#\1/#g' | "$G" -qiE -f "$T"
rc=$?
# 1 = no trigger: pass silently. 0 = a hit. Anything else (grep itself failed) is treated as a hit,
# so a broken fast path can only cost latency, never let a gated call through.
[ $rc -eq 1 ] && exit 0
# The Node step, under a deadline of this script's own. A hook that answers after its registered
# time limit (15 s) lets the call RUN (seen live), so this script must have answered before that:
# the Node step gives up on the board after 8 s, and whatever keeps it past 12 s is answered here
# with a deny. The step's answer and then its exit code travel through one pipe, as two lines,
# never through a file another process could write. A timer sleeps beside the step: the step stops
# the timer when it is done; a timer that ends by itself means the deadline passed, and then "late"
# is written in place of the exit code and the step is killed. The reader takes two lines and
# stops, so nothing a hung step left behind can keep this script waiting.
{
  exec 2>/dev/null
  sleep "$deadline" >/dev/null &
  timer=$!
  # The Node program is the one the registered command names (GATE_NODE='/…/node' in front of this
  # script: an assignment on the command line beats a settings file's env block). Without an
  # absolute path there, nothing is looked up on the session's PATH: the call is denied.
  case "${GATE_NODE:-}" in
    /*) { printf '%s' "$in" | "$GATE_NODE" "$DIR/scripts/gate-hook.mjs" "$@"; printf '\n%s\n' "$?"; kill "$timer"; } & ;;
    *) { printf '\n%s\n' nonode; kill "$timer"; } & ;;
  esac
  step=$!
  if wait "$timer"; then printf '\n%s\n' late; pkill -9 -P "$step"; kill -9 "$step"; fi
} | {
  IFS= read -r out
  IFS= read -r code
  # The Node step has read the input and knows which event this is: for a call that already ran
  # (PostToolUse) it says "nothing to say" itself, exit 3. The shell must never turn an answer into
  # silence because of TEXT in the call: the input holds the call's own words, and a command, a
  # comment or a tool's input can spell an event's name.
  [ "$code" = 3 ] && exit 0
  # Only when the Node step did not answer does the shell need the event itself, so that a call
  # which already ran is not answered with a deny. It is believed from one form only: the input's
  # own key with its value, quotes unescaped. A string value cannot produce that (its quotes arrive
  # escaped), and a tool's input that carries a real key of that name makes the key occur twice,
  # which is not believed either. Anything else is a call that has not run yet.
  post=0
  case "$in" in
    *'"hook_event_name"'*'"hook_event_name"'*) ;;
    *'"hook_event_name":"PostToolUse"'*|*'"hook_event_name": "PostToolUse"'*) post=1 ;;
  esac
  [ $post -eq 1 ] && exit 0
  if [ "$code" = 0 ] && [ -n "$out" ]; then printf '%s' "$out"; exit 0; fi
  why="the gate check failed"
  [ "$code" = late ] && why="the gate check did not answer in ${deadline} s"
  [ "$code" = nonode ] && why="the hook is registered without the path of its Node program (GATE_NODE), and it does not look one up on the session's PATH. Run scripts/guardrails-install.sh again: the gate check could not run"
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"GATE: '"$why"' (fail closed) - the command was not run. Tell the owner; do not work around it."}}'
  exit 0
}
exit $?
