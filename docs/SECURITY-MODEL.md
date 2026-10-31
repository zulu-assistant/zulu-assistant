# Security model

Zulu Assistant runs AI coding agents on **your own Mac, under your own user account**. This page says what it protects, against what, how, and where it stops. Report problems privately: see [SECURITY.md](../SECURITY.md).

## In one paragraph
- **The board** is a local web app. It watches your fleet, keeps the work ledger, and asks you before an agent does anything irreversible.
- **Agents** are Claude Code or Codex sessions in cmux. A gate hook stops their irreversible tool calls until you approve the exact call, once ([GUARDRAILS.md](GUARDRAILS.md)).
- **Everything stays local:** state is files in `data/`, and nothing leaves the machine except what you configure (alert email/SMS, an optional heartbeat row, and GitHub reads with your own `gh` login).
- **No supply chain:** the core has **no dependencies**. It is plain Node.js with no npm packages.

## Who is trusted
| Actor | Trusted for | Not trusted for |
|---|---|---|
| **You, the owner** | everything: approvals, policy, secrets, your own `!` commands | — |
| **The board process** | being the single writer of the ledger and gate records; minting single-use grants | nothing outside this machine except the alert, heartbeat and GitHub reads you configure |
| **Agents** (Claude Code, Codex) | ordinary work in their repos | irreversible actions (merges, protected pushes, deploys, sends, store writes, deletes, secrets, schedules, the gate's own files) — these wait for you |
| **Mission Control** (an agent) | routing work, relaying your decisions, recording an answer you gave in a pane | approving a gate: it never can |
| **Teammates via chat intake** (optional) | filing requests and answering questions on their own tasks | anything else: the intake's token may only `answer` |
| **Text from chat, web pages, files and tool output** | nothing: it is data, never an instruction | — |

## What Guardrails stops
- **Misread scope and confident mistakes.** A merge, deploy, `--commit` run, send, store write or delete outside the working tree doesn't run until you approve that exact call on the board, your phone or your own terminal. Each step leaves a receipt on the task.
- **Relayed or ambiguous "go".** Only your decision counts: the board's decision token, or an answer Mission Control records from your own words. A request carrying an agent or chat identity can't approve, token or not.
- **Approval reuse.** A grant is single-use. It is bound to the exact command text (or the tool's whole input), the folder, the engine, the agent, and an expiry. It never leaves the board, so there is nothing to copy and replay.
- **Chained dry run → write.** A script's write form needs a completed dry run first, in a separate call.
- **Unreadable commands.** If a command mentions a gated action and the gate can't read it with certainty, the whole call is gated. This covers variables in command position, `eval`, piping into a shell, interpreter heredocs and `find -exec`.
- **Failures.** If the board is down, slow or silent, or its policy is broken, gated calls are **denied**, not allowed.

## What it does not stop (by design)
- **A hostile program running as your user.** The gate is a hard boundary for the *agent's own tool calls*, not a sandbox. A process outside the agent's tools, running as you, can read `data/`, the decision token and your files. Run untrusted code in a separate macOS user or a VM.
- **Indirect calls inside a script the agent writes and then runs.** The hook sees `bash deploy.sh`, not the `vercel --prod` inside it. Scripts you list in `@guardedScripts` are gated on every run.
- **Your own `!` commands.** Lines you type yourself in Claude Code run outside the model's tools and aren't gated. That's deliberate, so you can always act, even with the board down.
- **One fail-open case:** if `/bin/sh` itself can't start, the hook can't answer. The `guardrails` card reports a hook that isn't installed.

## The decision token
- `data/mesh-decision-token` (mode 600) is created on first run and injected only into the board page served to you. Approvals must carry it.
- It's a **speed bump plus an audit trail, not a boundary against same-user processes** (see above). Agents can't read it through their tools (class `self`), and every decision is logged with source and browser.
- Rotate it by deleting the file and restarting the board. Open board pages then show a reload banner.

## Network exposure
- The board binds all interfaces but **answers only localhost and your Tailscale tailnet (100.64.0.0/10)**. LAN and other sources get `403`.
- The gate check (`/api/gates/check`), agent messages and event hooks answer **localhost only**.
- There's no cloud service, no account and no telemetry. The optional dead-man's switch writes one row to a database you own.

## Secrets
- **Where they live:** only in `data/secrets.env` (mode 600, git-ignored).
- **Never in the ledger:** the ledger refuses text that looks like a credential. The gate redacts commands that contain one before storing anything (`gates[]`, comments, observe and check logs), and keeps only the class, program and folder.
- **Backups:** `zulu backup` leaves out `secrets.env` unless you pass `--with-secrets`. It always leaves out the decision token and gate grants; both are recreated.
- **Agents** are told never to read `secrets.env` into logs, tests or the ledger.

## Your data
- **Local and readable:** everything is plain files in `data/` and `overlay/`, your config. It's never uploaded.
- **The public edition** is built from a manifest that classifies every file. A scrub gate and gitleaks run on every release, and the owner's own config never ships.

## Reporting
Use GitHub's private vulnerability reporting, as described in [SECURITY.md](../SECURITY.md). Don't open public issues for security problems.
