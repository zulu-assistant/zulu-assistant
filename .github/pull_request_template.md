## What and why

<!-- One change per PR. Link the issue or Discussion: Closes #… -->

## How it was tested

<!-- Demo mode, a real install, new/updated tests… -->

## Checklist

- [ ] `node --test "test/*.test.mjs"` passes (on a clean checkout: no `data/`, no `overlay/`)
- [ ] Every new or renamed file is classified in `publish/manifest.json` (`node scripts/publish.mjs --check` passes)
- [ ] Scrub gate is clean: no names, hosts, IPs, phone numbers, emails, UUIDs or home paths (`node scripts/scrub-gate.mjs <publish-dir>`)
- [ ] No new dependencies (no npm packages, no build step)
- [ ] Owner-specific config lives in `overlay/` / `examples/`, not in core
- [ ] New collectors are read-only and time-bounded; new writes are opt-in actions
- [ ] Docs and `CHANGELOG.md` (Unreleased) updated if behavior changed
