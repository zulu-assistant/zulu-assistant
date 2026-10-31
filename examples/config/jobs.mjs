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
// agent's last turn. Compaction happens near the top, so amber/red warn before it.
export const CONTEXT = { amberPct: 60, redPct: 80, tailBytes: 256 * 1024 };

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
  //     max: { stuck: 0 }, maxAgeMinutes: { last_run_at: 15 }, show: ['last_done_at'] }
  viewWatch: [],
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
  cmuxBin: '/opt/homebrew/bin/cmux',
  // interval jobs: stale when the log is quiet for staleFactor × StartInterval
  staleFactor: 3,
  realertHours: 6,
  // weekly GitHub Actions cost reading posted to a ledger task (src/ci-cost-watch.mjs);
  // set e.g. { task: <ledger task id>, weekday: 1, hour: 8 } once CI runs on paid macOS minutes
  ciCostWatch: null,
  // GitHub stats for your repos (stars, forks, watchers, clones, views — kept beyond GitHub's
  // 14 days) as board cards + a digest section; uses your gh login (traffic needs push access).
  // e.g. { repos: ['you/your-repo'], everyHours: 6 }
  repoStats: null,
  // public edition drift (src/release-drift.mjs): compares this checkout's publish set with the
  // newest release of your public repo; a card, a digest line and one ledger ask per episode.
  // e.g. { repo: 'you/your-repo', everyHours: 6, amberDays: 3, owner: '<agent>', queued: [] }
  releaseDrift: null,
};
