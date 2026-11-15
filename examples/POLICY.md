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
- **engine-start** — Start an agent session the gate may not see
  - `claude` · *check `engineStart`*
  - `codex` · *check `engineStart`*
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
  - MCP tool `^mcp__.*__(.*_)?(send|reply|forward|schedule)(_.*)?$` · *check `mcpDefault`*
  - MCP tool `^mcp__.*__.*post-(create|update)$` · *check `mcpDefault`*
  - MCP tool `^mcp__.*__slack_(add_reaction|create_conversation|complete_file_upload|create_canvas|update_canvas|add_list_record|update_list_record|create_list|update_list)$` · *check `mcpDefault`*
- **store** — Write to the store through an MCP tool
  - MCP tool `^mcp__.*Shopify__(graphql_mutation|create-.*|update-.*|set-inventory|bulk-.*|add-to-collection|publish-.*|upload-.*)$`
  - MCP tool `^mcp__.*Shopify__(switch-shop|upload[-_].*|import-.*|set-.*)$` · *check `mcpDefault`*
- **desktop** — Drive the desktop or a browser (click, type, run page script) · *standing: a program go on the task approves it (receipt kept)*
  - MCP tool `^mcp__(.*[-_])?computer[-_]use__(?!(screenshot|zoom|cursor_position|list_granted_applications|read_clipboard)$).+$` · *check `desktop`*
  - MCP tool `^mcp__cmux-cua__(click|double_click|right_click|type_text|press_key|hotkey|drag|scroll|launch_app|kill_app|set_value|perform_actions)$` · *check `desktop`*
  - MCP tool `^mcp__claude-in-chrome__(computer|navigate|form_input|javascript_tool|file_upload|browser_batch)$` · *check `desktop`*
  - `cmux browser` that clicks, types or runs script in a browser panel, or points one at this board (reading a panel is free) · *check `desktop`*
  - `osascript` that scripts the interface (System Events) or runs script in a browser page · *check `desktop`*
  - `cliclick` · *check `desktop`*
  - `open` naming `--remote-debugging` · *check `desktop`*
- **panes** — Type into another pane, or start a terminal with a command
  - `cmux` with `send` / `send-key` aimed at a pane other than the caller's own (not Mission Control) · *check `paneReach`*
  - `cmux` with `new-split` / `new-pane` / `new-surface` / `new-workspace` with a command to run (not Mission Control) · *check `paneReach`*
  - `tmux` with `send-keys` (not Mission Control) · *check `paneReach`*
- **remote-write** — Change something in a remote account or service
  - MCP tool `^mcp__.*__(.*[-_])?(create|update|edit|delete|trash|untrash|remove|share|copy|transition|add|apply|mark|unmark|label|unlabel)([-_].*)?$` · *check `mcpDefault`*
  - MCP tool `^mcp__.*__batch$` · *check `mcpDefault`*
  - MCP tool `^mcp__.*__(create|edit|update|delete|remove|transition|add|set|send|post|publish|share|trash)[A-Z].*$` · *check `mcpDefault`*
  - `gh api` with a write method, fields, or a graphql mutation · *check `remoteWrite`*
  - `curl` to `api.github.com` with a write method or a body · *check `remoteWrite`*
  - `gh workflow run` · *check `remoteWrite`*
  - `gh workflow enable` · *check `remoteWrite`*
  - `gh workflow disable` · *check `remoteWrite`*
  - `gh release create` · *check `remoteWrite`*
  - `gh release delete` · *check `remoteWrite`*
  - `gh release edit` · *check `remoteWrite`*
  - `gh pr close` · *check `remoteWrite`*
  - `gh pr ready` · *check `remoteWrite`*
  - `gh issue close` · *check `remoteWrite`*
  - `gh issue delete` · *check `remoteWrite`*
  - `gh gist create` · *check `remoteWrite`*
  - `gh gist edit` · *check `remoteWrite`*
  - `gh repo create` with `--public` · *check `remoteWrite`*
  - `gh pr review` · *check `remoteWrite`*
  - `gh pr comment` · *check `remoteWrite`*
  - `gh issue comment` · *check `remoteWrite`*
  - `gh issue create` · *check `remoteWrite`*
  - `gh pr create` · *check `remoteWrite`*
  - `gh pr edit` · *check `remoteWrite`*
  - `gh issue edit` · *check `remoteWrite`*
  - `gh repo edit` · *check `remoteWrite`*
  - `gh repo archive` · *check `remoteWrite`*
  - `gh repo rename` · *check `remoteWrite`*
  - SQL that updates, deletes, inserts or alters · *check `remoteWrite`*
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
  - a script in `<repo>/install.sh`
  - `zulu`
  - a script in `<repo>/scripts/bootstrap.sh` run as `… install` (not with `--dry-run`)
  - writing @gateCode, @guardGate (an edit, a redirect, or a program that writes its target) · *check `selfProtect`*
  - `git config` naming `core.` / `alias.` / `--global` / `--system` / `--file` / `-f` / `--edit` / `-e` / `remote.` / `url.` / `branch.` / `include` / `filter.` / `diff.` / `merge.` / `pager.` / `credential.` / `http.` / `protocol.` / `submodule.` / `gpg.` / `sequence.` / `interactive.` / `uploadpack.` / `receive.` / `fetch.` / `pull.` / `init.` / `safe.` / `extensions.` (a write; reading is free) · *check `selfProtect`*
  - `git` naming `core.hookspath=` / `alias.` as a `-c` setting for one call · *check `selfProtect`*
  - `git` with `update-ref` / `symbolic-ref` / `fetch` / `push` naming `refs/remotes/` / `refs/heads/main` / `refs/heads/master` / `refs/heads/origin/` / `refs/tags/origin/` / `refs/replace/` (moving the local copy of a remote branch) · *check `selfProtect`*
  - `git remote` with `set-url` / `add` / `rename` / `remove` / `rm` / `set-head` / `set-branches` · *check `selfProtect`*
  - `git` with `pull` / `merge` / `rebase` / `cherry-pick` / `revert` / `apply` / `am` / `checkout` / `switch` / `reset` / `stash` / `restore` / `branch` / `rm` / `mv` / `read-tree` / `bisect` / `fetch` / `tag` / `update-ref` / `symbolic-ref` / `update-index` / `checkout-index` / `clean` / `submodule` / `replace` / `sparse-checkout` in the live checkout, when it can leave a gate file holding something that has not landed (free: a fast-forward of the default branch from origin, a stash, a restore from the index) · *check `selfProtect`*
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
  - `gh alias set` · *check `selfProtect`*
  - `gh alias import` · *check `selfProtect`*
  - `gh repo set-default` (not with `--view` / `-v`) · *check `selfProtect`*

Checks (off | observe | enforce; a rule marked with a check applies only when that check is `enforce`, and `observe` only logs what it would hold): `inlineBodies` observe, `renamedBins` observe, `selfProtect` observe, `mcpDefault` observe, `remoteWrite` observe, `desktop` observe, `paneReach` observe, `runners` observe, `engineStart` observe

Lists:
- @dryFlags: `--dry-run`, `-n`, `--check`, `--plan`
- @guardSecrets: `<repo>/data/guardrails/**`, `<repo>/data/mesh-decision-token`
- @guardConfig: `<repo>/overlay/policy.json`, `<repo>/policy.json`, `<repo>/examples/policy.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`
- @gateCode: `<live>/scripts/gate-hook.sh`, `<live>/scripts/gate-hook.mjs`, `<live>/scripts/gate-triggers.default`, `<live>/scripts/guardrails-install.sh`, `<live>/scripts/merge-hooks.mjs`, `<live>/scripts/env.sh`, `<live>/src/gates.mjs`, `<live>/src/gate-service.mjs`, `<live>/src/gate-ledger.mjs`, `<live>/src/request-guard.mjs`, `<live>/src/guard.mjs`, `<live>/src/caller.mjs`, `<live>/src/tasks.mjs`, `<live>/src/config.mjs`, `<live>/server.mjs`, `<live>/public/**`, `<live>/src/gate-integrity.mjs`, `<live>/scripts/gate-config-hook.sh`, `<live>/scripts/gate-config-hook.mjs`, `<live>/src/receipt-chain.mjs`, `<live>/src/row-context.mjs`, `<live>/src/private-file.mjs`, `<live>/src/secret-text.mjs`, `<live>/src/profile.mjs`, `<live>/src/completion-packet.mjs`, `<live>/src/upgrade.mjs`, `<live>/src/worktree.mjs`
- @guardGate: `<live>/overlay/config/agents.json`, `<live>/config/agents.json`, `<live>/data/local.env`, `<live>/data/tasks/**`, `**/.claude/settings.json`, `**/.claude/settings.local.json`, `~/.claude.json`, `~/.codex/config.toml`, `**/.codex/hooks.json`, `/Library/Application Support/ClaudeCode/**`, `/etc/codex/**`, `~/.zshrc`, `~/.zshenv`, `~/.zprofile`, `~/.zlogin`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.profile`, `~/.gitconfig`, `**/.config/git/config`, `**/.git/hooks/**`, `**/.git/config`, `<live>/.git/HEAD`, `<live>/.git/index`, `<live>/.git/refs/**`, `<live>/.git/packed-refs`, `<live>/.git/info/**`, `<live>/.gitattributes`, `~/.config/cmux/**`, `~/.cmuxterm/claude-hook-sessions.json`, `~/.cmuxterm/codex-hook-sessions.json`, `~/.cmuxterm/claude-settings/**`

Anything that would need a gate but cannot be read with certainty is gated as **opaque**.
A **program go** (the owner's approval of a task's plan, kind `program`) approves the *standing* classes on that task only — merges only into private repos outside @publicRemotes/@deployOnPush — until it is revoked (`task.sh revoke-go N`) or the task closes. Every other class asks per action.

<!-- gates:end -->
