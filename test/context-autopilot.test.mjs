import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nextAction, attempted, inScope, continuityFile, thresholds, runAutopilot, DEFAULTS } from '../src/context-autopilot.mjs';
import { band } from '../src/context.mjs';
import { NEVER_SUPERSEDED } from '../src/mesh.mjs';

const t = DEFAULTS;
const MIN = 60e3;
const T0 = Date.parse('2026-11-01T10:00:00Z');

test('thresholds: 70/80/90 by default; the old amber/red keys still work; the gauge bands follow', () => {
  assert.deepEqual([t.warnPct, t.compactPct, t.forcePct], [70, 80, 90]);
  const old = thresholds({ amberPct: 60, redPct: 85 });
  assert.deepEqual([old.warnPct, old.compactPct, old.forcePct], [60, 85, 90]);
  assert.equal(thresholds({ warnPct: 65 }, { cooldownMinutes: 5 }).cooldownMinutes, 5);
  assert.equal(band(69), 'ok'); assert.equal(band(70), 'amber'); assert.equal(band(80), 'red');
});

test('warn once at 70%, then nothing until the state is saved', () => {
  let r = nextAction(null, { pct: 65 }, { now: T0 });
  assert.equal(r.action, null);
  r = nextAction(null, { pct: 71 }, { now: T0 });
  assert.equal(r.action, 'warn'); assert.equal(r.next.phase, 'warned'); assert.equal(r.next.warnedAt, T0);
  const again = nextAction(r.next, { pct: 75 }, { now: T0 + MIN });
  assert.equal(again.action, null);
  // at 80% with a state file older than the warn: wait
  assert.equal(nextAction(r.next, { pct: 82 }, { now: T0 + 2 * MIN, fresh: T0 - 5 * MIN }).action, null);
  // saved after the warn: compact (not forced)
  const c = nextAction(r.next, { pct: 82 }, { now: T0 + 3 * MIN, fresh: T0 + 2 * MIN });
  assert.equal(c.action, 'compact'); assert.equal(c.forced, false);
});

test('at 90% compact even with stale state (forced); saved state at 90% is not forced', () => {
  const w = nextAction(null, { pct: 72 }, { now: T0 }).next;
  const f = nextAction(w, { pct: 91 }, { now: T0 + MIN, fresh: 0 });
  assert.equal(f.action, 'compact'); assert.equal(f.forced, true);
  const s = nextAction(w, { pct: 91 }, { now: T0 + MIN, fresh: T0 + 30e3 });
  assert.equal(s.action, 'compact'); assert.equal(s.forced, false);
  // entering straight at 93%: warn first, the next pass forces
  const first = nextAction(null, { pct: 93 }, { now: T0 });
  assert.equal(first.action, 'warn');
  assert.equal(nextAction(first.next, { pct: 93 }, { now: T0 + MIN }).forced, true);
});

test('after /compact is typed: a compaction (estimate or a drop below warn) → resume; the episode ends', () => {
  const w = nextAction(null, { pct: 72 }, { now: T0 }).next;
  const c = attempted(w, T0 + MIN);
  assert.equal(c.phase, 'compacting');
  assert.equal(nextAction(c, { pct: 83 }, { now: T0 + 2 * MIN }).action, null);           // still waiting
  const est = nextAction(c, { pct: 4, estimated: true }, { now: T0 + 3 * MIN });
  assert.equal(est.action, 'resume'); assert.equal(est.next.phase, 'ok');
  const codex = nextAction(c, { pct: 12 }, { now: T0 + 3 * MIN });                         // Codex: a drop
  assert.equal(codex.action, 'resume');
  // ok again: no new warn below 70, and a new episode later warns again
  assert.equal(nextAction(est.next, { pct: 20 }, { now: T0 + 4 * MIN }).action, null);
  assert.equal(nextAction(est.next, { pct: 71 }, { now: T0 + 60 * MIN }).action, 'warn');
});

test('no compaction within 10 min = a failure; cooldown between tries; 3 failures → give up (MC told)', () => {
  let rec = attempted(nextAction(null, { pct: 72 }, { now: T0 }).next, T0);
  let r = nextAction(rec, { pct: 85 }, { now: T0 + 11 * MIN });
  assert.equal(r.action, 'fail'); assert.equal(r.next.failures, 1); assert.equal(r.next.phase, 'warned');
  // the cooldown counts from the attempt: 11 min later it may try again
  assert.equal(nextAction(r.next, { pct: 91 }, { now: T0 + 11 * MIN }).action, 'compact');
  assert.equal(nextAction({ ...r.next, attemptAt: T0 + 5 * MIN }, { pct: 91 }, { now: T0 + 11 * MIN }).action, null);
  rec = attempted(r.next, T0 + 12 * MIN);
  r = nextAction(rec, { pct: 85 }, { now: T0 + 23 * MIN });
  assert.equal(r.action, 'fail');
  rec = attempted(r.next, T0 + 24 * MIN);
  r = nextAction(rec, { pct: 85 }, { now: T0 + 35 * MIN });
  assert.equal(r.action, 'giveup'); assert.equal(r.next.phase, 'stopped');
  assert.equal(nextAction(r.next, { pct: 95 }, { now: T0 + 50 * MIN }).action, null);       // stays stopped
  assert.equal(nextAction(r.next, { pct: 10, estimated: true }, { now: T0 + 60 * MIN }).action, 'reset');
});

test('a warned agent that compacts itself (pct falls) just resets; an estimate above warn is ignored', () => {
  const w = nextAction(null, { pct: 72 }, { now: T0 }).next;
  assert.equal(nextAction(w, { pct: 8, estimated: true }, { now: T0 + MIN }).action, 'reset');
  assert.equal(nextAction(null, { pct: 75, estimated: true }, { now: T0 }).action, null);
  assert.equal(nextAction(w, null, { now: T0 }).action, null);                             // no gauge
});

test('scope: off/observe/on, only/exclude, vendors, closed panes, local-model profiles', () => {
  const a = { name: 'res-a', workspaceId: 'W1', vendor: 'claude', kind: 'resident' };
  assert.equal(inScope(a, { mode: 'off' }), false);
  assert.equal(inScope(a, null), false);
  assert.equal(inScope(a, { mode: 'on' }), true);
  assert.equal(inScope(a, { mode: 'observe', only: ['res-b'] }), false);
  assert.equal(inScope(a, { mode: 'on', only: ['res-a'] }), true);
  assert.equal(inScope(a, { mode: 'on', exclude: ['res-a'] }), false);
  assert.equal(inScope({ ...a, status: 'closed' }, { mode: 'on' }), false);
  assert.equal(inScope({ ...a, vendor: 'shell' }, { mode: 'on' }), false);
  assert.equal(inScope({ ...a, workspaceId: null }, { mode: 'on' }), false);
  assert.equal(inScope({ ...a, profile: 'local' }, { mode: 'on' }), false);
});

test('continuity file: settings map → agent field → resident default; workers have none', () => {
  const home = '/h';
  const res = { name: 'res-a', kind: 'resident', repo: '~/proj a' };
  assert.equal(continuityFile(res, {}, { home }), '/h/proj a/.claude/RESIDENT-STATE.md');
  assert.equal(continuityFile({ ...res, name: 'mc', kind: 'mission-control' }, { continuity: { mc: 'data/STATE.md' } }, { home }), '/h/proj a/data/STATE.md');
  assert.equal(continuityFile({ ...res, continuity: '~/notes/x.md' }, {}, { home }), '/h/notes/x.md');
  assert.equal(continuityFile({ name: 'w', kind: 'worker', repo: '~/p' }, {}, { home }), null);
});

test('context messages are never superseded in the outbox', () => {
  assert.ok(NEVER_SUPERSEDED.has('context'));
});

// ---- runAutopilot: the I/O pass with injected deps ----------------------------------------

function harness({ cfg = { mode: 'on' }, gauges, ready = true, mtimes = {} }) {
  const log = { tell: [], mc: [], compact: [], comment: [], event: [] };
  return {
    log,
    deps: (dir, now) => ({
      ctx: new Map(Object.entries(gauges)), cfg, t, now,
      stateFile: path.join(dir, 'context-state.json'),
      mtime: async (f) => mtimes[f] || 0,
      focusFor: async () => 7,
      commentAt: async () => 0,
      compact: async (a) => { log.compact.push(a.name); return ready ? { delivered: true } : { queued: 'target busy' }; },
      tell: async (a, text) => { log.tell.push([a.name, text]); },
      tellMC: async (text) => { log.mc.push(text); },
      comment: async (id, text) => { log.comment.push([id, text]); },
      event: (k, text) => { log.event.push(text); },
    }),
  };
}
const agents = [
  { name: 'res-a', workspaceId: 'W1', vendor: 'claude', kind: 'resident', repo: '/r/a' },
  { name: 'res-b', workspaceId: 'W2', vendor: 'codex', kind: 'resident', repo: '/r/b' },
];

test('runAutopilot: warns, then compacts a READY pane once the state file is newer, then resumes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctx ap-'));
  const h = harness({ gauges: { W1: { pct: 72 }, W2: { pct: 40 } } });
  let r = await runAutopilot(agents, h.deps(dir, T0));
  assert.deepEqual(r.changed.map((c) => c.action), ['warn']);
  assert.match(h.log.tell[0][1], /context 72% — finish the current step, then update \/r\/a\/\.claude\/RESIDENT-STATE\.md/);
  assert.equal(r.phases.get('W1'), 'saving state');
  assert.deepEqual(h.log.comment[0][0], 7);
  const saved = harness({ gauges: { W1: { pct: 84 } }, mtimes: { '/r/a/.claude/RESIDENT-STATE.md': T0 + MIN } });
  r = await runAutopilot(agents, saved.deps(dir, T0 + 2 * MIN));
  assert.deepEqual(saved.log.compact, ['res-a']);
  assert.equal(r.phases.get('W1'), 'compacting');
  assert.match(saved.log.comment[0][1], /compacted at 84% by the board/);
  assert.equal(saved.log.mc.length, 0);
  const st = JSON.parse(await readFile(path.join(dir, 'context-state.json'), 'utf8'));
  assert.equal(st.W1.phase, 'compacting'); assert.equal(st.W1.name, 'res-a');
  const after = harness({ gauges: { W1: { pct: 3, estimated: true } } });
  r = await runAutopilot(agents, after.deps(dir, T0 + 4 * MIN));
  assert.deepEqual(r.changed.map((c) => c.action), ['resume']);
  assert.match(after.log.tell[0][1], /compacted by the board at 3% — re-read \/r\/a\/\.claude\/RESIDENT-STATE\.md \(RESUME HERE\) and continue with #7/);
});

test('runAutopilot: a pane that is not READY is never typed into and no attempt is recorded', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctx ap-'));
  await runAutopilot(agents, harness({ gauges: { W1: { pct: 72 } } }).deps(dir, T0));
  const busy = harness({ gauges: { W1: { pct: 92 } }, ready: false });
  const r = await runAutopilot(agents, busy.deps(dir, T0 + MIN));
  assert.equal(r.changed.length, 0);
  assert.equal(r.phases.get('W1'), 'saving state');
  assert.equal(busy.log.mc.length, 0);
  // next pass, READY: forced, and Mission Control hears about it once
  const ok = harness({ gauges: { W1: { pct: 92 } } });
  await runAutopilot(agents, ok.deps(dir, T0 + 2 * MIN));
  assert.equal(ok.log.compact.length, 1);
  assert.match(ok.log.mc[0], /forced \/compact of res-a at 92% \(no state file\)/);
});

test('runAutopilot observe mode: ticker lines only — no messages, no /compact, no comments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctx ap-'));
  const h = harness({ cfg: { mode: 'observe' }, gauges: { W1: { pct: 91 } } });
  await runAutopilot(agents, h.deps(dir, T0));
  await runAutopilot(agents, h.deps(dir, T0 + MIN));
  assert.equal(h.log.tell.length + h.log.compact.length + h.log.comment.length + h.log.mc.length, 0);
  assert.deepEqual(h.log.event, ['context autopilot (observe): would warn res-a at 91%', 'context autopilot (observe): would compact (forced) res-a at 91%']);
});

test('runAutopilot: mode off touches nothing and writes no state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ctx ap-'));
  const h = harness({ cfg: { mode: 'off' }, gauges: { W1: { pct: 95 } } });
  const r = await runAutopilot(agents, h.deps(dir, T0));
  assert.equal(r.changed.length, 0);
  await assert.rejects(readFile(path.join(dir, 'context-state.json')));
});
