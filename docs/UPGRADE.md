# Upgrading Zulu Assistant

One-click upgrade ships in 1.2.0 (see [VERSIONS.md](VERSIONS.md)), and 1.2.0 is the first release you can upgrade *from* this way; from 1.0.x, upgrade by hand once ([INSTALL.md](INSTALL.md) §7b). From then on an install made by `get.sh` upgrades with one click: the board's **update** card shows **⇧ UPDATE TO vX.Y.Z** when a newer release is out.
The same steps run from a terminal with `zulu upgrade`.

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
6. **Install:** `scripts/bootstrap.sh install`, the idempotent install steps.
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
