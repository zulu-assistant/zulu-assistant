# Why cmux and not tmux?

Zulu Assistant runs its agents inside [cmux](https://github.com/manaflow-ai/cmux),
a native macOS terminal built for coding agents. cmux is a separate
GPL-licensed app. You install it yourself. Zulu Assistant does not bundle or
modify it, and talks to it only through its CLI and its socket.

A reasonable question is why this project doesn't use tmux plus a dashboard.
tmux is free, scriptable, available everywhere and very stable. This page
explains the trade-off.

## What the board needs from a terminal

1. **Read any pane's screen**, to classify an agent as running, idle, waiting
   on a dialog, or holding a half-typed draft.
2. **Type into a pane**, but only when it is safe to do so.
3. **Know which agent session lives in which pane**, and whether it is busy.
4. **Surface attention**: an agent needs input, a job went red.
5. **Survive a reboot**, bringing agent sessions back without manual work.
6. **Show per-agent status where you already look**: color, a short
   description, task state, context used.

## Side by side

| Need | tmux + a dashboard | cmux + this board |
|---|---|---|
| Read a pane | `tmux capture-pane -p`: solid | `cmux read-screen --scrollback`: equivalent |
| Type into a pane | `tmux send-keys`: solid | `cmux send` / `send-key`: equivalent |
| Pane ↔ agent session mapping | You build it (hooks write pane IDs somewhere) | Agent hooks maintain it (`~/.cmuxterm/claude-hook-sessions.json`); the board reads it |
| Agent lifecycle (running / idle / needs input) | Screen-scraping or your own hooks | Emitted by the agent integration; the board also classifies the screen before delivery |
| Notifications | `display-message`, bell, or an external notifier | Native notifications plus a **Feed** of agent and board events, sent with `cmux notify` |
| Per-workspace status | Status-line format strings; one line, set globally | Per-workspace **color**, **description**, **status pills** and a **progress bar**, all set over the socket |
| Session restore after reboot | tmux-resurrect/continuum restores layout and commands; the agent CLI must be relaunched and resumed by your own script | Workspaces restore and **Claude sessions auto-resume** (`cmux restore claude <id>`); the board retries restores that fail at boot |
| Remote control API | CLI over a Unix socket; access is controlled by file permissions | CLI and socket with an optional **password mode**, which the board uses |
| Glanceable side panel | None built in; the dashboard lives in a browser tab | **Dock** panels (the board at `?dock=1`, the Feed, a log tail) and scriptable **custom sidebars** |
| Where it runs | macOS, Linux, BSD, over SSH, headless | macOS desktop only |

## What cmux gives this project specifically

- **Attention in one place.** Board alerts and "agent needs input" events
  land in the same Feed you already watch. They are not a separate browser
  tab.
- **The mesh is visible in the sidebar.** With `chrome` on, each workspace is
  colored by domain and shows its ledger state (`#4 WORKING`, `3 tasks · #2
  BLOCKED`) and its context gauge. The phosphor custom sidebar sorts by what
  needs you.
- **Reboots mostly heal themselves.** Auto-login, the cmux login item, session
  restore with auto-resume, the board's socket-password heal and its restore
  retry together bring every agent session back with no human input.
- **Safer delivery.** The Agent Mesh never types into a pane showing a
  permission prompt, a trust dialog or someone's draft. This relies on
  reliable screen reads plus the session map. You can build both on tmux, but
  cmux provides them.

## Costs of cmux

Be aware of these before you commit:

- **macOS only, GUI only.** There is no SSH-only or Linux server story.
- **A younger project.** Some versions have had rough edges, such as losing
  the socket password on a cold launch. The board works around that with
  `src/heal-cmux.mjs`, which you would not need with tmux.
- **Another app to install and update**, with its own release cadence.
- **GPL.** This is fine for use. Zulu Assistant stays MIT because it only
  invokes cmux and never links, embeds or ships it.

## When tmux is still the right choice

- The agents run on a **Linux box or a remote server**, or you work mostly
  over SSH.
- You want **headless** agents with no desktop session at all.
- You already have a tuned tmux setup and only need the **Ops Board half**.
  The fleet monitoring (launchd, docker, cron, endpoints, gauges, escalation,
  dead-man's switch) does not depend on cmux. Without cmux, the agent tiles,
  the mesh delivery and the cmux notification tier are inactive, and email,
  SMS and the digest still work.
- You need a terminal with a very long track record and a large plugin
  ecosystem.

## Could the mesh support tmux?

In principle, yes. Delivery needs a "read screen" call, a "send line" call, a
workspace list and a pane-to-session map. `capture-pane`, `send-keys`,
`list-panes` and a hook file would cover these. That adapter does not exist
today. If you want to write it, open a Discussion first so the interface
between `src/mesh.mjs` and the terminal can be designed to allow more than
one backend.
