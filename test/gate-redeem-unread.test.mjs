// node --test "test/*.test.mjs" — #708: a slow read of what an approval refers to (the PR head) at the release lost the
// owner's approval (#704 g1, 2026-11-17: the read ran out at 5 s, g1 was marked superseded, the call was filed again
// unbound, past the hook's deadline, and the hook said "board unreachable"). Now: A) the command's own pin, in the form
// the board writes, releases with no read for every engine; B) unread is not moved: the grant is put back and the
// approval stands; C) a row filed while the PR cannot be read is bound to the head the command pins, marked not read,
// and never runs under a program go; D) nothing is written past the hook's deadline; E) the hook says the board was
// slow, not unreachable. An unread head never releases a call. Neutral fixtures; gh and git are injected.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService, RETRY_MIN_MS } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { waitRanOut, boardLate } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; const B = 'd4e5f60718293a4b5c6d7e8f9012345678a1b2c3';
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-unread-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  // world.head: the PR head gh reports (null = gh fails); world.fail: the next N reads fail; world.onRead: a hook per read
  const world = { head: A, fail: 0, reads: 0, t: Date.parse('2026-01-05T10:00:00Z'), onRead: null };
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, now: () => world.t,
    prInfo: async () => {
      world.reads += 1; world.onRead?.();
      if (world.fail > 0) { world.fail -= 1; return null; }
      if (world.head == null) throw new Error('gh failed');
      return { number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: world.head, repo: 'acme/app' };
    },
    git: (cwd, args) => (args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : null),
  });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const check = (command, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const approve = async (gate) => { const r = await ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true, now: world.t }); await svc.afterDecision(r.task, gate); };
  const gates = async () => (await ledger.get(task.id)).gates || [];
  const grants = async () => JSON.parse(await readFile(path.join(dir, 'guardrails', 'grants.json'), 'utf8').catch(() => '[]'));
  const receipts = async () => (await readFile(path.join(dir, 'guardrails', 'receipts.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, ledger, svc, world, task, check, approve, gates, grants, receipts };
}
const PINNED = `gh pr merge 7 --squash --match-head-commit ${A}`;
const LONGER = 'gh pr merge 7 --merge && git pull --ff-only';   // not pinnable by the board: the head is read at the release

test('A: a Claude merge whose own words pin the approved head is released with no read of the PR; a pin naming another head supersedes', async () => {
  const s = await setup();
  assert.equal((await s.check(PINNED)).decision, 'deny');
  assert.equal((await s.gates())[0].ref.head, A);
  await s.approve('g1');
  s.world.head = null;                           // GitHub does not answer now: the pin needs no read, GitHub compares at the run
  const before = s.world.reads;
  const r = await s.check(PINNED);
  assert.equal(r.decision, 'allow', r.reason); assert.equal(r.updatedCommand, undefined, 'its own pin, not a second one');
  assert.match(r.reason, /pinned by its own words to head a1b2c3d/);
  assert.equal(s.world.reads, before, 'no read of the PR at the release');
  assert.equal((await s.gates())[0].status, 'executed');

  // the command pins A, the PR read B when it was filed, and the owner approved B: the pin is not the approved head
  const t = await setup();
  t.world.head = B;
  await t.check(PINNED); await t.approve('g1');
  const moved = await t.check(PINNED);
  assert.equal(moved.decision, 'deny');
  const [g1] = await t.gates();
  assert.equal(g1.status, 'expired'); assert.match(g1.note, /superseded: its pin names a1b2c3d, and the head you approved is d4e5f60/);
});

test('B: a head that could not be read is not a head that moved: the grant is put back, the approval stands, nothing is filed', async () => {
  const s = await setup();
  await s.check(LONGER); await s.approve('g1');
  const exp = (await s.grants())[0].expires_at;
  s.world.head = null;
  const r = await s.check(LONGER);
  assert.equal(r.decision, 'deny'); assert.equal(r.unfiled, true);
  assert.match(r.reason, /the PR head could not be read just now .* The approval \(task #\d+ gate g1\) stands: run the same command again, once/);
  assert.equal((await s.gates()).length, 1); assert.equal((await s.gates())[0].status, 'approved');
  const [gr] = await s.grants();
  assert.equal(gr.used_at, null, 'put back'); assert.equal(gr.expires_at, exp, 'its expiry untouched');
  // the head reads again, unchanged: released once; the chain holds one approval and one release
  s.world.head = A;
  assert.equal((await s.check(LONGER)).decision, 'allow');
  assert.equal((await s.check(LONGER)).decision, 'deny', 'single use, as before');
  const lines = (await s.receipts()).filter((x) => x.gate === 'g1');
  assert.equal(lines.filter((x) => x.event === 'approved').length, 1, JSON.stringify(lines.map((x) => x.event)));
  assert.equal(lines.filter((x) => x.event === 'released').length, 1, JSON.stringify(lines.map((x) => x.event)));
  assert.equal((await s.ledger.get(s.task.id)).gates.filter((g) => g.id !== 'g1').length, 1, 'the second try filed one new row, nothing else');
  // a read that answers with ANOTHER head still supersedes (unchanged)
  const m = await setup();
  await m.check(LONGER); await m.approve('g1');
  m.world.head = B;
  assert.equal((await m.check(LONGER)).decision, 'deny');
  assert.equal((await m.gates())[0].status, 'expired');
});

test('B: one more read inside the budget; and two identical calls at once still give exactly one release', async () => {
  const s = await setup();
  await s.check(LONGER); await s.approve('g1');
  s.world.fail = 1;                              // the first read at the release does not answer, the retry does
  const r = await s.check(LONGER);
  assert.equal(r.decision, 'allow', r.reason); assert.match(r.reason, /head a1b2c3d unchanged/);
  assert.ok(RETRY_MIN_MS > 0 && RETRY_MIN_MS < 6000);

  for (const failFirst of [0, 2]) {             // 2: the first call's read and its retry fail, it puts the grant back; the second releases
    const t = await setup();
    await t.check(LONGER); await t.approve('g1');
    t.world.fail = failFirst;
    const both = await Promise.all([t.check(LONGER), t.check(LONGER)]);
    assert.deepEqual(both.map((x) => x.decision).sort(), ['allow', 'deny'], `failFirst ${failFirst}: ${both.map((x) => x.reason).join(' | ')}`);
    assert.equal((await t.grants()).filter((g) => g.used_at && g.used_at !== 'expired').length, 1, 'one use');
    const lines = (await t.receipts()).filter((x) => x.gate === 'g1');
    assert.equal(lines.filter((x) => x.event === 'released').length, 1);
    assert.equal(t.svc.locksHeld(), 0);
  }
});

test('C: a row filed while the PR cannot be read is bound to the head its command pins, says "not read", and has no repository chips', async () => {
  const s = await setup();
  s.world.head = null;
  const r = await s.check(PINNED);
  assert.equal(r.decision, 'deny');
  const [g] = await s.gates();
  assert.deepEqual(g.ref, { kind: 'pr', repo: null, number: 7, name: null, head: A, pinnedOnly: true });
  assert.match(g.why, /head a1b2c3d \(pinned by the command; not read\)/);
  assert.ok(!(g.context?.chips || []).some((c) => /public-repo|deploy-on-push/.test(c)), JSON.stringify(g.context));
  // released only by that pin, never by a read
  await s.approve('g1');
  const before = s.world.reads;
  assert.equal((await s.check(PINNED)).decision, 'allow');
  assert.equal(s.world.reads, before);
  // without a pin of its own: no binding (unchanged)
  const t = await setup();
  t.world.head = null;
  await t.check('gh pr merge 7 --squash');
  assert.equal((await t.gates())[0].ref, null);
});

test('C: a pinned-only row never runs under a program go', async () => {
  const s = await setup();
  await s.ledger.update(s.task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: ship', kind: 'program' });
  await s.ledger.update(s.task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  // read: the go applies (control)
  assert.equal((await s.check('gh pr merge 7 --squash')).decision, 'allow');
  s.world.head = null;
  const r = await s.check(PINNED);
  assert.equal(r.decision, 'deny', r.reason);
  const g = (await s.gates()).at(-1);
  assert.match(g.why, /not under the program go: the PR head was not read/);
});

test('D: past the hook\'s deadline nothing is written: no release, no superseding, no row, no task; the grant is put back', async () => {
  const s = await setup();
  await s.check(LONGER); await s.approve('g1');
  const deadline = s.world.t + 1000;
  s.world.onRead = () => { s.world.t += 5000; };   // the read takes the rest of the wait
  const r = await s.check(LONGER, { deadline });
  assert.equal(r.decision, 'deny'); assert.equal(r.stale, true);
  assert.equal((await s.gates()).length, 1); assert.equal((await s.gates())[0].status, 'approved');
  assert.equal((await s.grants())[0].used_at, null);
  s.world.onRead = null;
  assert.equal((await s.check(LONGER)).decision, 'allow', 'the approval still runs once');

  // a new call whose PR read runs past the deadline at filing: no row, no task made for it
  const t = await setup();
  const tasksBefore = (await t.ledger.list({})).length;
  t.world.onRead = () => { t.world.t += 5000; };
  const late = await t.check('gh pr merge 7 --squash', { deadline: t.world.t + 1000 });
  assert.equal(late.stale, true);
  assert.equal((await t.gates()).length, 0);
  assert.equal((await t.ledger.list({})).length, tasksBefore);
});

test('E: the hook tells a board that answered too late from one that cannot be reached', async () => {
  assert.equal(waitRanOut(Object.assign(new Error('x'), { name: 'TimeoutError' })), true);
  assert.equal(waitRanOut(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(waitRanOut(new TypeError('fetch failed')), false);
  assert.match(boardLate(8000), /^GATE: the board did not answer within 8 s — gated command not run \(fail closed\)\. Run it again/);
  const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
  const base = { ...process.env, GATE_NODE: process.execPath, MC_PORT: '', GATE_TIMEOUT_MS: '1500', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
  const input = JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash', description: 'x' } });
  const reason = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  // a board that takes the request and never answers (the kernel accepts the connection while this test waits)
  const srv = http.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((res) => srv.once('listening', res));
  const slow = spawnSync('sh', [HOOK, '--env-board'], { input, env: { ...base, MESH_BOARD: `http://127.0.0.1:${srv.address().port}` }, encoding: 'utf8' });
  srv.closeAllConnections?.(); srv.close();
  assert.match(reason(slow), /the board did not answer within 2 s/);
  const down = spawnSync('sh', [HOOK, '--env-board'], { input, env: { ...base, MESH_BOARD: 'http://127.0.0.1:9' }, encoding: 'utf8' });
  assert.match(reason(down), /board unreachable/);
});
