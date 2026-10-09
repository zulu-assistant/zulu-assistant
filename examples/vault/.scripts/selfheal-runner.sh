#!/bin/zsh
# Self-healing scheduled-job runner for launchd.
#   selfheal-runner.sh <label> <slotspec> <command-string>
#     slotspec: "daily:HH:MM[,HH:MM...]"   (times must be sorted ascending)
#            or "weekly:W:HH:MM"           (W = 0 Sunday … 6 Saturday)
#            or "monthly:D:HH:MM"          (D = day of month, 1 … 28)
#
# Called by a plist with BOTH StartCalendarInterval (the schedule) and
# RunAtLoad (boot/login catch-up). Decision rule: run iff the last successful
# run is OLDER than the most recent scheduled slot — so calendar fires run,
# wake-coalesced fires after sleep run, boot-after-power-off catches up the
# missed slot, and ordinary logins are no-ops. A FAILED run does not update
# the marker, so it is retried at the next slot or next load.
#
# Env: SELFHEAL_DRY=1 prints the decision without executing.
#      VAULT overrides the vault path (default: the folder above this script).

set -u
LABEL="$1"; SLOTSPEC="$2"; CMD="$3"
# MARKERS ARE STATE, NOT CACHE. Keep them out of ~/.cache, the one directory
# disk cleaners are designed to empty: a wiped marker dir makes every job read
# "never ran" and fire a catch-up at once, including paid or outbound ones.
# Two defences:
#   1. The primary store is Application Support, which cleaners avoid.
#   2. A missing marker NEVER means "never ran" — the newest of the primary,
#      the legacy path and the git-backed vault mirror wins, so losing any one
#      location is survivable.
VAULT="${VAULT:-${0:A:h:h}}"
MARKER_DIR="$HOME/Library/Application Support/selfheal-runner"
LEGACY_DIR="$HOME/.cache/selfheal-runner"
MIRROR_DIR="$VAULT/.scripts/state-mirror"
MARKER="$MARKER_DIR/$LABEL.last"
LEGACY_MARKER="$LEGACY_DIR/$LABEL.last"
MIRROR_MARKER="$MIRROR_DIR/$LABEL.last"
LOG="$HOME/Library/Logs/selfheal-runner.log"
mkdir -p "$MARKER_DIR"

now=$(date +%s)
today=$(date +%F)

last_expected=0
case "$SLOTSPEC" in
  daily:*)
    times="${SLOTSPEC#daily:}"
    for t in ${(s:,:)times}; do
      # :00 pins seconds — without it BSD date fills them from the current
      # clock, jittering the slot epoch by up to 59s vs the stored marker
      e=$(date -j -f '%Y-%m-%d %H:%M:%S' "$today $t:00" +%s 2>/dev/null) || continue
      (( e <= now && e > last_expected )) && last_expected=$e
    done
    if (( last_expected == 0 )); then
      # before the first slot today -> last slot was yesterday's final time
      yday=$(date -v-1d +%F)
      final="${times##*,}"
      last_expected=$(date -j -f '%Y-%m-%d %H:%M:%S' "$yday $final:00" +%s)
    fi
    ;;
  weekly:*)
    rest="${SLOTSPEC#weekly:}"
    wday="${rest%%:*}"; t="${rest#*:}"
    delta=$(( ($(date +%w) - wday + 7) % 7 ))
    cand=$(date -v-${delta}d +%F)
    last_expected=$(date -j -f '%Y-%m-%d %H:%M:%S' "$cand $t:00" +%s)
    if (( last_expected > now )); then
      cand=$(date -v-$((delta + 7))d +%F)
      last_expected=$(date -j -f '%Y-%m-%d %H:%M:%S' "$cand $t:00" +%s)
    fi
    ;;
  monthly:*)
    rest="${SLOTSPEC#monthly:}"
    mday="${rest%%:*}"; t="${rest#*:}"
    cand="$(date +%Y-%m)-$(printf '%02d' "$mday")"
    last_expected=$(date -j -f '%Y-%m-%d %H:%M:%S' "$cand $t:00" +%s 2>/dev/null) || {
      echo "$(date '+%F %H:%M:%S') [$LABEL] BAD SLOTSPEC: $SLOTSPEC" >> "$LOG"; exit 78; }
    if (( last_expected > now )); then
      cand="$(date -v-1m +%Y-%m)-$(printf '%02d' "$mday")"
      last_expected=$(date -j -f '%Y-%m-%d %H:%M:%S' "$cand $t:00" +%s)
    fi
    ;;
  *)
    echo "$(date '+%F %H:%M:%S') [$LABEL] BAD SLOTSPEC: $SLOTSPEC" >> "$LOG"; exit 78 ;;
esac

# Newest wins across all three locations. Reading a stale copy can only cause
# an extra run; reading none causes a catch-up storm, so bias to whatever
# evidence exists.
read_marker() {
  [[ -f "$1" ]] || { echo 0; return; }
  local v
  v=$(cat "$1" 2>/dev/null) || { echo 0; return; }
  [[ "$v" == <-> ]] && echo "$v" || echo 0
}
last_run=0
for f in "$MARKER" "$LEGACY_MARKER" "$MIRROR_MARKER"; do
  v=$(read_marker "$f")
  (( v > last_run )) && last_run=$v
done

# Seed the primary location from whatever we found, so the first run after a
# move or a wipe does not look like a cold start.
if [[ ! -f "$MARKER" ]] && (( last_run > 0 )); then
  echo "$last_run" > "$MARKER" 2>/dev/null || true
fi

if (( last_run >= last_expected )); then
  [[ "${SELFHEAL_DRY:-}" == "1" ]] && { echo "DRY[$LABEL]: SKIP (last_run $(date -r $last_run '+%F %H:%M') >= slot $(date -r $last_expected '+%F %H:%M'))"; exit 0; }
  echo "$(date '+%F %H:%M:%S') [$LABEL] skip — up to date (slot $(date -r $last_expected '+%F %H:%M'))" >> "$LOG"
  exit 0
fi

if [[ "${SELFHEAL_DRY:-}" == "1" ]]; then
  echo "DRY[$LABEL]: WOULD RUN (last_run $(date -r $last_run '+%F %H:%M' 2>/dev/null || echo never) < slot $(date -r $last_expected '+%F %H:%M'))"
  exit 0
fi

echo "$(date '+%F %H:%M:%S') [$LABEL] running (covering slot $(date -r $last_expected '+%F %H:%M'))" >> "$LOG"
/bin/zsh -c "$CMD"
rc=$?
if (( rc == 0 )); then
  now_stamp=$(date +%s)
  echo "$now_stamp" > "$MARKER"
  # Mirror to the git-backed copy on every success, so the backup is never
  # stale. Best-effort: a mirror failure must not fail the job.
  if [[ -d "$MIRROR_DIR" ]]; then
    echo "$now_stamp" > "$MIRROR_MARKER" 2>/dev/null || true
  fi
  echo "$(date '+%F %H:%M:%S') [$LABEL] success" >> "$LOG"
else
  echo "$(date '+%F %H:%M:%S') [$LABEL] FAILED rc=$rc — marker not updated, will retry next slot/load" >> "$LOG"
fi
tail -n 1000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
exit $rc
