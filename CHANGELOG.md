# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0-beta.4] - 2026-10-31

### Added
- **Release-drift watch** (`SETTINGS.releaseDrift`, off in `examples/`) for maintainers who publish a public edition with `scripts/publish.mjs`. A card, a digest line and one ledger ask appear when public files have sat committed but unreleased for more than `amberDays`.

### Fixed
- **Slack intake stays connected.** After a routine Slack disconnect whose socket never finished closing, the intake could sit silent for days with a green card. It now reconnects at once, replaces stuck sockets every 30 s, and exits for the service manager to restart it if no hello arrives for 15 min. Every 5 min it reads each request channel's history from a saved cursor to file anything the socket missed (`--sweep --since <ISO|12h|2d> [--apply]` for an older window). Posting back retries 3 times. With `linkStatus` on its JOBS entry the card judges the link, not only the process. `--check` never writes the running service's status. Socket closes are logged with their code, and a good reconnect clears the last error. See docs/CHAT-INTAKE.md "Staying connected".

### Changed
- docs/CMUX-SETUP.md: tested on cmux 0.65.2; the NODE_OPTIONS-helper quirk applies to 0.64.x–0.65.0 only.
- README: the commercial-support line links its site, and the still screenshot is gone (the animated cmux demo shows the same view).

## [0.1.0-beta.3] - 2026-10-28

### Added
- **Team chat intake (Slack), optional.** Teammates who never open a terminal post requests in a Slack
  channel. Each one becomes one ledger task routed through Mission Control, which picks the owner agent
  and holds every approval. The agents' questions are posted in the request's thread (`task.sh block N
  --on <person>`), and a reply there unblocks the task. Status lines and the final result come back to
  the same thread.
  - Socket Mode only: nothing is exposed to the internet.
  - Approvals, publishes and credentials never come from chat. Slack text is quoted data, and
    attachments are saved as untrusted files.
  - `"planFirst": true` on a person makes their requests planning-only until the owner reviews the plan
    on the board.
  - `task.sh chat-file` posts an agent-made file (a calendar `.ics`, a PDF) back into the thread.
  - Setup is the new optional step [docs/INSTALL.md §3c](docs/INSTALL.md#3c-optional-team-chat-intake-slack).
    It uses a ready app manifest (`examples/slack/app-manifest.json`), plus `examples/config/principals.json`
    and `channels.json`. Behaviour: [docs/CHAT-INTAKE.md](docs/CHAT-INTAKE.md).
- **Brain autopilot** (`SETTINGS.brain`, off in `examples/`). Stale vault notes become one owned,
  low-priority ledger task per project. Graphify rebuild failures and out-of-date graphs show on one
  amber `brain:autopilot` card; docs-only commits never count. The close checklist *verifies*
  `vault_synced` and `graphify_updated` instead of trusting the tick (waive with `--no-vault` /
  `--no-graph "<reason>"`). See [docs/BRAIN.md §6](docs/BRAIN.md).
- **Database-view cards** (`SETTINGS.viewWatch`, off in `examples/`): one row of a PostgREST view on a
  board card, with column limits and timestamp ages. Read-only, with the dead-man's project URL and key;
  amber only, never on the escalation ladder.
- JOBS entries take `log:` when a LaunchAgent's StandardOutPath isn't its real log.
- **Install report** issue form. When an install or demo fails (or a step warns), the installer prints
  where to send it, together with `./install.sh doctor` (a redacted file; nothing is uploaded).

### Changed
- The one star question now comes as soon as the board first answers during install, instead of after
  the whole setup. It is still asked once, defaults to No, and needs your own `gh` login.
- The vault staleness check skips `Checkpoint …` commits and also writes `staleness.json` for the board.
  `FORCE=1` runs it now.

## [0.1.0-beta.2] - 2026-10-12

### Added
- **cmux demo**: `./install.sh --demo --cmux` opens a separate "ZULU DEMO" cmux window with six scripted
  agent panes (one asks for permission, one climbs into amber context, one is blocked, one is Codex, two
  are quiet) next to the demo board, so the phosphor sidebar's ATTENTION view and the Dock can be seen
  without a real fleet. Every cmux write is filtered to the demo's own workspaces; `demo-stop` tears it
  down. New media in `docs/media/` (`cmux-demo.gif`, `two-part-console.png`, `cmux-attention.png`).
- GitHub repo stats on the board (`SETTINGS.repoStats`): stars, forks, watchers, clones and views as
  cards and a digest section, with history kept beyond GitHub's 14-day window (`data/repo-stats.json`).

### Fixed
- Workspace listings span every cmux window (`src/cmux-windows.mjs`); a board running outside cmux no
  longer sees only the front window, which could have marked the whole fleet closed. A failed listing is
  treated as no listing, never as closures. Demo workspaces never join the mesh.
- `agent-close.sh` passes `--force` (cmux 0.65 requires it for a workspace with a live process).

## [0.1.0-beta.1] - 2026-10-09

First public release.

### Added

**One-command install and guided setup**
- `get.sh` one-liner (uses `gh` when available), and `scripts/prereqs.sh`, which installs
  only the missing toolchain after one confirmation.
- `zulu setup`, a resumable wizard with live checks: GitHub, engines, owner and policy, a scan of
  this Mac for what to watch, alerts, an Obsidian vault from the template, Graphify and memory,
  macOS permissions, residents, verify. The board shows a setup card until it is done.
- Claude Code or Codex per role (Mission Control, workers, residents, triage): `scripts/engine.mjs`.
- `zulu doctor`: a redacted diagnostic file for bug reports (never uploaded).
- `overlay/config/local.json`: setup answers merged into the registry; `example: true`
  placeholders drop out once real items are chosen.

**Ops Board**
- Zero-dependency Node ≥ 22 server on port 3210, with a 60s poll, SSE push to
  the browser, and `/api/status` for scripts and agents.
- Watches launchd jobs (schedule, logs and selfheal markers auto-discovered
  from the plist; `quietOk` watchdogs judged by exit code), docker
  containers, HTTP endpoints, a disk gauge, a memory/swap gauge, bare
  processes, and user crontab lines (with a zero-dependency cron parser and a
  drift check against `crontab -l`).
- Agent session tiles for Claude Code and Codex sessions in cmux: running,
  idle or needs input, the last message, and a context-window gauge (amber
  ≥ 60%, red ≥ 80%, estimated after a compaction).
- Phosphor UI: rack-module cards, a 24h ops timeline, an event ticker, a
  `?tv` kiosk mode, a `?dock=1` compact view, a `/` command palette, CVD-safe
  status chips (glyph plus label), and `prefers-reduced-motion` support.
- Opt-in actions: KICKSTART (launchd), RESTART (docker), START (processes),
  DISPATCH CLAUDE (a diagnostic session in a new cmux workspace), ASK MASTER.
- Source guard: localhost and Tailscale CGNAT only; the LAN gets 403.

**Alerting and self-protection**
- Escalation ladder: cmux notification → email after 30 red minutes → SMS
  webhook for the critical set → 08:00 daily digest. Alerts are deduped and
  re-sent every 6h while a card stays red.
- Dead-man's switch: a heartbeat row is updated every poll, and an example
  GitHub Actions workflow emails when it goes silent.
- Disk auto-remediation mechanism with a 24h cooldown (ships with an empty
  lever list).
- cmux socket-password self-heal and a retry for failed session restores
  after a reboot.

**Agent workforce**
- Mission Control: a master agent in a pinned cmux workspace, with a contract
  template, `POLICY.md` approval authority, residents with
  `RESIDENT-STATE.md` continuity, ephemeral workers with a report-back
  protocol, and scheduled headless triage bounded by `--allowedTools`.
- Agent Mesh: a directory keyed by cmux workspace (addresses follow renames),
  a task ledger with a checklist-gated close and refusal of secret-like text,
  owner approvals on the board's WORK panel behind a decision token, and
  delivery only into READY panes with a 24h outbox.
- Optional cmux chrome: workspace colors per domain, descriptions, task pills,
  and context progress. Values you set by hand always win.
- cmux Dock and a phosphor custom sidebar (installer with backup and revert).

**Setup and publishing**
- `install.sh` with `--demo` mode (synthetic data; no launchd or cmux).
- `install.sh init | --brain | mission-control | star | demo-stop`, and a `bin/zulu`
  wrapper.
- Demo mode (`MC_DEMO=1`): a scripted incident loop, plus agents and a ledger, for
  trying the board and recording it. It keeps its own ledger, ticker and toast
  state, so it never touches a real board's `data/`.
- A configurable ledger close checklist (`SETTINGS.ledger.checklist`; the default is
  docs + report).
- Consent-first star surface: the installer asks once (default No, your own `gh`
  login), and the board shows one toast (Star opens the repo page; Never ask again).
  A "share your setup" button renders a redacted PNG locally for download.
- Overlay config (`overlay/` → core → `examples/`) and secrets in
  `data/secrets.env` only.
- `scripts/bootstrap.sh check | install | verify`, and LaunchAgent and cmux
  templates rendered without hard-coded paths.
- Publish manifest (checked locally with `scripts/publish.mjs --check`), and the scrub gate
  and gitleaks in CI.

[Unreleased]: https://github.com/zulu-assistant/zulu-assistant/compare/v0.1.0-beta.4...HEAD
[0.1.0-beta.4]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.1
