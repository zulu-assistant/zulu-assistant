import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmdHash, scriptsRun, soleMerge, pushedRef, pushedRefs, pinnedMerge, parseCommand, HASH_VERSION, DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { auditRows } from '../src/gate-ledger.mjs';
import { hookInput, hookOutput } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

// Zulu 1.3 slice 8: what a grant binds. The PR head (pinned through the hook, or read again), the pushed
// ref, and the content of the scripts a command runs. Neutral fixtures; gh and git are injected.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; const B = 'd4e5f60718293a4b5c6d7e8f9012345678a1b2c3';
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

async function setup(over = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-bind-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(over.policy || policy));
  const world = { head: A, refs: { HEAD: A, main: A, 'feature-x': A }, prCalls: [], t: Date.parse('2026-01-05T10:00:00Z') };
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, now: () => world.t,
    prInfo: async (cmd, cwd, opts) => { world.prCalls.push(opts || {}); if (world.head == null) throw new Error('gh failed'); return { number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: world.head, repo: opts?.ghRepo || 'acme/app' }; },
    git: (cwd, args) => (args[0] === 'rev-parse' && args.includes('--verify') ? world.refs[String(args.at(-1)).replace('^{commit}', '')] || null
      : args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : args[0] === 'config' ? world.config?.[args.at(-1)] ?? null : null),
  });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const check = (command, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: over.cwd || '/work/app', workspaceId: 'W1', ...extra });
  const approve = async (gate) => { const r = await ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true, now: world.t }); await svc.afterDecision(r.task, gate); };
  const gates = async () => (await ledger.get(task.id)).gates;
  return { dir, ledger, svc, world, task, check, approve, gates };
}

test('the fingerprint is gate-v3 and binds the content of the scripts a command runs', () => {
  assert.equal(HASH_VERSION, 'gate-v3');
  const base = { cwd: '/w', command: 'node x.mjs --commit' };
  assert.equal(cmdHash({ ...base, scripts: ['/w/x.mjs:aaa'] }), cmdHash({ ...base, scripts: ['/w/x.mjs:aaa'] }));
  assert.notEqual(cmdHash({ ...base, scripts: ['/w/x.mjs:aaa'] }), cmdHash({ ...base, scripts: ['/w/x.mjs:bbb'] }));
  assert.notEqual(cmdHash({ ...base, scripts: ['/w/x.mjs:aaa'] }), cmdHash(base));
  assert.deepEqual(scriptsRun('cd sub && node x.mjs --commit && python3 ../y.py; ./run.sh; npx tsx z.ts; node -e "1"; node $F', '/w'),
    [{ path: 'x.mjs', cwd: '/w/sub' }, { path: '../y.py', cwd: '/w/sub' }, { path: './run.sh', cwd: '/w/sub' }]);
  assert.deepEqual(scriptsRun('gh pr merge 5', '/w'), []);
  // on the combined tree: the script behind a preload flag (not the preload file), a sourced script, a script on the input
  assert.deepEqual(scriptsRun('node --import ./pre.mjs scripts/rename.mjs --commit', '/w'), [{ path: 'scripts/rename.mjs', cwd: '/w' }]);
  assert.deepEqual(scriptsRun('. ./env.sh', '/w'), [{ path: './env.sh', cwd: '/w' }]);
  assert.deepEqual(scriptsRun('bash -s -- --apply < tools/sync.sh', '/w'), [{ path: 'tools/sync.sh', cwd: '/w' }]);
  assert.deepEqual(scriptsRun('cat tools/sync.sh | bash -s -- --apply', '/w'), [{ path: 'tools/sync.sh', cwd: '/w' }]);
  assert.deepEqual(scriptsRun('node x.mjs < data.json', '/w'), [{ path: 'x.mjs', cwd: '/w' }]);
});

test('which merges the hook can pin, and which ref a push sends', () => {
  for (const c of ['gh pr merge 7', 'gh pr merge 7 --merge --delete-branch', 'gh -R acme/app pr merge 7', 'gh pr merge 7 > /tmp/out.txt', 'FOO=1 gh pr merge 7']) assert.equal(soleMerge(c), true, c);
  for (const c of ['gh pr merge 7 && git pull', 'cd /w && gh pr merge 7', 'gh pr merge 7 | tail -2', 'gh pr merge 7 --match-head-commit abc', 'gh pr view 7', 'echo $(gh pr merge 7)', 'gh pr merge 7; ls'])
    assert.equal(soleMerge(c), false, c);
  const ref = (c) => pushedRef(parseCommand(c).cmds[0]);
  assert.equal(ref('git push'), 'HEAD'); assert.equal(ref('git push origin'), 'HEAD'); assert.equal(ref('git push origin main'), 'main');
  assert.equal(ref('git push origin HEAD:main'), 'HEAD'); assert.equal(ref('git push origin +feature-x'), 'feature-x'); assert.equal(ref('git push origin :old'), null);
  assert.equal(ref('git push --force origin feature-x:main'), 'feature-x');
});

test('a merge: the row shows the head; approved and run alone it is pinned to that head through the hook', async () => {
  const s = await setup();
  const first = await s.check('gh pr merge 7 --merge');
  assert.equal(first.decision, 'deny');
  const [g] = await s.gates();
  assert.deepEqual(g.ref, { kind: 'pr', repo: 'acme/app', number: 7, name: null, head: A });
  assert.match(g.why, /PR #7 "Add the thing".*head a1b2c3d/);
  await s.approve('g1');
  s.world.head = B;                                  // it moved, and the pinned form needs no second read: GitHub compares
  const calls = s.world.prCalls.length;
  const r = await s.check('gh pr merge 7 --merge');
  assert.equal(r.decision, 'allow'); assert.equal(r.updatedCommand, `gh pr merge 7 --merge --match-head-commit ${A}`);
  assert.match(r.reason, /runs once, pinned to head a1b2c3d/);
  assert.equal(s.world.prCalls.length, calls, 'no extra read of the PR');
  const [done] = await s.gates();
  assert.equal(done.status, 'executed'); assert.equal(done.note, 'pinned to head a1b2c3d');
  assert.ok(auditRows(await s.ledger.get(s.task.id)).some((x) => /pinned to head a1b2c3d/.test(x.via || '')));
  // single use, as before
  assert.equal((await s.check('gh pr merge 7 --merge')).decision, 'deny');
});

test('a merge inside a longer command: the head is read again; unchanged runs, moved or unreadable is superseded and asked again', async () => {
  const cmd = 'gh pr merge 7 --merge && git pull --ff-only';
  const same = await setup();
  await same.check(cmd); await same.approve('g1');
  const ok = await same.check(cmd);
  assert.equal(ok.decision, 'allow'); assert.equal(ok.updatedCommand, undefined); assert.match(ok.reason, /head a1b2c3d unchanged/);

  const moved = await setup();
  await moved.check(cmd); await moved.approve('g1');
  moved.world.head = B;
  const r = await moved.check(cmd);
  assert.equal(r.decision, 'deny'); assert.equal(r.gate, 'g2');
  const [g1, g2] = await moved.gates();
  assert.equal(g1.status, 'expired'); assert.match(g1.note, /superseded: the PR head moved a1b2c3d → d4e5f60 after you approved/);
  assert.equal(g2.status, 'pending'); assert.match(g2.why, /the PR head moved a1b2c3d → d4e5f60 after you approved/); assert.equal(g2.ref.head, B);
  assert.ok((await moved.ledger.get(moved.task.id)).comments.some((c) => /GATE g1 expired unused \(superseded/.test(c.text)));
  // the new gate is an ordinary one: approved at the new head, it runs
  await moved.approve('g2');
  assert.equal((await moved.check(cmd)).decision, 'allow');

  const gone = await setup();
  await gone.check(cmd); await gone.approve('g1');
  gone.world.head = null;
  const u = await gone.check(cmd);
  assert.equal(u.decision, 'deny');
  assert.match((await gone.gates())[0].note, /superseded: the PR head could not be read again/);
});

test('a Codex call (the command is a list of words) is never rewritten: the head is read again', async () => {
  const s = await setup();
  const argv = ['gh', 'pr', 'merge', '7'];
  await s.check(argv, { engine: 'codex' }); await s.approve('g1');
  const ok = await s.check(argv, { engine: 'codex' });
  assert.equal(ok.decision, 'allow'); assert.equal(ok.updatedCommand, undefined);
  const t = await setup();
  await t.check(argv, { engine: 'codex' }); await t.approve('g1'); t.world.head = B;
  assert.equal((await t.check(argv, { engine: 'codex' })).decision, 'deny');
});

test('a merge under a program go is pinned to the head just read', async () => {
  const s = await setup();
  await s.ledger.update(s.task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: land the stack', kind: 'program' });
  await s.ledger.update(s.task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  const r = await s.check('gh pr merge 7 --merge');
  assert.equal(r.decision, 'allow'); assert.equal(r.updatedCommand, `gh pr merge 7 --merge --match-head-commit ${A}`); assert.match(r.reason, /program go.*pinned to head a1b2c3d/);
  const chained = await s.check('gh pr merge 7 --merge && git pull --ff-only');
  // since the program-go rule of slice 13b a landing auto-runs only as its own command: chained, it asks the owner, and nothing is pinned
  assert.equal(chained.decision, 'deny'); assert.equal(chained.updatedCommand, undefined);
});

test('GH_REPO in the agent\'s shell: the hook passes it on, the board reads that repo\'s PR and judges that repo', async () => {
  assert.equal(hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 7' }, cwd: '/w' }, { GH_REPO: 'acme-public/tool' }).ghRepo, 'acme-public/tool');
  assert.equal('ghRepo' in hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w' }, {}), false);
  const p = structuredClone(policy); p.lists.publicRemotes = ['acme-public/*'];
  const s = await setup({ policy: p });
  await s.check('gh pr merge 7', { ghRepo: 'acme-public/tool' });
  assert.equal(s.world.prCalls.at(-1).ghRepo, 'acme-public/tool');
  assert.match((await s.gates())[0].why, /acme-public\/tool/); assert.equal((await s.gates())[0].ref.repo, 'acme-public/tool');
  // under a program go the folder's own repo is private, but the call would act on the public one: it asks
  await s.ledger.update(s.task.id, { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'decline' }, { decider: true });
  await s.ledger.update(s.task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: land the stack', kind: 'program' });
  await s.ledger.update(s.task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  const r = await s.check('gh pr merge 8', { ghRepo: 'acme-public/tool' });
  assert.equal(r.decision, 'deny');
  assert.match((await s.gates()).at(-1).why, /not under the program go: acme-public\/tool is public/);
  assert.equal((await s.check('gh pr merge 9')).decision, 'allow', 'with no GH_REPO the folder\'s private repo decides');
});

test('a push: approved at one commit, it runs only while the pushed ref still points there', async () => {
  const s = await setup();
  await s.check('git push origin main');
  const [g] = await s.gates();
  assert.deepEqual(g.ref, { kind: 'push', repo: null, number: null, name: 'main', head: A }); assert.match(g.why, /main at a1b2c3d/);
  await s.approve('g1');
  assert.equal((await s.check('git push origin main')).decision, 'allow');

  const m = await setup();
  await m.check('git push --force origin feature-x'); await m.approve('g1');
  m.world.refs['feature-x'] = B;                     // another commit was added after the approval
  const r = await m.check('git push --force origin feature-x');
  assert.equal(r.decision, 'deny'); assert.equal(r.gate, 'g2');
  const [g1, g2] = await m.gates();
  assert.match(g1.note, /superseded: feature-x moved a1b2c3d → d4e5f60 after you approved/); assert.match(g2.why, /feature-x at d4e5f60.*feature-x moved/);
  // a delete of a remote ref names no local commit: nothing to compare, the approval stands
  const d = await setup();
  await d.check('git push origin :old-branch'); assert.equal((await d.gates())[0].ref, null);
  await d.approve('g1'); assert.equal((await d.check('git push origin :old-branch')).decision, 'allow');
});

// ── after Mission Control's read of PR 140 ──
test('the pin is used only when the shell hands it to the program: a comment, a list end or a group reads the head again', async () => {
  const PIN = ['gh pr merge 7 --squash', 'gh pr merge 7 --squash 2>&1', 'gh pr merge 7 --squash 2>&1 > out.log', 'GH_REPO=o/r gh pr merge 7 --squash', 'gh pr merge 7 --squash > /tmp/out.txt', 'gh pr merge 7 --subject "a b"'];
  // 1.3.1: '&>' / '&>>' are one redirect in bash and zsh but background + redirect in dash, so no pin there
  const NO_PIN = ['gh pr merge 7 --squash # land it', 'gh pr merge 7 --squash #', 'gh pr merge 7 --squash\n# next line', 'gh pr merge 7 --squash;', 'gh pr merge 7 --squash &', '(gh pr merge 7 --squash)', 'gh pr merge 7 --squash --',
    '{ gh pr merge 7 --squash; }', 'gh pr merge 7 --subject "fix #12"', 'gh pr merge 7 --squash \\', 'gh pr merge 7 --squash &> out.log', 'gh pr merge 7 --squash &>> out.log', 'gh pr merge 7 --squash >& out.log'];
  for (const c of PIN) assert.equal(pinnedMerge(c, A), `${c} --match-head-commit ${A}`, c);
  for (const c of NO_PIN) assert.equal(pinnedMerge(c, A), null, c);
  assert.equal(pinnedMerge('gh pr merge 7', 'not-a-sha; rm x'), null, 'the head is a commit id or nothing is pinned');
  // a stand-in for the program (a shell function, an empty PATH: nothing leaves this machine) shows what it is handed
  for (const c of PIN) {
    const out = spawnSync('/bin/sh', ['-c', `gh() { printf '%s\\n' "$*" >&3; }; ${pinnedMerge(c, A)}`], { env: { PATH: '' }, cwd: os.tmpdir(), encoding: 'utf8', stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    assert.match(String(out.output[3] || ''), new RegExp(`--match-head-commit ${A}\\n$`), c);
  }
  // through the service: each form that cannot be pinned has its head read again
  for (const c of ['gh pr merge 7 --squash # land it', 'gh pr merge 7 --squash;', 'gh pr merge 7 --squash &', 'gh pr merge 7 --squash\n# next line', 'gh pr merge 7 --squash --']) {
    const same = await setup();
    await same.check(c); await same.approve('g1');
    const ok = await same.check(c);
    assert.equal(ok.decision, 'allow', c); assert.equal(ok.updatedCommand, undefined, c); assert.match(ok.reason, /head a1b2c3d unchanged/, c); assert.doesNotMatch(ok.reason, /pinned/, c);
    const moved = await setup();
    await moved.check(c); await moved.approve('g1'); moved.world.head = B;
    const r = await moved.check(c);
    assert.equal(r.decision, 'deny', c);
    assert.match((await moved.gates())[0].note, /superseded: the PR head moved a1b2c3d → d4e5f60 after you approved/, c);
  }
});

test('a push: a flag\'s value is not the remote, every refspec is bound, a wide push says it is not bound', async () => {
  const refs = (c) => pushedRefs(parseCommand(c).cmds[0]);
  assert.deepEqual(refs('git push origin main'), { refs: ['main'] });
  assert.deepEqual(refs('git push origin HEAD:main'), { refs: ['HEAD'] });
  assert.deepEqual(refs('git push --force-with-lease origin +a:b'), { refs: ['a'] });
  assert.deepEqual(refs('git push -o ci.skip origin main'), { refs: ['main'] });
  assert.deepEqual(refs('git push --push-option ci.skip origin main'), { refs: ['main'] });
  assert.deepEqual(refs('git push --push-option=ci.skip origin main'), { refs: ['main'] });
  assert.deepEqual(refs('git push origin main v1.2.0'), { refs: ['main', 'v1.2.0'] });
  assert.deepEqual(refs('git push origin main:main dev:dev'), { refs: ['main', 'dev'] });
  assert.deepEqual(refs('git push origin tag v1.2.0'), { refs: ['refs/tags/v1.2.0'] });
  assert.deepEqual(refs('git push -fu origin main'), { refs: ['main'] });
  assert.deepEqual(refs('git push origin :old'), { refs: [] });
  assert.deepEqual(refs('git push'), { refs: ['HEAD'], bare: true }); assert.deepEqual(refs('git push origin'), { refs: ['HEAD'], bare: true });
  assert.deepEqual(refs('git push -d origin old'), { refs: [] });
  for (const c of ['git push --tags', 'git push --all origin', 'git push --mirror', 'git push --follow-tags origin main', 'git push --some-new-option x origin main', 'git push origin "refs/heads/*:refs/heads/*"'])
    assert.ok(refs(c).unbound, c);

  // the value of a push option is not taken for the ref: main is bound, and a move of main is seen
  const o = await setup();
  await o.check('git push -o ci.skip origin main');
  assert.deepEqual((await o.gates())[0].ref, { kind: 'push', repo: null, number: null, name: 'main', head: A });
  await o.approve('g1'); o.world.refs.main = B;
  assert.equal((await o.check('git push -o ci.skip origin main')).decision, 'deny');
  assert.match((await o.gates())[0].note, /superseded: main moved a1b2c3d → d4e5f60 after you approved/);

  // several refspecs: each is bound; the second one moving is seen
  const two = await setup(); two.world.refs['v1.2.0'] = A;
  await two.check('git push origin main v1.2.0');
  const [g] = await two.gates();
  assert.equal(g.ref.name, 'main v1.2.0'); assert.match(g.why, /main at a1b2c3d, v1\.2\.0 at a1b2c3d/);
  await two.approve('g1');
  const keep = await setup(); keep.world.refs['v1.2.0'] = A;
  await keep.check('git push origin main v1.2.0'); await keep.approve('g1');
  assert.equal((await keep.check('git push origin main v1.2.0')).decision, 'allow');
  two.world.refs['v1.2.0'] = B;
  assert.equal((await two.check('git push origin main v1.2.0')).decision, 'deny');
  assert.match((await two.gates())[0].note, /superseded: one of main, v1\.2\.0 moved after you approved/);

  // a bare push: HEAD, unless the repo's push settings send more (push.default matching, a push refspec for a remote, -c on the line)
  const bare = await setup();
  await bare.check('git push'); assert.equal((await bare.gates())[0].ref?.name, 'HEAD');
  for (const cfg of [{ 'push.default': 'matching' }, { '^remote\\..*\\.push$': 'remote.origin.push refs/heads/*:refs/heads/*' }]) {
    const m = await setup(); m.world.config = cfg;
    await m.check('git push');
    const [gm] = await m.gates();
    assert.equal(gm.ref, null); assert.match(gm.why, /not bound to a commit \(the repo's push settings send more than the current branch\)/);
  }
  for (const c of ['git -c push.default=matching push', 'git -c remote.origin.push=refs/heads/*:refs/heads/* push origin']) {
    const m = await setup(); await m.check(c);
    const [gm] = await m.gates();
    assert.equal(gm.ref, null, c); assert.match(gm.why, /not bound to a commit/, c);
  }
  // settings widened after the approval: the approved bare push no longer runs as approved
  const late = await setup();
  await late.check('git push'); await late.approve('g1'); late.world.config = { 'push.default': 'matching' };
  assert.equal((await late.check('git push')).decision, 'deny');

  // a wide push: no commit on the row, and the row says so
  const w = await setup();
  await w.check('git push --tags');
  const [gw] = await w.gates();
  assert.equal(gw.ref, null); assert.match(gw.why, /this push is not bound to a commit \(--tags sends whatever matches\)/); assert.doesNotMatch(gw.why, /HEAD at/);
  await w.approve('g1'); assert.equal((await w.check('git push --tags')).decision, 'allow');
});

test('the changelog: no entry stands twice', async () => {
  const file = [new URL('../publish/public/CHANGELOG.md', import.meta.url), new URL('../CHANGELOG.md', import.meta.url)].find((u) => existsSync(u));
  if (!file) return;
  const seen = new Map();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!/^- \*\*/.test(line) || line.length < 80) continue;
    assert.ok(!seen.has(line), `this entry stands twice: ${line.slice(0, 90)}…`);
    seen.set(line, true);
  }
});

test('a script: approved as written it runs once; changed after the approval it is a new call and asks again', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'gate bind work-'));
  await mkdir(path.join(work, 'scripts'));
  const script = path.join(work, 'scripts', 'rename.mjs');
  await writeFile(script, 'console.log("v1")\n');
  const cmd = 'node scripts/rename.mjs --commit';
  const s = await setup({ cwd: work });
  assert.match((await s.check(cmd)).reason, /run the dry form first/);
  await s.check('node scripts/rename.mjs'); await s.check('node scripts/rename.mjs', { event: 'post' });
  assert.equal((await s.check(cmd)).decision, 'deny');
  const pending = (await s.gates()).find((g) => g.status === 'pending');
  assert.equal(pending.hashVersion, 'gate-v3');
  await s.approve(pending.id);
  await writeFile(script, 'console.log("v2: something else")\n');          // edited between the approval and the run
  const r = await s.check(cmd);
  assert.equal(r.decision, 'deny'); assert.notEqual(r.gate, pending.id);
  assert.equal((await s.gates()).find((g) => g.id === pending.id).status, 'approved', 'the old approval is simply never used; it expires');
  // put back as approved: the grant matches again and it runs once
  await writeFile(script, 'console.log("v1")\n');
  assert.equal((await s.check(cmd)).decision, 'allow');
  assert.equal((await s.check(cmd)).decision, 'deny');
  // a script that did not exist at approval and appears later is a change too
  const t = await setup({ cwd: work });
  await t.check('bash scripts/later.sh --commit'); await t.check('bash scripts/later.sh'); await t.check('bash scripts/later.sh', { event: 'post' });
  await t.check('bash scripts/later.sh --commit');
  const p2 = (await t.gates()).find((g) => g.status === 'pending'); await t.approve(p2.id);
  await writeFile(path.join(work, 'scripts', 'later.sh'), 'echo hi\n');
  assert.equal((await t.check('bash scripts/later.sh --commit')).decision, 'deny');
});

// ── the real hook script against a board that answers: the pinned command reaches Claude Code as updatedInput ──
const hook = (port, obj) => new Promise((resolve) => {
  const c = spawn('sh', [path.join(ROOT, 'scripts', 'gate-hook.sh'), '--env-board'], { env: { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: `http://127.0.0.1:${port}`, GATE_TIMEOUT_MS: '4000', CMUX_WORKSPACE_ID: 'W1', GH_REPO: '' } });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.on('close', () => resolve(out)); c.stdin.end(JSON.stringify(obj));
});

test('real hook, real service: the allow carries updatedInput with the pinned command and the rest of the input untouched', async () => {
  const s = await setup();
  const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', async () => { const r = await s.svc.check(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r)); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const json = { session_id: 's', transcript_path: '/t.jsonl', cwd: '/work/app', permission_mode: 'auto', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 7 --merge', description: 'land it', timeout: 60000 }, tool_use_id: 'toolu_1' };
    const first = JSON.parse(await hook(port, json)).hookSpecificOutput;
    assert.equal(first.permissionDecision, 'deny'); assert.equal(first.updatedInput, undefined);
    await s.approve('g1');
    const out = JSON.parse(await hook(port, json)).hookSpecificOutput;
    assert.equal(out.permissionDecision, 'allow'); assert.match(out.permissionDecisionReason, /pinned to head a1b2c3d/);
    assert.deepEqual(out.updatedInput, { command: `gh pr merge 7 --merge --match-head-commit ${A}`, description: 'land it', timeout: 60000 });
    // an ordinary approved call is allowed with no rewrite, as before
    const push = { ...json, tool_input: { command: 'git push origin main' } };
    await hook(port, push); await s.approve((await s.gates()).find((g) => g.status === 'pending').id);
    const plain = JSON.parse(await hook(port, push)).hookSpecificOutput;
    assert.equal(plain.permissionDecision, 'allow'); assert.equal('updatedInput' in plain, false);
  } finally { server.close(); }
});

test('hook output: updatedInput only ever rides on an allow', () => {
  assert.deepEqual(JSON.parse(hookOutput('allow', 'ok', 'pre', { command: 'x' })).hookSpecificOutput.updatedInput, { command: 'x' });
  assert.equal('updatedInput' in JSON.parse(hookOutput('deny', 'no', 'pre', { command: 'x' })).hookSpecificOutput, false);
  assert.equal('updatedInput' in JSON.parse(hookOutput('allow', 'ok')).hookSpecificOutput, false);
  assert.equal(hookOutput('allow', 'ok', 'post', { command: 'x' }), '');
});
