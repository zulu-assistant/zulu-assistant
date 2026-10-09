# Testing Zulu Assistant (early access)

Thank you for trying it early. Plan on **about 45 minutes** for the first run;
most of it is downloads and macOS permission dialogs. Nothing here is automated against your
accounts: every login goes through the tool's own flow, and nothing is uploaded anywhere.

## Before you start
- A Mac on macOS 14 or later, with an admin account (Homebrew needs it).
- A GitHub account (for `zulu setup`'s GitHub step and for sending feedback).
- A Claude subscription or Anthropic API key, and/or a ChatGPT plan or OpenAI API key —
  you choose which engine runs Mission Control during setup.
- Optional: an SMTP account for email alerts, an Obsidian install you already use.

## 1. Install (one command)

```bash
curl -fsSL https://zuluassistant.com/install | bash
```

Or straight from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/zulu-assistant/zulu-assistant/main/get.sh | bash
```

The installer shows the list of tools it will add and asks once. Then it puts the board, the
cmux configuration, the agent memory and the Mission Control files in place, and offers
`zulu setup`.

## 2. zulu setup (the part we most want feedback on)
Say yes when the installer offers it, or run `zulu setup` later. Please try:
- **engines** — pick Claude for Mission Control and workers, or try Codex for one of them;
- **watch** — does the scan find your own LaunchAgents / containers / cron lines? Are the names sensible?
- **vault** — new vault or your existing one; does Obsidian open it?
- **macos** — were the Settings panes the right ones?
- **verify** — does Mission Control start in cmux on the engine you picked?

`zulu setup --status` shows the checklist; the board at http://localhost:3210 shows a setup card.

## 3. Use it for a day
- Leave the board open. Do cards match reality? Does anything nag without informing?
- Ask Mission Control for something small in one of your repos.
- Reboot once: does everything come back on its own?

## 4. Tell us
Open an issue with the **Beta feedback** template. Attach the output of `zulu doctor` (a
redacted text file in `data/` — read it first; it never leaves your Mac unless you attach it).
Rough timings and the exact step where you got stuck are the most useful things you can send.

## Undo
```bash
cd ~/zulu-assistant && ./install.sh demo-stop
launchctl bootout gui/$(id -u)/com.zulu-assistant.master-console
launchctl bootout gui/$(id -u)/com.zulu-assistant.mission-control-triage
node scripts/cmux-tier1-install.mjs --revert
```
Your vault, your repos and your logins are untouched by an uninstall. docs/INSTALL.md §7 has the
full rollback.
