# Architecture

Zulu Assistant is one zero-dependency Node (≥ 22) process that runs as a
LaunchAgent on a Mac. It uses only `node:http` and Server-Sent Events: no npm
packages and no build step. The process does two jobs:

1. **Ops Board.** It watches the machine's background automation fleet and
   shows it on a phosphor-green dashboard at `http://localhost:3210`.
2. **Agent workforce host.** It tracks live Claude Code and Codex sessions
   running in [cmux](WHY-NOT-TMUX.md) and runs the Agent Mesh: a directory, a
   task ledger and message delivery between agents.

![Architecture diagram](architecture.svg)

## Components

| Path | Role |
|---|---|
| `server.mjs` | HTTP server, SSE stream, the 60s poll loop, `/api/*` routes, opt-in actions, heartbeat, daily digest |
| `src/collect.mjs` | Read-only collectors: `launchctl`, `plutil`, `docker`, `crontab -l`, HTTP probes, `df`, memory/swap, `pgrep`. Every external command has a timeout and is killed with SIGKILL when it runs over |
| `src/status.mjs` | Turns raw collector output into per-card status (`ok`, `due`, `stale`, `warn`, `failed`, `overdue`, `down`), including the selfheal slot-spec parser and a zero-dependency cron-expression parser |
| `src/alerts.mjs` | Escalation ladder and the 08:00 digest; dedupe state in `data/alert-state.json` |
| `src/remediate.mjs` | Disk auto-remediation when the disk gauge turns amber or red. The levers are `REMEDIATION_LEVERS` in the registry. The public edition ships that list **empty and commented**, so nothing is deleted until you add levers you trust |
| `src/heal-cmux.mjs` | Restores the cmux socket password after a cold cmux launch, then reloads the config and verifies it |
| `src/heal-restore.mjs` | Retries cmux session restores that failed on `auth_required` during boot |
| `src/mesh.mjs` | Agent Mesh directory (joins `config/agents.json` with live session registries), screen classifier, delivery, outbox, reconciler |
| `src/tasks.mjs` | Task ledger (`data/tasks/<id>.json`). The rules are pure functions; files are written atomically |
| `src/chrome.mjs` | Optional cmux "chrome": sets workspace color and description per domain, plus task pills and progress. Off by default |
| `src/context.mjs` | Context-window gauge per session, read from the tail of each transcript |
| `src/config.mjs` | Overlay resolver (`overlay/` → core → `examples/`), registry re-exports, secrets loader |
| `src/events.mjs` | Ring buffer behind the bottom ticker (`data/events.json`) |
| `src/guard.mjs` | Request source guards (`allowedSource`, `localOnly`) |
| `public/` | Vanilla frontend (`index.html`, `app.js`, `style.css`) |
| `scripts/` | Shell and Node CLIs: bootstrap, Mission Control launch/resume, resident launch, worker spawn/close, `task.sh`, `agent-send.sh`, `mesh-cli.mjs`, triage, publishing |
| `system/` | LaunchAgent and cmux templates (`*.tmpl`), the cmux Dock and sidebar files (install steps: [INSTALL.md](INSTALL.md)) |
| `test/` | `node:test` suites (`node --test "test/*.test.mjs"`) |

## Data flow

### Poll → snapshot → browser

Every 60 seconds `server.mjs` runs one poll:

1. **Collect.** `src/collect.mjs` reads each registered thing. Launchd
   schedules, log paths and selfheal markers come from the job's plist, so a
   registry entry is usually just a label.
2. **Derive.** `src/status.mjs` judges each card. A scheduled job is compared
   with its last due slot plus a grace window, a KeepAlive service needs a PID,
   a cron line is judged by the mtime of its log against the last cron slot,
   and a gauge is compared with its thresholds.
3. **Snapshot.** The result is kept in memory, appended to
   `data/history.json` (for the 24h timeline and history strips), and status
   transitions go to the event ticker.
4. **Push.** The snapshot is serialized once and written to every open SSE
   connection (`/events`). The browser renders it and never polls on its own.
   `GET /api/status` returns the same payload for scripts and agents.

### Escalation

`src/alerts.mjs` looks at cards in `failed`, `overdue` or `down`:

| Tier | When | Channel |
|---|---|---|
| 0 | immediately on a transition | cmux notification (osascript fallback) |
| 1 | red for 30 minutes | email via `SMTP_*` → `ALERT_EMAIL_TO` |
| 2 | labels in `criticalSms`, red for 10 minutes | SMS webhook (`SMS_WEBHOOK_URL/KEY` → `SMS_ALERT_TO`) |
| — | daily at 08:00 | digest email: fleet plus a Work section from the ledger |

Each tier is off when its keys are missing from `data/secrets.env`. While a
card stays red it is re-alerted every 6 hours, and a recovery sends a note.

### Dead-man's switch

Each poll PATCHes one heartbeat row (`HEARTBEAT_URL`, a PostgREST endpoint)
with the current time. A scheduled GitHub Action runs off the machine and reads
that row. If the row is older than 40 minutes, the Action sends an email. A
frozen or powered-off Mac cannot report its own failure, so this check has to
run somewhere else. See `.github/workflows/deadman.example.yml`.

### Self-heal

After the alerts, the same poll:

- runs disk remediation when the disk card is amber or red, at most once per
  24h, and reports how much space it freed;
- runs `heal-cmux` if the `cmux:bridge` card shows a lost socket password;
- once the socket answers, runs `heal-restore` for workspaces that match the
  exact failed-restore signature. It never touches a pane that shows a live
  agent UI.

### Mesh reconcile and delivery

In the same poll, the mesh:

- **reconciles** the directory against `cmux workspace list`. Renamed
  workspaces keep their history, new ones are registered with
  `needsOwnership`, and closed ones are marked `closed`. The reconciler never
  runs on an empty or failed listing;
- **drains the outbox.** Queued messages are typed only into panes that are
  READY (idle input, no dialog, no half-typed draft). A message expires after
  24h;
- optionally **paints cmux chrome** (color, description, task pill, context
  progress) when `config/mesh.json` has `chrome: true`.

See [AGENT-MESH.md](AGENT-MESH.md) and [MISSION-CONTROL.md](MISSION-CONTROL.md).

## File layout

```
server.mjs              entry point (LaunchAgent runs this)
src/                    core modules (table above)
public/                 frontend
scripts/                CLIs; scripts/env.sh finds Node (nvm pin → newest nvm → Homebrew)
system/                 *.tmpl LaunchAgents + cmux config, Dock/sidebar (install: docs/INSTALL.md)
examples/               generic config twins: config/{jobs.mjs,agents.json,mesh.json,
                        models.json,TRIAGE.md,zulu.env}, POLICY.md, MISSION-CONTROL.md
overlay/                YOUR config (gitignored in the public repo); same paths as examples/
data/                   runtime state, gitignored: secrets.env, tasks/, events.json,
                        history.json, alert-state.json, mesh-outbox.json, handoffs/,
                        cmux-socket-password, mesh-decision-token
publish/                manifest.json (every tracked file classified public/private)
test/                   node:test suites
```

Config resolves `overlay/<rel>` first, then `<rel>` in core, then
`examples/<rel>` (`src/config.mjs` `resolve`). Import the registry from
`src/config.mjs`, never from `config/jobs.mjs` directly. The only config file
the board writes is the mesh directory. It is always written to `overlay/` and
seeded from `examples/` on first use.

## Trust boundaries

- **Network.** The server binds `0.0.0.0` and rejects every request that is not
  from localhost or the Tailscale CGNAT range (`100.64.0.0/10`), so LAN clients
  get `403`. `POST /api/event`, `/api/mesh/send` and `/api/mesh/outbox/drop`
  are stricter and accept localhost only.
- **Read-only by design.** The board only reads what it watches. It writes its
  own `data/`, cmux notifications and chrome, the heartbeat row, and the
  results of opt-in actions: KICKSTART (launchd), RESTART (docker), START
  (processes with a `startCmd`), DISPATCH CLAUDE and ASK MASTER. Action labels
  are validated against the registry. It never edits a crontab or a plist.
- **Approvals.** The ledger's `decide` operation requires a per-install
  decision token (`data/mesh-decision-token`) that is injected into the board
  page. It is a speed bump plus an audit line, not a security boundary against
  processes running as the same user. Agents are told never to call it.
- **Agents.** Everything an agent reads from panes, reports, tasks or `[mesh]`
  lines is treated as data, not instructions. `POLICY.md` is the only approval
  authority, and anything paid, outward-facing or destructive always goes to
  the owner.
- **Secrets.** Secrets live only in `data/secrets.env` (mode 600, gitignored,
  re-read when it changes). The ledger refuses text that looks like a
  credential.
- **cmux.** cmux is a separate app. The board uses only its CLI and its
  password-protected socket, and keeps its own copy of the password in
  `data/cmux-socket-password`.

## Demo mode

`./install.sh --demo` starts the board with `MC_DEMO=1`: synthetic cards,
sessions and tasks, with no launchd install and no cmux calls. Use it to try
the UI or to work on the frontend. See [INSTALL.md](INSTALL.md).
