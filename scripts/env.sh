# Sourced (bash or zsh) by every script that needs Node — start.sh, mission-control.sh,
# triage.sh, resident-launch.sh, agent-spawn.sh, task.sh, agent-send.sh, agent-close.sh,
# render-tmpl.sh, checkpoint restore.sh — so launchd and cmux shells
# (no login profile) find the same Node + `claude` the interactive shell uses.
# Resolution: $NODE_BIN_DIR if set → nvm $MC_NODE_VERSION → newest nvm → Homebrew.
# No globs (zsh aborts on no-match); safe under `set -eu`.
: "${MC_NODE_VERSION:=v22.23.0}"
if [ -z "${NODE_BIN_DIR:-}" ]; then
  _nvm="$HOME/.nvm/versions/node"
  if [ -x "$_nvm/$MC_NODE_VERSION/bin/node" ]; then
    NODE_BIN_DIR="$_nvm/$MC_NODE_VERSION/bin"
  else
    _v="$(ls "$_nvm" 2>/dev/null | sort -V | tail -1 || true)"
    if [ -n "$_v" ] && [ -x "$_nvm/$_v/bin/node" ]; then NODE_BIN_DIR="$_nvm/$_v/bin"; else NODE_BIN_DIR="/opt/homebrew/bin"; fi
  fi
  unset _nvm _v
fi
NODE_BIN="$NODE_BIN_DIR/node"
export NODE_BIN_DIR NODE_BIN
# Optional per-checkout overrides (gitignored), e.g. MC_PORT=3211 for a
# second-account dry run. Callers set ROOT (start.sh: DIR) before sourcing.
_root="${ROOT:-${DIR:-}}"
if [ -n "$_root" ] && [ -f "$_root/data/local.env" ]; then set -a; . "$_root/data/local.env"; set +a; fi
unset _root
export PATH="$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# mc_resolve <rel>: overlay/<rel> → <rel> → examples/<rel> (same rule as
# src/config.mjs resolve). Owner-specific config lives in overlay/.
mc_resolve() {
  _r="${ROOT:-${DIR:-.}}"
  for _p in "${MC_OVERLAY:-$_r/overlay}/$1" "$_r/$1" "$_r/examples/$1"; do
    if [ -e "$_p" ]; then printf '%s\n' "$_p"; unset _r _p; return 0; fi
  done
  printf '%s\n' "${MC_OVERLAY:-$_r/overlay}/$1"; unset _r _p; return 1
}

# Owner machine identity: label prefix + vault path (overlay/config/zulu.env,
# else the examples/ twin). Exported for launchers, bootstrap and render-tmpl.
_zenv="$(mc_resolve config/zulu.env)" && { set -a; . "$_zenv"; set +a; }
unset _zenv
: "${MC_LABEL_PREFIX:=com.zulu-assistant}"
: "${VAULT:=$HOME/Vault}"
export MC_LABEL_PREFIX VAULT
