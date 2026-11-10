// Hash-chained receipts (1.3): one line per gate change, verify against gates[], and a grant that
// runs only when the chain holds its approval. Temp dirs only; the "board" is the gate service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, rm, appendFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { createReceiptChain, readChain, gateDigest, eventOf, chainMode, GENESIS, OUTSIDE } from '../src/receipt-chain.mjs';
import { OWNER } from '../src/config.mjs';

const T0 = Date.parse('2026-01-05T10:00:00Z');
const CMD = 'gh pr merge 7 --merge';
const STATE = 'guardrails';
const sha = (s) => createHash('sha256').update(s).digest('hex');

function boot(dir, { t = T0, mode, clock = null, git = () => null, isPrivateRepo = async () => null } = {}) {
  const ledger = createLedger(path.join(dir, 'tasks'));
  const events = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, STATE), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: path.join(dir, 'home'), mcName: async () => 'coordinator',
    git, isPrivateRepo, prInfo: async () => null, now: clock || (() => t),
    recordEvent: async (k, text) => { events.push(`${k}: ${text}`); }, ...(mode === undefined ? {} : { receiptChain: mode }),
  });
  const check = (command = CMD) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const approve = async (id, gate) => { const r = await ledger.update(id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true, now: t }); await svc.afterDecision(r.task, gate); };
  return { svc, ledger, check, approve, events };
}
async function fresh(opts) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chain test-'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  // a home whose settings name the hook, so the card's own status is ok and what the tests read is the chain's
  await mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
  await writeFile(path.join(dir, 'home', '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: '/x/scripts/gate-hook.sh' }] }] } }));
  const b = boot(dir, opts);
  const task = await b.ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await b.ledger.update(task.id, { op: 'start', actor: 'builder' });
  return { dir, id: task.id, ...b };
}
const chainFile = (dir) => path.join(dir, STATE, 'receipts.jsonl');
const lines = async (dir) => (await readFile(chainFile(dir), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
const taskFile = (dir, id) => path.join(dir, 'tasks', `${id}.json`);
// A7 from the design: an approval made by hand, around the board. Two file writes: the task record
// and the grant. (The fixture writes what an agent with file tools could write.)
async function forgeApproval(dir, id, gate = 'g1', t = T0) {
  const task = JSON.parse(await readFile(taskFile(dir, id), 'utf8'));
  const g = task.gates.find((x) => x.id === gate);
  Object.assign(g, { status: 'approved', decision: 'approve', decided_by: OWNER.id, decided_at: new Date(t).toISOString(), via: 'board', expires_at: new Date(t + 3600e3).toISOString() });
  await writeFile(taskFile(dir, id), JSON.stringify(task, null, 2));
  await writeFile(path.join(dir, STATE, 'grants.json'), JSON.stringify([{ id: 'f'.repeat(32), task: id, gate, agent: g.agent, cmdHash: g.cmdHash, expires_at: g.expires_at, used_at: null }]));
  return g;
}

test('chainMode: absent = on; a string or { mode }; anything else = on', () => {
  assert.equal(chainMode(undefined), 'on'); assert.equal(chainMode(null), 'on'); assert.equal(chainMode('off'), 'off');
  assert.equal(chainMode('observe'), 'observe'); assert.equal(chainMode({ mode: 'off' }), 'off'); assert.equal(chainMode('nonsense'), 'on');
});

test('every gate change is one chained line: requested, approved, released', async () => {
  const s = await fresh();
  assert.equal((await s.check()).decision, 'deny');
  await s.approve(s.id, 'g1');
  assert.equal((await s.check()).decision, 'allow');
  const ls = await lines(s.dir);
  assert.deepEqual(ls.map((l) => [l.seq, l.task, l.gate, l.event]), [[1, null, null, 'started'], [2, s.id, 'g1', 'requested'], [3, s.id, 'g1', 'approved'], [4, s.id, 'g1', 'released']]);
  assert.equal(ls[0].prev, GENESIS);
  const raw = (await readFile(chainFile(s.dir), 'utf8')).trim().split('\n');
  assert.equal(ls[1].prev, sha(raw[0])); assert.equal(ls[2].prev, sha(raw[1]));
  const t = await s.ledger.get(s.id);
  assert.equal(ls[3].digest, gateDigest(s.id, t.gates[0]));
  for (const l of ls) assert.deepEqual(Object.keys(l).sort(), ['at', 'digest', 'event', 'gate', 'prev', 'seq', 'status', 'task']);
  const v = await s.svc.verifyChain();
  assert.equal(v.ok, true); assert.equal(v.lines, 4); assert.equal(v.head.hash, sha(raw[3]));
  const card = await s.svc.card(await s.ledger.list({ status: 'live' }));
  assert.equal(card.status, 'ok', card.detail); assert.match(card.detail, /receipts: 4 chained/);
  assert.equal((await s.svc.verifyChain(s.id)).ok, true);
  // an attempt at a waiting gate changes no decision field: no line
  await s.check('gh pr merge 8'); await s.check('gh pr merge 8');
  assert.equal((await lines(s.dir)).length, 5);
  // a decline and an auto-approval under a program go get their names too
  await s.ledger.update(s.id, { op: 'gate_decide', actor: OWNER.id, gate: 'g2', decision: 'decline' }, { decider: true });
  assert.equal((await lines(s.dir)).at(-1).event, 'declined');
  assert.equal(eventOf({ status: 'approved', via: 'standing' }, null), 'auto-approved');
  assert.equal(eventOf({ status: 'expired' }, 'approved'), 'expired');
});

test('an edited gates[] entry fails verify, on the running board and after a restart', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1'); await s.check();
  const task = JSON.parse(await readFile(taskFile(s.dir, s.id), 'utf8'));
  task.gates[0].decided_at = '2026-01-05T09:00:00.000Z';                // a receipt edited by hand
  await writeFile(taskFile(s.dir, s.id), JSON.stringify(task, null, 2));
  const again = boot(s.dir);                                            // the edit is on disk: a restart reads it
  const v = await again.svc.verifyChain(s.id);
  assert.equal(v.ok, false);
  assert.match(v.problems[0].why, /differs from the chain's last line for it \(released\)/);
  assert.equal(v.problems[0].gate, 'g1');
  const card = await again.svc.card(await again.ledger.list());
  assert.equal(card.status, 'failed'); assert.match(card.detail, /1 difference\(s\) between the chain and the ledger/);
});

test('a truncated or edited chain fails verify', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1'); await s.check();
  const raw = (await readFile(chainFile(s.dir), 'utf8')).trim().split('\n');
  // truncated under a running board: the file ends before the head this board holds
  await writeFile(chainFile(s.dir), raw.slice(0, 3).join('\n') + '\n');
  let v = await s.svc.verifyChain();
  assert.equal(v.ok, false); assert.match(v.problems.map((p) => p.why).join(' | '), /the file ends at line 3; this board recorded 4 \(truncated\)/);
  // truncated, then a restart: the task says released, the chain's last line for it says approved
  v = await boot(s.dir).svc.verifyChain();
  assert.equal(v.ok, false); assert.match(v.problems[0].why, /differs from the chain's last line for it \(approved\)/);
  // a line edited in place: the next line no longer follows it
  const edited = [raw[0], raw[1], raw[2].replace('"approved"', '"declined"'), raw[3]];
  await writeFile(chainFile(s.dir), edited.join('\n') + '\n');
  v = await boot(s.dir).svc.verifyChain();
  assert.equal(v.ok, false); assert.ok(v.problems.some((p) => /does not follow the line before it/.test(p.why) && p.seq === 4));
  // a line removed from the middle
  assert.ok(readChain([raw[0], raw[1], raw[3]].join('\n')).breaks.length >= 2);
  // the file removed
  await rm(chainFile(s.dir));
  v = await s.svc.verifyChain();
  assert.equal(v.ok, false); assert.ok(v.problems.some((p) => /missing/.test(p.why)));
});

test('a restart continues the chain, and an approval given before the restart still runs once', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1');
  const b = boot(s.dir, { t: T0 + 60e3 });
  assert.equal((await b.check()).decision, 'allow');
  assert.equal((await b.check()).decision, 'deny', 'once');
  const ls = await lines(s.dir);
  assert.deepEqual(ls.map((l) => l.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(ls.map((l) => l.event), ['started', 'requested', 'approved', 'released', 'requested']);
  assert.equal((await b.svc.verifyChain()).ok, true);
  assert.equal(readChain(await readFile(chainFile(s.dir), 'utf8')).breaks.length, 0);
});

test('an approval written by hand (task record + grant) does not run: refused, the gate is disputed, the card is red', async () => {
  const s = await fresh();
  assert.equal((await s.check()).gate, 'g1');
  await forgeApproval(s.dir, s.id);
  // the running board holds no approval for g1 in memory. Its ledger cache still says pending, as the live board's would.
  let r = await s.check();
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /is not in the board's receipt chain/);
  assert.ok(s.events.some((e) => /^bad: guardrails: DISPUTED gate g1/.test(e)));
  // after a restart the forged record is what the ledger reads; the chain still has no approval
  const s2 = await fresh();
  await s2.check();
  await forgeApproval(s2.dir, s2.id);
  const b = boot(s2.dir, { t: T0 + 60e3 });
  r = await b.check();
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /receipt chain/);
  const t = await b.ledger.get(s2.id);
  assert.equal(t.gates[0].status, 'disputed');
  assert.ok(t.comments.some((c) => /GATE g1 DISPUTED/.test(c.text)));
  const card = await b.svc.card(await b.ledger.list({ status: 'live' }));
  assert.equal(card.status, 'failed'); assert.match(card.detail, /DISPUTED #\d+ g1/);
  assert.equal((await lines(s2.dir)).at(-1).event, 'disputed');
  // the agent asks afresh: a new gate, and the owner's real approval of it runs
  r = await b.check();
  assert.equal(r.decision, 'deny'); assert.equal(r.gate, 'g2');
  await b.approve(s2.id, 'g2');
  assert.equal((await b.check()).decision, 'allow');
});

test('a third write, an approval line added to the chain file by hand, is not in the running board\'s memory', async () => {
  const s = await fresh();
  await s.check();
  const g = await forgeApproval(s.dir, s.id);
  const raw = (await readFile(chainFile(s.dir), 'utf8')).trim().split('\n');
  const forged = { seq: 3, at: new Date(T0).toISOString(), task: s.id, gate: 'g1', event: 'approved', status: 'approved', digest: gateDigest(s.id, g), prev: sha(raw[1]) };
  await appendFile(chainFile(s.dir), JSON.stringify(forged) + '\n');     // hashes line up
  const r = await s.check();
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /receipt chain/);
  const v = await s.svc.verifyChain();
  assert.equal(v.ok, false); assert.ok(v.problems.some((p) => /changed outside the board|does not follow/.test(p.why)));
});

test('modes: off = no file and today\'s answer; observe = lines and a would-dispute reading, the call passes; on = refused', async () => {
  // off
  const off = await fresh({ mode: 'off' });
  await off.check();
  await forgeApproval(off.dir, off.id);
  assert.equal((await boot(off.dir, { mode: 'off', t: T0 + 60e3 }).check()).decision, 'allow', 'as before 1.3');
  assert.ok(!existsSync(chainFile(off.dir)));
  const offBoard = boot(off.dir, { mode: 'off' });
  assert.equal((await offBoard.svc.verifyChain()).off, true);
  assert.doesNotMatch((await offBoard.svc.card([])).detail, /receipts/);
  // observe
  const ob = await fresh({ mode: 'observe' });
  await ob.check();
  await forgeApproval(ob.dir, ob.id);
  const b = boot(ob.dir, { mode: 'observe', t: T0 + 60e3 });
  assert.equal((await b.check()).decision, 'allow');
  assert.ok(b.events.some((e) => /^sys: guardrails \(observe\): would dispute gate g1/.test(e)));
  assert.ok(existsSync(chainFile(ob.dir)));
  assert.match((await b.svc.card([])).detail, /receipts: .*differen|receipts: \d+ chained \(observe\)/);
  // on (the default)
  const on = await fresh();
  await on.check();
  await forgeApproval(on.dir, on.id);
  assert.equal((await boot(on.dir, { t: T0 + 60e3 }).check()).decision, 'deny');
});

test('a failed append never fails a gate event: the call still runs, the card is amber, the lines land later', async () => {
  const s = await fresh();
  assert.equal((await s.check()).decision, 'deny');                       // the chain exists: started, g1 requested
  await chmod(chainFile(s.dir), 0o400);                                   // the file cannot be appended to
  await s.approve(s.id, 'g1');
  assert.equal((await s.check()).decision, 'allow', 'the approval the board recorded in memory still counts');
  const card = await s.svc.card(await s.ledger.list());
  assert.equal(card.status, 'warn', card.detail); assert.match(card.detail, /receipts: 2 line\(s\) not on disk/);
  assert.equal(s.svc.chain.status().unwritten, 2);
  assert.equal((await s.svc.verifyChain()).ok, true, 'held lines are expected to be missing from the file');
  await chmod(chainFile(s.dir), 0o600);
  await s.check('gh pr merge 9');                                        // the next gate change writes everything held
  assert.deepEqual((await lines(s.dir)).map((l) => l.seq), [1, 2, 3, 4, 5]);
  assert.equal(s.svc.chain.status().error, null);
  assert.equal((await s.svc.verifyChain()).ok, true);
});

test('first start with gates already on the ledger: an approval in flight is adopted, settled gates are before the chain', async () => {
  // real time here: the ledger stamps gates with the wall clock, and "older than the chain" compares the two
  const real = Date.now();
  const s = await fresh({ mode: 'off', t: real });                       // the board before the chain existed
  await s.check(); await s.approve(s.id, 'g1'); await s.check();         // g1 released
  await s.check('gh pr merge 8'); await s.approve(s.id, 'g2');           // g2 approved, not yet run
  await s.check('gh pr merge 9');                                        // g3 waiting
  const b = boot(s.dir, { t: Date.now() + 1000 });                       // the upgrade
  assert.equal((await b.check('gh pr merge 8')).decision, 'allow');
  const ls = await lines(s.dir);
  assert.deepEqual(ls.map((l) => [l.gate, l.event]), [[null, 'started'], ['g2', 'approved'], ['g2', 'released'], ['g3', 'requested']]);
  assert.equal(ls[1].note, 'adopted at chain start');
  assert.equal((await b.svc.verifyChain()).ok, true, 'g1 is older than the chain and is not expected in it');
});

test('the chain module alone: record is idempotent, approvalFor follows approve then release', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chain unit-'));
  const c = createReceiptChain({ file: path.join(dir, 'r.jsonl'), now: () => T0 });
  await c.load([]);
  const g = { id: 'g1', cls: 'merge', cmdHash: 'h', agent: 'builder', requested_at: '2026-01-05T10:00:00.000Z', status: 'pending' };
  assert.equal((await c.record({ id: 4, gates: [g] })).length, 1);
  assert.equal((await c.record({ id: 4, gates: [{ ...g, attempts: 9, note: 'x' }] })).length, 0, 'counters and notes are not decision fields');
  assert.equal(c.approvalFor(4, 'g1'), false);
  await c.record({ id: 4, gates: [{ ...g, status: 'approved', decision: 'approve' }] }, { op: 'gate_decide', gate: 'g1', decider: true });
  assert.equal(c.approvalFor(4, 'g1'), true); assert.equal(c.approvalFor(5, 'g1'), false);
  await c.record({ id: 4, gates: [{ ...g, status: 'executed', decision: 'approve', executed_at: 'x' }] });
  assert.equal(c.approvalFor(4, 'g1'), false, 'a released approval is spent');
  assert.equal(c.head().seq, 4);
  assert.deepEqual(await createReceiptChain({ file: path.join(dir, 'none.jsonl'), mode: 'off' }).record({ id: 1, gates: [g] }), []);
});

test('the ledger: concurrent first reads share one load (a create never reuses an id that is on disk)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ledger load-'));
  const a = createLedger(dir);
  const first = await a.create({ title: 'the first task', requester: 'helper', owner: 'builder' });
  const b = createLedger(dir);                                           // a restart
  const [list, made, got] = await Promise.all([b.list(), b.create({ title: 'another', requester: 'helper', owner: 'builder' }), b.get(first.id)]);
  assert.equal(list.length >= 1, true); assert.equal(got.title, 'the first task');
  assert.equal(made.id, first.id + 1);
  assert.equal(JSON.parse(await readFile(path.join(dir, `${first.id}.json`), 'utf8')).title, 'the first task');
  // subscribers hear every write, after it is on disk, and can never fail it
  const heard = [];
  b.subscribe(async (t) => { heard.push(JSON.parse(await readFile(path.join(dir, `${t.id}.json`), 'utf8')).status); });
  b.subscribe(() => { throw new Error('a broken subscriber'); });
  const r = await b.update(first.id, { op: 'start', actor: 'builder' });
  assert.equal(r.task.status, 'in_progress'); assert.deepEqual(heard, ['in_progress']);
});

test('wiring: the board passes the setting, the audit endpoint and CLI take the verify form', async () => {
  const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
  const [server, cli] = await Promise.all([read('server.mjs'), read('scripts/mesh-cli.mjs')]);
  assert.match(server, /receiptChain: SETTINGS\.receiptChain/);
  assert.match(server, /url\.searchParams\.has\('verify'\)\) return sendJson\(res, 200, \{ task: Number\(am\[1\]\), rows, verify: await gates\.verifyChain\(am\[1\]\) \}\)/);
  assert.match(cli, /audit\$\{flags\.verify \? '\?verify=1' : ''\}/);
  assert.match(cli, /RECEIPTS DO NOT VERIFY/);
});

// ── PR 106 review: the first start on a board that already has history ───────────────────────────
const origin = (cwd, args) => (args[0] === 'remote' ? 'git@github.com:acme/app.git' : null);
const grantOnly = async (dir, id, gate) => {                                // one hand-made grant, no edit of the task record
  const g = JSON.parse(await readFile(taskFile(dir, id), 'utf8')).gates.find((x) => x.id === gate);
  await writeFile(path.join(dir, STATE, 'grants.json'), JSON.stringify([{ id: 'e'.repeat(32), task: id, gate, agent: g.agent, cmdHash: g.cmdHash, expires_at: new Date(Date.now() + 3600e3).toISOString(), used_at: null }]));
};

test('P3: an old standing run found at the first start is never a waiting approval', async () => {
  const real = Date.now();
  const s = await fresh({ mode: 'off', t: real, git: origin, isPrivateRepo: async () => true });   // before the chain
  await s.ledger.update(s.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: ship it', kind: 'program' });
  await s.ledger.update(s.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  const ran = await s.check();
  assert.equal(ran.decision, 'allow'); assert.match(ran.reason, /auto-approved under program go/);
  await s.ledger.update(s.id, { op: 'revoke_go', actor: OWNER.id }, { decider: true });
  const b = boot(s.dir, { t: Date.now() + 1000 });                         // the upgrade: nothing to adopt
  const first = await b.check('gh pr merge 8');
  assert.equal(first.decision, 'deny'); assert.equal(first.gate, 'g2');
  assert.deepEqual((await lines(s.dir)).map((l) => [l.gate, l.event, l.status]), [[null, 'started', null], ['g2', 'requested', 'pending']], 'the old run is before the chain: no line');
  assert.equal(b.svc.chain.approvalFor(s.id, 'g1'), false);
  assert.equal((await b.svc.verifyChain()).ok, true);
  // the forgery the slice exists to stop: task record + grant + restart
  await forgeApproval(s.dir, s.id, 'g1', Date.now());
  const c = boot(s.dir, { t: Date.now() + 2000 });
  const r = await c.check();
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /receipt chain/);
  // even a line that names an old run "auto-approved" with status executed (a chain written before this fix) is no approval
  const unit = createReceiptChain({ file: path.join(s.dir, 'unit.jsonl'), now: () => T0 });
  await unit.load([]);
  await unit.record({ id: 9, gates: [{ id: 'g1', cls: 'merge', cmdHash: 'h', agent: 'builder', requested_at: '2099-01-01T00:00:00.000Z', status: 'executed', via: 'standing', decision: 'approve' }] });
  assert.equal(unit.approvalFor(9, 'g1'), false);
  assert.equal(eventOf({ status: 'executed', via: 'standing' }, null), 'executed', 'first seen settled: named by its status');
  assert.equal(eventOf({ status: 'approved', via: 'standing' }, null), 'auto-approved');
});

test('P3b: an old run the owner approved by hand, found at the first start, is no waiting approval either', async () => {
  const real = Date.now();
  const s = await fresh({ mode: 'off', t: real });
  await s.check(); await s.approve(s.id, 'g1'); assert.equal((await s.check()).decision, 'allow');
  const b = boot(s.dir, { t: Date.now() + 1000 });
  assert.equal((await b.check('gh pr merge 8')).gate, 'g2');
  assert.equal(b.svc.chain.approvalFor(s.id, 'g1'), false);
  await forgeApproval(s.dir, s.id, 'g1', Date.now());
  assert.equal((await boot(s.dir, { t: Date.now() + 2000 }).check()).decision, 'deny');
});

test('P7: an approval that ran out before the chain began is not adopted', async () => {
  const real = Date.now();
  const s = await fresh({ mode: 'off', t: real - 3 * 3600e3 });            // approved three hours ago, 120 minutes to live
  await s.check(); await s.approve(s.id, 'g1');
  assert.equal((await s.ledger.get(s.id)).gates[0].status, 'approved', 'the ledger still says approved');
  const b = boot(s.dir, { t: Date.now() });
  await b.check('gh pr merge 8');
  assert.deepEqual((await lines(s.dir)).map((l) => [l.gate, l.event]), [[null, 'started'], ['g2', 'requested']]);
  assert.equal(b.svc.chain.approvalFor(s.id, 'g1'), false);
  // an old gate that was still WAITING at the start and is approved now is a real decision: it runs
  await b.approve(s.id, 'g2');
  assert.equal((await b.check('gh pr merge 8')).decision, 'allow');
  await grantOnly(s.dir, s.id, 'g1');                                      // one hand-made grant, same board, no restart
  const r = await b.check();
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /receipt chain/);
});

test('P4: a chain file that exists and cannot be read is not a first start', async () => {
  const s = await fresh({ mode: 'off' });
  await s.check(); await s.approve(s.id, 'g1');                            // an approval in flight, which a first start would adopt
  await mkdir(chainFile(s.dir), { recursive: true });                      // the file's place cannot be read as a file
  const b = boot(s.dir, { t: T0 + 60e3 });
  const r = await b.check();
  assert.equal(r.decision, 'deny', 'no approval is vouched for'); assert.match(r.reason, /receipt chain/);
  const st = b.svc.chain.status();
  assert.match(st.unreadable, /EISDIR/); assert.equal(st.lines, 0, 'no new sequence'); assert.equal(st.unwritten, 0, 'nothing held to append later');
  const v = await b.svc.verifyChain();
  assert.equal(v.ok, false); assert.match(v.problems[0].why, /cannot read the chain file/);
  const card = await b.svc.card(await b.ledger.list({ status: 'live' }));
  assert.equal(card.status, 'failed'); assert.match(card.detail, /receipts: cannot read the chain/);
  // observe: the same state only reports
  const o = await fresh({ mode: 'off' });
  await o.check(); await o.approve(o.id, 'g1');
  await mkdir(chainFile(o.dir), { recursive: true });
  const ob = boot(o.dir, { mode: 'observe', t: T0 + 60e3 });
  assert.equal((await ob.check()).decision, 'allow');
  assert.ok(ob.events.some((e) => /would dispute/.test(e)));
});

test('a gate from before the chain: a decision taken after the start is recorded, an older one is not', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chain old-'));
  const start = Date.parse('2026-03-01T00:00:00Z');
  const c = createReceiptChain({ file: path.join(dir, 'r.jsonl'), now: () => start });
  await c.load([]);
  const old = { cls: 'merge', cmdHash: 'h', agent: 'builder', requested_at: '2026-02-28T10:00:00.000Z', decision: 'approve' };
  const gates = [
    { ...old, id: 'g1', status: 'approved', decided_at: '2026-02-28T11:00:00.000Z' },      // ran out unused before the chain
    { ...old, id: 'g2', status: 'pending', decision: null },                               // waiting at the start
    { ...old, id: 'g3', status: 'executed', decided_at: '2026-02-28T11:00:00.000Z' },
    { ...old, id: 'g4', status: 'pending', decision: null },
  ];
  await c.record({ id: 1, gates }, { op: 'comment', gate: null });
  gates[1] = { ...old, id: 'g2', status: 'approved', decided_at: '2026-03-01T00:05:00.000Z' };   // the owner approves it now
  await c.record({ id: 1, gates }, { op: 'gate_decide', gate: 'g2', decider: true });
  assert.deepEqual([1, 2, 3, 4].map((n) => c.approvalFor(1, `g${n}`)), [false, true, false, false]);
  const text = await readFile(path.join(dir, 'r.jsonl'), 'utf8');
  assert.deepEqual(readChain(text).lines.map((l) => [l.gate, l.event]), [[null, 'started'], ['g2', 'requested'], ['g4', 'requested'], ['g2', 'approved']]);
});

// ── PR 106 re-read, finding 4: an ordinary ledger write must never turn a hand-edited record into an approval ──
const comment = (b, id) => b.ledger.update(id, { op: 'comment', actor: 'builder', text: 'still working on it' });

test('C0 (control): a real approval, a restart, a comment, then the call: it runs', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1');
  const b = boot(s.dir, { t: T0 + 60e3 });
  await comment(b, s.id);
  assert.equal((await b.check()).decision, 'allow');
  assert.equal((await b.svc.verifyChain()).ok, true);
});

test('P8r: hand edit to approved + a grant, restart, one comment by the agent, the call: denied, and the record is flagged', async () => {
  const s = await fresh();
  await s.check();
  await forgeApproval(s.dir, s.id);
  const b = boot(s.dir, { t: T0 + 60e3 });
  await comment(b, s.id);
  const ls = await lines(s.dir);
  assert.deepEqual(ls.map((l) => [l.gate, l.event]), [[null, 'started'], ['g1', 'requested'], ['g1', OUTSIDE]], 'the board does not write an approval for a comment');
  assert.equal(b.svc.chain.approvalFor(s.id, 'g1'), false);
  const card = await b.svc.card(await b.ledger.list({ status: 'live' }));
  assert.equal(card.status, 'failed', card.detail); assert.match(card.detail, /read approved without a decision by this board/);
  const v = await b.svc.verifyChain(s.id);
  assert.equal(v.ok, false); assert.match(v.problems[0].why, /without a decision by this board/);
  const r = await b.check();
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /receipt chain/);
  // a later write does not absorb the difference, and neither does a restart
  await comment(b, s.id);
  const c = boot(s.dir, { t: T0 + 120e3 });
  await comment(c, s.id);
  assert.equal(c.svc.chain.approvalFor(s.id, 'g1'), false);
  assert.ok(c.svc.chain.flagged().some((f) => f.task === s.id && f.gate === 'g1'));
});

test('P8g: the same hand edit, restart, another held call that files a second gate, then the first call: denied', async () => {
  const s = await fresh();
  await s.check();
  await forgeApproval(s.dir, s.id);
  const b = boot(s.dir, { t: T0 + 60e3 });
  assert.equal((await b.check('gh pr merge 8')).gate, 'g2');              // a gate-system write, but a decision on g2 only
  assert.deepEqual((await lines(s.dir)).filter((l) => l.gate === 'g1').map((l) => l.event), ['requested', OUTSIDE]);
  assert.equal((await b.check()).decision, 'deny');
});

test('P10: a gate that ran before the chain, edited to approved with a decision time after the start, a comment, the call: denied', async () => {
  const real = Date.now();
  const s = await fresh({ mode: 'off', t: real });
  await s.check(); await s.approve(s.id, 'g1'); assert.equal((await s.check()).decision, 'allow');   // g1 ran before the chain
  const first = boot(s.dir, { t: Date.now() + 1000 });
  await comment(first, s.id);                                             // the chain starts; g1 is before it
  await forgeApproval(s.dir, s.id, 'g1', Date.now() + 5000);              // decided "after the start"
  const b = boot(s.dir, { t: Date.now() + 10000 });
  await comment(b, s.id);
  assert.deepEqual((await lines(s.dir)).map((l) => [l.gate, l.event]), [[null, 'started'], ['g1', OUTSIDE]]);
  assert.equal((await b.check()).decision, 'deny');
});

test('P8o: the same in observe: the call runs and a "would dispute" line is written', async () => {
  const s = await fresh({ mode: 'observe' });
  await s.check();
  await forgeApproval(s.dir, s.id);
  const b = boot(s.dir, { mode: 'observe', t: T0 + 60e3 });
  await comment(b, s.id);
  assert.equal((await b.check()).decision, 'allow');
  assert.ok(b.events.some((e) => /would dispute gate g1/.test(e)));
});

test('a recorded pane answer under "direct" and a standing run are decisions; the ledger says which write it was', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ledger write-'));
  const ledger = createLedger(dir);
  const seen = [];
  ledger.subscribe((t, w) => { seen.push(w); });
  const t = await ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await ledger.update(t.id, { op: 'start', actor: 'builder' });
  await ledger.update(t.id, { op: 'gate_request', actor: 'board', gate: { cls: 'merge', label: 'Merge', command: 'gh pr merge 1', cwd: '/w', tool: 'Bash', agent: 'builder', cmdHash: 'h1' } }, { gateSystem: true });
  await ledger.update(t.id, { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' }, { decider: true });
  assert.deepEqual(seen, [
    { op: 'start', gate: null, decider: false, gateSystem: false },
    { op: 'gate_request', gate: 'g1', decider: false, gateSystem: true },
    { op: 'gate_decide', gate: 'g1', decider: true, gateSystem: false },
  ]);
});
