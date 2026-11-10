#!/bin/bash
# The daily state backup (LaunchAgent <prefix>.state-backup, selfheal daily:03:15).
# One small archive of the ledger + the board's state files + overlay/ into
# data/backups/zulu-state-<time>.tgz, then keep the newest N of ITS OWN archives
# (default 14; STATE_BACKUP_KEEP in data/local.env). Never touches other archives.
# Run by hand any time: scripts/state-backup.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"
. scripts/env.sh
exec "$NODE_BIN" scripts/backup.mjs backup --state --keep "${STATE_BACKUP_KEEP:-14}"
