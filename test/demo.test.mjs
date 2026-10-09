// node --test "test/*.test.mjs" — demo mode data (src/demo.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { demoSnapshot, demoDirectory, demoContext, demoBeats, demoHistory, seedDemoLedger, DEMO_DOMAINS, CYCLE_S } from '../src/demo.mjs';
import { createLedger } from '../src/tasks.mjs';

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
        if (e.isDirectory()) await walk(p);
        else { const s = await stat(p).catch(() => null); if (s) out[rel] = `${s.size}:${s.mtimeMs}`; }
      }
    };
    await walk(DATA);
    return out;
  };
  const before = await snap();
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, MC_DEMO: '1', MC_DEMO_POLL: '1', MC_PORT: String(port) }, stdio: 'ignore' });
  try {
    let status = null;
    for (let i = 0; i < 80 && !status; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    assert.ok(status?.demo, 'demo server answered');
    await new Promise((r) => setTimeout(r, 2500));                           // a couple of polls
    const r = await fetch(`http://127.0.0.1:${port}/api/star`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"event":"shown"}' });
    assert.equal(r.status, 200);
  } finally { child.kill(); }
  const after = await snap();
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
  assert.deepEqual(changed, [], `demo touched: ${changed.join(', ')}`);
});
