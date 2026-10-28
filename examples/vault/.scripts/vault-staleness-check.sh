#!/bin/zsh
# Vault staleness check — compares each project's `last-synced` frontmatter
# against the latest activity in its source folder(s), and writes the result
# to "Staleness Report.md" at the vault root.
#
# Run by launchd (<prefix>.obsidian-staleness, template
# .scripts/launchd/vault-staleness.plist.tmpl): weekly (Mon 08:00) + at load.
# A marker file makes the at-load run a no-op unless >6 days have passed, so a
# powered-off Mac still gets its weekly check on next boot without re-running
# on every login.
#
# Env override: VAULT (default: the folder above this script).

set -u
VAULT="${VAULT:-${0:A:h:h}}"
REPORT="$VAULT/Staleness Report.md"
MARKER="$HOME/.cache/obsidian-vault/staleness-last-run"
LOG="$HOME/Library/Logs/obsidian-staleness.log"
JSON="${STALENESS_JSON:-$HOME/.cache/obsidian-vault/staleness.json}"   # read by the board (SETTINGS.brain.staleness)
GRACE_DAYS=3   # source activity this many days newer than last-synced => stale

mkdir -p "$(dirname "$MARKER")"

# Skip if we ran within the last 6 days (RunAtLoad fires on every login).
if [[ -f "$MARKER" && "${FORCE:-0}" != 1 ]]; then   # FORCE=1 runs now
  last_run=$(cat "$MARKER" 2>/dev/null || echo 0)
  now=$(date +%s)
  if (( now - last_run < 6 * 86400 )); then
    echo "$(date '+%Y-%m-%d %H:%M') skipped (ran $(( (now - last_run) / 86400 ))d ago)" >> "$LOG"
    exit 0
  fi
fi

# project name | overview note (relative to the vault) | source dirs (comma-separated)
# >>> One line per project. Add a line whenever you onboard a project (Vault Guide step 6). <<<
TABLE=$(cat <<EOF
Example Project|Example Project/Example Project.md|$HOME/example-project
EOF
)

# Latest REAL activity date (YYYY-MM-DD) for one dir: git commit date if a
# repo, else newest mtime among source-ish files near the top of the tree.
# Metadata-only changes (CLAUDE.md, AGENTS.md, README.md, .gitignore, lock
# files) don't count as work and are excluded from both signals.
latest_activity() {
  local dir="$1"
  [[ -d "$dir" ]] || { echo ""; return; }
  if [[ -d "$dir/.git" ]]; then
    # "Checkpoint …" commits only preserve uncommitted work: not activity
    git -C "$dir" log -1 --format=%cs --invert-grep --grep='^Checkpoint' -- . \
      ':(exclude)CLAUDE.md' ':(exclude)AGENTS.md' ':(exclude)README.md' \
      ':(exclude).gitignore' ':(exclude)*.lock' ':(exclude)*-lock.json' \
      2>/dev/null
    return
  fi
  local newest
  newest=$(find "$dir" -maxdepth 3 -type f \
      \( -name '*.py' -o -name '*.js' -o -name '*.ts' -o -name '*.tsx' -o -name '*.md' -o -name '*.sh' -o -name '*.json' \) \
      -not -name 'CLAUDE.md' -not -name 'AGENTS.md' -not -name 'README.md' \
      -not -name '*-lock.json' -not -name '*.lock' \
      -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/venv/*' \
      -not -path '*/logs/*' -not -path '*/.venv/*' \
      -exec stat -f %m {} + 2>/dev/null | sort -rn | head -1)
  [[ -n "$newest" ]] && date -r "$newest" '+%Y-%m-%d' || echo ""
}

to_epoch() { date -j -f '%Y-%m-%d' "$1" '+%s' 2>/dev/null || echo 0; }

today=$(date '+%Y-%m-%d')
rows=""; jrows=""
stale_count=0

while IFS='|' read -r name note sources; do
  [[ -z "$name" ]] && continue
  synced=$(awk -F': *' '/^last-synced:/{print $2; exit}' "$VAULT/$note" 2>/dev/null | tr -d "\"'" | cut -c1-10)
  [[ -z "$synced" ]] && synced="(none)"

  newest_src=""; newest_dir=""
  IFS=',' read -rA dirs <<< "$sources"
  for d in "${dirs[@]}"; do
    a=$(latest_activity "$d")
    [[ -n "$a" && ( -z "$newest_src" || "$a" > "$newest_src" ) ]] && { newest_src="$a"; newest_dir="$d"; }
  done
  [[ -z "$newest_src" ]] && newest_src="(unknown)"

  verdict="ok"; is_stale=false; diff_days=0
  if [[ "$synced" == "(none)" ]]; then
    verdict="no last-synced"
  elif [[ "$newest_src" != "(unknown)" ]]; then
    diff_days=$(( ($(to_epoch "$newest_src") - $(to_epoch "$synced")) / 86400 ))
    if (( diff_days > GRACE_DAYS )); then
      verdict="STALE (${diff_days}d behind)"; is_stale=true
      (( stale_count++ ))
    fi
  fi
  rows="${rows}| [[${note%.md}\\|$name]] | $synced | $newest_src | $verdict |
"
  srcjson=$(printf '"%s",' "${dirs[@]}"); srcjson="[${srcjson%,}]"
  jrows="${jrows}{\"project\":\"$name\",\"note\":\"$note\",\"synced\":\"$synced\",\"latest\":\"$newest_src\",\"latestDir\":\"$newest_dir\",\"sources\":$srcjson,\"stale\":$is_stale,\"days\":$diff_days},"
done <<< "$TABLE"

cat > "$REPORT" <<EOF
---
type: data-log
tags: [meta, staleness]
date: $today
---

# Staleness Report — $today

Auto-generated weekly by \`.scripts/vault-staleness-check.sh\` (self-healing after
downtime). A project is **stale** when its source folder has activity more than
${GRACE_DAYS} days newer than the overview note's \`last-synced\` — work happened that
was never mirrored into the vault. Fix by syncing the project (see [[Vault Guide]])
and bumping \`last-synced\`.

**Stale projects: $stale_count**

| Project | last-synced | Latest source activity | Status |
|---|---|---|---|
$rows
EOF

mkdir -p "$(dirname "$JSON")"
printf '{"at":"%s","date":"%s","grace":%d,"stale":%d,"rows":[%s]}\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$today" "$GRACE_DAYS" "$stale_count" "${jrows%,}" > "$JSON.tmp" && mv "$JSON.tmp" "$JSON"

date +%s > "$MARKER"
echo "$(date '+%Y-%m-%d %H:%M') report written ($stale_count stale)" >> "$LOG"
exit 0
