# Troubleshooting

Start here when something does not work. Each entry says what you see, why, and what to do.
If yours is not listed, run `zulu doctor`: it writes a redacted diagnostic file to `data/` (nothing is
uploaded). Attach it to an [install report](https://github.com/zulu-assistant/zulu-assistant/issues/new?template=install_report.yml).

Three commands answer most questions:

```sh
./install.sh check     # PASS / WARN / FAIL table, read-only
./install.sh verify    # end-to-end checks
tail -50 logs/server.log logs/server.err.log
```

## The board

| You see | Why | Do |
|---|---|---|
| Nothing on `http://localhost:3210` | the board's LaunchAgent is not loaded, or it exits at start | `launchctl print gui/$(id -u)/<prefix>.master-console` shows the state and last exit. Read `logs/server.err.log`. Restart with `launchctl kickstart -k gui/$(id -u)/<prefix>.master-console`. |
| "address already in use" in the error log | another program has port 3210 | set `MC_PORT=3211` in `data/local.env` and restart the board |
| The LaunchAgent cannot find Node | launchd has no shell profile | `scripts/env.sh` resolves Node (the nvm pin, then the newest nvm version, then Homebrew). Pin one with `MC_NODE_VERSION=v22.x.y` in `data/local.env`. |
| 403 from another device on your network | by design: the board answers this Mac and your Tailscale tailnet only | open it over Tailscale, `http://<tailscale-ip>:3210` |
| A button says "reload" (403) | the page is older than the running board, or the decision token was rotated | reload the page |
| A `curl` that writes gets 415 or 403 | every write must declare JSON and come from a known host | add `-H 'content-type: application/json'` and call `localhost` |
| Every scheduled job shows OVERDUE at once | the selfheal markers were deleted (a cleaner app, an emptied `~/.cache`) | restore them from your vault's `.scripts/state-mirror/`; never recreate them by hand ([INSTALL.md](INSTALL.md) §8) |
| A card is amber or red and you do not know why | each card's detail line says what it measured | hover the card, or `curl -s localhost:3210/api/status` |

## cmux and agent sessions

| You see | Why | Do |
|---|---|---|
| `cmux:bridge` card red, dispatch and notifications fail after a reboot | cmux 0.64.x loses its socket password on a cold launch | the board puts it back by itself within a few minutes. By hand: copy `data/cmux-socket-password` into `automation.socketPassword` in `~/.config/cmux/cmux.json`, then `cmux reload-config`. |
| After a reboot or a cmux update, panes are bare shells | cmux ran its auto-resume before the password was back, or ran none | the board retries the restore once the socket answers (one ticker line per repair). `node src/heal-restore.mjs --dry-run` lists what it would do. |
| A restored session has an old name | `cmux restore` replays the launch arguments, so a launch-time `--name` beats a later rename | `node src/heal-restore.mjs --dry-run` shows the name each session will come back with |
| The right sidebar shows Files after a cmux relaunch | cmux resets a custom sidebar at launch | `cmux right-sidebar set custom phosphor --no-focus` (the sidebar choice is yours; agents never switch it) |
| Every Node start in a cmux shell fails with "Cannot find module … restore-node-options.cjs" | cmux 0.64.x to 0.65.0 start Claude through a helper in the temp folder, and macOS cleaned it up | update cmux to 0.65.2 or later, or recreate the helper ([CMUX-SETUP.md](CMUX-SETUP.md), Known cmux quirks) |
| No tile for a session | it was started outside cmux | start agents inside cmux workspaces |
| A message to an agent stays queued | the pane is busy, shows a dialog, or holds a draft | it is delivered when the pane is ready; `node scripts/mesh-cli.mjs outbox` lists what waits and why |
| A new agent never starts on its brief | a trust dialog is on screen | answer it yourself; the board never answers a trust dialog |

More, with the cmux versions each applies to: [CMUX-SETUP.md](CMUX-SETUP.md), Known cmux quirks.

## Guardrails

| You see | Why | Do |
|---|---|---|
| Every gated command is denied | the board is down or slow: the gate fails closed | start the board; your own `!` lines are never gated |
| With the board down, a command that would be let through is denied now and then ("board unreachable … fail closed") | while the board cannot be asked, the hook judges the call itself and reads the repository with git, with one second for each read. On a loaded machine a git start can take longer; a read with no answer counts as not read, and a call the hook could not read is held | start the board, or run the command again. Nothing that should be held gets through this way: a slow read only ever holds |
| "set it first: task.sh focus N" | the agent has two or more live tasks and the receipt needs one | the agent runs `task.sh focus N` and tries again |
| You approved and nothing happened | the session is not one the board can wake (started outside cmux, or not registered) | the agent runs the same command again; the approval is valid for 120 minutes |
| "it expired before it ran" on a new row | an approval is never re-armed | approve the new row |
| In a Codex session, after you approved a row: Codex's own "Would you like to run the following command?" (on 1.3.1 and earlier also `Hook failed`, `PreToolUse hook returned unsupported permissionDecision:allow`) | The Codex hook file has no `PermissionRequest` entry yet, or the session started before it was added, so Codex's own question is not answered by the board. Then the call runs only when the prompt is answered, and the approval was used at the release | run `scripts/guardrails-install.sh --apply --codex` (it adds the entry), then restart each Codex session. Until then, answer **"Yes, proceed"** soon after you approved, never **"Yes, and don't ask again"** (it saves a Codex rule, and Codex then never asks for that command again). If the PR, the commit or the script may have changed since you approved, answer no and have the agent ask again. A held MCP tool call can still meet the prompt with the entry installed. Claude Code sessions are not affected |
| A Codex agent's merge: `in a Codex session a merge must name the head it merges` | A Codex hook cannot add the pin to a merge, so the merge must carry `--match-head-commit <head>` in its own words, with the PR's head of now | run exactly the command the message gives, alone, as its own call |
| On a Codex row: `no run seen` | The call was released, and no result of it came back within 30 minutes: a "no" at Codex's prompt, or a call that ended without a result | nothing is retried; if it should still run, have the agent ask again. A result that arrives later is still recorded as "ran (seen late)" |
| Every tool call is blocked in every session; each one ends with `PreToolUse:<tool> hook error:` followed by the hook's own command line, which names `scripts/gate-hook.sh` | the gate hook's script cannot start: the checkout was moved or deleted with the hook still registered, or the script is broken. The entries say `"onFailure": "block"`, so nothing runs past a hook that cannot answer | in your own terminal: `scripts/guardrails-install.sh --remove --apply` from the checkout, then restart the sessions. With the checkout gone, open `~/.claude/settings.json` and delete the two entries whose command ends in `scripts/gate-hook.sh'` (under `PreToolUse` and `PostToolUse`) and the one that ends in `scripts/gate-config-hook.sh'` (under `ConfigChange`); the installer left a backup beside the file. If you anchored the hook, also `scripts/guardrails-anchor.sh --remove`, or remove `managed-settings.d/50-zulu-guardrails.json` with administrator rights |
| A command ran that you expected to be held | the hook is not installed for that session, the agent is in observe mode, or the fast path did not match | the `guardrails` card shows a missing hook. `data/guardrails/checks.jsonl` has one line per answer the board gave; no line means the call never reached it. |
| Every tool call in one folder is slow (about a tenth of a second more each) | the hook's shell step reads the whole call, the folder it is made from included. A folder in that path whose name is a gated word by itself (`deploy`, `push`, `bootstrap`, `public`, or `zulu`) matches a trigger line, so every call from there goes on to the Node step, which reads it properly and passes it. Nothing is held that should not be; it only costs time. A name that merely contains such a word (`zulu-public`, `my-deploys`) does not match | move the checkout or the project to a folder without that name, or accept the delay. Up to and including 1.2.4 the word `public` matched anywhere in the path (`zulu-public` too), and three hook tests failed in such a checkout, so `./install.sh verify` and an upgrade's test step failed there; later releases match the whole name only |
| An agent's call is held with `zulu is named where no command shows it, and …` or `zulu is behind the variable in program position` | the call keeps the installer program's name (which is also the product's name) in a variable's value, and has a place where a value can become the program: a variable or a substitution in program position, `eval` or `xargs` with a variable, a shell fed from a pipe. The gate cannot tell a note's title from the program there. A path with a space after a folder named for the product reads the same way: unquoted, `/srv/Zulu Assistant/scripts/task.sh` would run `/srv/Zulu` | spell the program out in program position (`"/srv/Zulu Assistant/scripts/task.sh" show 5` instead of `T=…; "$T" show 5`), or make the part that carries the title its own call. A variable in program position is free when the call gives it a fixed value that is another program (`T=/srv/app/scripts/task.sh; "$T" …`). A title or a folder that names the product is never held by itself |
| "this session's environment names another board" | `MESH_BOARD` or `MC_PORT` is set in that session's environment (a settings file's `env` block, or your shell profile) to an address that is not the board the hook belongs to. The hook asks nobody and denies gated calls | remove the variable, or make it name the same board; if a settings file set it and you did not write that, find out which session did |
| "the gate check did not answer in 12 s" | the hook's Node step hung; the script answered for it, because a late answer would have let the call run | run the command again; if it repeats, check that Node starts (`scripts/env.sh`) and look at the board's error log |
| Claude Code will not start: "managed settings … could not be parsed" | a file in the managed settings folder is not valid JSON | fix or remove that file with administrator rights. The anchor's own file is `managed-settings.d/50-zulu-guardrails.json`; `scripts/guardrails-anchor.sh --remove` prints the line |
| Every held call is denied in every session after a Node upgrade ("the gate check failed"), and `scripts/guardrails-anchor.sh --check` says `NOT anchored` | the anchor names the old Node program by its full path, and that path is gone | run `scripts/guardrails-anchor.sh` and type the line again; `scripts/guardrails-install.sh --apply` does the same for your own settings file |
| Every session shows a hook error for `gate-hook.sh` after you moved the checkout | the anchor still names the old path | type the remove line (`scripts/guardrails-anchor.sh --remove`), then anchor again from the new checkout |
| `guardrails` card red | the hook is missing from your Claude settings, or the policy file does not parse | `scripts/guardrails-install.sh` (shows what it would write), then fix `overlay/policy.json` as the card says |
| `guardrails` card amber: "gate files are behind" | with gate integrity on: a change to the gate's files has landed on the remote and this checkout has not been fast-forwarded yet | pull (fast-forward) the checkout the board runs from and restart the board; it turns red after `behindMinutes` |
| `guardrails` card red: "gate files differ" | with gate integrity on: a gate file in the board's checkout matches nothing that has landed, or the checkout was moved back | look at the named files with `git status` and `git diff` in that checkout before anything else; restore them from the index only once you know who changed them |
| `guardrails` card red, naming a settings file | that file sets `disableAllHooks`, or its `env` block sets one of the gate hook's own variables, so sessions in that folder run ungated or ask something that is not the board | open the file, remove the key, and find out which session wrote it; sessions already running there were kept safe only if the settings-change hook is installed |
| `guardrails` card red: a settings file "sets GIT_DIR in env" (or `GIT_WORK_TREE`, `GIT_CONFIG_COUNT` …), or an agent is told its settings change "is not applied" for that reason | the file's `env` block sets one of git's variables that point every git call of the session at another repository or put settings into it. The block reaches the shell every tool call runs in, so the board would read the folder's repository while git acts on another | take the name out of the `env` block and set it on the one command that needs it (`GIT_DIR=… git …`), which the gate reads. A deploy key, a proxy or a settings file of your own (`GIT_SSH_COMMAND`, `GIT_PROXY_COMMAND`, `GIT_CONFIG_GLOBAL` …) is not refused: the card only notes it, without colour |
| `guardrails` card red: "session N was started with settings on its command line that set …", or naming a file "N running sessions were started with" | a Claude Code session was started with `--settings` (a file, or JSON text) that sets `disableAllHooks` or one of the gate hook's own variables. That session has run ungated, or asked something that is not the board, since its first call | find the session by its process id (`ps -p N -o args=`) and what started it, stop it, and read what it did. A file in `~/.cmuxterm/claude-settings/` is cmux's own: if cmux did not write the key, something else did |
| A settings change does not take effect in a running session | the settings-change hook blocked it: some settings file that session reads would switch the gate off | the red ticker line names the file; put it right and the next change passes |

Details: [GUARDRAILS.md](GUARDRAILS.md).

## Installer and setup

| You see | Why | Do |
|---|---|---|
| The installer stops at "Command Line Tools" | Apple's tools are needed for git | install them from the dialog, then run the installer again |
| A tool failed to install | Homebrew or npm reported an error | the installer continues and says what is missing; run it again, it only installs what is absent |
| The setup card stays on the board | a required step is not done | `zulu setup --status` lists the steps; `zulu setup --step <name>` runs one |
| Costs you did not expect | the scheduled triage job runs a headless Claude pass four times a day | unload it: `launchctl bootout gui/$(id -u)/<prefix>.mission-control-triage` ([INSTALL.md](INSTALL.md) §3) |
| `./install.sh check` says a secret is empty | that alert tier is off | fill the key in `data/secrets.env`; a missing key only turns that feature off |

## Chat intake and the phone relay

| You see | Why | Do |
|---|---|---|
| A request posted in chat never became a task | the bot is not in that channel, or the channel has no route | `scripts/chat-intake.sh --check` lists every channel and the link's health; invite the bot and add the route ([CHAT-INTAKE.md](CHAT-INTAKE.md)) |
| The intake card is amber or red | no traffic on the link for 10 or 60 minutes | the service restarts itself; `scripts/chat-intake.sh --sweep --since 2d` shows what a catch-up would file |
| The phone does not ring | the relay is off or in observe mode, the token is missing, or quiet hours hold it | the `relay` card says which; steps in [RELAY.md](RELAY.md) |

## Backups and upgrades

| You see | Why | Do |
|---|---|---|
| `backup:state` card amber | the newest daily archive is older than 36 hours, or there is none | `scripts/state-backup-install.sh` shows the job; run `zulu backup --state` once to check it writes |
| A restore is refused | the backup is from a newer version, or a file does not match the backup's manifest | upgrade first, or take a fresh backup; a restore never writes anything before these checks pass |
| `./install.sh upgrade` or `./install.sh rollback` prints nothing and ends at once (exit 0), and nothing changed | up to and including 1.2.4: the checkout is reached through a symbolic link (a linked home or projects folder), and the script took the linked path for another file and skipped its work. Later releases resolve the link | run it from the real path: `cd "$(pwd -P)" && ./install.sh upgrade`. The board's UPDATE button was not affected |
| An upgrade failed | a preflight check stopped it (nothing changed), or a later step failed and it rolled back | the `update` card and `logs/upgrade.log` say which; [UPGRADE.md](UPGRADE.md) has manual recovery |
