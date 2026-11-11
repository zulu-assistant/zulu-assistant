// node --test "test/*.test.mjs" — demo mode data (src/demo.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile, mkdir } from 'node:fs/promises';
import { readdirSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { demoSnapshot, demoDirectory, demoContext, demoBeats, demoHistory, seedDemoLedger, demoTasksDir, DEMO_MARKER, DEMO_DOMAINS, CYCLE_S } from '../src/demo.mjs';
import { createLedger } from '../src/tasks.mjs';
import { demoEnv } from './demo-board.mjs';

test('snapshot has the shape the board renders, every card in a demo domain', () => {
  const s = demoSnapshot();
  assert.ok(s.demo);
  assert.ok(s.jobs.length >= 12);
  const ids = new Set(DEMO_DOMAINS.map((d) => d.id));
  for (const j of s.jobs) {
    assert.ok(ids.has(j.domain), j.label);
    for (const k of ['label', 'name', 'status', 'detail', 'schedule']) assert.ok(k in j, `${j.label}.${k}`);
  }
  assert.equal(s.counts.total, s.jobs.length);
  assert.equal(s.counts.ok + s.counts.attention, s.jobs.length);
  assert.ok(s.timeline.length > 10 && s.timeline.every((t, i, a) => !i || a[i - 1].at <= t.at));
});

test('sessions, directory and context gauges line up by workspace id', () => {
  const s = demoSnapshot();
  const dir = new Map(demoDirectory().map((a) => [a.workspaceId, a]));
  const ctx = demoContext();
  for (const x of s.sessions) {
    assert.ok(dir.has(x.workspaceId));
    assert.ok(['ok', 'amber', 'red'].includes(ctx.get(x.workspaceId).band));
    assert.match(x.workspaceId, /^00000000-/);                             // never a real-looking UUID
  }
});

test('one full cycle plays every beat once: self-heal (success moment), needs-input, close', () => {
  const t0 = Date.now();
  const beats = [];
  for (let t = 0; t < CYCLE_S; t += 5) beats.push(...demoBeats(t0 + t * 1000, t0 + (t + 5) * 1000));
  assert.equal(beats.filter((b) => b.success).length, 1);
  assert.equal(beats.filter((b) => b.closeTask).length, 1);
  assert.ok(beats.some((b) => /NEEDS INPUT/.test(b.text)));
});

test('history pre-fills the sparkline and strips', () => {
  const h = demoHistory();
  assert.equal(h.fleet.length, 240);
  assert.ok(Object.values(h.perJob).every((a) => a.length === 48));
});

test('seeded ledger fills every WORK column', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zulu-demo-'));
  const L = await seedDemoLedger(dir, createLedger);
  const c = (await L.summary()).counts;
  assert.ok(c.needsApproval >= 1 && c.blocked >= 1 && c.open >= 2);
  // the scripted close beat must work under ANY configured checklist (server.mjs demoTick)
  const t = await L.create({ title: 'Triage pass', requester: 'board', owner: 'mission-control' });
  const r = await L.update(t.id, { op: 'close', actor: 'mission-control', checklist: 'all', links: { handoff: 'x.report.md' } });
  assert.equal(r.task.status, 'done');
});

// A demo run in a live checkout must not touch live state: boot the real server
// with MC_DEMO=1 on a spare port, let it poll, record a toast event, then check
// that nothing in data/ outside the demo-* files was created or changed.
test('a demo server never touches the real board\'s data/', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { readdir, stat, mkdir: mk } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const DATA = path.join(ROOT, 'data');
  await mk(DATA, { recursive: true });
  const snap = async () => {
    const out = {};
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        const rel = path.relative(DATA, p);
        if (/^demo[-.]/.test(rel)) continue;                                   // the demo's own files
        if (/^guardrails\/(checks|observed)\.jsonl$/.test(rel)) continue;     // the LIVE board appends these on other agents' hook calls mid-run
        if (e.isDirectory()) await walk(p);
        else { const s = await stat(p).catch(() => null); if (s) out[rel] = `${s.size}:${s.mtimeMs}`; }
      }
    };
    await walk(DATA);
    return out;
  };
  const before = await snap();
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: demoEnv({ MC_PORT: String(port) }), stdio: 'ignore' });
  try {
    let status = null;
    for (let i = 0; i < 80 && !status; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    assert.ok(status?.demo, 'demo server answered');
    await new Promise((r) => setTimeout(r, 2500));                           // a couple of polls
    // board self-readings (#467): per-stage duration + last error, on every board
    const st = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json());
    assert.ok(st.poll.stages.snapshot.runs >= 1 && Number.isFinite(st.poll.stages.snapshot.ms), 'poll stages are exposed');
    assert.equal(st.poll.stages.snapshot.error, null);
    assert.equal(st.poll.rejections, 0);
    assert.ok(!st.poll.stages.alerts && !st.poll.stages.heartbeat, 'demo never alerts or beats');
    const r = await fetch(`http://127.0.0.1:${port}/api/star`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"shown"}' });
    assert.equal(r.status, 200);
  } finally { child.kill(); }
  const after = await snap();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [], `demo touched: ${changed.join(', ')}`);
});

// ── two demo boards never share a ledger folder (task 526) ──────────────────
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

test('where a demo board keeps its ledger: data/demo-tasks, or the folder MC_DEMO_TASKS names; a named folder must be empty or a demo board\'s own, and the checkout\'s real ledger folder is refused whatever it holds', async () => {
  assert.deepEqual(demoTasksDir('/r', {}), { dir: path.join('/r', 'data', 'demo-tasks'), own: false });
  assert.deepEqual(demoTasksDir('/r', { MC_DEMO_TASKS: '  ' }), { dir: path.join('/r', 'data', 'demo-tasks'), own: false });
  assert.deepEqual(demoTasksDir('/r', { MC_DEMO_TASKS: '/t/x' }), { dir: '/t/x', own: true });
  assert.equal(demoTasksDir('/r', { MC_DEMO_TASKS: 'rel/x' }).dir, path.resolve('rel/x'), 'a relative value is resolved, never used as it is');

  // a new, empty folder: seeded, and marked as a demo board's
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-own-'));
  let L = await seedDemoLedger(dir, createLedger, { own: true, root: REPO });
  assert.equal((await L.list()).length, 5);
  assert.deepEqual((await readdir(dir)).sort(), [DEMO_MARKER, '1.json', '2.json', '3.json', '4.json', '5.json']);
  // the same folder at the next start: the ledger's own files go, the folder and its mark stay, a fresh seed is written
  await writeFile(path.join(dir, '9.json'), '{}');
  await writeFile(path.join(dir, '3.json.4242.tmp'), '{');
  L = await seedDemoLedger(dir, createLedger, { own: true, root: REPO });
  assert.equal((await L.list()).length, 5);
  assert.deepEqual((await readdir(dir)).sort(), [DEMO_MARKER, '1.json', '2.json', '3.json', '4.json', '5.json']);

  const untouched = async (d, want) => { assert.deepEqual((await readdir(d)).sort(), want.sort()); };
  // a folder that holds NOTHING BUT numbered task files and no mark is a real ledger (another install's, a
  // restored copy): refused and left exactly as it was
  const ledgerLike = await mkdtemp(path.join(os.tmpdir(), 'demo-real-'));
  await writeFile(path.join(ledgerLike, '1.json'), '{"mine":true}'); await writeFile(path.join(ledgerLike, '2.json'), '{"mine":true}');
  await assert.rejects(() => seedDemoLedger(ledgerLike, createLedger, { own: true, root: REPO }), /holds files and was not made by a demo board/);
  await untouched(ledgerLike, ['1.json', '2.json']);
  assert.equal(readFileSync(path.join(ledgerLike, '1.json'), 'utf8'), '{"mine":true}');
  // any other folder with files in it: the same
  const other = await mkdtemp(path.join(os.tmpdir(), 'demo-other-'));
  await writeFile(path.join(other, 'notes.txt'), 'mine'); await mkdir(path.join(other, 'sub'));
  await assert.rejects(() => seedDemoLedger(other, createLedger, { own: true, root: REPO }), /holds files and was not made by a demo board/);
  await untouched(other, ['notes.txt', 'sub']);
  // a marked folder into which something else was put: refused too, nothing deleted
  await writeFile(path.join(dir, 'notes.txt'), 'mine');
  await assert.rejects(() => seedDemoLedger(dir, createLedger, { own: true, root: REPO }), /holds other files \(notes\.txt\)/);
  await untouched(dir, [DEMO_MARKER, '1.json', '2.json', '3.json', '4.json', '5.json', 'notes.txt']);

  // the checkout's own ledger folder is refused by its resolved path, whatever it holds: empty, marked, or reached through a link
  const fake = await mkdtemp(path.join(os.tmpdir(), 'demo-root-'));
  const realLedger = path.join(fake, 'data', 'tasks');
  await mkdir(realLedger, { recursive: true });
  await assert.rejects(() => seedDemoLedger(realLedger, createLedger, { own: true, root: fake }), /names this checkout's real ledger folder/);
  await writeFile(path.join(realLedger, '7.json'), '{"real":true}'); await writeFile(path.join(realLedger, DEMO_MARKER), 'x');
  await assert.rejects(() => seedDemoLedger(realLedger, createLedger, { own: true, root: fake }), /names this checkout's real ledger folder/);
  await assert.rejects(() => seedDemoLedger(path.join(fake, 'data', '..', 'data', 'tasks'), createLedger, { own: true, root: fake }), /real ledger folder/);
  const link = path.join(fake, 'link-to-ledger'); symlinkSync(realLedger, link);
  await assert.rejects(() => seedDemoLedger(link, createLedger, { own: true, root: fake }), /real ledger folder/);
  if (process.platform === 'darwin') await assert.rejects(() => seedDemoLedger(path.join(fake, 'DATA', 'Tasks'), createLedger, { own: true, root: fake }), /real ledger folder/);
  assert.equal(readFileSync(path.join(realLedger, '7.json'), 'utf8'), '{"real":true}');

  // the board uses exactly this
  const server = readFileSync(path.join(REPO, 'server.mjs'), 'utf8');
  assert.match(server, /seedDemoLedger\(demoTasksDir\(ROOT\)\.dir, createLedger, \{ own: demoTasksDir\(ROOT\)\.own, root: ROOT \}\)/);
});

test('every test that starts a demo board gives it a ledger folder of its own (demoEnv)', () => {
  const bad = [];
  for (const f of readdirSync(HERE).filter((n) => n.endsWith('.test.mjs'))) {
    readFileSync(path.join(HERE, f), 'utf8').split('\n').forEach((line, i) => {
      // a board is started in demo mode by its environment: the literal belongs in test/demo-board.mjs only
      if (/MC_DEMO\s*[:=]\s*['"]?1/.test(line) && !/^\s*\/\//.test(line) && !line.includes('MC_DEMO\\s')) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(bad, [], `start the board with env: demoEnv({ MC_PORT: … }) from ./demo-board.mjs — ${bad.join(', ')}`);
  const env = demoEnv({ MC_PORT: '1' });
  assert.equal(env.MC_DEMO, '1'); assert.equal(env.MC_PORT, '1');
  assert.ok(existsSync(env.MC_DEMO_TASKS) && readdirSync(env.MC_DEMO_TASKS).length === 0, 'a new, empty folder');
  assert.notEqual(demoEnv().MC_DEMO_TASKS, env.MC_DEMO_TASKS, 'a different folder for every board');
});

test('six demo boards started at the same moment in one checkout all come up (they used to remove each other\'s ledger and die)', { timeout: 40000 }, async () => {
  const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const ports = [];
  for (let i = 0; i < 6; i += 1) ports.push(await freePort());
  const boards = ports.map((port) => {
    const child = spawn(process.execPath, ['server.mjs'], { cwd: REPO, env: demoEnv({ MC_PORT: String(port), ZULU_NO_NOTIFY: '1' }), stdio: ['ignore', 'ignore', 'pipe'] });
    const b = { port, child, err: '', exited: null };
    child.stderr.on('data', (c) => { b.err += c; });
    child.on('exit', (code) => { b.exited = code; });
    return b;
  });
  try {
    const up = await Promise.all(boards.map(async (b) => {
      for (let i = 0; i < 150 && b.exited === null; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const st = await fetch(`http://127.0.0.1:${b.port}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (st?.demo) return true;
      }
      return false;
    }));
    const died = boards.filter((b, i) => !up[i]).map((b) => `port ${b.port}: ${b.exited === null ? 'no answer' : `exit ${b.exited}`} ${b.err.split('\n').find((l) => /Error/.test(l)) || ''}`);
    assert.deepEqual(died, [], 'every board answered');
    // and each has its own five seeded tasks
    for (const b of boards) assert.equal((await fetch(`http://127.0.0.1:${b.port}/api/tasks`).then((r) => r.json())).tasks?.length ?? -1, 5, `board on ${b.port}`);
  } finally { for (const b of boards) b.child.kill(); }
});
