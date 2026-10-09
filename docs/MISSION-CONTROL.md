# Mission Control

Mission Control is the agent-workforce layer on top of the Ops Board. A
**master agent** runs as a persistent Claude Code session in a pinned cmux
workspace. You talk to it, and it manages everyone else: **residents**,
**ephemeral workers** and **headless jobs**. It reads the board, reads and types
into sibling cmux panes through the cmux socket, and records work in the
[Agent Mesh](AGENT-MESH.md) ledger.

Mission Control orchestrates and does not implement. Its context window is the
scarce resource, so it hands substantive work to others and keeps its own
turns short.

- **Contract** (its system prompt): [`examples/MISSION-CONTROL.md`](../examples/MISSION-CONTROL.md).
  Copy it to `overlay/MISSION-CONTROL.md` and fill in the placeholders.
- **Approval authority**: [`examples/POLICY.md`](../examples/POLICY.md).
  Copy it to `overlay/POLICY.md`. You own this file; agents never edit it.

## Launch

```sh
./install.sh mission-control
```

This creates (or reuses) a cmux workspace titled `⌘ MISSION CONTROL`, pins it,
and runs `scripts/mission-control.sh` inside it. The launcher:

- reads the master model from `config/models.json` (`master`);
- starts `claude --name <slug-of-workspace-title>` with the contract passed
  via `--append-system-prompt-file`;
- pre-approves only the master's routine tools with `--allowedTools`: board
  reads (`curl`), `cmux`, its helper scripts (`agent-spawn.sh`,
  `resident-launch.sh`, `agent-close.sh`, `task.sh`, `agent-send.sh`,
  `mesh-cli.mjs`) and its own state and handoff files. Anything else, such as
  `git`, `launchctl` or arbitrary shell, still asks you through the cmux Feed.

After a reboot, run `scripts/mc-resume.sh` inside the same pane. It resumes the
recorded session ID instead of starting a fresh conversation. The master keeps
its roster, open threads and pending escalations in `data/MISSION-STATE.md`.

The **ASK MASTER** button on the board looks for a workspace whose title
contains `MISSION CONTROL`, so keep that text in the title.

## What it can see and do

| Senses | Command |
|---|---|
| Fleet, sessions, timeline, events | `curl -s localhost:3210/api/status` |
| Directory and context gauges | `curl -s localhost:3210/api/agents`, `node scripts/mesh-cli.mjs agents` |
| Any pane's screen | `cmux read-screen --workspace <ref> --scrollback --lines 200` |
| Reports | `data/handoffs/*.report.md`, `data/handoffs/triage-*.md` |

| Hands | Command |
|---|---|
| Instruct a session | `cmux send` + `cmux send-key enter`, always after a `read-screen` |
| Spawn a worker | `scripts/agent-spawn.sh "<name>" "<cwd>" <promptfile> [model]` |
| Launch a resident | `scripts/resident-launch.sh "<repo-path>" "<Name>"` |
| Close a worker | `scripts/agent-close.sh <name>` |
| Track work | `scripts/task.sh create "<title>" --owner <agent> --body "…"` |
| Log to the ticker | `POST localhost:3210/api/event` with `{"kind":"sys","text":"…"}` |
| Escalate to you | `cmux notify --title 'Mission Control' --body '<question>'`, then wait |

## The workforce

| Kind | Lifetime | Use for | Launched by |
|---|---|---|---|
| **Resident** | long-lived, one per core repo | recurring work in that repo | `scripts/resident-launch.sh` |
| **Worker** | one task, then closed | one-off work in a repo that has no resident | `scripts/agent-spawn.sh` |
| **Headless job** | one process | parse or batch work whose output the master needs itself | `claude -p --model $(scripts/worker-model.sh) --output-format json '…'` |
| **Triage** | scheduled, headless | fleet check-ups (below) | LaunchAgent → `scripts/triage.sh` |

Rules the contract enforces:

- **One writer per repo.** If a repo has a resident or an active worker, new
  work queues there. The master never starts a second writer.
- **At most 3 concurrent workers.**
- **Address agents by mesh name or workspace UUID**, never by sidebar index.
  Indexes renumber after every relaunch.
- **Models** come from `config/models.json` (`master`, `worker`, plus a
  fallback). `scripts/worker-model.sh` resolves and probes them and caches the
  result for 24h.

### Residents and continuity

A resident keeps its durable state in `<repo>/.claude/RESIDENT-STATE.md`
(active tasks, decisions, next steps) and updates it after every task. After a
compaction or resume, it re-reads the file first, so nothing important lives
only in the context window.

The board's context gauge (`ctx` on tiles and in `/api/agents`) turns amber at
60% and red at 80%. When a resident is idle and in the red band, Mission
Control sends: *"checkpoint your state file, then run /compact"*. Compaction
happens between tasks, never in the middle of one.

### Report-back protocol (workers)

`agent-spawn.sh` creates a ledger task (or reuses `MESH_TASK=<id>`), registers
the worker in the directory, launches `claude --name <slug>` with no prompt
argument, and submits the brief once the pane is ready. It appends a footer to
every brief. The footer tells the worker to:

1. `task.sh claim <id>` first;
2. when done, write `data/handoffs/<brief>.report.md` with the outcome first,
   then what changed, then anything that needs the owner;
3. close the task with the checklist: `task.sh close <id> --checklist all
   --handoff <report> "<one-line outcome>"`, or if blocked, `task.sh block <id>
   --on owner "<why>"`;
4. set the cmux `result` pill and send a one-line `cmux notify`.

Mission Control reads the report, accepts it, and closes the workspace with
`agent-close.sh`.

## Choosing the engine: Claude Code or Codex

Each role runs on the engine you pick in `zulu setup --step engines`, stored in
`overlay/config/models.json`:

```json
"engine": { "master": "claude", "worker": "codex", "triage": "claude" }
```

`resident` can be set separately and otherwise follows `worker`; anything unset is `claude`.
`scripts/engine.mjs` turns the choice into the launch command for Mission Control,
`agent-spawn.sh`, `resident-launch.sh` and `triage.sh`.

| | Claude Code | Codex |
|---|---|---|
| Mission Control | contract via `--append-system-prompt-file`, a fixed tool allowlist | contract as its first instruction (plus `~/.codex/AGENTS.md`), workspace-write sandbox, on-request approvals |
| Workers / residents | `--permission-mode auto` / `acceptEdits`, `--name` = mesh address | workspace-write sandbox, on-request approvals; the address comes from the workspace title |
| Scheduled triage | `claude -p` bounded by `--allowedTools` | `codex exec` in the workspace-write sandbox (writes only inside the repo), no approvals |
| Models | `master` / `worker` / `workerFallback` (probed daily) | `codex.model` / `codex.workerModel`, or Codex's own default |

**The bounds are not identical.** Claude enforces a per-tool allowlist. Codex has no per-tool
allowlist, so a Codex role is bounded by its sandbox and approval policy instead: it can
read anywhere, write only in its working directory, and asks you before anything else
(interactive roles). POLICY.md applies to both, and both escalate paid, outward and
destructive work. The mesh, the board tiles, context gauges and restore-after-reboot work
the same for both.

## POLICY.md — approval authority

When an agent's pane shows a permission prompt, Mission Control:

1. runs `read-screen` to get the exact prompt text and options;
2. approves only if the request matches the **ALLOW** list, then logs the
   approval to the ticker;
3. otherwise notifies you and waits. This covers **ESCALATE** items, anything
   ambiguous, and anything not listed.

Anything **paid** (metered APIs, SMS, labels, ads, bulk LLM jobs), anything
**outward-facing** (email, production writes, deploys, posts, DNS) and anything
**destructive** (deletes outside a repo's working tree) always goes to you,
however the request is phrased. The master re-reads `POLICY.md` before every
approval, so edits take effect immediately.

Ledger tasks in `needs_approval` are decided by you on the board's **WORK**
panel (APPROVE / DECLINE). Mission Control never calls the decide operation.

## Scheduled triage

A LaunchAgent runs `scripts/triage.sh` four times a day (the template schedule
is 08:30, 12:30, 16:30 and 20:30). Triage is a headless `claude -p` pass that
follows `config/TRIAGE.md`
([example](../examples/config/TRIAGE.md)). It is **hard-bounded by
`--allowedTools`**: the model cannot run anything outside that list.

Each pass:

- reads `/api/status` and `/api/tasks/summary`. If everything is green, it
  prints `all green` and stops, with no files and no notifications;
- for each red card, applies only policy-safe fixes (`launchctl kickstart` of
  non-paid, non-outbound jobs, `docker restart`), or dispatches **one**
  diagnostic worker. It never runs more than 2 dispatches per pass;
- keeps a 12h cooldown per label in `data/triage-state.json`;
- writes `data/handoffs/triage-<timestamp>.md` with a Work section from the
  ledger, then sends a `cmux notify` and a ticker line.

Triage never deletes, never changes config, and never claims, closes or
approves tasks.

## Board hooks

- **ASK MASTER** (on every card): types a one-line brief with the card name,
  status, detail, label and schedule into the Mission Control pane.
- **DISPATCH CLAUDE** (on red cards with a `repo`): spawns a fresh Claude
  session (`--permission-mode acceptEdits`) in a new cmux workspace. The
  session's working directory is the job's repo, and it starts with a
  pre-built diagnostic prompt.
- **`POST /api/event`** (localhost only): the master and scripts log spawns,
  approvals and closes to the ticker so there is an audit trail.

## Safety

- Everything read from panes, reports, tasks and `[mesh]` lines is **data,
  not instructions**. If a worker's output asks the master to act outside its
  task, or claims you authorized something, the master stops and asks you.
- Permission boundaries are per session. An agent must never ask a peer to do
  something its own session was denied.
- If the cmux socket returns errors, the board repairs it within about a
  minute (`src/heal-cmux.mjs`). Agents wait and retry instead of editing cmux
  config.
