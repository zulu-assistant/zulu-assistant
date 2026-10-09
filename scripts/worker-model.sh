#!/bin/zsh
# Resolve the workforce model. Prefers models.json "worker" (overlay/config/, via mc_resolve)
# (claude-opus-5); if a cheap probe shows it unavailable, falls back to
# "workerFallback". Probe result cached 24h in data/.model-probe.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/env.sh"   # mc_resolve: overlay/ → core → examples/
MODELS="$(mc_resolve config/models.json)"
WORKER=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['worker'])" "$MODELS")
FALLBACK=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['workerFallback'])" "$MODELS")
CACHE="$ROOT/data/.model-probe"

if [[ -f "$CACHE" ]]; then
  read -r ts model < "$CACHE" 2>/dev/null || true
  if [[ -n "${model:-}" ]] && (( $(date +%s) - ${ts:-0} < 86400 )); then
    echo "$model"; exit 0
  fi
fi

if claude --model "$WORKER" -p "Reply with exactly: OK" >/dev/null 2>&1; then
  chosen="$WORKER"
else
  chosen="$FALLBACK"
fi
echo "$(date +%s) $chosen" > "$CACHE"
echo "$chosen"
