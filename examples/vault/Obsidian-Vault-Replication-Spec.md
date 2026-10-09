# Obsidian Cross-Project Vault — From-Scratch Setup Spec

> **Purpose.** A self-contained specification for standing up an Obsidian "cross-project
> documentation & memory" vault that works with Zulu Assistant: folder layout, note conventions,
> frontmatter schema, templates, self-healing automation (backup + staleness), and the agent
> integration rules. It contains no real projects; the vault fills itself as work happens.
> Hand this file to the agent or person doing the setup.
>
> **Why the conventions are fixed:** two vaults built from this spec can **merge cleanly later**
> (e.g. two people, or two machines, that later share one vault). That works when the
> *conventions* are identical (layout, frontmatter, templates, wikilink style, meta-note
> filenames) while the *infrastructure identifiers* are distinct (git repo, launchd label
> namespace, absolute paths). Same shape → notes slot together; distinct IDs → automations never
> collide. See §8.

---

## 0. Placeholders

Decide these once. The ★ ones must be unique per vault or two vaults running side by side collide.

| Token | Meaning | Example | |
|---|---|---|---|
| `<OWNER>` | short slug for identity | `alice` | ★ |
| `<VAULT_NAME>` | vault folder + git repo name | `Alice-Vault` | ★ |
| `$VAULT` | absolute path to the vault | `$HOME/<VAULT_NAME>` | per machine |
| `<GIT_REMOTE>` | **private** git remote for backups | `git@github.com:<OWNER>/<VAULT_NAME>.git` | ★ |
| `<prefix>` | launchd label prefix (`MC_LABEL_PREFIX` in Zulu Assistant's `zulu.env`) | `com.zulu-assistant` | ★ |

Keep **identical** across vaults (do not rename): the meta-note filenames `Home.md`,
`Vault Guide.md`, `Capabilities.md`, `Projects.base`, `Staleness Report.md`; the frontmatter field
names; the folder-per-project layout; the note templates.

> **Platform.** The reference is macOS (launchd, zsh, BSD `date`/`stat`). On Linux keep the logic
> and swap: launchd → systemd timers **with the same "run if the last success is older than the
> last slot" rule**; `stat -f %m` → `stat -c %Y`; `date -j -f FMT` → `date -d`;
> `date -v-1d` → `date -d yesterday`.

## 1. Mental model

One vault is the **centralized cross-project documentation & memory layer** for everything
`<OWNER>` works on. It exists so there is one durable place that survives any chat or agent
session. Two jobs keep it healthy, both **self-healing** — they recover cycles missed to sleep,
reboot or power-off instead of silently dropping them:

1. **Auto-backup** — commits and pushes the vault every 30 min and at boot/login.
2. **Staleness check** — weekly, compares each project's `last-synced` against real activity in
   its source folder and writes `Staleness Report.md`.

```
$VAULT/
├─ Home.md                 # index of every project + "How these connect"
├─ Vault Guide.md          # the conventions (structure, frontmatter, templates, checklists)
├─ Capabilities.md         # reusable building blocks + shared-resource constraints
├─ Projects.base           # optional Obsidian Bases dashboard over overview frontmatter
├─ Staleness Report.md     # auto-generated weekly
├─ <Project A>/
│   ├─ <Project A>.md      # overview note (map of content) — one per project
│   └─ <child note>.md     # per service/module or per deliverable
└─ .scripts/               # automation (backup, staleness, selfheal runner, plists, state-mirror)
```

## 2. Seed files (shipped in `examples/vault/`)

| File | Role |
|---|---|
| `Vault Guide.md` | the conventions — source of truth for agents; replace `<OWNER>` |
| `Home.md` | index skeleton: `## Projects`, `## How these connect`, `## Conventions` |
| `Capabilities.md` | reuse catalog skeleton, ending with `## Shared resources & constraints` |
| `.scripts/vault-backup.sh` | commit → `pull --rebase --autostash` → push; mirrors selfheal markers |
| `.scripts/vault-staleness-check.sh` | weekly staleness report; **fill its `TABLE`** |
| `.scripts/selfheal-runner.sh` | optional generic self-healing job runner (§5) |
| `.scripts/state-mirror/README.md` | what the mirror holds and how to restore it |
| `.scripts/launchd/*.plist.tmpl` | LaunchAgent templates (tokens `__HOME__ __VAULT__ __LABEL_PREFIX__`) |

Optional `Projects.base` (enable the **Bases** core plugin):

```yaml
filters:
  and:
    - type == "overview"
views:
  - type: table
    name: All projects
    order: [file.name, status, last-synced]
    sort:
      - property: last-synced
        direction: DESC
  - type: table
    name: Active
    filters:
      and:
        - status == "active"
    order: [file.name, last-synced]
```

Vault-root `.gitignore`:

```gitignore
.obsidian/workspace.json
.obsidian/workspace-mobile.json
.obsidian/cache
.trash/
.DS_Store
```

## 3. Automation design (keep it)

- **Backup:** `RunAtLoad` fires at every boot/login, so downtime is caught immediately. A push that
  failed offline stays committed locally and goes out on the next 30-min run. The script commits,
  rebases on the remote (`--autostash`, in case of edits from another machine), then pushes.
- **Staleness:** the weekly calendar fire coalesces on wake; if the Mac was off past Monday,
  `RunAtLoad` runs it at next boot. A marker (`~/.cache/obsidian-vault/staleness-last-run`) makes
  at-load runs a no-op when the last run was < 6 days ago. A project is **stale** when its source
  shows activity > 3 days newer than the overview's `last-synced`. Metadata-only changes
  (CLAUDE.md, AGENTS.md, README.md, .gitignore, lock files) don't count as activity.
- Logs: `~/Library/Logs/obsidian-backup.log` (last 2000 lines) and
  `~/Library/Logs/obsidian-staleness.log`.

## 4. First-time install

```bash
cp -R examples/vault "$VAULT" && cd "$VAULT"
git init && git branch -M main
git remote add origin <GIT_REMOTE>            # a PRIVATE repo
gh auth login && gh auth setup-git            # non-interactive push
chmod +x .scripts/*.sh
# set VAULT in Zulu Assistant's overlay/config/zulu.env, then from the Zulu Assistant checkout:
P=com.zulu-assistant
scripts/render-tmpl.sh "$VAULT/.scripts/launchd/vault-backup.plist.tmpl"    "$VAULT/.scripts/$P.obsidian-backup.plist"
scripts/render-tmpl.sh "$VAULT/.scripts/launchd/vault-staleness.plist.tmpl" "$VAULT/.scripts/$P.obsidian-staleness.plist"
./install.sh                                   # installs + loads both vault LaunchAgents
launchctl list | grep obsidian                 # exit-code column 0
git -C "$VAULT" log --oneline -3               # an "Auto-backup" commit proves the loop runs
```

Without Zulu Assistant: copy the rendered plists to `~/Library/LaunchAgents/` and
`launchctl bootstrap gui/$(id -u) <plist>`.

**Restore on a new Mac:** clone `<GIT_REMOTE>` to `$VAULT`, run the same render + install steps,
then restore selfheal markers from `.scripts/state-mirror/` (see its README) — only if the live
marker dir is empty.

## 5. Optional: `selfheal-runner.sh`

A generic self-healing runner for scheduled jobs *outside* the vault. Contract:
`selfheal-runner.sh <label> <slotspec> <command>`, called by a plist with **both**
`StartCalendarInterval` and `RunAtLoad`. Slotspecs: `daily:HH:MM[,HH:MM…]`, `weekly:W:HH:MM`,
`monthly:D:HH:MM`. It runs iff the last **successful** run is older than the latest scheduled slot;
a failed run leaves the marker alone, so it retries at the next slot or load.
`SELFHEAL_DRY=1` prints the decision without running.

Markers (`<label>.last`, epoch seconds) live in `~/Library/Application Support/selfheal-runner/`;
the legacy `~/.cache/selfheal-runner/` and the vault's `state-mirror/` are also read and the newest
wins. **Markers are state, not cache:** deleting them makes every job fire a catch-up at once.

Zulu Assistant's triage LaunchAgent (`system/launchd/mission-control-triage.plist.tmpl`) is a
worked example of the plist pattern, and the Ops Board reads the same markers to judge job health.

## 6. Agent integration

**Per-repo block** — add to every project's `CLAUDE.md` (template:
`examples/claude/CLAUDE.md.tmpl`):

```markdown
## Obsidian vault sync
Mirror notable work on this project to the central Obsidian vault at `$VAULT`, following its
**`Vault Guide.md`** note (structure, frontmatter, templates). This project maps to the vault
folder of the same name — create it and an overview note if absent. Keep notes current with the
live state (append a dated `## Update — YYYY-MM-DD` section when state changes). Create any
missing notes yourself; the owner should not have to pre-create them.
Before designing new subsystems or integrations here, consult the vault's `Home.md` and
`Capabilities.md` for prior art, reusable services, and cross-project constraints.
```

**Global rules** — in `~/.claude/CLAUDE.md`:

```markdown
## Obsidian vault — cross-project knowledge base
A documentation/memory vault lives at `$VAULT` (one folder per project, conventions in its
"Vault Guide" note).
**Read side — consult before building.** When starting a NEW project, or designing a new
subsystem/integration, first read `Home.md` and `Capabilities.md`. Check for prior art to reuse
and shared resources you must not conflict with. Follow `[[wikilinks]]` only as needed — don't
bulk-read the vault. Skip this for routine Q&A or small fixes.
**Write side — sync after substantive work.** Mirror notable work back to the vault per its
"Vault Guide" note, bumping the overview's `last-synced`. New reusable capabilities also get an
entry in `Capabilities.md`.

## Protected paths — never delete during cleanup/disk work
`~/Library/Application Support/selfheal-runner/` and `~/.cache/selfheal-runner/` (selfheal
markers — state, not cache), `~/Library/Logs/selfheal-runner.log` and
`~/Library/Logs/obsidian-backup.log`. Git-versioned copies of the markers and the runner log live
at `$VAULT/.scripts/state-mirror/` — restore from there after any wipe.
```

**Skill** — install `examples/claude/skills/sync-obsidian/SKILL.md` into
`~/.claude/skills/sync-obsidian/` (`./install.sh --brain` does this) for a one-command sync that
always defers to the live `Vault Guide.md`.

**Optional AI discovery check** — a weekly scheduled agent can complement the deterministic job:
list vault project folders, scan disk for project roots (`.git/` or a manifest), compute "last real
work" from git history excluding metadata files, and classify each as MISSING (work, no note) /
STALE (work newer than `last-synced` by > ~2 days) / in sync. Inspect and report only; no edits.

## 7. Setup checklist

1. [ ] Decide the §0 placeholders.
2. [ ] Create `$VAULT` from `examples/vault/`, `git init`, connect a **private** remote, confirm
       non-interactive push.
3. [ ] Open `$VAULT` in Obsidian (enable Bases if you add `Projects.base`).
4. [ ] Replace `<OWNER>` in the meta notes; add `.gitignore`.
5. [ ] Fill the `TABLE` in `.scripts/vault-staleness-check.sh`.
6. [ ] Render, install and load the two LaunchAgents (§4); verify.
7. [ ] Add the global rules + protected paths (§6); install the `sync-obsidian` skill.
8. [ ] For each existing project: onboard it per the Vault Guide checklist and add the per-repo
       block to its `CLAUDE.md`.
9. [ ] Confirm: an `Auto-backup` commit reached the remote, `launchctl list | grep obsidian` shows
       exit code 0, and `Staleness Report.md` was generated.

## 8. Merge compatibility contract

**Keep identical:** folder-per-project layout with one overview note; frontmatter field names and
values (`project`, `type`, `source`, `tags`, `date`, `status`, `last-synced`); note templates and
the dated `## Update` rule; `[[wikilink]]` style; meta-note filenames; the `sync-obsidian`
procedure and the per-repo block wording.

**Make distinct:** the git remote; the launchd label prefix; absolute paths; the staleness
`TABLE`.

**Merge procedure:**
1. Distinct projects: copy project folders across — folders are keyed by project name.
2. Same project in both: merge the overview notes (keep the richer history, append the other's
   `## Update` sections in date order, take the newer `status`/`last-synced`); merge child notes by
   topic.
3. `Home.md`: concatenate `## Projects`, dedupe, merge "How these connect".
4. `Capabilities.md`: merge by section and **carefully reconcile "Shared resources &
   constraints"** — the highest-value manual step.
5. Automation: keep one backup job and one staleness job; extend the surviving `TABLE`.
6. Update every repo's `CLAUDE.md` vault path; run the staleness check once and confirm it is clean.

> **Before-merge hygiene:** if two vaults share an ecosystem (shared databases, sender identities,
> hosts, single-writer contracts), seed the new vault's `Capabilities.md` with the other's
> shared-resource constraints from day one, so agents don't build conflicting integrations.
