import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, cleanWorktree, processesIn, worktreeMode, leftover, branchFor, sh } from '../src/worktree.mjs';
import { applyPatch, newTask } from '../src/tasks.mjs';
import { classify, compileTriggers, DEFAULT_POLICY } from '../src/gates.mjs';

// Worktree-per-task (#401): real git in temp repos under a path WITH A SPACE, a bare "origin",
// and the user's global git config kept out (no global hooks, no signing).
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});
const g = async (cwd, ...args) => { const r = await sh('git', ['-C', cwd, ...args]); assert.ok(r.ok, `git ${args.join(' ')}: ${r.err}`); return r.out; };

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wt tests-')));
  const parent = path.join(base, 'code dir');
  await mkdir(parent);
  const origin = path.join(base, 'origin.git');
  await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const repo = path.join(parent, 'my repo');
  await sh('git', ['clone', '-q', origin, repo]);
  await writeFile(path.join(repo, 'a.txt'), 'a');
  await writeFile(path.join(repo, '.gitignore'), 'data/\n');
  await g(repo, 'add', '.'); await g(repo, 'commit', '-qm', 'first'); await g(repo, 'push', '-q', 'origin', 'main');
  await sh('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
  await mkdir(path.join(repo, 'data')); await writeFile(path.join(repo, 'data', 'secrets.env'), 'X=1');
  return { base, parent, origin, repo };
}

test('create: sibling wt-<N> on task/<N>-<slug> from origin/main; idempotent; ignored files never copied', async () => {
  const f = await fixture();
  const r = await createWorktree({ repo: f.repo, task: 12, title: 'Ship the Widget!' });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.path, path.join(f.parent, 'wt-12'));
  assert.equal(r.branch, 'task/12-ship-the-widget');
  assert.equal(r.base, 'main');
  assert.ok(existsSync(path.join(r.path, 'a.txt')));
  assert.ok(!existsSync(path.join(r.path, 'data', 'secrets.env')), 'ignored files are not copied in');
  const again = await createWorktree({ repo: f.repo, task: 12, title: 'Ship the Widget!' });
  assert.deepEqual([again.ok, again.existed, again.path], [true, true, r.path]);
  const fromInside = await createWorktree({ repo: r.path, task: 12, title: 'x' });     // from inside the worktree: same answer
  assert.equal(fromInside.path, r.path);
  assert.equal(branchFor(5, ''), 'task/5-task');
});

test('create refuses: a wt-<N> that is not this repo\'s worktree, a non-repo, a bad task id', async () => {
  const f = await fixture();
  await mkdir(path.join(f.parent, 'wt-13'));
  assert.match((await createWorktree({ repo: f.repo, task: 13, title: 'x' })).why, /exists and is not a worktree/);
  assert.match((await createWorktree({ repo: f.parent, task: 14, title: 'x' })).why, /not a git checkout/);
  assert.match((await createWorktree({ repo: f.repo, task: 'x', title: 'x' })).why, /number/);
});

test('clean: refuses uncommitted, then unpushed; removes once pushed; never forces', async () => {
  const f = await fixture();
  const r = await createWorktree({ repo: f.repo, task: 20, title: 'feature' });
  await writeFile(path.join(r.path, 'b.txt'), 'b');
  assert.match((await cleanWorktree({ path: r.path })).why, /1 uncommitted or untracked/);
  await g(r.path, 'add', '.'); await g(r.path, 'commit', '-qm', 'b');
  assert.match((await cleanWorktree({ path: r.path })).why, /not on the remote/);
  await g(r.path, 'push', '-q', '-u', 'origin', r.branch);
  await writeFile(path.join(r.path, 'c.txt'), 'c'); await g(r.path, 'add', '.'); await g(r.path, 'commit', '-qm', 'c');
  assert.match((await cleanWorktree({ path: r.path })).why, /1 commit\(s\) not pushed/);
  await g(r.path, 'push', '-q');
  const ok = await cleanWorktree({ path: r.path });
  assert.equal(ok.ok, true, ok.why);
  assert.equal(ok.removed, true);
  assert.ok(!existsSync(r.path));
  assert.equal((await cleanWorktree({ path: r.path })).why, 'already gone');
  assert.match((await cleanWorktree({ path: f.repo })).why, /not a linked worktree/, 'never the main checkout');
});

test('clean after a SQUASH merge + deleted branch (pruned remote): only a merged PR at this exact HEAD is proof', async () => {
  const f = await fixture();
  const r = await createWorktree({ repo: f.repo, task: 40, title: 'squashed' });
  await writeFile(path.join(r.path, 'd.txt'), 'd'); await g(r.path, 'add', '.'); await g(r.path, 'commit', '-qm', 'd');
  await g(r.path, 'push', '-q', '-u', 'origin', r.branch);
  const head = await g(r.path, 'rev-parse', 'HEAD');
  // the host squashes it into main and deletes the branch; the local checkout has not fetched since
  await g(f.repo, 'merge', '-q', '--squash', r.branch); await g(f.repo, 'commit', '-qm', 'squash d');
  await g(f.repo, 'push', '-q', 'origin', 'main');
  await g(f.repo, 'push', '-q', 'origin', '--delete', r.branch);
  await g(f.repo, 'update-ref', `refs/remotes/origin/${r.branch}`, head);      // the stale ref an un-pruned fetch keeps
  const merged = (oid) => async () => ({ state: 'MERGED', mergeCommit: 'abc', headRefOid: oid });
  assert.match((await cleanWorktree({ path: r.path })).why, /not on the remote/, 'the stale ref is pruned, so it proves nothing');
  assert.ok(existsSync(r.path));
  assert.match((await cleanWorktree({ path: r.path, pr: 'u', readPr: async () => ({ state: 'OPEN', headRefOid: head }) })).why, /PR not merged at this HEAD/);
  assert.match((await cleanWorktree({ path: r.path, pr: 'u', readPr: merged('0'.repeat(40)) })).why, /PR not merged at this HEAD/, 'a commit after the merged head is not covered');
  assert.match((await cleanWorktree({ path: r.path, pr: 'u', readPr: async () => null })).why, /not on the remote/, 'gh unavailable = no proof');
  const ok = await cleanWorktree({ path: r.path, pr: 'u', readPr: merged(head) });
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual([ok.removed, ok.proof, ok.branchDeleted], [true, 'pr', true]);
  assert.equal(await g(f.repo, 'branch', '--list', r.branch), '', 'the local task branch is gone too');
});

test('clean after a merge-commit merge: HEAD inside the default branch is proof; --keep-branch is reported as asked', async () => {
  const f = await fixture();
  const r = await createWorktree({ repo: f.repo, task: 41, title: 'merged' });
  await writeFile(path.join(r.path, 'e.txt'), 'e'); await g(r.path, 'add', '.'); await g(r.path, 'commit', '-qm', 'e');
  await g(r.path, 'push', '-q', '-u', 'origin', r.branch);
  await g(f.repo, 'merge', '-q', '--no-ff', '-m', 'merge e', r.branch); await g(f.repo, 'push', '-q', 'origin', 'main');
  await g(f.repo, 'push', '-q', 'origin', '--delete', r.branch);
  const ok = await cleanWorktree({ path: r.path, keepBranch: true });
  assert.deepEqual([ok.ok, ok.proof, ok.branchDeleted, ok.keptByRequest], [true, 'default', false, true], ok.why);
});

test('clean: a live process inside refuses; an lsof timeout refuses; a fresh, unchanged worktree goes', async () => {
  const f = await fixture();
  const r = await createWorktree({ repo: f.repo, task: 30, title: 'busy' });
  const p = spawn('sleep', ['30'], { cwd: r.path });
  try {
    await new Promise((res) => setTimeout(res, 300));
    const pids = await processesIn(r.path);
    assert.ok(pids.includes(p.pid), `lsof sees the sleep (${JSON.stringify(pids)})`);
    assert.match((await cleanWorktree({ path: r.path })).why, /live process/);
  } finally { p.kill(); }
  await new Promise((res) => p.on('exit', res));
  const slowLsof = (cmd, args, o) => (cmd === 'lsof' ? Promise.resolve({ ok: false, out: '', err: '', timedOut: true, code: -1 }) : sh(cmd, args, o));
  assert.match((await cleanWorktree({ path: r.path, run: slowLsof })).why, /lsof timed out/);
  const ok = await cleanWorktree({ path: r.path });                 // no commits beyond origin/main: nothing to lose
  assert.equal(ok.removed, true, ok.why);
  assert.equal(ok.branchDeleted, true, 'merged (empty) branch deleted with -d');
});

test('mode: off / observe / on, workers vs residents, only, MESH_WORKTREE override', () => {
  const env = {};
  assert.equal(worktreeMode(undefined, { env }), 'off');
  assert.equal(worktreeMode({ mode: 'observe', workers: true }, { env }), 'observe');
  assert.equal(worktreeMode({ mode: 'on', workers: true }, { env }), 'on');
  assert.equal(worktreeMode({ mode: 'on', workers: false }, { env }), 'off');
  assert.equal(worktreeMode({ mode: 'on', workers: true }, { kind: 'resident', env }), 'off');
  assert.equal(worktreeMode({ mode: 'on', residents: true }, { kind: 'resident', env }), 'on');
  assert.equal(worktreeMode({ mode: 'on', workers: true, only: ['a'] }, { name: 'b', env }), 'off');
  assert.equal(worktreeMode({ mode: 'observe' }, { env: { MESH_WORKTREE: '1' } }), 'on');
  assert.equal(worktreeMode({ mode: 'on' }, { env: { MESH_WORKTREE: '0' } }), 'off');
});

test('close with the worktree still on disk: a warning comment, never a refusal', async () => {
  const f = await fixture();
  const r = await createWorktree({ repo: f.repo, task: 40, title: 'left' });
  await writeFile(path.join(r.path, 'x.txt'), 'x');
  const left = await leftover(r.path);
  assert.deepEqual(left, { path: r.path, dirty: 1 });
  assert.equal(await leftover(path.join(f.parent, 'nope')), null);
  const t = Object.assign(newTask({ title: 'left', requester: 'helper', owner: 'builder' }, { id: 40 }), { status: 'in_progress' });
  const out = applyPatch(t, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'h.md', worktree: r.path, branch: r.branch }, text: 'done' }, { worktreeLeft: left });
  assert.equal(out.task.status, 'done');
  assert.match(out.task.comments.at(-1).text, /⚠ worktree left: .*wt-40 \(1 uncommitted\) — task.sh worktree-clean 40/);
  assert.equal(out.task.links.branch, 'task/40-left');
});

test('the worktree verbs are not gated: add and remove read as plain git', () => {
  const ctx = { home: '/home/u', boardRoot: '/work/board', tmpdir: '/tmp', triggers: compileTriggers(DEFAULT_POLICY), repoRoot: () => '/work/app', git: () => null };
  const v = (command) => classify({ tool: 'Bash', command, cwd: '/work/app' }, DEFAULT_POLICY, ctx).verdict;
  assert.equal(v('git -C /work/app worktree add --no-track -b task/5-x /work/wt-5 origin/main'), 'clear');
  assert.equal(v('git -C /work/app worktree remove /work/wt-5'), 'clear');
  assert.equal(v('git -C /work/app branch -d task/5-x'), 'clear');
  assert.equal(v('scripts/task.sh worktree-clean 5'), 'clear');
});
