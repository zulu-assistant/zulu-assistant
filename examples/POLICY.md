# POLICY.md — Mission Control approval policy (<OWNER>-owned)

> Zulu Assistant example. Copy to `overlay/POLICY.md` and edit. Mission Control
> re-reads this file before every approval, so edits take effect immediately.

Mission Control may approve a worker/resident permission prompt ONLY if it
matches the ALLOW list. Everything on the ESCALATE list — and anything not
listed at all — goes to <OWNER>.

## ALLOW (Mission Control may approve on a worker's behalf)
- Read-only operations: file reads, greps, `git status/log/diff`, `ls`,
  `curl` GETs to localhost services and public docs.
- Read-only third-party API **queries** that are free and cannot write. The
  matching write verbs stay ESCALATE. **Metered reads are not covered** —
  anything billed per call falls under "Anything PAID".
- File edits inside the worker's own repo working tree.
- `git add/commit`, and `git push` to <OWNER>'s private repos.
- `launchctl kickstart` of jobs that are NOT paid/outbound (list your paid or
  outbound job labels here: <PAID_OR_OUTBOUND_LABELS>).
- `npm install` / `pip install` inside a project directory.
- Running the project's own test/build/lint commands.
- Syntax checks and local dev servers on unclaimed ports (never the board's
  port, 3210 by default).

## ESCALATE (always <OWNER>, no exceptions)
- Anything PAID: metered APIs, shipping labels, SMS, bulk LLM/API jobs, ads.
- Anything OUTWARD-FACING: sending email or SMS, writes to production stores or
  customer data, publishing/deploying to production, social posts, DNS.
- Deletes beyond a repo's working tree (rm -rf outside the repo, dropping DB
  tables, emptying trash, bulk file deletion anywhere).
- System/security config: launchd plist installs/removals, cron, System
  Settings, keychain, credentials of any kind.
- New standing rules: mail filters, webhooks, scheduled jobs, integrations.
- Anything touching funds, trading or exchange APIs.
- Any prompt whose wording is ambiguous about scope or blast radius.

<!-- gates:begin (generated from policy.json by scripts/policy-render.mjs — edit the JSON, not this block) -->

## ENFORCED GATES (the system holds these, not the model)

Mode: **enforce**. A gated call does not run: it waits on the owner on the ledger, runs once on approval (within 120 min), and leaves a receipt on the task.

- **merge** — Merge a pull request · *standing: a program go on the task approves it (receipt kept)*
  - `gh pr merge`
- **push** — Push to a protected branch or public remote, force-push, push tags or delete a ref
  - `git push` to `main`/`master`, forced, tags, ref deletes, any push to @publicRemotes or @deployOnPush (free: `checkpoint/*` and feature branches)
- **deploy** — Deploy to production, or touch a paid/outbound job
  - `vercel` (not `env ls`, `ls`, `whoami`, `logs`, `inspect`, `list`)
  - `launchctl` with `bootstrap` / `bootout` / `load` / `unload` / `enable` / `disable` / `kickstart` of a label in @paidOrOutbound
  - `shopify` with `deploy` / `push` / `publish`
- **deploy-local** — Load or unload a service on this machine · *standing: a program go on the task approves it (receipt kept)*
  - `launchctl` with `bootstrap` / `bootout` / `load` / `unload` / `enable` / `disable` of a label not in @paidOrOutbound
- **upgrade** — Upgrade or roll back this install
  - `zulu upgrade` (not with `--check`)
  - `zulu rollback`
  - a script in `**/upgrade.mjs` (not with `--check`)
  - a script in `**/install.sh` run as `… upgrade` (not with `--check`)
  - a script in `**/install.sh` run as `… rollback`
- **env** — Change production configuration or secrets
  - `gh secret` with `set` / `delete`
  - `gh variable` with `set` / `delete`
- **guarded** — Run a script on the guarded list (it writes without a flag)
  - a script in @guardedScripts (not with @dryFlags)
- **write** — A guarded script's write form · *dry run first, in the same task*
  - a script with `--commit` / `--apply` / `--write` / `--execute` / `--confirm` / `--activate` / `--live` / `--send` / `--go`
- **outbound** — Send a message or post outside the system
  - `curl` POST to `slack.com/api/chat.` / `slack.com/api/files.` / `api.twilio.com` / `a.klaviyo.com/api/campaign-send`
  - MCP tool `^mcp__.*__(send_message|reply|forward)$`
- **store** — Write to the store through an MCP tool
  - MCP tool `^mcp__.*Shopify__(graphql_mutation|create-.*|update-.*|set-inventory|bulk-.*|add-to-collection|publish-.*|upload-.*)$`
- **delete** — Delete outside the working tree, drop data, delete repos
  - `rm` with `-r` / `-R` / `--recursive` outside the working tree (or on a glob/variable path)
  - `find` with `-delete` / `-exec` / `-execdir` / `-ok` / `-okdir` outside the working tree (or on a glob/variable path)
  - SQL that drops or truncates a table/schema/database
  - `gh repo delete`
  - `git clean` with `-x` / `-X` (not with `-n` / `--dry-run`) · *check `selfProtect`*
- **schedule** — Change scheduled jobs
  - `crontab` (not with `-l`)
  - writing ~/Library/LaunchAgents/**
- **self** — Change or read the gate itself
  - reading or writing @guardSecrets
  - writing @guardConfig
  - a command containing `gate_decide` / `x-mesh-decision`
  - a script in `**/task.sh` run as `… gate`
  - a script in `**/mesh-cli.mjs` run as `… task gate`
  - a script in `**/task.sh` with `--signed`
  - a script in `**/agent-send.sh` with `--signed`
  - a script in `**/mesh-cli.mjs` with `--signed`
  - a script in `**/install.sh` with `--guardrails` (not with `--dry-run`)
  - a script in `**/install.sh` run as `… guardrails` (not with `--dry-run`)
  - `zulu` with `--guardrails` (not with `--dry-run`)
  - `zulu guardrails` (not with `--dry-run`)
  - writing @gateCode, @guardGate (an edit, a redirect, or a program that writes its target) · *check `selfProtect`*
  - `git config` naming `core.` / `alias.` / `--global` / `--system` / `--file` / `-f` / `--edit` / `-e` / `remote.` / `url.` / `branch.` / `include` / `filter.` / `diff.` / `merge.` / `pager.` / `credential.` / `http.` / `protocol.` / `submodule.` / `gpg.` / `sequence.` / `interactive.` / `uploadpack.` / `receive.` / `fetch.` / `pull.` / `init.` / `safe.` / `extensions.` (a write; reading is free) · *check `selfProtect`*
  - `git` naming `core.hookspath=` / `alias.` as a `-c` setting for one call · *check `selfProtect`*
  - `git` with `update-ref` / `symbolic-ref` / `fetch` / `push` naming `refs/remotes/` / `refs/heads/main` / `refs/heads/master` / `refs/heads/origin/` / `refs/tags/origin/` / `refs/replace/` (moving the local copy of a remote branch) · *check `selfProtect`*
  - `git remote` with `set-url` / `add` / `rename` / `remove` / `rm` / `set-head` / `set-branches` · *check `selfProtect`*
  - `git` with `pull` / `merge` / `rebase` / `cherry-pick` / `revert` / `apply` / `am` / `checkout` / `switch` / `reset` / `stash` / `restore` / `branch` / `rm` / `mv` / `read-tree` / `bisect` / `fetch` / `tag` / `update-ref` / `symbolic-ref` / `update-index` / `checkout-index` / `clean` / `submodule` / `replace` in the live checkout, when it can leave a gate file holding something that has not landed (free: a fast-forward of the default branch from origin, a stash, a restore from the index) · *check `selfProtect`*
  - `kill` aimed at the board · *check `selfProtect`*
  - `pkill` aimed at the board · *check `selfProtect`*
  - `killall` aimed at the board · *check `selfProtect`*
  - `xargs` with `kill` aimed at the board · *check `selfProtect`*
  - `launchctl` with `kill` / `stop` / `remove` / `reboot` aimed at the board · *check `selfProtect`*
  - `fuser` aimed at the board · *check `selfProtect`*
  - `kill-port` aimed at the board · *check `selfProtect`*
  - `reboot` aimed at the board · *check `selfProtect`*
  - `shutdown` aimed at the board · *check `selfProtect`*
  - `halt` aimed at the board · *check `selfProtect`*
  - `poweroff` aimed at the board · *check `selfProtect`*
  - `osascript` naming `restart` / `shut down` / `shutdown` / `log out` / `logout` aimed at the board · *check `selfProtect`*

Checks (off | observe | enforce; a rule marked with a check applies only when that check is `enforce`, and `observe` only logs what it would hold): `inlineBodies` observe, `renamedBins` observe, `selfProtect` observe

Lists:
- @dryFlags: `--dry-run`, `-n`, `--check`, `--plan`
- @guardSecrets: `<repo>/data/guardrails/**`, `<repo>/data/mesh-decision-token`
- @guardConfig: `<repo>/overlay/policy.json`, `<repo>/policy.json`, `<repo>/examples/policy.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`
- @gateCode: `<live>/scripts/gate-hook.sh`, `<live>/scripts/gate-hook.mjs`, `<live>/scripts/gate-triggers.default`, `<live>/scripts/guardrails-install.sh`, `<live>/scripts/merge-hooks.mjs`, `<live>/scripts/env.sh`, `<live>/src/gates.mjs`, `<live>/src/gate-service.mjs`, `<live>/src/gate-ledger.mjs`, `<live>/src/request-guard.mjs`, `<live>/src/guard.mjs`, `<live>/src/caller.mjs`, `<live>/src/tasks.mjs`, `<live>/src/config.mjs`, `<live>/server.mjs`, `<live>/public/**`, `<live>/src/gate-integrity.mjs`, `<live>/scripts/gate-config-hook.sh`, `<live>/scripts/gate-config-hook.mjs`
- @guardGate: `<live>/overlay/config/agents.json`, `<live>/config/agents.json`, `<live>/data/local.env`, `<live>/data/tasks/**`, `**/.claude/settings.json`, `**/.claude/settings.local.json`, `~/.claude.json`, `~/.codex/config.toml`, `**/.codex/hooks.json`, `/Library/Application Support/ClaudeCode/**`, `/etc/codex/**`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.zlogin`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`, `~/.gitconfig`, `**/.git/hooks/**`, `**/.git/config`, `<live>/.git/HEAD`, `<live>/.git/index`, `<live>/.git/refs/**`, `<live>/.git/packed-refs`, `<live>/.git/info/**`, `<live>/.gitattributes`, `~/.config/cmux/**`, `~/.cmuxterm/claude-hook-sessions.json`, `~/.cmuxterm/codex-hook-sessions.json`

Anything that would need a gate but cannot be read with certainty is gated as **opaque**.
A **program go** (the owner's approval of a task's plan, kind `program`) approves the *standing* classes on that task only — merges only into private repos outside @publicRemotes/@deployOnPush — until it is revoked (`task.sh revoke-go N`) or the task closes. Every other class asks per action.

<!-- gates:end -->
