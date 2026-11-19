// node --test "test/*.test.mjs" — #636 (PR 2): the gate service's reads off the board's event loop, one budget per
// check, and one decision at a time per call. The service ran git (1.5 s), gh pr view (5 s) and gh api (8 s) with
// execFileSync inside a gate check; each held the whole loop. Now classify (still synchronous: the hook runs it too)
// reads git from a per-check cache run to a fixpoint, the service's own reads are awaited, and a lock per call
// (agent + fingerprint) keeps "find, re-read and use a grant" and "file a row" one step each (MC's condition 1).
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, DEFAULT_POLICY, CHECKS, compileTriggers } from '../src/gates.mjs';
import { createGateService, createReadCache, toFixpoint, CHECK_BUDGET_MS, MAX_PASSES } from '../src/gate-service.mjs';
import { createBudget } from '../src/gate-integrity.mjs';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUB = 'https://github.com/acme/public-app.git'; const PRIV = 'https://github.com/acme/private-app.git';
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// ── condition 4: the same verdict and reason through the cache as with a synchronous git, for every handler that reads git ──
async function repo(name, origin = PRIV) {
  const dir = path.join(realpathSync(await mkdtemp(path.join(os.tmpdir(), 'reads-svc-'))), name);
  execFileSync('git', ['init', '-q', '-b', 'feature', dir], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'branch', 'main'], { stdio: 'ignore' });
  return dir;
}
const syncGit = (cwd, a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
const asyncGit = (cwd, a) => new Promise((res) => { res(syncGit(cwd, a)); });   // the same answers, read through the cache

test('equivalence: every handler that reads git gives the same verdict and reason through the cache (0 differences)', async () => {
  const P = await repo('priv'); const Q = await repo('pub', PUB);
  const enforce = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'enforce'])) };
  enforce.lists = { ...(enforce.lists || {}), publicRemotes: ['acme/public-app'] };
  const observe = { ...structuredClone(enforce), checks: Object.fromEntries(CHECKS.map((n) => [n, 'observe'])) };
  const calls = [
    // push address (#552)
    ...['git push origin feature', `git push ${PUB} feature`, `git -c remote.origin.url=${PUB} push origin feature`, `git remote add up ${PUB} && git push up feature`,
      `git push --repo=${PUB}`, `git push --repo=${PUB} feature`, 'git push', 'git push origin HEAD', 'git push --all origin', 'git push origin main:main',
      'GIT_CONFIG_COUNT=1 git push origin feature', 'git config remote.origin.url x; git push origin feature', 'git push -u origin feature', 'git push origin +feature'].map((c) => [c, P]),
    ...['git push origin feature', 'git push', 'git push origin main', 'git push --tags'].map((c) => [c, Q]),
    // push after a switch (#584)
    ...['git switch main && git push origin', 'git checkout main && git push', 'git switch -c x && git push origin HEAD', 'git checkout - && git push',
      'bash -c "git switch main && git push origin"', 'git branch -u origin/main && git push', 'git stash branch b && git push origin', 'echo $(git switch main) && git push'].map((c) => [c, P]),
    // folder changes (#551) and git -C
    ...[`cd ${Q} && git push origin feature`, `cd ${P}; git push origin feature`, `cd ${Q} || true; git push origin feature`, `git -C ${Q} push origin feature`,
      `cd ${Q} && cd ${P} && git push`, `pushd ${Q} && git push`, `cd ${Q} | cat && git push`, `GIT_DIR=${Q}/.git git push origin feature`].map((c) => [c, P]),
    // landings (merge binding, #584 PR 2) and gh with repos named
    ...['gh pr merge 7 --squash', 'gh pr merge 7 --squash -R acme/private-app', 'git switch main && gh pr merge --squash', 'git commit -m x && gh pr merge 7',
      'gh pr merge https://github.com/acme/public-app/pull/7', 'GH_REPO=acme/public-app gh pr merge 7', 'gh pr comment 3 --body hi', 'gh pr create --repo acme/public-app'].map((c) => [c, P]),
    // the live checkout and the board repo (selfProtect: git config, reset, checkout, fetch into main)
    ...['git config core.hooksPath x', 'git reset --hard HEAD~1', 'git checkout main', 'git fetch origin main:main', 'git pull --ff-only', 'git status',
      'git branch -f main HEAD', 'git config user.name x'].map((c) => [c, ROOT]),
    // deletes relative to the folder, and a script run
    ...['rm -rf build', 'git clean -fdx', 'node scripts/rename.mjs --commit', 'git rm -r src'].map((c) => [c, P]),
  ];
  // the Codex shell form: the folder not told (#548): every one of the above, read as unread
  const codex = calls.slice(0, 20).map(([c, cwd]) => [c, cwd, true]);
  let diffs = []; let most = 0; let n = 0;
  for (const pol of [enforce, observe]) {
    const triggers = compileTriggers(pol, {});
    for (const [command, cwd, unread] of [...calls, ...codex]) {
      const call = { tool: 'Bash', command, cwd, ...(unread ? { folderUnread: true } : {}) };
      const base = { home: '/home/u', boardRoot: ROOT, triggers };
      const want = classify(call, pol, { ...base, git: syncGit, repoRoot: (d) => syncGit(d, ['rev-parse', '--show-toplevel']) });
      const rc = createReadCache(asyncGit, createBudget(CHECK_BUDGET_MS));
      const { out: got, passes } = await toFixpoint(rc, () => classify(call, pol, { ...base, git: rc.sync, repoRoot: (d) => rc.sync(d, ['rev-parse', '--show-toplevel']) }));
      most = Math.max(most, passes); n += 1;
      const pick = (v) => JSON.stringify({ verdict: v.verdict, cls: v.cls || null, why: v.why || null, check: v.check || null, wouldHold: v.wouldHold?.check || null });
      if (pick(want) !== pick(got)) diffs.push({ command, cwd: path.basename(cwd), unread: !!unread, want: pick(want), got: pick(got) });
    }
  }
  assert.deepEqual(diffs, [], 'no call reads differently through the cache');
  assert.ok(n >= 120, `${n} readings compared`);
  assert.ok(most <= MAX_PASSES, `at most ${most} passes`);
  console.log(`# equivalence: ${n} readings, 0 differences, most passes ${most}`);
});

// ── the service: conditions 1, 3, 6 ──
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
async function service({ git = async () => null, prInfo, isPrivateRepo = async () => true, afterTaskChange } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reads-svc-board-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo, git,
    prInfo: prInfo || (async () => ({ number: 7, title: 'T', head: 'f', base: 'main', headOid: A, repo: 'acme/app' })),
    ...(afterTaskChange ? { afterTaskChange } : {}),
  });
  const task = await ledger.create({ title: 'ship', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const check = (command, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const approve = async (gate) => { const r = await ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true }); await svc.afterDecision(r.task, gate); };
  const gates = async () => (await ledger.get(task.id)).gates || [];
  return { dir, ledger, svc, task, check, approve, gates };
}
const MERGE = 'gh pr merge 7 --squash -R acme/app';
const hang = (ms) => new Promise((res) => setTimeout(res, ms));

test('two identical approved calls at once: exactly one allow; the grant file shows one use', async () => {
  const s = await service();
  assert.equal((await s.check(MERGE)).decision, 'deny');
  await s.approve('g1');
  const both = await Promise.all([s.check(MERGE), s.check(MERGE)]);
  assert.deepEqual(both.map((x) => x.decision).sort(), ['allow', 'deny']);
  const grants = JSON.parse(await readFile(path.join(s.dir, 'guardrails', 'grants.json'), 'utf8'));
  assert.equal(grants.filter((g) => g.used_at && g.used_at !== 'expired').length, 1);
  assert.equal(s.svc.locksHeld(), 0, 'the lock map is empty when idle');
});

test('two identical held calls at once: one row; the other is told it is waiting', async () => {
  const s = await service();
  const both = await Promise.all([s.check(MERGE), s.check(MERGE)]);
  assert.deepEqual(both.map((x) => x.decision), ['deny', 'deny']);
  assert.equal((await s.gates()).length, 1, 'one row');
  assert.ok(both.some((x) => /Waiting on the owner/.test(x.reason)));
  assert.equal(s.svc.locksHeld(), 0);
});

test('a decision that throws releases the lock: the next identical call is decided', async () => {
  let boom = true;
  const s = await service({ afterTaskChange: async () => { if (boom) { boom = false; throw new Error('boom'); } } });
  await assert.rejects(s.check(MERGE), /boom/);
  assert.equal(s.svc.locksHeld(), 0, 'nothing left held after the throw');
  const t0 = Date.now();
  const r = await s.check(MERGE);
  assert.equal(r.decision, 'deny'); assert.ok(Date.now() - t0 < 2000, 'not waiting on a lock');
});

test('condition 3: two identical calls at once with slow reads: both answered inside the hook\'s 8 s wait, never passed', async () => {
  // every PR read takes 2.5 s: the first call files after one read, the second waits for the lock and answers from the row
  const s = await service({ prInfo: async () => { await hang(2500); return { number: 7, title: 'T', head: 'f', base: 'main', headOid: A, repo: 'acme/app' }; } });
  const t0 = Date.now();
  const both = await Promise.all([s.check(MERGE).then((r) => ({ r, ms: Date.now() - t0 })), s.check(MERGE).then((r) => ({ r, ms: Date.now() - t0 }))]);
  for (const x of both) { assert.equal(x.r.decision, 'deny'); assert.ok(x.ms < 8000, `answered at ${x.ms} ms`); }
  assert.equal((await s.gates()).length, 1);
  console.log(`# two identical held calls with 2.5 s reads: answered at ${both.map((x) => x.ms).join(' and ')} ms`);
  // a call waiting longer than its own budget for the same call is held with the same-call text, never passed
  const slow = await service({ prInfo: async () => { await hang(CHECK_BUDGET_MS + 1500); return null; } });
  const t1 = Date.now();
  const pair = await Promise.all([slow.check(MERGE), slow.check(MERGE)]);
  assert.ok(pair.every((x) => x.decision === 'deny'));
  assert.ok(pair.some((x) => /being decided right now/.test(x.reason)), 'the waiter ran out and was held');
  assert.ok(Date.now() - t1 < 8000 + 1500, `ended at ${Date.now() - t1} ms`);
});

test('a hung git during a check: the loop answers HTTP meanwhile, the verdict is held, the check ends inside its budget', async () => {
  const P = await repo('hung');
  // the reader the board injects honours the budget (readChild kills at it); this one never answers before it ends
  const s = await service({ git: async (cwd, args, budget) => { await hang(budget.left() + 10); return null; } });
  const srv = http.createServer((q, res) => res.end('ok')).listen(0);
  const port = srv.address().port;
  const t0 = Date.now();
  const pending = s.check('git push origin feature', { cwd: P });
  const answers = [];
  for (let i = 0; i < 3; i++) { await hang(300); answers.push(await new Promise((res) => http.get(`http://127.0.0.1:${port}/`, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res(b)); }))); }
  const r = await pending; srv.close();
  assert.deepEqual(answers, ['ok', 'ok', 'ok'], 'HTTP answered while the check waited on git');
  // on main a git that never answered read as null, and this push (a branch no rule protects, address unread) passed:
  // a reading made while reads ran out is held now, and nothing is filed
  assert.equal(r.decision, 'deny', r.reason); assert.equal(r.unfiled, true);
  assert.match(r.reason, /could not read this call's repository in time/);
  assert.deepEqual(await s.gates(), []);
  assert.ok(Date.now() - t0 < CHECK_BUDGET_MS + 1500, `ended at ${Date.now() - t0} ms`);
  // the same call with git answering: passes as before (an answered "no" is an answer)
  const ok = await service({ git: async (cwd, a) => syncGit(cwd, a) });
  assert.equal((await ok.check('git push origin feature', { cwd: P })).decision, 'pass');
});

// MC's read of b89c951 (blocking): the hold sat before the mode and enforcement decision, and refused callers the board
// only observes. Only an enforced caller is held; mode off passes; observe or a caller not enforced passes with one line.
test('reads that ran out: only an enforced caller is held; mode observe, mode off and a caller on observeFor pass as on main', async () => {
  const P = await repo('modes');
  const hung = async (cwd, args, budget) => { await hang(budget.left() + 10); return null; };
  const board = async (pol, ws) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'reads-svc-mode-'));
    await writeFile(path.join(dir, 'policy.json'), JSON.stringify(pol));
    const svc = createGateService({ root: dir, ledger: createLedger(path.join(dir, 'tasks')), policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
      identifyWs: async (w) => ({ W1: 'builder' }[w] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, git: hung });
    const r = await svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: 'git push origin feature', cwd: P, ...(ws ? { workspaceId: ws } : {}) });
    const lines = await readFile(path.join(dir, 'guardrails', 'observed.jsonl'), 'utf8').then((t) => t.trim().split('\n').filter(Boolean)).catch(() => []);
    return { r, lines };
  };
  const cases = [
    ['mode observe', { ...structuredClone(policy), mode: 'observe' }, 'W1', 'pass', 1],
    ['mode off', { ...structuredClone(policy), mode: 'off' }, 'W1', 'pass', 0],
    ['an unregistered caller on observeFor', { ...structuredClone(policy), defaultMode: 'enforce', observeFor: ['unregistered'] }, null, 'pass', 1],
    ['an unregistered caller under the opt-in default', { ...structuredClone(policy), defaultMode: 'observe', enforceFor: ['*'] }, null, 'pass', 1],
    ['an enforced registered caller', { ...structuredClone(policy), defaultMode: 'enforce', observeFor: [] }, 'W1', 'deny', 0],
    ['an enforced unregistered caller', { ...structuredClone(policy), defaultMode: 'enforce', observeFor: [] }, null, 'deny', 0],
  ];
  const got = await Promise.all(cases.map(([, pol, ws]) => board(pol, ws)));
  cases.forEach(([name, , , want, lines], k) => {
    assert.equal(got[k].r.decision, want, `${name}: ${got[k].r.reason || ''}`);
    assert.equal(got[k].lines.length, lines, `${name}: observed lines`);
    if (want === 'deny') { assert.equal(got[k].r.unfiled, true, name); assert.match(got[k].r.reason, /could not read this call's repository in time/); }
    else if (lines) assert.match(got[k].lines[0], /git did not answer in time/, name);
  });
});

test('reads still not asked at the pass cap or the budget\'s end are a guess too: marked as ran out', async () => {
  // a step that asks for a new read on every pass never reaches a fixpoint
  let n = 0;
  const rc = createReadCache(async () => 'x', createBudget(CHECK_BUDGET_MS));
  const { passes } = await toFixpoint(rc, () => rc.sync('/w', ['rev-parse', String(n++)]));
  assert.equal(passes, MAX_PASSES); assert.equal(rc.budget.ranOut, true);
  // a budget already spent: the first miss is not read, and the reading is marked
  const spent = createReadCache(async () => 'x', createBudget(0));
  await toFixpoint(spent, () => spent.sync('/w', ['status']));
  assert.equal(spent.budget.ranOut, true);
  // a step that reaches its fixpoint is not marked
  const fine = createReadCache(async () => 'x', createBudget(CHECK_BUDGET_MS));
  await toFixpoint(fine, () => fine.sync('/w', ['status']));
  assert.equal(fine.budget.ranOut, false);
});

test('a hung gh: the PR read and the private read run out; no binding, and a program go does not auto-approve', async () => {
  const s = await service({ prInfo: async () => { await hang(CHECK_BUDGET_MS + 500); return null; }, isPrivateRepo: async () => { await hang(CHECK_BUDGET_MS + 500); return true; } });
  await s.ledger.update(s.task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: ship', kind: 'program' });
  await s.ledger.update(s.task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  const r = await s.check(MERGE);
  assert.equal(r.decision, 'deny', r.reason);
  const [g] = await s.gates();
  assert.ok(!g.ref, 'no head bound when the PR could not be read');
  assert.match(g.why, /not under the program go: .*(not confirmed private|target repo is unknown)/);
  // a Codex merge whose PR cannot be read is refused unfiled, as for an unreadable PR
  const c = await s.check(MERGE, { engine: 'codex', folderUnread: true, turn: 'T1' });
  assert.equal(c.decision, 'deny'); assert.equal(c.unfiled, true, c.reason);
});

test('a release whose head re-read hangs is not released on the old head (#708: and the approval stands)', async () => {
  let slow = false;
  const s = await service({ prInfo: async () => { if (slow) { await hang(CHECK_BUDGET_MS + 500); return null; } return { number: 7, title: 'T', head: 'f', base: 'main', headOid: A, repo: 'acme/app' }; } });
  const NOT_ALONE = `cd /work/app && ${MERGE}`;   // not pinnable: the head is read again at the release
  assert.equal((await s.check(NOT_ALONE)).decision, 'deny');
  await s.approve('g1');
  slow = true;
  const r = await s.check(NOT_ALONE);
  assert.equal(r.decision, 'deny', r.reason); assert.equal(r.unfiled, true);
  const g1 = (await s.gates()).find((g) => g.id === 'g1');
  assert.equal(g1.status, 'approved', 'unread is not moved: not superseded'); assert.equal((await s.gates()).length, 1, 'nothing filed');
});

test('earlier passes have no effect outside the check: one observed line for a call that needed several passes', async () => {
  const P = await repo('passes');
  const reads = []; const obsPolicy = { ...structuredClone(policy), defaultMode: 'enforce', observeFor: ['builder'] };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reads-svc-obs-'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(obsPolicy));
  const svc = createGateService({ root: dir, ledger: createLedger(path.join(dir, 'tasks')), policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async () => 'builder', home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, git: async (cwd, a) => { reads.push(a[0]); return syncGit(cwd, a); } });
  const r = await svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: 'git switch main && git push origin', cwd: P, workspaceId: 'W1' });
  assert.equal(r.decision, 'pass'); assert.equal(r.observed, true);
  const lines = (await readFile(path.join(dir, 'guardrails', 'observed.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(lines.length, 1, 'one observed line');
  assert.ok(svc.callerReadings().passesMax >= 2, `${svc.callerReadings().passesMax} passes`);
  assert.ok(reads.length > 0);
});

test('the gate service has no synchronous child process; its reader comes from the file already on the gate-code list', async () => {
  const src = await readFile(path.join(ROOT, 'src', 'gate-service.mjs'), 'utf8');
  assert.doesNotMatch(src, /execFileSync|spawnSync|execSync/);
  assert.match(src, /import \{ readChild, createBudget \} from '\.\/gate-integrity\.mjs';/);
});
