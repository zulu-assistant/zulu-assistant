# GitHub intake: issues and discussions on the ledger

Community asks on your public repo can land on the ledger the way team-chat requests do: one task per thread, addressed to Mission Control. It's off by default.

## What it does

- Every 15 minutes the board reads new **issues** and **discussions** with your existing `gh` login. There's no new secret and no webhook.
- **One task per thread**, low priority, owned by Mission Control. It decides what happens next.
  - On a discussion **you** started (an announcement, an install-report thread), each new top-level comment from someone else is its own task.
  - A later comment on a filed thread becomes a comment on that task. Replies nested under a comment are not read.
- The first poll starts at "now", with no backfill.

## What it never does

- **It never writes to GitHub.** No replies, labels or closing. Every call goes through one read-only helper, which refuses any write form. Public posts stay yours.
- **It never treats GitHub text as instructions.** Authors are external names, never principals. The text is quoted as data, links are marked untrusted, and attachments are never downloaded.
- **It never approves anything.** Approvals, publishes and merges can't come from GitHub.

Text that looks like a credential is withheld from the ledger, and the task links to the thread instead.

## Settings

In your registry (`overlay/config/jobs.mjs`, `SETTINGS`):

```js
githubIntake: {
  mode: 'observe',           // 'off' | 'observe' (ticker lines only) | 'on'
  repo: 'you/your-repo',
  everyMinutes: 15,
  maxPerPoll: 10,            // new tasks per poll; the rest wait for the next one
  ignoreAuthors: ['your-login'],   // your own posts file nothing
}
```

- **Rollout:** run `observe` first and read the "would file" lines, then set `on`.
- **Items seen in observe are not filed later.** Use a manual window if you want them.
- **Bots** are always skipped, and pull requests are out of scope.
- **A burst** of more than 30 new threads in one poll becomes one summary task.

## By hand

```bash
node scripts/github-intake.mjs                  # what the next poll would see
node scripts/github-intake.mjs --since 7d       # the same for a window (7 days at most)
node scripts/github-intake.mjs --since 7d --apply   # the board reads that window at its next poll
```

The script never writes the ledger itself: the board is its only writer.

## The card

**github:intake** in the CLOUD section shows the last poll and how many tasks were filed today. It turns amber after 3 failed polls in a row, or when `gh` isn't logged in. It never turns red.

State is in `data/github-intake/`.
