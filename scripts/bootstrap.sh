#!/bin/zsh
# Stand up (or audit) the agent OS (Ops Board + Mission Control) on this Mac. Runbook:
# docs/INSTALL.md (public edition) or system/SETUP.md (private runbook, when present).
#
#   scripts/bootstrap.sh check                       PASS/WARN/FAIL table; exit 1 on any FAIL
#   scripts/bootstrap.sh install [--dry-run] [--force] [--deadman] [--sandbox]
#                                                    idempotent; every step prints done|skip|would|kept
#   scripts/bootstrap.sh verify [--no-notify]        tests, board, cmux notify, heal-restore + triage dry runs
#
# install never overwrites a file that differs from the repo's version unless
# --force (then it backs it up to <file>.bak-<ts> first). It never touches the
# cmux sidebar/Dock selection, workspace titles or groups (groups stay OFF —
# they hide anchors), and never deletes selfheal markers. --deadman pushes the
# dead-man's-switch Actions secrets from data/secrets.env with `gh secret set`
# (values are never printed). --sandbox is for a second macOS account (the
# dry run on a second account): no triage LaunchAgent (paid claude -p passes) and no vault
# LaunchAgents (a second backup loop would push the same vault repo).
set -u
setopt null_glob
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/env.sh"

# ---- pins (bump deliberately; the runbook's requirements section explains each) ----
NODE_MAJOR=22
CLAUDE_MIN=2.1.280          # claude-opus-5-5 needs >= 2.1.280
CMUX_SERIES=0.65            # tested 0.65.0 (0.64.x also works); quirks handled in code: password wipe, placeholder anchors, feed tui flag
GRAPHIFY_PIN=0.9.83
# VAULT + MC_LABEL_PREFIX come from config/zulu.env (overlay/, else examples/) via scripts/env.sh
# Where messages point: the private runbook when this checkout has one, else the public docs.
if [[ -f "$ROOT/system/SETUP.md" ]]; then DOC_BRAIN="SETUP §7"; DOC_MANUAL="system/SETUP.md §4"; DOC_CMUX="CLAUDE.md"
else DOC_BRAIN="docs/BRAIN.md"; DOC_MANUAL="docs/INSTALL.md"; DOC_CMUX="docs/CMUX-SETUP.md"; fi
MARKER_DIR="$HOME/Library/Application Support/selfheal-runner"
PW_FILE="$ROOT/data/cmux-socket-password"
AGENT_NAMES=(master-console mission-control-triage)            # system/launchd/<name>.plist.tmpl
AGENTS=("${AGENT_NAMES[@]/#/$MC_LABEL_PREFIX.}")
VAULT_AGENTS=("$MC_LABEL_PREFIX.obsidian-backup" "$MC_LABEL_PREFIX.obsidian-staleness")   # plists versioned in $VAULT/.scripts/
# Actions secret ← secrets.env key (deadman.yml reads the heartbeat + emails via SMTP)
# Two workflow shapes: the public deadman.example.yml (renamed to deadman.yml) reads
# HEARTBEAT_READ_URL/KEY; an older Supabase-specific one reads SUPABASE_URL/ANON_KEY.
if grep -q HEARTBEAT_READ_URL .github/workflows/deadman.yml 2>/dev/null; then
  DEADMAN_KEYS=(HEARTBEAT_READ_URL:HEARTBEAT_READ_URL HEARTBEAT_READ_KEY:HEARTBEAT_READ_KEY SMTP_HOST:SMTP_HOST SMTP_PORT:SMTP_PORT SMTP_USER:SMTP_USER SMTP_PASS:SMTP_PASS ALERT_TO:ALERT_EMAIL_TO)
else
  DEADMAN_KEYS=(SUPABASE_URL:SUPABASE_URL SUPABASE_ANON_KEY:SUPABASE_ANON_KEY SMTP_HOST:SMTP_HOST SMTP_PORT:SMTP_PORT SMTP_USER:SMTP_USER SMTP_PASS:SMTP_PASS ALERT_TO:ALERT_EMAIL_TO)
fi
# secrets.env keys the board uses at runtime (a missing one = that feature off)
SECRET_KEYS=(SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS ALERT_EMAIL_TO SMS_WEBHOOK_URL SMS_WEBHOOK_KEY SMS_ALERT_TO HEARTBEAT_URL HEARTBEAT_KEY)
skey() { grep -E "^$1=" data/secrets.env 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

TS=$(date +%Y-%m-%dT%H-%M-%S)
FAILS=0 WARNS=0
row() {  # row STATUS item detail
  local s=$1; shift
  case $s in FAIL) ((FAILS++)) ;; WARN) ((WARNS++)) ;; esac
  printf '%-5s %-26s %s\n' "$s" "$1" "${2:-}"
}
has() { command -v "$1" >/dev/null 2>&1; }
t() { perl -e 'alarm shift; exec @ARGV' "$@"; }   # t <secs> cmd… (macOS has no timeout(1))
vge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]; }   # vge have min
loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }
cmuxc() { CMUX_SOCKET_PASSWORD="$(cat "$PW_FILE" 2>/dev/null)" CMUX_QUIET=1 t 10 cmux "$@"; }

# =========================================================================== check
do_check() {
  echo "bootstrap check — $(hostname -s) — repo $ROOT"
  echo
  has brew && row PASS homebrew "$(brew --version | head -1)" || row FAIL homebrew "install: https://brew.sh"

  local nv; nv=$("$NODE_BIN" -v 2>/dev/null)
  if [[ -z "$nv" ]]; then row FAIL node "no node; nvm install $NODE_MAJOR (scripts/env.sh resolves nvm → Homebrew)"
  elif [[ "${nv#v}" == ${NODE_MAJOR}.* ]]; then row PASS node "$nv ($NODE_BIN_DIR)"
  else row WARN node "$nv — pinned major is $NODE_MAJOR (MC_NODE_VERSION in scripts/env.sh)"; fi

  if has gh; then
    t 15 gh auth status >/dev/null 2>&1 && row PASS "gh auth" "$(gh api user -q .login 2>/dev/null)" || row FAIL "gh auth" "gh auth login"
  else row FAIL gh "brew install gh"; fi

  if has claude; then
    local cv; cv=$(claude --version 2>/dev/null | awk '{print $1}')
    vge "$cv" "$CLAUDE_MIN" && row PASS "claude code" "$cv" || row FAIL "claude code" "$cv < $CLAUDE_MIN — npm i -g @anthropic-ai/claude-code (nvm Node)"
    t 20 claude auth status 2>/dev/null | grep -q '"loggedIn": true' && row PASS "claude login" "" || row FAIL "claude login" "run: claude  (then /login)"
  else row FAIL "claude code" "npm i -g @anthropic-ai/claude-code (nvm Node $NODE_MAJOR)"; fi

  if has codex; then
    t 10 codex login status >/dev/null 2>&1 && row PASS codex "$(codex --version 2>/dev/null) · logged in" || row WARN codex "codex login"
  else row WARN codex "optional (Codex panes): npm i -g @openai/codex"; fi

  if has cmux; then
    local xv; xv=$(cmux --version 2>/dev/null | awk '{print $2}')
    [[ "$xv" == ${CMUX_SERIES}.* ]] && row PASS cmux "$xv" || row WARN cmux "$xv — tested on $CMUX_SERIES.x; re-check the quirks in $DOC_CMUX"
  else row FAIL cmux "brew install --cask cmux"; fi
  if [[ -f "$PW_FILE" ]]; then
    [[ "$(stat -L -f %Lp "$PW_FILE")" == 600 ]] && row PASS "cmux socket password" "data/cmux-socket-password (600)" || row WARN "cmux socket password" "chmod 600 $PW_FILE"
    cmuxc ping >/dev/null 2>&1 && row PASS "cmux socket" "answers with the password" || row WARN "cmux socket" "not answering — is cmux running? the board's heal-cmux re-injects the password"
  else row FAIL "cmux socket password" "missing — scripts/bootstrap.sh install"; fi

  [[ -d /Applications/Tailscale.app ]] && { t 5 tailscale status >/dev/null 2>&1 && row PASS tailscale "connected" || row WARN tailscale "app present, not connected"; } \
    || row WARN tailscale "optional (phone): App Store build, not the brew cask"
  # Full Disk Access is per app; this probes the terminal running bootstrap.
  ls "$HOME/Library/Safari" >/dev/null 2>&1 && row PASS "full disk access" "this terminal has FDA" \
    || row WARN "full disk access" "this terminal lacks FDA (iCloud Drive moves fail with EPERM) — grant cmux FDA (System Settings → Privacy; not migrated by Migration Assistant — $DOC_MANUAL) and re-run from a cmux pane"

  if [[ -d "$VAULT/.git" && -f "$VAULT/.scripts/selfheal-runner.sh" ]]; then row PASS vault "$VAULT"
  else row FAIL vault "clone the vault to $VAULT (VAULT= to override) — $DOC_BRAIN"; fi
  local n=0; for f in "$MARKER_DIR"/*.last; do ((n++)); done
  ((n)) && row PASS "selfheal markers" "$n in Application Support" || row WARN "selfheal markers" "none — restore from \$VAULT/.scripts/state-mirror (README), never fabricate"

  local a; for a in $AGENTS $VAULT_AGENTS; do
    loaded "$a" && row PASS "launchd ${a#$MC_LABEL_PREFIX.}" "loaded" || row FAIL "launchd ${a#$MC_LABEL_PREFIX.}" "not loaded — install (repo agents) / vault plists ($DOC_BRAIN)"
  done

  if has graphify; then
    local gv; gv=$(graphify --version 2>/dev/null | awk '{print $NF}')
    [[ "$gv" == "$GRAPHIFY_PIN" ]] && row PASS graphify "$gv" || row WARN graphify "$gv — pinned $GRAPHIFY_PIN (uv tool install graphifyy==$GRAPHIFY_PIN)"
  else row WARN graphify "uv tool install graphifyy==$GRAPHIFY_PIN"; fi
  grep -q '"graphify"' "$HOME/.claude.json" 2>/dev/null && row PASS "graphify mcp" "registered (user scope)" || row WARN "graphify mcp" "claude mcp add -s user graphify -- $HOME/.local/bin/graphify-mcp $HOME/.graphify/global-graph.json"
  local sk; for sk in graphify sync-obsidian; do
    [[ -f "$HOME/.claude/skills/$sk/SKILL.md" ]] && row PASS "skill $sk" "" || row WARN "skill $sk" "missing in ~/.claude/skills — bootstrap install ($DOC_BRAIN)"
  done
  if grep -q 'hook-guard' .claude/settings.json "$HOME/.claude/settings.json" 2>/dev/null; then row PASS "graphify hooks" "hook-guard in Claude settings"
  else row WARN "graphify hooks" "graphify hook-guard hooks missing — ./install.sh --brain"; fi

  if [[ ! -f data/secrets.env ]]; then row FAIL secrets.env "missing — cp secrets.env.example data/secrets.env && chmod 600 (alerts + heartbeat are off without it)"
  else
    [[ "$(stat -L -f %Lp data/secrets.env)" == 600 ]] || row WARN "secrets.env mode" "chmod 600 data/secrets.env"
    local k; local -a missing
    for k in $SECRET_KEYS; do [[ -n "$(skey $k)" ]] || missing+=("$k"); done
    if ((${#missing} == 0)); then row PASS secrets.env "all ${#SECRET_KEYS} runtime keys set"
    else
      local off=()
      [[ " ${missing[*]} " == *" SMTP_"* || " ${missing[*]} " == *" ALERT_EMAIL_TO "* ]] && off+=(email)
      [[ " ${missing[*]} " == *" SMS_"* ]] && off+=(sms)
      [[ " ${missing[*]} " == *" HEARTBEAT_"* ]] && off+=(heartbeat)
      row WARN secrets.env "empty: ${missing[*]} → off: ${off[*]:-none}"
    fi
  fi
  pmset -g 2>/dev/null | grep -Eq 'autorestart +1' && row PASS "power: autorestart" "" || row WARN "power: autorestart" "sudo pmset autorestart 1"
  local al; al=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null)
  [[ -n "$al" ]] && row PASS "power: auto-login" "$al" || row WARN "power: auto-login" "System Settings → Users & Groups → Automatically log in"

  echo; echo "$FAILS fail, $WARNS warn"
  ((FAILS == 0))
}

# =========================================================================== install
DRY=0 FORCE=0 DEADMAN=0 SANDBOX=0
step() { [[ $1 == FAIL ]] && ((FAILS++)); printf '%-6s %s\n' "$1" "$2"; }
# place <src-file> <dest>: create | up to date | kept (differs) | replaced (backup) ; honours DRY/FORCE
place() {
  local src=$1 dst=$2 what=$3
  if [[ ! -e "$dst" ]]; then
    ((DRY)) && { step would "create $what → $dst"; return; }
    mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; step done "created $what → $dst"
  elif cmp -s "$src" "$dst"; then step skip "$what up to date"
  elif ((FORCE)); then
    ((DRY)) && { step would "back up + replace $what ($dst)"; return; }
    cp -p "$dst" "$dst.bak-$TS"; cp "$src" "$dst"; step done "replaced $what (backup $dst.bak-$TS)"
  else step kept "$what differs from the repo — left alone (--force backs up + replaces): $dst"; fi
}

do_install() {
  local a
  for a in "$@"; do case $a in --dry-run) DRY=1 ;; --force) FORCE=1 ;; --deadman) DEADMAN=1 ;; --sandbox) SANDBOX=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
  local tmp; tmp=$(mktemp -d); trap "rm -rf '$tmp'" EXIT
  echo "bootstrap install$( ((DRY)) && echo ' (dry run)')$( ((FORCE)) && echo ' --force')$( ((SANDBOX)) && echo ' --sandbox')"

  # 1. dirs
  local d; local -a missing
  for d in data data/handoffs data/tasks logs "$HOME/.config/cmux" "$HOME/.config/ghostty" "$MARKER_DIR"; do [[ -d "$d" ]] || missing+=("$d"); done
  if ((${#missing})); then ((DRY)) && step would "mkdir ${missing[*]}" || { mkdir -p "${missing[@]}"; step done "mkdir ${missing[*]}"; }
  else step skip "dirs exist"; fi

  # 2. cmux socket password (never regenerated: cmux and every script share it)
  if [[ -f "$PW_FILE" ]]; then step skip "cmux socket password exists"
  elif ((DRY)); then step would "generate data/cmux-socket-password (600)"
  else (umask 077; openssl rand -hex 16 > "$PW_FILE"); step done "generated data/cmux-socket-password (600)"; fi

  # 3. ghostty (theme/font/colors, read by cmux)
  place system/ghostty-config "$HOME/.config/ghostty/config" "ghostty config"

  # 4. cmux.json — rendered from the template; compared ignoring the password slot
  scripts/render-tmpl.sh system/cmux/cmux.json.tmpl "$tmp/cmux.json" || { step FAIL "render cmux.json.tmpl"; return 1; }
  local live="$HOME/.config/cmux/cmux.json"
  local same; same=$(node -e '
    const fs=require("fs"); const [a,b]=process.argv.slice(1);
    try { const x=JSON.parse(fs.readFileSync(a)), y=JSON.parse(fs.readFileSync(b));
      delete x.automation.socketPassword; if (y.automation) delete y.automation.socketPassword;
      delete x.workspaceGroups; delete y.workspaceGroups;   // owned by cmux-chrome-config.mjs (repoDomains), not the template
      const canon=(v)=>Array.isArray(v)?v.map(canon):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canon(v[k])])):v;
      console.log(JSON.stringify(canon(x))===JSON.stringify(canon(y)) ? "same" : "differs") } catch { console.log("absent") }' "$tmp/cmux.json" "$live")
  if [[ "$same" == same ]]; then step skip "cmux.json up to date"
  elif [[ "$same" == differs && $FORCE == 0 ]]; then step kept "cmux.json differs from the template — left alone (--force backs up + replaces; pane chrome: scripts/cmux-chrome-config.mjs)"
  elif ((DRY)); then step would "$([[ $same == absent ]] && echo create || echo 'back up + replace') ~/.config/cmux/cmux.json (password injected)"
  elif [[ ! -f "$PW_FILE" ]]; then step FAIL "cmux.json needs data/cmux-socket-password"
  else
    [[ -f "$live" ]] && cp -p "$live" "$live.bak-$TS"
    PW="$(cat "$PW_FILE")" node -e 'const fs=require("fs");const [s,d]=process.argv.slice(1);
      fs.writeFileSync(d, fs.readFileSync(s,"utf8").replace("__FROM_data/cmux-socket-password__", process.env.PW))' "$tmp/cmux.json" "$live"
    step done "wrote ~/.config/cmux/cmux.json$([[ $same == differs ]] && echo " (backup $live.bak-$TS)") — run: cmux reload-config"
  fi

  # 5. LaunchAgents this repo owns (board + triage)
  for a in $AGENTS; do
    if ((SANDBOX)) && [[ $a == *triage ]]; then step skip "$a (--sandbox: no paid triage passes from a test account)"; continue; fi
    scripts/render-tmpl.sh "system/launchd/${a#$MC_LABEL_PREFIX.}.plist.tmpl" "$tmp/$a.plist" || { step FAIL "render $a"; continue; }
    place "$tmp/$a.plist" "$HOME/Library/LaunchAgents/$a.plist" "plist $a"
    if loaded "$a"; then step skip "$a loaded"
    elif ((DRY)); then step would "launchctl bootstrap $a"
    else launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$a.plist" && step done "loaded $a" || step FAIL "launchctl bootstrap $a"; fi
  done

  # 6. cmux Tier 1 (Dock seed + phosphor sidebar) — the installer backs up and validates
  local out; out=$(node scripts/cmux-tier1-install.mjs 2>&1)
  if ! grep -q '^would' <<<"$out"; then step skip "cmux Dock + phosphor up to date"
  elif ((DRY)); then step would "cmux-tier1-install.mjs --apply ($(grep -c '^would' <<<"$out") file(s))"
  else
    # the installer copies, then asks cmux to validate the sidebar — that needs a running cmux
    node scripts/cmux-tier1-install.mjs --apply >/dev/null 2>&1; local rc=$?
    if node scripts/cmux-tier1-install.mjs 2>&1 | grep -q '^would'; then step FAIL "cmux-tier1-install.mjs --apply"
    elif ((rc)); then step done "cmux Dock + phosphor installed — validate once cmux runs: cmux sidebar validate phosphor"
    else step done "cmux Dock + phosphor installed + validated (revert: --revert)"; fi
  fi

  # 7-8. cmux pane chrome + workspace colors/descriptions (need the cmux socket)
  if ! cmuxc ping >/dev/null 2>&1; then step skip "cmux socket not answering — pane chrome + colors later (re-run install once cmux is up)"
  else
    out=$(CMUX_SOCKET_PASSWORD="$(cat "$PW_FILE")" node scripts/cmux-chrome-config.mjs 2>&1)
    if grep -q 'already applied' <<<"$out"; then step skip "cmux pane chrome applied"
    elif ((DRY)); then step would "cmux-chrome-config.mjs --apply"
    else CMUX_SOCKET_PASSWORD="$(cat "$PW_FILE")" node scripts/cmux-chrome-config.mjs --apply >/dev/null 2>&1 && step done "cmux pane chrome applied" || step FAIL "cmux-chrome-config.mjs --apply"; fi
    out=$(CMUX_SOCKET_PASSWORD="$(cat "$PW_FILE")" CMUX_QUIET=1 node scripts/mesh-cli.mjs sync-colors 2>&1)
    if ! grep -q '^would' <<<"$out"; then step skip "workspace colors/descriptions in sync"
    elif ((DRY)); then step would "mesh-cli sync-colors --apply ($(grep -c '^would' <<<"$out") change(s))"
    else CMUX_SOCKET_PASSWORD="$(cat "$PW_FILE")" CMUX_QUIET=1 node scripts/mesh-cli.mjs sync-colors --apply >/dev/null 2>&1 && step done "workspace colors/descriptions synced" || step FAIL "sync-colors"; fi
    step skip "workspace groups stay OFF (they hide anchors) — never created by bootstrap"
  fi

  # 9. brain: vault LaunchAgents, selfheal markers, Graphify, skills (docs/BRAIN.md)
  if [[ ! -d "$VAULT/.scripts" ]]; then step skip "vault not at $VAULT — clone it, then re-run install ($DOC_BRAIN)"
  else
    for a in $VAULT_AGENTS; do
      if ((SANDBOX)); then step skip "$a (--sandbox: one vault backup loop per vault)"; continue; fi
      place "$VAULT/.scripts/$a.plist" "$HOME/Library/LaunchAgents/$a.plist" "plist $a"
      if loaded "$a"; then step skip "$a loaded"
      elif ((DRY)); then step would "launchctl bootstrap $a"
      else launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$a.plist" && step done "loaded $a" || step FAIL "launchctl bootstrap $a"; fi
    done
    # markers are STATE: restore from the git mirror only when the live dir is empty — never fabricate
    local n=0; for f in "$MARKER_DIR"/*.last; do ((n++)); done
    if ((n)); then step skip "selfheal markers present ($n)"
    elif ((DRY)); then step would "restore selfheal markers from $VAULT/.scripts/state-mirror"
    else cp -p "$VAULT/.scripts/state-mirror/"*.last "$MARKER_DIR/" 2>/dev/null && step done "restored selfheal markers from the vault mirror" || step skip "no markers in the mirror"; fi
    # both are written into the vault by `zulu setup --step vault`; a hand-built vault may lack them
    [[ -f "$VAULT/.scripts/claude-skills/sync-obsidian/SKILL.md" ]] && place "$VAULT/.scripts/claude-skills/sync-obsidian/SKILL.md" "$HOME/.claude/skills/sync-obsidian/SKILL.md" "skill sync-obsidian" \
      || step skip "vault has no .scripts/claude-skills (zulu setup --step vault adds it)"
    [[ -f "$VAULT/.scripts/claude-global/CLAUDE.md" ]] && place "$VAULT/.scripts/claude-global/CLAUDE.md" "$HOME/.claude/CLAUDE.md" "global ~/.claude/CLAUDE.md" \
      || step skip "vault has no .scripts/claude-global/CLAUDE.md (zulu setup --step vault adds it)"
  fi
  if ! has graphify; then
    if ! has uv; then step skip "graphify: install uv first (brew install uv), then re-run"
    elif ((DRY)); then step would "uv tool install 'graphifyy[mcp]==$GRAPHIFY_PIN'"
    else uv tool install "graphifyy[mcp]==$GRAPHIFY_PIN" >/dev/null 2>&1 && step done "installed graphify $GRAPHIFY_PIN" || step FAIL "uv tool install graphifyy"; fi
  else step skip "graphify $(graphify --version 2>/dev/null | awk '{print $NF}') installed"; fi
  if has graphify; then
    if [[ -f "$HOME/.claude/skills/graphify/SKILL.md" ]]; then step skip "skill graphify present"
    elif ((DRY)); then step would "graphify install --platform claude (skill)"
    else graphify install --platform claude >/dev/null 2>&1 && step done "graphify skill installed" || step FAIL "graphify install --platform claude"; fi
    local hook; hook=$(git rev-parse --git-path hooks/post-commit 2>/dev/null)
    if [[ -f "$hook" ]] && grep -q graphify "$hook"; then step skip "graphify git hooks present"
    elif ((DRY)); then step would "graphify hook install (post-commit/post-checkout rebuild)"
    else graphify hook install >/dev/null 2>&1 && step done "graphify git hooks installed" || step FAIL "graphify hook install"; fi
    if [[ -f graphify-out/graph.json ]]; then step skip "graphify-out/ built"
    elif ((DRY)); then step would "graphify update . (first code graph)"
    else graphify update . >/dev/null 2>&1 && step done "built graphify-out/ (graphify update .)" || step FAIL "graphify update ."; fi
    if grep -q '"graphify"' "$HOME/.claude.json" 2>/dev/null; then step skip "graphify MCP registered"
    elif ((DRY)); then step would "claude mcp add -s user graphify (global graph)"
    else claude mcp add -s user graphify -- "$HOME/.local/bin/graphify-mcp" "$HOME/.graphify/global-graph.json" >/dev/null 2>&1 && step done "registered graphify MCP (user scope)" || step FAIL "claude mcp add graphify"; fi
    if [[ -x "$HOME/.graphify/reconcile-global.sh" ]]; then step skip "~/.graphify global sync present"
    elif [[ -d "$VAULT/.scripts/graphify-global" ]]; then step skip "~/.graphify missing — restore by hand: $VAULT/.scripts/graphify-global/RESTORE.md"
    fi
  fi

  # 10. secrets + overlay (owner config lives in overlay/, seeded from examples/)
  if [[ -f data/secrets.env ]]; then step skip "data/secrets.env exists"
  elif ((DRY)); then step would "create data/secrets.env from secrets.env.example (600) — then fill it in"
  else (umask 077; cp secrets.env.example data/secrets.env); step done "created data/secrets.env (600) — fill in SMTP_*/SMS_*/HEARTBEAT_* (alerts are off until then)"; fi
  local rel
  for rel in config/agents.json config/jobs.mjs config/mesh.json config/models.json config/TRIAGE.md config/zulu.env POLICY.md MISSION-CONTROL.md publish/denylist.json; do
    if [[ -e "overlay/$rel" ]]; then continue
    elif ((DRY)); then step would "seed overlay/$rel from examples/"
    else mkdir -p "overlay/$(dirname $rel)"; cp "examples/$rel" "overlay/$rel"; step done "seeded overlay/$rel from examples/ — edit it (<OWNER> placeholders)"; fi
  done

  # 11. dead-man's-switch Actions secrets (opt-in, outward: writes GitHub repo secrets)
  if ((DEADMAN)); then
    if [[ ! -f data/secrets.env ]]; then step FAIL "--deadman needs data/secrets.env (template: secrets.env.example)"
    else
      local pair k src v
      for pair in $DEADMAN_KEYS; do
        k=${pair%%:*}; src=${pair#*:}; v=$(skey "$src")
        if [[ -z "$v" ]]; then step FAIL "secrets.env has no $src (Actions secret $k)"
        elif ((DRY)); then step would "gh secret set $k (from $src)"
        else gh secret set "$k" --body "$v" >/dev/null && step done "gh secret set $k" || step FAIL "gh secret set $k"; fi
      done
    fi
  else step skip "dead-man Actions secrets (opt in: --deadman)"; fi
  echo; echo "manual steps (can't be scripted): $DOC_MANUAL"
  ((FAILS == 0))
}

# =========================================================================== verify
do_verify() {
  local notify=1; [[ "${1:-}" == --no-notify ]] && notify=0
  echo "bootstrap verify"
  local out
  out=$(node --test "test/*.test.mjs" 2>&1)
  local pass fail; pass=$(grep -E '^# pass' <<<"$out" | awk '{print $3}'); fail=$(grep -E '^# fail' <<<"$out" | awk '{print $3}')
  [[ "$fail" == 0 ]] && row PASS tests "$pass pass" || row FAIL tests "$fail failing — node --test \"test/*.test.mjs\""

  local code body
  local port="${MC_PORT:-3210}"
  body=$(curl -s -m 10 -w '\n%{http_code}' "localhost:$port/api/status"); code=${body##*$'\n'}
  if [[ "$code" == 200 ]]; then
    row PASS board "HTTP 200 · $(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(`${(j.jobs||[]).length} cards, ${(j.sessions||[]).length} sessions`)})' <<<"${body%$'\n'*}")"
  else row FAIL board "HTTP ${code:-none} on :$port — launchctl kickstart -k gui/$(id -u)/$MC_LABEL_PREFIX.master-console; logs/server.err.log"; fi

  if ((notify)); then
    cmuxc notify --title "Ops Board" --body "bootstrap verify: notify roundtrip OK" >/dev/null 2>&1 \
      && row PASS "cmux notify" "sent (check the cmux Feed)" || row FAIL "cmux notify" "socket refused — check data/cmux-socket-password vs cmux; the board's cmux:bridge card"
  else row WARN "cmux notify" "skipped (--no-notify)"; fi

  t 60 node src/heal-restore.mjs --dry-run >/dev/null 2>&1 && row PASS "heal-restore dry run" "" || row FAIL "heal-restore dry run" "node src/heal-restore.mjs --dry-run"

  # triage: ask the selfheal runner what it WOULD do (never runs the paid pass)
  local plist="$HOME/Library/LaunchAgents/$MC_LABEL_PREFIX.mission-control-triage.plist" slot
  slot=$(plutil -extract ProgramArguments.3 raw -o - "$plist" 2>/dev/null)
  if [[ -n "$slot" && -f "$VAULT/.scripts/selfheal-runner.sh" ]]; then
    out=$(SELFHEAL_DRY=1 t 20 zsh "$VAULT/.scripts/selfheal-runner.sh" mission-control-triage "$slot" "true" 2>&1 | tail -1)
    [[ "$out" == DRY* ]] && row PASS "triage selfheal (dry)" "$out" || row FAIL "triage selfheal (dry)" "${out:-no output}"
  else row FAIL "triage selfheal (dry)" "triage plist or vault runner missing"; fi

  local hits; hits=$(grep -rlE '/Users/[A-Za-z]' scripts system 2>/dev/null | grep -v '\.tmpl$' | wc -l | tr -d ' ')
  [[ "$hits" == 0 ]] && row PASS "no hard-coded paths" "scripts/ system/" || row WARN "no hard-coded paths" "$hits file(s): grep -rlE '/Users/[A-Za-z]' scripts system"

  echo; echo "$FAILS fail, $WARNS warn"
  ((FAILS == 0))
}

case "${1:-}" in
  check) do_check ;;
  install) shift; do_install "$@" ;;
  verify) shift; do_verify "$@" ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
