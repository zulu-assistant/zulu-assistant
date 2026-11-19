import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTask, applyPatch, summarize } from '../src/tasks.mjs';
import { attentionItems } from '../src/attention.mjs';
import { OWNER } from '../src/config.mjs';

// #566: deciding a gate removes only the gate's own wait on the owner. Seen on one task: an ask to the owner
// (block), then a gate, then the owner's gate decision left the task "blocked" with nobody named, and the
// ask dropped off the owner's waiting list. Neutral fixtures: agent "builder", requester "helper", task #7.
const isOwner = (x) => x === OWNER.id;
const gate = { cls: 'merge', label: 'Merge a pull request', command: 'gh pr merge 9', cwd: '/work/app', tool: 'Bash', agent: 'builder', cmdHash: 'h1' };
const at = Date.parse('2026-01-05T10:00:00Z');
const waiting = (t) => { const s = summarize([t]); return attentionItems([...s.needsApproval, ...s.blocked], { isOwner }).map((i) => i.id); };
const claimed = () => applyPatch(newTask({ title: 'x', requester: 'helper', owner: 'builder' }, { id: 12, now: at }), { op: 'claim', actor: 'builder' }).task;
const request = (t) => applyPatch(t, { op: 'gate_request', actor: 'board', gate }, { gateSystem: true }).task;
const decide = (t, decision = 'approve') => applyPatch(t, { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision }, { decider: true, now: at + 60e3 }).task;

test('an owner block filed before the gate stays after the gate is decided (the shape first seen)', () => {
  for (const decision of ['approve', 'decline']) {
    let t = claimed();
    t = applyPatch(t, { op: 'block', actor: 'builder', blocked_on: [OWNER.id], text: 'a question for the owner' }).task;
    t = request(t);
    assert.equal(t.status, 'needs_approval');
    assert.notEqual(t.gate_wait, true, 'the owner was already waited on: the gate did not add them');
    t = decide(t, decision);
    assert.equal(t.status, 'blocked', decision);
    assert.deepEqual(t.blocked_on, [OWNER.id], `${decision}: the ask is still open`);
    assert.equal(t.gate_wait, undefined);
    assert.ok(waiting(t).length, `${decision}: the ask stays on the owner's waiting list`);
  }
});

test('a gate on a task that waited on nobody: deciding it ends the wait, as before', () => {
  let t = request(claimed());
  assert.deepEqual(t.blocked_on, [OWNER.id]);
  assert.equal(t.gate_wait, true);
  t = decide(t);
  assert.equal(t.status, 'claimed');
  assert.deepEqual(t.blocked_on, []);
  assert.equal(t.gate_wait, undefined);
});

test('a block filed while the gate waits: the block keeps its own waits, the gate takes only its own', () => {
  // the block names another task only: the gate still lists through its own row (#421), and deciding it
  // leaves the block as it was
  let t = request(claimed());
  t = applyPatch(t, { op: 'block', actor: 'builder', blocked_on: [7] }).task;
  assert.equal(t.status, 'blocked');
  assert.deepEqual(t.blocked_on, [7]);
  assert.deepEqual(waiting(t), ['gate:12:g1']);
  t = decide(t);
  assert.equal(t.status, 'blocked');
  assert.deepEqual(t.blocked_on, [7]);
  // the block names the owner: that ask is the owner's own and outlives the gate
  t = request(claimed());
  t = applyPatch(t, { op: 'block', actor: 'builder', blocked_on: [OWNER.id] }).task;
  t = decide(t);
  assert.equal(t.status, 'blocked');
  assert.deepEqual(t.blocked_on, [OWNER.id]);
});

test('a gate requested before the mark existed (no gate_wait) on a working task still ends the wait', () => {
  let t = request(claimed());
  delete t.gate_wait;
  t = decide(t);
  assert.equal(t.status, 'claimed');
  assert.deepEqual(t.blocked_on, []);
});

test('a task never reads blocked with nobody named after the gates settle', () => {
  let t = request(claimed());
  t = { ...t, gates: t.gates.map((g) => ({ ...g, prev_status: 'blocked' })) };   // it was blocked, and that wait ended meanwhile
  t = decide(t);
  assert.equal(t.status, 'in_progress');
  assert.deepEqual(t.blocked_on, []);
});
