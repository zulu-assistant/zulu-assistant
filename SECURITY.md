# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/zulu-assistant/zulu-assistant/security/advisories/new)
(Security tab → "Report a vulnerability"). Include:

- what you found and where (file, route, script);
- how to reproduce it;
- the impact you expect, and any suggested fix.

We aim to acknowledge reports within 7 days and will coordinate a fix and a
disclosure date with you. Only the latest release and `main` are supported.

## Design: read-only by default

Zulu Assistant is an observer. It reads launchd, docker, the user crontab,
HTTP endpoints, disk and memory, process lists, agent transcripts and cmux
state. **It does not modify what it watches** unless you trigger an explicit
action.

### What the board writes

| Target | When |
|---|---|
| Its own `data/` directory (state, history, ledger, outbox, events) | always |
| cmux notifications, and optionally workspace color, description, status pills and progress | always / when `chrome` is on |
| One heartbeat row at `HEARTBEAT_URL` | every poll, if configured |
| Email, SMS webhook | only when the escalation ladder fires, if configured |
| `launchctl kickstart`, `docker restart`, a process `startCmd`, a new cmux workspace running Claude, one line typed into the Mission Control pane | only when you press KICKSTART / RESTART / START / DISPATCH CLAUDE / ASK MASTER; labels are validated against the registry |
| Disk cache cleanup | only levers you list in `REMEDIATION_LEVERS` (empty by default) |
| One line typed into an agent's pane (mesh delivery) | only into a READY pane: never over a dialog or a draft |

### What the board never does

- Edit your crontab, LaunchAgent plists or docker configuration.
- Approve an agent's permission prompt. Only Mission Control does that, as
  bounded by your `POLICY.md`, and paid, outward-facing or destructive actions
  always go to you.
- Read another project's secret files. Its secrets come only from
  `data/secrets.env`.

## Network exposure

- The server binds `0.0.0.0:3210` but **accepts only localhost and the
  Tailscale CGNAT range (`100.64.0.0/10`)**. Every other source, including
  your LAN, gets `403` (`src/guard.mjs`).
- `POST /api/event`, `/api/mesh/send` and `/api/mesh/outbox/drop` accept
  **localhost only**.
- Anyone on your tailnet can reach the board and press its action buttons.
  Use Tailscale ACLs to limit which devices can reach port 3210.
- There is no user login. The board assumes a single-user machine.

## Approval decisions

Ledger approvals (`decide`) require a random per-install **decision token**
(`data/mesh-decision-token`, mode 600) that is injected into the board page
and checked with a constant-time compare. Every decision is logged with the
source IP. The token is a speed bump and an audit trail. It is **not** a
boundary against other processes running as the same macOS user, which can
read the file. Agents are instructed never to call `decide`.

## Secrets

- All credentials live in `data/secrets.env`: gitignored, mode 600, re-read
  on change. The template is `secrets.env.example`. A missing key turns that
  feature off; nothing falls back to other files.
- The cmux socket password is kept in `data/cmux-socket-password` (mode 600,
  gitignored) and passed via environment variable to cmux CLI calls.
- The task ledger **refuses text that looks like a credential**, such as API
  key and token patterns.
- The dead-man workflow reads its endpoint, key and SMTP credentials from
  GitHub Actions secrets, never from the repository.

## Agents and prompt injection

Agents read untrusted text: logs, web pages, pane contents, other agents'
messages. The contracts in `examples/MISSION-CONTROL.md`, `AGENT-MESH.md` and
`examples/config/TRIAGE.md` require that such text is treated as **data, not
instructions**. Scheduled triage is additionally hard-bounded by
`--allowedTools`. These are defenses in depth, not guarantees. Keep
`POLICY.md` strict, and review what you allow.

## Release hygiene

The public tree is produced from a manifest (`publish/manifest.json`). Every
file is classified, and CI runs:

- `node scripts/publish.mjs --check`, which fails on any unclassified file;
- `scripts/scrub-gate.mjs`, a denylist of identity patterns (names, domains,
  phone numbers, tailnet IPs, workspace UUIDs, home paths) with no waivers;
- **gitleaks** on the publish output.

If you find something that slipped through, report it privately as described
above.
