# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.3] - 2026-11-13

**Security: if you run Guardrails, upgrade.** In 1.2.2 and every earlier release, an agent could push to `main` (or another branch your policy holds) without asking you, by switching to it in the same call first: `git switch main && git push origin`. Found in our own review. Upgrading is all you need to do: nothing to reconfigure, and your policy file is not touched.

### Fixed
- **Guardrails: a push after a branch switch in the same call.** A push that goes through the current branch (no branch named, `HEAD` or `@`) was judged by the branch the folder stood on before the call. So from a feature branch, `git switch main && git push origin` (or `git checkout main && git push origin HEAD`) pushed to main unasked. Now every branch a switch earlier in the call names is judged as well as the folder's own, and the push is held when any of them is held; nothing is taken off that list, so no call that was held before passes now. A switch the gate cannot read (`-`, `--detach`, `--track`, an option it does not read to the end, a tag or a commit, a variable, `gh pr checkout`, `git branch -m`, `bisect`, a git or gh subcommand it does not know, such as an alias) is asked. A switch inside `sh -c "…"` counts too, as does a switch before a push inside one (`git switch main && bash -c "git push origin"`) and a switch or a push inside a command substitution (`out=$(git push origin)`). A bare push is also judged by the upstream's name under `push.default upstream` (asked when the call changes branch or upstream first), and asked under `push.default matching` or with a push refspec set for the remote. Feature-branch work away from main is not asked more (`git checkout -b feat && git push -u origin`). What the gate still does not read is listed in [docs/GUARDRAILS.md](docs/GUARDRAILS.md). Affects Claude Code and Codex agents alike.

### Changed
- **The scheduled triage pass gets four tools.** Its allow list (`--allowedTools`) only answers permission asks; tools that need no permission stayed available. Probed on Claude Code 2.1.321, the pass held 29 built-in tools (among them a helper agent, messages to other sessions, schedules and web reads) and every MCP server of the account. `scripts/triage.sh` now starts it with `--tools "Bash,Read,Write,Edit"`, `--strict-mcp-config` (no MCP servers) and `--disable-slash-commands` (no skills), next to the allow list, when `claude --help` lists all three; otherwise it starts as before and says so in the job's log. On a large board (many cards, agents and tasks), the two readings the procedure fetches are longer than one answer, and the pass can no longer hand them to a helper; it reads them in parts instead, which takes a few more calls (a smaller reading made for the pass is in 1.3). The docs no longer call the pass hard-bounded: Claude Code runs read-only shell commands without asking, and the pass may write inside the checkout ([docs/MISSION-CONTROL.md](docs/MISSION-CONTROL.md#scheduled-triage)).

## [1.2.2] - 2026-11-11

**Security: if you run Guardrails, upgrade.** In 1.2.1 and every earlier release, an agent's push to a repository on your public list could run without asking you. This happened in three families of cases, all found in our own review. Upgrading is all you need to do: nothing to reconfigure, and your policy file is not touched.

### Fixed
- **Guardrails: a Codex shell call was read against the session's folder.** Codex runs a shell command in a folder of its own choosing, but tells the hook only the command and the session's folder. The gate read the repository from the session's folder, so a Codex `git push origin feature` run in a repository whose remote is public read as an ordinary push when the session sat in a private one. A row could also describe a repository the call did not touch. Now a Codex call's folder counts only when the command names it and it certainly applies (`git -C /abs/path`, or `cd /abs/path &&` with nothing but `&&` in between). Every held Codex call whose folder is not named that way is refused without a row, unless it is a `gh` call that names its repository. The agent is told how to run it again so it can be read. Affects you if Codex agents run under Guardrails.
- **Guardrails: a folder change that fails or does not apply was believed.** The gate took a command's folder from any earlier `cd`, even one that could fail or not apply: after a `;`, an `|| true`, in a pipeline or background list, behind `false &&`, in an `if` that is false, or undone by `popd`. The command then ran in the real folder, and a push to a public remote could read as private. A `cd` now counts for certain only when nothing but `&&` joins it to the command. Otherwise the command is read in every folder it may run in, and it is held if any of them holds it. Also read now: `cd -- <folder>`, `chdir`, `pushd -n` (no change), a `cd` with extra words (unknown), and git told its repository with `--git-dir` or `GIT_DIR`. Affects Claude Code and Codex agents alike.
- **Guardrails: the remote of a push told another way.** The push rule read the remote's fetch address, by name. A push could go to a public repository and read as private in several ways. The repository's push address was public; the remote had a second push address; with no remote named, git used another remote than `origin`; or the call gave the remote another address (`-c remote.origin.url=…`, `GIT_CONFIG_*`, a rewrite rule, `git remote add up <public> && git push up …`). Now every push address of the remote git really uses is read. A literal address given in the call is used, and any other change to a remote in the same call is asked. So is a variable or a substitution as the repository. Affects Claude Code and Codex agents alike.

## [1.2.1] - 2026-11-11

**Security: if you run Guardrails, upgrade.** Two ways of starting a gated script got past the gate in 1.0.0, 1.0.1 and 1.2.0: an agent could run it without your approval. Our own review found both. Upgrading is all you need to do: nothing to reconfigure, and your policy file is not touched.

### Fixed
- **One-click upgrade from 1.2.0 would have rolled back.** Found in our own upgrade rehearsal, before any release existed to upgrade to. After the tests, the upgrade runs `node scripts/publish.mjs --check`, and in a public checkout that check counted the files published only in the public edition (`README.md`, `docs/…`) as unclassified. So the upgrade from 1.2.0 would have failed at that last check and rolled back to 1.2.0, whatever release it moved to. In a public checkout the check now reads those files as what they are; a file listed twice still fails it. The upgrade runs the check of the release it moves to, and 1.2.1 is the first release it can move to, so the one-click upgrade works with this release.
- **Guardrails: a gated script behind an interpreter flag.** For `node`, `bash` and the other interpreters and shells, the gate took the first word that looks like a script to be the script, and the value of a flag is such a word. So `node --import ./pre.mjs scripts/upgrade.mjs --to v9`, `node -r …`, `--require`, `--loader`, `--env-file`, `bash --rcfile ./rc.sh install.sh upgrade` and the same forms in front of the ledger's decision commands were not held, though the plain forms are. A rule that names a script (`scriptIn`) is now tried on every script-looking word of the call, and the flags that take a value are known, so the dry-run bookkeeping follows the right file. The `=` form (`--import=./pre.mjs`) was always held. Rules on a program (`gh`, `git`, …) and rules on a flag (`--commit`, `--apply`) were not affected.
- **Guardrails: a script handed to the interpreter on its input.** `node < scripts/upgrade.mjs`, `cat install.sh | bash -s upgrade`, `sh -s -- gate 5 g1 approve < scripts/task.sh` and `node - --commit < scripts/rename.mjs` were not held: the rules that name a script did not see the file, and for the redirect form the rules on a flag did not either. An input redirect, a pipe from `cat` and a here-string that is one file's content are now read as the plain run of that file, when the call names no script or program of its own. Readers of the same files (`wc -l < install.sh`, `cat task.sh | grep gate`) stay free. What the gate still does not read as a run of a named script is listed in [docs/GUARDRAILS.md](docs/GUARDRAILS.md#writing-rules).
- **Tests: demo boards started together no longer kill each other.** A demo board empties and re-seeds its ledger folder (`data/demo-tasks`) at startup. Several tests start a real demo board from the checkout and the test runner starts test files side by side, so two boards could remove each other's files mid-write; the loser died at once and its test waited 15 seconds for a board that was already gone ("demo board answered"). This failed about one full run in four on a busy machine, and `./install.sh verify` and the one-click upgrade run the suite on your machine. A demo board now takes its ledger folder from `MC_DEMO_TASKS` when set (default unchanged), every test gives its board a folder of its own, and a test fails when a new one forgets. A folder named that way must be empty, or one a demo board seeded before (it then carries a marker file); anything else is refused and left as it was, and your real ledger folder (`data/tasks`) is refused whatever it holds.
- **Tests: two more timing tests judge the third-fastest run.** Like the hook's fast-path test in 1.2.0, two other tests timed the hook over 60 runs and required the median under their ceiling, which a busy machine moves. They now judge the third-fastest run, and a test names any test that judges a median. The Guardrails-only board test now waits for a whole poll before it reads which stages ran.

## [1.2.0] - 2026-11-10

**Security: if you run 1.0.0 or 1.0.1 with Guardrails, upgrade.** This release fixes a hole in the gate hook of both: a call that should have been held could get past the hook and run without your approval (see [Security](#security) below).

The trust release. Guardrails reads more of what an agent can do and protects itself, an approval is something only you can give (a recorded "yes" is a proposal until you confirm it), receipts are chained, and the gate hook no longer trusts the session it runs in. Also new: one-click upgrade (1.2.0 is the first release you can upgrade *from* that way), a Guardrails-only install, push notices to your phone, GitHub intake, the evidence panel and a daily ledger backup. There was no public 1.1.0; this release holds everything since 1.0.1.

**After upgrading from 1.0.x, run `scripts/guardrails-install.sh --apply` once more:** that adds the settings-change hook, which an older install does not have.

**An upgrade from 1.0.x does not bring this release's gate rules.** Your `overlay/policy.json` is never overwritten, so it stays without the `upgrade` class and the new rules that protect the gate's own files until you add them. The guardrails card says how many are missing; [docs/INSTALL.md §7b](docs/INSTALL.md#7b-upgrading) has the step. The manual path also needs `node scripts/migrate.mjs` after the pull.

### Added
- **Guardrails: the gate checks itself.** Two parts, neither needs `sudo`. See [docs/GUARDRAILS.md](docs/GUARDRAILS.md#the-gate-checks-itself).
  - **Gate integrity on the guardrails card** (`SETTINGS.gateIntegrity: { mode: 'on' }`, off by default). Every poll the board compares the gate's own files in its checkout with what has landed on the remote's default branch, or with the release tag on a release install. Green when current; amber while a landed change has not been fast-forwarded here, red after `behindMinutes` (default 30); red at once when a file differs or the checkout moved back. It asks the remote itself, so a moved local ref hides nothing. It also checks that the hook is registered with the exact command and a matcher that covers every tool, that no settings file of yours or of a registered agent's repo switches hooks off or sets one of the hook's own variables in `env`, that the triggers file is what the policy generates, and that `data/local.env` names the board's own port. It only reads.
  - **A settings-change hook** (`scripts/gate-config-hook.sh`, installed by `guardrails-install.sh`; run the installer again to get it). Claude Code reads settings files again while a session runs, and a project file can switch off a hook the user file registered. The hook blocks such a change for the running session and the board says so on the ticker. It judges every settings file the session reads on each change, answers "blocked" itself if its check takes longer than 8 seconds, and does not take its tools or its folders from the session's environment. It cannot help a session that starts in a folder whose settings already switch hooks off; the card shows that file.
- **Guardrails-only install.** `./install.sh --guardrails` installs the board, the ledger, the gate hook and the page with the waiting rows, and nothing else: no cmux, no Homebrew packages, no Mission Control, no scheduled triage job, no brain. It sets `profile: "guardrails"` (`SETTINGS.profile`, `full` by default) and `"defaultMode": "enforce"` in your policy, loads one LaunchAgent, shows the hook it would add to your Claude settings and asks before writing it. In this profile the board runs no fleet collector, no mesh and no session heal, and makes no cmux call. A session the board cannot wake is told to run the same command again after you approve, and its row says so. On an install that already runs the full board it stops and shows what would change unless you add `--switch`, and an agent that runs it is held by the gate (the dry run is free). See [docs/QUICKSTART-GUARDRAILS.md](docs/QUICKSTART-GUARDRAILS.md).
- **Docs: three new pages.** [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) gathers what usually goes wrong (the board, cmux and sessions, Guardrails, the installer, chat intake and the relay, backups and upgrades) with the cause and the fix for each. [docs/MODELS.md](docs/MODELS.md) says which model runs each role and how to change it. [CONTRIBUTING.md](CONTRIBUTING.md) now says how a pull request lands: this repository is a generated copy, so an accepted PR is applied in the source repository with you as author and closed here with the release that carries it.
- **Guardrails: a waiting row says what kind of call it is.** A row now carries a chip when the target repo is on your `publicRemotes` or `deployOnPush` list (`public repo`, `deploys on push`), and for a send, a store write, a change to the gate itself, desktop control or an unlisted tool. Chips come from the class and your lists, never from the agent. The agent's own description of a shell call is shown on its own line, labelled "agent's words" and escaped; it is not part of what an approval binds. The time of a dry run links to the task's receipts when the evidence panel is on, and a grouped row's chip names the context too.
- **Guardrails: `selfProtect` reads the forms that stood between it and `enforce`.** In the live checkout: git commands that move the index or HEAD to another commit, a work tree paired with another repo's index, names git resolves another way (a remote-only branch name, a local branch or tag called `origin/main`), settings given for one call (`-c`, `--config-env`, `GIT_*`) on the commands that bring content in, and every stored setting except `user.*`. Writers that name no file (a pattern as the source, a download named by its address, unpackers, line editors), targets spelled with `$(pwd)`, braces, a pattern or a variable, and more ways of stopping the board (`pgrep -u`, `pidof`, `fuser -k`, the process group, `reboot`). The check still ships in `observe`. [docs/GUARDRAILS.md](docs/GUARDRAILS.md) lists each form and what is still not read.
- **Guardrails: the gate protects itself (`selfProtect`, ships in `observe`).** Held under class `self` once you set it to `enforce`: writes to the gate's own files in the live checkout (the hook, the classifier, the board page, the agent directory, the task files), to hook settings in any repo, to shell and git start files and to cmux's session maps; `git config` that sets a hooks path, an alias or the user or system file; moving a remote-tracking ref or a remote; git in the live checkout that can leave a gate file holding something that has not landed (a hard reset, a branch change, a pull that is not a fast-forward of the default branch); and stopping the board with `kill`, `pkill`, `killall` or `launchctl`. `git clean -x` is held as a delete anywhere. A git worktree of the checkout is free, and so is `git pull --ff-only --autostash` in the live checkout. Lists `gateCode` and `guardGate` and the `<live>/` path prefix are new in the policy. See [docs/GUARDRAILS.md](docs/GUARDRAILS.md). The check reads a command on several lines and a heredoc the way the hook sends it, ignores letter case where the volume does, and covers the forms that move what a pull brings (`git config remote.*`, `branch -u`, a refspec into `refs/remotes/`, `git -c core.hooksPath=`), `git rm` and `git mv` of a gate file, recursive copies and extracts into the checkout, `$HOME` and `$PWD` in a target, and a board pid found with `pgrep`.
- **Guardrails: two more things the gate reads, and a replay tool.** Code handed to an interpreter on the command line (`node -e`, `python -c`, `osascript -e` and the like) is read the way an interpreter heredoc is, and a renamed or path-run program whose first words are a gated action (`./mygh pr merge 5`) is held as unreadable. Each has a switch in the policy's new `checks` object (`inlineBodies`, `renamedBins`) and ships in `observe`: the call passes as before and `observed.jsonl` says it would have been held. `node scripts/gate-replay.mjs` reads the recorded checks and prints what the checks would newly hold, so you can look before you set one to `enforce`. See [docs/GUARDRAILS.md](docs/GUARDRAILS.md).
- **A daily backup of the ledger.** `zulu backup --state` writes a small archive of the ledger, the board's state files and `overlay/` (no handoffs, no logs, nothing over 5 MB), then keeps its newest 14 archives. It never removes an archive it did not create. `scripts/state-backup-install.sh` shows the daily LaunchAgent it would install; you install it. A `backup:state` card goes amber when the newest archive is older than 36 hours (`SETTINGS.backupWatch`, off by default). Restore steps are in [docs/INSTALL.md](docs/INSTALL.md), Rollback.
- **The board reports on itself.** `GET /api/status` now carries `poll` (the last duration and last error of each poll stage, and a count of stray promise rejections) and `dataUsage` (the size of `data/` and its largest folders). The morning briefing gets one `DATA:` line. Nothing is deleted.
- **Parser watch.** If you feed the board a per-supplier view of document parse results, a supplier whose files stop parsing becomes one high-priority ledger task, with the outcome counts, the failing filenames and your fix brief. It comments while the failures continue and cancels the task when they end, unless someone has already claimed it. Off by default (`SETTINGS.parserWatch`).
- **GitHub intake.** New issues and discussions on your public repo can become ledger tasks, one per thread, addressed to Mission Control. On a discussion you started, each new comment from someone else is its own task. It reads with your `gh` login and never writes to GitHub. The text is quoted as data and authors are external names. `observe` shows ticker lines only. Switch: `SETTINGS.githubIntake` (`off` by default). See [docs/GITHUB-INTAKE.md](docs/GITHUB-INTAKE.md).
- **A close checks that the linked PR landed.** `task.sh close` is refused while the task's linked PR is open or closed without landing. `--pr-not-landed "<reason>"` closes anyway and records the reason on the task. A PR that cannot be read (no `gh`, a timeout) adds a warning comment and never blocks.
- **Worker lifecycle rules in code.** A worker spawned on a task Mission Control owns now gets the task at spawn, so its claim works. `agent-close.sh` lists the worker's live tasks and open PRs and refuses to close the workspace until they are settled (`--override "<why>"` closes anyway). Its worktree sweep also covers the task the worker was spawned on. A spawn prints a warning when it would exceed `SETTINGS.workers.max` live workers (default 3); it never refuses.
- **Guardrails: an `upgrade` class.** An agent that runs `zulu upgrade`, `zulu rollback`, `scripts/upgrade.mjs` or `install.sh upgrade|rollback` now waits for your one click, and the command runs once. The `--check` form is never gated, and a program go never covers this class.
- **Attention ring: grouping + snooze.** The WAITING ON YOU strip (full board and `?dock=1`) can show one row per task with its N items. Gates, approvals and plan reviews come first and start open, with their buttons showing; tasks that are only blocked on you wait in one "blocked on you (n)" fold. An open row can be snoozed (closed rows stay one line, with no snooze button) for 15 minutes, 1 hour, 4 hours or until 08:00 tomorrow (pick a length, then click it again). Snoozed items leave the strip and the `(N)` title count and wait in a dim "snoozed (n)" fold; when a snooze runs out the item comes back marked BACK. A snooze never decides anything and never holds an agent: gates stay pending. Only the board page can snooze (decision token, no agent identity). The cmux task pill shows `+n snoozed`, and the custom sidebar drops a row whose items are all snoozed. Switch: `SETTINGS.attention.snooze` (`off` by default).
- **Evidence panel.** A read-only page at `/?evidence=1`, sized for the cmux Dock: one expandable row per task (live first, then closed in the last 14 days) with its completion packet (request, PR and head, test stamps, checks not run, gates, generated summary, STALE) and its gate receipts (who decided, when, whether it ran, or the program go that auto-approved it). Closes without a packet are marked EVIDENCE MISSING; a filter box takes `#id` or text. Data from `GET /api/evidence?limit=N&task=ID`; gate command text is never shown and secret-looking text is withheld. The Dock seed gains an "Evidence" tab. Switch: `SETTINGS.evidencePanel` (`on` by default).
- **Weekly operating reading.** Once a week the board reads the ledger and reports how the workforce ran, against the week before: closes by owner and by requester, reopens and the reopen rate, how long tasks waited on you, gates by outcome (approved, auto-approved under a program go, declined, expired unused) with the declined-or-expired share as a false-positive signal, approval-to-action time (median and p90), closes with a completion packet, and worktrees created and cleaned. Tasks now keep a short status history so reopens and waits can be measured. `observe` shows it as a ticker line and an info-only `ops:reading` card; `on` also posts it to one ledger task. `node scripts/operating-reading.mjs` prints it now. Switch: `SETTINGS.operatingReading` (`off` by default).
- **Task titles in cmux.**
  - The progress label the board writes on each agent's workspace now ends with the task title (`#411 WORKING · 1/4 · <title>`, cut at 48 characters). A custom sidebar, which has no network, can now show what the task is.
  - Phosphor's second row line shows it, and its ATTENTION states read only the status token, so a title word like "blocked" never flags a row.
  - An agent with several tasks still gets one headline task, with its title and checklist (`22 tasks · #344 BLOCKED · 0/4 · <title>`). The headline is the agent's focus, else the task waiting on you, else the latest. `ledger-node` shows it plus "and 21 more".
  - Turn it off with `titleInLabel: false` in `mesh.json`.
- **Optional `ledger-node` sidebar.** The selected workspace's ledger task (id, title, status, checklist, owner) as a cmux custom sidebar. It's installed by `cmux-tier1-install.mjs` and never selected for you. See docs/CMUX-SETUP.md.
- **Push approvals on your phone (prototype).** When a gate, an approval or a plan review waits on you, your phone buzzes through a self-hosted ntfy server on your tailnet, or through the opt-in public ntfy.sh fallback.
  - **What a push carries:** ids and labels only, never the command. The fallback leaves out the task title too.
  - **The tap** opens the board with that item highlighted (`?dock=1&item=…`). You still decide there with two clicks.
  - **Rings:** again at 30 and 90 minutes if still waiting. An item you snoozed in WAITING ON YOU gets no re-rings until the snooze ends; then it rings once and the 30/90 re-rings restart.
  - **Quiet hours** (22:00–07:00): gates still ring, at normal priority; everything else is held until morning.
  - The desk notification always fires as well. Off by default (`SETTINGS.relay`). See [docs/RELAY.md](docs/RELAY.md).
- **One-click upgrade.** A release install (`get.sh` clone, on a release tag) gets an **update** card with **⇧ UPDATE TO vX.Y.Z** when a newer release is out (GitHub's releases API, checked every 6 hours).
  - **What it does:** preflight, backup, fast-forward to the tag, migrations, tests, install steps, restart and a health check. It runs from a one-shot LaunchAgent, never inside the board.
  - **If it fails:** any failure after the code moved rolls back by itself to the exact previous commit, with `overlay/` and migrated files restored. Your ledger is never rolled back.
  - **Commands:** `zulu upgrade [--check] [--to <tag>]` and `zulu rollback`.
  - **Migrations** may only add missing keys to your `overlay/`.
  - Switch: `SETTINGS.upgrade`. See [docs/UPGRADE.md](docs/UPGRADE.md).
- **Status taxonomy.** Agent tiles now say what each agent is doing (working, waiting on input, idle, stopped, or an explicit UNKNOWN), where that came from (the hook files, or a screen read marked "screen") and how sure the board is ("?" = low confidence; the tooltip gives the reason). A hook report counts only while its process is alive; a stale "running" becomes "running?"; a recognised prompt on screen beats a hook that says idle. An agent is never shown as done; only closing its task is. Also in `/api/agents`, the Dock, a cmux `state` pill and the custom sidebar (`?` prefix). Screen reads are bounded (8 per poll, cached 2 minutes). Display and API only. Switch: `SETTINGS.statusTaxonomy`.
- **Worktree per task.** A spawned worker now codes in its own git worktree (`<repo-parent>/wt-<task>`, branch `task/<task>-<slug>`, from the remote's default branch), recorded on its task; ignored files such as `data/` and `.env*` are never copied in. `task.sh worktree N` makes one by hand (residents get it as a per-task instruction with `residents: true`), and `task.sh worktree-clean N` removes one only when nothing can be lost: no uncommitted files, no live process inside, every commit pushed. It never forces. Closing a task with its worktree still on disk leaves a warning on the task. Switch: `SETTINGS.worktrees` (on for workers by default; `MESH_WORKTREE=0|1` overrides one launch).
- **Completion packet.** When a task closes, the board can record the evidence it rests on: the request, the PR and its head commit, test runs stamped by the new `task.sh test N -- <command>` (exit code, revision, branch, dirty tree, time; output never stored), checks the closer did not run (`--unrun`), each gate's outcome, and the closer's summary labelled as generated. A run on a dirty tree or off the PR head marks the packet STALE. It shows on the close comment and the WORK panel and never blocks a close. Switch: `SETTINGS.completionPacket` (`off` by default; `observe` = a ticker line only).
- **Dock: WAITING ON YOU on top.** In `?dock=1` the owner's decisions strip sits above the header, sticky at the top of the column, and never disappears: with nothing waiting it shows one dim line, "⛨ nothing waiting on you", so a one-click gate is never below the fold. The full board is unchanged.
- **View cards: `maxAgeIfSet`.** An "oldest waiting item" timestamp ambers only when it is set and too old; null means nothing is waiting. A `show` column already listed by a rule is no longer repeated in the detail line.
- **Chat intake: channel discovery.** Every chat channel the bot can see that has no route (including ones it isn't in) becomes ONE board task, "map it or ignore it", plus a ticker line, so a new request channel is never silently unread. `ignoreChannels` in `config/channels.json` silences one, and `--check` lists them.

### Security
- **Guardrails: text in a call could turn the gate's answer into silence.** After its Node step had answered, the hook's shell script decided whether a call had already run by looking for the after-call event's name anywhere in the raw hook input. That input holds the call's own words, so a held call whose command, comment or tool input contained that name ended with no output, and no output lets the call run. With the board up, the gate was filed and the call ran anyway. The Node step, which reads the input properly, now says by itself when there is nothing to say; the shell reads the event only when the Node step could not answer, and only from the input's own key, in a form a string value cannot produce and only when that key occurs once. `gate-replay.mjs --mentions <word> --list` lists past checks that name a word (time, agent, event, answer; never the call's text), so you can look for past calls of this kind.
- **Guardrails: the gate hook no longer believes the session's environment, and answers before its time limit.** Two things were seen on Claude Code 2.1.321, in scratch folders: a settings file's `env` block reaches every hook process of the sessions in that folder, and a hook that answers after its registered time limit lets the call run. On a copy of the hook script as it was, one settings file in a repo was enough to make a gated call pass (its own `cat` first on `PATH`, a preload in `NODE_OPTIONS`, or `MESH_BOARD` pointing at another listener), with no change to any gate file.
  - The script now puts the system folders first on `PATH` and clears the variables that load other code before it runs anything.
  - The board's address comes from the checkout's own `data/local.env`, else the default port. An environment that names another board gets no request sent anywhere: gated calls are denied and the reason names both addresses. **If you export `MESH_BOARD` or `MC_PORT` in your shell and it does not name the board the hook belongs to, unset it.**
  - The Node step runs under the script's own 12-second deadline, below the registered 15, and the script answers "deny" itself when it passes. `GATE_TIMEOUT_MS` can only shorten the 8-second wait for the board.
  - Speed is unchanged: about 14 ms for a call that hits no trigger.
- **Guardrails: hash-chained receipts.** Every change to a gate appends one line to `receipts.jsonl` in the Guardrails state folder, each carrying the hash of the line before. `task.sh audit N --verify` recomputes the chain and compares it with the task's gates; the `guardrails` card does the same over every task at start and every six hours and goes red on a difference. An approved call now runs only when the chain holds the approval the running board recorded: an approval written into the files by hand is refused, the gate is marked `disputed` and the card goes red. A line that cannot be written never fails a gate event (the card goes amber and the line is written with the next one). Switch: `SETTINGS.receiptChain` (`on` by default; `observe`, `off`). See [docs/GUARDRAILS.md](docs/GUARDRAILS.md), The receipt chain.
- **Guardrails: a guarded file is held however the call reaches it.** The hook's fast path looked for a guarded file as its folder and name side by side, so `cd data && cat <file>`, `data/./<file>`, `data//<file>` or a call made from inside the folder never reached the rule. The fast path now looks for the bare file name, and for a guarded folder also in the folder the call is made from; `/./` and a doubled slash are dropped first. On macOS `/System/Volumes/Data/<path>` is read as `<path>`. A bare name only sends the call to the rules: a script in another repo that names `settings.json` or `webhooks.json` is not held for it. An interpreter's program run from inside a guarded folder is held. A glob or a variable in a path is still not read.
- **Guardrails fix: a check in `observe` no longer changes the hook's answer.** A fast-path line that only an observing check adds made an interpreter's program or an assignment naming one of that check's paths (a shell start file, `.git/hooks/`, a hook-session file) opaque, so the call was held although the check was only observing. Such a line now routes the call and gives the "would hold" reading, and decides nothing until the check is set to `enforce`. On the shipped default this affected `selfProtect` and `renamedBins`.
- **Guardrails: another letter case is the same file, script and program.** On a disk that ignores case (the default on macOS and Windows) the rules matched names exactly, so the rules file or the gate's state could be reached under another spelling (`Overlay/POLICY.JSON`), a guarded script could be run as `TASK.SH`, and a gated program as `GH`. Paths, script names and program names are now compared without case there. This is a fix, not a switch.
- **Backups can no longer carry the phone relay's credentials.** `zulu backup` used to walk all of `data/` and leave out a fixed list of names, so the relay folder (its user database and the phone's token file) went into every manual archive. Credentials are now left out by three rules: a folder holding a `.nobackup` file is skipped whole in every kind of backup, `--with-secrets` included (`data/relay/` gets the file from the backup itself and from the upgrade); a file only its owner can read is left out unless it is in one of the board's state folders; a small file whose text looks like a key is left out. The backup prints what it left out and why. A restore refuses to write into a marked folder, puts each file's mode back, and brings credentials back only with `--with-secrets`. If you copied an earlier full backup off your machine and use the relay, treat the phone's token as exposed and make a new one. Note: files that agents saved owner-only under `data/handoffs/` are now left out of a backup unless you pass `--with-secrets`.
- **Guardrails: a quoted here-string to a shell is read.** `bash <<< "gh pr merge 5"` was read as an argument of `bash` and passed. The word after `<<<` or `>` is now that operator's target whether it is quoted or not. This is a fix, not a switch.
- **Guardrails: a gated command behind a shell keyword is held.** A command written after `then`, `do`, `else`, `elif`, `if`, `while`, `until`, `coproc` or `!` (`if …; then gh pr merge 5; fi`) was read as the keyword's arguments and passed. The program is now the word after the keyword, so the command is judged like any other. This is a fix, not a switch.
- **An answer you gave in a pane no longer approves by itself.** When an agent records "the owner said yes" (`task.sh approved-in-pane`, or Mission Control's `task.sh gate-approved`), the record is now a proposal. Your row on the board quotes it and names who typed it, and you click **CONFIRM**, **DECLINE** or **NOT WHAT I SAID**.
  - Until you confirm: the gate stays pending and no grant is minted, no program go starts, and a plan-first plan is not approved.
  - Before, the record was the approval. It rested on a name the agent declared for itself, so an agent could approve its own gate by claiming to be Mission Control, and a task's owner could grant its own program go.
  - A recorded decline still takes effect at once.
  - `SETTINGS.paneAnswers: 'direct'` restores the old behaviour. The default, also when the key is absent from your config, is `'confirm'`, so an upgrade changes this for you: a pane answer now needs one click on the board.
- **The decision door.** The board now looks at the process that holds the connection before it takes an owner decision (`SETTINGS.callerEvidence.tripwire`).
  - `'agent'`: an approve, decline, snooze, card action or upgrade that an agent session is behind is refused, with the decision token or without it, and Mission Control is told which agent. Before, an agent that fetched the token from the board page could post an approval.
  - `'browser'`: also, a decision made on this machine must come from a browser or web view. Under `'agent'` this is only logged (`[door] would refuse`), so you can read what it would stop before you turn it up.
  - A decision typed as a `!` line inside an agent's pane is refused under both: the board cannot tell it from the agent. Decide on the board page.
  - A request from another device and a request the board could not look up are never refused by the door. Each decision that passes with no evidence of its sender is logged, put on the ticker and counted.
  - A sender that writes its request and leaves (it exits, or resets the connection) is not a failed lookup. It is logged under `'agent'` and refused under `'browser'`.
- **The board checks agent names against the calling process (observe).** `SETTINGS.callerEvidence.mode: 'observe'` records, next to the name an agent declared, the agent the board worked out from the process ancestry and cmux's session map. A mismatch between two agents reaches the ticker as `[caller mismatch]`. Nothing is refused on names in this release. The lookup runs before the answer goes out, so a ledger or mesh write takes about 160 ms longer while this is on. Needs `lsof`.
- **Agent names can be enforced.** `SETTINGS.callerEvidence.mode: 'on'` (not the shipped setting, which stays `'observe'`) makes a declared name count only when the calling process backs it.
  - A name it does not back keeps its words and loses its standing: a message, a comment or a new task still goes out, marked `UNVERIFIED` and recorded under the board's name with the reason. Claim, start, close, reassign, a gate focus and Mission Control's steps are refused.
  - The gate hook's identity comes from the session behind the hook's call. A child session started with an observed agent's workspace id is now judged as the session that started it. A lookup that fails, or a cmux session the board cannot name, is enforced whatever it declared.
  - Headless runs are named by their launchd job (`callerEvidence.jobs`) or by the workspace the board opened for a card dispatch. The `MESH_GATE_IDENTITY` variable is ignored under `'on'`; it still works in `'observe'`.
  - The owner's name still needs the decision token, and under `'on'` is not accepted from a process an agent session is behind.
  - Read a week of `[caller mismatch]` lines in `'observe'` before you turn this on. A scheduled script that uses an agent's name needs an entry in `callerEvidence.jobs`.
- **An approval typed in a terminal becomes a row you confirm** (`callerEvidence.tripwire: 'browser'`). `task.sh gate N gK approve` from your own terminal no longer decides on a board that takes decisions from its page only. It prints `NOT approved yet`, the gate stays pending with nothing minted, and the gate's row says an approval was typed in a terminal and that the board cannot tell who typed it. One click confirms it; **I DID NOT TYPE THIS** throws it out and tells Mission Control. A typed decline is refused: decline on the board page. Under `'agent'` nothing changes, and the server log says what `'browser'` would do with each typed approval.
- **Board down: the hook reads its session from the agent process above it.** A child session started with an observed agent's workspace id in its environment is now enforced when the board is unreachable.
- **Receipts: `phone` means another device.** A decision this machine made through its own tailnet address is recorded as local.
- **Card actions need your decision token.** The buttons on a card (kickstart, restart, start, dispatch a session, ask the master) now go through the same check as a gate decision: the board page's token, and no agent or intake identity. Before, any local caller could post them.
- **Every write is checked for where it came from.** A POST, PATCH, PUT or DELETE is refused (403) when its `Origin` is another site, when the browser marks it cross-site, or when it was addressed to a host name the board does not answer to. Requests with no `Origin` (curl, the hook, scripts) pass as before. A body must be declared as `content-type: application/json` (415 otherwise). If you reach the board by a name of your own, list it in `SETTINGS.allowedHosts`.
- **The owner's name and `board` are reserved as senders.** A mesh message or a task wake under the owner's name is the owner's only with the decision token (the board page, or `--signed` from your own shell; an agent that runs the ledger or mesh CLI with that flag is held as class `self`). `board` is the board's only from its own process. A message that claims either name without proof is still delivered, marked `UNVERIFIED sender`, and is not written to the ledger under that name.
- **Wakes for intake tasks carry the id and the source only.** When a task came from the team chat, from GitHub or from a channel name, the text typed into an agent's pane no longer contains the title, the body or a comment. The agent reads the task from the ledger.
- **Guardrails: a default mode, with readings first.** The policy takes `defaultMode` (`observe`, the shipped default and today's behaviour, or `enforce`) and `observeFor`. With `enforce`, every session is held, registered or not, except the names in `observeFor`. Headless runs the board starts (triage, a dispatched fix session) now resolve as `headless:<role>`. While the default is `observe`, every call the other setting would have held is logged as "would enforce". See [docs/GUARDRAILS.md](docs/GUARDRAILS.md).

### Fixed
- **`ZULU_NO_LAUNCHD=1` now covers the full installer.** Only `--guardrails` and `zulu setup` honored it, so a test install under a temp `HOME` still loaded real LaunchAgents. `scripts/bootstrap.sh`, a backup restore and the job installers now skip `launchctl`; `zulu upgrade` and `zulu rollback` refuse (`--check` still works).
- **cmux is looked up, not assumed.** The shipped registry named a fixed Homebrew path for cmux. It is now found on `PATH` (a full path in `SETTINGS.cmuxBin` still pins one). On a Mac with no cmux the `cmux:bridge` card says so in amber; before, it could read "socket auth OK". With no cmux the board skips the session heal and sends desktop notices through macOS.
- **Ledger: concurrent first reads.** Two requests arriving while the board read the ledger for the first time could see a half-filled list, and a task created in that moment could take an id that was already on disk and overwrite that task's file. The first read is now shared by every caller.
- **Docs: twelve places where the docs disagreed with each other or with the code.** One macOS version (26, the version each release is tested on; "14 or later" was never tested). What the one-line installer really installs and loads: the Codex CLI, Graphify and Obsidian by default, the brain step without a question, and a scheduled triage job that costs money, with how to leave each out. Where credentials live (the file you fill, plus three the board generates and the relay's folder). The one file outside its checkout that the board writes (cmux's config, to restore the socket password). What the decision token covers, and that the board page carries it. That an approval is a click on the board, also from the phone over your tailnet, and that a push only rings. That an agent the board cannot reach is not woken after an approval and runs the command again. One-click upgrade is described as part of this release, not as present "since 1.1". An older backup is migrated forward, not refused. The roadmap names the latest release.
- **Guardrails: a program go is stricter about which repo a landing reaches.** A landing now runs by itself only when the `gh` call is the whole command (a leading `cd <folder> &&` and a plain `GH_REPO=<owner/name>` prefix are fine); with anything else in the same text it asks you, and the agent is told to run it as its own command. The repo flag is read inside a group of short flags (`-sR <repo>`). With no repo named, every remote of the checkout and every `gh-resolved` key must point at the origin's repo, because that is where `gh` looks. These only ever make it ask more.
- **Guardrails: a program go judged the wrong repo for a landing named by URL or `GH_REPO`.** `gh pr merge https://github.com/<owner>/<name>/pull/N` and `GH_REPO=<owner>/<name> gh pr merge N` were checked against the checkout's own repo, so a go for work in a private repo also auto-ran a landing into a public, deploy-on-push or unknown repo named that way. The board now collects every repo the command names (the repo flag, a PR URL, each `GH_REPO` assignment) and uses it only when they agree on one github.com repo; two different names, an unreadable name, another host or `GH_HOST` ask you. Without a program go these commands were always held.
- **"Not approved yet" always reaches the agent.** When a pane answer was recorded for a gate, the notice telling the waiting agent not to retry could be replaced in its queue by any later message about the same task. It is now a kind the queue never replaces, and it is dropped only once you have decided. The notice sent when you reject a record is the same kind.
- **"Not what I said" puts a task back where it was.** If the task had moved on before the pane answer was recorded, rejecting the record left it waiting on you with plain approve and decline buttons. It now returns to the status it had.
- **The agent feed no longer reads the whole workstream file.** `/api/feed` and the log view read the last 256 KB, cached by size and modified time. On a file of a few hundred MB the old read ran on every open tab's refresh.
- **Alerts no longer wait behind mesh work.** The alert pass and the dead-man heartbeat run straight after the snapshot. Each poll stage runs in its own try, so one failing stage cannot skip the others.
- **A stray promise rejection no longer stops the board.** It is logged with a timestamp and the board stays up. An uncaught exception is logged, then the process exits for the supervisor to restart.
- **The morning briefing survives a restart.** Its day is kept in `data/digest-state.json`. A restart after the briefing hour neither skips nor repeats it, and a failed send is retried twice.
- **A message queued while the outbox is being delivered is no longer lost.** Queueing, delivery and dropping go through one writer per outbox file.
- **Dock order.** The `?dock=1` column now reads header, then NEEDS ATTENTION with your one-click decisions above the amber and red cards, then WAITING ON you with the blocked tasks and snoozed items folded. Blocked tasks no longer fill the top of the column. The full board keeps its strip.
- **Gate buttons no longer sit below the command.** A gate row now shows what it is, why it was held and who asked, then ✓ RUN ONCE / ✕ DECLINE, then the command. A command over 6 lines or 480 characters starts folded with a "show full command" toggle; unfolded, it is the exact, uncut text. In a narrow column, a long task title no longer pushes DECLINE off the side.
- **Guardrails: `gh` flags placed before the subcommand.** `gh --subject x pr merge 5` is a real merge, but the flag's value read as the subcommand, so it wasn't gated. It is now.
- **Guardrails: harmless chained commands were held.** A read followed by an unrelated command on one line, such as `gh pr view 5 && git merge --abort`, could look like a gated `gh pr merge` and wait for your approval. The gate now judges each command, and only a real match holds.
- **Guardrails: policy files in a git worktree.** The gate protected `policy.json` only in the live checkout, so an agent could edit the copy in a worktree without asking. Those copies now need your approval too.
- **Guardrails: the word "gate" in a message no longer holds the command.**
  - **What went wrong:** the fast-path trigger for `task.sh gate` (and `mesh-cli.mjs task`) let any text sit between the script name and the word. A `task.sh comment` whose text said "merge gate" set it off. So did a later command on the same line, such as an agent message. The parser judges each command separately, so it couldn't account for the hit and held the call as unreadable, waiting on you.
  - **Fix:** a script rule's argument is its subcommand, and now has to follow the script name directly.
  - **Unchanged:** a real `task.sh gate N gK approve` from an agent still gates.
- **Guardrails: Mission Control's focus.** `task.sh focus N` already let Mission Control focus a task another agent owns, but the hook only honored a focus on the caller's own tasks, so Mission Control's gates were refused with "live tasks and no focus". Its focus now counts on any live task.
- **Guardrails: a pending gate could fall off WAITING ON YOU.**
  - **What went wrong:** the waiting list only read tasks whose status was "needs approval". A task that was blocked and then unblocked went back to "in progress" while its gate was still pending. The gate stayed off the strip, `?dock=1`, the sidebar ATTENTION list and the cmux pill, and the phone relay was the only place that still showed it.
  - **Ledger fix:** a task with a pending gate stays in "needs approval" through any status change (unblock, start, claim, assign). It leaves only when the gate is decided.
  - **Display fix:** the summary and the pill also treat any live task with a pending gate as waiting on you. This covers tasks saved before the fix.
- **Brain: "graph behind" from data-only commits.** A commit that touches only data or binary files (spreadsheets, CSV/TSV, images, PDF, zip, `.ics`, `.plist`, lock files, any letter case) no longer counts as code for the graph-behind check or for the close gate's `graphify_updated`. graphify never extracts these, so the graph never moved and the repo read as behind forever.
- **A task's original request can no longer scroll away.** New tasks keep the request in its own field. On older tasks the comment cap (200) now keeps the first comment when it is the request. No existing task file is rewritten.
- **Worktree cleanup after a squash.** A branch that was sent to the remote without tracking and then squashed and deleted left no proof, so `worktree-clean` refused. It now looks the PR up by branch name and accepts a landed PR whose head is exactly the local head.

## [1.0.1] - 2026-11-03

A Guardrails hardening release, prompted by a question in the project's Discussions: can a crash or restart make an approved action run twice? It can't, and this release proves it with tests, completes any receipt a crash left half-written, and says plainly what a "run" receipt means. No settings to change: update, then restart the board.

### Added
- **Guardrails crash-and-restart tests** (`test/gate-crash.test.mjs`): a board killed between spending a grant and writing its receipt, a normal run then a restart, torn and corrupt grant files, and concurrent attempts at one approved call. An approval never runs twice. See [docs/GUARDRAILS.md](docs/GUARDRAILS.md#crash-and-restart).
- **Startup reconcile for gate receipts.** A receipt a crash left at *approved* is completed when the board starts, stamped with when the grant was spent and noted `recorded after restart; outcome unknown`.

### Changed
- **The "executed" receipt now says what it means:** `released to run once … — the agent reports the outcome on this task`, in the task comment, the ticker and `task.sh audit`. The board lets the call through; it never sees the result. The stored status is still `executed`, so existing ledgers need no migration.

### Fixed
- **Guardrails: simultaneous gated calls right after the policy loads could be refused by mistake.** Two writes of the hook's trigger file could collide, and the losing call was denied with an error. That was a wrongly refused call, never a double run. The writes now take turns, each with its own temp file.

## [1.0.0] - 2026-10-31

The first stable release. Its headline is **Guardrails**: an agent's irreversible actions wait for your approval, run once, and leave a receipt. The release also adds a written security model, backup and restore, and a context autopilot that compacts agents before they run out of room.

**Upgrading from a beta:**
1. Follow [docs/INSTALL.md §7b](docs/INSTALL.md#7b-upgrading): take a backup, `git pull`, `./install.sh`, restart the board.
2. `./install.sh` adds the new example files (such as `overlay/policy.json`) and never overwrites yours.
3. To turn on the new settings in an existing `overlay/config/jobs.mjs`, copy them from `examples/config/jobs.mjs`: `CONTEXT.warnPct/compactPct/forcePct` and `SETTINGS.contextAutopilot`.
4. Guardrails need their hook installed once: `scripts/guardrails-install.sh --apply [--codex]`. Then restart the agent sessions.
5. Tested versions are in [docs/VERSIONS.md](docs/VERSIONS.md). One-click upgrades come in 1.1.

### Added
- **Context autopilot.** The board compacts your agents before their context runs out, instead of the CLI's own auto-compact cutting in mid-thought.
  - At 70% it asks the agent to save its state file. At 80%, once the save has landed, it types `/compact` at the agent's next idle moment. At 90% it compacts even without a save and tells Mission Control.
  - After the compaction it tells the agent to re-read its state file and carry on with its task.
  - It never types into a busy pane, a dialog or a half-typed draft. One try per 10 minutes, and after 3 failed tries it stops and says so.
  - `SETTINGS.contextAutopilot` (`mode: 'off' | 'observe' | 'on'`, `only`, `exclude`), off in the examples. The gauge colours now follow the thresholds (amber 70, red 80).
- **Gate receipts say where you decided:** board, phone, Dock, the WAITING ON YOU strip, the CLI or a recorded pane answer (`surface` / `surfaces` on each gate; also shown in `task.sh audit`).
- **`zulu backup` / `zulu restore`.** Backup writes your ledger, state and config (`data/` + `overlay/`) to one tarball with a manifest of hashes.
  - It's lean by default: from `data/handoffs/` only text files up to 1 MB. `--full` keeps media and big exports too.
  - Every backup prints its size and what it left out.
  - Left out: the decision token, gate grants and earlier backups always; secrets unless you add `--with-secrets`.
  - Restore shows what would change and checks every hash. It refuses a backup from a newer schema; migrating an older one forward arrives with the 1.1 upgrade migrations (1.0 has one schema). `--apply` takes a safety backup first. Secrets come back only with `--with-secrets` on the restore too.
- **[docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md):** who is trusted, what the Guardrails gate stops and what it doesn't, the decision token, network exposure and secrets. The README gains a Guardrails section.
- **Guardrails: owner gates for irreversible agent actions** ([docs/GUARDRAILS.md](docs/GUARDRAILS.md)). These commands no longer run when an agent tries them: merges, pushes to protected branches or public remotes, deploys, secret changes, a guarded script's `--commit`/`--apply` run (dry run required first), outbound sends, MCP store writes, deletes outside the working tree, schedule changes and edits to the gate itself. Each waits for the owner on the ledger. The owner approves the exact call on the board or a phone: a shell command's text, or a tool's whole input such as an MCP mutation's arguments or an edit's old and new text. It runs once on a single-use grant that never leaves the board. Every attempt, decision and run is a receipt on the task (`gates[]`, `task.sh audit`), and a task can't close with a gate unresolved.
  - Claude Code and Codex, through a PreToolUse hook (`scripts/guardrails-install.sh`).
  - The policy lives in `policy.json`, rendered into `POLICY.md`, with observe mode and per-agent pilot enforcement.
  - Fail closed: if the board is down, gated calls are denied, and calls that aren't gated pass in milliseconds.
  - Demo mode shows a gate.
  - **Program go:** one owner approval of kind `program` on a task lets that task's *standing* classes run without a per-action tap, each with a receipt. By default those are merges into confirmed-private repos and local service loads. Revocable from the board or `task.sh revoke-go`; it ends at task close.
  - **Decide anywhere:**
    - a pinned *WAITING ON YOU* strip at the top of the board, the Dock view and the phone, with a "(N)" count in the tab title;
    - the count in the phosphor sidebar;
    - `task.sh gate N gK approve|decline` from the owner's own terminal (gated if an agent runs it).
  - **Judged where it runs:** each command is judged in the folder it really runs in (`cd …`, `git -C`). Outside any git repo, `rm -r` gates.
  - **Fewer false alarms:** `--help`/`--version`, and an agent cleaning its own scratch folder, aren't gated.
  - **Scripts that write without a flag** can be listed in `@guardedScripts`, which gates them on every run.
  - **Approvals reach the agent:**
    - the notice is delivered inside a busy session and can't be replaced by a later message about the same task;
    - the agent's sidebar shows `⛨ gK APPROVED — run it` until it runs;
    - approvals last 120 minutes.
    
    One that expires unused is never re-armed: the next attempt asks again and says it was approved before.

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

[Unreleased]: https://github.com/zulu-assistant/zulu-assistant/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v1.2.0
[1.0.1]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v1.0.1
[1.0.0]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v1.0.0
[0.1.0-beta.4]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.4
[0.1.0-beta.3]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.3
[0.1.0-beta.2]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.2
[0.1.0-beta.1]: https://github.com/zulu-assistant/zulu-assistant/releases/tag/v0.1.0-beta.1
