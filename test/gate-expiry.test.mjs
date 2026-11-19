// An approval the agent never used does not stay approved (#498).
//
// Before: a gate the owner approved and nobody ran kept status `approved` after its time. Nothing looked
// at it again unless the same call came back, and the check that releases a call read only the grant's own
// time. So one hand-made grant that named such a gate let a held call run, with no edit of the task record.
// Now the board marks a run-out approval expired (at start and in the poll, on live and closed tasks), and
// a grant is released only while the ledger itself says the approval stands.
// Temp dirs only; the "board" is the gate service, and the fixture writes what a process with file tools could.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/tasks.mjs';
import { createGateService, RAN_OUT_NOTE, LATE_GRANT_NOTE } from '../src/gate-service.mjs';
import { runOut, auditRows } from '../src/gate-ledger.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { OWNER } from '../src/config.mjs';

const T0 = Date.parse('2026-01-05T10:00:00Z');
const HOUR = 3600e3;
const CMD = 'gh pr merge 7 --merge';
const STATE = 'guardrails';

async function fresh({ mode } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'expiry test-'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  await mkdir(path.join(dir, 'home', '.claude'), { recursive: true });
  await writeFile(path.join(dir, 'home', '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: '/x/scripts/gate-hook.sh' }] }] } }));
  const clock = { t: T0 };
  const ledger = createLedger(path.join(dir, 'tasks'));
  const events = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, STATE), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: path.join(dir, 'home'), mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, now: () => clock.t,
    recordEvent: async (k, text) => { events.push(`${k}: ${text}`); }, ...(mode === undefined ? {} : { receiptChain: mode }),
  });
  const check = (command = CMD) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const approve = async (id, gate) => { const r = await ledger.update(id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true, now: clock.t }); await svc.afterDecision(r.task, gate); };
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const gate = async (id, g) => (await ledger.get(id)).gates.find((x) => x.id === g);
  return { dir, id: task.id, svc, ledger, check, approve, events, clock, gate };
}
/** One grant written by hand: it names an existing gate and gives itself an hour from `at`. */
async function handMadeGrant(s, id, gateId, at) {
  const g = await s.gate(id, gateId);
  await writeFile(path.join(s.dir, STATE, 'grants.json'), JSON.stringify([{ id: 'f'.repeat(32), task: id, gate: gateId, agent: g.agent, cmdHash: g.cmdHash, expires_at: new Date(at + HOUR).toISOString(), used_at: null }]));
}

test('runOut: an approval whose time is not ahead; nothing else', () => {
  const at = (ms) => new Date(ms).toISOString();
  assert.equal(runOut({ status: 'approved', expires_at: at(T0 - 1) }, T0), true);
  assert.equal(runOut({ status: 'approved', expires_at: at(T0) }, T0), true);
  assert.equal(runOut({ status: 'approved', expires_at: at(T0 + 1) }, T0), false);
  assert.equal(runOut({ status: 'approved', expires_at: null }, T0), true, 'no time on record: the board never writes one');
  assert.equal(runOut({ status: 'approved', expires_at: 'soon' }, T0), true);
  for (const status of ['pending', 'expired', 'executed', 'declined', 'disputed']) assert.equal(runOut({ status, expires_at: at(T0 - 1) }, T0), false);
  assert.equal(runOut(null, T0), false);
});

test('the sweep marks an approval that ran out unused as expired, once, and leaves one still in time alone', async () => {
  const s = await fresh();
  assert.equal((await s.check()).decision, 'deny');
  await s.approve(s.id, 'g1');
  const until = Date.parse((await s.gate(s.id, 'g1')).expires_at);
  assert.ok(until > T0);
  // still in time: nothing to do
  assert.deepEqual(await s.svc.expireRunOut(), { checked: 1, expired: [] });
  assert.equal((await s.gate(s.id, 'g1')).status, 'approved');
  // a second approval, made later, is still in time when the first runs out
  s.clock.t = until - 60e3;
  assert.equal((await s.check('gh pr merge 8 --merge')).decision, 'deny');
  await s.approve(s.id, 'g2');
  s.clock.t = until + 1000;
  const r = await s.svc.expireRunOut();
  assert.deepEqual(r, { checked: 2, expired: [`#${s.id} g1`] });
  const g1 = await s.gate(s.id, 'g1');
  assert.equal(g1.status, 'expired'); assert.equal(g1.note, RAN_OUT_NOTE);
  assert.equal((await s.gate(s.id, 'g2')).status, 'approved');
  const t = await s.ledger.get(s.id);
  assert.ok(t.comments.some((c) => c.text === `GATE g1 expired unused (${RAN_OUT_NOTE})`), 'the ledger says so in its own words');
  const row = auditRows(t).find((x) => x.gate === 'g1' && x.event === 'expired');
  assert.equal(row.at, g1.expires_at); assert.equal(row.via, RAN_OUT_NOTE);
  assert.equal(s.events.filter((e) => /ran out unused, now marked expired/.test(e)).length, 1);
  assert.match(s.events.find((e) => /ran out unused/.test(e)), new RegExp(`^sys: guardrails: 1 approval\\(s\\) ran out unused, now marked expired \\(#${s.id} g1\\)$`));
  // the chain has the line, holds no approval for it any more, and still agrees with the ledger
  assert.equal(s.svc.chain.approvalFor(s.id, 'g1'), false);
  assert.equal(s.svc.chain.approvalFor(s.id, 'g2'), true);
  assert.equal((await s.svc.verifyChain()).ok, true);
  // again: nothing left, and no second ticker line
  assert.deepEqual(await s.svc.expireRunOut(), { checked: 1, expired: [] });
  assert.equal(s.events.filter((e) => /ran out unused/.test(e)).length, 1);
  // the same call coming back is asked again, and the row says it was approved before
  const again = await s.check();
  assert.equal(again.decision, 'deny');
  assert.equal((await s.gate(s.id, again.gate)).previously.gate, 'g1');
});

test('the sweep reaches a closed task; a closed task takes no other gate event', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1');
  await s.ledger.update(s.id, { op: 'cancel', actor: 'helper' });
  assert.equal((await s.ledger.get(s.id)).status, 'cancelled');
  await assert.rejects(s.ledger.update(s.id, { op: 'gate_event', actor: 'board', gate: 'g1', event: 'executed' }, { gateSystem: true }), /is cancelled/);
  await assert.rejects(s.ledger.update(s.id, { op: 'gate_event', actor: 'board', gate: 'g1', event: 'attempt' }, { gateSystem: true }), /is cancelled/);
  // not the gate service: refused as before, closed or not
  await assert.rejects(s.ledger.update(s.id, { op: 'gate_event', actor: 'builder', gate: 'g1', event: 'expired' }), /gate service only/);
  s.clock.t = Date.parse((await s.gate(s.id, 'g1')).expires_at) + 1;
  assert.deepEqual((await s.svc.expireRunOut()).expired, [`#${s.id} g1`]);
  const t = await s.ledger.get(s.id);
  assert.equal(t.status, 'cancelled', 'the task stays closed');
  assert.equal(t.gates[0].status, 'expired');
  // an approval that already reads expired cannot be expired again
  await assert.rejects(s.ledger.update(s.id, { op: 'gate_event', actor: 'board', gate: 'g1', event: 'expired' }, { gateSystem: true }), /gate g1 is expired/);
});

for (const mode of ['on', 'off']) {
  test(`a hand-made grant for an approval that ran out lets nothing run (receipt chain ${mode})`, async () => {
    const s = await fresh({ mode });
    await s.check(); await s.approve(s.id, 'g1');
    const until = Date.parse((await s.gate(s.id, 'g1')).expires_at);
    s.clock.t = until + HOUR;                       // long over, and no sweep has run: the ledger still reads approved
    assert.equal((await s.gate(s.id, 'g1')).status, 'approved');
    if (mode === 'on') assert.equal(s.svc.chain.approvalFor(s.id, 'g1'), true, 'the chain alone would vouch for it');
    await handMadeGrant(s, s.id, 'g1', s.clock.t);
    const r = await s.check();
    assert.equal(r.decision, 'deny', JSON.stringify(r));
    const g1 = await s.gate(s.id, 'g1');
    assert.equal(g1.status, 'expired'); assert.equal(g1.note, LATE_GRANT_NOTE);
    assert.equal(g1.executed_at, null);
    assert.ok(s.events.some((e) => new RegExp(`^bad: guardrails: REFUSED gate g1 on #${s.id}: a grant was presented by builder, and its approval ran out at `).test(e)), s.events.join('\n'));
    // the call is asked again as a new gate, and the grant is spent: a second try is the waiting gate, not a run
    const g2 = await s.gate(s.id, r.gate);
    assert.equal(g2.id, 'g2'); assert.equal(g2.status, 'pending'); assert.equal(g2.previously.gate, 'g1');
    assert.equal((await s.check()).decision, 'deny');
    assert.equal(JSON.parse(await readFile(path.join(s.dir, STATE, 'grants.json'), 'utf8')).filter((x) => !x.used_at).length, 0);
    if (mode === 'on') assert.equal((await s.svc.verifyChain()).ok, true);
  });
}

test('after the sweep the same hand-made grant is refused too (the chain no longer holds the approval)', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1');
  s.clock.t = Date.parse((await s.gate(s.id, 'g1')).expires_at) + HOUR;
  await s.svc.expireRunOut();
  await handMadeGrant(s, s.id, 'g1', s.clock.t);
  const r = await s.check();
  assert.equal(r.decision, 'deny', JSON.stringify(r));
  assert.equal((await s.gate(s.id, 'g1')).executed_at, null);
});

test('a hand-made grant for a gate that already ran, or was never approved, is refused and not an error (chain off)', async () => {
  const s = await fresh({ mode: 'off' });
  await s.check(); await s.approve(s.id, 'g1');
  assert.equal((await s.check()).decision, 'allow');
  assert.equal((await s.gate(s.id, 'g1')).status, 'executed');
  const ranAt = (await s.gate(s.id, 'g1')).executed_at;
  await handMadeGrant(s, s.id, 'g1', s.clock.t);
  const r = await s.check();
  assert.equal(r.decision, 'deny', JSON.stringify(r));
  assert.ok(s.events.some((e) => /^bad: guardrails: REFUSED gate g1 on #\d+: a grant was presented by builder, and the gate is executed/.test(e)), s.events.join('\n'));
  const g1 = await s.gate(s.id, 'g1');
  assert.equal(g1.status, 'executed'); assert.equal(g1.executed_at, ranAt, 'the receipt of the one real run is untouched');
  // the new gate is waiting; a grant that names it before any decision runs nothing either
  assert.equal((await s.gate(s.id, r.gate)).status, 'pending');
  await handMadeGrant(s, s.id, r.gate, s.clock.t);
  const again = await s.check();
  assert.equal(again.decision, 'deny');
  assert.ok(s.events.some((e) => /a grant was presented by builder, and the gate is pending/.test(e)));
  assert.equal((await s.gate(s.id, r.gate)).status, 'pending');
});

test('an approval used in time runs once, as before', async () => {
  const s = await fresh();
  await s.check(); await s.approve(s.id, 'g1');
  s.clock.t = Date.parse((await s.gate(s.id, 'g1')).expires_at) - 1000;
  await s.svc.expireRunOut();
  const r = await s.check();
  assert.equal(r.decision, 'allow', JSON.stringify(r));
  assert.equal((await s.gate(s.id, 'g1')).status, 'executed');
  assert.equal(s.events.some((e) => /REFUSED|ran out unused/.test(e)), false);
});

test('the board runs the sweep before it listens and at the head of every card pass', async () => {
  const src = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const reconcile = src.indexOf('await gates.reconcile()');
  const atStart = src.indexOf('await gates.expireRunOut()', reconcile);
  const listen = src.indexOf('server.listen(');
  assert.ok(reconcile > 0 && atStart > reconcile, 'after the startup reconcile');
  assert.ok(listen > atStart, 'and before the board listens');
  const card = src.slice(src.indexOf('async function writeGateCard()'));
  assert.ok(card.indexOf('gates.expireRunOut()') > 0 && card.indexOf('gates.expireRunOut()') < card.indexOf('gates.card('), 'in the card pass, before the card is computed');
});
