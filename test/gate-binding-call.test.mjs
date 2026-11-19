import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, CHECKS, parseCommand, refMover } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

// #584 PR 2: a push or a merge was bound to the commit (or PR head) read when the row was filed, from the folder as
// it stood before the call. A switch or a commit earlier in the same call then sent another commit than the row named
// (seen once: one approval, two rows). Now such a push or merge carries no binding, its row
// says what runs before it, and a landing with no PR named after a branch change is refused unfiled. Real git.
const PRS = { main: { number: 5, headOid: 'c'.repeat(40) }, 'feat-a': { number: 11, headOid: 'a'.repeat(40) }, 'feat-b': { number: 12, headOid: 'b'.repeat(40) } };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function setup(on = 'main') {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'bind-call-')));
  const R = path.join(dir, 'app');
  execFileSync('git', ['init', '-q', '-b', 'main', R]);
  git(R, 'remote', 'add', 'origin', 'https://github.com/acme/private-app.git');
  await writeFile(path.join(R, 'f'), 'x\n'); git(R, 'add', 'f'); git(R, 'commit', '-qm', 'base');
  git(R, 'branch', 'feat-a'); git(R, 'branch', 'feat-b'); git(R, 'switch', '-q', on);
  const ledger = createLedger(path.join(dir, 'tasks'));
  const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const prInfo = async (cmd, cwd) => {
    const p = cmd.tokens.filter((t) => !t.startsWith('-')); const target = p[p.indexOf('merge') + 1];
    const branch = target && PRS[target] ? target : Object.keys(PRS).find((b) => String(PRS[b].number) === target) || git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD');
    return { number: PRS[branch].number, title: `PR of ${branch}`, head: branch, base: 'main', headOid: PRS[branch].headOid, repo: 'acme/private-app' };
  };
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, prInfo });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const check = (command) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: R, workspaceId: 'W1' });
  const gates = async () => (await ledger.get(task.id)).gates || [];
  const approve = async (gate) => { const r = await ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true }); await svc.afterDecision(r.task, gate); };
  return { R, check, gates, approve };
}

test('A, the shape first seen: a switch before the push; no commit on the row, what runs first named, one approval = one row', async () => {
  const s = await setup('feat-a');
  git(s.R, 'config', 'push.default', 'current');
  assert.equal((await s.check('git switch main && git push origin')).decision, 'deny');   // held: main is switched to (PR 1)
  const [g1] = await s.gates();
  assert.equal(g1.ref, null); assert.match(g1.why, /this push is not bound to a commit \(run before it in the same call: git switch\)/);
  // the sequence as it was seen: filed, approved, the folder's HEAD moved before the redeem: still one row, it runs
  await s.approve(g1.id);
  git(s.R, 'commit', '-q', '--allow-empty', '-m', 'moved');
  assert.equal((await s.check('git switch main && git push origin')).decision, 'allow');
  assert.equal((await s.gates()).length, 1, 'no second row for the same call');
});

test('C: a commit before the push in the same call; a reader before it keeps the binding; a plain push is bound as before', async () => {
  const s = await setup('main');
  await s.check('git commit -qam x && git push origin main');
  const [c] = await s.gates();
  assert.equal(c.ref, null); assert.match(c.why, /not bound to a commit \(run before it in the same call: git commit\)/);
  await s.check('git status && git log -1 && git fetch origin && git push origin main --force-with-lease');
  const r = (await s.gates()).at(-1);
  assert.equal(r.ref?.kind, 'push'); assert.equal(r.ref.name, 'main'); assert.match(r.why, /main at [0-9a-f]{7}/);
  await s.check('git push origin main -f');
  assert.equal((await s.gates()).at(-1).ref?.kind, 'push');
  await s.check('echo $(git commit -qam y) && git push origin main --force');
  assert.match((await s.gates()).at(-1).why, /git commit in a substitution/);
  await s.check('./build.sh && npm test && git commit -qam z && git tag v9 && git switch -q main && git push origin main --no-verify');
  assert.match((await s.gates()).at(-1).why, /build\.sh, npm, git commit, git tag, git switch\)/);
});

test('a merge after something that may move the PR head: no head on the row; a landing with no PR named after a branch change: refused unfiled', async () => {
  const s = await setup('feat-a');
  await s.check('git push origin feat-a && gh pr merge 11 --squash');
  const [m] = await s.gates();
  assert.equal(m.ref, null); assert.match(m.why, /PR #11 .*this merge is not bound to a head \(run before it in the same call: git push\)/);
  assert.doesNotMatch(m.why, /head aaaaaaa/);
  const before = (await s.gates()).length;
  const r = await s.check('git switch feat-b && gh pr merge --squash');
  assert.equal(r.decision, 'deny'); assert.equal(r.unfiled, true); assert.match(r.reason, /Name the PR \(gh pr merge <number>/);
  assert.equal((await s.gates()).length, before, 'nothing filed');
  // named, it is read and asked as usual; alone it is bound to its head
  await s.check('gh pr merge 12 --squash');
  const n = (await s.gates()).at(-1); assert.equal(n.ref?.head, PRS['feat-b'].headOid);
});

test('what counts as a command that may move a ref', () => {
  const one = (t) => refMover(parseCommand(t).cmds[0]);
  for (const t of ['git status', 'git log -1', 'git fetch origin', 'git branch', 'git branch -vv', 'git remote -v', 'echo x', 'cd /x', 'cat f', 'gh pr view 3', 'git add -A',
    'gh pr checks 3', 'gh run watch 9', 'gh api repos/o/r/pulls/3', 'gh auth status', 'echo x > /dev/null', 'git log 2>&1', 'cat f 2>/dev/null'])
    assert.equal(one(t), null, t);
  for (const [t, w] of [['git commit -m x', 'git commit'], ['git fetch origin main:main', 'git fetch'], ['git push origin', 'git push'], ['git branch -f x', 'git branch'],
    ['./x.sh', 'x.sh'], ['npm test', 'npm'], ['gh pr checkout 3', 'gh pr checkout'], ['X=1', 'a variable set in the call'], ['git stash pop', 'git stash'],
    // MC's read of PR 2: the gh verbs that change something, and a reader that writes a file
    ['gh pr edit 12 --base main', 'gh pr edit'], ['gh pr create --fill', 'gh pr create'], ['gh repo sync', 'gh repo sync'], ['gh api -X PATCH repos/o/r/git/refs/heads/x -f sha=1', 'gh api (a write)'],
    ['gh auth login', 'gh auth login'], ['echo abc > .git/refs/heads/x', 'echo (writes a file)'], ['git show -s --output=.git/HEAD', 'git show (writes a file)'], ['cat a >> b', 'cat (writes a file)']])
    assert.equal(one(t), w, t);
});

test('MC read of PR 2: a body handed to a shell, gh changes, a file written, the hint to the agent, and an upstream change is not a branch change', async () => {
  const s = await setup('main');
  const r1 = await s.check('git commit -qam x && bash -c "git push origin main"');
  const g1 = (await s.gates()).at(-1);
  assert.equal(g1.ref, null); assert.match(g1.why, /not bound to a commit \(run before it in the same call: git commit\)/);
  assert.match(r1.reason, /run what comes first as its own call and the push or merge alone/);
  const w = await s.check('echo abc > .git/refs/heads/main && git push origin main');
  assert.match((await s.gates()).at(-1).why, /echo \(writes a file\)/, JSON.stringify(w));
  await s.check('echo ok > /dev/null && git push origin main');
  assert.equal((await s.gates()).at(-1).ref?.kind, 'push', 'a write to /dev/null keeps the binding');
  const r2 = await s.check('git push origin main --force');
  assert.doesNotMatch(r2.reason || '', /run what comes first/, 'a bound row gets no hint');
  const f = await setup('feat-a');
  await f.check('gh pr edit 11 --base main && gh pr merge 11 --squash');
  const m = (await f.gates()).at(-1); assert.equal(m.ref, null); assert.match(m.why, /not bound to a head \(run before it in the same call: gh pr edit\)/);
  const before = (await f.gates()).length;
  const up = await f.check('git branch -u origin/main && gh pr merge --squash');
  assert.notEqual(up.unfiled, true, 'an upstream change is not a branch change: filed, not refused');
  assert.equal((await f.gates()).length, before + 1);
});
