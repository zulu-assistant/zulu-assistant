// Turn raw collector output into per-job status.
// Status vocabulary (dataviz status roles — icon + label always accompany color):
//   ok        good      — ran on schedule / process up / container healthy
//   due       warning   — a selfheal slot has passed, still inside the grace window
//   stale     warning   — interval job's log quiet for staleFactor × interval (data went old)
//   warn      warning   — gauge (disk/mem) in its amber band; reading is FRESH, value is high
//   failed    serious   — last exit code non-zero
//   overdue   critical  — selfheal slot missed beyond grace
//   down      critical  — KeepAlive service without a PID / not loaded / container down
import { JOBS, DOCKER_CONTAINERS, CRON, DISK, MEM, SETTINGS } from './config.mjs';
import * as collect from './collect.mjs';
import { readStateSync, setupCard } from './setup.mjs';
import { readStatsSync, repoCards } from './repo-stats.mjs';

let pollCount = 0;

// slotspec: "daily:HH:MM[,HH:MM...]" | "weekly:W:HH:MM" (W: 0=Sun) | "monthly:D:HH:MM" (D: 1–28)
export function lastDueSlot(slotspec, now = new Date()) {
  if (!slotspec) return null;
  const mk = (base, h, m, dayOffset = 0) => {
    const d = new Date(base);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const candidates = [];
  if (slotspec.startsWith('daily:')) {
    for (const t of slotspec.slice(6).split(',')) {
      const [h, m] = t.split(':').map(Number);
      candidates.push(mk(now, h, m, 0), mk(now, h, m, -1));
    }
  } else if (slotspec.startsWith('weekly:')) {
    const [w, h, m] = slotspec.slice(7).split(':').map(Number);
    const diff = (now.getDay() - w + 7) % 7;
    candidates.push(mk(now, h, m, -diff), mk(now, h, m, -diff - 7));
  } else if (slotspec.startsWith('monthly:')) {
    // D is capped at 28 by the selfheal runner, so setDate never rolls over.
    const [dom, h, m] = slotspec.slice(8).split(':').map(Number);
    for (const monthOff of [0, -1]) {
      const d = new Date(now);
      d.setDate(1);
      d.setMonth(d.getMonth() + monthOff);
      d.setDate(dom);
      d.setHours(h, m, 0, 0);
      candidates.push(d);
    }
  } else return null;
  const past = candidates.filter((d) => d <= now);
  return past.length ? new Date(Math.max(...past.map((d) => +d))) : null;
}

export function nextSlot(slotspec, now = new Date()) {
  if (!slotspec) return null;
  const last = lastDueSlot(slotspec, now);
  const horizon = slotspec.startsWith('monthly:') ? 32 : slotspec.startsWith('weekly:') ? 8 : 2;
  for (let addMin = 1; addMin <= horizon * 24 * 60; addMin += 15) {
    const probe = new Date(+now + addMin * 60000);
    const due = lastDueSlot(slotspec, probe);
    if (due && (!last || +due > +last)) return due;
  }
  return null;
}

// every slot of a slotspec inside a ±12h window — feeds the 24h ops timeline
export function slotsInWindow(slotspec, now = new Date()) {
  const from = +now - 12 * 3600e3, to = +now + 12 * 3600e3;
  const mk = (h, m, dayOffset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const out = [];
  if (slotspec?.startsWith('daily:')) {
    for (const t of slotspec.slice(6).split(',')) {
      const [h, m] = t.split(':').map(Number);
      for (const off of [-1, 0, 1]) { const d = mk(h, m, off); if (+d >= from && +d <= to) out.push(d); }
    }
  } else if (slotspec?.startsWith('weekly:')) {
    const [w, h, m] = slotspec.slice(7).split(':').map(Number);
    const diff = (now.getDay() - w + 7) % 7;
    for (const off of [-diff - 7, -diff, -diff + 7]) { const d = mk(h, m, off); if (+d >= from && +d <= to) out.push(d); }
  } else if (slotspec?.startsWith('monthly:')) {
    const [dom, h, m] = slotspec.slice(8).split(':').map(Number);
    for (const monthOff of [-1, 0, 1]) {
      const d = new Date(now);
      d.setDate(1);
      d.setMonth(d.getMonth() + monthOff);
      d.setDate(dom);
      d.setHours(h, m, 0, 0);
      if (+d >= from && +d <= to) out.push(d);
    }
  }
  return out.sort((a, b) => a - b);
}

/* ---------- user-crontab schedules ----------
 * Only the subset the registry actually uses: 5 fields (min hour dom month dow),
 * each `*`, a number, a comma list, a range, or a `*`/range with a `/n` step.
 * No dependency (zero-dep repo rule), no @macros — @reboot lines are self-heal
 * hooks, not schedules, and are deliberately out of scope.
 */
function parseField(spec, min, max, mapper = (n) => n) {
  const set = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) return null;
    let lo, hi;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number);
      lo = a; hi = b;
    } else { lo = Number(range); hi = lo; }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi || lo < min || hi > max) return null;
    for (let v = lo; v <= hi; v += step) set.add(mapper(v));
  }
  return set.size ? set : null;
}

export function parseCron(expr) {
  const f = String(expr || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dow = parseField(f[4], 0, 7, (n) => n % 7);   // 7 = Sunday = 0
  if (!minute || !hour || !dom || !month || !dow) return null;
  return { minute, hour, dom, month, dow, domStar: f[2] === '*', dowStar: f[4] === '*' };
}

// cron's day rule: with BOTH dom and dow restricted the two are OR'd, not AND'd
function dayMatches(f, d) {
  if (!f.month.has(d.getMonth() + 1)) return false;
  const dom = f.dom.has(d.getDate());
  const dow = f.dow.has(d.getDay());
  if (!f.domStar && !f.dowStar) return dom || dow;
  if (!f.domStar) return dom;
  if (!f.dowStar) return dow;
  return true;
}

// walk whole days, then that day's hour/minute sets — cheap enough to run every
// poll for every registered cron job (vs. minute-stepping an 8-day window)
function walkSlots(expr, now, { back, days }) {
  const f = parseCron(expr);
  if (!f) return null;
  const hours = [...f.hour].sort((a, b) => a - b);
  const mins = [...f.minute].sort((a, b) => a - b);
  const dir = back ? -1 : 1;
  for (let off = 0; off <= days; off += 1) {
    const day = new Date(now);
    day.setDate(day.getDate() + dir * off);
    day.setHours(0, 0, 0, 0);
    if (!dayMatches(f, day)) continue;
    for (const h of back ? [...hours].reverse() : hours) {
      for (const m of back ? [...mins].reverse() : mins) {
        const d = new Date(day);
        d.setHours(h, m, 0, 0);
        if (back ? d <= now : d > now) return d;
      }
    }
  }
  return null;
}

// most recent due slot at or before `now` (null if none within ~8 days)
export function lastCronSlot(expr, now = new Date()) {
  return walkSlots(expr, now, { back: true, days: 8 });
}

// next slot strictly after `now`
export function nextCronSlot(expr, now = new Date()) {
  return walkSlots(expr, now, { back: false, days: 8 });
}

// every slot inside ±12h — feeds the same 24h ops timeline as selfheal slotspecs
export function cronSlotsInWindow(expr, now = new Date()) {
  const f = parseCron(expr);
  if (!f) return [];
  const from = +now - 12 * 3600e3, to = +now + 12 * 3600e3;
  const out = [];
  for (const off of [-1, 0, 1]) {
    const day = new Date(now);
    day.setDate(day.getDate() + off);
    day.setHours(0, 0, 0, 0);
    if (!dayMatches(f, day)) continue;
    for (const h of f.hour) {
      for (const m of f.minute) {
        const d = new Date(day);
        d.setHours(h, m, 0, 0);
        if (+d >= from && +d <= to) out.push(d);
      }
    }
  }
  return out.sort((a, b) => a - b);
}

// registry entry + collector reading -> the same card shape every other watched
// thing produces, so the escalation ladder and frontend need no special case
export function cronJobStatus(c, now = new Date()) {
  const j = {
    label: `cron:${c.id}`, name: c.name, domain: c.domain, repo: c.repo,
    schedule: `cron ${c.schedule}`, logAvailable: Boolean(c.log),
    status: 'ok', detail: '',
  };
  const next = nextCronSlot(c.schedule, now);
  j.next = next ? fmtTime(next) : '—';

  if (c.present === false) return { ...j, status: 'down', detail: 'line missing from crontab' };
  if (!parseCron(c.schedule)) return { ...j, status: 'down', detail: `unparseable cron expr "${c.schedule}"` };
  // quietOk / no log: nothing proves a run, so presence is the whole signal
  if (c.quietOk || !c.log) {
    return { ...j, detail: c.present === null ? 'scheduled (crontab not read yet)' : 'scheduled in crontab' };
  }

  const due = lastCronSlot(c.schedule, now);
  const graceMs = (c.grace ?? 120) * 60000;
  if (!due) {
    j.status = c.mtime ? 'ok' : 'due';
    j.detail = c.mtime ? `last activity ${ago(c.mtime)}` : 'no run recorded yet';
  } else if (c.mtime && c.mtime >= +due) {
    j.status = 'ok';
    j.detail = `last activity ${ago(c.mtime)}`;
  } else {
    j.status = +now - +due <= graceMs ? 'due' : 'overdue';
    j.detail = `${fmtTime(due)} slot ${j.status === 'due' ? 'pending' : 'MISSED'}` +
      (c.mtime ? ` · last activity ${ago(c.mtime)}` : ' · never ran');
  }
  return j;
}

const fmtTime = (d) =>
  d ? d.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '—';

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export async function snapshot() {
  pollCount += 1;
  const [plists, launchctl, markers, docker, sessions, endpoints, disk, mem, procs, crons] = await Promise.all([
    collect.getPlists(), collect.getLaunchctl(), collect.getMarkers(), collect.getDocker(),
    collect.getSessions(), collect.httpChecks(pollCount), collect.diskStatus(pollCount),
    collect.memStatus(pollCount), collect.processChecks(), collect.cronChecks(pollCount),
  ]);
  const now = new Date();
  const jobs = [];
  const timeline = [];

  for (const job of JOBS) {
    const plist = plists.get(job.label);
    const lc = launchctl.get(job.label);
    const j = { ...job, status: 'ok', detail: '', schedule: '', logAvailable: false };

    if (!plist) {
      jobs.push({ ...j, status: 'down', detail: 'plist missing' });
      continue;
    }
    j.logAvailable = Boolean(plist.outLog || plist.errLog);

    if (!lc) {
      jobs.push({ ...j, status: 'down', detail: 'not loaded in launchd' });
      continue;
    }

    if (plist.selfheal) {
      const due = lastDueSlot(plist.selfheal.slotspec, now);
      const next = nextSlot(plist.selfheal.slotspec, now);
      const marker = markers.get(plist.selfheal.marker);
      j.schedule = plist.selfheal.slotspec;
      j.next = next ? fmtTime(next) : '—';
      // ±12h slot marks for the timeline (state mirrors the card logic)
      for (const slot of slotsInWindow(plist.selfheal.slotspec, now)) {
        const graceMs = (job.grace ?? 120) * 60000;
        const state = +slot > +now ? 'upcoming'
          : (marker && marker * 1000 >= +slot) ? 'ran'
          : (+now - +slot <= graceMs) ? 'pending' : 'missed';
        timeline.push({ label: job.label, name: job.name, at: +slot, state });
      }
      if (marker) j.detail = `last success ${ago(marker * 1000)}`;
      if (!due) {
        j.status = marker ? 'ok' : 'due';
        if (!marker) j.detail = 'no run recorded yet';
      } else if (marker && marker * 1000 >= +due) {
        j.status = 'ok';
      } else {
        const graceMs = (job.grace ?? 120) * 60000;
        j.status = +now - +due <= graceMs ? 'due' : 'overdue';
        j.detail = `${fmtTime(due)} slot ${j.status === 'due' ? 'pending' : 'MISSED'}` +
          (marker ? ` · last success ${ago(marker * 1000)}` : ' · never succeeded');
      }
    } else if (plist.keepAlive) {
      j.schedule = 'always-on';
      if (lc.pid) { j.status = 'ok'; j.detail = `running · pid ${lc.pid}`; }
      else { j.status = 'down'; j.detail = 'service not running'; }
    } else if (plist.interval) {
      j.schedule = `every ${Math.round(plist.interval / 60)}m`;
      const mtime = await collect.logMtime(plist.outLog);
      if (lc.lastExit) {
        j.status = 'failed'; j.detail = `last exit ${lc.lastExit}`;
      } else if (!job.quietOk && mtime && Date.now() - mtime > plist.interval * 1000 * SETTINGS.staleFactor) {
        j.status = 'stale'; j.detail = `log quiet ${ago(mtime)}`;
      } else {
        j.status = 'ok';
        j.detail = mtime ? `last activity ${ago(mtime)}` : 'loaded';
      }
    } else {
      // calendar job without selfheal wrapper — judge by exit code + log freshness
      j.schedule = 'scheduled';
      const mtime = await collect.logMtime(plist.outLog);
      if (lc.lastExit) { j.status = 'failed'; j.detail = `last exit ${lc.lastExit}`; }
      else { j.status = 'ok'; j.detail = mtime ? `last activity ${ago(mtime)}` : 'loaded'; }
    }
    jobs.push(j);
  }

  for (const p of procs) {
    jobs.push({
      label: `proc:${p.id}`, name: p.name, domain: p.domain, repo: p.repo,
      schedule: 'process', logAvailable: false,
      status: p.pid ? 'ok' : 'down',
      detail: p.pid ? `running · pid ${p.pid}` : 'process not running',
    });
  }

  for (const c of crons) {
    const j = cronJobStatus(c, now);
    jobs.push(j);
    // same ±12h slot marks as selfheal jobs; presence-only entries have no
    // per-slot evidence, so they stay off the timeline
    if (c.log && !c.quietOk) {
      const graceMs = (c.grace ?? 120) * 60000;
      for (const slot of cronSlotsInWindow(c.schedule, now)) {
        const state = +slot > +now ? 'upcoming'
          : (c.mtime && c.mtime >= +slot) ? 'ran'
          : (+now - +slot <= graceMs) ? 'pending' : 'missed';
        timeline.push({ label: j.label, name: c.name, at: +slot, state });
      }
    }
  }

  for (const c of DOCKER_CONTAINERS) {
    const j = { label: `docker:${c.name}`, name: c.display, domain: c.domain, schedule: 'container', logAvailable: false };
    if (!docker.reachable) {
      jobs.push({ ...j, status: 'stale', detail: 'docker daemon unreachable' });
    } else {
      const info = docker.containers.get(c.name);
      if (!info) jobs.push({ ...j, status: 'down', detail: 'container not found' });
      else if (/unhealthy/i.test(info.status)) jobs.push({ ...j, status: 'down', detail: info.status });
      else if (info.state !== 'running') jobs.push({ ...j, status: 'down', detail: info.status });
      else jobs.push({ ...j, status: 'ok', detail: info.status });
    }
  }

  for (const ep of endpoints) {
    jobs.push({
      label: `endpoint:${ep.id}`, name: ep.name, domain: 'cloud',
      schedule: 'http check', logAvailable: false,
      status: !ep.up ? 'down' : ep.okFlag === false ? 'down' : 'ok',
      detail: !ep.up ? `unreachable (${ep.err || 'timeout'})`
        : `HTTP ${ep.code}${ep.note ? ` · ${ep.note}` : ''}`,
    });
  }

  jobs.push({
    label: 'disk:/', name: DISK.name || 'Disk', domain: 'infra',
    schedule: 'gauge', logAvailable: false,
    status: disk.pct >= DISK.critPct ? 'down' : disk.pct >= DISK.warnPct ? 'warn' : 'ok',
    detail: `${disk.pct}% used · ${DISK.bloatLabel || 'bloat'} ${disk.bloatGB} GB` +
      (disk.bloatGB >= DISK.bloatWarnGB ? ' ⚠ bloat' : ''),
  });

  jobs.push({
    label: 'mem:', name: 'Memory / Swap', domain: 'infra',
    schedule: 'gauge', logAvailable: false,
    status: (mem.pressure >= 4 || mem.swapGB >= MEM.swapCritGB) ? 'down'
      : (mem.pressure >= 2 || mem.swapGB >= MEM.swapWarnGB) ? 'warn' : 'ok',
    detail: `swap ${mem.swapGB} GB · pressure ${mem.pressure === 1 ? 'normal' : mem.pressure === 2 ? 'WARN' : 'CRITICAL'}`,
  });

  const bridge = collect.cmuxBridgeStatus();
  jobs.push({
    label: 'cmux:bridge', name: 'cmux bridge (dispatch + notify)', domain: 'infra',
    schedule: 'socket check', logAvailable: false,
    status: bridge.ok ? 'ok' : 'down',
    detail: bridge.ok ? 'socket auth OK'
      : `${bridge.detail} — restore: data/cmux-socket-password → cmux.json automation.socketPassword, then cmux reload-config (docs/CMUX-SETUP.md)`,
  });

  // installs made by install.sh carry data/setup-state.json: one card until `zulu setup` is done
  const setup = setupCard(readStateSync());
  if (setup) jobs.push(setup);
  // GitHub stats (SETTINGS.repoStats): informational cards, fetched by server.mjs
  jobs.push(...repoCards(readStatsSync(), SETTINGS.repoStats, now));

  const attention = jobs.filter((x) => x.status !== 'ok');
  return {
    at: Date.now(),
    dockerReachable: docker.reachable,
    jobs,
    timeline: timeline.sort((a, b) => a.at - b.at),
    sessions,
    counts: {
      ok: jobs.length - attention.length,
      attention: attention.length,
      total: jobs.length,
      agents: sessions.filter((s) => s.active).length,
      agentsNeedInput: sessions.filter((s) => s.active && s.lifecycle === 'needsInput').length,
    },
  };
}

// server-side map for the log-tail endpoint (client passes label only — never a path)
export async function logPathsFor(label) {
  if (label.startsWith('cron:')) {
    const c = CRON.find((x) => `cron:${x.id}` === label);
    return c?.log ? { out: c.log, err: null } : null;
  }
  const plists = await collect.getPlists();
  const p = plists.get(label);
  return p ? { out: p.outLog, err: p.errLog } : null;
}
