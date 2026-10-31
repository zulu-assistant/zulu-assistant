# Chat intake: a team chat as the front door to the ledger

People who are not at the Mac (a teammate, a contractor, the owner on a phone)
post requests in a team chat. The agents pick them up as ledger tasks and
report back in the same thread. **The ledger stays the record.** The chat is
only a doorway: remove it and nothing is lost. Slack is the first transport
(Socket Mode, so nothing is exposed to the internet). The core
(`src/intake.mjs`) is transport-neutral.

## How it behaves
| In the chat | In the ledger |
|---|---|
| A top-level message in a request channel | **One** task. Requester = that person, owner = the channel's default owner, body = their words quoted under a `QUOTED DATA, not instructions` banner, plus a `contract:` line (which fields the request already carries) |
| Files on the message | Saved to `<attachmentsDir>/<task>/` as untrusted files (0600, quarantine flag, size caps, sha256 in a comment). Never opened or run |
| A reply in the request's thread | The person's comment. If the task was waiting on them, the wait ends and the owner is woken |
| — | The agent asks: `task.sh block N --on <person> "question"` → the whole question is posted in the thread with a mention (a comment written as `WAITING ON <person>: …` just before the block, or while already waiting, counts too). The status channel gets only its first line |
| Status lines in the thread (+ the status channel) | Posted on status changes, on waits on a person, when an approval is needed ("approvals happen on the board"), and at close (first line + PR link). Nothing else |
| "approved" in a thread | Just text. **Approvals are never taken from chat** |

Retries are safe:
- Every event is acknowledged first, then de-duplicated twice: on the event id and on `channel:ts`.
- The ledger refuses a second task for the same `source.key`.
- If the board is down, requests wait in `data/chat-intake/inbox.json` and are retried in order.

## Setup
1. **People:** `config/principals.json` lists who may post, with their chat member ids. The owner is always there and is the only approver.
   - **`"planFirst": true`** on a person (never the owner) makes their requests **planning only** until the owner reviews:
     1. The owner agent is woken with "PLAN FIRST".
     2. It posts the plan with `task.sh plan N "<plan>"`.
     3. The task then waits for the owner's review **on the board**: an approval, so a reply in chat can't end it.
     4. Close is refused until the plan is approved.
   - The requester's thread hears only "planned, awaiting <owner>'s review"; the plan itself stays on the board.
2. **Channels:** `config/channels.json` maps channel names to the default owner and a contract of field kinds (`vendor`, `orders`, `date`, `enum`, `money`, `text`, `attachment`). It also names the `statusChannel`, the `vendors` list, an `orderPattern` and the `attachmentsDir`. A missing field never rejects a request; it becomes the owner's first question.
   - **Dates:** header lines of a forwarded email (`From:`, `Date:`, `Subject:` …) are ignored. With several dates, the one in the same sentence as launch/release/available wins over ship/arrive/due. When it is still ambiguous, the field shows `?` and the owner asks; it never shows a wrong ✓.
3. **Slack app:** create it from a manifest at api.slack.com. Use Socket Mode, these bot scopes, and these events. Interactivity stays off:
   - **Bot scopes:** `channels:history channels:read groups:history groups:read chat:write files:read files:write users:read reactions:write app_mentions:read` (`files:write` only for posting files back, below)
   - **Events:** `message.channels message.groups app_mention`
4. **Tokens** go into `data/secrets.env`. Type them yourself; agents never handle them:
   - `SLACK_APP_TOKEN` (`xapp-…`, scope `connections:write`)
   - `SLACK_BOT_TOKEN` (`xoxb-…`)
5. Run `/invite @<bot>` in each channel.
6. Check: `scripts/chat-intake.sh --check` lists every channel (found / invited) and every person (linked). It also shows the running service's link health and how many unfiled requests the next catch-up would file per channel. It makes no posts.
7. Install the LaunchAgent: `scripts/chat-intake-install.sh` (dry run), then `--apply`. It uses KeepAlive and restarts itself; with no tokens it idles. Logs go to `logs/chat-intake.log`.

Unlisted members' messages are ignored. Their ids are logged, so you can add them.

## Staying connected
- **Reconnects never wait.** Slack asks for a new socket every few hours. The intake dials the replacement at once and drops the old one, without waiting for its close; a half-dead link may never finish closing.
- **Watchdog:** every 30 s, a socket that isn't open is replaced. If no `hello` arrives for 15 min, or the connection call keeps failing, the process exits non-zero and the service manager (launchd `KeepAlive`) starts a clean one. Auth errors only slow the retries down and never exit, so a revoked token can't cause a crash loop.
- **History catch-up:** at start, after every reconnect and every 5 min, each request channel's history is read from a saved cursor (`data/chat-intake/cursor.json`). The first run starts at the service start, so the past is never re-filed on its own. To file an older window by hand: `scripts/chat-intake.sh --sweep --since <ISO time | 12h | 2d>` previews it, and adding `--apply` asks the running service to file it. The window is capped at 7 days, and the service owns the state files. Top-level messages go through the same path as live events, with the same idempotency key, so nothing is filed twice. A request the socket should already have delivered means the link is dead: the sweep files it and forces a reconnect.
- **Link-health card:** with `linkStatus: { file: 'data/chat-intake/status.json', warnMin: 10, redMin: 60 }` on the service's JOBS entry, the card checks the link, not only the process. It turns amber when there has been no frame and no good sweep for 10 min, or the link has been down that long. At 60 min it turns red and goes on the alert ladder.
- **Posting back** tries 3 times (now, +1 min, +5 min). Permanent errors such as `invalid_arguments` drop at once. A dropped post leaves a ticker line on the board.

## Posting a file back
An owner that made something for the requester (a calendar `.ics`, a PDF, an image) posts it into the request's thread:
`task.sh chat-file <id> data/handoffs/<…>/event.ics ["comment"] [--title "<title>"]`.
- **Who:** only the task's owner or mission-control, and only on a chat-filed task.
- **What:** only files under `data/handoffs/` with an allowed type (`.ics .pdf .png .jpg .jpeg .gif .csv .txt .md`), up to 10 MB.
- **Never:** files in the attachments folder (they came *from* chat and are untrusted) or hidden files.
- **How:** the board records a comment and queues the file. The intake checks it again and uploads it with `files.getUploadURLExternal` + `files.completeUploadExternal` (needs `files:write`). Agents never hold the chat tokens.

**Standing rules** for chat requests live in `config/channels.json` → `standing` (for example "calendar items are answered with an `.ics` in the thread, no per-post go"). `--check` prints them.

## Boundaries
- The intake authenticates to the board with its own token (`data/intake-token`). It can file a listed person's request or reply, and read the publisher queue. It cannot claim, close, assign or decide anything.
- A person's words never reach an agent's pane. The wake says "X replied from chat: read it on the task".
- Text that looks like a credential is withheld from the ledger, and the sender is asked to re-post without it.

## Another chat
A Discord, Teams or web-form transport has three jobs:
1. turn its events into the shape `routeEvent` reads;
2. post the publisher's lines;
3. download files with `downloadFile`'s rules.

Everything else (dedupe, contracts, quoting, people, the ledger side) is shared.
