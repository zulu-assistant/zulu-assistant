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
| **Mission Control** (an agent) | routing work, relaying your decisions, recording an answer you gave in a pane | approving anything. A "yes" it records is a proposal: it releases nothing until you confirm it on the board (`SETTINGS.paneAnswers`, `'confirm'` by default; `'direct'` gives this up) |
| **Teammates via chat intake** (optional) | filing requests and answering questions on their own tasks | anything else: the intake's token may only `answer` |
| **Text from chat, web pages, files and tool output** | nothing: it is data, never an instruction | — |

## What Guardrails stops
- **Misread scope and confident mistakes.** A merge, deploy, `--commit` run, send, store write or delete outside the working tree doesn't run until you approve that exact call with a click on the board (the phone opens the same page over your tailnet) or from your own terminal. Each step leaves a receipt on the task.
- **Relayed or ambiguous "go".** Only your decision on the board counts. An answer you gave in a pane can be recorded by an agent, and that record is a proposal: your row quotes it and names who typed it, and nothing runs, no program go starts and no plan is approved until you confirm it there. You can also throw it out as "not what I said". A request carrying an agent or chat identity can't approve, token or not. A request that carries the token and names no one is taken as yours: see the decision token, below.
- **Approval reuse.** A grant is single-use. It is bound to the exact command text (or the tool's whole input), the folder, the engine, the agent, and an expiry. It never leaves the board, so there is nothing to copy and replay. A crash or restart can't run it twice either: only an unspent grant allows a call, lost or corrupt grant state counts as no grant, and a receipt a crash left half-written is completed at startup ([crash and restart](GUARDRAILS.md#crash-and-restart)).
- **Chained dry run → write.** A script's write form needs a completed dry run first, in a separate call.
- **Unreadable commands.** If a command mentions a gated action and the gate can't read it with certainty, the whole call is gated. This covers variables in command position, `eval`, piping into a shell, interpreter heredocs and `find -exec`.
- **Failures.** If the board is down, slow or silent, or its policy is broken, gated calls are **denied**, not allowed.

## What it does not stop (by design)
- **A hostile program running as your user.** The gate is a hard boundary for the *agent's own tool calls*, not a sandbox. A process outside the agent's tools, running as you, can read `data/`, the decision token and your files. Run untrusted code in a separate macOS user or a VM.
- **Indirect calls inside a script the agent writes and then runs.** The hook sees `bash deploy.sh`, not the `vercel --prod` inside it. Scripts you list in `@guardedScripts` are gated on every run.
- **Your own `!` commands.** Lines you type yourself in Claude Code run outside the model's tools and aren't gated. That's deliberate, so you can always act, even with the board down.
- **Fail-open cases that remain:** if `/bin/sh` itself can't start, the hook can't answer. And Claude Code treats a hook that has not answered by its registered time limit as no objection, so the hook script answers "deny" itself three seconds before that limit; a machine too starved to run a shell script in fifteen seconds would still get past it. The `guardrails` card reports a hook that isn't installed.
- **A change to the gate itself that the classifier could not read.** An agent runs as you, so it can edit the gate's files, or switch the hook off from a settings file in its repo. Writes the classifier reads are held (`selfProtect`). For the rest there are two detectors, described under [the gate checks itself](GUARDRAILS.md#the-gate-checks-itself): the guardrails card compares the gate's files with what has landed and reads the settings files of every registered agent's repo, and the settings-change hook keeps such a change out of a session that is already running. Both detect or delay; neither makes the change impossible. A session that starts in a folder whose settings already switch hooks off runs ungated until you see the red card.

## The decision token
- `data/mesh-decision-token` (mode 600) is created on first run and injected only into the board page served to you. Approvals must carry it.
- It's a **speed bump plus an audit trail, not a boundary against same-user processes** (see above). The token file is guarded from agents' tools (class `self`), but the board page carries the token and a local process can fetch the page. Every decision is logged with source and browser.
- **The decision door** stands in front of it (`SETTINGS.callerEvidence.tripwire`). A decision request that an agent session is behind is refused, whatever token it carries, and Mission Control is told which agent. Set to `'browser'`, a decision made on this machine must also come from a browser or web view; an approval typed in a terminal is then kept as a row you confirm on the board, and decides nothing until you do. The door looks at the process that holds the connection, so it cannot be talked past with headers. A sender that leaves before the board can look (it exits, or resets the connection) is a kind of its own, refused under `'browser'` and logged under `'agent'`; only a lookup that could not run passes, and each such pass is logged and counted. It does not make a request yours: a background command has no session behind it, and a real browser can be driven. See [GUARDRAILS.md](GUARDRAILS.md).
- Rotate it by deleting the file and restarting the board. Open board pages then show a reload banner.
- Card actions (kickstart, restart, start, dispatch, ask the master) need it too, with no agent or intake identity on the request.

## Writes: where a request came from
- Every POST, PATCH, PUT and DELETE must be addressed to a name the board answers to (localhost, a tailnet address or `*.ts.net` name, this machine's hostname, or `SETTINGS.allowedHosts`). This stops a page on another site that points its own hostname at your machine.
- A write with an `Origin` header must come from the board's own page. Another site's page gets a 403, with or without the token. A write with no `Origin` (curl, the hook, scripts, the chat intake) passes.
- Bodies must be declared as JSON. A cross-site form cannot send that without the browser asking first.
- Reads are not covered by these checks. The source guard (this machine and the tailnet only) still applies to everything.

## Sender names
- Agent names are self-declared, and the board now checks them against something an agent does not choose: the process that made the call.
  - **How:** the client's source port names the process (`lsof`); its ancestry leads to the agent session; cmux's own session map says which workspace that session is. The topmost session in the chain counts, so a child started with another workspace id in its environment is still its parent.
  - **`mode: 'observe'` (the shipped setting):** the evidence is recorded next to the declared name (the guardrails check log, the server log) and a mismatch between two agents reaches the ticker as `[caller mismatch]`. Nothing is refused on names. Read these lines for a week before you turn it up: they show every caller whose name the process does not back.
  - **The lookup runs before the answer goes out.** A command-line caller exits the moment it has its answer, and a lookup started after that finds nobody. So a ledger or mesh write waits for it: about 160 ms, and never longer than the lookup's own limit of 3 seconds.
  - **`mode: 'on'` (names enforced):** a name the calling process does not back earns none of that name's standing.
    - Its words still go out, marked. A message is delivered as from an `UNVERIFIED sender`. A new task and a comment are recorded, with a board comment that says the caller was not verified and why. Nothing is dropped.
    - Every other ledger step is refused with a 403 that says what to do: claim, start, close, reassign, set a gate focus, and Mission Control's steps (recording a pane answer included).
    - The gate hook's identity comes from the evidence, not from the workspace id the hook sends. A child session started under an observed agent's workspace id is judged as the session that started it.
    - A lookup that fails proves nothing. The name is unverified, and a hook call is enforced whatever it declared.
    - The owner's name still needs the decision token, and is not accepted from a process an agent session is behind.
  - **What it cannot be fooled by:** an agent cannot change its own running session's start environment, or make a child count as another session.
  - **What it does not prove:** a process with no session in its chain (a background job, a plain terminal) resolves to nobody. That is never taken as "the owner". Being the owner is the decision token, and nothing else in this release.
  - **What `'on'` still leaves open:** the decision token says "someone on this machine", no more. A detached process that has read it can sign a message as the owner (`--signed`), and the words reach panes as the owner's. Gated actions still need a decision on the board page. An owner-held key is what would close this.
  - Nothing is issued to agents, so there is no per-agent secret to steal, and a restored session needs nothing given back.
- Two names are reserved because agents act on them. The owner's name counts only with the decision token (the board page, or `--signed` from your own shell) or from a listed person through the chat intake. `board` counts only from the board's own process.
- A message that claims a reserved name without proof is delivered, marked `UNVERIFIED sender`, and the ledger records it as a board comment that says so. It is never dropped.
- `--signed` reads the token file. An agent that runs the ledger or mesh CLI with it is held by the gate (class `self` in the shipped policy). Beyond that it is as strong as the token: not a boundary against a process running as you.
- Text from outside (a chat request, a GitHub issue title) is never typed into a pane. The wake carries the task id and the source; the agent reads the text from the ledger as quoted data.

## Network exposure
- The board binds all interfaces but **answers only localhost and your Tailscale tailnet (100.64.0.0/10)**. LAN and other sources get `403`.
- The gate check (`/api/gates/check`), agent messages and event hooks answer **localhost only**.
- There's no cloud service, no account and no telemetry. The optional dead-man's switch writes one row to a database you own.

## Secrets
- **Where they live:** the credentials you supply are only in `data/secrets.env` (mode 600, git-ignored). The board generates three more, also mode 600 in `data/`: `cmux-socket-password`, `mesh-decision-token` and `intake-token`. The optional phone relay keeps its server's user database and the phone's token in `data/relay/`.
- **Never in the ledger:** the ledger refuses text that looks like a credential. The gate redacts commands that contain one before storing anything (`gates[]`, comments, observe and check logs), and keeps only the class, program and folder.
- **Backups:** `zulu backup` leaves out credentials by rule, not by a list of names: a folder marked `.nobackup` (the phone relay's folder) is skipped whole and never restored into; a file only you can read (mode 600) is left out unless it is in one of the board's own state folders; a small file whose text looks like a key is left out. `--with-secrets` includes the last two, never a marked folder. It always leaves out the decision token and gate grants; both are recreated. Details: [INSTALL.md](INSTALL.md), Rollback.
- **Agents** are told never to read `secrets.env` into logs, tests or the ledger.

## Your data
- **Local and readable:** everything is plain files in `data/` and `overlay/`, your config. It's never uploaded.
- **The public edition** is built from a manifest that classifies every file. A scrub gate and gitleaks run on every release, and the owner's own config never ships.

## Reporting
Use GitHub's private vulnerability reporting, as described in [SECURITY.md](../SECURITY.md). Don't open public issues for security problems.
