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
- **schedule** — Change scheduled jobs
  - `crontab` (not with `-l`)
  - writing ~/Library/LaunchAgents/**
- **self** — Change or read the gate itself
  - reading or writing @guardSecrets
  - writing @guardConfig
  - a command containing `gate_decide` / `x-mesh-decision`
  - a script in `**/task.sh` run as `… gate`
  - a script in `**/mesh-cli.mjs` run as `… task gate`

Lists:
- @dryFlags: `--dry-run`, `-n`, `--check`, `--plan`
- @guardSecrets: `<repo>/data/guardrails/**`, `<repo>/data/mesh-decision-token`
- @guardConfig: `<repo>/overlay/policy.json`, `<repo>/policy.json`, `<repo>/examples/policy.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`

Anything that would need a gate but cannot be read with certainty is gated as **opaque**.
A **program go** (the owner's approval of a task's plan, kind `program`) approves the *standing* classes on that task only — merges only into private repos outside @publicRemotes/@deployOnPush — until it is revoked (`task.sh revoke-go N`) or the task closes. Every other class asks per action.

<!-- gates:end -->
