// Loads the real cmux sidebar (system/cmux/sidebars/phosphor.js) with a stub
// runtime to test its data logic: ATTENTION filter/sort, quiet folding, calm
// line, and mode-specific keys. Rendering itself is cmux's (not testable here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function load(workspaces, groups = []) {
  const src = await readFile(new URL('../system/cmux/sidebars/phosphor.js', import.meta.url), 'utf8');
  const node = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : () => node()), apply: () => node() });
  const signal = (v) => { let x = v; return [() => x, (n) => { x = n; }]; };
  const computed = (fn) => fn;
  const data = { workspaces: () => workspaces, groups: () => groups, clock: () => ({ epoch: 1000, time: '12:00:00' }), unreadTotal: () => 0 };
  const views = Object.fromEntries(['VStack', 'HStack', 'ZStack', 'Text', 'Image', 'Rectangle', 'Spacer', 'Reorderable', 'ForEach', 'Divider']
    .map((n) => [n, () => node()]));
  const fn = new Function('signal', 'computed', 'data', 'cmux', 'sidebar', ...Object.keys(views),
    `${src}\nreturn { entries, setMode, attentionOf, stateOf, STATE };`);
  return fn(signal, computed, data, () => {}, () => {}, ...Object.values(views));
}

const ag = (status, since) => [{ kind: 'claude', status, sinceEpoch: since }];
const G = [{ id: 'g-store', name: 'STORE', color: '#E500E5' }, { id: 'g-mkt', name: 'MARKETING' }];

test('ATTENTION: only rows that need the owner, sorted INPUT → APPROVAL → BLOCKED → UNREAD, oldest first', async () => {
  const ws = [
    { id: 'idle1', title: 'A', group: 'g-store', agents: ag('idle', 1), unread: 0 },
    { id: 'unread', title: 'B', group: 'g-mkt', agents: ag('idle', 5), unread: 2 },
    { id: 'blocked', title: 'C', group: 'g-store', agents: ag('working', 3), unread: 0, progress: { value: 0, label: '#9 BLOCKED · 0/4' } },
    { id: 'input-new', title: 'D', agents: ag('idle', 900), unread: 0, progress: { value: 0, label: '▲ INPUT · permission' } },
    { id: 'input-old', title: 'E', group: 'g-mkt', agents: ag('idle', 100), unread: 1, progress: { value: 0, label: '▲ INPUT · #3 WORKING · 0/4' } },
    { id: 'cmux-says-input', title: 'H', group: 'g-store', agents: ag('needs_input', 50), unread: 0 },
    { id: 'approval', title: 'F', agents: ag('idle', 50), unread: 0, progress: { value: 0.5, label: '#7 APPROVAL · 2/4' } },
    { id: 'run1', title: 'G', group: 'g-store', agents: ag('working', 2), unread: 0, progress: { value: 0, label: '#8 WORKING · 0/4' } },
  ];
  const sb = await load(ws, G);
  const e = sb.entries();
  assert.deepEqual(e.filter((x) => x.attention).map((x) => x.wsId), ['input-old', 'input-new', 'approval', 'blocked', 'unread']);
  assert.ok(e.filter((x) => x.attention).every((x) => x.id.startsWith('a:')), 'attention keys are mode-specific');
  const quiet = e.filter((x) => x.kind === 'quiet');
  assert.deepEqual(quiet.map((q) => [q.groupId, q.running, q.idle]), [['g-store', 1, 2]],
    "quiet rows fold into per-group counts; cmux's own needs_input counts as idle");
  assert.equal(e.filter((x) => x.kind === 'bar').length, 0, 'no bars without a context gauge in the label');
  assert.ok(!e.some((x) => x.kind === 'calm'));
});

test('ATTENTION with nothing to do shows one calm line; ALL shows the grouped roster', async () => {
  const ws = [
    { id: 'a', title: 'A', group: 'g-store', agents: ag('idle', 1), unread: 0 },
    { id: 'b', title: 'B', agents: ag('working', 1), unread: 0 },
  ];
  const sb = await load(ws, G);
  const e = sb.entries();
  assert.equal(e[0].kind, 'calm');
  assert.equal(e.filter((x) => x.kind === 'ws').length, 0);
  sb.setMode('all');
  const all = sb.entries();
  assert.deepEqual(all.map((x) => x.kind), ['header', 'ws', 'header', 'ws']);
  assert.deepEqual(all.filter((x) => x.kind === 'ws').map((x) => x.id), ['a', 'b'], 'ALL keys are plain workspace ids');
});

test('INPUT comes only from the board-verified progress label, never from cmux needs_input', async () => {
  const ws = [
    { id: 'x', title: 'X', agents: ag('needs_input', 1), unread: 0 },
    { id: 'y', title: 'Y', agents: ag('idle', 1), unread: 0, progress: { value: 0, label: '▲ INPUT · permission' } },
  ];
  const sb = await load(ws, []);
  assert.equal(sb.stateOf(ws[0]), sb.STATE.idle);
  assert.equal(sb.stateOf(ws[1]), sb.STATE.input);
  assert.deepEqual(sb.entries().filter((x) => x.attention).map((x) => x.wsId), ['y']);
});

test('ALL mode: a context bar follows rows the board measured, width + band color static in the entry', async () => {
  const ws = [
    { id: 'a', title: 'A', agents: ag('working', 1), unread: 0, progress: { value: 0.5, label: 'ctx 50% · #4 WORKING · 2/4' } },
    { id: 'b', title: 'B', agents: ag('idle', 1), unread: 0 },
  ];
  const sb = await load(ws, []);
  sb.setMode('all');
  const e = sb.entries();
  assert.deepEqual(e.map((x) => x.kind), ['header', 'ws', 'bar', 'ws']);
  assert.equal(e[2].px, 60);
  assert.match(e[2].id, /^b:a:60$/);
  assert.equal(e[2].color, '#00A600');
  const hot = await load([{ id: 'h', title: 'H', agents: ag('idle', 1), unread: 0, progress: { value: 0.85, label: 'ctx 85%' } }], []);
  hot.setMode('all');
  assert.equal(hot.entries().find((x) => x.kind === 'bar').color, '#FF4444');
});
