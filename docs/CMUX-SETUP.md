# cmux setup

Zulu Assistant has two halves: the **Ops Board** (a local web dashboard) and **cmux**, the agent
terminal where your Claude Code and Codex sessions live. This document covers the cmux half: why
it is used, how to install and pin it, what Zulu Assistant configures, and the cmux quirks the
board works around.

> **cmux is a separate application.** It is developed by Manaflow and licensed under the GPL. Zulu
> Assistant does not bundle, modify or redistribute it. You install it yourself; the board and
> scripts talk to it only through its public CLI (`cmux …`) and its local control socket.

## Why cmux

cmux is a native macOS terminal built on Ghostty with first-class Claude Code integration:

- it wraps `claude` and injects hooks, so every pane reports a semantic state — running, idle, or
  needs input;
- the **Feed** (Ctrl-4) collects every permission prompt, plan and question across all sessions
  into one approval queue;
- workspaces, notifications and session restore are scriptable over a local socket.

That socket is what lets the board open a workspace for a failing job (**◉ DISPATCH CLAUDE**),
type messages into ready panes (the Agent Mesh), post alerts into the Feed, and colour workspaces
by domain.

## Install and pin

```bash
brew install --cask cmux        # app in /Applications/cmux.app, CLI on PATH as `cmux`
```

**Pin 0.65.x** (tested on 0.65.2 and 0.65.0; 0.64.25 also works). The board's self-heal code targets specific 0.64/0.65 behaviour;
see *Known quirks* below. cmux auto-updates through Sparkle and ships fixes quickly — if you move
to a newer minor version, re-run `./install.sh verify` and watch the `cmux:bridge` card.

Then, once:

1. **Full Disk Access**: System Settings → Privacy & Security → Full Disk Access → + → cmux.app,
   then relaunch cmux. TCC applies to the responsible app, so every agent in a cmux pane inherits
   (or lacks) this grant.
2. **Login item**: System Settings → General → Login Items → + → cmux. With
   `terminal.autoResumeAgentSessions` (on by default) cmux restores workspaces and resumes Claude
   sessions after a reboot.
3. `./install.sh` renders `~/.config/cmux/cmux.json` and `~/.config/ghostty/config` for you.

## What Zulu Assistant configures

`~/.config/cmux/cmux.json` is rendered from `system/cmux/cmux.json.tmpl`:

| Key | Value | Why |
|---|---|---|
| `automation.claudeCodeIntegration` | `true` | the core toggle: per-pane state, Feed approvals, session restore |
| `automation.claudeBinaryPath` | your Node bin dir + `/claude` | the wrapper must target the real binary (e.g. the nvm one) |
| `automation.socketControlMode` | `"password"` | outside processes (the board) need control operations, not just notify |
| `automation.socketPassword` | from `data/cmux-socket-password` | see the password quirk below |
| `automation.suppressSubagentNotifications` | `true` | no false needs-input noise while Claude subagents run |
| `notifications.*` | dock badge, menu bar, unread pane ring, permission prompts; turn-complete when idle | full attention surface |
| `sidebar.*` | notification message (2 lines), agent activity, trailing badge | the sidebar answers "which session needs me" |
| `app.reorderOnNotification` | `true` | workspaces with fresh notifications float up |

cmux also reads `~/.config/ghostty/config` for theme, font and colours (the green-on-black
phosphor look). Ghostty itself does not need to be installed. After any edit:

```bash
cmux reload-config     # reloads cmux.json and the Ghostty config in place, no restart
```

## The socket password

`socketControlMode: "password"` gates control operations behind a shared secret. The installer
generates it once into `data/cmux-socket-password` (mode 600, gitignored), and the board passes it
as `CMUX_SOCKET_PASSWORD` on every CLI call.

cmux **migrates** `socketPassword` out of `cmux.json` into its own private store when it loads the
file. That is expected — don't rely on the password staying in `cmux.json`, and keep the
repo's copy as the canonical one.

**Quirk (0.64.x): the password is lost on every cold app launch.** The migration scrubs the file
but the private-store write does not persist, so after a reboot or relaunch every dispatch and
notify fails. The board detects this on its `cmux:bridge` card, and `src/heal-cmux.mjs` repairs it
automatically: re-inject the password into `cmux.json` → `cmux reload-config` → verify, with a
5-minute cooldown. If the heal ever fails, do it by hand: copy `data/cmux-socket-password` into
`cmux.json` `automation.socketPassword`, then run `cmux reload-config`.

**Never switch the mode back to `"notifications"`.** That mode only allows notify; dispatch and
all workspace calls break.

## Tier 1 — Dock and the phosphor sidebar

Canonical files live in `system/cmux/`:

- `dock.json` — a Dock with three panels: the chromeless board (`http://localhost:3210/?dock=1`,
  a compact view for a ~360 px column), the Feed TUI (`cmux feed tui`), and a tail of the selfheal
  runner log;
- `sidebars/phosphor.js` — a green-on-black custom **right** sidebar with two modes: ATTENTION
  (default: needs input, approvals, blocked, unread; quiet rows folded per group) and ALL.

```bash
node scripts/cmux-tier1-install.mjs            # dry run
node scripts/cmux-tier1-install.mjs --apply    # back up, copy to ~/.config/cmux/, validate
node scripts/cmux-tier1-install.mjs --revert   # restore backups / remove what it installed
```

The installer records what it did in `data/cmux-tier1-install.json`. It never opens the Dock or
selects the sidebar; that is your click (`cmux right-sidebar set custom phosphor --no-focus`).
The left sidebar stays the cmux default. Custom sidebars have no network access and cannot see
status pills, so the board mirrors task state into each workspace's progress label, and fleet
health lives in the Dock's board panel. If the Dock was already saved empty, cmux won't re-seed
it: close its tabs, or add the panels from the Dock `+` menu.

## Tier 2 — workspace chrome

With `"chrome": true` in `overlay/config/mesh.json` (default `false`), each board poll keeps cmux
in line with the Agent Mesh directory and task ledger:

- workspace **colour** = the agent's domain colour (`domainColors`; Codex panes share one violet);
- workspace **description** = `DOMAIN · <first owned area>`;
- a **task pill** (`#4 WORKING`, `3 tasks · #2 BLOCKED`) and checklist progress;
- a **context gauge**: the progress bar shows how full the session's context window is, with a
  `ctx n%` pill (amber ≥ 60 %, red ≥ 80 %).

A colour or description you set by hand is never overwritten (state in
`data/mesh-chrome-state.json`). Pane chrome — border colours, flash colour, per-repo group tints —
is a separate, reversible script:

```bash
node scripts/cmux-chrome-config.mjs                         # dry run
node scripts/cmux-chrome-config.mjs --apply                 # timestamped .bak, patch, reload
node scripts/cmux-chrome-config.mjs --revert ~/.config/cmux/cmux.json.bak-<ts>
```

Workspace groups are CLI-only (`node scripts/mesh-cli.mjs sync-groups [--apply]`, reversible with
`cmux workspace-group ungroup`) and off by default, because a group hides its anchor workspace.

## Restore and auto-resume

After a reboot cmux runs each workspace's auto-resume (`cmux restore claude <id>`). Two things to
know:

- **Names.** `cmux restore` replays the captured launch arguments, so a launch-time `--name` wins
  over a later `/rename`. Zulu Assistant's launch scripts always pass `--name <workspace-slug>`.
  `node src/heal-restore.mjs --dry-run` lists the name each session will come back as.
- **Restores that die early.** cmux runs the resumes at launch, *before* the socket-password heal
  lands, so they can all fail on `auth_required` and leave bare shells. `src/heal-restore.mjs`
  (chained after the password heal in the board's poll) walks the workspace list once the socket
  answers. It re-sends the restore only where the scrollback shows restore → auth error → nothing
  since, **and** the viewport is a bare shell — never a live Claude UI, even one parked on a
  dialog. It answers the "Resume from summary" picker only if it is on screen. Limits: 10-minute
  per-workspace cooldown, 60 s pass throttle, 12 repairs per pass; one ticker line per repair.
  Manual pass: `node src/heal-restore.mjs`.

Codex panes are not auto-resumed by cmux; run `codex resume` in each by hand.

## The cmux demo

`./install.sh --demo --cmux` (see [INSTALL.md](INSTALL.md#the-cmux-half-too---demo---cmux)) is built so
it cannot touch your real workspaces:

- **Its own window.** It opens a cmux window named ZULU DEMO and creates its six panes there
  (`--id-format both new-workspace`, so the ids come straight from cmux). Every id it creates is
  recorded in `data/demo-cmux-state.json` before anything else is made.
- **A write filter.** While the demo board runs, every cmux command it issues goes through
  `scopedRun` (`src/demo-cmux.mjs`). It allows reads, plus only these writes: `set-color` and
  `set-description` workspace actions, `set-status`/`clear-status`, and
  `set-progress`/`clear-progress`. All of them must target a workspace the demo created. Anything else
  is refused before it reaches cmux. A test proves a full sync pass writes to demo panes only.
- **The group placeholder.** `workspace-group create` always makes an empty anchor workspace. The
  demo finds that exact workspace from the group's own record, takes it out of the group, and
  closes it. It is the only workspace the demo closes outside its pane list.
- **Never in the mesh.** The real board lists workspaces across every window and ignores anything
  titled `ZULU DEMO…` or recorded in the state file. The demo never gets registered, assigned or
  restored.
- **Sidebar selection is yours.** The demo prints
  `cmux right-sidebar set custom phosphor --window <id> --no-focus` and never runs it.
- **Teardown.** `./install.sh demo-stop` closes the demo window, but only if it still holds nothing but demo
  workspaces. If you dragged a real workspace into it, only the demo panes are closed and the window
  stays. Then it deletes `data/demo-cmux-state.json` and `data/demo-chrome-state.json`.

Known limit: the fake agents don't report RUN/IDLE to cmux. That would mean writing into cmux's
real Claude/Codex session files. The sidebar's RUN/IDLE counts therefore ignore them, while everything
ATTENTION shows (INPUT, APPROVAL, BLOCKED, ctx) comes from the board, exactly as in real use.

## Known cmux quirks

| Quirk | Effect | What Zulu Assistant does |
|---|---|---|
| Socket password lost on cold launch (0.64.x) | dispatch and notify fail after every reboot | `src/heal-cmux.mjs` auto re-injects; manual recipe above |
| Password migrated out of `cmux.json` | the file looks empty after load | canonical copy in `data/cmux-socket-password` |
| Auto-resume runs before the password heal | sessions die on `auth_required` | `src/heal-restore.mjs` retries safely |
| `workspace-group create` makes an empty placeholder anchor workspace | stray workspaces appear | `sync-groups` repairs in place; the reconciler never registers placeholders; close them with `mesh-cli.mjs close-placeholders --apply` |
| **NODE_OPTIONS helper purged** (0.64.x–0.65.0) | cmux launches Claude with `NODE_OPTIONS=--require=$TMPDIR/cmux-claude-node-options/restore-node-options.cjs`; macOS temp cleanup can delete that folder, and then every Node start from a cmux shell fails with `Cannot find module … restore-node-options.cjs` | recreate the file (a module that strips its own `--require` from `NODE_OPTIONS` and keeps other flags); `unset NODE_OPTIONS` only fixes one shell. It recurs on the next temp purge. 0.65.2 no longer launches Claude with this helper (cmux PR #18284), so the quirk doesn't apply there |
| Attention signal ~90 % reliable | occasional delayed or duplicate needs-input, stale sidebar text | the board reads session state from the hook file, not the sidebar |
| Sessions started outside cmux are invisible | no tile, no Feed | launch agents inside cmux workspaces |
| Workspace UUIDs change across restores | IDs are not stable keys | the mesh keys agents by workspace and adopts renames each poll; don't build on UUIDs |
| `feed tui` flags | older builds needed `--opentui` | the Dock uses plain `cmux feed tui` |
| Cmd+Q asks for confirmation | — | expected |

## Useful commands

```bash
cmux notify --title "Build" --body "done"     # lands in the Feed (needs CMUX_SOCKET_PASSWORD)
cmux workspace list                           # what the board's reconciler sees
cmux reload-config                            # after editing cmux.json or the Ghostty config
cmux config doctor                            # validate cmux.json
```

Keyboard: Ctrl-4 Feed · Cmd+Shift+U latest unread · Ctrl+Cmd+U walk the unread queue ·
Cmd+Shift+L embedded browser (the board works well as a browser workspace).
