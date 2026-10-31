#!/usr/bin/env node
// GitHub Actions cost watch: the ACCOUNT's month-to-date Actions minutes (every
// repo, every runner SKU at its included-minute weight) vs the plan's included
// minutes, a linear month-end projection, and the review triggers.
//
// Task #189 (2026-10-20): the first version counted only macOS minutes in the
// watched repos, so 1,440 Linux minutes elsewhere on the account (the dead-man's
// switch, other repos' CI) were invisible while the account hit 100% of 2,000.
//
//   node scripts/ci-cost.mjs [--repos repo[:workflow.yml],…] [--included 2000] [--json] [--comment <task-id>]
//
// --comment posts the reading to that ledger task as the board's system actor
// (`board`); when a review trigger fires it also wakes the task's owner and requester.
//
// --repos names the WATCHED repos: macOS minutes outside them are a trigger. The
// jobs-API fallback (no `user` scope) can only see those repos' macOS workflows —
// it says so in the reading, because it cannot see the account total.
//
// Read-only. Source, best first:
//   1. account billing (needs the `user` token scope — once: gh auth refresh -h github.com -s user):
//      the enhanced usage report, else the legacy /settings/billing/actions summary
//   2. estimate from the repos' jobs API (works with the `repo` scope): every
//      macOS job's wall time rounded UP to whole minutes per job (GitHub's rule).
// Private-repo macOS minutes count 10× against included minutes (Linux 1×).
// Exit 0 = fine, 3 = a review trigger fired (callers notify), 2 = error.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MACOS_MULTIPLIER = 10;

/** Included-minute weight of an Actions runner SKU (GitHub: Linux 1×, Windows 2×, macOS 10×). */
export function skuWeight(sku = '') {
  if (/macos/i.test(sku)) return MACOS_MULTIPLIER;
  if (/windows/i.test(sku)) return 2;
  return 1;
}
const skuKind = (sku = '') => (/macos/i.test(sku) ? 'macos' : /windows/i.test(sku) ? 'windows' : 'linux');

/**
 * The account's Actions minutes from the billing usage report (pure).
 * → { equivalent, byKind: {linux, windows, macos}, perRepo: {repo: {linux, windows, macos, equivalent}}, grossUsd, netUsd }
 */
export function summarizeUsage(items = []) {
  const out = { equivalent: 0, byKind: { linux: 0, windows: 0, macos: 0 }, perRepo: {}, grossUsd: 0, netUsd: 0 };
  for (const i of items) {
    if (i.product !== 'actions') continue;
    out.grossUsd += i.grossAmount || 0;
    out.netUsd += i.netAmount || 0;
    if (!/minute/i.test(i.unitType || '')) continue;
    const q = i.quantity || 0;
    const kind = skuKind(i.sku);
    const repo = i.repositoryName || '(no repo)';
    const r = (out.perRepo[repo] ||= { linux: 0, windows: 0, macos: 0, equivalent: 0 });
    r[kind] += q; r.equivalent += q * skuWeight(i.sku);
    out.byKind[kind] += q;
    out.equivalent += q * skuWeight(i.sku);
  }
  const round = (x) => Math.round(x);
  out.equivalent = round(out.equivalent);
  for (const k of Object.keys(out.byKind)) out.byKind[k] = round(out.byKind[k]);
  for (const r of Object.values(out.perRepo)) for (const k of Object.keys(r)) r[k] = round(r[k]);
  out.grossUsd = Math.round(out.grossUsd * 100) / 100;
  out.netUsd = Math.round(out.netUsd * 100) / 100;
  return out;
}

/** "master-console 1400 (870 Linux + 53 macOS), …" — biggest first (pure). */
export function repoBreakdown(perRepo, max = 6) {
  const rows = Object.entries(perRepo).sort((a, b) => b[1].equivalent - a[1].equivalent);
  const fmt = ([name, r]) => {
    const parts = [r.linux && `${r.linux} Linux`, r.windows && `${r.windows} Windows`, r.macos && `${r.macos} macOS`].filter(Boolean);
    return `${name} ${r.equivalent}${parts.length > 1 || r.macos || r.windows ? ` (${parts.join(' + ')})` : ''}`;
  };
  return rows.slice(0, max).map(fmt).join(', ') + (rows.length > max ? `, +${rows.length - max} more` : '');
}

const gh = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }));
const ghPages = (path, key) => {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = gh(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? j[key] : j;
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
};

/** Billable minutes for one job: wall time rounded up per job; unfinished jobs don't count yet. */
export function jobMinutes(job) {
  if (!job.started_at || !job.completed_at) return 0;
  const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}
export const isMacJob = (job) => (job.labels || []).some((l) => /macos/i.test(l)) || /macos/i.test(job.runner_name || '');

/**
 * Month-end projection + trigger evaluation (pure). `equivalent` = the account's
 * weighted minutes; without it (jobs-API fallback) only macMinutes × 10 is known.
 */
export function assess({ equivalent, macMinutes = 0, otherMacRepos = [], included, overageUsd = 0, now = new Date() }) {
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const billed = Math.round(equivalent ?? macMinutes * MACOS_MULTIPLIER);
  const projected = Math.round((billed / day) * daysInMonth);
  const triggers = [];
  const pct = Math.round((billed / included) * 100);
  if (billed >= included) triggers.push(`included minutes used up (${billed}/${included})`);
  else if (billed >= included * 0.9) triggers.push(`included minutes nearly used up (${billed}/${included}, ${pct}%)`);
  else if (billed >= included * 0.5) triggers.push(`month-to-date ${billed} ≥ 50% of ${included} included`);
  if (projected > included && billed < included * 0.9) triggers.push(`projected ${projected} > ${included} included`);
  if (overageUsd > 0) triggers.push(`billed overage $${overageUsd.toFixed(2)} this month`);
  if (otherMacRepos.length) triggers.push(`macOS CI also running in: ${otherMacRepos.join(', ')}`);
  return { macMinutes, billed, included, pct, projected, day, daysInMonth, overageUsd, triggers };
}

function accountBilling(user, now) {
  try {   // enhanced billing platform
    const r = gh(`/users/${user}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
    const u = summarizeUsage(r.usageItems || []);
    return { source: 'billing-usage', ...u, macMinutes: u.byKind.macos, included: null };
  } catch { /* fall through */ }
  try {   // legacy summary
    const r = gh(`/users/${user}/settings/billing/actions`);
    const b = r.minutes_used_breakdown || {};
    const byKind = { linux: b.UBUNTU ?? 0, windows: b.WINDOWS ?? 0, macos: b.MACOS ?? 0 };
    return { source: 'billing-actions', byKind, macMinutes: byKind.macos, perRepo: null,
      equivalent: byKind.linux + byKind.windows * 2 + byKind.macos * MACOS_MULTIPLIER, netUsd: 0,
      included: r.included_minutes ?? null };
  } catch { return null; }
}

/** Local workflow files that run on macOS (the only ones that cost 10×). */
export function macWorkflows(dir = '.github/workflows') {
  try { return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && /runs-on:\s*\[?\s*['"]?macos/i.test(readFileSync(`${dir}/${f}`, 'utf8'))); }
  catch { return []; }
}

function estimateFromJobs(owner, repos, now) {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const perRepo = {};
  for (const spec of repos) {
    const [repo, wf] = spec.split(':');
    let m = 0;
    for (const w of wf ? [wf] : macWorkflows())
    for (const run of ghPages(`/repos/${owner}/${repo}/actions/workflows/${w}/runs?created=>=${since}`, 'workflow_runs')) {
      for (const job of ghPages(`/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?filter=all`, 'jobs')) if (isMacJob(job)) m += jobMinutes(job);
    }
    perRepo[repo] = m;
  }
  return { source: 'jobs-estimate', macMinutes: Object.values(perRepo).reduce((a, b) => a + b, 0), perRepo };
}

async function postComment(taskId, text, wake) {
  const port = process.env.MC_PORT || 3210;
  const r = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ actor: 'board', op: 'comment', text, wake }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`comment on #${taskId} failed: ${j.msg || r.status}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const now = new Date();
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const [, owner, thisRepo] = origin.match(/[:/]([^/]+)\/([^/.]+)(?:\.git)?$/) || [];
  const repos = (opt('--repos') || thisRepo).split(',').map((s) => s.trim()).filter(Boolean);
  const user = gh('/user').login;
  const acct = accountBilling(user, now);
  // the jobs walk is only needed without the account view (it is slow on busy repos)
  const est = acct?.perRepo ? { source: 'jobs-estimate', macMinutes: 0, perRepo: {} } : estimateFromJobs(owner, repos, now);
  const included = Number(opt('--included')) || acct?.included || 2000;
  const watched = new Set(repos.map((r) => r.split(':')[0]));
  let a, line;
  if (acct) {
    // macOS minutes in a repo nobody listed → named (per-repo report), else inferred from the total
    const otherMacRepos = acct.perRepo
      ? Object.entries(acct.perRepo).filter(([r, v]) => v.macos > 0 && !watched.has(r)).map(([r, v]) => `${r} (${v.macos} min)`)
      : (acct.macMinutes > est.macMinutes + 2 ? [`other repos (+${acct.macMinutes - est.macMinutes} min)`] : []);
    a = assess({ equivalent: acct.equivalent, macMinutes: acct.macMinutes, otherMacRepos, included, overageUsd: acct.netUsd || 0, now });
    const k = acct.byKind;
    line = `CI cost ${now.toISOString().slice(0, 10)} [${acct.source}, whole account]: ${a.billed}/${a.included} included minutes used (${a.pct}%)`
      + ` — Linux ${k.linux}${k.windows ? `, Windows ${k.windows}×2` : ''}, macOS ${k.macos}×${MACOS_MULTIPLIER}`
      + (acct.perRepo ? ` · by repo: ${repoBreakdown(acct.perRepo)}` : '')
      + ` · projected month-end ${a.projected}`
      + (a.overageUsd > 0 ? ` · overage billed $${a.overageUsd.toFixed(2)}` : '')
      + (a.triggers.length ? ` — REVIEW TRIGGER: ${a.triggers.join('; ')}` : ' — ok');
  } else {
    a = assess({ macMinutes: est.macMinutes, included, now });
    line = `CI cost ${now.toISOString().slice(0, 10)} [${est.source}, WATCHED REPOS' macOS ONLY — no account view without the user scope]:`
      + ` macOS ${a.macMinutes} min (${Object.entries(est.perRepo).map(([r, m]) => `${r} ${m}`).join(', ')})`
      + ` = ${a.billed}/${a.included} (${a.pct}%), projected month-end ${a.projected}`
      + (a.triggers.length ? ` — REVIEW TRIGGER: ${a.triggers.join('; ')}` : ' — ok (Linux and other repos not counted)');
  }
  if (args.includes('--json')) console.log(JSON.stringify({ ...a, source: acct ? acct.source : est.source, byKind: acct?.byKind, perRepo: acct?.perRepo || est.perRepo, line }, null, 1));
  else console.log(line);
  if (!acct) console.error('note: account billing needs the `user` scope (gh auth refresh -h github.com -s user); showing the jobs-API estimate');
  if (opt('--comment')) await postComment(opt('--comment'), line, a.triggers.length > 0);
  process.exit(a.triggers.length ? 3 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => { console.error(`ci-cost: ${String(e.stderr || e.message).trim()}`); process.exit(2); });
}
