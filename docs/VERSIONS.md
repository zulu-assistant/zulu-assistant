# Tested versions

Each release is tested on one real install with the versions below. Newer versions usually work. If one doesn't, open an [Install report](https://github.com/zulu-assistant/zulu-assistant/issues/new/choose) with `zulu doctor`'s bundle.

## 1.0.0 (2026-10-31)

| Component | Tested version | Notes |
|---|---|---|
| macOS | 26.6 | Apple silicon |
| cmux | 0.65.2 | 0.65.2's update relaunch runs no auto-resume; the board's restore retry covers it (CMUX-SETUP.md) |
| Claude Code | 2.1.296 | Guardrails hooks (PreToolUse/PostToolUse); the newest models need ≥ 2.1.280 |
| Codex CLI | 0.162.1 | Guardrails hooks via `guardrails-install.sh --codex` |
| Node.js | 22.23 | ≥ 22 required; zero npm dependencies |

`zulu doctor` will check your install against this table in 1.1, along with the one-click upgrade. In 1.0 the table is for reading only.
