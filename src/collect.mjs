// Read-only collectors. Every external command is time-bounded — a wedged
// docker daemon or launchctl must never hang the board (see the watchdog
// lesson: timeout-less checks silently defeat self-healing).
import { execFile } from 'node:child_process';
import { readFile, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { acrossWindows } from './cmux-windows.mjs';
import { JOBS, DOCKER_CONTAINERS, ENDPOINTS, CRON, CRON_DRIFT, DISK, MEM, PROCESSES, SETTINGS } from './config.mjs';

function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
  });
}

// ---- launchd plists (schedules, selfheal args, log paths) ----
let plistCache = { at: 0, byLabel: new Map() };

export async function getPlists() {
  if (Date.now() - plistCache.at < 5 * 60 * 1000) return plistCache.byLabel;
  const byLabel = new Map();
  for (const job of JOBS) {
    const file = path.join(SETTINGS.launchAgentsDir, `${job.label}.plist`);
    const json = await run('plutil', ['-convert', 'json', '-o', '-', file], 4000);
    if (!json) continue;
    try {
      const p = JSON.parse(json);
      const args = p.ProgramArguments || [];
      const selfheal = args.findIndex((a) => a.includes('selfheal-runner.sh'));
      byLabel.set(job.label, {
        args,
        selfheal: selfheal >= 0 ? { marker: args[selfheal + 1], slotspec: args[selfheal + 2] } : null,
        calendar: p.StartCalendarInterval || null,
        interval: p.StartInterval || null,
        keepAlive: p.KeepAlive === true,
        outLog: p.StandardOutPath || null,
        errLog: p.StandardErrPath || null,
      });
    } catch { /* unparseable plist -> treated as missing */ }
  }
  plistCache = { at: Date.now(), byLabel };
  return byLabel;
}

// ---- launchctl list -> { label: { pid, lastExit } } ----
export async function getLaunchctl() {
  const out = await run('launchctl', ['list'], 6000);
  const map = new Map();
  if (!out) return map;
  for (const line of out.split('\n').slice(1)) {
    const [pid, status, label] = line.split('\t');
    if (!label) continue;
    map.set(label.trim(), {
      pid: pid !== '-' ? Number(pid) : null,
      lastExit: status !== '-' ? Number(status) : null,
    });
  }
  return map;
}

// ---- selfheal markers -> { markerName: epochSeconds } ----
// Markers live in Application Support ("markers are state, not cache"), with
// ~/.cache as a read-only legacy fallback.
// Mirror the wrapper's newest-wins rule across both locations.
export async function getMarkers() {
  const map = new Map();
  const dirs = [SETTINGS.selfhealMarkerDir, SETTINGS.selfhealLegacyMarkerDir].filter(Boolean);
  for (const dir of dirs) {
    try {
      for (const f of await readdir(dir)) {
        if (!f.endsWith('.last')) continue;
        const raw = await readFile(path.join(dir, f), 'utf8').catch(() => null);
        const epoch = Number((raw || '').trim());
        const label = f.replace(/\.last$/, '');
        if (epoch && epoch > (map.get(label) || 0)) map.set(label, epoch);
      }
    } catch { /* dir missing -> skip */ }
  }
  return map;
}

// ---- docker ----
export async function getDocker() {
  const out = await run('/usr/local/bin/docker', ['ps', '-a', '--format', '{{json .}}'], 8000)
    ?? await run('docker', ['ps', '-a', '--format', '{{json .}}'], 8000);
  if (out == null) return { reachable: false, containers: new Map() };
  const containers = new Map();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line);
      containers.set(c.Names, { status: c.Status || '', state: c.State || '' });
    } catch { /* skip */ }
  }
  return { reachable: true, containers };
}

// ---- log mtime + tail ----
export async function logMtime(file) {
  if (!file) return null;
  try { return (await stat(file)).mtimeMs; } catch { return null; }
}

export async function tailFile(file, lines = 60) {
  if (!file) return '';
  try {
    const fh = await readFile(file);
    const text = fh.toString('utf8');
    return text.split('\n').slice(-lines).join('\n');
  } catch { return ''; }
}

// ---- cmux workstream (agent activity feed) ----
export async function getAgentFeed(limit = 40) {
  try {
    const raw = await readFile(SETTINGS.cmuxWorkstream, 'utf8');
    const lines = raw.trim().split('\n');
    const items = [];
    for (const line of lines.slice(-limit).reverse()) {
      try {
        const j = JSON.parse(line);
        items.push({
          at: j.createdAt || j.timestamp || j.at || null,
          title: j.title || (j.source && j.kind ? `${j.source} · ${j.kind}` : j.type || 'event'),
          subtitle: j.subtitle || '',
          body: j.body || j.message ||
            (j.cwd ? j.cwd.replace(process.env.HOME, '~') : ''),
        });
      } catch { /* skip malformed line */ }
    }
    return items;
  } catch { return []; }
}

// ---- cmux Claude sessions (running/idle/needsInput per session) ----
// Socket-auth health piggybacks on this poll: a cmux app update can wipe the
// migrated password (happened 0.64.20), silently killing
// dispatch + notify. status.mjs surfaces this as the cmux:bridge card.
let cmuxBridge = { ok: true, detail: '' };
export function cmuxBridgeStatus() { return cmuxBridge; }

async function workspaceNames() {
  try {
    const pw = (await readFile(new URL('../data/cmux-socket-password', import.meta.url), 'utf8')).trim();
    const run = (args) => new Promise((resolve) => {
      execFile(SETTINGS.cmuxBin, args,
        { timeout: 6000, env: { ...process.env, CMUX_SOCKET_PASSWORD: pw, CMUX_QUIET: '1' } },
        (e, stdout, stderr) => resolve({
          err: e ? (String(stderr || '').trim() || e.message) : null,
          out: String(stdout || ''),
        }));
    });
    const { err, out } = await acrossWindows(run, ['workspace', 'list', '--id-format', 'both']);
    cmuxBridge = err ? { ok: false, detail: err.slice(0, 110) } : { ok: true, detail: '' };
    const map = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/([0-9A-F-]{36})\s+(.+?)(\s+\[selected\])?\s*$/);
      if (m) map.set(m[1], m[2].replace(/^✳\s*/, ''));
    }
    return map;
  } catch { return new Map(); }
}

export async function getSessions() {
  try {
    const d = JSON.parse(await readFile(SETTINGS.cmuxSessionsFile, 'utf8'));
    const wsNames = await workspaceNames();
    const activeIds = new Set(
      Object.values(d.activeSessionsBySurface || {}).map((s) => s.sessionId));
    const cutoff = Date.now() / 1000 - 48 * 3600;
    return Object.entries(d.sessions || {})
      .map(([id, s]) => ({
        id,
        lifecycle: s.agentLifecycle || 'unknown',
        cwd: (s.cwd || '').replace(process.env.HOME, '~'),
        workspace: wsNames.get(s.workspaceId) || '',
        workspaceId: s.workspaceId || '',
        note: s.lastBody || s.lastSubtitle || '',
        active: activeIds.has(id),
        updatedAt: (s.launchCommand?.capturedAt || 0) * 1000,
      }))
      .filter((s) => s.active || (s.updatedAt / 1000) > cutoff)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt)
      .slice(0, 24);
  } catch { return []; }
}

// ---- HTTP endpoint checks (any HTTP response = up; error/timeout = down) ----
// An entry may add `okPath` (dotted path into a JSON body, e.g. 'tabs.ok'):
// the card then also goes DOWN when that field is false, with the optional
// `detailPath` (e.g. 'tabs.failed') quoted in the detail. A body that is not
// JSON or lacks the path is reported, never treated as a failure.
const pathGet = (obj, dotted) => String(dotted || '').split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
export function judgeBody(ep, text) {
  if (!ep.okPath) return { okFlag: null, note: '' };
  let body;
  try { body = JSON.parse(text); } catch { return { okFlag: null, note: `${ep.okPath} unreadable (body not JSON)` }; }
  const v = pathGet(body, ep.okPath);
  if (v === undefined || v === null) return { okFlag: null, note: `${ep.okPath} absent` };
  if (v === true) return { okFlag: true, note: `${ep.okPath} true` };
  const why = ep.detailPath ? pathGet(body, ep.detailPath) : null;
  const list = Array.isArray(why) ? why.join(', ') : (why && typeof why === 'object' ? Object.keys(why).join(', ') : (why ?? ''));
  return { okFlag: false, note: `${ep.okPath} false${list ? ` (${String(list).slice(0, 80)})` : ''}` };
}
const epCache = new Map(); // id -> { polls, result }
export async function httpChecks(pollCount) {
  const results = [];
  for (const ep of ENDPOINTS) {
    const cached = epCache.get(ep.id);
    if (cached && pollCount % ep.everyPolls !== 0) { results.push(cached.result); continue; }
    let result;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(ep.url, { method: 'GET', redirect: 'manual', signal: ctl.signal })
        .finally(() => clearTimeout(t));
      const judged = ep.okPath ? judgeBody(ep, await res.text().catch(() => '')) : { okFlag: null, note: '' };
      result = { ...ep, up: true, code: res.status, ...judged };
    } catch (err) {
      result = { ...ep, up: false, code: null, err: err.cause?.code || err.name };
    }
    epCache.set(ep.id, { polls: pollCount, result });
    results.push(result);
  }
  return results;
}

// ---- disk gauge (root % + known bloat dir size), cached between polls ----
let diskCache = null;
export async function diskStatus(pollCount) {
  if (diskCache && pollCount % DISK.everyPolls !== 0) return diskCache;
  const df = await new Promise((resolve) => {
    execFile('df', ['-k', '/System/Volumes/Data'], { timeout: 10000 }, (e, out) => resolve(out || ''));
  });
  const line = df.split('\n')[1] || '';
  const pct = Number((line.match(/(\d+)%/) || [])[1] || 0);
  const du = await new Promise((resolve) => {
    execFile('du', ['-sk', DISK.bloatGlob], { timeout: 60000, killSignal: 'SIGKILL' }, (e, out) => resolve(out || ''));
  });
  const bloatGB = Math.round((Number((du.split('\t')[0] || 0)) / 1024 / 1024) * 10) / 10;
  diskCache = { pct, bloatGB };
  return diskCache;
}

// ---- bare-process checks (nohup/cron-managed, not in launchctl) ----
export async function processChecks() {
  const results = [];
  for (const p of PROCESSES) {
    const out = await new Promise((resolve) => {
      execFile('pgrep', ['-f', p.match], { timeout: 5000 }, (e, stdout) => resolve(String(stdout || '').trim()));
    });
    const pid = out.split('\n')[0] || null;
    results.push({ ...p, pid });
  }
  return results;
}

// ---- user-crontab jobs (invisible to launchctl) ----
// Freshness comes from each job's log mtime — the registry, not `crontab -l`,
// is the source of truth, so the poll costs one stat() per entry. `crontab -l`
// runs only every CRON_DRIFT.everyPolls polls, purely to notice a line that was
// edited or removed out from under the board; a failed/absent read leaves
// presence `null` (unknown) and never manufactures an alert.
let cronDrift = { polls: -1, present: null }; // present: Map(id -> bool) | null

// scheduled (non-@reboot) crontab lines only — a surviving @reboot self-heal
// line is not the recurring schedule this registry entry stands for
export function cronPresence(crontabText, registry = CRON) {
  const lines = String(crontabText || '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('@'));
  const map = new Map();
  for (const c of registry) map.set(c.id, lines.some((l) => l.includes(c.match)));
  return map;
}

export async function cronChecks(pollCount) {
  if (cronDrift.present === null || pollCount % CRON_DRIFT.everyPolls === 0) {
    const out = await run('crontab', ['-l'], 5000);
    // null = crontab unreadable; keep the last known map rather than flapping
    if (out != null) cronDrift = { polls: pollCount, present: cronPresence(out) };
  }
  const results = [];
  for (const c of CRON) {
    results.push({
      ...c,
      mtime: c.log ? await logMtime(c.log) : null,
      present: cronDrift.present ? cronDrift.present.get(c.id) : null,
    });
  }
  return results;
}

// ---- memory pressure (swap GB + kernel pressure level) ----
let memCache = null;
export async function memStatus(pollCount) {
  if (memCache && pollCount % MEM.everyPolls !== 0) return memCache;
  const swapOut = await new Promise((resolve) => {
    execFile('sysctl', ['-n', 'vm.swapusage'], { timeout: 5000 }, (e, out) => resolve(out || ''));
  });
  const swapGB = Number((swapOut.match(/used = ([\d.]+)M/) || [])[1] || 0) / 1024;
  const lvlOut = await new Promise((resolve) => {
    execFile('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], { timeout: 5000 }, (e, out) => resolve(out || '1'));
  });
  // 1 = normal, 2 = warning, 4 = critical
  memCache = { swapGB: Math.round(swapGB * 10) / 10, pressure: Number(String(lvlOut).trim()) || 1 };
  return memCache;
}

export { DOCKER_CONTAINERS };
