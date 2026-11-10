# Contributing to Zulu Assistant

Thanks for your interest. Zulu Assistant is a small, zero-dependency project,
and the rules below keep it that way.

- **Questions and ideas**: use [GitHub Discussions](https://github.com/zulu-assistant/zulu-assistant/discussions).
- **Bugs and concrete feature requests**: open an issue using one of the templates.
- **First contribution?** Look for issues labelled
  [`good first issue`](https://github.com/zulu-assistant/zulu-assistant/labels/good%20first%20issue).

## Dev setup

Requirements: macOS, Node ≥ 22, git. Docker and cmux are optional for
development: demo mode and the tests need neither. A real install uses cmux
for the agent half (see [docs/INSTALL.md](docs/INSTALL.md)).

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

## How a pull request lands

This repository is a **generated copy**. The maintainers work in a private source repository that
also holds one owner's own configuration; each release copies the public files from there
(`publish/manifest.json` lists them, `scripts/publish.mjs` copies them, and a scrub gate checks the
result). The history here is one commit per release.

That decides what happens to your pull request:

1. Open it against `main` here, as usual. CI runs the tests and the scrub gate on it.
2. A maintainer reviews it here. Review comments and changes happen on your PR.
3. When it is accepted, a maintainer applies your diff in the source repository with you as the
   commit's author (`Co-authored-by` when it had to be adapted).
4. Your PR is then **closed, not merged**, with a comment that names the release that will carry it.
   A merge here would be overwritten by the next release copy.
5. The release notes and `CHANGELOG.md` credit you.

So a closed PR with a "lands in vX.Y.Z" comment is the accepted outcome. If that release goes out
without your change, say so on the PR: that is a bug on our side.

Two things that follow from the copy model:

- Files under `overlay/`, `data/` and `graphify-out/` are yours and never part of a PR.
- A change to a public-only file (this file, `README.md`, `docs/`, `.github/`) is welcome the same
  way; in the source repository those live under `publish/public/`.

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
