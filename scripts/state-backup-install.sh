#!/bin/bash
# Install / remove the daily state-backup LaunchAgent (the owner's step, never an agent's).
#   scripts/state-backup-install.sh            dry run: render the plist, show where it goes
#   scripts/state-backup-install.sh --apply    render, place in ~/Library/LaunchAgents, bootstrap
#   scripts/state-backup-install.sh --remove   bootout + delete the plist (archives are kept)
# The job follows the selfheal pattern (system/launchd/README.md): it needs the
# vault's selfheal-runner.sh, and it catches up after a reboot or a sleep.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
. scripts/env.sh
LABEL="$MC_LABEL_PREFIX.state-backup"          # from config/zulu.env via env.sh
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mode="${1:-}"
if [ "$mode" = "--remove" ]; then
  [ -n "${ZULU_NO_LAUNCHD:-}" ] || launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$DEST"; echo "removed $LABEL (archives in data/backups/ are kept)"; exit 0
fi
tmp="$(mktemp -d)"
scripts/render-tmpl.sh system/launchd/state-backup.plist.tmpl "$tmp/$LABEL.plist"
plutil -lint "$tmp/$LABEL.plist" >/dev/null
RUNNER="$(sed -n 's|.*<string>\(.*/selfheal-runner\.sh\)</string>.*|\1|p' "$tmp/$LABEL.plist" | head -1)"
if [ ! -f "$RUNNER" ]; then
  echo "the selfheal runner is not at: $RUNNER" >&2
  echo "set up the vault first (./install.sh --brain), or run scripts/state-backup.sh from your own scheduler" >&2
  exit 1
fi
if [ "$mode" != "--apply" ]; then
  echo "dry run: would place $DEST and bootstrap $LABEL (daily 03:15, catch-up at load)"; cat "$tmp/$LABEL.plist"; exit 0
fi
mkdir -p logs
if [ -n "${ZULU_NO_LAUNCHD:-}" ]; then cp "$tmp/$LABEL.plist" "$DEST"; echo "placed $DEST, not loaded (ZULU_NO_LAUNCHD)"; exit 0; fi
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$tmp/$LABEL.plist" "$DEST"
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "loaded $LABEL (logs/state-backup.log) — the first archive is written now; the board card is backup:state"
