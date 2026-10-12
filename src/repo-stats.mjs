// GitHub repo stats on the board: stars, forks, watchers, clones and views.
//
// SETTINGS.repoStats = { repos: ['owner/name', …], everyHours: 6 } turns it on
// (absent or empty = off). GitHub keeps traffic for 14 days only and never
// notifies about clones, so the board polls `gh api` (your own login; traffic
// needs push access) every `everyHours`, MERGES each day's counts into
// data/repo-stats.json and so builds a permanent history. Each repo becomes an
// informational card (cloud domain) and a line in the morning digest; a new star
// or fork leaves a ticker line. A failed fetch retries next poll after an hour,
// and the card turns STALE only after a day without a good reading.
import { execFile } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STATS_FILE = fileURLToPath(new URL('../data/repo-stats.json', import.meta.url));
const RETRY_MS = 3600e3;
const STALE_MS = 24 * 3600e3;

/** Merge the API's per-day array into the stored day map (pure). */
export function mergeDays(days = {}, apiDays = []) {
  const out = { ...days };
  for (const d of apiDays) {
    const day = String(d.timestamp || '').slice(0, 10);
    if (!day) continue;
    out[day] = { count: d.count ?? 0, uniques: d.uniques ?? 0 };
  }
  return out;
}

const sum = (days, from) => Object.entries(days || {}).filter(([d]) => !from || d >= from)
  .reduce((a, [, v]) => ({ count: a.count + v.count, uniques: a.uniques + v.uniques }), { count: 0, uniques: 0 });

/** Numbers for one repo (pure). `today` = 'YYYY-MM-DD' (UTC, GitHub's day). */
export function repoSummary(r, today) {
  const d14 = new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 864e5).toISOString().slice(0, 10);
  return {
    stars: r.meta?.stars ?? 0, forks: r.meta?.forks ?? 0, watchers: r.meta?.watchers ?? 0,
    clonesToday: r.clones?.[today]?.count ?? 0, clonersToday: r.clones?.[today]?.uniques ?? 0,
    // GitHub's own 14-day totals (true unique visitors); summing daily uniques would double-count
    clones14: r.clones14 || sum(r.clones, d14), views14: r.views14 || sum(r.views, d14),
    clonesAll: sum(r.clones).count, viewsAll: sum(r.views).count,
    since: r.since || today,                      // the day tracking started
    topReferrer: r.referrers?.[0] ? `${r.referrers[0].referrer} (${r.referrers[0].count})` : null,
  };
}

const short = (repo) => repo.split('/').pop();

/** Board cards, one per repo (pure). */
export function repoCards(state, cfg, now = new Date()) {
  if (!cfg?.repos?.length) return [];
  const today = now.toISOString().slice(0, 10);
  return cfg.repos.map((repo) => {
    const r = state?.repos?.[repo];
    const base = { label: `repo:${repo}`, name: `GitHub: ${short(repo)}`, domain: 'cloud', schedule: `stats every ${cfg.everyHours || 6}h`, logAvailable: false };
    if (!r?.lastOk) return { ...base, status: 'due', detail: 'no reading yet (gh api, your login)' };
    const s = repoSummary(r, today);
    const stale = now.getTime() - r.lastOk > STALE_MS;
    return {
      ...base, status: stale ? 'stale' : 'ok',
      detail: `★ ${s.stars} · ${s.forks} fork${s.forks === 1 ? '' : 's'} · ${s.watchers} watching · clones today ${s.clonesToday}` +
        ` · 14d ${s.clones14.count} clones (${s.clones14.uniques} uniq) / ${s.views14.count} views` +
        (stale ? ` · last reading ${Math.round((now.getTime() - r.lastOk) / 36e5)}h ago${r.lastError ? ` — ${r.lastError}` : ''}` : ''),
    };
  });
}

/** Morning-digest lines (pure). */
export function digestLines(state, cfg, now = new Date()) {
  if (!cfg?.repos?.length) return [];
  const today = now.toISOString().slice(0, 10);
  const out = ['', 'GITHUB:'];
  for (const repo of cfg.repos) {
    const r = state?.repos?.[repo];
    if (!r?.lastOk) { out.push(`  ${repo}: no reading yet`); continue; }
    const s = repoSummary(r, today);
    out.push(`  ${repo}: ★ ${s.stars} · forks ${s.forks} · watching ${s.watchers}`,
      `    clones 14d ${s.clones14.count} (${s.clones14.uniques} unique) · views 14d ${s.views14.count} (${s.views14.uniques} unique)`,
      `    all-time since ${s.since}: ${s.clonesAll} clones · ${s.viewsAll} views${s.topReferrer ? ` · top referrer ${s.topReferrer}` : ''}`);
  }
  return out;
}

export function readStatsSync(file = STATS_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { repos: {} }; } }

const gh = (args, run) => new Promise((resolve, reject) => {
  run('gh', ['api', ...args], { timeout: 30000, env: process.env }, (err, stdout, stderr) =>
    (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0].slice(0, 100))) : resolve(JSON.parse(String(stdout || 'null')))));
});

let busy = false;
/** Fetch when due; returns ticker lines for new stars/forks. `run` is injectable (tests). */
export async function maybeRepoStats({ cfg, now = new Date(), file = STATS_FILE, run = execFile, record = async () => {} } = {}) {
  if (busy || !cfg?.repos?.length) return;
  const state = readStatsSync(file);
  state.repos ||= {};
  const everyMs = (cfg.everyHours || 6) * 3600e3;
  const due = cfg.repos.filter((repo) => {
    const r = state.repos[repo] || {};
    return now.getTime() - (r.lastOk || 0) >= everyMs && now.getTime() - (r.lastAttempt || 0) >= RETRY_MS;
  });
  if (!due.length) return;
  busy = true;
  try {
    for (const repo of due) {
      const r = state.repos[repo] ||= {};
      r.lastAttempt = now.getTime();
      try {
        const [meta, clones, views, refs] = await Promise.all([
          gh([`repos/${repo}`], run), gh([`repos/${repo}/traffic/clones`], run),
          gh([`repos/${repo}/traffic/views`], run), gh([`repos/${repo}/traffic/popular/referrers`], run).catch(() => []),
        ]);
        const prev = r.meta;
        r.meta = { stars: meta.stargazers_count, forks: meta.forks_count, watchers: meta.subscribers_count };
        r.clones = mergeDays(r.clones, clones?.clones);
        r.views = mergeDays(r.views, views?.views);
        r.clones14 = { count: clones?.count ?? 0, uniques: clones?.uniques ?? 0 };
        r.views14 = { count: views?.count ?? 0, uniques: views?.uniques ?? 0 };
        r.referrers = (refs || []).slice(0, 5).map((x) => ({ referrer: x.referrer, count: x.count, uniques: x.uniques }));
        r.since ||= now.toISOString().slice(0, 10);
        r.lastOk = now.getTime(); delete r.lastError;
        if (prev && r.meta.stars > prev.stars) await record('good', `★ ${short(repo)}: ${r.meta.stars - prev.stars} new star(s) — now ${r.meta.stars}`);
        if (prev && r.meta.forks > prev.forks) await record('good', `${short(repo)}: ${r.meta.forks - prev.forks} new fork(s) — now ${r.meta.forks}`);
      } catch (e) {
        r.lastError = e.message;
        await record('sys', `repo stats ${repo}: ${e.message} (retry in 1h)`);
      }
    }
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(state, null, 1));
    await rename(tmp, file);
  } finally { busy = false; }
}

