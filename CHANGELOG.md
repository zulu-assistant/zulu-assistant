# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/zulu-assistant/zulu-assistant/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.1
