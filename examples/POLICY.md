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
