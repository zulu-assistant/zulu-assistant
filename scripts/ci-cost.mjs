#!/usr/bin/env node
// GitHub Actions cost watch: month-to-date macOS minutes vs the plan's
// included minutes, a linear month-end projection, and the review triggers.
//
//   node scripts/ci-cost.mjs [--repos repo[:workflow.yml],…] [--included 2000] [--json] [--comment <task-id>]
//
// --comment posts the reading to that ledger task as the board's system actor
// (`board`); when a review trigger fires it also wakes the task's owner and requester.
//
// Only macOS workflows are walked: for this repo, every .github/workflows/*.yml
// that names a macos runner; for another repo, name its workflow (`other:ci.yml`).
//
// Read-only. Source, best first:
//   1. account billing (needs the `user` token scope — once: gh auth refresh -h github.com -s user):
//      the enhanced usage report, else the legacy /settings/billing/actions summary
//   2. estimate from the repos' jobs API (works with the `repo` scope): every
//      macOS job's wall time rounded UP to whole minutes per job (GitHub's rule).
// Private-repo macOS minutes count 10× against included minutes (Linux 1×).
// Exit 0 = fine, 3 = a review trigger fired (callers notify), 2 = error.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MACOS_MULTIPLIER = 10;

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

/** Month-end projection + trigger evaluation (pure). */
export function assess({ macMinutes, otherMacRepos = [], included, now = new Date() }) {
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const billed = macMinutes * MACOS_MULTIPLIER;
  const projected = Math.round((billed / day) * daysInMonth);
  const triggers = [];
  if (billed >= included * 0.5) triggers.push(`month-to-date ${billed} ≥ 50% of ${included} included`);
  if (projected > included) triggers.push(`projected ${projected} > ${included} included`);
  if (otherMacRepos.length) triggers.push(`macOS CI also running in: ${otherMacRepos.join(', ')}`);
  return { macMinutes, billed, included, pct: Math.round((billed / included) * 100), projected, day, daysInMonth, triggers };
}

function accountBilling(user, now) {
  try {   // enhanced billing platform
    const r = gh(`/users/${user}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`);
    const mac = (r.usageItems || []).filter((i) => i.product === 'actions' && /macos/i.test(i.sku || ''));
    return { source: 'billing-usage', macMinutes: mac.reduce((s, i) => s + (i.quantity || 0), 0), included: null };
  } catch { /* fall through */ }
  try {   // legacy summary
    const r = gh(`/users/${user}/settings/billing/actions`);
    return { source: 'billing-actions', macMinutes: r.minutes_used_breakdown?.MACOS ?? 0, included: r.included_minutes ?? null };
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
  const est = estimateFromJobs(owner, repos, now);
  const acct = accountBilling(user, now);
  const included = Number(opt('--included')) || acct?.included || 2000;
  const macMinutes = acct ? acct.macMinutes : est.macMinutes;
  // account total well above what the watched repos explain → macOS CI elsewhere (another repo running macOS jobs)
  const otherMacRepos = acct && acct.macMinutes > est.macMinutes + 2 ? [`other repos (+${acct.macMinutes - est.macMinutes} min)`] : [];
  const a = assess({ macMinutes, otherMacRepos, included, now });
  const line = `CI cost ${now.toISOString().slice(0, 10)} [${acct ? acct.source : est.source}]: macOS ${a.macMinutes} min MTD`
    + ` (${Object.entries(est.perRepo).map(([r, m]) => `${r} ${m}`).join(', ')})`
    + ` = ${a.billed}/${a.included} included (${a.pct}%), projected month-end ${a.projected}`
    + (a.triggers.length ? ` — REVIEW TRIGGER: ${a.triggers.join('; ')}` : ' — ok');
  if (args.includes('--json')) console.log(JSON.stringify({ ...a, source: acct ? acct.source : est.source, perRepo: est.perRepo, line }, null, 1));
  else console.log(line);
  if (!acct) console.error('note: account billing needs the `user` scope (gh auth refresh -h github.com -s user); showing the jobs-API estimate');
  if (opt('--comment')) await postComment(opt('--comment'), line, a.triggers.length > 0);
  process.exit(a.triggers.length ? 3 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`ci-cost: ${String(e.stderr || e.message).trim()}`); process.exit(2); });
}
