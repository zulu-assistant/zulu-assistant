# Guardrails: owner gates for irreversible agent actions

**What it is.** When an agent tries something irreversible (merging a pull request, pushing to `main`, deploying, a script's `--commit` run, sending a message, a store write, a delete outside its working tree), the command **does not run**. It waits for the owner on the ledger. One approval, from the board or a phone, lets **that exact command** run **once**. Every step (attempt, decision, run) leaves a receipt on the task.

**What it is not.** It is a hard stop for the agent's own tool calls (Bash, MCP tools, edits of the gate's files), in Claude Code and in Codex. It is **not** a sandbox against a hostile program running as your user. A script the agent writes and then runs can call `gh` inside it, and the hook only sees `bash deploy.sh`. One case fails open: if `/bin/sh` itself cannot start, the hook can't answer and the tool call runs; the `guardrails` card reports a missing hook. The realistic failures it stops:
- a model misreading scope;
- a relayed or ambiguous "go";
- a dry run chained into `--commit`;
- a confident wrong merge.

## How a gate goes
1. An agent runs a gated command. The **PreToolUse hook** (`scripts/gate-hook.sh`) stops it before it runs.
2. The hook asks the board (`POST /api/gates/check`). The board classifies the call with **its** policy and files a gate on the agent's current task. The task goes to *needs approval*, the owner gets a desktop notice, and the agent is told: `GATE: … Waiting on the owner, task #N (gate gK). You'll be woken when they decide; do not retry it or work around it.`
3. The owner opens the WORK panel (the phone works over your tailnet). Each gate row shows the **full command, folder, agent and age**, wrapped, with **✓ RUN ONCE / ✕ DECLINE**. A non-shell call shows the tool and its whole input: an MCP call's arguments, an edit's old and new text. The row shows up to 1,500 characters; the task keeps up to 20,000 (`task.sh audit N --json`). Like every board decision, it takes two clicks.
4. **Approve:** the board mints a **single-use grant**. The grant is bound to a hash of the exact call (folder + tool + engine + the shell command's text, or for any other tool its **whole input** as canonical JSON), the agent and an expiry (120 min by default). So a grant for one Shopify mutation can't run a different mutation, and a grant for one edit of a file can't make a different edit. It stays in `data/guardrails/grants.json` (mode 600) and is never sent anywhere: not to the agent, the page, a log or the ledger.
   - **The notice always arrives.** The agent is woken (`GATE gK on #N APPROVED — run exactly: …`). That notice is delivered inside a busy session, and no later message about the same task can replace it in the queue. Until it runs, the agent's sidebar label leads with `⛨ gK APPROVED — run it`.
   - **It runs once.** The agent re-runs the command; the hook finds the grant, consumes it and lets the call through. Any change to the command is a new gate. So is running it a second time, and so is the same command from another folder or agent.
   - **Unused approvals expire.** An approval that expires before it ran is never re-armed: the next attempt asks again. That row says *↻ you approved this exact call at 13:52Z (g8); it expired before it ran*, and the agent is told so.
5. **Decline:** the agent is told not to retry. A re-attempt is counted on the gate, and the task can't close until that is waived with a reason.
6. **Receipts:** `gates[]` on `GET /api/tasks/N`, one ledger comment per step (`GATE g1 requested · merge · gh pr merge 38 … / APPROVED by <owner> (board, phone/tailnet) / executed 11:42:07Z (single use)`), and `task.sh audit N` (add `--json` for the raw records).
   - Each decision also records where it was made: `surface` is one of `board` (the WORK panel), `phone` (over the tailnet), `dock` (the `?dock=1` view), `strip` (the pinned WAITING ON YOU strip), `cli` (`task.sh gate`) or `pane` (an answer Mission Control recorded). `surfaces` lists every one that applies, e.g. a phone tap in the strip.
   - `phone` comes from the request's network address, so the page can't claim it.
   - This is a receipt only: it never changes who may decide.

**Where the owner decides:**
- **The board.** While anything waits, a pinned **WAITING ON YOU** strip sits at the top of the board, the Dock view (`?dock=1`) and the phone. It shows pending gates and approval requests, oldest first, with the same two-click buttons. The tab title shows the count, `(2) Zulu Assistant`. The phosphor sidebar can't make network calls, so it shows the count instead: `⛨ 2 GATES · #343 …` leads that agent's progress label.
- **The owner's terminal:** `task.sh gate N gK approve|decline ["reason"]`. It uses the board's decision token from `data/mesh-decision-token` and is recorded as `(cli)`. In Claude Code a `!` line is yours and isn't gated. An *agent* running the same command is gated (class `self`), so it can't approve its own gate.
- **In a pane:** if the owner answered there, **Mission Control** records it with `task.sh gate-approved N gK "<what was said, when>"` (or `--decline`). The gated agent can't record an approval of its own gate; it asks Mission Control.

A chat message never approves. Neither does anything the agent itself sends: a `gate_decide` request that carries an agent or intake identity is refused, decision token or not.

**Verified 2026-10-31** (pilot, task #343): an approved gate runs with no further prompt in both **acceptEdits** sessions and **auto-mode** workers. The hook's `allow` is honoured by Claude Code's permission system and its auto-mode check alike.

## What is gated (default policy)
The policy is `policy.json`: `overlay/policy.json` for your own rules, else `examples/policy.json`. `POLICY.md` carries a generated, human-readable block of it (`node scripts/policy-render.mjs --write POLICY.md policy.json`; a test fails when the two drift).

| class | gated | free |
|---|---|---|
| merge *(standing)* | `gh pr merge` (the row names the PR: title, branches, repo) | `gh pr view/list/create`, `--help` |
| push | `git push` to `main`/`master`, `--force`/`-f`/`+ref`, tags, `:ref` deletes, any push to a `@publicRemotes` or `@deployOnPush` repo | feature branches, `checkpoint/*` |
| deploy | `vercel` (not `ls/whoami/logs/inspect/env ls`), any `launchctl` load/unload/kickstart of a `@paidOrOutbound` label, `shopify deploy/push/publish` | — |
| deploy-local *(standing)* | `launchctl bootstrap/bootout/load/unload/enable/disable` of any other label (a service on this machine) | kickstarts, `launchctl print` |
| env | `gh secret set/delete`, `gh variable set/delete` | listing |
| guarded | any run of a script on `@guardedScripts`, for scripts that write without a flag (e.g. a theme updater) | runs with a `@dryFlags` flag (`--dry-run`, `-n`, `--check`, `--plan`) |
| write | a script run with `--commit --apply --write --execute --confirm --activate --live --send --go`: **dry run first** | the same script without the flag |
| outbound | `curl` POSTs to chat/SMS/email-send APIs; MCP `…send_message/reply/forward` | drafts, GETs |
| store | MCP Shopify mutations, `create-*`, `update-*`, `set-inventory`, `bulk-*`, … | MCP reads and queries |
| delete | `rm -r` outside the git working tree the command runs in (anywhere, if it runs outside a repo; or on a glob/variable/`~` path), `DROP/TRUNCATE` via SQL tools, `gh repo delete` | `rm -rf build` inside the repo; the agent's own scratch space (`/tmp/claude-*/…`, `$TMPDIR/claude-*/…`, also via a variable assigned in the same command) |
| schedule | `crontab` (not `-l`), writing `~/Library/LaunchAgents/` | reading them |
| self | reading `data/guardrails/**` or the decision token; writing `policy.json`, `~/.claude/settings.json`, `~/.codex/hooks.json`; a command that can send (`curl`, `wget`, `node`, `python3`, `osascript`, …) and contains `gate_decide`; an agent running `task.sh gate …` | reading your settings; `grep`/`cat`/`sed` of the gate's own source |

**Help is free:** `--help`, `-h`, `--version` and `help` on a gated program (`gh`, `git`, `vercel`, `launchctl`, `shopify`, `crontab`) print usage and change nothing, so they aren't gated. That never applies to scripts or to anything opaque.

**Where a command runs:** each command is judged in the folder it actually runs in. That means the hook's folder, then every literal `cd` before it in the same chain (a subshell's `cd` stays inside the subshell), then `git -C`. So `cd /elsewhere && rm -rf build` is judged in `/elsewhere`, and `git -C ~/site push` checks `~/site`'s remote. After a `cd` the gate can't resolve (`cd "$X"`, `cd -`), path- and repo-dependent rules ask instead of guessing.

**Opaque:** if a command mentions a gated action and the gate can't read it with certainty, the whole call is gated as `opaque`. Examples: `$BIN pr merge`, `eval …`, `… | sh`, `xargs gh pr merge`, an interpreter heredoc that runs `gh`, an unterminated quote. The parser keeps one invariant, and tests pin it: every trigger hit is either attributed to a command it recognised (then gated or cleared) or the call is opaque. A hit is never dropped.

**Dry run first** (`requireDryRun`, class `write`):
- The write form is refused (`run the dry form first: python3 scripts/archive.py`) until that exact command without its write flag has **run to completion** by the same agent, after the last time the write form ran.
- The first refusal also adds the script to the hook's watch list, so its dry runs are recorded from then on.
- A dry run chained into the write in one call (`x.py && x.py --commit`) never counts.
- The approval row shows when the dry run finished.

## Standing approval: a program go
Approving every merge after you've already said "go ahead with this" is noise. So one approval can cover a whole task:
- **Asking:** the agent runs `task.sh approve-request N --policy "<what the program is>" --program`.
- **Granting:** you approve it on the WORK panel. An answer you give in the pane is recorded with `task.sh approved-in-pane N "…"`.
- **What it covers:** gates of a **standing** class (`"standing": true` in `policy.json`) run **at once** on that task, with no tap, and each one still leaves a receipt: `GATE g3 auto-approved under program go go1 · merge · gh pr merge 41 …` plus a ticker line. By default the standing classes are:
  - **merge**, but only into a repo that GitHub confirms is **private** and that is in neither `@publicRemotes` nor `@deployOnPush`. If the repo is unknown or unconfirmed, the merge asks per action.
  - **deploy-local**: loading or unloading a service on this machine (not a `@paidOrOutbound` one).
- **What it never covers:** production deploys, secrets, store writes, sends, protected or public pushes, deletes, schedule changes and the gate itself always ask per action.
- **How it ends:** you revoke it with **⊘ REVOKE GO** on the task's row, or the task owner runs `task.sh revoke-go N`. It also ends when the task closes. It never carries over to another task.

## Which task a gate lands on
1. The agent's **focus**. `task.sh focus N` sets it by hand. `task.sh claim|start N` sets it too, but never over a focus the agent set by hand on a task that is still live.
2. Else its single live task.
3. With **no** live task, a new task `GATE: <class> — <command>` owned by the agent. An unregistered session's gate lands on mission control.
4. With **two or more** live tasks and no focus, the call is refused: `set it first: task.sh focus <N>`. The receipt must land on the right task.

## Fail closed
| condition | a gated call | anything else |
|---|---|---|
| board down or slow | **denied** ("board unreachable — fail closed"). The hook decides locally from the policy file, honoring `mode` and `enforceFor` (it looks the agent up in the mesh directory), so an observed agent isn't blocked. An agent it can't identify is treated as enforced. Each request carries the hook's deadline, so a board that only gets to it later (frozen, overloaded) drops it instead of filing a gate nobody was told about | untouched |
| the Node step prints nothing | **denied**: "not gated" must be said explicitly (exit 3), so silence is never an allow | untouched |
| the policy's fingerprint version changes (an upgrade) | a gate filed before it and approved after it still runs that exact shell command: the board re-fingerprints it from the stored text at approval | — |
| `policy.json` invalid | the last good policy, else the shipped default; the card turns red | untouched |
| the hook's Node step fails | **denied** ("the gate check failed") | untouched |
| trigger file missing | the shipped default triggers (`scripts/gate-triggers.default`) | untouched |

**Speed:** a call that hits no trigger never starts Node. The hook greps the call against `data/guardrails/triggers` (generated from the policy, plus watched scripts) and exits in a few milliseconds; the tests hold the median under 35 ms. Only a hit asks the board.

**The fast path is tested on the real hook JSON.** A trigger matches the JSON Claude Code actually sends, where a word or flag that ends the command is followed by `",` or `"}`. It doesn't match a tidied-up copy of the command. The tests send every gated sample, with the action at the end and in the middle, in each field order, through the real `gate-hook.sh`. The hook uses the system `grep`, and a grep error counts as a hit.

**Every check is logged:** each answer the board gives (pass, allow, deny, observed) adds one line to `data/guardrails/checks.jsonl`: time, agent, tool, decision, task/gate, and a 160-character excerpt with secrets withheld. A call that ran ungated but appears there was passed by the board; a call that's missing never reached it.

## Install
```bash
scripts/guardrails-install.sh                  # show what would change
scripts/guardrails-install.sh --apply          # Claude Code: ~/.claude/settings.json (backed up first)
scripts/guardrails-install.sh --apply --codex  # also Codex: ~/.codex/hooks.json
scripts/guardrails-install.sh --remove --apply [--codex]
```
Run it yourself: changing these files from an agent session is itself gated. **Agents pick hooks up when they start**, so restart a session (or review `/hooks`) after installing.
- **Codex:** hooks need Codex's `hooks` feature (stable in current releases). Codex also asks you to trust a new hook once. Sessions launched through cmux's Codex wrapper already run with `--dangerously-bypass-hook-trust` for the hooks cmux injects; check that a Codex pane is actually gated before you rely on it.
- **Your own `!` commands:** in Claude Code, a line you type with `!` runs outside the model's tools, so it is not gated. That keeps you able to act when the board is down.

## Rolling out
- **`mode: "observe"`**: every gated call is logged ("would wait on the owner", ticker + `data/guardrails/observed.jsonl`) and nothing is blocked or written to tasks.
- **`enforceFor: ["agent-a", "agent-b"]`**: enforce for a pilot group while everyone else observes. Read the observe log for false positives, then set `enforceFor: ["*"]`. That edit is itself a `self` gate.
- **`"*"` means every *registered* agent**, i.e. a session in the mesh directory (a cmux workspace). A Claude or Codex session with no mesh identity is only observed, unless `enforceFor` also lists **`"unregistered"`**. Its gates then land on a new task owned by Mission Control. This keeps your own sessions outside cmux from being gated by the fleet flip unless you ask for it.
- **`mode: "off"`**: the hook passes everything.

Board card **`guardrails`** (infra):
- **amber**: a gate waiting more than 30 min, or the hook missing from the agents' settings;
- **red** (alert ladder): an invalid policy.

## Writing rules
Each class has `id`, `label`, optional `requireDryRun`, `ttlMinutes`, and `rules`. A rule matches one simple command (or tool call) with:
- `bin` (basename) + `args` (a prefix of the positional words) / `argsAny` / `notArgs` / `flagsAny` (one-letter flags also match inside clusters such as `-rf`) / `unlessFlags`;
- `script: true` (an interpreter + script path, or an executable path);
- `method` + `urlAny` (curl);
- `tool` (a regex on MCP tool names; keep it to plain `.*` and alternation, because the hook greps it too);
- `sql`;
- `labels` (`@list`);
- `pathAny` (read or write) / `pathWrite`;
- `textAny`;
- `when: "pushProtected" | "outsideRepo"`.

`lists` hold your names (`paidOrOutbound`, `publicRemotes`, `deployOnPush`, `guardSecrets`, `guardConfig`), referred to as `@name`. `keywords` adds words that make an unreadable command opaque.
