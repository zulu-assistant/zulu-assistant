import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newTask, applyPatch, summarize } from '../src/tasks.mjs';
import { attentionItems } from '../src/attention.mjs';
import { pillStatus } from '../src/chrome.mjs';
import { OWNER } from '../src/config.mjs';

// #421: a pending gate must stay on WAITING ON YOU whatever op moves the task's status.
// Neutral fixtures: agent "builder", requester "helper", task #7 as the blocker.
const isOwner = (x) => x === OWNER.id;
const gate = { cls: 'merge', label: 'Merge a pull request', command: 'gh pr merge 9', cwd: '/work/app', tool: 'Bash', agent: 'builder', cmdHash: 'h1' };
const waiting = (t) => { const s = summarize([t]); return attentionItems([...s.needsApproval, ...s.blocked], { isOwner }).map((i) => i.id); };

function gated() {
  let t = newTask({ title: 'x', requester: 'helper', owner: 'builder' }, { id: 12, now: Date.parse('2026-01-05T10:00:00Z') });
  t = applyPatch(t, { op: 'claim', actor: 'builder' }).task;
  t = applyPatch(t, { op: 'gate_request', actor: 'board', gate }, { gateSystem: true }).task;
  assert.equal(t.status, 'needs_approval');
  return t;
}

test('gate requested, then block + unblock: the gate stays waiting on the owner (the #408 shape)', () => {
  let t = gated();
  t = applyPatch(t, { op: 'block', actor: 'builder', blocked_on: [7] }).task;
  assert.equal(t.status, 'blocked');
  assert.deepEqual(waiting(t), ['gate:12:g1']);
  t = applyPatch(t, { op: 'unblock', actor: 'builder' }).task;
  assert.equal(t.status, 'needs_approval');
  assert.ok(t.blocked_on.includes(OWNER.id));
  assert.deepEqual(waiting(t), ['gate:12:g1']);
  assert.equal(pillStatus(t), 'needs_approval');
});

test('start / claim / assign never drop a pending gate; the decision settles the task as before', () => {
  let t = gated();
  t = applyPatch(t, { op: 'start', actor: 'builder' }).task;
  assert.equal(t.status, 'needs_approval');
  t = applyPatch(t, { op: 'assign', actor: 'helper', owner: 'builder' }).task;
  assert.equal(t.status, 'needs_approval');
  assert.deepEqual(waiting(t), ['gate:12:g1']);
  t = applyPatch(t, { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' }, { decider: true }).task;
  assert.notEqual(t.status, 'needs_approval');
  assert.deepEqual(waiting(t), []);
});

test('a task already stored in_progress with a pending gate (pre-fix data) still reaches the strip and the pill', () => {
  const t = { ...gated(), status: 'in_progress', blocked_on: [] };
  const s = summarize([t]);
  assert.deepEqual(s.needsApproval.map((x) => x.id), [12]);
  assert.deepEqual(s.open, []);
  assert.equal(s.counts.needsApproval, 1);
  assert.equal(s.counts.open, 0);
  assert.deepEqual(waiting(t), ['gate:12:g1']);
  assert.equal(pillStatus(t), 'needs_approval');
  // a gate blocked on another person still shows as APPROVAL in the pill, not WAITING
  assert.equal(pillStatus({ ...t, status: 'blocked', blocked_on: ['teammate'] }), 'needs_approval');
});
