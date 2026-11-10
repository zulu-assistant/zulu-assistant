// Evidence panel (src/evidence.mjs + public/evidence.js): rows from a fixture ledger,
// secret redaction, limit/filter, the page render, and the off switch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { evidenceRows, evidenceRow, evidenceMode, safeText, receipt, WITHHELD, MAX_LIMIT } from '../src/evidence.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/evidence.js'), { globalThis: ctx });
const view = ctx.EvidenceView;

const NOW = Date.parse('2026-01-20T12:00:00Z');
const day = 86400e3;
const iso = (ms) => new Date(ms).toISOString();
const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123';

const packet = (over = {}) => ({
  at: iso(NOW - day), requested: 'Add a widget — make the widget', stale: null,
  pr: { url: 'https://github.com/example/repo/pull/7', number: 7, state: 'MERGED', head: 'abc1234def', merge: 'fff0000' },
  tests: [{ command: 'node --test', exit: 0, rev: 'abc1234', branch: 'task/1-widget', dirty: false, at: iso(NOW - day), ms: 900, stale: null }],
  unrun: ['live smoke: needs the owner'], gates: [{ id: 'g1', cls: 'merge', status: 'executed' }],
  summary: { text: 'widget shipped', generated: true }, ...over,
});

const gate = (over = {}) => ({
  id: 'g1', cls: 'merge', label: 'Merge a pull request', command: 'gh pr merge 7 --squash', status: 'executed',
  requested_at: iso(NOW - day - 600e3), decided_at: iso(NOW - day - 300e3), executed_at: iso(NOW - day - 200e3),
  decision: 'approve', decided_by: 'owner', via: 'board', reason: null, ...over,
});

const fixture = () => [
  { id: 1, title: 'Add a widget', status: 'done', owner: 'worker-a', updated_at: iso(NOW - day), closed_at: iso(NOW - day),
    links: { pr: 'https://github.com/example/repo/pull/7' }, evidence: packet(), gates: [gate()] },
  { id: 2, title: 'Old close', status: 'done', owner: 'worker-a', updated_at: iso(NOW - 20 * day), closed_at: iso(NOW - 20 * day) },
  { id: 3, title: 'Closed without packet', status: 'done', owner: 'worker-b', updated_at: iso(NOW - 2 * day), closed_at: iso(NOW - 2 * day) },
  { id: 4, title: 'Live work', status: 'in_progress', owner: 'worker-b', updated_at: iso(NOW - 3 * day),
    gates: [gate({ id: 'g2', cls: 'deploy-local', status: 'approved', executed_at: null, via: 'standing', go: 'go1', decided_by: 'owner', reason: 'auto-approved under program go go1' })] },
  { id: 5, title: 'Cancelled', status: 'cancelled', owner: 'worker-c', updated_at: iso(NOW - 3 * day), closed_at: iso(NOW - 3 * day) },
  { id: 6, title: 'Stale close', status: 'done', owner: 'worker-c', updated_at: iso(NOW - 4 * day), closed_at: iso(NOW - 4 * day),
    evidence: packet({ stale: 'dirty tree', tests: [{ command: `deploy --token=${SECRET}`, exit: 1, rev: null, dirty: true, at: iso(NOW - 4 * day), stale: 'dirty tree' }] }) },
];

test('evidenceMode: only "on" turns the panel on', () => {
  assert.equal(evidenceMode(undefined), 'off');
  assert.equal(evidenceMode({ mode: 'off' }), 'off');
  assert.equal(evidenceMode({ mode: 'observe' }), 'off');
  assert.equal(evidenceMode({ mode: 'on' }), 'on');
});

test('evidenceRows: live first, then closed in the last 14 days, newest first; old closes drop out', () => {
  const { rows, total } = evidenceRows(fixture(), { now: NOW });
  assert.deepEqual(rows.map((r) => r.id), [4, 1, 3, 5, 6]);
  assert.equal(total, 5);
  assert.equal(rows[0].live, true);
});

test('evidenceRows: a done task without a packet is marked missing; cancelled and live are not', () => {
  const by = Object.fromEntries(evidenceRows(fixture(), { now: NOW }).rows.map((r) => [r.id, r]));
  assert.equal(by[3].missing, true);
  assert.equal(by[1].missing, false);
  assert.equal(by[5].missing, false);
  assert.equal(by[4].missing, false);
});

test('evidenceRows: limit is clamped, task= picks one id even outside the window, q filters', () => {
  assert.equal(evidenceRows(fixture(), { now: NOW, limit: 2 }).rows.length, 2);
  assert.equal(evidenceRows(fixture(), { now: NOW, limit: 2 }).total, 5);
  assert.equal(evidenceRows(fixture(), { now: NOW, limit: 9999 }).limit, MAX_LIMIT);
  assert.equal(evidenceRows(fixture(), { now: NOW, limit: 'x' }).rows.length, 5);
  assert.deepEqual(evidenceRows(fixture(), { now: NOW, task: '2' }).rows.map((r) => r.id), [2]);
  assert.deepEqual(evidenceRows(fixture(), { now: NOW, task: '#4' }).rows.map((r) => r.id), [4]);
  assert.deepEqual(evidenceRows(fixture(), { now: NOW, task: 99 }).rows, []);
  assert.deepEqual(evidenceRows(fixture(), { now: NOW, q: 'WORKER-B' }).rows.map((r) => r.id), [4, 3]);
  assert.deepEqual(evidenceRows(fixture(), { now: NOW, q: 'deploy-local' }).rows.map((r) => r.id), [4]);
});

test('secret redaction: a stamp command with a secret-looking token is withheld whole', () => {
  const r = evidenceRows(fixture(), { now: NOW, task: 6 }).rows[0];
  assert.equal(r.packet.tests[0].command, WITHHELD);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  assert.equal(safeText(`password: ${SECRET}`), WITHHELD);
  assert.equal(safeText('node --test'), 'node --test');
  assert.equal(safeText(null), null);
});

test('receipts: never carry the gate command; standing approvals read as the program go', () => {
  const g = receipt(gate({ command: `curl -H "x: ${SECRET}"`, label: `run ${SECRET}` }));
  assert.equal('command' in g, false);
  assert.equal(g.label, WITHHELD);
  const auto = evidenceRow(fixture()[3]).gates[0];
  assert.deepEqual({ ...auto.auto }, { go: 'go1' });
  assert.equal(auto.decided_by, null);
  assert.ok(!JSON.stringify(evidenceRows(fixture(), { now: NOW })).includes('gh pr merge'));
});

test('page render: packet, receipts, missing marker, STALE badge, escaped text', () => {
  const tasks = fixture();
  tasks[0].title = 'Add a <script>widget</script>';
  const rows = evidenceRows(tasks, { now: NOW }).rows;
  const html = view.renderRows(rows, new Set(['1']));
  assert.match(html, /LIVE · 1/);
  assert.match(html, /CLOSED · 4/);
  assert.match(html, /<details class="ev-row" data-id="1" open>/);
  assert.match(html, /PR #7 @abc1234 merged/);
  assert.match(html, /✓ <code>node --test<\/code> exit 0 @abc1234/);
  assert.match(html, /not run: live smoke: needs the owner/);
  assert.match(html, /summary \(generated\):<\/span> widget shipped/);
  assert.match(html, /approved by owner via board/);
  assert.match(html, /auto-approved under program go go1/);
  assert.match(html, /✗ EVIDENCE MISSING/);
  assert.match(html, /⚠ STALE/);
  assert.match(html, /\[withheld: looks like a secret\]/);
  assert.ok(!html.includes('<script>widget'));
  assert.ok(html.includes('&lt;script&gt;widget'));
  assert.ok(!html.includes(SECRET));
  assert.match(view.renderRows([], new Set()), /no tasks match/);
});

test('switch: examples ship it on, the server routes it, the Dock seed carries the tab', async () => {
  const ex = await read('examples/config/jobs.mjs');
  assert.match(ex, /evidencePanel: \{ mode: 'on' \}/);
  const server = await read('server.mjs');
  assert.match(server, /url\.pathname === '\/api\/evidence'/);
  assert.match(server, /evidenceMode\(SETTINGS\.evidencePanel\) !== 'on'/);
  const dock = JSON.parse(await read('system/cmux/dock.json'));
  const tab = dock.controls.find((c) => c.id === 'mc-evidence');
  assert.equal(tab.type, 'browser');
  assert.match(tab.url, /\?evidence=1$/);
});
