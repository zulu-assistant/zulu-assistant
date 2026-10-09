#!/bin/zsh
# Auto-backup the Obsidian vault to its private git remote.
# Run by launchd (<prefix>.obsidian-backup, template .scripts/launchd/vault-backup.plist.tmpl):
# every 30 min + at load, so cycles missed to sleep/reboot/power-off run on the next start.
#
# Env overrides: VAULT (default: the folder above this script), VAULT_BRANCH (default: main).

set -u
VAULT="${VAULT:-${0:A:h:h}}"
BRANCH="${VAULT_BRANCH:-main}"
LOG="$HOME/Library/Logs/obsidian-backup.log"

cd "$VAULT" || exit 1

# Mirror selfheal scheduler state into the vault so it survives local wipes
# (git-versioned; restore steps in .scripts/state-mirror/README.md). Copy-only,
# never a syncing delete: after a wipe the mirror must keep the last good copies.
setopt null_glob
MIRROR="$VAULT/.scripts/state-mirror"
mkdir -p "$MIRROR"
# Markers live in Application Support (the legacy ~/.cache dir is still read):
# mirror the NEWEST epoch per label across both, so a restore never rolls a job
# back to an older value.
for m in "$HOME/Library/Application Support/selfheal-runner/"*.last "$HOME/.cache/selfheal-runner/"*.last; do
  dst="$MIRROR/${m:t}"
  new=$(<"$m" 2>/dev/null); old=$(<"$dst" 2>/dev/null)
  [[ "$new" == <-> ]] || continue
  if [[ "$old" != <-> ]] || (( new > old )); then cp -p "$m" "$dst"; fi
done
[[ -f "$HOME/Library/Logs/selfheal-runner.log" ]] && cp -p "$HOME/Library/Logs/selfheal-runner.log" "$MIRROR/"

{
  echo "--- $(date '+%Y-%m-%d %H:%M:%S') backup run"
  git add -A
  if ! git diff --cached --quiet; then
    git commit -m "Auto-backup $(date '+%Y-%m-%d %H:%M')"
  else
    echo "no changes to commit"
  fi
  # Rebase on the remote in case the vault was edited from another machine,
  # then push (also flushes any commit whose earlier push failed offline).
  git pull --rebase --autostash origin "$BRANCH" 2>&1 || echo "pull failed (offline?) — will push what we can"
  git push origin "$BRANCH" 2>&1 || echo "push failed (offline?) — retained locally, next run retries"
} >> "$LOG" 2>&1

# Keep the log from growing unbounded
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit 0
