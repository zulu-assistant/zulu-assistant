// node --test "test/*.test.mjs" — daily decision page (#788: src/decide-page.mjs, public/decide-page.js, workspaceHtml)
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  decideMode, costOf, decideRows, pushView, blockQuestion, workspaceOf, openRefusal, openWorkspace, workspaceIdFor, TITLE_MAX,
} from '../src/decide-page.mjs';
import { buildAttention } from '../src/attention.mjs';

const require = createRequire(import.meta.url);
const BoardDecidePage = require('../public/decide-page.js');
const BoardDecide = require('../public/decide.js');

const NOW = Date.parse('2026-11-26T12:00:00Z');
const hAgo = (h) => new Date(NOW - h * 3600e3).toISOString();
const isOwner = (x) => x === 'owner';
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const WS_A = '11111111-1111-1111-1111-111111111111';
const WS_B = '22222222-2222-2222-2222-222222222222';
const DIR = [
  { name: 'builder', title: 'BUILDER', workspaceId: WS_A, status: 'active', workspaceOpen: true },
  { name: 'helper', title: 'HELPER', workspaceId: WS_B, status: 'active', workspaceOpen: true },
  { name: 'gone', title: 'GONE', workspaceId: '33333333-3333-3333-3333-333333333333', status: 'closed' },
];

// full ledger tasks (comments, source) and the summary briefs the strip reads
const TASKS = [
  { id: 10, title: 'Merge the fix', owner: 'builder', status: 'in_progress', priority: 'normal', created_at: hAgo(5), updated_at: hAgo(2),
    gates: [{ id: 'g1', status: 'pending', label: 'Merge a pull request', requested_at: hAgo(2), command: 'gh pr merge 1', agent: 'builder', cwd: '/w', tool: 'Bash' }], comments: [] },
  { id: 11, title: 'Ship the release', owner: 'helper', status: 'needs_approval', priority: 'high', created_at: hAgo(9), updated_at: hAgo(1),
    approval: { policy_item: 'release', requested_at: hAgo(1) }, comments: [] },
  { id: 12, title: 'Which list goes first?', owner: 'builder', status: 'blocked', priority: 'normal', blocked_on: ['owner'], created_at: hAgo(40), updated_at: hAgo(30),
    history: [{ at: hAgo(30), op: 'block', by: 'builder', from: 'in_progress', status: 'blocked', blocked_on: ['owner'] }],
    comments: [{ who: 'board', at: hAgo(31), text: 'older note' }, { who: 'builder', at: hAgo(30), text: 'Which list goes first:\ntry-on or colour guide?' }, { who: 'board', at: hAgo(29), text: 'reminder' }] },
  { id: 13, title: 'A customer asked about Jane Doe', owner: 'gone', status: 'blocked', priority: 'low', blocked_on: ['owner'], created_at: hAgo(4), updated_at: hAgo(4),
    source: { via: 'chat' }, comments: [{ who: 'gone', text: 'outside words never shown' }] },
];
const outside = (t) => t.source?.via === 'chat';
const view = (state = null) => buildAttention(TASKS, state, { now: NOW, mode: 'on', isOwner });
const rows = (state) => decideRows(view(state), TASKS, { now: NOW, directory: DIR, outside, waitP90H: 3.84 });

test('#788 cost = weight × priority × hours; ordered highest first, older first on a tie', () => {
  assert.equal(costOf('gate', 'normal', 2), 6);
  assert.equal(costOf('decision', 'high', 1), 4);
  assert.equal(costOf('block', 'urgent', 1), 4);
  assert.equal(costOf('block', 'low', 4), 2);
  assert.equal(costOf('block', 'nonsense', 3), 3, 'an unknown priority counts as normal');
  const r = rows();
  // block #12 normal 30 h = 30; gate #10 normal 2 h = 6; approval #11 high 1 h = 4; block #13 low 4 h = 2
  assert.deepEqual(r.rows.map((x) => x.id), ['block:12', 'gate:10:g1', 'decision:11', 'block:13']);
  assert.deepEqual(r.rows.map((x) => x.cost), [30, 6, 4, 2]);
  assert.equal(r.count, 4);
  assert.equal(r.oldestH, 30);
  assert.equal(r.waitP90H, 3.8);
  // ties: older first
  const tie = decideRows({ groups: [
    { task: 1, items: [{ id: 'block:1', kind: 'block', since: hAgo(2) }] },
    { task: 2, items: [{ id: 'decision:2', kind: 'decision', since: hAgo(1) }] },
  ] }, [], { now: NOW });
  assert.deepEqual(tie.rows.map((x) => x.id), ['block:1', 'decision:2']);
});

test('#788 a snoozed item stays off the page and is counted', () => {
  const state = { snoozes: { 'block:12': { until: NOW + 3600e3, by: 'owner', at: NOW, choice: '1h' } }, back: {} };
  const r = rows(state);
  assert.ok(!r.rows.some((x) => x.id === 'block:12'));
  assert.equal(r.snoozedCount, 1);
  assert.match(BoardDecidePage.headerText(r), /⏾ 1 snoozed$/);
});

test('#788 an outside-source task shows its number and intake only, never its title or comments', () => {
  const r = rows().rows.find((x) => x.task === 13);
  assert.equal(r.title, '#13 · chat intake');
  assert.equal(r.outside, true);
  assert.equal(r.question, undefined);
  const html = BoardDecidePage.renderPage({ rows: [r] }, new Map(), { esc, workspaceHtml: (ws, a, o) => BoardDecide.workspaceHtml(ws, a, o) }).html;
  assert.ok(!html.includes('Jane'), 'no title words');
  assert.ok(!html.includes('outside words'), 'no comment words');
  assert.match(html, /question not shown: outside source/);
});

test('#788 a block row: the owner agent\'s newest comment, one line cut at 200, the full text on click; no reply box', () => {
  assert.deepEqual(blockQuestion(TASKS[2]), { line: 'Which list goes first: try-on or colour guide?', full: 'Which list goes first:\ntry-on or colour guide?' });
  const long = blockQuestion({ owner: 'a', comments: [{ who: 'a', text: 'x'.repeat(500) }] });
  assert.equal(long.line.length, 200);
  assert.equal(long.full.length, 500);
  assert.equal(blockQuestion({ owner: 'a', comments: [] }), null);
  // MC's read of a89b780: a block filed by someone else than the owner, with the owner commenting after it
  const byMc = {
    owner: 'builder',
    history: [{ at: hAgo(5), op: 'claim', by: 'builder' }, { at: hAgo(3), op: 'block', by: 'mission-control-main' }],
    comments: [
      { who: 'builder', at: hAgo(4), text: 'working on it' },
      { who: 'mission-control-main', at: hAgo(3), text: 'Ship the spring discount on Friday or Monday?' },
      { who: 'builder', at: hAgo(1), text: 'progress note, not the question' },
    ],
  };
  assert.equal(blockQuestion(byMc).line, 'Ship the spring discount on Friday or Monday?');
  // the newest block step wins over an older one
  const twice = { ...byMc, history: [...byMc.history, { at: hAgo(0.5), op: 'block', by: 'builder' }], comments: [...byMc.comments, { who: 'builder', at: hAgo(0.5), text: 'second question' }] };
  assert.equal(blockQuestion(twice).line, 'second question');
  // a re-block that wrote no text: the newest earlier block step's text, never another comment
  const reblock = { ...byMc, history: [...byMc.history, { at: hAgo(0.2), op: 'block', by: 'mission-control-main' }] };
  assert.equal(blockQuestion(reblock).line, 'Ship the spring discount on Friday or Monday?');
  // no block step's text left at all (none written, or capped away): no question
  assert.equal(blockQuestion({ ...byMc, comments: byMc.comments.filter((c) => c.who !== 'mission-control-main') }), null);
  // history but no block step in it: no question; no history at all (before 1.2): the newest comment
  assert.equal(blockQuestion({ ...byMc, history: [{ at: hAgo(5), op: 'claim', by: 'builder' }] }), null);
  assert.equal(blockQuestion({ owner: 'builder', comments: byMc.comments }).line, 'progress note, not the question');
  const r = rows().rows.find((x) => x.task === 12);
  const shut = BoardDecidePage.renderPage({ rows: [r] }, new Map(), { esc }).html;
  assert.match(shut, /“Which list goes first: try-on or colour guide\?”/);
  assert.match(shut, /answer it: tell Mission Control/);
  assert.ok(!/<textarea|<input|<form/i.test(shut), 'no reply box on the page');
  const open = BoardDecidePage.renderPage({ rows: [r] }, new Map(), { esc, openQuestions: new Set(['block:12']) }).html;
  assert.match(open, /dp-q-full">Which list goes first:\ntry-on or colour guide\?</);
});

test('#788 the page push carries one line per question; the full text is the GET\'s', () => {
  const full = rows();
  assert.equal(full.rows.find((x) => x.task === 12).questionFull, 'Which list goes first:\ntry-on or colour guide?');
  const pushed = pushView(full);
  const r = pushed.rows.find((x) => x.task === 12);
  assert.equal(r.questionFull, undefined);
  assert.equal(r.more, true, 'the line is not the whole text');
  assert.ok(!JSON.stringify(pushed).includes('questionFull'));
  assert.equal(pushed.count, full.count);
  // unfolded before the text is read: says so; after the read: the text from the GET
  const loading = BoardDecidePage.renderPage({ rows: [r] }, new Map(), { esc, openQuestions: new Set([r.id]) }).html;
  assert.match(loading, /loading the full question/);
  const read = BoardDecidePage.renderPage({ rows: [r] }, new Map(), { esc, openQuestions: new Set([r.id]), fullText: new Map([[r.id, 'the whole\ntext']]) }).html;
  assert.match(read, /dp-q-full">the whole\ntext</);
  // a one-line question needs no read
  const short = pushView({ rows: [{ id: 'block:1', kind: 'block', task: 1, question: 'q?', questionFull: 'q?' }] }).rows[0];
  assert.equal(short.more, undefined);
  assert.match(BoardDecidePage.renderPage({ rows: [short] }, new Map(), { esc, openQuestions: new Set(['block:1']) }).html, /dp-q-full">q\?</);
});

test('#788 titles as on WORK, one line, cut at 80', () => {
  const t = { id: 20, title: `a\n${'y'.repeat(200)}`, owner: 'builder', status: 'blocked', blocked_on: ['owner'], updated_at: hAgo(1), comments: [] };
  const r = decideRows(buildAttention([t], null, { now: NOW, isOwner }), [t], { now: NOW, directory: DIR });
  assert.equal(r.rows[0].title.length, TITLE_MAX);
  assert.ok(!r.rows[0].title.includes('\n'));
});

test('#788 gate and approval rows are the strip\'s own buttons (taskRow), with only that row\'s gate', () => {
  const r = rows();
  const seen = [];
  const taskRow = (t, opts) => { seen.push({ id: t.id, gates: (t.gates || []).map((g) => g.id), hideAsk: opts.hideAsk }); return `<div class="task" data-row="${t.id}"></div>`; };
  const briefs = new Map(TASKS.map((t) => [t.id, t]));
  const html = BoardDecidePage.renderPage(r, briefs, { esc, taskRow }).html;
  assert.deepEqual(seen, [{ id: 10, gates: ['g1'], hideAsk: true }, { id: 11, gates: [], hideAsk: false }]);
  assert.match(html, /data-row="10"/);
  assert.match(html, /data-row="11"/);
  // the page has no write path of its own: no request is sent from its code
  const src = readFileSync(new URL('../public/decide-page.js', import.meta.url), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon/.test(src));
});

test('#788 each row names the owner\'s workspace from the directory; closed or unknown = no workspace, no button', () => {
  assert.deepEqual(workspaceOf('builder', DIR), { title: 'BUILDER', open: true });
  assert.deepEqual(workspaceOf('gone', DIR), { title: null, open: false });
  assert.deepEqual(workspaceOf('headless:triage', DIR), { title: null, open: false });
  assert.deepEqual(workspaceOf('builder', [{ ...DIR[0], workspaceOpen: false }]), { title: null, open: false });
  const o = { esc, results: new Map() };
  assert.equal(BoardDecide.workspaceHtml({ title: null, open: false }, 'gone', o), '<span class="ws-none">no workspace</span>');
  const html = BoardDecide.workspaceHtml({ title: 'A <b>', open: true }, 'builder', o);
  assert.match(html, /A &lt;b&gt;/);
  assert.match(html, /data-open-ws="builder">⧉ OPEN WORKSPACE</);
  assert.match(BoardDecide.workspaceHtml({ title: 'A', open: true }, 'builder', { ...o, phone: true }), /OPEN ON THE MAC/);
  assert.equal(rows().rows.find((x) => x.task === 13).workspace.open, false);
});

test('#788 OPEN WORKSPACE is the owner\'s click only (condition H, as a snooze)', () => {
  assert.equal(openRefusal({ decider: true }), null);
  assert.equal(openRefusal({ decider: false }).status, 403);
  assert.equal(openRefusal({ decider: true, intake: true }).status, 403);
  assert.equal(openRefusal({ decider: true, body: { actor: 'builder' } }).status, 403);
  assert.equal(openRefusal({ decider: true, headers: { 'x-mesh-agent': 'builder' } }).status, 403);
  assert.equal(openRefusal({ decider: true, headers: { 'x-mesh-intake': '1' } }).status, 403);
});

function fakeCmux(windows) {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'list-windows') return { err: null, out: Object.keys(windows).map((w, i) => `${i ? ' ' : '*'} ${i}: ${w} selected_workspace=x`).join('\n') };
    if (args[0] === 'workspace' && args[1] === 'list') {
      const w = args[args.indexOf('--window') + 1];
      return { err: null, out: (windows[w] || []).map((id, i) => `  workspace:${i + 1}  ${id}  T${i}`).join('\n') };
    }
    return { err: null, out: 'OK' };
  };
  return { run, calls };
}
const W1 = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
const W2 = 'BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB';

test('#788 OPEN WORKSPACE selects the directory\'s workspace in the window that holds it, then focuses that window', async () => {
  const { run, calls } = fakeCmux({ [W1]: [WS_B], [W2]: [WS_A] });
  const r = await openWorkspace('builder', { directory: DIR, run });
  assert.deepEqual(r, { ok: true, workspaceId: WS_A, windowId: W2 });
  const writes = calls.filter((a) => a[0] !== 'list-windows' && !(a[0] === 'workspace' && a[1] === 'list'));
  assert.deepEqual(writes, [['workspace', 'select', WS_A], ['focus-window', '--window', W2]]);
  // nothing else is ever run: no sidebar, no layout, no send
  assert.ok(!calls.some((a) => /sidebar|send|new-|close|rename/.test(a.join(' '))));
});

test('#788 OPEN WORKSPACE refuses an unknown or closed agent and never takes an id from the request', async () => {
  const { run, calls } = fakeCmux({ [W1]: [WS_A] });
  assert.equal((await openWorkspace('nobody', { directory: DIR, run })).status, 404);
  assert.equal((await openWorkspace('gone', { directory: DIR, run })).status, 404);
  // a workspace id given as the "agent" is not a name in the directory
  assert.equal((await openWorkspace(WS_A, { directory: DIR, run })).status, 404);
  assert.equal(workspaceIdFor(WS_A, DIR), null);
  assert.equal(calls.length, 0, 'nothing is asked of cmux for a name the directory does not know');
  // a workspace in no window: nothing selected
  const two = fakeCmux({ [W1]: [] });
  const r = await openWorkspace('helper', { directory: DIR, run: two.run });
  assert.equal(r.ok, false);
  assert.ok(!two.calls.some((a) => a[1] === 'select' || a[0] === 'focus-window'));
  // a cmux failure stops before any select
  const bad = await openWorkspace('helper', { directory: DIR, run: async () => ({ err: 'socket', out: '' }) });
  assert.equal(bad.status, 502);
});

test('#788 switch: on only when the mode says on', () => {
  assert.equal(decideMode({ mode: 'on' }), 'on');
  assert.equal(decideMode({ mode: 'observe' }), 'off');
  assert.equal(decideMode(undefined), 'off');
});
