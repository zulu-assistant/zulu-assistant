---
type: guide
tags: [meta, guide, conventions]
---

# Vault Guide — for humans and AI agents

This vault is <OWNER>'s **centralized cross-project documentation & memory layer**. Each project
(code repos, web apps, analytics, ops — any app) is mirrored here as notes, so there is one durable
place that survives any individual chat or agent session.

**If you are an AI agent working on one of these projects: read this note, then keep the matching
vault notes in sync with the live state of your work. Create any folders or notes you need
yourself — the owner should never have to pre-create them.**

## When to sync (the trigger)
Sync at the end of any substantive piece of work that changes a project's state — new features,
executed changes (things that went live), new deliverables, architecture decisions, or status
changes. Routine Q&A or throwaway exploration does **not** need a note.

The cardinal rule: **a note must describe the *current* state, not a stale pre-execution plan.**
If work moved something from "planned" to "live", update the note (or append a dated update
section) rather than leaving the old version standing.

## Structure
- **One folder per project**, named after the project.
- Each project folder has **one overview note** (a map of content) named after the project. It
  summarizes the project and links every child note with `[[wikilinks]]`.
- **Child notes** sit under the project folder (optionally in subfolders such as `Services/` for
  per-module docs, or as per-deliverable notes). One note = one coherent topic.
- **`Home.md`** is the vault index: it links every project overview note and has a
  "How these connect" section for cross-project relationships. **Keep Home.md blurbs to 1–2
  sentences** — status detail belongs in the project's own overview note.
- **`Projects.base`** (optional, Obsidian Bases) is a live dashboard over the overview notes'
  `status` / `last-synced` frontmatter.
- **`Capabilities.md`** catalogs reusable building blocks across projects plus the
  shared-resource constraints list. **Consult it (and Home.md) before designing anything new; add
  an entry whenever a project ships a reusable capability.**
- Link **liberally** with `[[wikilinks]]`, within a project and across projects.

## Frontmatter (top of every note)
```yaml
---
project: <Project Name>        # omit on Home/guide
type: overview | service-doc | progress-audit | data-log | produced-asset | reference | guide | index
source: <file(s) or system the note documents>   # optional but encouraged
tags: [<project-slug>, <type-ish>]
date: YYYY-MM-DD               # for dated notes (audits, snapshots)
status: live | active | paused # overview notes only
last-synced: YYYY-MM-DD        # overview notes only — bump on EVERY sync (the staleness check reads it)
---
```

## Onboarding a NEW project (agent checklist)
1. Create `/<Project Name>/` in the vault.
2. Create `/<Project Name>/<Project Name>.md` as the overview note (purpose, source path, stack,
   an index table of child notes, key decisions), with `status:` and `last-synced:`.
3. Add child notes for the meaningful parts (per service/module, or per deliverable).
4. Add a one-line entry under `Home.md` → `## Projects`, and note any cross-project link.
5. Add the vault-sync block to the project's own `CLAUDE.md` so future sessions sync out AND read
   in (see the Zulu Assistant template `examples/claude/CLAUDE.md.tmpl`).
6. Add the project to the table in `.scripts/vault-staleness-check.sh` so the weekly staleness
   report covers it.

## Syncing an EXISTING project (agent checklist)
1. Update the relevant notes to current state (append dated `## Update — YYYY-MM-DD` sections to
   status notes).
2. Bump `last-synced:` (and `status:` if it changed) in the overview note.
3. Keep the Home.md blurb at 1–2 sentences.
4. If the work shipped a reusable capability or changed a shared resource, update [[Capabilities]].

## Templates

### Overview note
```markdown
---
project: <Name>
type: overview
tags: [<slug>, overview]
status: active
last-synced: YYYY-MM-DD
---
# <Name>
**Source folder:** `<path>` · **Stack:** <…> · **This map:** <YYYY-MM-DD>
<one-paragraph what-it-is>
## Index
| Note | Source | Role |
|---|---|---|
| [[child-note]] | `file` | <role> |
## Key decisions / context
- …
```

### Service / module note
```markdown
---
project: <Name>
type: service-doc
source: <file(s)>
tags: [<slug>, service]
---
# <Module>
**Source:** `<file>` · **Role:** <one line>
## Responsibility / Key functions / Data flow / Gotchas
…
## Sibling services: [[a]] · [[b]]
```

### Progress / status note
Keep the original assessment intact; when state changes, **append a dated
`## Update — YYYY-MM-DD` section** rather than rewriting history.

## Automation
- **Backup:** launchd `<prefix>.obsidian-backup` runs `.scripts/vault-backup.sh` every 30 min and
  at load — commits and pushes to the vault's private git remote, and mirrors selfheal scheduler
  markers into `.scripts/state-mirror/`. Missed cycles run on the next boot/login.
- **Staleness check:** launchd `<prefix>.obsidian-staleness` runs
  `.scripts/vault-staleness-check.sh` weekly (Mon 08:00) and at load (skipped if it ran < 6 days
  ago) — writes [[Staleness Report]].
- Logs: `~/Library/Logs/obsidian-backup.log`, `~/Library/Logs/obsidian-staleness.log`.

## Housekeeping
- Prefer updating an existing note over creating a near-duplicate.
- `.DS_Store` files aren't part of the system (gitignored).
- Never cite a scratch location (e.g. `~/Downloads`) as a file's location of record. Every artefact
  a note references must live inside the owning project repo, and the note cites that path.
