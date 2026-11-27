// node --test "test/*.test.mjs" — #786 B: an agent withdraws its own pending gate row.
// Adds only: a withdrawal decides, releases and mints nothing. Only a pending row, only by the agent it was
// filed for. A withdrawn row is refused at every later door (decide, pane record, typed approval, release,
// expiry, dispute, redeem) and the chain gives it a line of its own.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { pendingGates, auditRows, gatesResolved, withdrawGate } from '../src/gate-ledger.mjs';
import { createReceiptChain } from '../src/receipt-chain.mjs';
import { attentionItems } from '../src/attention.mjs';
import { windowMetrics, readingText, computeReading } from '../src/operating-reading.mjs';
import { OWNER } from '../src/config.mjs';

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MERGE = `gh pr merge 7 --squash -R acme/app --match-head-commit ${A}`;
const policy = { ...structuredClone(DEFAULT_POLICY), defaultMode: 'enforce', observeFor: [], checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

// a fresh folder per state (never a delete inside one)
async function setup() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'gate-withdraw-')));
  const work = path.join(dir, 'work');
  await mkdir(work, { recursive: true });
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => (ws === 'WS-1' ? 'worker-a' : null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true,
    prInfo: async () => ({ number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: A, repo: 'acme/app' }),
    git: (cwd, args) => (args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : null) });
  await ledger.create({ title: 'Land the thing', requester: 'coordinator', owner: 'worker-a', priority: 'normal' });
  const pre = (command) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: work, workspaceId: 'WS-1' });
  const filed = await pre(MERGE);
  assert.equal(filed.decision, 'deny');
  const task = () => ledger.get(filed.task);
  const gate = async (id = filed.gate) => ((await task())?.gates || []).find((x) => x.id === id);
  const withdraw = (actor, ctx = {}, extra = {}) => ledger.update(filed.task, { op: 'gate_withdraw', actor, gate: filed.gate, reason: 'made the edit with the Edit tool', ...extra }, ctx);
  return { dir, ledger, svc, pre, filed, task, gate, withdraw };
}
const refused = async (p, status, rx) => {
  await assert.rejects(p, (e) => { assert.equal(e.status, status, e.message); if (rx) assert.match(e.message, rx); return true; });
};

test('#786 B the filer withdraws its own pending row: withdrawn, a board comment, no wake, the wait on the owner ends', async () => {
  const s = await setup();
  const before = await s.task();
  assert.equal(before.status, 'needs_approval');
  assert.ok(before.blocked_on.includes(OWNER.id));
  const r = await s.withdraw('worker-a');
  const g = await s.gate();
  assert.equal(g.status, 'withdrawn');
  assert.equal(g.withdrawn_by, 'worker-a');
  assert.equal(g.withdraw_reason, 'made the edit with the Edit tool');
  assert.ok(g.withdrawn_at);
  const t = await s.task();
  assert.notEqual(t.status, 'needs_approval');
  assert.ok(!t.blocked_on.includes(OWNER.id), 'the gate\'s own wait on the owner is settled');
  const last = t.comments[t.comments.length - 1];
  assert.equal(last.who, 'board');
  assert.match(last.text, /withdrawn by worker-a \(not a decision; nothing ran\)/);
  assert.deepEqual(last.gate, { id: g.id, event: 'withdrawn' });
  assert.deepEqual([...(r.wake || [])], [], 'nobody is woken');
  // off every list that shows the owner what waits
  assert.deepEqual(pendingGates(t), []);
  assert.deepEqual(attentionItems([t], { isOwner: (x) => x === OWNER.id }).filter((i) => i.kind === 'gate'), []);
  assert.equal(gatesResolved(t).ok, true);
  const row = auditRows(t).find((x) => x.event.startsWith('withdrawn'));
  assert.equal(row.actor, 'worker-a');
  assert.equal(row.via, 'made the edit with the Edit tool');
});

test('#786 B pending only: an approved, released, declined or expired row cannot be withdrawn', async () => {
  for (const [label, prep] of [
    ['approved', (s) => s.ledger.update(s.filed.task, { op: 'gate_decide', actor: OWNER.id, gate: s.filed.gate, decision: 'approve' }, { decider: true })],
    ['declined', (s) => s.ledger.update(s.filed.task, { op: 'gate_decide', actor: OWNER.id, gate: s.filed.gate, decision: 'decline' }, { decider: true })],
    ['executed', async (s) => { await s.ledger.update(s.filed.task, { op: 'gate_decide', actor: OWNER.id, gate: s.filed.gate, decision: 'approve' }, { decider: true }); await s.ledger.update(s.filed.task, { op: 'gate_event', actor: 'board', gate: s.filed.gate, event: 'executed' }, { gateSystem: true }); }],
    ['expired', async (s) => { await s.ledger.update(s.filed.task, { op: 'gate_decide', actor: OWNER.id, gate: s.filed.gate, decision: 'approve' }, { decider: true }); await s.ledger.update(s.filed.task, { op: 'gate_event', actor: 'board', gate: s.filed.gate, event: 'expired' }, { gateSystem: true }); }],
  ]) {
    const s = await setup();
    await prep(s);
    await refused(s.withdraw('worker-a'), 409, /only a pending row can be withdrawn/);
    assert.notEqual((await s.gate()).status, 'withdrawn', label);
  }
});

test('#786 B only the filer: not another agent, not Mission Control, the owner\'s board, the intake, a headless or unregistered session', async () => {
  const s = await setup();
  await refused(s.withdraw('worker-b'), 403, /only that agent can withdraw it/);
  await refused(s.withdraw('mission-control'), 403, /Mission Control does not withdraw rows/);
  await refused(s.withdraw('coordinator', { mc: true }), 403, /Mission Control does not withdraw rows/);
  await refused(s.withdraw('worker-a', { decider: true }), 403, /not decided/);
  await refused(s.withdraw('worker-a', { intake: true }), 403);
  // a headless or unregistered session: refused by the ledger's own name check before the op runs (400);
  // the op's `registered()` rule stands behind it as a second line (403) should that check ever loosen
  for (const who of ['headless:triage', 'unregistered:abc']) await assert.rejects(s.withdraw(who), (e) => [400, 403].includes(e.status));
  await refused(s.withdraw(OWNER.id), 403);
  await refused(s.withdraw('worker-a', {}, { reason: '   ' }), 400, /needs a reason/);
  assert.equal((await s.gate()).status, 'pending', 'still waiting on the owner after every refusal');
});

test('#786 B a closed task: nothing is withdrawn (the row stays as the close left it)', async () => {
  const s = await setup();
  await s.ledger.update(s.filed.task, { op: 'cancel', actor: 'coordinator', text: 'not needed' }, { mc: true });
  assert.equal((await s.task()).status, 'cancelled');
  await assert.rejects(s.withdraw('worker-a'), /is cancelled|nothing to withdraw/);
  assert.equal((await s.gate()).status, 'pending');
});

test('#786 B a withdrawn row is refused at every later door', async () => {
  const s = await setup();
  await s.withdraw('worker-a');
  const id = s.filed.task; const gate = s.filed.gate;
  // the owner's board: approve or decline
  await refused(s.ledger.update(id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true }), 409, /withdrawn, not pending/);
  await refused(s.ledger.update(id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'decline' }, { decider: true }), 409, /withdrawn, not pending/);
  // an approval typed in a terminal
  await refused(s.ledger.update(id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true, typed: true }), 409, /withdrawn, not pending/);
  // a pane answer Mission Control records (a proposal, or a direct record)
  await refused(s.ledger.update(id, { op: 'gate_record', actor: 'coordinator', gate, decision: 'approve', text: 'yes in the pane' }, { mc: true, paneAnswers: 'confirm' }), 409, /withdrawn, not pending/);
  await refused(s.ledger.update(id, { op: 'gate_record', actor: 'coordinator', gate, decision: 'approve', text: 'yes' }, { mc: true, paneAnswers: 'direct' }), 409, /withdrawn, not pending/);
  // the gate service's own events: released, expired, disputed
  for (const event of ['executed', 'expired', 'disputed']) await refused(s.ledger.update(id, { op: 'gate_event', actor: 'board', gate, event }, { gateSystem: true }), 409);
  // withdrawn twice
  await refused(s.withdraw('worker-a'), 409);
  assert.equal((await s.gate()).status, 'withdrawn');
  // redeem: no grant was ever minted, so the same call again is held and files a NEW row
  const again = await s.pre(MERGE);
  assert.equal(again.decision, 'deny');
  assert.notEqual(again.gate, gate);
  assert.equal((await s.gate(again.gate)).status, 'pending');
  assert.equal((await s.gate()).status, 'withdrawn', 'the withdrawn row stays as it was');
});

test('#786 B a pane answer waiting on the row is closed by the withdrawal and can never be confirmed', async () => {
  const s = await setup();
  await s.ledger.update(s.filed.task, { op: 'gate_record', actor: 'coordinator', gate: s.filed.gate, decision: 'approve', text: 'owner said yes in the pane' }, { mc: true, paneAnswers: 'confirm' });
  assert.ok((await s.gate()).proposal);
  await s.withdraw('worker-a');
  const g = await s.gate();
  assert.equal(g.proposal.withdrawn, true);
  assert.ok(g.proposal.overruled_at);
  // confirming it (the owner's approve on the board) and rejecting it both find nothing to act on
  await refused(s.ledger.update(s.filed.task, { op: 'gate_decide', actor: OWNER.id, gate: g.id, decision: 'approve' }, { decider: true }), 409);
  await refused(s.ledger.update(s.filed.task, { op: 'proposal_reject', actor: OWNER.id, gate: g.id }, { decider: true }), 409, /no recorded pane answer is waiting/);
});

test('#786 B the receipt chain: a line of its own, never an approval, and verify accepts it', async () => {
  const s = await setup();
  const chain = createReceiptChain({ file: path.join(s.dir, 'receipts.jsonl') });
  await chain.load();
  await chain.record(await s.task(), { op: 'gate_request', gate: s.filed.gate, gateSystem: true });
  await s.withdraw('worker-a');
  const lines = await chain.record(await s.task(), { op: 'gate_withdraw', gate: s.filed.gate });
  assert.deepEqual(lines.map((l) => [l.gate, l.event, l.status]), [[s.filed.gate, 'withdrawn', 'withdrawn']]);
  assert.equal(chain.approvalFor(s.filed.task, s.filed.gate), false);
  const v = await chain.verify([await s.task()]);
  assert.deepEqual(v.problems, []);
  assert.equal(v.ok, true);
});

test('#786 B withdrawGate itself (pure): pending only, filer only, a reason', () => {
  const t = { id: 1, gates: [{ id: 'g1', status: 'pending', agent: 'a' }, { id: 'g2', status: 'approved', agent: 'a' }] };
  assert.throws(() => withdrawGate(t, { gate: 'g2', reason: 'x' }, { iso: 'now', by: 'a' }), (e) => e.status === 409);
  assert.throws(() => withdrawGate(t, { gate: 'g1', reason: 'x' }, { iso: 'now', by: 'b' }), (e) => e.status === 403);
  assert.throws(() => withdrawGate(t, { gate: 'g1', reason: '' }, { iso: 'now', by: 'a' }), (e) => e.status === 400);
  const g = withdrawGate(t, { gate: 'g1', reason: 'y'.repeat(400) }, { iso: 'now', by: 'a' });
  assert.equal(g.status, 'withdrawn');
  assert.equal(g.withdraw_reason.length, 300);
});

test('#786 B the weekly reading counts withdrawn rows apart, with their time on the strip, outside the false-positive proxy', () => {
  const at = (m) => new Date(Date.parse('2026-11-25T12:00:00Z') + m * 60e3).toISOString();
  const tasks = [{ id: 1, status: 'in_progress', comments: [], gates: [
    { id: 'g1', status: 'withdrawn', requested_at: at(0), withdrawn_at: at(30) },
    { id: 'g2', status: 'withdrawn', requested_at: at(0), withdrawn_at: at(90) },
    { id: 'g3', status: 'declined', via: 'board', requested_at: at(0), decided_at: at(5) },
  ] }];
  const w = { from: Date.parse('2026-11-24T00:00:00Z'), to: Date.parse('2026-11-27T00:00:00Z') };
  const m = windowMetrics(tasks, w, { owner: OWNER.id });
  assert.equal(m.gates.withdrawn, 2);
  assert.equal(m.gates.withdrawnOnStrip.n, 2);
  assert.equal(m.gates.withdrawnOnStrip.p90, 90 * 60e3);
  assert.equal(m.gates.falsePositive, 1, 'only the declined row');
  assert.equal(m.gates.judged, 1);
  const text = readingText(computeReading(tasks, { end: w.to, owner: OWNER.id }));
  assert.match(text, /withdrawn by the agent 2 \(on the strip median 30m, p90 1\.5h\)/);
});
