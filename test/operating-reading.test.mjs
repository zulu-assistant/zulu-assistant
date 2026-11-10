// node --test "test/*.test.mjs" — weekly operating reading (Zulu 1.2, task #414)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';
import {
  percentile, fmtDur, gateOutcome, ownerWaits, windowMetrics, computeReading, readingText, readingLine,
  due, readingCard, maybeOperatingReading, readTasksDir, modeOf,
} from '../src/operating-reading.mjs';

const H = 3600e3;
const T0 = Date.parse('2026-03-02T08:00:00Z');
const iso = (x) => new Date(x).toISOString();
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'mc-reading-'));

test('percentile (nearest rank) and fmtDur', () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.deepEqual([fmtDur(null), fmtDur(30e3), fmtDur(12 * 60e3), fmtDur(3.42 * H), fmtDur(50 * H)], ['—', '30s', '12m', '3.4h', '2.1d']);
});

test('the ledger records status history: reopen + an owner wait are measured from it', async () => {
  const dir = tmp();
  const ledger = createLedger(dir);
  const t = await ledger.create({ title: 'fixture work', requester: 'alpha-agent', owner: 'beta-agent' }, T0);
  const at = (h) => ({ now: T0 + h * H });
  await ledger.update(t.id, { op: 'start', actor: 'beta-agent' }, at(1));
  await ledger.update(t.id, { op: 'block', actor: 'beta-agent', blocked_on: [OWNER.id], text: 'need a decision' }, at(2));
  await ledger.update(t.id, { op: 'comment', actor: 'beta-agent', text: 'no status change' }, at(3));
  await ledger.update(t.id, { op: 'unblock', actor: 'beta-agent' }, at(6));
  await ledger.update(t.id, { op: 'close', actor: 'beta-agent', checklist: 'all', links: { handoff: 'report.md' } }, at(7));
  await ledger.update(t.id, { op: 'reopen', actor: 'alpha-agent', text: 'one more part' }, at(8));
  await ledger.update(t.id, { op: 'close', actor: 'beta-agent', checklist: 'all' }, at(9));
  const [task] = await readTasksDir(dir);
  assert.deepEqual(task.history.map((h) => [h.op, h.from, h.status]), [
    ['start', 'open', 'in_progress'], ['block', 'in_progress', 'blocked'], ['unblock', 'blocked', 'in_progress'],
    ['close', 'in_progress', 'done'], ['reopen', 'done', 'claimed'], ['close', 'claimed', 'done']]);
  assert.deepEqual(task.history[1].blocked_on, [OWNER.id]);
  const w = { from: T0, to: T0 + 24 * H, current: true };
  assert.deepEqual(ownerWaits(task, OWNER.id, w), [4 * H]);
  const m = windowMetrics([task], w, { owner: OWNER.id });
  assert.deepEqual([m.closed, m.reopened, m.reopenedTasks, m.withHistory, m.ownerWaits.median], [1, 1, [task.id], 1, 4 * H]);
});

const gate = (id, over) => ({ id, cls: 'merge', requested_at: iso(T0 + H), decided_at: null, executed_at: null, via: null, status: 'pending', ...over });

test('gates: outcomes, false-positive proxy and approval-to-action times', () => {
  const gates = [
    gate('g1', { status: 'executed', via: 'board', decision: 'approve', decided_at: iso(T0 + H + 10 * 60e3), executed_at: iso(T0 + H + 11 * 60e3) }),
    gate('g2', { status: 'executed', via: 'pane', decision: 'approve', decided_at: iso(T0 + 3 * H), executed_at: iso(T0 + 3 * H + 60e3) }),
    gate('g3', { status: 'declined', via: 'board', decision: 'decline', decided_at: iso(T0 + 2 * H) }),
    gate('g4', { status: 'expired', via: 'board', decision: 'approve', decided_at: iso(T0 + 2 * H) }),
    gate('g5', { status: 'executed', via: 'standing', decided_at: iso(T0 + H), executed_at: iso(T0 + H + 30e3) }),
    gate('g6', { status: 'dry_required' }),
    gate('g7', {}),
    gate('g8', { requested_at: iso(T0 - 30 * 24 * H), status: 'declined', via: 'board' }),   // outside both windows
  ];
  assert.deepEqual(gates.map(gateOutcome), ['approved', 'approved', 'declined', 'expired', 'auto', 'dry', 'pending', 'declined']);
  const m = windowMetrics([{ id: 1, status: 'needs_approval', blocked_on: [], gates, comments: [] }], { from: T0, to: T0 + 7 * 24 * H });
  const g = m.gates;
  assert.deepEqual([g.requested, g.approved, g.auto, g.declined, g.expired, g.dry, g.pending], [7, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual([g.falsePositive, g.judged], [2, 4]);
  assert.equal(g.decide.n, 4);                                   // human decisions only (board + pane), not the program go
  assert.equal(g.decide.median, 60 * 60e3);                      // 10m, 60m, 60m, 2h → nearest-rank median 60m
  assert.deepEqual([g.act.n, g.total.n], [3, 3]);                // released: g1, g2, g5
});

test('closes by owner / requester (chat-filed marked), packets, worktree comments, both windows', () => {
  const c = (at, text, who = 'board') => ({ who, at: iso(at), text });
  const tasks = [
    { id: 1, status: 'done', owner: 'beta-agent', requester: 'alpha-agent', closed_at: iso(T0 + H), evidence: { v: 1 },
      comments: [c(T0, 'worktree created: /tmp/wt-1 (branch task/1-x, from main)', 'alpha-agent'), c(T0 + H, '⚠ worktree left: /tmp/wt-1 (clean) — task.sh worktree-clean 1'),
        c(T0 + 2 * H, 'worktree cleanup refused: live process(es) inside', 'alpha-agent'), c(T0 + 3 * H, 'worktree removed: /tmp/wt-1 (branch task/1-x deleted)', 'alpha-agent')] },
    { id: 2, status: 'done', owner: 'beta-agent', requester: 'person-a', source: { via: 'slack', key: 'k' }, closed_at: iso(T0 + 2 * H), comments: [] },
    { id: 3, status: 'cancelled', owner: 'gamma-agent', requester: 'alpha-agent', closed_at: iso(T0 + 2 * H), comments: [] },
    { id: 4, status: 'done', owner: 'gamma-agent', requester: 'alpha-agent', closed_at: iso(T0 - 3 * 24 * H), comments: [] },   // previous week
    { id: 5, status: 'blocked', owner: 'gamma-agent', requester: 'alpha-agent', blocked_on: [OWNER.id], closed_at: null, comments: [] },
  ];
  const r = computeReading(tasks, { end: T0 + 5 * 24 * H, owner: OWNER.id });
  assert.deepEqual([r.cur.closed, r.cur.cancelled, r.prev.closed], [2, 1, 1]);
  assert.deepEqual(r.cur.byOwner, [['beta-agent', 2]]);
  assert.deepEqual(r.cur.byRequester, [['alpha-agent', 1], ['person-a via slack', 1]]);
  assert.deepEqual(r.cur.packets, { with: 1, without: 1 });
  assert.deepEqual(r.cur.worktrees, { created: 1, removed: 1, refused: 1, left: 1 });
  assert.equal(r.cur.waitingNow, 1);
  assert.equal(r.prev.waitingNow, null);
  const text = readingText(r);
  assert.ok(text.length <= 2000);
  assert.match(text, /^OPERATING READING 2026-02-28 → 2026-03-07/);
  assert.match(text, /by requester: alpha-agent 1, person-a via slack 1/);
  assert.match(text, /Completion packets: 1 of 2 closes \(prev 0 of 1\)/);
  assert.match(readingLine(r), /closed 2 \(prev 1\) · reopened 0 \(0%\)/);
});

test('readingText stays under the 2000-char comment limit with a large ledger', () => {
  const tasks = Array.from({ length: 400 }, (_, i) => ({ id: i + 1, status: 'done', owner: `agent-${i % 60}-with-a-long-name`, requester: `req-${i % 50}-long-requester-name`,
    closed_at: iso(T0 + (i % 100) * 60e3), comments: [] }));
  assert.ok(readingText(computeReading(tasks, { end: T0 + 24 * H })).length <= 2000);
});

test('due: weekly slot, catch-up after downtime, hourly retry, off = never', () => {
  const cfg = { mode: 'observe', weekday: 1, hour: 8 };
  const mon = new Date(2026, 2, 2, 8, 30);                       // local Monday 08:30
  assert.equal(due({ now: mon, cfg, state: {} }), true);
  assert.equal(due({ now: mon, cfg: { mode: 'off' }, state: {} }), false);
  assert.equal(due({ now: mon, cfg: undefined, state: {} }), false);
  assert.equal(due({ now: mon, cfg, state: { lastRun: mon.getTime() - 60e3 } }), false);           // ran after the slot
  assert.equal(due({ now: new Date(2026, 2, 4, 9), cfg, state: { lastRun: new Date(2026, 1, 23, 8, 5).getTime() } }), true);   // Mac off Monday → Wednesday catch-up
  assert.equal(due({ now: mon, cfg, state: { lastAttempt: mon.getTime() - 60e3 } }), false);       // failed a minute ago
  assert.deepEqual([modeOf({ mode: 'on' }), modeOf({ mode: 'bogus' }), modeOf(null)], ['on', 'off', 'off']);
});

test('card: info only (always ok), null when off', () => {
  assert.equal(readingCard({}, { mode: 'off' }), null);
  assert.equal(readingCard({}, null), null);
  const c0 = readingCard({}, { mode: 'observe' });
  assert.deepEqual([c0.label, c0.status, c0.detail], ['ops:reading', 'ok', 'no reading yet']);
  assert.match(c0.schedule, /weekly Mon 08:00 · observe/);
  const c1 = readingCard({ line: 'operating reading x', task: 9, lastError: 'boom' }, { mode: 'on' });
  assert.equal(c1.status, 'ok');
  assert.match(c1.detail, /operating reading x · posted on #9 · last attempt failed: boom/);
});

test('poll hook: observe = ticker only; on = one task created once, one comment per week', async () => {
  const dir = tmp();
  const file = path.join(tmp(), 'state.json');
  const ledger = createLedger(dir);
  await ledger.create({ title: 'fixture', requester: 'alpha-agent', owner: 'beta-agent' }, T0);
  const lines = [];
  const record = async (_k, t) => { lines.push(t); };
  const mon = new Date(2026, 2, 2, 8, 30);
  await maybeOperatingReading({ cfg: { mode: 'observe' }, ledger, owner: OWNER.id, now: mon, file, record });
  assert.equal((await ledger.list()).length, 1);                              // nothing written to the ledger
  assert.match(lines.pop(), /^operating reading .* \(observe\)$/);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).lastRun);

  writeFileSync(file, '{}');                                                  // as if the week had not run yet
  const created = [];
  const cfg = { mode: 'on', owner: 'gamma-agent' };
  await maybeOperatingReading({ cfg, ledger, owner: OWNER.id, now: mon, file, record, afterCreate: async (t) => created.push(t.id) });
  const st = JSON.parse(readFileSync(file, 'utf8'));
  const task = await ledger.get(st.task);
  assert.deepEqual([task.requester, task.owner, created], ['board', 'gamma-agent', [st.task]]);
  assert.match(task.comments.at(-1).text, /^OPERATING READING/);
  assert.equal(task.comments.at(-1).who, 'board');
  await maybeOperatingReading({ cfg, ledger, owner: OWNER.id, now: new Date(2026, 2, 3, 9), file, record });   // same week: no second post
  assert.equal((await ledger.get(st.task)).comments.length, task.comments.length);
  await maybeOperatingReading({ cfg, ledger, owner: OWNER.id, now: new Date(2026, 2, 9, 8, 5), file, record });   // next Monday: same task
  assert.equal((await ledger.list()).length, 2);
  assert.equal((await ledger.get(st.task)).comments.length, task.comments.length + 1);
  assert.match(lines.at(-1), new RegExp(`→ #${st.task}$`));
});
