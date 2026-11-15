# Upgrading Zulu Assistant

One-click upgrade ships in 1.2.0 (see [VERSIONS.md](VERSIONS.md)), and 1.2.0 is the first release you can upgrade *from* this way; from 1.0.x, upgrade by hand once ([INSTALL.md](INSTALL.md) §7b). From then on an install made by `get.sh` upgrades with one click: the board's **update** card shows **⇧ UPDATE TO vX.Y.Z** when a newer release is out.
The same steps run from a terminal with `zulu upgrade`.

## Upgrading to 1.3
The button (or `zulu upgrade`) brings the code, runs the migrations and the tests, and restarts the board. These steps it does not do, because each touches something that is yours:

1. **Your rules file.** An upgrade never changes `overlay/policy.json`. The rules 1.3 adds reach it only when you copy them from `examples/policy.json`: the rules that hold an agent running the installer, the classes `engine-start`, `desktop`, `panes` and `remote-write` with their rules, the wider `outbound` and `store` rules for MCP tools, the six new names in the `checks` object (all `observe`), the `mcpRead` list, the eight more lines of the `gateCode` list, and the new entries of `guardGate`. `dryForms` is a list you add only when a script of yours has a dry flag of its own. The guardrails card says how many are missing (*N shipped rules are not in yours*). The steps are in [INSTALL.md](INSTALL.md#7b-upgrading): compare the two files, copy, render the rules page again. Until then the gate works with the rules you have; what 1.3 fixes in how a call is *read* (an interpreter named with its version, a word in front of a held call, the dry run) applies at once.
2. **The hook entries.** Run `scripts/guardrails-install.sh` (it shows what it would write), then `scripts/guardrails-install.sh --apply`. It adds `"onFailure": "block"` to the gate hook and the settings-change hook: without the field, a hook whose script cannot start, or that Claude Code times out, lets every call run. An install that came from 1.0.x gets the settings-change hook itself this way. It needs Claude Code 2.1.295 or later and refuses to write on an older one. The guardrails card names each entry that lacks the field until you have done it. **From then on, before you move or delete the checkout, run `scripts/guardrails-install.sh --remove --apply`:** with the script gone and the entries registered, every tool call is blocked ([GUARDRAILS.md](GUARDRAILS.md#install)).
3. **Triage.** New installs ship `SETTINGS.triage.dispatch: 'ask'`: the scheduled pass asks Mission Control for a worker and starts none. Your `overlay/config/jobs.mjs` was made before that key existed, so your pass keeps starting workers until you add `triage: { dispatch: 'ask' }` to `SETTINGS` there. And if you keep your own `overlay/config/TRIAGE.md`: the pass no longer has `curl`, `cat` or `date`, so the old procedure's steps are refused. Copy the example's steps ([examples/config/TRIAGE.md](../examples/config/TRIAGE.md)) and keep your own notes.
4. **Optional: the anchor.** `scripts/guardrails-anchor.sh` prints one line for you to type with your password; it puts the hook entries into Claude Code's managed settings, where a session cannot leave them out ([GUARDRAILS.md](GUARDRAILS.md#anchor-the-hook-optional-your-password-once)).

What you will see once, and need not act on:
- An approval you gave shortly before the upgrade and the agent has not used yet is asked again (the fingerprint of a call now includes the content of the scripts it runs).
- Approvals that ran out unused in the past are marked expired at the first start, with one ticker line that counts them.
- `./install.sh` with no word is the light install from 1.3 on. It removes nothing from a fuller install; `./install.sh --full` is the old behaviour.

**A checkout reached through a symbolic link** (a linked home or projects folder): 1.2.4 and earlier end `./install.sh upgrade` at once there, with no output and nothing done. Use the button or `zulu upgrade`, or run it from the real path: `cd "$(pwd -P)" && ./install.sh upgrade`. 1.3 fixes this for the upgrades after it.

## What the button does
The board never upgrades itself in its own process: the restart would kill the upgrade halfway.
Instead, the click writes `data/upgrade-request.json` and starts a one-shot LaunchAgent (`<prefix>.zulu-upgrade`) that runs `scripts/upgrade.mjs`.
Progress shows in the ticker, and the result shows on the card.

1. **Preflight.** Any failure here stops the upgrade, and nothing changes:
   - the working tree has no edits to tracked files;
   - no other upgrade is running (`data/upgrade.lock`);
   - at least 500 MB of disk is free;
   - the target is newer than this install;
   - the fetched tag points at the same commit GitHub reports for it;
   - the target is a fast-forward from this install.
2. **Backup** to `data/backups/upgrade-<time>/`:
   - a full restore point (`zulu backup`);
   - a copy of `overlay/`;
   - the previous commit.
3. **Code:** `git merge --ff-only <tag>`.
4. **Migrate:** `scripts/migrate.mjs` runs every new migration (below).
5. **Check:** the test suite.
6. **Install:** `scripts/bootstrap.sh install`, the idempotent install steps. On a light install (`./install.sh`) and on a Guardrails-only install, an upgrade *from* 1.3 or later writes the board's plist again and nothing else: those installs have no cmux config, no secrets file and no toolchain, and an upgrade does not add them.
7. **Restart** the board.
8. **Health:** within 90 seconds the board must answer `GET /api/version` with a new boot id and the target commit, and `/api/status` must answer.

**If any step from 3 on fails, the upgrade rolls back by itself.** The code goes back to the exact previous commit, and `overlay/` and every migrated file are restored. Then it re-runs the install steps, restarts and checks health again. The card says which step failed and why.
Your ledger and other `data/` written in the meantime are never rolled back.

The card turns red only when the rollback itself ends unhealthy. Then follow [Manual recovery](#manual-recovery).

## Which installs get the button
Only a **release install**: `origin` is the public repo (`SETTINGS.upgrade.repo`, default: the repo in `SETTINGS.repoUrl`), and `HEAD` is exactly a release tag.
- A checkout with local commits, a fork, or a branch you work on gets an information-only card ("no UPDATE button: …").
- `zulu upgrade` refuses on those too.

## Settings
`SETTINGS.upgrade` in `overlay/config/jobs.mjs`:

| key | default | meaning |
|-----|---------|---------|
| `mode` | `'on'` | `'on'` = card + button; `'observe'` = a ticker line when a new release appears, no card; `null` (the whole setting) = off |
| `repo` | from `repoUrl` | the public repo to check |
| `channel` | `'stable'` | `'pre'` also offers prereleases |
| `everyHours` | `6` | how often the board checks (GitHub's releases API, unauthenticated) |

An overlay from 1.0 has no `upgrade` key. It reads as `mode: 'on'` against `repoUrl`, so an upgraded install keeps checking.

## From a terminal
```sh
zulu upgrade --check          # what would happen: target, commits, migrations. Writes nothing.
zulu upgrade                  # upgrade to the newest release
zulu upgrade --to vX.Y.Z      # a specific newer release
zulu rollback                 # put back the code + overlay/ + migrated files of the last upgrade
```

## Migrations
A release that changes the shape of `data/` ships a migration in `migrations/NNN-<name>.mjs`.
- Applied ids are recorded in `data/schema-version.json`.
- Before writing, each migration backs up the file it changes.
- **Your `overlay/` is yours:** a migration may only add a missing key with a default. It never changes or removes a value you set.
- The upgrade's log lists every key a migration added.

## Manual recovery
If the card is red, the rollback itself failed. Its backup is in the newest `data/backups/upgrade-<time>/`:

```sh
cd ~/zulu-assistant
git reset --hard "$(node -p "require('./data/backups/upgrade-<time>/prev.json').sha")"
rm -rf overlay && cp -R data/backups/upgrade-<time>/overlay overlay
./install.sh check
launchctl kickstart -k gui/$(id -u)/<prefix>.master-console
```

The full restore point next to it (`restore-point.tgz`) restores `data/` and `overlay/` with `zulu restore <file> --apply`.

## What is not covered yet
- **Signed tags:** the preflight compares the tag with GitHub's API. That catches a wrong or tampered remote, not a compromised GitHub account.
- **Agents:** an agent may run `zulu upgrade` or `zulu rollback` only as a gated action (policy class `upgrade`, docs/GUARDRAILS.md). It waits for your one click and runs once. `zulu upgrade --check` is never gated. The button stays yours.
