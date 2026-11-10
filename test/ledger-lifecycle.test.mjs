// node --test "test/*.test.mjs"
// Ledger + worker lifecycle (#468): a close checks its PR landed, the request survives the
// comment cap, spawn hands over a Mission Control task, the close sweep and its refusal,
// the squash proof by branch name, the worker limit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, newTask, prLanded, requestOf, capComments, MAX_COMMENTS, createLedger } from '../src/tasks.mjs';
import { buildPacket } from '../src/completion-packet.mjs';
import { createWorktree, cleanWorktree, landedProof, mergedPrsFor, sh } from '../src/worktree.mjs';
import { isMissionControl, adoptDecision, sweepTasks, closeBlockers, workerCapacity, prsToRead, mapCapped, DEFAULT_MAX_WORKERS, PR_READ_DAYS, PR_READ_CAP } from '../src/worker-lifecycle.mjs';
import { inScope } from '../src/context-autopilot.mjs';
import { classifyScreen } from '../src/mesh.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PR = 'https://github.com/acme/widgets/pull/12';

function closable(over = {}) {
  const t = newTask({ title: 'ship the widget', requester: 'helper', owner: 'builder', body: 'make the widget blue' }, { id: 7, now: Date.parse('2026-01-05T09:00:00Z') });
  t.status = 'in_progress';
  return Object.assign(t, over);
}
const closeIt = (t, ctx = {}, patch = {}) => applyPatch(t, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'data/handoffs/x.md', pr: PR }, text: 'widget is blue now', ...patch }, { now: Date.parse('2026-01-05T11:00:00Z'), ...ctx });

// ---- M1: a close checks that the linked PR landed ---------------------------------------

test('close: refused while the linked PR is open or closed-unmerged; a merged PR closes', () => {
  for (const state of ['OPEN', 'CLOSED']) {
    assert.throws(() => closeIt(closable(), { pr: { url: PR, number: 12, state, head: 'a'.repeat(40) } }),
      (e) => e.status === 409 && e.extra.missing.includes('pr_landed') && new RegExp(`linked PR is ${state.toLowerCase()}, not merged`).test(e.message) && /--pr-not-landed "<reason>"/.test(e.message));
  }
  const r = closeIt(closable(), { pr: { url: PR, number: 12, state: 'MERGED', head: 'a'.repeat(40) } });
  assert.equal(r.task.status, 'done');
  assert.ok(!r.task.comments.some((c) => /PR state not checked/.test(c.text)));
  // a PR already linked on the task (not in the close call) is checked the same way
  assert.throws(() => applyPatch(closable({ links: { pr: PR } }), { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'x.md' } }, { pr: { url: PR, state: 'OPEN' } }), /pr_landed not verified/);
});

test('close: the waiver needs a reason and is recorded as a close comment, like the other waivers', () => {
  const open = { pr: { url: PR, number: 12, state: 'OPEN' } };
  assert.throws(() => closeIt(closable(), open, { waive: { pr_landed: '   ' } }), /waiving pr_landed needs a reason/);
  const r = closeIt(closable(), open, { waive: { pr_landed: 'stacked PR, lands with the release branch' } });
  assert.equal(r.task.status, 'done');
  assert.equal(r.task.verify_waived.pr_landed, 'stacked PR, lands with the release branch');
  assert.ok(r.task.comments.some((c) => c.text === 'close waived: pr_landed (stacked PR, lands with the release branch)'));
});

test('close: a PR that cannot be read warns and never blocks; no PR and an unchecked PR close as before', () => {
  for (const pr of [{ url: PR, unavailable: 'gh timed out' }, { url: PR, unavailable: 'gh not installed' }, { url: 'https://example.com/x', unavailable: 'not a GitHub PR link' }, null]) {
    const r = closeIt(closable(), { pr });
    assert.equal(r.task.status, 'done');
    const warn = r.task.comments.find((c) => /PR state not checked at close/.test(c.text));
    assert.ok(warn && warn.who === 'board', 'a board warning comment');
    assert.ok(r.events.some((e) => /closed without a PR check/.test(e)));
  }
  assert.equal(closeIt(closable()).task.status, 'done', 'ctx.pr not supplied (demo, older callers) → no check');
  assert.equal(applyPatch(closable(), { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'x.md' } }, { pr: undefined }).task.status, 'done', 'no PR linked');
  assert.deepEqual(prLanded(null, { state: 'OPEN' }), { ok: true });
  assert.deepEqual(prLanded(PR, { state: 'MERGED' }), { ok: true });
});

test('the server reads the PR once at close and hands it to the ledger (wiring)', async () => {
  const src = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /prRead = await readPr\(prUrl\)/);
  assert.match(src, /\.\.\.\(prRead \? \{ pr: prRead \} : \{\}\)/);
  assert.equal(src.match(/readPr\(/g).length, 1, 'one gh read per close');
});

// the waiver flag must not trip the gate hook's fast path: feed the real hook the JSON exactly
// as the agent CLI sends it, with the board down — a gated call would come back denied
test('the waiver flag passes the gate hook untouched (real hook JSON, board down)', () => {
  const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '' };
  const decision = (obj) => { const r = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(obj), env, encoding: 'utf8' }); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'pass'; };
  const cmds = [
    'scripts/task.sh close 468 --checklist all --handoff data/handoffs/x.report.md --pr-not-landed "stacked on the release branch" "done"',
    '"/Users/x/My Zulu/scripts/task.sh" close 468 --checklist all --pr https://github.com/acme/widgets/pull/12 --pr-not-landed "lands with the release"',
    'scripts/task.sh close 468 --checklist all --handoff r.md --pr-not-landed "x"',     // the flag's value ends the command
    'scripts/agent-close.sh worker-one --override "task moved to another worker"',
  ];
  for (const command of cmds) {
    for (const shape of [
      { session_id: 's', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } },
      { session_id: 's', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },
    ]) assert.equal(decision(shape), 'pass', command);
  }
  // control: the same hook, same shapes, does deny a gated command with the board down
  assert.equal(decision({ session_id: 's', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr merge 5' } }), 'deny');
});

// ---- M3: the request survives the comment cap --------------------------------------------

test('new tasks keep the request in its own field; 300 comments later it is still there', () => {
  let t = newTask({ title: 'ship the widget', requester: 'helper', owner: 'builder', body: 'make the widget blue, keep the logo' }, { id: 7, now: Date.parse('2026-01-05T09:00:00Z') });
  assert.deepEqual(t.request, { who: 'helper', at: '2026-01-05T09:00:00.000Z', text: 'make the widget blue, keep the logo' });
  assert.equal(t.comments[0].text, 'make the widget blue, keep the logo', 'the first comment stays for older readers');
  for (let i = 0; i < 300; i++) t = applyPatch(t, { op: 'comment', actor: 'builder', text: `note ${i}` }, { now: Date.parse('2026-01-05T09:00:00Z') + (i + 1) * 1000 }).task;
  assert.equal(t.comments.length, MAX_COMMENTS);
  assert.equal(t.request.text, 'make the widget blue, keep the logo');
  assert.equal(requestOf(t).text, 'make the widget blue, keep the logo');
  assert.match(buildPacket(t).requested, /^ship the widget — make the widget blue, keep the logo$/);
  assert.equal(newTask({ title: 'no body', requester: 'helper' }, { id: 8 }).request, undefined);
});

test('a task from before the field: the cap pins its first comment (the request) and adds nothing to the file', () => {
  let t = newTask({ title: 'old task', requester: 'helper', owner: 'builder', body: 'the original ask' }, { id: 9, now: Date.parse('2026-01-05T09:00:00Z') });
  delete t.request;                                              // as written before this change
  for (let i = 0; i < 250; i++) t = applyPatch(t, { op: 'comment', actor: 'builder', text: `note ${i}` }, { now: Date.parse('2026-01-05T09:00:00Z') + (i + 1) * 1000 }).task;
  assert.equal(t.comments.length, MAX_COMMENTS);
  assert.equal(t.comments[0].text, 'the original ask', 'pinned');
  assert.equal(t.comments[1].text, 'note 51', 'then the newest 199');
  assert.equal(t.comments.at(-1).text, 'note 249');
  assert.equal(t.request, undefined, 'no field is written onto an old task');
  assert.equal(requestOf(t).text, 'the original ask');
  // an old task whose first comment is NOT the request (already trimmed, or no body) pins nothing
  const trimmed = { requester: 'helper', created_at: '2026-01-05T09:00:00.000Z', comments: Array.from({ length: 205 }, (_, i) => ({ who: 'builder', at: `2026-01-06T00:00:${String(i % 60).padStart(2, '0')}.000Z`, text: `n${i}` })) };
  assert.equal(capComments(trimmed).length, MAX_COMMENTS);
  assert.equal(capComments(trimmed)[0].text, 'n5');
  assert.equal(requestOf(trimmed), null);
});

test('existing task files are read as they are: an update writes only what the op changed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ledger req-'));
  const L = createLedger(dir);
  const t = await L.create({ title: 'old task', requester: 'helper', owner: 'builder', body: 'the original ask' });
  const file = path.join(dir, `${t.id}.json`);
  const old = JSON.parse(await readFile(file, 'utf8')); delete old.request;
  await writeFile(file, JSON.stringify(old, null, 2));
  const L2 = createLedger(dir);                                   // a restart reads the old file
  const r = await L2.update(t.id, { op: 'comment', actor: 'builder', text: 'still here' });
  assert.equal(r.task.request, undefined);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).comments[0].text, 'the original ask');
});

// ---- M5: worker lifecycle ---------------------------------------------------------------

const AGENTS = [
  { name: 'coordinator', kind: 'mission-control', workspaceId: 'MC', status: 'active' },
  { name: 'resident-a', kind: 'resident', workspaceId: 'R1', status: 'active' },
  { name: 'worker-one', kind: 'worker', workspaceId: 'W1', status: 'active', spawnTask: 30 },
  { name: 'worker-two', kind: 'worker', workspaceId: 'W2', status: 'active' },
  { name: 'worker-old', kind: 'worker', workspaceId: 'W0', status: 'closed' },
];

test('spawn: a task Mission Control owns (or nobody) goes to the worker; anyone else\'s task is left alone', () => {
  assert.equal(isMissionControl('coordinator', AGENTS), true);
  assert.equal(isMissionControl('mission-control', []), true);
  assert.equal(isMissionControl('resident-a', AGENTS), false);
  const task = (over) => ({ id: 30, status: 'open', owner: 'coordinator', ...over });
  assert.deepEqual(adoptDecision(task(), 'worker-one', AGENTS), { assign: true });
  assert.deepEqual(adoptDecision(task({ owner: null }), 'worker-one', AGENTS), { assign: true });
  assert.match(adoptDecision(task({ owner: 'resident-a' }), 'worker-one', AGENTS).why, /owned by resident-a, not Mission Control/);
  assert.deepEqual(adoptDecision(task({ owner: 'worker-one' }), 'worker-one', AGENTS), { assign: false, why: 'already the owner', silent: true });
  assert.equal(adoptDecision(task({ owner: 'resident-a' }), 'worker-one', AGENTS).silent, undefined, 'a real refusal is still said');
  assert.match(adoptDecision(task({ status: 'done' }), 'worker-one', AGENTS).why, /is done/);
  assert.equal(adoptDecision(null, 'worker-one', AGENTS).assign, false);
});

test('the quiet assign changes the owner without typing an "assigned" wake; then the worker\'s claim works', () => {
  const t = newTask({ title: 'hardening', requester: 'coordinator', owner: 'coordinator' }, { id: 30 });
  assert.throws(() => applyPatch(t, { op: 'claim', actor: 'worker-one' }), /already owned by coordinator/, 'the bug: the worker could not claim');
  const quiet = applyPatch(t, { op: 'assign', actor: 'mission-control', owner: 'worker-one', quiet: true, text: 'assigned to the worker at spawn' });
  assert.equal(quiet.task.owner, 'worker-one');
  assert.deepEqual(quiet.wake, []);
  assert.equal(quiet.wakeKind, null);
  assert.equal(applyPatch(quiet.task, { op: 'claim', actor: 'worker-one' }).task.status, 'claimed');
  assert.deepEqual(applyPatch(t, { op: 'assign', actor: 'mission-control', owner: 'worker-one' }).wake, ['worker-one'], 'a normal assign still wakes');
  // quiet is Mission Control's only: from any other caller the normal "assigned" wake goes out
  const own = newTask({ title: 'handover', requester: 'resident-a', owner: 'resident-a' }, { id: 31 });
  const loud = applyPatch(own, { op: 'assign', actor: 'resident-a', owner: 'worker-one', quiet: true });
  assert.deepEqual([loud.task.owner, loud.wake, loud.wakeKind], ['worker-one', ['worker-one'], 'assigned']);
  assert.deepEqual(applyPatch(t, { op: 'assign', actor: 'coordinator', owner: 'worker-one', quiet: true }, { mc: true }).wake, [], 'the directory-resolved Mission Control name counts (ctx.mc)');
});

test('close sweep: the worker\'s own tasks plus its spawn task, whoever owns that one', () => {
  const tasks = [
    { id: 30, owner: 'coordinator', status: 'in_progress', title: 'spawn task', links: { worktree: '/w/wt-30' } },
    { id: 31, owner: 'worker-one', status: 'done', title: 'own', links: { worktree: '/w/wt-31' } },
    { id: 32, owner: 'worker-two', status: 'open', title: 'someone else' },
    { id: 31, owner: 'worker-one', status: 'done', title: 'dup' },
  ];
  assert.deepEqual(sweepTasks(tasks, 'worker-one', 30).map((t) => t.id), [30, 31]);
  assert.deepEqual(sweepTasks(tasks, 'worker-one').map((t) => t.id), [31], 'without a recorded spawn task: owned only');
  assert.deepEqual(sweepTasks(tasks, 'worker-two', null).map((t) => t.id), [32]);
});

test('close blockers: live tasks and open PRs block; done tasks, merged PRs and unread PRs do not', () => {
  const tasks = [
    { id: 30, status: 'in_progress', title: 'spawn task' },
    { id: 31, status: 'done', title: 'own' },
    { id: 33, status: 'blocked', title: 'waiting' },
  ];
  const b = closeBlockers(tasks, [{ task: 31, url: `${PR}`, state: 'OPEN' }, { task: 30, url: 'https://github.com/acme/widgets/pull/13', state: 'MERGED' }, { task: 33, url: 'https://github.com/acme/widgets/pull/14', state: null }]);
  assert.equal(b.ok, false);
  assert.deepEqual(b.liveTasks, [30, 33]);
  assert.deepEqual(b.openPrs, [PR]);
  assert.deepEqual(b.unread, ['https://github.com/acme/widgets/pull/14']);
  assert.deepEqual(b.lines, ['live task #30 [in_progress] spawn task', 'live task #33 [blocked] waiting', `open PR ${PR} (task #31)`]);
  assert.equal(closeBlockers([{ id: 31, status: 'done', title: 'own' }], [{ task: 31, url: PR, state: 'MERGED' }]).ok, true);
  assert.equal(closeBlockers([], []).ok, true);
});

test('worker limit: counts live workers only, default 3, warns from the limit on, never refuses', () => {
  assert.equal(DEFAULT_MAX_WORKERS, 3);
  const two = workerCapacity(AGENTS);
  assert.deepEqual([two.count, two.max, two.over, two.line], [2, 3, false, null]);
  const three = workerCapacity([...AGENTS, { name: 'worker-three', kind: 'worker', workspaceId: 'W3', status: 'active' }]);
  assert.equal(three.over, true);
  assert.match(three.line, /^worker limit: 3 live worker\(s\) \(worker-one, worker-two, worker-three\) — this spawn makes 4, the limit is 3\. Spawning anyway \(warning only\)\.$/);
  assert.equal(workerCapacity(AGENTS, { max: 2 }).over, true);
  assert.equal(workerCapacity(AGENTS, { max: 0 }).max, 3, 'a bad limit falls back to the default');
  assert.equal(workerCapacity([{ name: 'w', kind: 'worker', status: 'active' }]).count, 0, 'no workspace = not live');
});

test('close-check PR reads are bounded: live tasks, the spawn task and recent closes only; a few at a time', async () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  const pr = (n) => ({ pr: `https://github.com/acme/widgets/pull/${n}` });
  const tasks = [
    { id: 1, status: 'in_progress', links: pr(1) },
    { id: 2, status: 'done', closed_at: '2026-01-09T12:00:00Z', links: pr(2) },           // closed yesterday
    { id: 3, status: 'done', closed_at: '2025-12-01T12:00:00Z', links: pr(3) },           // long closed
    { id: 4, status: 'done', closed_at: '2025-11-01T12:00:00Z', links: pr(4) },           // long closed, but the spawn task
    { id: 5, status: 'cancelled', closed_at: '2025-10-01T12:00:00Z', links: pr(5) },
    { id: 6, status: 'open', links: {} },                                                  // no PR
    ...Array.from({ length: 40 }, (_, i) => ({ id: 100 + i, status: 'done', closed_at: '2025-09-01T00:00:00Z', links: pr(100 + i) })),
  ];
  const r = prsToRead(tasks, { spawnTask: 4, now });
  assert.deepEqual(r.read.map((t) => t.id), [1, 2, 4]);
  assert.equal(r.skipped, 42);
  assert.equal(PR_READ_DAYS, 3);
  assert.deepEqual(prsToRead([], { now }), { read: [], skipped: 0 });
  // at most PR_READ_CAP reads in flight, results in order
  let inFlight = 0; let peak = 0;
  const out = await mapCapped([1, 2, 3, 4, 5, 6, 7, 8, 9], PR_READ_CAP, async (n) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((res) => setTimeout(res, 5)); inFlight--; return n * 2; });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.equal(peak, PR_READ_CAP);
  assert.deepEqual(await mapCapped([], 4, async () => 1), []);
});

// the CLI against a small stand-in board (MESH_BOARD), as the spawn and close scripts call it
async function fakeBoard(state) {
  const patches = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (url.pathname === '/api/agents') return send(200, { agents: state.agents, outbox: [] });
      if (url.pathname === '/api/tasks' && req.method === 'GET') return send(200, { tasks: state.tasks.filter((t) => !url.searchParams.get('owner') || t.owner === url.searchParams.get('owner')) });
      const m = /^\/api\/tasks\/(\d+)$/.exec(url.pathname);
      if (m) {
        const t = state.tasks.find((x) => x.id === Number(m[1]));
        if (!t) return send(404, { ok: false, msg: 'no such task' });
        if (req.method === 'GET') return send(200, t);
        const b = JSON.parse(body); patches.push({ id: t.id, ...b });
        if (b.op === 'assign') t.owner = b.owner;
        return send(200, { ok: true, task: t, deliveries: [] });
      }
      return send(404, { ok: false, msg: 'not found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, patches, close: () => new Promise((r) => server.close(r)) };
}
const cli = (board, args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/mesh-cli.mjs'), ...args], { env: { ...process.env, MESH_BOARD: board, MESH_AGENT: '', CMUX_WORKSPACE_ID: '', PATH: env.PATH ?? process.env.PATH, ...env } });
  let out = ''; let err = '';
  child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
  child.on('close', (code) => resolve({ code, out, err }));
});
const baseTask = (over) => ({ id: 30, title: 'spawn task', status: 'open', owner: 'coordinator', requester: 'coordinator', blocked_on: [], links: {}, comments: [], checklist: {}, ...over });

test('CLI adopt: reassigns a Mission Control task quietly at spawn; leaves another agent\'s task alone', async () => {
  const state = { agents: structuredClone(AGENTS), tasks: [baseTask(), baseTask({ id: 40, owner: 'resident-a' })] };
  const board = await fakeBoard(state);
  try {
    const a = await cli(board.url, ['task', 'adopt', '30', 'worker-one', '--as', 'mission-control']);
    assert.equal(a.code, 0, a.err);
    assert.deepEqual(board.patches.map((p) => [p.id, p.op, p.owner, p.quiet, p.actor]), [[30, 'assign', 'worker-one', true, 'mission-control']]);
    const b = await cli(board.url, ['task', 'adopt', '40', 'worker-one', '--as', 'mission-control']);
    assert.equal(b.code, 0);
    assert.match(b.out, /#40: not reassigned — task #40 is owned by resident-a, not Mission Control/);
    assert.equal(board.patches.length, 1, 'nothing written for the other agent\'s task');
    // the ordinary spawn (the worker made its own task): nothing printed, nothing written
    state.tasks.push(baseTask({ id: 50, owner: 'worker-one' }));
    const c = await cli(board.url, ['task', 'adopt', '50', 'worker-one', '--as', 'mission-control']);
    assert.deepEqual([c.code, c.out, c.err, board.patches.length], [0, '', '', 1]);
  } finally { await board.close(); }
});

test('CLI close-check: exit 3 and a list while the worker has a live task (its spawn task included); exit 0 when clear', async () => {
  const state = { agents: structuredClone(AGENTS), tasks: [baseTask({ status: 'in_progress' }), baseTask({ id: 31, owner: 'worker-one', status: 'done', title: 'own' })] };
  const board = await fakeBoard(state);
  try {
    const busy = await cli(board.url, ['close-check', 'worker-one']);
    assert.equal(busy.code, 3);
    assert.match(busy.out, /live task #30 \[in_progress\] spawn task/, 'the task Mission Control still owns is covered through spawnTask');
    state.tasks[0].status = 'done';
    const clear = await cli(board.url, ['close-check', 'worker-one']);
    assert.equal(clear.code, 0, clear.err);
    assert.match(clear.out, /worker-one: no live tasks, no open PRs \(0 PR\(s\) read\)/);
    // 30 long-closed tasks with PR links: none is read (no gh call per old task), and the output says so
    for (let i = 0; i < 30; i++) state.tasks.push(baseTask({ id: 200 + i, owner: 'worker-one', status: 'done', closed_at: '2025-01-01T00:00:00.000Z', links: { pr: `https://github.com/acme/widgets/pull/${200 + i}` } }));
    const many = await cli(board.url, ['close-check', 'worker-one'], { PATH: '/nonexistent' });
    assert.equal(many.code, 0, many.err);
    assert.match(many.out, /no live tasks, no open PRs \(0 PR\(s\) read, 30 on tasks closed more than 3 days ago not read\)/);
    const down = await cli('http://127.0.0.1:9', ['close-check', 'worker-one']);
    assert.notEqual(down.code, 0, 'board down = not a pass');
  } finally { await board.close(); }
});

test('CLI worker-count: one warning line at the limit, silence under it, silence (exit 0) with the board down', async () => {
  const state = { agents: [...structuredClone(AGENTS), { name: 'worker-three', kind: 'worker', workspaceId: 'W3', status: 'active' }], tasks: [] };
  const board = await fakeBoard(state);
  try {
    const over = await cli(board.url, ['worker-count']);
    assert.equal(over.code, 0);
    assert.match(over.out, /^worker limit: 3 live worker\(s\)/);
    state.agents.pop();
    assert.equal((await cli(board.url, ['worker-count'])).out, '');
    const down = await cli('http://127.0.0.1:9', ['worker-count']);
    assert.deepEqual([down.code, down.out], [0, '']);
  } finally { await board.close(); }
});

test('the scripts: spawn warns then adopts after registering; close checks before anything is closed', async () => {
  const spawnSh = await readFile(path.join(ROOT, 'scripts/agent-spawn.sh'), 'utf8');
  assert.ok(spawnSh.indexOf('worker-count') > 0 && spawnSh.indexOf('worker-count') < spawnSh.indexOf('new-workspace'));
  assert.ok(spawnSh.indexOf(' register --workspace') < spawnSh.indexOf('task adopt "$TASK" "$SLUG"'), 'adopt needs the worker in the directory');
  assert.ok(spawnSh.indexOf('task adopt "$TASK" "$SLUG"') < spawnSh.indexOf('" kick --workspace'), 'and comes before the brief is submitted');
  assert.match(spawnSh, /register .*\$\{TASK:\+--task "\$TASK"\}/);
  const closeSh = await readFile(path.join(ROOT, 'scripts/agent-close.sh'), 'utf8');
  assert.ok(closeSh.indexOf('close-check "$NAME"') < closeSh.indexOf('cmux close-workspace'));
  assert.ok(closeSh.indexOf('exit 3') < closeSh.indexOf('cmux close-workspace'));
  assert.match(closeSh, /--override\)/);
});

// ---- M5: squash-landed branch pushed without tracking ------------------------------------

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});
const g = async (cwd, ...args) => { const r = await sh('git', ['-C', cwd, ...args]); assert.ok(r.ok, `git ${args.join(' ')}: ${r.err}`); return r.out; };

test('clean after a squash merge of a branch pushed WITHOUT tracking and no PR link: the merged PR found by branch name is proof', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wt squash-')));
  const origin = path.join(base, 'origin.git');
  await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const repo = path.join(base, 'my repo');
  await sh('git', ['clone', '-q', origin, repo]);
  await writeFile(path.join(repo, 'a.txt'), 'a');
  await g(repo, 'add', '.'); await g(repo, 'commit', '-qm', 'first'); await g(repo, 'push', '-q', 'origin', 'main');
  await sh('git', ['-C', repo, 'remote', 'set-head', 'origin', 'main']);
  const r = await createWorktree({ repo, task: 54, title: 'squashed no tracking' });
  await writeFile(path.join(r.path, 'd.txt'), 'd'); await g(r.path, 'add', '.'); await g(r.path, 'commit', '-qm', 'd');
  await g(r.path, 'push', '-q', 'origin', 'HEAD');                           // no -u: the branch has no upstream
  const head = await g(r.path, 'rev-parse', 'HEAD');
  // the host squashes it into main and deletes the branch
  await g(repo, 'merge', '-q', '--squash', r.branch); await g(repo, 'commit', '-qm', 'squash d');
  await g(repo, 'push', '-q', 'origin', 'main');
  await g(repo, 'push', '-q', 'origin', '--delete', r.branch);

  const asked = [];
  const none = async (branch) => { asked.push(branch); return []; };
  const refused = await cleanWorktree({ path: r.path, findPrs: none });
  assert.equal(refused.ok, false);
  assert.match(refused.why, /not on the remote/, 'the refusal seen before this change');
  assert.deepEqual(asked, [r.branch], 'the PR is looked up by the branch name');
  // a merged PR for this branch at ANOTHER head (a commit was added after the merge) is no proof
  assert.equal((await cleanWorktree({ path: r.path, findPrs: async () => [{ url: PR, headRefOid: '0'.repeat(40) }] })).ok, false);
  assert.ok(existsSync(r.path));
  const ok = await cleanWorktree({ path: r.path, findPrs: async () => [{ url: 'https://github.com/acme/widgets/pull/1', headRefOid: '1'.repeat(40) }, { url: PR, headRefOid: head }] });
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual([ok.removed, ok.proof, ok.branchDeleted], [true, 'pr-branch', true]);
  assert.ok(!existsSync(r.path));
  assert.equal(await g(repo, 'branch', '--list', r.branch), '');
});

test('the branch lookup: gh list by head branch, merged only; fails soft to no proof', async () => {
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push([cmd, args.join(' '), opts.cwd]); return { ok: true, out: JSON.stringify([{ url: PR, headRefOid: 'abc' }, { url: 'x' }]) }; };
  assert.deepEqual(await mergedPrsFor('task/54-x', { root: '/r', run }), [{ url: PR, headRefOid: 'abc' }]);
  assert.deepEqual(calls[0], ['gh', 'pr list --head task/54-x --state merged --json url,headRefOid --limit 10', '/r']);
  assert.deepEqual(await mergedPrsFor('b', { root: '/r', run: async () => ({ ok: false, out: '' }) }), []);
  assert.deepEqual(await mergedPrsFor('b', { root: '/r', run: async () => ({ ok: true, out: 'not json' }) }), []);
  assert.deepEqual(await mergedPrsFor(null, { root: '/r', run }), []);
  // pushed-but-unmerged work keeps its earlier proof and never asks gh
  let asked = 0;
  const p = await landedProof({ wt: '/w', root: '/r', head: 'h', branch: 'b', findPrs: async () => { asked++; return []; },
    run: async (cmd, args) => (args.includes('symbolic-ref') ? { ok: true, out: 'origin/main' } : args.includes('merge-base') ? { ok: false, out: '' } : args.includes('--contains') ? { ok: true, out: 'origin/b' } : { ok: false, out: '' }) });
  assert.deepEqual([p.ok, p.how, asked], [true, 'remote', 0]);
});

// ---- M6: context autopilot on a Codex pane (what the code does)

test('context autopilot scope: a Codex agent is in once the only-list is empty; a --profile Codex stays out', () => {
  const codex = { name: 'resident-codex', workspaceId: 'C1', vendor: 'codex', kind: 'resident', status: 'active' };
  assert.equal(inScope(codex, { mode: 'on', only: ['resident-a'] }), false, 'outside the only-list');
  assert.equal(inScope(codex, { mode: 'on', only: [], exclude: [] }), true);
  assert.equal(inScope(codex, { mode: 'on' }), true);
  assert.equal(inScope({ ...codex, profile: 'local' }, { mode: 'on' }), false);
  assert.equal(inScope(codex, { mode: 'on', exclude: ['resident-codex'] }), false);
  // an idle Codex pane reads as READY to the delivery rule that types /compact; a busy one or a draft does not
  const idle = ['  Worked for 2h 21m 39s', '› Ask Codex to do anything', '  gpt-5 high · ~/my-app', '  ← for agents · ? for shortcuts'].join('\n');
  assert.equal(classifyScreen(idle).state, 'ready');
  assert.equal(classifyScreen(idle.replace('› Ask Codex to do anything', '› half a thought')).state, 'draft');
  assert.equal(classifyScreen(`${idle}\n  Working (12s · esc to interrupt)`).state, 'busy');
});
