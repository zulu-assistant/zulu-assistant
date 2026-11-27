// Dock reload after a cold start: only the board's own Dock pages, once, no retry of a reload.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockBrowsers, surfacesToReload, isColdStart, reloadDockOnce, ownDockUrls, COLD_START_MS } from '../src/dock-reload.mjs';

const PORT = 3210;
const TREE = [
  'window window:1 [current] ◀ active',
  '├── workspace workspace:1 "MAIN" [selected] ◀ active',
  '│   ├── pane pane:1 [focused] ◀ active',
  '│   │   └── surface surface:1 [terminal] "shell" [selected] ◀ active',
  '│   └── pane pane:9 [dock:global] [focused]',
  '│       ├── surface surface:10 [browser] [dock:global] "Board" [selected] http://localhost:3210/?dock=1',
  '│       ├── surface surface:11 [browser] [dock:global] "Evidence" http://localhost:3210/?evidence=1',
  '│       ├── surface surface:12 [browser] [dock:global] "TV" http://localhost:3210/?tv',
  '│       ├── surface surface:13 [browser] [dock:global] "Other port" http://localhost:3211/?dock=1',
  '│       ├── surface surface:14 [browser] [dock:global] "Look-alike" http://localhost.example.com:3210/?dock=1',
  '│       ├── surface surface:15 [browser] [dock:global] "Longer path" http://localhost:3210/x/?dock=1',
  '│       ├── surface surface:16 [browser] [dock:global] "Extra query" http://localhost:3210/?dock=1&item=4',
  '│       └── surface surface:17 [terminal] [dock:global] "Feed" [selected]',
  '│   └── pane pane:8 [dock:workspace]',
  '│       └── surface surface:7 [browser] [dock:workspace] "Board" http://localhost:3210/?dock=1',
  '├── workspace workspace:2 "SIDE"',
  '│   └── pane pane:2 [focused]',
  '│       └── surface surface:20 [browser] "Split board" [selected] http://localhost:3210/?dock=1',
  '│   └── pane pane:9 [dock:global]',
  '│       └── surface surface:10 [browser] [dock:global] "Board" [selected] http://localhost:3210/?dock=1',
].join('\n');

test('only global Dock browsers are read, once per surface (a workspace Dock is not)', () => {
  const refs = dockBrowsers(TREE).map((s) => s.ref);
  assert.deepEqual(refs, ['surface:10', 'surface:11', 'surface:12', 'surface:13', 'surface:14', 'surface:15', 'surface:16']);
});

test('exact origin and path: look-alike host, other port, longer path, other query and a split browser never match', () => {
  assert.deepEqual(surfacesToReload(TREE, PORT).map((s) => s.ref), ['surface:10', 'surface:11']);
  assert.ok(ownDockUrls(PORT).has('http://127.0.0.1:3210/?dock=1'));
  assert.ok(!ownDockUrls(PORT).has('https://localhost:3210/?dock=1'));
});

test('cold start window', () => {
  const now = 10 * 3600_000;
  assert.equal(isColdStart(now - 60_000, now), true);
  assert.equal(isColdStart(now - COLD_START_MS, now), false);
  assert.equal(isColdStart(0, now), false);
  assert.equal(isColdStart(now + 1000, now), false);
});

function fakeRun(answers = {}) {
  const calls = [];
  const run = async (args) => {
    calls.push(args.join(' '));
    const key = args.join(' ');
    const a = answers[key];
    if (typeof a === 'function') return a();
    return a || { err: null, out: '' };
  };
  return { run, calls };
}

const NOW = 50 * 3600_000;
const fresh = async () => NOW - 5 * 60_000;

test('a cold start reloads the two own Dock pages, and makes no other call', async () => {
  const { run, calls } = fakeRun({ 'tree --all': { err: null, out: TREE } });
  const lines = [];
  const r = await reloadDockOnce({ port: PORT, run, appStart: fresh, now: () => NOW, log: async (t) => lines.push(t), sleep: async () => {} });
  assert.deepEqual(r.reloaded, ['surface:10', 'surface:11']);
  assert.deepEqual(calls, ['tree --all', 'browser surface:10 reload', 'browser surface:11 reload']);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /2 board pages in the Dock reloaded/);
});

test('cmux older than the window, or its start unread: no call at all', async () => {
  for (const appStart of [async () => NOW - COLD_START_MS - 1, async () => 0, async () => { throw new Error('ps'); }]) {
    const { run, calls } = fakeRun({ 'tree --all': { err: null, out: TREE } });
    const r = await reloadDockOnce({ port: PORT, run, appStart, now: () => NOW, sleep: async () => {} });
    assert.equal(r.ran, false);
    assert.deepEqual(calls, []);
  }
});

test('a failed reload is one ticker line and is never retried', async () => {
  const { run, calls } = fakeRun({ 'tree --all': { err: null, out: TREE }, 'browser surface:10 reload': { err: new Error('x'), out: '' } });
  const lines = [];
  const r = await reloadDockOnce({ port: PORT, run, appStart: fresh, now: () => NOW, log: async (t) => lines.push(t), sleep: async () => {} });
  assert.deepEqual(r.failed, ['surface:10']);
  assert.deepEqual(r.reloaded, ['surface:11']);
  assert.equal(calls.filter((c) => c === 'browser surface:10 reload').length, 1);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /1 failed .*not retried/);
});

test('the tree read is tried twice at most; unread = one line, nothing reloaded', async () => {
  const { run, calls } = fakeRun({ 'tree --all': { err: new Error('socket'), out: '' } });
  const lines = []; const slept = [];
  const r = await reloadDockOnce({ port: PORT, run, appStart: fresh, now: () => NOW, log: async (t) => lines.push(t), sleep: async (ms) => slept.push(ms) });
  assert.equal(r.ran, false);
  assert.deepEqual(calls, ['tree --all', 'tree --all']);
  assert.equal(slept.length, 1);
  assert.equal(lines.length, 1);
});

test('no own Dock page in either read: no reload and no line', async () => {
  const { run, calls } = fakeRun({ 'tree --all': { err: null, out: 'window window:1\n└── surface surface:3 [browser] "x" http://localhost:3210/?dock=1' } });
  const lines = [];
  await reloadDockOnce({ port: PORT, run, appStart: fresh, now: () => NOW, log: async (t) => lines.push(t), sleep: async () => {} });
  assert.deepEqual(calls, ['tree --all', 'tree --all']);
  assert.deepEqual(lines, []);
});

test('a Dock still being restored: the first read shows no board page, the second one does', async () => {
  let n = 0;
  const { run, calls } = fakeRun({ 'tree --all': () => (++n === 1 ? { err: null, out: 'window window:1 [current]' } : { err: null, out: TREE }) });
  const slept = [];
  const r = await reloadDockOnce({ port: PORT, run, appStart: fresh, now: () => NOW, sleep: async (ms) => slept.push(ms) });
  assert.deepEqual(r.reloaded, ['surface:10', 'surface:11']);
  assert.deepEqual(calls, ['tree --all', 'tree --all', 'browser surface:10 reload', 'browser surface:11 reload']);
  assert.equal(slept.length, 1);
});

test('a first read with the board page is not read again', async () => {
  const { run, calls } = fakeRun({ 'tree --all': { err: null, out: TREE } });
  const slept = [];
  await reloadDockOnce({ port: PORT, run, appStart: fresh, now: () => NOW, sleep: async (ms) => slept.push(ms) });
  assert.equal(calls.filter((c) => c === 'tree --all').length, 1);
  assert.deepEqual(slept, []);
});
