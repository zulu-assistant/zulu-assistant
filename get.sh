#!/bin/bash
# One-command install:  curl -fsSL https://raw.githubusercontent.com/zulu-assistant/zulu-assistant/main/get.sh | bash
#
# Clones the repo to ~/zulu-assistant (ZULU_HOME) — or updates it — and runs
# ./install.sh, which installs the toolchain (asking once), the agent OS, and
# then walks you through `zulu setup` to connect your own accounts.
# A private repo (e.g. a beta) is cloned through your gh login:
#   ZULU_REPO=<owner>/<repo> bash get.sh
set -euo pipefail
REPO="${ZULU_REPO:-zulu-assistant/zulu-assistant}"
DEST="${ZULU_HOME:-$HOME/zulu-assistant}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

[[ "$(uname -s)" == Darwin ]] || { echo "Zulu Assistant runs on macOS (launchd + cmux)."; exit 1; }
if ! xcode-select -p >/dev/null 2>&1; then
  echo "Apple's Command Line Tools are needed (git). A dialog opens — install them, then run this again."
  xcode-select --install 2>/dev/null || true; exit 1
fi
if [[ -d "$DEST/.git" ]]; then
  echo "updating $DEST"; git -C "$DEST" pull --ff-only || echo "(could not fast-forward — using the copy as it is)"
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh repo clone "$REPO" "$DEST"
elif ! git clone "https://github.com/$REPO.git" "$DEST" 2>/dev/null; then
  echo "could not clone $REPO."
  echo "If it is a private repo you were invited to: brew install gh && gh auth login, then run this again."
  exit 1
fi
# piped through curl, stdin is this script — give the installer the terminal back for its questions
if [[ -r /dev/tty ]]; then exec "$DEST/install.sh" "$@" </dev/tty; else exec "$DEST/install.sh" "$@"; fi
