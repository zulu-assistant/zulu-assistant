#!/bin/zsh
# Manually bring Mission Control back after a reboot/power loss when auto-restore did not.
# Run INSIDE the "⌘ MISSION CONTROL" cmux workspace pane. Resumes the last known
# Mission Control session (id recorded in data/mission-control-session-id by MC itself)
# with the mesh --name, allowed tools and the MISSION-CONTROL.md contract.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SID="${1:-$(cat "$ROOT/data/mission-control-session-id" 2>/dev/null || true)}"
if [ -z "$SID" ]; then echo "no session id recorded; starting a fresh Mission Control"; exec "$ROOT/scripts/mission-control.sh"; fi
echo "resuming Mission Control session $SID"
MC_RESUME="$SID" exec "$ROOT/scripts/mission-control.sh"
