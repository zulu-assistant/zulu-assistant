# Tested versions

Each release is tested on one real install with the versions below. Newer versions usually work. If one doesn't, open an [Install report](https://github.com/zulu-assistant/zulu-assistant/issues/new/choose) with `zulu doctor`'s bundle.

**Latest release: 1.2.3.** **Next release: 1.3.0** (not out yet; what it holds is under Unreleased in the [changelog](../CHANGELOG.md)). Where these docs say "since 1.3" or "in 1.3", they describe `main`. There was no public 1.1.0: what was built under that name shipped in 1.2.0.

## 1.2.3 (2026-11-13)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6.2 | Apple silicon |
| cmux | 0.65.2 | unchanged from 1.2.2 |
| Claude Code | 2.1.321 | the triage pass's three start-line flags were seen on this version; one that does not list them starts the pass without them |
| Codex CLI | 0.162.1 | unchanged from 1.2.2 |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

## 1.2.2 (2026-11-11)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6.2 | Apple silicon |
| cmux | 0.65.2 | unchanged from 1.2.1 |
| Claude Code | 2.1.321 | unchanged from 1.2.1 |
| Codex CLI | 0.162.1 | its hook input for a shell call carries no folder of its own (read in the Codex source); the gate reads Codex calls accordingly |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

## 1.2.1 (2026-11-11)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6.2 | Apple silicon |
| cmux | 0.65.2 | unchanged from 1.2.0 |
| Claude Code | 2.1.321 | unchanged from 1.2.0 |
| Codex CLI | 0.162.1 | unchanged from 1.2.0 |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

## 1.2.0 (2026-11-10)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6.2 | Apple silicon |
| cmux | 0.65.2 | unchanged from 1.0.1; a Guardrails-only install runs without it |
| Claude Code | 2.1.321 | the gate hook's time limit and environment handling were tested on this version; the newest models need ≥ 2.1.280 |
| Codex CLI | 0.162.1 | unchanged from 1.0.1 |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

## 1.0.1 (2026-11-03)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6.2 | Apple silicon |
| cmux | 0.65.2 | unchanged from 1.0.0 |
| Claude Code | 2.1.296 | unchanged from 1.0.0 |
| Codex CLI | 0.162.1 | unchanged from 1.0.0 |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

## 1.0.0 (2026-10-31)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6 | Apple silicon |
| cmux | 0.65.2 | 0.65.2's update relaunch runs no auto-resume; the board's restore retry covers it (CMUX-SETUP.md) |
| Claude Code | 2.1.296 | Guardrails hooks (PreToolUse/PostToolUse); the newest models need ≥ 2.1.280 |
| Codex CLI | 0.162.1 | Guardrails hooks via `guardrails-install.sh --codex` |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

The table is for reading only: `zulu doctor` does not check your install against it yet. The latest release is the first section above; what is on `main` for the next one is under Unreleased in the [changelog](../CHANGELOG.md).
