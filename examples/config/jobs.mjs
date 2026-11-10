// Zulu Assistant — EXAMPLE fleet registry (generic twin of overlay/config/jobs.mjs).
//
// Copy to overlay/config/jobs.mjs and make it yours: src/config.mjs resolves
// overlay/<path> first, then the core path, then examples/<path>, so the board
// runs on this file until you add an overlay. Everything the board watches is
// one entry here. Schedules, selfheal slotspecs and log paths are parsed live
// from each job's LaunchAgent plist — this file only adds display metadata and
// groups. A label listed here but absent from launchd shows as DOWN ("not
// loaded"), which is itself signal. Entries marked `example: true` are
// placeholders: `zulu setup` replaces them with what it finds on your Mac
// (overlay/config/local.json, merged by src/config.mjs). Secrets (SMTP, SMS webhook, heartbeat) never
// live here: data/secrets.env (template: secrets.env.example).

export const DOMAINS = [
  { id: 'app',       name: 'App Jobs',          accent: '#9085e9' },
  { id: 'data',      name: 'Data Pipeline',     accent: '#3987e5' },
  { id: 'infra',     name: 'Infra / Misc',      accent: '#c98500' },
  { id: 'cloud',     name: 'Cloud / Endpoints', accent: '#00e5e5' },
];

// External/HTTP surfaces. Any HTTP response (even 401/403) counts as UP —
// only network errors and timeouts are DOWN. Checked every `everyPolls` polls.
export const ENDPOINTS = [
  { id: 'site', name: 'Website example.com', url: 'https://example.com', everyPolls: 5, example: true },
  { id: 'api-health', name: 'Local API /health :8080', url: 'http://localhost:8080/health', everyPolls: 2, example: true },
  // Optional: also go DOWN when a JSON field is false — okPath is a dotted path
  // into the body, detailPath (a list or map) is quoted in the card detail.
  // { id: 'api-tabs', name: 'API self-check', url: 'http://localhost:8080/health', everyPolls: 2,
  //   okPath: 'checks.ok', detailPath: 'checks.failed' },
];

// Bare processes (nohup/PM2, invisible to launchctl). pgrep by `match`;
// `startCmd` enables the one-tap START action (runs detached in the repo cwd).
export const PROCESSES = [
  // { id: 'worker', match: 'my-app/src/worker.js', name: 'Queue worker', domain: 'app', repo: '~/my-app', startCmd: 'npm run worker' },
];

// User-crontab jobs. READ-ONLY: the board never edits the crontab; `crontab -l`
// is only a periodic drift check.
//   schedule — 5-field cron expr · log — abs path whose mtime proves the run
//   match — substring of the crontab line · grace — minutes before a quiet log
//   turns critical · quietOk — no usable log; judged by crontab presence only
export const CRON = [
  {
    id: 'nightly-report', name: 'Nightly report', domain: 'data',
    repo: '~/my-app', schedule: '30 2 * * *',
    log: `${process.env.HOME}/my-app/logs/nightly-report.log`,
    match: 'nightly-report.sh', grace: 120, example: true,
  },
];

// `crontab -l` drift check cadence (polls).
export const CRON_DRIFT = { everyPolls: 30 };

export const MEM = {
  // swap + kernel pressure — the "Mac quietly drowning" gauge
  swapWarnGB: 16, swapCritGB: 28,
  everyPolls: 2,
};

// Context-window gauge (src/context.mjs): % of the model window used by an
// agent's last turn. The context autopilot (SETTINGS.contextAutopilot) asks for a
// state save at warnPct, compacts at the next idle moment at compactPct once the
// state is saved, and at forcePct even without it. Gauge: amber ≥ warn, red ≥ compact.
export const CONTEXT = { warnPct: 70, compactPct: 80, forcePct: 90, tailBytes: 256 * 1024 };

export const DISK = {
  // tune to your Mac so the gauge isn't permanently amber
  warnPct: 90, critPct: 95,
  // recurring bloat source worth reporting (push-notification attachments)
  bloatGlob: `${process.env.HOME}/Library/Group Containers/group.com.apple.UserNotifications`,
  bloatWarnGB: 6,
  everyPolls: 15,
  name: 'Disk',               // card title
  bloatLabel: 'notif-cache',   // what bloatGlob measures, in the card detail
};

// launchd jobs. grace = minutes after a due slot before a missed selfheal run
// turns critical; quietOk = silent-when-healthy watchdog (exit code only);
// log = the job's real log when the plist's StandardOutPath is not it.
export const JOBS = [
  { label: 'com.example.app.server',  repo: '~/my-app', name: 'App server :8080', domain: 'app', example: true },
  { label: 'com.example.app.sync',    repo: '~/my-app', name: 'Hourly sync',      domain: 'data', grace: 90, example: true },
  { label: 'com.example.app.watchdog', repo: '~/my-app', name: 'Watchdog',        domain: 'infra', quietOk: true, example: true },
];

export const DOCKER_CONTAINERS = [
  { name: 'my-app-db', display: 'Docker: database', domain: 'app', example: true },
];

// Disk auto-remediation levers: src/remediate.mjs runs them in order when the
// disk gauge goes amber/red (at most once per remediation.cooldownHours) and
// reports the GB freed. EMPTY by default — only you know which caches on your
// Mac are safe to delete. Regenerable data only; never user data or volumes.
// Each lever: { name, run: async ({ run, rm, HOME, npmBin }) => {} }
export const REMEDIATION_LEVERS = [
  // { name: 'pip', run: ({ rm, HOME }) => rm(`${HOME}/Library/Caches/pip`, { recursive: true, force: true }) },
  // { name: 'npm', run: ({ run, npmBin }) => run(npmBin, ['cache', 'clean', '--force']) },
  // { name: 'docker-dangling', run: ({ run }) => run('docker', ['image', 'prune', '-f']) },
];

export const SETTINGS = {
  // the human principal (src/config.mjs OWNER): approves on the board, blockable, never woken
  owner: { id: 'owner', name: 'Owner' },
  // product name in the board header, page title and boot text
  brand: 'Zulu Assistant',
  // the public repo (Star button / share-card backlink); empty = hide both
  repoUrl: 'https://github.com/zulu-assistant/zulu-assistant',
  // ledger close gate (src/tasks.mjs): every item must be ticked before a task
  // closes. Running the brain (docs/BRAIN.md)? Add 'vault_synced' and
  // 'graphify_updated' so agents also sync the vault and the code graph.
  ledger: { checklist: ['docs_updated', 'report_written'] },
  // brain autopilot (src/brain.mjs, docs/BRAIN.md), off here. Set it to turn on stale-vault
  // ledger tasks, the brain:autopilot card and a VERIFIED vault_synced / graphify_updated close:
  // { vault: '~/<vault>', staleness: '<staleness.json>', reposTsv: '~/.graphify/repos.tsv',
  //   rebuildLog: '~/.cache/graphify-rebuild.log', requester: 'mission-control', everyMinutes: 10 }
  brain: null,
  // database views on cards (src/view-watch.mjs): one row read over PostgREST with the
  // HEARTBEAT_URL origin + HEARTBEAT_KEY, amber on thresholds. Off here. Example entry:
  //   { label: 'jobs:queue', name: 'Job queue', view: 'queue_status', everyMinutes: 5,
  //     max: { stuck: 0 }, maxAgeMinutes: { last_run_at: 15 }, maxAgeIfSet: { oldest_waiting_at: 60 }, show: ['last_done_at'] }
  viewWatch: [],
  // one fix task per supplier whose documents stop parsing (src/parser-watch.mjs). Off here. Reads a
  // per-supplier view with the keys above; { view, owner, requester, repo, stagingDir, template, everyMinutes }
  parserWatch: null,
  // scheduled ledger backup (src/backup-watch.mjs): a `backup:state` card that goes amber when the
  // newest archive in data/backups/ is older than maxAgeHours (never red). null = no card.
  // Turn it on after installing the daily job (scripts/state-backup-install.sh):
  //   backupWatch: { maxAgeHours: 36 },
  backupWatch: null,
  // extra host names this board answers to for writes (src/request-guard.mjs). localhost, tailnet
  // addresses, *.ts.net names and this machine's hostname are always accepted. Hostnames only, no port.
  allowedHosts: [],
  port: Number(process.env.MC_PORT) || 3210,   // MC_PORT via data/local.env
  pollSeconds: 60,
  // escalation ladder: cmux notify is instant; a red persisting this long also
  // emails; the criticalSms labels also text (needs SMS_* in data/secrets.env)
  escalation: {
    emailAfterMin: 30,
    smsAfterMin: 10,
    criticalSms: ['disk:/'],
    digestHour: 8,
  },
  // auto-remediation: when disk goes amber/red, run ONLY the regenerable levers
  // in src/remediate.mjs, at most once per this many hours
  remediation: { cooldownHours: 24 },
  // alert email/SMS + the dead-man heartbeat read their endpoints, keys and
  // recipients from data/secrets.env (SMTP_*, ALERT_EMAIL_TO, SMS_*, HEARTBEAT_*)
  cmuxSessionsFile: `${process.env.HOME}/.cmuxterm/claude-hook-sessions.json`,
  historySamples: 96,          // per-job status strip length (96 × poll ≈ 96 min at 60s)
  fleetHistorySamples: 1440,   // fleet-health sparkline (~24h at 60s)
  launchAgentsDir: `${process.env.HOME}/Library/LaunchAgents`,
  // selfheal markers are STATE, not cache (never delete them): primary dir +
  // read-only legacy fallback; getMarkers() takes newest-of-both
  selfhealMarkerDir: `${process.env.HOME}/Library/Application Support/selfheal-runner`,
  selfhealLegacyMarkerDir: `${process.env.HOME}/.cache/selfheal-runner`,
  cmuxWorkstream: `${process.env.HOME}/.cmuxterm/workstream.jsonl`,
  // cmux: looked up on PATH (scripts/env.sh puts Homebrew's folders there for launchd). Set a full path to pin one.
  // Not found = the board says so on the cmux:bridge card; a Guardrails-only install never calls it.
  cmuxBin: process.env.CMUX_BIN || 'cmux',
  // interval jobs: stale when the log is quiet for staleFactor × StartInterval
  staleFactor: 3,
  realertHours: 6,
  // weekly GitHub Actions cost reading posted to a ledger task (src/ci-cost-watch.mjs);
  // set e.g. { task: <ledger task id>, weekday: 1, hour: 8 } once CI runs on paid macOS minutes
  ciCostWatch: null,
  // weekly operating reading from the ledger (src/operating-reading.mjs): closes, reopens, waits on you,
  // gate outcomes + approval-to-action time, completion packets, worktrees. mode 'off' | 'observe' (a ticker
  // line + the ops:reading card) | 'on' (also a weekly board comment on one ledger task, created once).
  // e.g. { mode: 'on', weekday: 1, hour: 8, owner: 'mission-control' } (task: <id> to post on an existing one)
  operatingReading: { mode: 'off' },
  // GitHub stats for your repos (stars, forks, watchers, clones, views — kept beyond GitHub's
  // 14 days) as board cards + a digest section; uses your gh login (traffic needs push access).
  // e.g. { repos: ['you/your-repo'], everyHours: 6 }
  repoStats: null,
  // GitHub issues + discussions as an intake front door (src/github-intake.mjs, docs/GITHUB-INTAKE.md): one task per thread,
  // read-only, never replies. mode 'off' | 'observe' (ticker only) | 'on'.
  // e.g. { mode: 'observe', repo: 'you/your-repo', everyMinutes: 15, maxPerPoll: 10, ignoreAuthors: ['your-login'] }
  githubIntake: { mode: 'off' },
  // context autopilot (src/context-autopilot.mjs): the board saves an agent's state and types
  // /compact at its next idle moment (thresholds in CONTEXT). mode 'off' | 'observe' (ticker
  // lines only) | 'on'; only/exclude: agent names; continuity: { <agent>: <state file> } for
  // agents without <repo>/.claude/RESIDENT-STATE.md.
  // e.g. { mode: 'on', only: ['my-resident'], exclude: [], continuity: {} }
  contextAutopilot: { mode: 'off' },
  // completion packet at close (src/completion-packet.mjs): an evidence block on the task — the request,
  // the PR and its head, test runs stamped by `task.sh test N -- <cmd>`, checks not run, gates, the
  // closer's summary (labelled generated). Never blocks a close. 'observe' = a ticker line only.
  // e.g. { mode: 'on', only: ['my-resident'] }
  completionPacket: { mode: 'off' },
  // receipt chain (src/receipt-chain.mjs): every gate change appends one hash-chained line to
  // receipts.jsonl in the Guardrails state folder, and an approved call runs only when the chain holds
  // the approval the running board recorded. 'observe' = lines and a "would dispute" ticker line, the
  // call passes; 'off' = no file, no check. Check a task with: task.sh audit N --verify
  receiptChain: { mode: 'on' },
  // evidence panel (src/evidence.mjs, page /?evidence=1): per task, the completion packet and the gate
  // receipts, read-only, from the ledger. A second Dock browser tab (system/cmux/dock.json). 'off' = no page, no API.
  // install profile (src/profile.mjs): 'full' = the fleet board, the mesh and the heals; 'guardrails' = the ledger,
  // the gate and the waiting rows only (no cmux, no collector). `./install.sh --guardrails` sets it in config/local.json.
  profile: 'full',
  evidencePanel: { mode: 'on' },
  // worktree-per-task (src/worktree.mjs): each spawned worker codes in its own git worktree,
  // <repo-parent>/wt-<task> on branch task/<task>-<slug>; ignored files (data/, .env*) are never copied in.
  // `task.sh worktree-clean N` removes one only when nothing would be lost. residents: true adds the
  // per-task instruction to resident launches. MESH_WORKTREE=0|1 overrides one launch.
  worktrees: { mode: 'on', workers: true, residents: false },
  // how many spawned workers may be live at once before a spawn prints a warning (it never refuses)
  workers: { max: 3 },
  // pane answers (src/tasks.mjs paneAnswersMode): what an approval you gave in an agent's pane is worth
  // once an agent records it (task.sh approved-in-pane / gate-approved).
  //   'confirm' (also when this key is absent): a proposal. You get a row that quotes it, and it counts
  //             when you confirm it on the board. Until then: no grant, no program go, no plan approval.
  //   'direct'  the record IS the decision (the behaviour before 1.2). It rests on a name the agent
  //             declares for itself; choose it only if you accept that.
  // A recorded decline takes effect at once in both modes: it only reduces what runs.
  paneAnswers: 'confirm',
  // caller evidence (src/caller.mjs): the board works out WHO is calling from the process that holds
  // the connection (lsof, the process ancestry, cmux's session map), not from the name the caller
  // declares. Absent = off.
  //   mode      'observe' = the evidence is recorded next to the declared name (the guardrails check
  //             log, the server log, a "[caller mismatch]" ticker line); nothing is refused.
  //             'on' is reserved for a later release: take a week of observe readings first.
  //   tripwire  the decision door, for requests made on this machine:
  //             'agent'   an owner decision (approve, decline, a card action, an upgrade, a snooze)
  //                       that an agent session is behind is refused and named. A decision typed as
  //                       a `!` line inside an agent's pane is one of those: decide on the board page.
  //             'browser' also: a decision must come from a browser or web view. Under 'agent' the
  //                       board only logs what this would refuse ("[door] would refuse"); read
  //                       those lines before you turn it up. A typed approval is refused under it.
  //             false     the door is open.
  //   browsers  app names (without ".app") that count as a browser, e.g. ['Safari', 'Firefox'];
  //             absent = the built-in list. WebKit web views (Safari, the cmux Dock) always count.
  //   jobs      launchd jobs that may use a name: { '<label>': '<name>' },
  //             e.g. { 'com.example.mission-control-triage': 'headless:triage' }
  // A request from another device (your phone) and a failed lookup are never refused by the door.
  callerEvidence: { mode: 'observe', tripwire: 'agent', jobs: {} },
  // Gate integrity (src/gate-integrity.mjs, docs/GUARDRAILS.md): compare the gate's own files in this
  // checkout with what has landed on the remote's default branch (a release install: with its tag),
  // and check that the hook is still registered exactly as installed. The result is part of the
  // guardrails card: red when a gate file differs or the hook is dropped, amber while the checkout
  // is behind. It only reads. 'off' until you turn it on:
  //   gateIntegrity: { mode: 'on', behindMinutes: 0 },   // 0 = being behind stays amber, never red
  gateIntegrity: { mode: 'off' },
  // status taxonomy (src/agent-state.mjs): each agent tile says what the agent is doing (working / input /
  // idle / stopped / UNKNOWN), where that came from (the hook files, or a screen read: "screen") and how
  // sure it is ("?" = low confidence). Never "done" — only a ledger close is. Screen reads are bounded.
  statusTaxonomy: { mode: 'on', runningFreshMinutes: 20, maxReadsPerPoll: 8, readCacheSeconds: 120 },
  // attention ring (src/attention.mjs): the WAITING ON YOU strip shows one row per task (expand on click)
  // and each row can be snoozed 15m / 1h / 4h / until 08:00 tomorrow. A snooze hides the row from the
  // strip and the "(N)" title count only; it never decides anything and never delays an agent.
  // snooze 'off' = today's strip, unchanged.
  attention: { snooze: 'off' },
  // public edition drift (src/release-drift.mjs): compares this checkout's publish set with the
  // newest release of your public repo; a card, a digest line and one ledger ask per episode.
  // e.g. { repo: 'you/your-repo', everyHours: 6, amberDays: 3, owner: '<agent>', queued: [] }
  releaseDrift: null,
  // one-click upgrade (src/upgrade.mjs, docs/UPGRADE.md): checks the public repo's releases every 6h;
  // a release install (origin = that repo, HEAD on a release tag) gets an UPDATE button on the
  // `update` card. mode 'observe' = a ticker line only; null = off. channel 'pre' includes prereleases.
  // repo defaults to the one in repoUrl.
  upgrade: { mode: 'on', channel: 'stable', everyHours: 6 },
  // push approvals to your phone (src/relay.mjs, docs/RELAY.md): a self-hosted ntfy server on your
  // tailnet, or the public ntfy.sh fallback with a 32+ character random topic. Ids and labels only;
  // the tap opens the board, where you still decide. The token goes in data/secrets.env RELAY_TOKEN.
  // e.g. { mode: 'observe', url: 'http://<tailscale-ip>:2586', topic: 'zulu-owner',
  //        boardUrl: 'http://<tailscale-ip>:3210', quiet: { from: '22:00', to: '07:00' } }
  relay: null,
};
