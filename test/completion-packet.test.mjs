import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { cleanStamp, addStamp, buildPacket, packetText, packetLine, packetBrief, packetMode, stampStale, readPr, MAX_STAMPS, MAX_PACKET_BYTES } from '../src/completion-packet.mjs';
import { applyPatch, newTask, summarize } from '../src/tasks.mjs';
import { classify, compileTriggers, DEFAULT_POLICY } from '../src/gates.mjs';

// Completion packet (#400): evidence recorded at close — never a close gate.
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const stamp = (over = {}) => cleanStamp({ command: 'node --test', exit: 0, rev: SHA, branch: 'feat', dirty: false, cwd: '/w/app', at: '2026-01-05T10:00:00Z', ms: 900, ...over });

function closable(over = {}) {
  const t = newTask({ title: 'ship the widget', requester: 'helper', owner: 'builder', body: 'make the widget blue' }, { id: 7, now: Date.parse('2026-01-05T09:00:00Z') });
  t.status = 'in_progress';
  return Object.assign(t, over);
}
const closeIt = (t, ctx = {}, patch = {}) => applyPatch(t, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'data/handoffs/x.md' }, text: 'widget is blue now', ...patch }, { now: Date.parse('2026-01-05T11:00:00Z'), ...ctx });

test('stamps: validated, cut, secret text refused, newest 20 kept', () => {
  assert.equal(stamp().exit, 0);
  assert.throws(() => cleanStamp({ command: '', exit: 0 }), /command/);
  assert.throws(() => cleanStamp({ command: 'x', exit: 'nope' }), /exit/);
  assert.throws(() => cleanStamp({ command: 'x', exit: 0, rev: 'not a sha' }), /sha/);
  assert.throws(() => cleanStamp({ command: 'x'.repeat(301), exit: 0 }), /too long/);
  let all = [];
  for (let i = 0; i < MAX_STAMPS + 5; i++) all = addStamp(all, stamp({ exit: i % 2 }));
  assert.equal(all.length, MAX_STAMPS);
  const t = closable();
  const r = applyPatch(t, { op: 'test_stamp', actor: 'builder', stamp: { command: 'node t.mjs', exit: 1, rev: SHA } });
  assert.equal(r.task.test_stamps.length, 1);
  assert.throws(() => applyPatch(t, { op: 'test_stamp', actor: 'other', stamp: { command: 'x', exit: 0 } }), /only the owner/);
  assert.throws(() => applyPatch(t, { op: 'test_stamp', actor: 'builder', stamp: { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"', exit: 0 } }), /secret/);
});

test('stale: a dirty tree, or a run not on the PR head; close-time only', () => {
  assert.equal(stampStale(stamp(), SHA), null);
  assert.equal(stampStale(stamp({ rev: SHA.slice(0, 7) }), SHA), null);      // a short sha matches
  assert.match(stampStale(stamp(), SHA2), /ran at aaaaaaa, PR head bbbbbbb/);
  assert.equal(stampStale(stamp({ dirty: true }), SHA), 'dirty tree');
  assert.equal(stampStale(stamp({ dirty: true }), null), 'dirty tree');      // no PR: dirty still counts
  assert.equal(stampStale(stamp(), null), null);
  const t = closable({ test_stamps: [stamp({ rev: SHA2, exit: 1 }), stamp()] });
  const p = buildPacket(t, { pr: { url: 'https://github.com/o/r/pull/3', number: 3, state: 'MERGED', head: SHA } });
  assert.equal(p.stale, null, 'the newest stamp decides');
  assert.match(p.tests[0].stale, /PR head/);
});

test('packet: request, PR, tests, unrun, gates, generated summary — under 4 KB', () => {
  const t = closable({ test_stamps: [stamp()], gates: [{ id: 'g1', cls: 'merge', status: 'executed' }, { id: 'g2', cls: 'push', status: 'declined' }] });
  const p = buildPacket(t, { pr: { url: 'https://github.com/o/r/pull/3', number: 3, state: 'MERGED', head: SHA }, unrun: ['ui check on a phone (no device)'], summary: 'widget is blue now' });
  assert.equal(p.requested, 'ship the widget — make the widget blue');
  assert.equal(p.pr.number, 3);
  assert.deepEqual(p.gates.map((g) => g.status), ['executed', 'declined']);
  assert.deepEqual(p.summary, { text: 'widget is blue now', generated: true });
  const text = packetText(p);
  assert.match(text, /^EVIDENCE\nPR #3 @aaaaaaa merged · tests ✓1 ✗0/);
  assert.match(text, /not run: ui check on a phone/);
  assert.match(text, /gates: g1 executed, g2 declined/);
  assert.match(text, /summary \(generated\): widget is blue now/);
  const big = closable({ title: 'x'.repeat(200), test_stamps: Array.from({ length: 20 }, () => stamp({ command: 'y'.repeat(290) })) });
  const bp = buildPacket(big, { summary: 'z'.repeat(400) });
  assert.ok(Buffer.byteLength(JSON.stringify(bp)) <= MAX_PACKET_BYTES, 'kept under 4 KB');
  assert.equal(bp.trimmed, true);
  assert.match(packetText(buildPacket(closable({ test_stamps: [stamp({ dirty: true })] }))), /⚠ STALE \(dirty tree\)/);
});

test('pr read fails soft: gh missing, timeout, a non-GitHub link → unavailable, never an error', async () => {
  const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
  assert.deepEqual(await readPr('https://github.com/o/r/pull/3', { run: async () => { throw enoent; } }), { url: 'https://github.com/o/r/pull/3', unavailable: 'gh not installed' });
  assert.equal((await readPr('https://github.com/o/r/pull/3', { run: async () => { throw Object.assign(new Error('t'), { killed: true }); } })).unavailable, 'gh timed out');
  assert.equal((await readPr('https://example.com/x')).unavailable, 'not a GitHub PR link');
  assert.equal(await readPr(null), null);
  const ok = await readPr('https://github.com/o/r/pull/3', { run: async () => JSON.stringify({ number: 3, state: 'MERGED', headRefOid: SHA, mergeCommit: { oid: SHA2 } }) });
  assert.deepEqual(ok, { url: 'https://github.com/o/r/pull/3', number: 3, state: 'MERGED', head: SHA, merge: SHA2 });
  assert.match(packetText(buildPacket(closable(), { pr: { url: 'u', unavailable: 'gh timed out' } })), /PR: unavailable \(gh timed out\)/);
});

test('modes: off = nothing; observe = returned, not stored; on = stored + an evidence comment; never blocks', () => {
  assert.equal(packetMode(undefined, 'builder'), 'off');
  assert.equal(packetMode({ mode: 'observe' }, 'builder'), 'observe');
  assert.equal(packetMode({ mode: 'on', only: ['other'] }, 'builder'), 'off');
  assert.equal(packetMode({ mode: 'on', only: ['builder'] }, 'builder'), 'on');
  const off = closeIt(closable());
  assert.equal(off.packet, null);
  assert.equal(off.task.evidence, undefined);
  const obs = closeIt(closable({ test_stamps: [stamp()] }), { packet: { mode: 'observe', pr: null } });
  assert.equal(obs.task.status, 'done');
  assert.equal(obs.task.evidence, undefined);
  assert.ok(obs.packet);
  assert.match(packetLine(7, obs.packet), /^packet #7: PR: none linked · tests ✓1 ✗0/);
  const on = closeIt(closable(), { packet: { mode: 'on', pr: null } }, { unrun: ['load test (no staging)'] });
  assert.equal(on.task.status, 'done', 'no tests recorded still closes');
  assert.deepEqual(on.task.evidence.unrun, ['load test (no staging)']);
  const ev = on.task.comments.at(-1);
  assert.equal(ev.who, 'board');
  assert.equal(ev.evidence, true);
  assert.match(ev.text, /tests: none recorded/);
  const s = summarize([on.task], Date.parse('2026-01-05T12:00:00Z'));
  assert.match(s.closed24h[0].evidence.line, /tests: none recorded · 1 not run/);
  assert.equal(packetBrief(null), null);
});

test('the wrapper never hides a gated action from the classifier', () => {
  const ctx = { home: '/home/u', boardRoot: '/work/board', tmpdir: '/tmp', triggers: compileTriggers(DEFAULT_POLICY), repoRoot: () => '/work/app', git: () => null };
  const verdict = (command) => classify({ tool: 'Bash', command, cwd: '/work/app' }, DEFAULT_POLICY, ctx).verdict;
  assert.equal(verdict('scripts/task.sh test 400 -- node rename.mjs --commit'), 'gate');
  assert.equal(verdict('scripts/task.sh test 400 -- gh pr merge 5 --merge'), 'gate');
  assert.equal(verdict('scripts/task.sh test 400 -- node --test test/x.test.mjs'), 'clear');
});

// The CLI end to end, from a path with a space: the command runs here, its exit code passes
// through, and the stamp the board receives carries rev/branch/dirty. A stub board, never the live one.
const CLI = path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'mesh-cli.mjs');
test('task.sh test: runs the command, passes its exit code through, stamps rev/branch/dirty', async () => {
  const got = [];
  const srv = createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => { got.push({ method: req.method, url: req.url, body: JSON.parse(b || '{}') }); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const board = `http://127.0.0.1:${srv.address().port}`;
  try {
    const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'packet cli-')), 'my repo');
    await mkdir(dir);
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'feat'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    await writeFile(path.join(dir, 'a.txt'), 'a'); git('add', '.'); git('commit', '-qm', 'a');
    const head = git('rev-parse', 'HEAD').stdout.trim();
    // async spawn: a spawnSync would block this loop and the stub board could not answer
    const runAsync = (...cmd) => new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const p = spawn(process.execPath, [CLI, 'task', 'test', '7', '--as', 'builder', '--', ...cmd], { cwd: dir, env: { ...process.env, MESH_BOARD: board } });
        let err = ''; p.stderr.on('data', (d) => { err += d; });
        p.on('close', (code) => resolve({ code, err }));
      });
    });
    const ok = await runAsync(process.execPath, '-e', 'process.exit(0)');
    assert.equal(ok.code, 0, ok.err);
    const bad = await runAsync(process.execPath, '-e', 'process.exit(3)');
    assert.equal(bad.code, 3, 'exit code passed through');
    await writeFile(path.join(dir, 'b.txt'), 'dirty');
    await runAsync(process.execPath, '-e', '0');
    const stamps = got.filter((g) => g.body.op === 'test_stamp').map((g) => g.body.stamp);
    assert.equal(stamps.length, 3);
    assert.equal(got[0].url, '/api/tasks/7');
    assert.deepEqual(stamps.map((s) => s.exit), [0, 3, 0]);
    assert.equal(stamps[0].rev, head);
    assert.equal(stamps[0].branch, 'feat');
    assert.deepEqual(stamps.map((s) => s.dirty), [false, false, true]);
    assert.match(stamps[0].command, /-e 'process.exit\(0\)'$/);
    const none = await new Promise((resolve) => import('node:child_process').then(({ spawn }) => {
      const p = spawn(process.execPath, [CLI, 'task', 'test', '7'], { cwd: dir, env: { ...process.env, MESH_BOARD: board } });
      p.on('close', (code) => resolve(code));
    }));
    assert.notEqual(none, 0, 'usage error without -- <command>');
  } finally { srv.close(); }
});
