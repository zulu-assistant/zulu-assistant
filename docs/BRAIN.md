# The brain: three memories

Agents forget. A session ends, a context window compacts, a Mac is replaced. Zulu Assistant keeps a
fleet of agents cumulative rather than amnesiac with three memories, each with a different scope,
plus a continuity protocol that ties them to long-lived sessions.

| Memory | Holds | Scope | Lives in |
|---|---|---|---|
| **Obsidian vault** | org memory: what each project is, its current state, what can be reused, what must not be stepped on | all projects, all machines | a git-backed vault (`$VAULT`) |
| **Graphify** | code memory: the structure of each repo | one repo | `<repo>/graphify-out/` (local) |
| **Claude memory** | agent memory: facts and preferences an agent learned | one project, one machine | `~/.claude/projects/<project>/memory/` |

The brain is optional: the board runs without it. It is what makes a multi-agent setup improve over
weeks instead of re-learning the same things every session.

## 1. Obsidian vault — org memory

One Markdown vault documents every project you run agents on. It survives any individual chat,
and it is where an agent looks before building something that already exists.

**Conventions** live in the vault's own `Vault Guide.md` (template:
`examples/vault/Vault Guide.md`):

- **one folder per project**, with **one overview note** named after the project that links every
  child note with `[[wikilinks]]`;
- frontmatter on every note (`project`, `type`, `source`, `tags`, `date`); overview notes also carry
  `status` and **`last-synced: YYYY-MM-DD`**, bumped on every sync;
- a note describes the **current** state. When state changes, status notes get a dated
  **`## Update — YYYY-MM-DD`** section appended rather than history rewritten;
- **`Home.md`** is the index: one 1–2 sentence entry per project plus a "How these connect"
  section for cross-project relationships;
- **`Capabilities.md`** catalogs reusable building blocks (by capability, not by project) and the
  **shared-resource constraints** list — shared databases, shared sender identities, single-writer
  contracts. Agents read it before designing anything new, and add to it when a project ships
  something reusable.

**The contract** that makes agents use it is two rules in `~/.claude/CLAUDE.md` and each repo's
`CLAUDE.md` (template: `examples/claude/CLAUDE.md.tmpl`):

- *read side* — before a new project or subsystem, read `Home.md` and `Capabilities.md`;
- *write side* — after substantive work, sync the project's notes and bump `last-synced`.

The `sync-obsidian` skill (`examples/claude/skills/sync-obsidian/SKILL.md`) is the one-command
version of the write side; it always defers to the live `Vault Guide.md`.

**Automation** (scripts in `examples/vault/.scripts/`, plist templates in
`examples/vault/.scripts/launchd/`):

| Job | Schedule | Does |
|---|---|---|
| `vault-backup.sh` (`<prefix>.obsidian-backup`) | every 30 min + at load | commit, rebase, push the vault; mirror selfheal markers into `.scripts/state-mirror/` |
| `vault-staleness-check.sh` (`<prefix>.obsidian-staleness`) | Mondays 08:00 + at load (skips if run < 6 days ago) | writes `Staleness Report.md`: projects whose source has activity > 3 days newer than their `last-synced` |
| `selfheal-runner.sh` | wraps other scheduled jobs | run iff the last *successful* run is older than the latest scheduled slot, so missed slots after sleep or power-off are caught up exactly once |

**Selfheal markers are state, not cache.** The runner stores each job's last success as an epoch in
`~/Library/Application Support/selfheal-runner/<label>.last` (legacy `~/.cache/selfheal-runner/` is
still read; the newest of all copies wins). The backup job mirrors the markers and the runner log
into the vault's `.scripts/state-mirror/`, copy-only and never deleting, so a disk cleaner that wipes
them cannot trigger a catch-up storm of every job at once. Restore steps are in
`examples/vault/.scripts/state-mirror/README.md`. Never fabricate markers.

To set up a vault from scratch, follow `examples/vault/Obsidian-Vault-Replication-Spec.md`.

## 2. Graphify — code memory

[Graphify](https://pypi.org/project/graphifyy/) is a **third-party** tool that turns a repo into a
knowledge graph (god nodes, communities, cross-file relationships). Zulu Assistant never bundles
it; install it yourself:

```bash
uv tool install graphifyy==0.9.83
```

Per repo:

- `graphify update .` builds `graphify-out/` (graph, report, optional wiki) with AST extraction
  only — no API cost. Run it **after every code change**; `graphify hook install` adds git hooks
  that rebuild after each commit and checkout.
- `graphify-out/` is per-machine and **never committed** (it is in `.gitignore`).
- Agents run **`graphify query "<question>"` before grepping**, `graphify path "<A>" "<B>"` for
  relationships and `graphify explain "<concept>"` for one concept. A scoped subgraph is usually
  far smaller than raw grep output or the full report.

Two things enforce "graphify first":

1. **Hook guards** in `.claude/settings.json` (template: `examples/claude/settings.json`). A
   `PreToolUse` hook runs `graphify hook-guard search` before shell searches and
   `graphify hook-guard read` before `Read`/`Glob`. When `graphify-out/graph.json` exists, the
   guard injects a reminder to query the graph first; otherwise it is silent. It never blocks a
   tool call.
2. **The rules block** at the bottom of each repo's `CLAUDE.md` says the same thing in words.

## 3. Claude memory — agent memory

Claude Code keeps per-project memory in `~/.claude/projects/<project>/memory/`:

- **one fact per file**, with frontmatter `name`, `description` and `metadata.type`, one of
  `user` (who you are, how you work), `feedback` (corrections to agent behaviour), `project`
  (decisions and state) or `reference` (where things are);
- **`MEMORY.md`**, an index with one line per memory: `- [Title](file.md) — one-line hook`.

Details and an example: `examples/claude/memory/README.md`. Memory is per machine; copy
`~/.claude/projects/*/memory/` when you move to a new Mac.

Rule of thumb for what goes where: a durable *project* fact that other agents or projects need
belongs in the vault; a preference or correction for *this* agent in *this* project belongs in
memory; anything derivable from the code belongs in neither — Graphify has it.

## 4. Continuity — surviving compaction and restarts

Long-lived sessions (residents, Mission Control) also keep a **state file** they own:

| File | Owner | Template |
|---|---|---|
| `<repo>/.claude/RESIDENT-STATE.md` | the resident agent for that repo | `examples/claude/RESIDENT-STATE.md.tmpl` |
| `data/MISSION-STATE.md` | Mission Control | `examples/claude/MISSION-STATE.md.tmpl` |

The protocol:

1. **Update the state file after every completed task** — live state, active tasks, open
   decisions, gotchas learned.
2. **Re-read it first** after any compaction, resume or reboot, then `CLAUDE.md` and
   `AGENT-MESH.md`.
3. **Safe compaction**: when the board's context gauge shows the session getting full
   (`ctx n%`, amber ≥ 60 %, red ≥ 80 %), the agent checkpoints its state file *first*, then runs
   `/compact` while idle. Right after a compaction the gauge shows an estimate marked `est` until
   the next turn reports real usage.

A compaction summary is lossy; the state file is not. The order — checkpoint, then compact — is the
whole trick.

## 5. Wiring it up: `./install.sh --brain`

```bash
./install.sh --brain
```

It:

1. installs the example skills `sync-obsidian` and `graphify` into `~/.claude/skills/` — only where
   a skill of that name is absent;
2. backs up `~/.claude/settings.json`, then merges in the graphify hook-guard hooks (existing hooks
   are kept);
3. **prints** the Graphify install line, `uv tool install graphifyy==0.9.83`, for you to run.
   Graphify is third-party and is never installed silently.

Then, by hand:

1. Create your vault from `examples/vault/` (copy it to `$VAULT`, set `VAULT` in
   `overlay/config/zulu.env`), `git init` it and connect a **private** remote.
2. Fill the project table in `.scripts/vault-staleness-check.sh`.
3. Render and load the two vault LaunchAgents:
   ```bash
   P=com.zulu-assistant    # your MC_LABEL_PREFIX
   scripts/render-tmpl.sh "$VAULT/.scripts/launchd/vault-backup.plist.tmpl"    "$VAULT/.scripts/$P.obsidian-backup.plist"
   scripts/render-tmpl.sh "$VAULT/.scripts/launchd/vault-staleness.plist.tmpl" "$VAULT/.scripts/$P.obsidian-staleness.plist"
   ./install.sh           # bootstrap installs and loads both plists
   ```
4. Add the vault and graphify blocks from `examples/claude/CLAUDE.md.tmpl` to each repo's
   `CLAUDE.md`, and the vault read/write rules to `~/.claude/CLAUDE.md`.
5. In each repo: `graphify update .` and `graphify hook install`.

`./install.sh check` reports the vault, markers, vault LaunchAgents, Graphify version, skills and
hook guards.
