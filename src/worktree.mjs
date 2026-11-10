// Worktree-per-task (Zulu 1.1): a task's code work happens in its own git worktree,
// a sibling of the repo named wt-<task>, on branch task/<task>-<slug>. Creating one is
// idempotent; removing one refuses — never forces — while it holds uncommitted files,
// a live process has its cwd inside it, or its commits are not on the remote yet.
// Nothing is ever copied into a worktree (no data/, no .env*): ignored files stay home.
// Every git/lsof call goes through an injectable runner, so the tests drive real git in
// temp repos without touching this checkout.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const LSOF_TIMEOUT_MS = 5000;

/** Run a command → { ok, out, err, timedOut }. Never throws. */
export function sh(cmd, args, { cwd, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => resolve({
      ok: !e, out: String(stdout || '').trim(), err: String(stderr || e?.message || '').trim(),
      timedOut: Boolean(e?.killed), code: e ? (typeof e.code === 'number' ? e.code : -1) : 0,
    }));
  });
}
const git = (run, cwd, ...args) => run('git', ['-C', cwd, ...args]);

export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'task';
export const branchFor = (n, title) => `task/${n}-${slug(title)}`;

/** The main checkout's root (also from inside one of its worktrees). */
export async function mainRoot(repo, { run = sh } = {}) {
  const r = await git(run, repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!r.ok || !r.out) return null;
  const common = realpathSync(r.out);
  return path.basename(common) === '.git' ? path.dirname(common) : null;   // a bare repo has no checkout
}
export const worktreePath = (root, n) => path.join(path.dirname(root), `wt-${n}`);

/** Registered worktrees of a repo → [{ path, branch, head }]. */
export async function listWorktrees(root, { run = sh } = {}) {
  const r = await git(run, root, 'worktree', 'list', '--porcelain');
  if (!r.ok) return [];
  const out = [];
  for (const block of r.out.split('\n\n')) {
    const w = {};
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ');
      if (k === 'worktree') w.path = v.join(' ');
      else if (k === 'branch') w.branch = v.join(' ').replace(/^refs\/heads\//, '');
      else if (k === 'HEAD') w.head = v[0];
    }
    if (w.path) out.push(w);
  }
  return out;
}
const same = (a, b) => { try { return realpathSync(a) === realpathSync(b); } catch { return path.resolve(a) === path.resolve(b); } };

/** origin's default branch (origin/HEAD), else main. */
async function defaultBase(root, run) {
  const r = await git(run, root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
  return r.ok && r.out.startsWith('origin/') ? r.out.slice('origin/'.length) : 'main';
}

/**
 * Create (or find) task N's worktree. → { ok, path, branch, base, existed } | { ok: false, why }.
 * Starts from origin/<base> after a fetch; without a remote, from the local <base>.
 */
export async function createWorktree({ repo, task, title, base, run = sh }) {
  if (!/^\d+$/.test(String(task))) return { ok: false, why: 'task must be a number' };
  const root = await mainRoot(repo, { run });
  if (!root) return { ok: false, why: `${repo} is not a git checkout` };
  const wt = worktreePath(root, task);
  const branch = branchFor(task, title);
  const known = await listWorktrees(root, { run });
  const mine = known.find((w) => same(w.path, wt));
  if (mine) return { ok: true, path: wt, branch: mine.branch || branch, base: base || null, existed: true };
  if (existsSync(wt)) return { ok: false, why: `${wt} exists and is not a worktree of ${root} — move it, or pick the right repo` };
  const b = base || await defaultBase(root, run);
  const hasOrigin = (await git(run, root, 'remote', 'get-url', 'origin')).ok;
  let start = b;
  if (hasOrigin) {
    const f = await git(run, root, 'fetch', '--quiet', 'origin', b);
    if (!f.ok) return { ok: false, why: `git fetch origin ${b} failed: ${f.err.split('\n')[0]}` };
    start = `origin/${b}`;
  }
  const exists = (await git(run, root, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`)).ok;
  const add = exists
    ? await git(run, root, 'worktree', 'add', wt, branch)
    : await git(run, root, 'worktree', 'add', '--no-track', '-b', branch, wt, start);
  if (!add.ok) return { ok: false, why: `git worktree add failed: ${add.err.split('\n')[0]}` };
  return { ok: true, path: wt, branch, base: b, existed: false };
}

/** Processes whose cwd is inside dir → [pid…]; null when lsof did not answer in time (= refuse). */
export async function processesIn(dir, { run = sh, timeoutMs = LSOF_TIMEOUT_MS } = {}) {
  const r = await run('lsof', ['-a', '-d', 'cwd', '-Fpn'], { timeoutMs });
  if (r.timedOut) return null;
  if (!r.ok && !r.out) return r.code === 1 ? [] : null;   // lsof exits 1 when it matched nothing
  let real; try { real = realpathSync(dir); } catch { real = path.resolve(dir); }
  const pids = []; let pid = null;
  for (const line of r.out.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1));
    else if (line[0] === 'n') {
      const p = line.slice(1);
      if ((p === real || p.startsWith(real + path.sep)) && pid !== process.pid) pids.push(pid);
    }
  }
  return [...new Set(pids)];
}

/** The task's PR → { state, mergeCommit, headRefOid } | null (gh; fails soft). */
export async function prState(url, { run = sh } = {}) {
  if (!url) return null;
  const r = await run('gh', ['pr', 'view', String(url), '--json', 'state,mergeCommit,headRefOid'], { timeoutMs: 10000 });
  if (!r.ok) return null;
  try { const j = JSON.parse(r.out); return { state: j.state, mergeCommit: j.mergeCommit?.oid || null, headRefOid: j.headRefOid || null }; } catch { return null; }
}

/**
 * Merged PRs whose head branch is `branch` → [{ url, headRefOid }] (gh, run in the repo; fails soft
 * to []). For a task with no PR link: a squash merge that deleted the remote branch leaves the
 * commits in no ref at all, and the PR found by branch name is the only proof left.
 */
export async function mergedPrsFor(branch, { root, run = sh } = {}) {
  if (!branch) return [];
  const r = await run('gh', ['pr', 'list', '--head', String(branch), '--state', 'merged', '--json', 'url,headRefOid', '--limit', '10'], { cwd: root, timeoutMs: 10000 });
  if (!r.ok) return [];
  try { const j = JSON.parse(r.out); return Array.isArray(j) ? j.filter((x) => x && x.headRefOid) : []; } catch { return []; }
}

/**
 * Are this worktree's commits safe elsewhere? The first proof that holds wins:
 *   pr       — the task's PR is MERGED and its head is exactly this HEAD (a squash merge leaves
 *              the commit in no branch; a commit made after the merge is not covered)
 *   default  — HEAD is inside origin's default branch (merge commit or fast-forward)
 *   remote   — HEAD is inside some remote branch (pushed, not merged yet)
 *   upstream — nothing ahead of the upstream
 *   pr-branch — none of the above (no PR link, branch pushed without tracking and deleted by
 *              the squash merge): a MERGED PR found by this branch's name whose head is exactly
 *              this HEAD. A commit made after the merge has a different HEAD and is not covered.
 * → { ok, how, merged } | { ok: false, why }
 */
export async function landedProof({ wt, root, head, pr = null, branch = null, run = sh, readPr = prState, findPrs = mergedPrsFor }) {
  if (pr) {
    const p = await readPr(pr, { run });
    if (p?.state === 'MERGED' && head && p.headRefOid === head) return { ok: true, how: 'pr', merged: true };
  }
  const sym = await git(run, root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  const def = sym.ok && sym.out ? sym.out
    : (await git(run, root, 'rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main')).ok ? 'origin/main' : '';
  if (def && head && (await git(run, root, 'merge-base', '--is-ancestor', head, def)).ok) return { ok: true, how: 'default', merged: true };
  const onRemote = await git(run, wt, 'branch', '-r', '--contains', 'HEAD');
  if (onRemote.ok && onRemote.out) return { ok: true, how: 'remote', merged: false };
  const ahead = await git(run, wt, 'rev-list', '--count', '@{u}..HEAD');
  if ((!ahead.ok || Number(ahead.out) > 0) && branch && head) {
    const hit = (await findPrs(branch, { root, run })).find((p) => p.headRefOid === head);
    if (hit) return { ok: true, how: 'pr-branch', merged: true, pr: hit.url || null };
  }
  if (!ahead.ok) return { ok: false, why: `its commits are not on the remote (no upstream, not in any remote branch${pr ? ', PR not merged at this HEAD' : ''}) — push the branch first` };
  if (Number(ahead.out) > 0) return { ok: false, why: `${ahead.out} commit(s) not pushed — push the branch first` };
  return { ok: true, how: 'upstream', merged: false };
}

/**
 * Remove a task's worktree — only when it is safe. → { ok, removed, branchDeleted, proof } | { ok: false, why }.
 * Refuses on: uncommitted/untracked files, a live process inside, lsof timing out, commits with no
 * landedProof (merged PR at this HEAD — linked, or found by branch name —, in the default branch, in a
 * remote branch, or pushed). Never forces.
 */
export async function cleanWorktree({ path: wt, keepBranch = false, pr = null, run = sh, readPr = prState, findPrs = mergedPrsFor, lsofTimeoutMs = LSOF_TIMEOUT_MS }) {
  if (!wt || !existsSync(wt)) return { ok: true, removed: false, why: 'already gone' };
  const root = await mainRoot(wt, { run });
  if (!root) return { ok: false, why: `${wt} is not a git worktree` };
  const w = (await listWorktrees(root, { run })).find((x) => same(x.path, wt));
  if (!w || same(root, wt)) return { ok: false, why: `${wt} is not a linked worktree of ${root}` };
  const st = await git(run, wt, 'status', '--porcelain');
  if (!st.ok) return { ok: false, why: `git status failed: ${st.err.split('\n')[0]}` };
  if (st.out) return { ok: false, why: `${st.out.split('\n').length} uncommitted or untracked file(s) — commit or remove them first` };
  const procs = await processesIn(wt, { run, timeoutMs: lsofTimeoutMs });
  if (procs === null) return { ok: false, why: 'could not check for live processes (lsof timed out) — refusing' };
  if (procs.length) return { ok: false, why: `live process(es) inside: pid ${procs.join(', ')} — stop the session first` };
  await git(run, root, 'fetch', '--quiet', '--prune', 'origin');  // best effort: fresh refs; a deleted branch's stale ref proves nothing
  const head = (await git(run, wt, 'rev-parse', 'HEAD')).out;
  const proof = await landedProof({ wt, root, head, pr, branch: w.branch || null, run, readPr, findPrs });
  if (!proof.ok) return { ok: false, why: proof.why };
  const rm = await git(run, root, 'worktree', 'remove', wt);
  if (!rm.ok) return { ok: false, why: `git worktree remove refused: ${rm.err.split('\n')[0]}` };
  // `branch -d` deletes only an ancestry-merged branch; after a squash merge the merged-PR (or
  // default-branch) proof is what allows the forced delete. Otherwise -d, which keeps unmerged work.
  let branchDeleted = false;
  if (!keepBranch && w.branch) branchDeleted = (await git(run, root, 'branch', proof.merged ? '-D' : '-d', w.branch)).ok;
  return { ok: true, removed: true, branch: w.branch || null, branchDeleted, keptByRequest: Boolean(keepBranch && w.branch), proof: proof.how };
}

/** What a close should say about a leftover worktree → null | { path, dirty }. */
export async function leftover(wt, { run = sh } = {}) {
  if (!wt || !existsSync(wt)) return null;
  const st = await git(run, wt, 'status', '--porcelain');
  return { path: wt, dirty: st.ok ? (st.out ? st.out.split('\n').length : 0) : null };
}

/**
 * SETTINGS.worktrees → 'off' | 'observe' | 'on' for a launch. env MESH_WORKTREE=0|1 overrides
 * (the pilot: one spawn with MESH_WORKTREE=1).
 */
export function worktreeMode(cfg, { kind = 'worker', name = '', env = process.env } = {}) {
  if (env.MESH_WORKTREE === '0') return 'off';
  if (env.MESH_WORKTREE === '1') return 'on';
  const mode = cfg?.mode || 'off';
  if (mode === 'off') return 'off';
  if (kind === 'resident' ? cfg.residents !== true : cfg.workers === false) return 'off';
  if (Array.isArray(cfg.only) && cfg.only.length && !cfg.only.includes(name)) return 'off';
  return mode === 'on' ? 'on' : 'observe';
}
