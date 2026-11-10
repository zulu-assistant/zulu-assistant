import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hookFor, pidCheck, needsScreen, agentState, createScreenReader, parseProcStarts, observeLines, stateView, taxonomyMode, STATES } from '../src/agent-state.mjs';
import { withState, pillSignature, ownerPill, withContext } from '../src/chrome.mjs';

// Status taxonomy (#402): neutral fixtures only — no cmux, no live board.
const NOW = Date.parse('2026-01-05T12:00:00Z');
const sec = (ms) => ms / 1000;
const hook = (over = {}) => ({ lifecycle: 'idle', updatedAt: sec(NOW) - 60, pid: 100, pidStart: 1000, sessionId: 's1', ...over });
const procs = new Map([[100, 1000], [200, 5000]]);

test('hookFor: the newest entry across the claude and codex hook files', () => {
  const claude = { activeSessionsByWorkspace: { W1: { sessionId: 'a' } }, sessions: { a: { agentLifecycle: 'running', updatedAt: 10, pid: 1, pidStartSeconds: 5, sessionId: 'a' } } };
  const codex = { sessions: { x: { workspaceId: 'W2', agentLifecycle: 'idle', updatedAt: 20, pid: 2, sessionId: 'x' }, y: { workspaceId: 'W2', agentLifecycle: 'running', updatedAt: 30, pid: 3, sessionId: 'y' } } };
  assert.deepEqual(hookFor('W1', { claude, codex }), { lifecycle: 'running', updatedAt: 10, pid: 1, pidStart: 5, sessionId: 'a' });
  assert.equal(hookFor('W2', { claude, codex }).sessionId, 'y');
  assert.equal(hookFor('W3', { claude, codex }), null);
});

test('pidCheck: alive, dead, recycled (start time differs), unknown', () => {
  assert.equal(pidCheck(hook(), procs), 'alive');
  assert.equal(pidCheck(hook({ pid: 300 }), procs), 'dead');
  assert.equal(pidCheck(hook({ pid: 200 }), procs), 'recycled');
  assert.equal(pidCheck(null, procs), 'unknown');
  assert.equal(pidCheck(hook(), null), 'unknown');
  const m = parseProcStarts('  100 Mon Jan  5 11:00:00 2026\n 2 garbage\nnot a line');
  assert.equal(m.size, 1);
  assert.equal(m.get(100), Math.round(new Date(2026, 0, 5, 11, 0, 0).getTime() / 1000));
});

test('rules: hook high while its pid lives; stale running = low; dialog beats hook idle; unknown says why', () => {
  const st = (h, pid, screen) => agentState({ hook: h, pid, screen, now: NOW });
  assert.deepEqual(st(hook(), 'alive'), { state: 'idle', source: 'reported:hook', confidence: 'high', age: 60, why: 'hook: idle' });
  assert.equal(st(hook({ lifecycle: 'needsInput' }), 'alive').state, 'input');
  assert.equal(st(hook({ lifecycle: 'running', updatedAt: sec(NOW) - 300 }), 'alive').confidence, 'high');
  const stale = st(hook({ lifecycle: 'running', updatedAt: sec(NOW) - 42 * 60 }), 'alive');
  assert.deepEqual([stale.state, stale.confidence, stale.why], ['working', 'low', 'running? (reported 42m ago)']);
  const dlg = st(hook(), 'alive', { state: 'dialog', at: NOW - 5000, agree: false });
  assert.deepEqual([dlg.state, dlg.source, dlg.confidence], ['input', 'inferred:screen', 'low'], 'one read is enough for input, low until a second agrees');
  assert.match(dlg.why, /hook says idle/);
  assert.equal(st(hook(), 'alive', { state: 'dialog', at: NOW, agree: true }).confidence, 'high');
  const dead = st(hook(), 'dead');
  assert.deepEqual([dead.state, dead.confidence], ['stopped', 'high']);
  assert.match(dead.why, /pid 100 is gone/);
  assert.equal(st(hook(), 'recycled').state, 'stopped');
  const codex = st(null, 'unknown', { state: 'busy', at: NOW - 30000, agree: true });
  assert.deepEqual([codex.state, codex.source, codex.confidence, codex.age], ['working', 'inferred:screen', 'high', 30]);
  assert.equal(st(null, 'unknown', { state: 'draft', busy: true, at: NOW }).state, 'working');
  assert.match(st(null, 'unknown', { state: 'draft', at: NOW }).why, /draft in the input box/);
  const unk = st(null, 'unknown', { state: 'unknown', at: NOW });
  assert.deepEqual([unk.state, unk.source, unk.confidence], ['unknown', 'none', 'none']);
  assert.match(unk.why, /no hook entry; screen not recognised/);
  assert.match(st(null, 'unknown', null).why, /no screen read/);
  assert.match(st(null, 'unknown', { state: 'unreadable', at: NOW }).why, /not recognised \(unreadable\)/);
});

test('never "done": no combination of inputs yields a state outside the taxonomy', () => {
  const hooks = [null, ...['running', 'idle', 'needsInput', 'weird'].map((l) => hook({ lifecycle: l })), hook({ lifecycle: 'running', updatedAt: 0 })];
  const screens = [null, ...['busy', 'dialog', 'ready', 'shell', 'draft', 'unknown', 'unreadable'].map((s) => ({ state: s, at: NOW }))];
  for (const h of hooks) for (const p of ['alive', 'dead', 'recycled', 'unknown']) for (const s of screens) {
    const r = agentState({ hook: h, pid: p, screen: s, now: NOW });
    assert.ok(STATES.includes(r.state), JSON.stringify(r));
    assert.notEqual(r.state, 'done');
    assert.ok(['reported:hook', 'inferred:screen', 'none'].includes(r.source));
    assert.ok(r.why);
  }
});

test('screen reads: only where the hook cannot answer; capped per pass; cached; agreement', async () => {
  const fresh = { now: NOW, runningFreshMinutes: 20 };
  assert.equal(needsScreen({ vendor: 'claude' }, hook(), 'alive', fresh), false, 'a fresh claude hook costs nothing');
  assert.equal(needsScreen({ vendor: 'codex' }, hook(), 'alive', fresh), true);
  assert.equal(needsScreen({ vendor: 'claude' }, null, 'unknown', fresh), true);
  assert.equal(needsScreen({ vendor: 'claude' }, hook({ lifecycle: 'running', updatedAt: sec(NOW) - 3600 }), 'alive', fresh), true);
  assert.equal(needsScreen({ vendor: 'claude' }, hook({ lifecycle: 'unknown' }), 'alive', fresh), true, 'an unrecognised lifecycle (Codex after a reboot) needs a read');
  const u = agentState({ hook: hook({ lifecycle: 'unknown' }), pid: 'alive', screen: null, now: NOW });
  assert.equal(u.state, 'unknown');
  assert.match(u.why, /hook reports lifecycle unknown/);
  let calls = 0;
  const r = createScreenReader({ read: async () => { calls++; return { out: 'x' }; }, classify: () => ({ state: 'busy' }), cap: 3, ttlMs: 120000 });
  const ws = ['A', 'B', 'C', 'D', 'E'];
  const p1 = await r.refresh(ws, NOW);
  assert.equal(p1.reads, 3, 'capped');
  assert.equal(p1.results.size, 3);
  const p2 = await r.refresh(ws, NOW + 1000);
  assert.equal(p2.reads, 2, 'the rest next pass; cached ones not re-read');
  const p3 = await r.refresh(ws, NOW + 2000);
  assert.equal(p3.reads, 0, 'all inside the 2-min cache');
  const p4 = await r.refresh(ws, NOW + 121000);
  assert.equal(p4.reads, 3);
  assert.equal(p4.results.get('A').agree, true, 'second read agrees with the first');
  assert.equal(calls, 8);
  const r2 = createScreenReader({ read: async () => ({ err: 'socket' }), classify: () => ({ state: 'busy' }) });
  assert.equal((await r2.refresh(['Z'], NOW)).results.get('Z').state, 'unreadable');
  await r.refresh(['A'], NOW + 500000);
  assert.ok(!r.cache.has('B'), 'agents that no longer need reads leave the cache');
});

test('observe lines: on a source change or unknown, at most one per agent per 10 min', () => {
  const last = new Map();
  const row = (name, state, source, confidence = 'high') => ({ name, state: { state, source, confidence, why: 'w' } });
  assert.deepEqual(observeLines([row('a', 'idle', 'reported:hook')], last, { now: NOW }), [], 'a plain hook report on first sight is quiet');
  assert.equal(observeLines([row('b', 'unknown', 'none', 'none')], last, { now: NOW }).length, 1);
  const lines = observeLines([row('a', 'working', 'inferred:screen', 'low')], last, { now: NOW + 1000 });
  assert.match(lines[0], /^status \(observe\): a working\? · inferred:screen/);
  assert.deepEqual(observeLines([row('a', 'idle', 'reported:hook')], last, { now: NOW + 2000 }), [], 'rate-limited');
  assert.equal(observeLines([row('a', 'unknown', 'none', 'none')], last, { now: NOW + 700000 }).length, 1);
});

test('display: glyph + label (+ "?" when unsure), mode, the state pill and the sidebar prefix', () => {
  assert.deepEqual(stateView({ state: 'working', source: 'inferred:screen', confidence: 'low', age: 30, why: 'w' }).label, 'WORKING?');
  assert.equal(stateView({ state: 'working', source: 'inferred:screen', confidence: 'low', age: 30, why: 'w' }).glyph, '◌');
  assert.equal(stateView({ state: 'unknown', source: 'none', confidence: 'none', age: null, why: 'w' }).label, 'UNKNOWN');
  assert.equal(stateView(null), null);
  assert.equal(taxonomyMode(undefined, 'a'), 'off');
  assert.equal(taxonomyMode({ mode: 'observe' }, 'a'), 'observe');
  assert.equal(taxonomyMode({ mode: 'on', only: ['b'] }, 'a'), 'off');
  const base = withContext(ownerPill([{ id: 4, status: 'in_progress', checklist: { a: false } }]), null);
  assert.equal(pillSignature(withState(base, null, null)), pillSignature(base), 'no state → the pill set is untouched (no rewrite on deploy)');
  const unk = { state: 'unknown', source: 'none', confidence: 'none', age: null, why: 'w' };
  const u = withState(base, stateView(unk), unk);
  assert.match(u.progress.label, /^\? · #4 /);
  assert.equal(u.statePill.key, 'state');
  const lowIn = { state: 'input', source: 'inferred:screen', confidence: 'low', age: 1, why: 'w' };
  assert.match(withState(base, stateView(lowIn), lowIn).progress.label, /^▲\? · #4/);
  const verified = { ...base, progress: { value: 0, label: '▲ INPUT · #4 WORKING' } };
  assert.equal(withState(verified, stateView(lowIn), lowIn).progress.label, '▲ INPUT · #4 WORKING', 'a verified prompt is not doubled');
  const idle = { state: 'idle', source: 'reported:hook', confidence: 'high', age: 1, why: 'w' };
  assert.equal(withState(base, stateView(idle), idle).progress.label, base.progress.label, 'no prefix for a known state');
});
