// node --test "test/*.test.mjs" — attention ring (src/attention.mjs, public/attention.js, the pill)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  attentionItems, buildAttention, settle, untilFor, applySnooze, snoozeRefusal, snoozedByTask, snoozeMode, emptyState, BACK_MS,
} from '../src/attention.mjs';
import { ownerPill } from '../src/chrome.mjs';

const require = createRequire(import.meta.url);
const BoardAttention = require('../public/attention.js');
const BoardDecide = require('../public/decide.js');

const isOwner = (x) => x === 'owner';
const NOW = Date.parse('2026-11-07T12:00:00Z');
const gate = (id) => ({ id, cls: 'merge', label: 'Merge a pull request', command: 'gh pr merge 1', requested_at: '2026-11-07T11:00:00Z' });
// summary briefs (src/tasks.mjs summarize): two approval tasks with gates, one blocked on the owner, one on someone else
const TASKS = [
  { id: 7, title: 'Ship the widget', owner: 'res-a', status: 'needs_approval', ageH: 3, gates: [gate('g1'), gate('g2')],
    approval: { policy_item: 'merge to main', requested_at: '2026-11-07T09:00:00Z', decision: null } },
  { id: 9, title: 'Rotate a key', owner: 'res-b', status: 'needs_approval', ageH: 5, gates: [gate('g1')] },
  { id: 11, title: 'Pick a colour', owner: 'res-a', status: 'blocked', ageH: 1, blocked_on: ['owner'] },
  { id: 12, title: 'Waiting on a teammate', owner: 'res-b', status: 'blocked', ageH: 2, blocked_on: ['teammate'] },
];

test('items: gates, an undecided approval and a block on the owner; never a block on someone else', () => {
  const ids = attentionItems(TASKS, { isOwner }).map((i) => i.id);
  assert.deepEqual(ids, ['gate:7:g1', 'gate:7:g2', 'decision:7', 'gate:9:g1', 'block:11']);
  const decided = { ...TASKS[0], approval: { ...TASKS[0].approval, decision: 'approve' } };
  assert.ok(!attentionItems([decided], { isOwner }).some((i) => i.kind === 'decision'));
});

test('grouping: one row per task with its N items, oldest task first; the count is the item total', () => {
  const v = buildAttention(TASKS, emptyState(), { now: NOW, isOwner });
  assert.deepEqual(v.groups.map((g) => [g.task, g.items.length]), [[9, 1], [7, 3], [11, 1]]);
  assert.equal(v.count, 5);
  assert.equal(v.snoozedCount, 0);
});

test('a snoozed item leaves its group and the count and is listed in the fold; mode off ignores snoozes', () => {
  const r = applySnooze(emptyState(), { op: 'snooze', items: ['gate:9:g1'], choice: '1h' }, attentionItems(TASKS, { isOwner }), { now: NOW, by: 'owner' });
  assert.equal(r.until, NOW + 3600e3);
  const v = buildAttention(TASKS, r.state, { now: NOW + 60e3, isOwner });
  assert.deepEqual(v.groups.map((g) => g.task), [7, 11], 'the task with nothing left awake has no row');
  assert.equal(v.count, 4);
  assert.deepEqual(v.snoozed.map((s) => [s.id, s.by, s.choice]), [['gate:9:g1', 'owner', '1h']]);
  assert.deepEqual([...snoozedByTask(v).get(9)], ['gate:9:g1']);
  const off = buildAttention(TASKS, r.state, { now: NOW + 60e3, isOwner, mode: 'off' });
  assert.equal(off.count, 5);
  assert.equal(off.snoozedCount, 0);
});

test('expiry: a snooze that ran out comes back with a back marker, which clears after BACK_MS', () => {
  const items = attentionItems(TASKS, { isOwner });
  const { state } = applySnooze(emptyState(), { op: 'snooze', items: ['block:11'], choice: '15m' }, items, { now: NOW });
  const before = settle(state, items, NOW + 14 * 60e3);
  assert.equal(before.changed, false);
  const after = settle(state, items, NOW + 15 * 60e3);
  assert.deepEqual(after.expired, ['block:11']);
  assert.deepEqual(Object.keys(after.state.snoozes), []);
  const v = buildAttention(TASKS, after.state, { now: NOW + 16 * 60e3, isOwner });
  assert.equal(v.groups.find((g) => g.task === 11).items[0].back, NOW + 15 * 60e3);
  const later = settle(after.state, items, NOW + 15 * 60e3 + BACK_MS + 1);
  assert.deepEqual(later.state.back, {});
});

test('settle drops snoozes for items no longer waiting (decided, gate gone); a re-asked gate is never snoozed', () => {
  const items = attentionItems(TASKS, { isOwner });
  const { state } = applySnooze(emptyState(), { op: 'snooze', items: ['gate:7:g1', 'decision:7'], choice: '4h' }, items, { now: NOW });
  const gone = TASKS.map((t) => (t.id === 7 ? { ...t, gates: [gate('g2'), gate('g3')], approval: null } : t));
  const r = settle(state, attentionItems(gone, { isOwner }), NOW + 60e3);
  assert.equal(r.changed, true);
  assert.deepEqual(r.state.snoozes, {});
  const v = buildAttention(gone, state, { now: NOW + 60e3, isOwner });
  assert.deepEqual(v.groups.find((g) => g.task === 7).items.map((i) => i.id), ['gate:7:g2', 'gate:7:g3']);
});

test('snooze lengths: 15m / 1h / 4h, and tomorrow = 08:00 local (today\'s 08:00 in the small hours)', () => {
  assert.equal(untilFor('15m', NOW), NOW + 15 * 60e3);
  assert.equal(untilFor('4h', NOW), NOW + 4 * 3600e3);
  assert.equal(untilFor('2d', NOW), null);
  const evening = new Date(2026, 10, 7, 21, 30).getTime();
  assert.equal(untilFor('tomorrow', evening), new Date(2026, 10, 8, 8, 0).getTime());
  const smallHours = new Date(2026, 10, 7, 2, 0).getTime();
  assert.equal(untilFor('tomorrow', smallHours), new Date(2026, 10, 7, 8, 0).getTime());
});

test('applySnooze refuses unknown lengths and items that are not waiting; unsnooze removes', () => {
  const items = attentionItems(TASKS, { isOwner });
  assert.equal(applySnooze(emptyState(), { op: 'snooze', items: ['gate:7:g1'], choice: 'forever' }, items).error.status, 400);
  assert.equal(applySnooze(emptyState(), { op: 'snooze', items: ['block:12'], choice: '1h' }, items).error.status, 404);
  assert.equal(applySnooze(emptyState(), { op: 'snooze', items: [], choice: '1h' }, items).error.status, 400);
  const { state } = applySnooze(emptyState(), { op: 'snooze', items: 'gate:7:g1', choice: '1h' }, items, { now: NOW });
  assert.deepEqual(applySnooze(state, { op: 'unsnooze', items: ['gate:7:g1'] }, items).state.snoozes, {});
});

test('token refusal: no token = 403; an agent or intake identity = 403 even WITH the token (condition H)', () => {
  assert.equal(snoozeRefusal({ decider: false }).status, 403);
  assert.match(snoozeRefusal({ decider: false }).msg, /decision token/);
  assert.equal(snoozeRefusal({ decider: true, body: { actor: 'res-a' } }).status, 403);
  assert.equal(snoozeRefusal({ decider: true, headers: { 'x-mesh-agent': 'res-a' } }).status, 403);
  assert.equal(snoozeRefusal({ decider: true, headers: { 'x-mesh-intake': 'x' } }).status, 403);
  assert.equal(snoozeRefusal({ decider: true, intake: true }).status, 403);
  assert.equal(snoozeRefusal({ decider: true }), null);
  assert.equal(snoozeMode(undefined), 'off');
  assert.equal(snoozeMode({ snooze: 'off' }), 'off');
  assert.equal(snoozeMode({ snooze: 'on' }), 'on');
});

test('strip rendering (full board + ?dock=1): decisions open with buttons, blocks in a fold, BACK, second-click snooze', () => {
  const items = attentionItems(TASKS, { isOwner });
  let { state } = applySnooze(emptyState(), { op: 'snooze', items: ['gate:9:g1'], choice: '1h' }, items, { now: NOW });
  state = { ...state, back: { 'block:11': { at: NOW - 60e3 } } };
  const view = buildAttention(TASKS, state, { now: NOW, isOwner });
  const tasks = new Map(TASKS.map((t) => [t.id, t]));
  const rows = [];
  const taskRow = (t, o) => { rows.push({ id: t.id, gates: t.gates.map((g) => g.id), hideAsk: o.hideAsk }); return `<div class="task" data-id="${t.id}"></div>`; };
  for (const dock of [false, true]) {
    rows.length = 0;
    const r = BoardAttention.renderStrip(view, tasks, { taskRow, dock, now: NOW });
    assert.equal(r.count, 4);
    assert.equal(r.snoozedCount, 1);
    // #437: the decision comes first and open, with its buttons; the block waits in one closed fold
    assert.deepEqual([r.decisions, r.blocks], [1, 1]);
    assert.equal((r.html.match(/class="att-row/g) || []).length, 1, 'only decisions in the list');
    assert.match(r.html, /#7<\/span><span class="task-title">Ship the widget<\/span><span class="att-items">⛨ g1 · ⛨ g2 · ⚑ approval<\/span><span class="chip att-n">3<\/span>/);
    assert.match(r.html, /class="att-row is-open" data-att-task="7"/);
    assert.match(r.html, /data-att-toggle="7" data-att-decision="1" aria-expanded="true"/);
    assert.deepEqual(rows.map((x) => x.id), [7], 'the decision renders its task row (the buttons); the block does not');
    assert.match(r.fold, /<details class="att-fold att-blocks"><summary>blocked on you \(1\)<\/summary>/);
    assert.ok(/class="att-row is-back" data-att-task="11"/.test(r.fold), 'a returned item marks its row BACK');
    assert.ok(r.fold.indexOf('blocked on you') < r.fold.indexOf('snoozed'), 'blocks before the snoozed fold');
    assert.match(r.fold, /<summary>⏾ snoozed \(1\)<\/summary>/);
    assert.match(r.fold, /data-unsnooze="gate:9:g1"/);
    assert.ok(!/data-snooze-open="11"/.test(r.fold), 'a collapsed block stays one line: no snooze control');
    assert.match(r.html, /data-snooze-open="7"/, 'snooze stays per row on an open decision');
    assert.ok(!/window\.confirm/.test(r.html));
  }
  // the control appears once the row is expanded, and stays while a pick or its result is on screen
  const openHtml = BoardAttention.renderStrip(view, tasks, { taskRow, expanded: new Set(['7']), now: NOW }).html;
  assert.match(openHtml, /data-snooze-open="7"/);
  assert.equal((openHtml.match(/data-snooze-open=/g) || []).length, 1, 'only the expanded row');
  const pending = BoardAttention.renderStrip(view, tasks, { taskRow, results: new Map([['snooze:7', { text: 'snoozing…', pending: true }]]), now: NOW }).html;
  assert.match(pending, /snoozing…/);
  // expanded: the real task row, only awake gates, approval buttons hidden when the approval is snoozed
  const s2 = applySnooze(emptyState(), { op: 'snooze', items: ['gate:7:g1', 'decision:7'], choice: '1h' }, items, { now: NOW }).state;
  const v2 = buildAttention(TASKS, s2, { now: NOW, isOwner });
  rows.length = 0;
  BoardAttention.renderStrip(v2, tasks, { taskRow, expanded: new Set(['7']), now: NOW });
  assert.deepEqual(rows.filter((x) => x.id === 7), [{ id: 7, gates: ['g2'], hideAsk: true }]);
  // the snooze control: pick → choices; first click arms ("CLICK AGAIN"), second fires (decide.js armClick)
  const picking = BoardAttention.renderStrip(view, tasks, { taskRow, picking: new Set(['7']), now: NOW }).html;
  assert.match(picking, /data-snooze="7" data-for="15m">15m</);
  assert.match(picking, /data-for="tomorrow">tomorrow 08:00</);
  const first = BoardDecide.armClick(null, 'snooze:7', '1h', NOW);
  assert.equal(first.fire, false);
  const armedHtml = BoardAttention.renderStrip(view, tasks, { taskRow, picking: new Set(['7']), armed: first.armed, now: NOW + 1 }).html;
  assert.match(armedHtml, /act-snooze armed" data-snooze="7" data-for="1h">CLICK AGAIN · 1h</);
  assert.equal(BoardDecide.armClick(first.armed, 'snooze:7', '1h', NOW + 1).fire, true);
  assert.equal(BoardDecide.armClick(first.armed, 'snooze:7', '4h', NOW + 1).fire, false, 'a different length re-arms');
});

test('#437: closing a decision by hand, opening a block, the open fold, and a strip with only blocks', () => {
  const tasks = new Map(TASKS.map((t) => [t.id, t]));
  const view = buildAttention(TASKS, emptyState(), { now: NOW, isOwner });
  const rows = [];
  const taskRow = (t) => { rows.push(t.id); return `<div class="task" data-id="${t.id}"></div>`; };
  assert.deepEqual(view.groups.map((g) => g.task), [9, 7, 11], 'the view itself is unchanged: oldest first');
  const all = BoardAttention.renderStrip(view, tasks, { taskRow, now: NOW });
  assert.ok(all.html.indexOf('data-att-task="9"') >= 0 && all.html.indexOf('data-att-task="7"') >= 0 && !all.html.includes('data-att-task="11"'));
  assert.equal(all.count, 5, 'the (N) title count still counts every item, blocks included');
  rows.length = 0;
  const shut = BoardAttention.renderStrip(view, tasks, { taskRow, collapsed: new Set(['7']), now: NOW });
  assert.deepEqual(rows, [9], 'a decision closed by hand renders no body');
  assert.match(shut.html, /data-att-toggle="7" data-att-decision="1" aria-expanded="false"/);
  rows.length = 0;
  const opened = BoardAttention.renderStrip(view, tasks, { taskRow, expanded: new Set(['11']), blocksOpen: true, now: NOW });
  assert.deepEqual(rows, [9, 7, 11]);
  assert.match(opened.fold, /<details class="att-fold att-blocks" open>/);
  assert.match(opened.fold, /data-snooze-open="11"/, 'snooze still per row on an opened block');
  assert.ok(!/data-att-toggle="11" data-att-decision/.test(opened.fold), 'a block toggles the expanded set');
  const onlyBlocks = buildAttention([TASKS[2]], emptyState(), { now: NOW, isOwner });
  const b = BoardAttention.renderStrip(onlyBlocks, new Map([[11, TASKS[2]]]), { taskRow, now: NOW });
  assert.match(b.html, /att-none">⛨ nothing to approve/);
  assert.equal(b.count, 1);
  const none = BoardAttention.renderStrip({ groups: [], snoozed: [], count: 0 }, new Map(), { taskRow, now: NOW });
  assert.deepEqual([none.html, none.fold], ['', ''], 'nothing at all: the page shows its own empty line');
  // #450: the Dock always says so, and counts only what takes a click
  const dockNone = BoardAttention.renderStrip({ groups: [], snoozed: [], count: 0 }, new Map(), { taskRow, dock: true, now: NOW });
  assert.equal(dockNone.html, BoardAttention.NOTHING);
  assert.equal(dockNone.decisionItems, 0);
  const mixed = BoardAttention.renderStrip(buildAttention(TASKS, emptyState(), { now: NOW, isOwner }), tasks, { taskRow, dock: true, now: NOW });
  assert.deepEqual([mixed.count, mixed.decisionItems, mixed.blocks], [5, 4, 1], 'g1, g2, approval and #9 g1; the block is not one');
  assert.equal(b.decisionItems, 0, 'only blocks: nothing to click');
});

test('empty strip: everything snoozed keeps the strip (dim line + fold) on the full board', () => {
  assert.deepEqual(BoardDecide.decisionsState(0, false, 2), { hidden: false, empty: true });
  assert.deepEqual(BoardDecide.decisionsState(0, false), { hidden: true, empty: true });
  assert.deepEqual(BoardDecide.decisionsState(0, true, 0), { hidden: true, empty: false });
});

test('cmux pill: "+n snoozed"; "⏾ n snoozed" in the progress label when every item is snoozed; snoozed gates leave the lead', () => {
  const full = (id, status, gates = [], extra = {}) => ({ id, status, checklist: {}, gates: gates.map((g) => ({ ...gate(g), status: 'pending' })), ...extra });
  const t = full(7, 'needs_approval', ['g1', 'g2']);
  assert.equal(ownerPill([t], NOW).pill.value, '#7 APPROVAL');
  const some = ownerPill([t], NOW, { snoozed: new Map([[7, new Set(['gate:7:g1'])]]) });
  assert.equal(some.pill.value, '#7 APPROVAL +1 snoozed');
  assert.equal(some.progress.label, '⛨ 1 GATE · #7 APPROVAL · 0/4 · +1 snoozed');
  const all = ownerPill([t], NOW, { snoozed: new Map([[7, new Set(['gate:7:g1', 'gate:7:g2'])]]) });
  assert.equal(all.progress.label, '#7 APPROVAL · 0/4 · ⏾ 2 snoozed');
  const blocked = ownerPill([full(11, 'blocked', [], { blocked_on: ['owner'] })], NOW, { snoozed: new Map([[11, new Set(['block:11'])]]) });
  assert.equal(blocked.progress.label, '#11 BLOCKED · 0/4 · ⏾ 1 snoozed');
  assert.deepEqual(ownerPill([t], NOW, { snoozed: new Map() }), ownerPill([t], NOW), 'no snoozes = the pill is unchanged');
  const titled = ownerPill([{ ...t, title: 'Ship the widget' }], NOW, { snoozed: new Map([[7, new Set(['gate:7:g1', 'gate:7:g2'])]]) });
  assert.equal(titled.progress.label, '#7 APPROVAL · 0/4 · Ship the widget · ⏾ 2 snoozed', 'the snooze suffix rides after the title (#416)');
});
