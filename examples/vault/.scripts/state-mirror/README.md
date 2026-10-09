# state-mirror — git-versioned copies of selfheal scheduler state

Written by `.scripts/vault-backup.sh` on every backup run (every 30 min), and by
`.scripts/selfheal-runner.sh` after every successful job, so the selfheal markers and the runner's
success log survive any local wipe — they ride the vault's push to its git remote.

## Contents
- `<label>.last` — the NEWEST copy of each job's marker (epoch seconds of its last successful run)
  across the primary marker dir `~/Library/Application Support/selfheal-runner/` and the legacy
  `~/.cache/selfheal-runner/`. Lags live state by up to 30 min.
- `selfheal-runner.log` — copy of `~/Library/Logs/selfheal-runner.log` (the live copy
  self-truncates to 1000 lines).

The runner also reads this folder directly: the newest of primary, legacy and mirror wins, so a
wiped primary dir does not by itself trigger catch-up runs.

## Restore after a wipe

```bash
VAULT="${VAULT:-$HOME/Vault}"
mkdir -p "$HOME/Library/Application Support/selfheal-runner"
cp -p "$VAULT/.scripts/state-mirror/"*.last "$HOME/Library/Application Support/selfheal-runner/"
cp -p "$VAULT/.scripts/state-mirror/selfheal-runner.log" "$HOME/Library/Logs/"
```

On a new Mac, `scripts/bootstrap.sh install` does this for you — but only when the live marker dir
is empty. Never hand-write or fabricate markers: a marker claims a job succeeded.

## Design notes
- Deliberately one-way (live → mirror) and copy-only. The backup script never deletes mirror
  files, so a wiped live dir cannot empty the mirror on the next run.
- `~/Library/Logs/obsidian-backup.log` is deliberately NOT mirrored: it changes on every run, which
  would force a git commit every 30 min. Protect it with a protected-paths rule in your global
  agent instructions instead (it is the only way to tell "machine asleep" from "ran, nothing to
  commit").
