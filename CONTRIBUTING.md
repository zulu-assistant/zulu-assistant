# Contributing to Zulu Assistant

Thanks for your interest. Zulu Assistant is a small, zero-dependency project,
and the rules below keep it that way.

- **Questions and ideas**: use [GitHub Discussions](https://github.com/zulu-assistant/zulu-assistant/discussions).
- **Bugs and concrete feature requests**: open an issue using one of the templates.
- **First contribution?** Look for issues labelled
  [`good first issue`](https://github.com/zulu-assistant/zulu-assistant/labels/good%20first%20issue).

## Dev setup

Requirements: macOS, Node ≥ 22, git. Docker and cmux are optional for
development.

```sh
git clone https://github.com/zulu-assistant/zulu-assistant.git
cd zulu-assistant
./install.sh --demo          # MC_DEMO=1: synthetic cards, sessions and tasks
open http://localhost:3210
```

Demo mode installs no LaunchAgents and makes no cmux calls, so it is safe on
any Mac and is the fastest way to work on the frontend (`public/`) or the
status logic. For a real install, see [docs/INSTALL.md](docs/INSTALL.md).

## Tests

```sh
node --test "test/*.test.mjs"
node scripts/publish.mjs --check
```

- Tests use `node:test` only.
- Tests must pass on a clean checkout with **no `data/` and no `overlay/`**.
  Use neutral fixtures and inject registries or paths instead of reading the
  owner's config. The existing tests show the pattern (`cronPresence(text,
  registry)`, `MC_OVERLAY=<dir>`).
- CI runs the tests on ubuntu-latest (plus a demo-board smoke check), and
  the scrub gate and gitleaks on macOS. CI does not run the manifest check,
  so run `node scripts/publish.mjs --check` yourself when you add files.

## House rules

### 1. Zero dependencies

There is no `package.json` with dependencies, no bundler and no build step.
Use Node built-ins (`node:http`, `node:fs`, `node:child_process`,
`node:test`, …) and vanilla HTML/CSS/JS. A PR that adds an npm dependency will
not be merged. If you think one is unavoidable, open a Discussion first.

### 2. Every new file goes in the manifest

`publish/manifest.json` classifies every tracked file as `public` or
`private`. `node scripts/publish.mjs --check` fails on any file that is
unclassified or listed twice; CI does not run it, so run it locally. When you add a file,
add it to the `public` list in the same PR.

### 3. Keep the core generic

The same core code runs every installation. Anything specific to one owner
belongs in `overlay/`, which is gitignored:

- Put your jobs, endpoints, agents, models and policy in `overlay/config/…`
  and `overlay/POLICY.md`, not in core files.
- Generic templates live in `examples/` with `<OWNER>`-style placeholders.
- Core code must not contain names, hostnames, phone numbers, email
  addresses, IP addresses, UUIDs or home-directory paths. Say "the owner" and
  use `OWNER` from `src/config.mjs`.
- `scripts/` and `system/` must not hard-code home paths. Use
  `scripts/env.sh` or a `*.tmpl` file rendered by `scripts/render-tmpl.sh`.
  `test/hygiene.test.mjs` enforces this.
- Import the registry from `src/config.mjs`, never from `config/jobs.mjs`
  directly.

### 4. Read-only by default

The board only observes what it watches. A new collector must be read-only,
time-bounded (with a timeout and SIGKILL), and must never hang the poll. A
new action must be opt-in (a button or an explicit CLI call), validated
against the registry, and logged to the event ticker. See
[SECURITY.md](SECURITY.md).

### 5. UI charter

The phosphor look is deliberate: green on black, a monospace font, and glyph
plus label on every status chip, never color alone. Honor
`prefers-reduced-motion`. See `PRODUCT.md` before making visual changes.

## Pull requests

- Keep each PR to one change. Explain the *why* in the description.
- Fill in the PR template checklist: tests, manifest classification, a clean
  scrub gate, no new dependencies.
- Update docs (`docs/`, `AGENT-MESH.md`, the examples) in the same PR when
  behavior changes, and add a line to `CHANGELOG.md` under `Unreleased`.
- By contributing, you agree that your contribution is licensed under the MIT
  License.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Please
report unacceptable behavior as described there.
