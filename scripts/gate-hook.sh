#!/bin/sh
# Guardrails gate hook — Claude Code / Codex PreToolUse (+ PostToolUse for dry runs).
# docs/GUARDRAILS.md. Fast path: a tool call that hits no trigger exits 0 with no
# output in a few ms. A hit goes to gate-hook.mjs, which asks the board. Its exit 3 means
# "not gated"; exit 0 must carry a decision. Anything else on a hit — a crash, a timeout,
# silence — DENIES the call (fail closed). A PostToolUse call never is.
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
in=$(cat)
T="$DIR/data/guardrails/triggers"
[ -r "$T" ] || T="$DIR/scripts/gate-triggers.default"
# the system grep, not whatever a profile or alias puts first (one grep build rejected the trigger file)
G=/usr/bin/grep; [ -x "$G" ] || G=grep
printf '%s' "$in" | sed -e 's/\\[nt]/ /g' -e 's/["`\\]//g' -e "s/'//g" | "$G" -qiE -f "$T"
rc=$?
# 1 = no trigger: pass silently. 0 = a hit. Anything else (grep itself failed) is treated as a hit,
# so a broken fast path can only cost latency, never let a gated call through.
[ $rc -eq 1 ] && exit 0
out=$(printf '%s' "$in" | "${GATE_NODE:-node}" "$DIR/scripts/gate-hook.mjs" 2>/dev/null)
code=$?
case "$in" in *PostToolUse*) exit 0 ;; esac
[ $code -eq 3 ] && exit 0
if [ $code -eq 0 ] && [ -n "$out" ]; then printf '%s' "$out"; exit 0; fi
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"GATE: the gate check failed (fail closed) - the command was not run. Tell the owner; do not work around it."}}'
exit 0
