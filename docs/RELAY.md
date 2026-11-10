# Push approvals on your phone (relay)

When an agent's gated action, an approval or a plan review is waiting on you, your phone buzzes. Tap it and the board opens with that item highlighted. **You still decide on the board, with the usual two clicks.** The push is a doorbell, not a key.

- **Transport:** [ntfy](https://ntfy.sh), an open-source push server you run on your own Mac and reach over Tailscale. A public ntfy.sh topic is an opt-in fallback.
- **The push carries ids and labels only**, for example `GATE g3 · #401` with `Merge a pull request · agent-mesh · <task title>`.
  - It never carries the command, a diff or comments.
  - In fallback mode it doesn't carry the task title either.
- **The desk notification still fires** every time. The phone is in addition to it, never instead.
- **Rings:** once when an item arrives. If it's still waiting at 30 minutes and at 90 minutes it rings again, then stops.
- **Snoozed items stay quiet.** When you snooze an item in WAITING ON YOU (the attention ring, `SETTINGS.attention.snooze` on), it gets no re-rings while the snooze lasts.
  - When the snooze ends and the item is still waiting, it rings once ("still waiting"), and the 30/90-minute re-rings restart from that ring.
  - The first ring of a new item is never held back. A re-asked gate is a new item.
- **Quiet hours** (default 22:00–07:00, local time):
  - gates still ring, at normal priority instead of time-sensitive;
  - everything else, re-rings included, waits and is sent once when quiet hours end.

## Settings
`SETTINGS.relay` in `overlay/config/jobs.mjs` (`null` = off):

```js
relay: {
  mode: 'observe',                        // 'off' | 'observe' (ticker lines: "relay (observe): would push …") | 'on'
  url: 'http://<tailscale-ip>:2586',      // your ntfy server, or 'https://ntfy.sh' for the fallback
  topic: 'zulu-owner',                    // fallback: 32+ random characters
  boardUrl: 'http://<tailscale-ip>:3210', // where a tap opens; empty = no link in the push
  quiet: { from: '22:00', to: '07:00', allow: ['gate'] },
  reRingMinutes: [30, 90],
}
```

- **Token:** the server's write token goes in `data/secrets.env` as `RELAY_TOKEN`, never in the overlay. With `mode: 'on'` and no token, the relay only observes and says so in the ticker.
- **Card:** the board's **relay** card turns amber after 3 failed pushes in a row. It never turns red, because the desk notification still works.

## Install (one Mac, one phone)
1. **Server, in Docker on macOS.** Homebrew's `ntfy` formula is the client only: on macOS it cannot `serve`. Run the official image instead.
   - Mark the folder as never backed up: `mkdir -p data/relay && touch data/relay/.nobackup`. The server keeps its user database and you keep the phone's token there, and `zulu backup` skips any folder that holds a `.nobackup` file, in every kind of backup, `--with-secrets` included. (`zulu backup` and an upgrade add the file to an existing `data/relay/` that lacks it.)
   - Copy `examples/relay/server.yml` to `data/relay/server.yml` and put in your Tailscale address. It uses the container's paths (`/var/lib/ntfy/…`) and `auth-default-access: deny-all`.
   - Start it, published on your **tailnet address only**:
     ```bash
     docker run -d --name ntfy --restart unless-stopped \
       -p <tailscale-ip>:2586:2586 \
       -v "$PWD/data/relay/server.yml:/etc/ntfy/server.yml:ro" \
       -v "$PWD/data/relay:/var/lib/ntfy" \
       binwiederhier/ntfy:v2.37.2 serve
     ```
   - Docker's `unless-stopped` brings it back after a reboot (Docker Desktop must start at login). No LaunchAgent is needed. `system/launchd/ntfy.plist.tmpl` is only for a native `ntfy serve` binary, which Homebrew doesn't provide on macOS.
   - Optional: add `ntfy` to `DOCKER_CONTAINERS` in your registry for a board card.
2. **Users and tokens, in one-off containers.** Stop the server first: the user database is SQLite on the bind mount, and it locks under the running server.
   ```bash
   docker stop ntfy
   ntfy_cli() { docker run --rm -it -v "$PWD/data/relay/server.yml:/etc/ntfy/server.yml:ro" -v "$PWD/data/relay:/var/lib/ntfy" binwiederhier/ntfy:v2.37.2 "$@"; }
   ntfy_cli user add zulu                 # board user (asks for a password)
   ntfy_cli access zulu <topic> rw
   ntfy_cli token add zulu                # → RELAY_TOKEN in data/secrets.env
   ntfy_cli user add phone                # phone user, read-only
   ntfy_cli access phone <topic> ro
   ntfy_cli token add phone               # for the ntfy app; keep it out of git and chat
   docker start ntfy
   ```
   - Check: `curl -s -o /dev/null -w '%{http_code}' http://<tailscale-ip>:2586/v1/health` gives `200`. An anonymous publish or read gives `403`.
3. **iPhone.**
   - Install **ntfy** from the App Store and Tailscale.
   - In ntfy, add the server `http://<tailscale-ip>:2586` with the phone user's token.
   - Subscribe to `<topic>`, and allow notifications and Time Sensitive.
4. **Turn it on.**
   - Set `mode: 'observe'` for a day and read the would-push lines.
   - Then set `mode: 'on'`, and test with a harmless gated command.

**iOS note:** iOS can't keep a connection open to your own server. So ntfy asks ntfy.sh to wake the app (`upstream-base-url`).
- ntfy.sh receives only a poll request: a hash of the topic URL plus the message id. Your phone then fetches the message from your server over the tailnet.
- Check this once after install. Watch the server log, or read ntfy's docs on "iOS instant notifications".

**Fallback without a server:** set `url: 'https://ntfy.sh'` and a topic of 32+ random characters, with no token. Anyone who learns the topic can read the pushes. That's why fallback pushes carry only ids and class labels.

## Threat model
| threat | what stops it |
|---|---|
| Someone reads your pushes | Your server: deny-all plus a read token, on the tailnet only. Fallback: a long random topic, and the pushes say only "a gate is waiting on #401", never what it is. |
| Someone sends a fake push | Your server: only the board holds the write token. Fallback: a fake push can only send a link, which you can see in the notification. On the board nothing happens without the decision token. |
| Acting from a push | A push carries no token, grant or approve URL. `?item=` only highlights a row; it never arms or clicks. Grants stay single-use. |
| A lost or stolen phone | The notification history shows ids and labels. Deciding also needs your tailnet and the board page. Remove the phone from your tailnet (Tailscale admin) and revoke its token (`ntfy token remove`). |
| The relay is down | The desk notification still fires; the card turns amber after 3 failures. |

## Later: a hosted relay
A hosted relay would add one phone for several Macs, a deputy (a second person who can approve), and links that work without Tailscale on the phone. It would sit behind the same `push` interface; your board decides as before.
