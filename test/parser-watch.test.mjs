// node --test "test/*.test.mjs" — one fix task per failing supplier (src/parser-watch.mjs, task #456)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/tasks.mjs';
import { planParsers, streakKey, streakStart, shouldFile, supplierOfTask, cleanName, rowsUrl, parserWatchCard, maybeParserWatch, COLUMNS, COMMENT_GAP_MS } from '../src/parser-watch.mjs';

const H = 3600e3;
const now = Date.parse('2026-01-10T12:00:00Z');
const START = '2026-01-09T08:30:00.000Z';
const KEY = `parser:Acme Supply, Inc.@${START}`;
const cfg = { view: 'supplier_watch', owner: 'lead', repo: '/srv/shop', stagingDir: 'data/staging', template: 'data/handoffs/parser-fix/TEMPLATE.md', everyMinutes: 10 };
const failing = (over = {}) => ({ supplier_name: 'Acme Supply, Inc.', last_parsed_at: '2026-01-01T00:00:00Z', last_failure_at: '2026-01-10T11:00:00Z',
  consecutive_failures: 3, layout_changed_7d: 1, partial_7d: 0, failed_7d: 2, parsed_7d: 0, last_layout_name: 'v1',
  first_failure_in_streak_at: START, failing_files: ['Inv 100.pdf', 'Inv 99.pdf'], parsed_since_last_failure: 0, ...over });
const cleared = (over = {}) => failing({ consecutive_failures: 0, first_failure_in_streak_at: null, failing_files: [], parsed_since_last_failure: 4, ...over });
const task = (over = {}) => ({ id: 7, status: 'open', source: { via: 'parser-watch', key: KEY }, ...over });

test('streakKey: the full timestamp, normalised; no streak = no key', () => {
  assert.equal(streakKey(failing()), KEY);
  assert.equal(streakKey(failing({ first_failure_in_streak_at: '2026-01-09T08:30:00+00:00' })), KEY, 'PostgREST offset form is the same streak');
  assert.equal(streakKey(failing({ consecutive_failures: 0 })), null);
  assert.equal(streakKey(failing({ first_failure_in_streak_at: null })), null);
  assert.equal(streakKey(failing({ first_failure_in_streak_at: 'soon' })), null);
  assert.equal(streakStart(failing()), START);
});

test('shouldFile: one layout change is enough, one other failure is not', () => {
  assert.equal(shouldFile(failing({ consecutive_failures: 1, layout_changed_7d: 1 })), true);
  assert.equal(shouldFile(failing({ consecutive_failures: 1, layout_changed_7d: 0 })), false);
  assert.equal(shouldFile(failing({ consecutive_failures: 2, layout_changed_7d: 0 })), true);
  assert.equal(shouldFile(cleared()), false, 'a layout change earlier in the week, streak over');
});

test('plan: a new streak files ONE high task carrying the facts and the brief', () => {
  const [a, ...rest] = planParsers([failing()], [], {}, cfg, now);
  assert.equal(rest.length, 0);
  assert.equal(a.kind, 'create');
  assert.equal(a.input.priority, 'high');
  assert.equal(a.input.owner, 'lead');
  assert.equal(a.input.requester, 'board');
  assert.deepEqual(a.input.source, { via: 'parser-watch', key: KEY });
  assert.equal(a.input.links.repo, '/srv/shop');
  assert.match(a.input.title, /Acme Supply, Inc\. \(layout changed\)/);
  for (const part of ['"Acme Supply, Inc."', '3 failures in a row', 'layout changed 1', 'failed 2', '"Inv 100.pdf"', '"Inv 99.pdf"', 'data/staging/Acme_Supply,_Inc./', 'data/handoffs/parser-fix/TEMPLATE.md'])
    assert.ok(a.input.body.includes(part), part);
});

test('plan: a live task gets a comment on a changed reading, at most one per gap', () => {
  const rows = [failing({ consecutive_failures: 4, failing_files: ['Inv 101.pdf'] })];
  const fresh = { noted: { [KEY]: { sig: '3:Inv 100.pdf', at: now - H } } };
  assert.deepEqual(planParsers(rows, [task()], fresh, cfg, now), [], 'inside the gap');
  const old = { noted: { [KEY]: { sig: '3:Inv 100.pdf', at: now - COMMENT_GAP_MS } } };
  const [a] = planParsers(rows, [task()], old, cfg, now);
  assert.equal(a.kind, 'comment');
  assert.equal(a.id, 7);
  assert.match(a.text, /still failing: 4 failures in a row.*"Inv 101\.pdf"/);
  assert.deepEqual(planParsers([failing()], [task()], { noted: { [KEY]: { sig: '3:Inv 100.pdf', at: 0 } } }, cfg, now), [], 'same reading: nothing to say');
});

test('plan: a task already closed for this streak is not re-filed', () => {
  assert.deepEqual(planParsers([failing()], [task({ status: 'done' })], {}, cfg, now), []);
  assert.deepEqual(planParsers([failing()], [task({ status: 'cancelled' })], {}, cfg, now), []);
});

test('plan: streak over, nobody claimed it: cancelled with the count', () => {
  assert.deepEqual(planParsers([cleared()], [task()], {}, cfg, now), [{ kind: 'cancel', id: 7, key: KEY, text: 'cleared: 4 parsed since' }]);
});

test('plan: streak over, a worker holds it: one comment, never cancelled', () => {
  for (const status of ['claimed', 'in_progress', 'blocked', 'needs_approval']) {
    const [a, ...rest] = planParsers([cleared()], [task({ status })], {}, cfg, now);
    assert.equal(rest.length, 0);
    assert.equal(a.kind, 'comment', status);
    assert.equal(a.ended, true);
    assert.match(a.text, /^cleared: 4 parsed since\. Close this when the fix is finished\.$/);
  }
  assert.deepEqual(planParsers([cleared()], [task({ status: 'claimed' })], { noted: { [KEY]: { ended: true } } }, cfg, now), [], 'said once');
});

test('plan: a task is never cleared on an absence or a row that contradicts itself', () => {
  assert.deepEqual(planParsers([], [task()], {}, cfg, now), [], 'missing from the view');
  assert.deepEqual(planParsers([failing({ first_failure_in_streak_at: null })], [task()], {}, cfg, now), [], 'failures with no streak start');
  assert.deepEqual(planParsers([cleared({ parsed_since_last_failure: 0 })], [task()], {}, cfg, now), [], 'no failures, nothing parsed');
});

test('plan: a second streak on the same day files its own task; the old one ends', () => {
  const later = '2026-01-09T15:00:00.000Z';
  const acts = planParsers([failing({ first_failure_in_streak_at: later })], [task()], {}, cfg, now);
  assert.deepEqual(acts.map((a) => a.kind).sort(), ['cancel', 'create']);
  assert.equal(acts.find((a) => a.kind === 'create').input.source.key, `parser:Acme Supply, Inc.@${later}`);
  assert.match(acts.find((a) => a.kind === 'cancel').text, /streak ended; a new one began 2026-01-09T15:00/);
});

test('outside text is one line, without backticks; only the first 10 files are quoted', () => {
  assert.equal(cleanName('a\n\tb`c\u0007d  e'), 'a b c d e');
  const many = Array.from({ length: 14 }, (_, i) => `f${i}.pdf`);
  const [a] = planParsers([failing({ supplier_name: 'Bad\nSupplier', failing_files: many })], [], {}, cfg, now);
  assert.equal(a.input.source.key, `parser:Bad Supplier@${START}`);
  assert.ok(a.input.body.includes('"f9.pdf"'));
  assert.ok(!a.input.body.includes('"f10.pdf"'));
});

test('supplierOfTask: only this watch\'s tasks, and a supplier name with @ survives', () => {
  assert.equal(supplierOfTask(task()), 'Acme Supply, Inc.');
  assert.equal(supplierOfTask({ source: { via: 'parser-watch', key: `parser:a@b@${START}` } }), 'a@b');
  assert.equal(supplierOfTask({ source: { via: 'brain', key: KEY } }), null);
  assert.equal(supplierOfTask({}), null);
});

test('rowsUrl: same origin, explicit columns, no star', () => {
  const u = rowsUrl('https://db.example/rest/v1/heartbeat?id=eq.1', 'supplier_watch');
  assert.ok(u.startsWith('https://db.example/rest/v1/supplier_watch?select=supplier_name,'));
  assert.ok(!u.includes('*'));
  assert.ok(COLUMNS.every((c) => u.includes(c)));
  assert.equal(rowsUrl('not a url', 'v'), null);
});

test('card: off without config; amber only when it cannot do its job', () => {
  assert.equal(parserWatchCard({}, null, now), null);
  assert.equal(parserWatchCard({}, cfg, now).status, 'due');
  const bad = parserWatchCard({ lastRun: now, error: 'HTTP 404' }, cfg, now);
  assert.equal(bad.status, 'warn');
  assert.match(bad.detail, /HTTP 404/);
  assert.equal(parserWatchCard({ lastRun: now, actionError: 'create for k: nope' }, cfg, now).status, 'warn');
  const busy = parserWatchCard({ lastRun: now - 60e3, failing: [{ supplier: 'Acme', task: 7 }] }, cfg, now);
  assert.equal(busy.status, 'ok');
  assert.match(busy.detail, /in a streak: Acme #7 \(read 1m ago\)/);
  assert.match(parserWatchCard({ lastRun: now, failing: [] }, cfg, now).detail, /no supplier in a streak/);
});

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'parser-watch-'));
  const ledger = createLedger(path.join(root, 'tasks'));
  const file = path.join(root, 'state.json');
  const secrets = { HEARTBEAT_URL: 'https://db.example/rest/v1/hb', HEARTBEAT_KEY: 'k' };
  const seen = { urls: [], woken: [], events: [] };
  let rows = [];
  const fetchImpl = async (url) => { seen.urls.push(url); return rows === 404 ? { ok: false, status: 404 } : { ok: true, json: async () => rows }; };
  const pass = (at) => maybeParserWatch({ cfg, ledger, secrets, now: at, file, fetchImpl,
    record: async (_k, t) => { seen.events.push(t); }, afterCreate: async (t) => { seen.woken.push(t.id); } });
  return { ledger, file, seen, pass, setRows: (r) => { rows = r; } };
}

test('pass: files once, wakes once, then comments; the streak ends and the board cancels', async () => {
  const h = await harness();
  h.setRows([failing()]);
  await h.pass(now);
  let all = await h.ledger.list({});
  assert.equal(all.length, 1);
  assert.equal(h.seen.woken.length, 1);
  assert.equal(all[0].priority, 'high');
  await h.pass(now + 60e3);
  assert.equal(h.seen.urls.length, 1, 'not due yet: no read');
  await h.pass(now + 11 * 60e3);
  all = await h.ledger.list({});
  assert.equal(all.length, 1, 'no second task');
  assert.equal(h.seen.woken.length, 1);
  assert.equal(all[0].comments.length, 1, 'unchanged reading: the body only');
  h.setRows([failing({ consecutive_failures: 5, failing_files: ['Inv 102.pdf'] })]);
  await h.pass(now + COMMENT_GAP_MS + 60e3);
  all = await h.ledger.list({});
  assert.equal(all[0].comments.length, 2);
  assert.match(all[0].comments[1].text, /still failing: 5/);
  h.setRows([cleared()]);
  await h.pass(now + COMMENT_GAP_MS + 12 * 60e3);
  all = await h.ledger.list({});
  assert.equal(all[0].status, 'cancelled');
  assert.match(all[0].comments.at(-1).text, /cleared: 4 parsed since/);
});

test('pass: a claimed task is left to its worker', async () => {
  const h = await harness();
  h.setRows([failing()]);
  await h.pass(now);
  const [t] = await h.ledger.list({});
  await h.ledger.update(t.id, { op: 'claim', actor: 'lead' }, { now });
  h.setRows([cleared()]);
  await h.pass(now + 11 * 60e3);
  await h.pass(now + 22 * 60e3);
  const [after] = await h.ledger.list({});
  assert.equal(after.status, 'claimed');
  assert.equal(after.comments.filter((c) => /cleared/.test(c.text)).length, 1);
});

test('pass: an unreadable view files nothing, keeps the task, tells the ticker on the change', async () => {
  const h = await harness();
  h.setRows([failing()]);
  await h.pass(now);
  h.setRows(404);
  await h.pass(now + 11 * 60e3);
  assert.equal((await h.ledger.list({}))[0].status, 'open');
  assert.equal(JSON.parse(await readFile(h.file, 'utf8')).error, 'HTTP 404');
  assert.ok(h.seen.events.some((e) => /view unreadable \(HTTP 404\)/.test(e)));
  h.setRows([failing()]);
  await h.pass(now + 22 * 60e3);
  const st = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(st.error, undefined);
  assert.ok(h.seen.events.some((e) => /view readable again/.test(e)));
  assert.equal((await h.ledger.list({})).length, 1);
});

test('pass: off without config or secrets; the key never reaches the state file', async () => {
  const h = await harness();
  await maybeParserWatch({ cfg: null, ledger: h.ledger, file: h.file, now });
  assert.equal(h.seen.urls.length, 0);
  await maybeParserWatch({ cfg, ledger: h.ledger, secrets: {}, file: h.file, now });
  assert.match(JSON.parse(await readFile(h.file, 'utf8')).error, /no HEARTBEAT/);
  const h2 = await harness();
  h2.setRows([failing()]);
  await h2.pass(now);
  assert.ok(!(await readFile(h2.file, 'utf8')).includes('"k"'));
  assert.ok(h2.seen.urls[0].includes('select=supplier_name'));
});
