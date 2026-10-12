// Demo mode (MC_DEMO=1): a synthetic fleet, agent workforce and task ledger so
// the board renders on any Mac with nothing but Node — no launchd jobs, no
// Docker, no cmux. server.mjs swaps its collectors for these and turns every
// side effect (actions, alerts, heartbeat, heals, mesh delivery) into a ticker
// line that says what WOULD have happened. It is also the GIF/screenshot source.
// Its state is its own: data/demo-tasks/, data/demo-events.json,
// data/demo-star-prompt.json and an in-memory decision token — a demo run in a
// live checkout never reads or writes the real board's ledger, ticker, toast
// state, history or token (test/demo.test.mjs proves it).
//
// A scripted incident loops every CYCLE_S seconds so a recording shows the
// whole story: a job fails → the self-heal restarts it → it goes green again →
// a worker needs input → a ledger task closes.
import { rm, mkdir } from 'node:fs/promises';

export const DEMO = process.env.MC_DEMO === '1';
export const DEMO_POLL_SECONDS = Number(process.env.MC_DEMO_POLL) || 5;
export const CYCLE_S = 150;

export const DEMO_DOMAINS = [
  { id: 'app',   name: 'App Jobs',          accent: '#9085e9' },
  { id: 'data',  name: 'Data Pipeline',     accent: '#3987e5' },
  { id: 'infra', name: 'Infra / Misc',      accent: '#c98500' },
  { id: 'cloud', name: 'Cloud / Endpoints', accent: '#00e5e5' },
];

const T0 = Date.now();
const phase = (now = Date.now()) => ((now - T0) / 1000) % CYCLE_S;
// With a cmux demo up (src/demo-cmux.mjs) the synthetic agents point at real
// demo panes, and what those panes show drives their state.
let paneIds = new Map();        // n -> workspace UUID of its demo pane
let observed = new Map();       // workspace UUID -> classifyScreen state
export function useDemoPanes(m) { paneIds = new Map(m); }
export function observeDemoScreens(m) { observed = new Map(m); }
const ws = (n) => paneIds.get(n) || `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hhmm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// scripted incident windows (seconds into the cycle)
const FAIL_AT = 20, HEAL_AT = 38, GREEN_AT = 44, INPUT_AT = 60, INPUT_END = 110, CLOSE_AT = 90;

function job(label, name, domain, status, detail, schedule, extra = {}) {
  return { label, name, domain, status, detail, schedule, logAvailable: label.startsWith('com.') || label.startsWith('cron:'), ...extra };
}

export function demoJobs(now = Date.now()) {
  const p = phase(now);
  const failing = p >= FAIL_AT && p < GREEN_AT;      // the heal lands first, green follows
  const nextHour = new Date(now); nextHour.setMinutes(0, 0, 0); nextHour.setHours(nextHour.getHours() + 1);
  return [
    job('com.example.app.server', 'App server :8080', 'app', 'ok', 'running · pid 4312', 'always-on'),
    job('proc:queue-worker', 'Queue worker', 'app', 'ok', 'running · pid 5120', 'process'),
    job('docker:app-db', 'Docker: database', 'app', 'ok', 'Up 3 days (healthy)', 'container'),
    job('docker:app-cache', 'Docker: cache', 'app', 'ok', 'Up 3 days', 'container'),
    job('com.example.data.sync', 'Hourly sync', 'data', failing ? 'failed' : 'ok',
      failing ? 'last exit 1 · upstream timeout' : `last activity ${p >= GREEN_AT ? Math.max(1, Math.round((p - GREEN_AT) / 60)) + 'm' : '12m'} ago`,
      'every 60m', { next: hhmm(nextHour) }),
    job('com.example.data.index', 'Search index rebuild', 'data', 'ok', 'last success 3h ago', '00:00,06:00,12:00,18:00'),
    job('cron:nightly-report', 'Nightly report', 'data', 'ok', 'ran 02:30 · log 9h ago', '30 2 * * *'),
    job('com.example.data.export', 'Weekly export', 'data', 'due', `${hhmm(new Date(now - 40 * 60e3))} slot pending · last success 7d ago`, 'Mon 09:00'),
    job('com.example.infra.watchdog', 'Watchdog', 'infra', 'ok', 'loaded · exit 0', 'every 5m'),
    job('com.example.infra.backup', 'Backup to NAS', 'infra', 'ok', 'last success 5h ago', '01:00,13:00'),
    job('disk:/', 'Disk', 'infra', 'warn', '91% used · notif-cache 1.2 GB', 'gauge'),
    job('mem:', 'Memory / Swap', 'infra', 'ok', 'swap 2.1 GB · pressure normal', 'gauge'),
    job('cmux:bridge', 'cmux bridge (dispatch + notify)', 'infra', 'ok', 'socket auth OK (demo)', 'socket check'),
    job('endpoint:site', 'Website example.com', 'cloud', 'ok', 'HTTP 200', 'http check'),
    job('endpoint:status', 'Status page', 'cloud', 'ok', 'HTTP 200', 'http check'),
    job('endpoint:hooks', 'Webhook receiver', 'cloud', 'ok', 'HTTP 401 (up)', 'http check'),
  ];
}

function demoTimeline(now) {
  const out = [];
  const add = (label, name, at, grace = 120) => out.push({
    label, name, at,
    state: at > now ? 'upcoming' : (now - at <= grace * 60e3 && label === 'com.example.data.export') ? 'pending' : 'ran',
  });
  const from = now - 12 * 3600e3, to = now + 12 * 3600e3;
  const h0 = new Date(from); h0.setMinutes(0, 0, 0);
  for (let t = +h0; t <= to; t += 3600e3) {
    const d = new Date(t);
    if (t >= from) add('com.example.data.sync', 'Hourly sync', t);
    if (d.getHours() % 6 === 0 && t >= from) add('com.example.data.index', 'Search index rebuild', t);
    if ((d.getHours() === 1 || d.getHours() === 13) && t >= from) add('com.example.infra.backup', 'Backup to NAS', t);
    if (d.getHours() === 2 && t + 30 * 60e3 >= from) add('cron:nightly-report', 'Nightly report', t + 30 * 60e3);
  }
  add('com.example.data.export', 'Weekly export', now - 40 * 60e3);
  const p = phase(now);
  if (p >= FAIL_AT && p < GREEN_AT) {            // the failed hourly run shows as missed until the heal
    const last = out.filter((s) => s.label === 'com.example.data.sync' && s.at <= now).pop();
    if (last) last.state = 'missed';
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---- agents: sessions (tiles), directory (mesh), context gauges ----
const AGENTS = [
  { n: 1, workspace: '⌘ MISSION CONTROL', name: 'mission-control', kind: 'mission-control', domain: 'ops', vendor: 'claude', cwd: '~/zulu-assistant',
    owns: ['workforce', 'triage'], pct: 34, lifecycle: 'running', note: 'Triage pass: 1 red → self-heal handled it; nothing to escalate' },
  { n: 2, workspace: 'app — resident', name: 'app-resident', kind: 'resident', domain: 'app', vendor: 'claude', cwd: '~/my-app',
    owns: ['app', 'queue-worker'], pct: 64, lifecycle: 'idle', note: 'PR #12 opened: retry backoff for the queue worker' },
  { n: 3, workspace: 'data — resident', name: 'data-resident', kind: 'resident', domain: 'data', vendor: 'claude', cwd: '~/data-pipeline',
    owns: ['sync', 'search-index'], pct: 18, lifecycle: 'running', note: 'Rebuilding the search-index mapping (task #2)' },
  { n: 4, workspace: 'fix: Weekly export', name: 'fix-weekly-export', kind: 'worker', domain: 'data', vendor: 'claude', cwd: '~/data-pipeline',
    owns: ['task #3'], pct: 41, lifecycle: 'running', note: 'Reproducing the export timeout locally' },
  { n: 5, workspace: 'docs — worker', name: 'docs-worker', kind: 'worker', domain: 'web', vendor: 'claude', cwd: '~/zulu-assistant',
    owns: ['task #1'], pct: 83, lifecycle: 'idle', note: 'CHANGELOG + README updated for 0.1.0' },
  { n: 6, workspace: 'codex — review', name: 'codex-review', kind: 'worker', domain: 'app', vendor: 'codex', cwd: '~/my-app',
    owns: ['PR #12'], pct: 22, lifecycle: 'running', note: 'Reviewing PR #12' },
];

const bandOf = (pct) => (pct >= 80 ? 'red' : pct >= 60 ? 'amber' : 'ok');

export function demoSessions(now = Date.now()) {
  const p = phase(now);
  return AGENTS.map((a) => {
    let { lifecycle, note } = a;
    const seen = observed.get(ws(a.n));
    if (seen) {                                   // cmux demo: the pane's screen decides
      lifecycle = seen === 'dialog' ? 'needsInput' : seen === 'busy' ? 'running' : 'idle';
      if (seen === 'dialog') note = 'Needs approval: restart the queue worker in production?';
    } else if (a.n === 4 && p >= INPUT_AT && p < INPUT_END) {
      lifecycle = 'needsInput';
      note = 'Needs approval: re-run the export against production? (POLICY: destructive → owner)';
    }
    return { id: `demo-${a.n}`, lifecycle, cwd: a.cwd, workspace: a.workspace, workspaceId: ws(a.n), note, active: true, updatedAt: now - a.n * 60e3 };
  });
}

export function demoDirectory() {
  return AGENTS.map((a) => ({
    name: a.name, kind: a.kind, vendor: a.vendor, owns: a.owns, domain: a.domain, status: 'active', workspaceId: ws(a.n), title: a.workspace,
    live: { liveName: a.name, nameOk: true, status: a.lifecycle === 'running' ? 'busy' : 'ready' },
  }));
}

export function demoContext(now = Date.now()) {
  const drift = Math.floor(phase(now) / 30);     // gauges creep up a little each cycle
  return new Map(AGENTS.map((a) => {
    // the working resident's gauge climbs 12% → 72% over a cycle, so the amber band shows
    const pct = a.n === 3 ? Math.round(12 + (phase(now) / CYCLE_S) * 60) : Math.min(99, a.pct + drift);
    return [ws(a.n), { pct, band: bandOf(pct), ctxTokens: pct * 10000, window: 1000000, model: a.vendor === 'codex' ? 'codex' : 'claude-opus', source: a.vendor }];
  }));
}

export function demoSnapshot(now = Date.now()) {
  const jobs = demoJobs(now);
  const sessions = demoSessions(now);
  const attention = jobs.filter((j) => j.status !== 'ok');
  return {
    at: now, demo: true, dockerReachable: true, jobs, timeline: demoTimeline(now), sessions,
    counts: {
      ok: jobs.length - attention.length, attention: attention.length, total: jobs.length,
      agents: sessions.length, agentsNeedInput: sessions.filter((s) => s.lifecycle === 'needsInput').length,
    },
  };
}

/** 24h of believable history so the sparkline and strips aren't empty on first paint. */
export function demoHistory(now = Date.now()) {
  const fleet = [];
  for (let i = 240; i > 0; i -= 1) {
    const dip = i % 67 < 3 ? 2 : i % 41 < 2 ? 1 : 0;
    fleet.push({ at: now - i * 6 * 60e3, okPct: (16 - 1 - dip) / 16 });
  }
  const perJob = {};
  for (const j of demoJobs(now)) {
    perJob[j.label] = Array.from({ length: 48 }, (_, i) => (
      j.label === 'com.example.data.sync' && (i === 9 || i === 31) ? 'failed'
        : j.label === 'disk:/' && i > 30 ? 'warn'
        : j.label === 'com.example.data.export' && i > 44 ? 'due' : 'ok'));
  }
  return { fleet, perJob };
}

/** Script beats crossed since the last tick → ticker lines + side effects for server.mjs. */
export function demoBeats(prevNow, now) {
  const a = phase(prevNow), b = phase(now);
  const crossed = (t) => (a <= b ? a < t && t <= b : a < t || t <= b);
  const out = [];
  if (crossed(HEAL_AT)) out.push({ kind: 'good', text: 'self-heal: Hourly sync exited 1 → kickstarted, rerun OK' });
  // the toast waits until the card is green again: the catch is complete
  if (crossed(GREEN_AT + 1)) out.push({ kind: 'sys', text: 'Hourly sync healthy again — no page needed', success: 'a failed Hourly sync run and restarted it' });
  if (crossed(INPUT_AT)) out.push({ kind: 'bad', text: 'fix-weekly-export NEEDS INPUT: re-run the export against production?' });
  if (crossed(CLOSE_AT)) out.push({ kind: 'sys', text: 'mission-control: triage pass clean — 0 escalations', closeTask: true });
  return out;
}

export function demoFeed(now = Date.now()) {
  return [
    { at: new Date(now - 2 * 60e3).toISOString(), title: 'mission-control · triage', subtitle: '12:30 pass', body: '1 red card (Hourly sync) was self-healed; no escalation needed.' },
    { at: new Date(now - 9 * 60e3).toISOString(), title: 'app-resident · stop', subtitle: 'PR #12', body: 'Opened PR #12: exponential backoff for the queue worker. Tests green.' },
    { at: new Date(now - 17 * 60e3).toISOString(), title: 'Ops Board', subtitle: 'Weekly export', body: 'Slot pending — dispatching a worker to investigate.' },
    { at: new Date(now - 31 * 60e3).toISOString(), title: 'docs-worker · stop', subtitle: 'task #4', body: 'CHANGELOG and README updated for 0.1.0; report written.' },
  ];
}

export function demoLog(label) {
  const t = (m) => new Date(Date.now() - m * 60e3).toISOString().replace('T', ' ').slice(0, 19);
  if (label === 'com.example.data.sync') return { out: `${t(62)} sync: 1,204 rows upserted\n${t(2)} sync: upstream timeout after 30s\n${t(1)} selfheal: exit 1 → kickstart\n${t(0)} sync: 1,198 rows upserted`, err: `${t(2)} Error: ETIMEDOUT api.example.com:443` };
  return { out: `${t(30)} (demo) ${label}: started\n${t(29)} (demo) ${label}: finished OK`, err: '' };
}

/** Fresh demo ledger each start: one task per column so the WORK panel is populated. */
export async function seedDemoLedger(dir, createLedger) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const L = createLedger(dir);
  const mk = (title, requester, owner, priority = 'normal') => L.create({ title, requester, owner, priority, owner_ws: null });
  const t1 = await mk('Publish the 0.1.0 release notes to the mailing list', 'mission-control', 'docs-worker');
  await L.update(t1.id, { op: 'request_approval', actor: 'docs-worker', policy_item: 'outward: anything sent to people outside the machine', text: 'Draft ready in data/handoffs/release-notes.md' });
  const t2 = await mk('Search index: rebuild mapping for the new product fields', 'mission-control', 'data-resident', 'high');
  await L.update(t2.id, { op: 'start', actor: 'data-resident', text: 'Mapping drafted; reindex running' });
  const t3 = await mk('Weekly export missed its slot — find the root cause', 'board', 'fix-weekly-export');
  await L.update(t3.id, { op: 'block', actor: 'fix-weekly-export', blocked_on: [t2.id], text: 'Export reads the index; waiting on #2' });
  const t4 = await mk('Queue worker: add retry backoff', 'mission-control', 'app-resident');
  await L.update(t4.id, { op: 'start', actor: 'app-resident', text: 'PR #12 open' });
  await mk('Triage the 16:30 pass', 'board', 'mission-control');
  return L;
}
