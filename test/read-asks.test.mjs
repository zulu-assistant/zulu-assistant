// node --test "test/*.test.mjs" — #787 part 3: a read or a go asked only in a task comment wakes Mission Control once
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { asksForRead, findAsks, askText, noteSent, settleState, readAsksMode, ASK_WAIT_MS } from '../src/read-asks.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIN = 60e3;
const NOW = Date.parse('2026-11-27T12:00:00Z');
const ago = (m) => new Date(NOW - m * MIN).toISOString();
const notAgent = (n) => ['mission-control', 'mission-control-main', 'board', 'owner'].includes(n);
const task = (id, last, extra = {}) => ({
  id, title: 'some work', owner: 'builder', status: 'in_progress',
  comments: [{ who: 'mission-control-main', at: ago(120), text: 'please build it' }, last],
  ...extra,
});

// the three shapes that waited (paraphrased, neutral): a plan for MC, a head for MC to read, a head for your read not pushed
const SHAPES = [
  'PLAN for MC: data/handoffs/x/PLAN.md. Two options below.',
  'HEAD for MC to read: 0123abc on branch fix/x, worktree ~/wt-x (not pushed).',
  'HEAD for your read, NOT pushed: branch task/x @ 0123abc, based on main 89abcde.',
];
const NOT_ASKS = [
  'LANDED: PR 28 merged as 3371bf1, live checkout pulled.',
  'PR 28 open, head 0123abc, unchanged from your read. Landing row filed.',
  'STEP 2 PREPARED, NOT RUN. Dry run attached.',
  'Claimed and focused.',
];

test('#787 the ask patterns: the three shapes that waited, and ordinary progress notes that are not asks', () => {
  for (const s of SHAPES) assert.ok(asksForRead(s), s);
  for (const s of NOT_ASKS) assert.ok(!asksForRead(s), s);
  for (const s of ['waiting for your go on the restart', 'needs your go', 'awaiting MC', 'for Mission Control to review']) assert.ok(asksForRead(s), s);
});

test('#787 an unseen ask wakes Mission Control after 10 min, once per comment', () => {
  const t = task(5, { who: 'builder', at: ago(11), text: SHAPES[1] });
  assert.deepEqual(findAsks([task(5, { who: 'builder', at: ago(9), text: SHAPES[1] })], {}, { now: NOW, notAgent }).wake, []);
  const r = findAsks([t], {}, { now: NOW, notAgent });
  assert.deepEqual(r.wake, [{ key: `5@${ago(11)}`, task: 5, agent: 'builder', ageMin: 11 }]);
  const told = settleState({}, { told: r.wake.map((w) => w.key), liveIds: new Set([5]), at: ago(0) });
  assert.deepEqual(findAsks([t], told, { now: NOW + 30 * MIN, notAgent }).wake, [], 'once per comment');
  // a new ask comment later is its own ask
  const t2 = { ...t, comments: [...t.comments, { who: 'builder', at: ago(-1), text: SHAPES[2] }] };
  assert.equal(findAsks([t2], told, { now: NOW + 30 * MIN, notAgent }).wake.length, 1);
  assert.equal(ASK_WAIT_MS, 10 * MIN);
});

test('#787 seen = a message to Mission Control on the task after the comment, or a status change, or a newer comment', () => {
  const t = task(6, { who: 'builder', at: ago(30), text: SHAPES[0] });
  // a message sent after the comment
  let st = noteSent({}, { task: 6, from: 'builder', at: ago(25) });
  assert.deepEqual(findAsks([t], st, { now: NOW, notAgent }).wake, []);
  // a message sent BEFORE the comment does not cover it; one from another agent does not either
  st = noteSent(noteSent({}, { task: 6, from: 'builder', at: ago(40) }), { task: 6, from: 'helper', at: ago(5) });
  assert.equal(findAsks([t], st, { now: NOW, notAgent }).wake.length, 1);
  // a status change after the comment
  const moved = { ...t, history: [{ at: ago(20), op: 'block', by: 'builder', from: 'in_progress', status: 'blocked' }] };
  assert.deepEqual(findAsks([moved], {}, { now: NOW, notAgent }).wake, []);
  // Mission Control answered: the ask is no longer the newest comment
  const answered = { ...t, comments: [...t.comments, { who: 'mission-control-main', at: ago(10), text: 'read, go' }] };
  assert.deepEqual(findAsks([answered], {}, { now: NOW, notAgent }).wake, []);
});

test('#787 only the owner agent asks: not Mission Control, the owner, the board, another agent; only live tasks', () => {
  const ask = (who, extra) => task(7, { who, at: ago(30), text: SHAPES[1] }, extra);
  assert.equal(findAsks([ask('helper')], {}, { now: NOW, notAgent }).wake.length, 0, 'another agent on the task');
  assert.equal(findAsks([ask('mission-control-main', { owner: 'mission-control-main' })], {}, { now: NOW, notAgent }).wake.length, 0);
  assert.equal(findAsks([ask('board', { owner: 'board' })], {}, { now: NOW, notAgent }).wake.length, 0);
  assert.equal(findAsks([ask('builder', { status: 'done' })], {}, { now: NOW, notAgent }).wake.length, 0);
  assert.equal(findAsks([ask('builder', { status: 'blocked' })], {}, { now: NOW, notAgent }).wake.length, 1);
});

test('#787 the wake carries the task id, the agent and the age only: never the comment\'s words', () => {
  const t = task(8, { who: 'builder', at: ago(12), text: 'HEAD for MC to read: a customer named Jane Doe asked …' }, { source: { via: 'chat' } });
  const [w] = findAsks([t], {}, { now: NOW, notAgent }).wake;
  const text = askText(w);
  assert.equal(text, '#8: builder asked for a read in a comment 12 min ago and sent no message');
  assert.ok(!/Jane|customer|some work/.test(text));
});

test('#787 state: entries of tasks no longer live are dropped; switch off unless on', () => {
  const st = { told: { '1@a': 'x', '2@b': 'y' }, sent: { '1|builder': 'x', '3|builder': 'z' } };
  assert.deepEqual(settleState(st, { told: ['4@c'], liveIds: new Set([1, 4]), at: 'now' }), { told: { '1@a': 'x', '4@c': 'now' }, sent: { '1|builder': 'x' } });
  assert.equal(readAsksMode({ mode: 'on' }), 'on');
  assert.equal(readAsksMode({ mode: 'observe' }), 'off');
  assert.equal(readAsksMode(undefined), 'off');
});

// ---- through the real routes (a demo board): the order the seen rule rests on ----
async function board(fn) {
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'read-asks-overlay-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { readAsks: { mode: 'on' } } }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1' }), stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    await fn(base);
  } finally { child.kill(); }
}
const json = { 'content-type': 'application/json' };

test('#787 through the real routes: the comment is written before the send is recorded, so a sent ask is never older than its comment', { timeout: 30_000 }, async () => {
  await board(async (base) => {
    const get = (p) => fetch(`${base}${p}`).then((r) => r.json());
    const t0 = await get('/api/tasks/1');
    const owner = t0.owner;
    assert.ok(owner && owner !== 'mission-control', 'the demo task has an agent owner');
    // 1. the owner agent asks in a comment (task.sh comment), 2. then messages Mission Control (agent-send.sh --task 1)
    const c = await fetch(`${base}/api/tasks/1`, { method: 'PATCH', headers: json, body: JSON.stringify({ op: 'comment', actor: owner, text: 'HEAD for MC to read: 0123abc (not pushed).' }) });
    assert.equal(c.status, 200);
    const s = await fetch(`${base}/api/mesh/send`, { method: 'POST', headers: json, body: JSON.stringify({ from: owner, to: 'mission-control', text: 'head 0123abc for your read', task: 1 }) });
    assert.equal(s.status, 200);
    const t = await get('/api/tasks/1');
    const st = await get('/api/read-asks');
    const comment = t.comments[t.comments.length - 1];
    const sent = st.sent[`1|${owner}`];
    assert.ok(sent, 'the send route recorded the message');
    assert.ok(Date.parse(sent) >= Date.parse(comment.at), `sent ${sent} is not earlier than the comment ${comment.at}`);
    // so the ask reads as seen, however long after
    const later = Date.parse(comment.at) + 60 * MIN;
    assert.deepEqual(findAsks([t], st, { now: later, notAgent }).wake, []);
    // a message from someone else, or to another agent, records nothing
    await fetch(`${base}/api/mesh/send`, { method: 'POST', headers: json, body: JSON.stringify({ from: 'some-other-agent', to: owner, text: 'hello', task: 1 }) });
    const st2 = await get('/api/read-asks');
    assert.deepEqual(Object.keys(st2.sent), [`1|${owner}`]);
    // a NEW ask written after that message is not covered by it
    await fetch(`${base}/api/tasks/1`, { method: 'PATCH', headers: json, body: JSON.stringify({ op: 'comment', actor: owner, text: 'HEAD for your read, NOT pushed: 4567def.' }) });
    const t2 = await get('/api/tasks/1');
    const st3 = await get('/api/read-asks');
    const wake = findAsks([t2], st3, { now: Date.parse(t2.comments[t2.comments.length - 1].at) + 11 * MIN, notAgent }).wake;
    assert.equal(wake.length, 1);
    assert.equal(wake[0].task, 1);
  });
});
