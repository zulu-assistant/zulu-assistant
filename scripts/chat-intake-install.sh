#!/bin/bash
# Install / remove the chat-intake LaunchAgent (task #223).
#   scripts/chat-intake-install.sh            dry run: render the plist, show where it goes
#   scripts/chat-intake-install.sh --apply    render, place in ~/Library/LaunchAgents, bootstrap
#   scripts/chat-intake-install.sh --remove   bootout + delete the plist
# Check the tokens and channels first: scripts/chat-intake.sh --check
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
. scripts/env.sh
LABEL="$MC_LABEL_PREFIX.chat-intake"          # from config/zulu.env via env.sh
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
mode="${1:-}"
if [ "$mode" = "--remove" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$DEST"; echo "removed $LABEL"; exit 0
fi
tmp="$(mktemp -d)"
scripts/render-tmpl.sh system/launchd/chat-intake.plist.tmpl "$tmp/$LABEL.plist"
plutil -lint "$tmp/$LABEL.plist" >/dev/null
if [ "$mode" != "--apply" ]; then
  echo "dry run: would place $DEST and bootstrap $LABEL"; cat "$tmp/$LABEL.plist"; exit 0
fi
mkdir -p logs
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$tmp/$LABEL.plist" "$DEST"
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "loaded $LABEL (logs/chat-intake.log)"
