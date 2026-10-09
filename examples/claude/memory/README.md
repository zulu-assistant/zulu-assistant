# Claude memory — agent memory convention

Claude Code keeps per-project memory in `~/.claude/projects/<project>/memory/`, where `<project>`
is the project's absolute path with `/` replaced by `-`. It is loaded into every session in that
project. Zulu Assistant uses one convention for it across the fleet.

## Layout

```
~/.claude/projects/<project>/memory/
├─ MEMORY.md                  # the index — one line per memory
├─ deploy-needs-approval.md   # one fact per file
├─ prefers-small-prs.md
└─ …
```

## One fact per file

Each memory is a short Markdown file with frontmatter:

```markdown
---
name: deploy-needs-approval
description: "Production deploys of this service always go through an owner approval task, even hotfixes"
metadata:
  type: feedback
---

The owner corrected an agent that deployed a hotfix directly (YYYY-MM-DD). Deploys are an
outward action under POLICY.md: open a ledger task with `approve-request` and wait.

**How to apply:** before any `deploy`/`publish` command in this repo, check for an approved task.
```

| Field | Rule |
|---|---|
| `name` | kebab-case slug, same as the filename without `.md` |
| `description` | one sentence that stands alone — it is what the index and search show |
| `metadata.type` | one of the four types below |

| `metadata.type` | Holds | Example |
|---|---|---|
| `user` | who the owner is and how they like to work | "prefers terse status updates, no emojis" |
| `feedback` | corrections to agent behaviour — the highest-value kind | "never force-push shared branches" |
| `project` | decisions and durable project state | "chose SQLite over Postgres for the local cache (YYYY-MM-DD)" |
| `reference` | where things are | "staging credentials live in the team password manager, entry X" |

The body: the fact, when and why it was learned, and a **How to apply** line. Link related
memories as `[[other-memory-name]]`.

## The index: MEMORY.md

One line per memory, newest or most important first:

```markdown
- [Deploys need approval](deploy-needs-approval.md) — prod deploys always go through an approval task
- [Small PRs](prefers-small-prs.md) — owner reviews faster when PRs stay under ~300 lines
```

Keep the index short enough to read at a glance. When a memory stops being true, delete the file
and its index line rather than leaving a contradiction.

## What goes where

| Kind of knowledge | Home |
|---|---|
| A preference or correction for agents in this project | Claude memory (`feedback`, `user`) |
| Durable project state other agents or projects need | the Obsidian vault project note |
| Reusable capability or shared-resource constraint | vault `Capabilities.md` |
| Structure of the code | Graphify (`graphify-out/`), never memory |
| In-flight work of a long-lived agent | its state file (`RESIDENT-STATE.md` / `MISSION-STATE.md`) |

Never store secrets, tokens or personal data in memory files.

## Moving to a new Mac

Memory is per machine. Copy `~/.claude/projects/*/memory/` from the old Mac to keep what agents
learned. If a project lives at a different path on the new Mac, rename its `<project>` folder to
match.
