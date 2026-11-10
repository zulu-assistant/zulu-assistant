# Guardrails in five minutes

The smallest useful part of Zulu Assistant, on its own: **an agent's irreversible command waits for
your click, runs once, and leaves a receipt.** No cmux, no Mission Control, no Homebrew packages,
nothing that costs money.

You need a Mac, Node 22 and Claude Code. That is all.

## Install

```sh
git clone https://github.com/zulu-assistant/zulu-assistant.git ~/zulu-assistant
cd ~/zulu-assistant
./install.sh --guardrails
```

It does five things and says each one as it goes (`--dry-run` shows the plan and writes nothing):

1. **Checks Node.** 22 or later.
2. **Copies the example config** into `overlay/`, which is yours. Nothing of yours is overwritten.
3. **Sets the Guardrails-only profile:** `profile: "guardrails"` in `overlay/config/local.json`, and
   `"defaultMode": "enforce"` in `overlay/policy.json` so that every session is held (without cmux
   no session is registered anywhere, and the shipped policy only observes unregistered ones).
4. **Starts the board** as one LaunchAgent, on `http://localhost:3210`.
5. **Shows the hook** it would add to `~/.claude/settings.json`, asks, then adds it (a backup is taken
   first). Restart your Claude Code sessions so they load it. The hook goes into your user-level
   settings, so from then on **every Claude Code session on this Mac is held**, not only sessions
   started in one folder.

**Already running the full board from this checkout?** Then this command stops and shows what it would
change: switching to Guardrails only turns off the fleet cards, the mesh and the session heals. Add
`--switch` to do it on purpose. `--yes` alone never switches. An agent that runs this installer is held
by the gate like any other change to the gate itself; the `--dry-run` form is free.

## Try it

In a scratch repository, ask your agent to push to `main`:

> push this branch to main

- The command **does not run**. The agent is told it is waiting on you.
- A row appears on the board with the exact command and the folder.
- Click **✓ RUN ONCE** (it takes two clicks). The agent runs the same command again, and this time it
  goes through. Once.
- Run it a third time and it waits for you again. `scripts/task.sh audit 1` prints the receipt.

What is held by default: merges, pushes to `main` or a public remote, force pushes, deploys, a
script's `--commit` or `--apply` run, sends, store writes, deletes outside the working tree, schedule
changes and the gate's own files. The full table and how to write your own rules:
[GUARDRAILS.md](GUARDRAILS.md).

## What this install cannot do

It is honest to say what you give up without the rest:

- **No wake.** With no terminal to type into, the board cannot tell the agent you decided. The agent
  is told to run the same command again after you approve, and the row says so too. An approval lasts
  120 minutes.
- **No agent names.** Every session shows as `unregistered:<folder>`, and each held command gets its
  own task on the board.
- **No program go.** A standing approval for a task's routine merges needs named agents.
- **No phone push** unless you set up the relay ([RELAY.md](RELAY.md)). The board page itself opens
  on your phone over Tailscale.
- **Desktop notices** come from macOS (`osascript`), not from a terminal feed.
- **No fleet monitoring, no session tiles, no self-healing of sessions.** The board shows the waiting
  rows, the ledger and its own cards.

## Adding the rest later

The full install adds cmux (the agent terminal), the mesh, Mission Control, fleet monitoring and the
brain: [INSTALL.md](INSTALL.md). To switch this install over, run the full installer and then

```sh
node scripts/guardrails-profile.mjs --full --apply
```

and restart the board. Your ledger, receipts and policy stay as they are.

## Taking it out

```sh
scripts/guardrails-install.sh --remove --apply          # the hook, out of ~/.claude/settings.json
launchctl bootout gui/$(id -u)/com.zulu-assistant.master-console
rm ~/Library/LaunchAgents/com.zulu-assistant.master-console.plist
```

Then delete the checkout. Nothing else was installed.
