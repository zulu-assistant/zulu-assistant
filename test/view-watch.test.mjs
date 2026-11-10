// node --test "test/*.test.mjs" — database-view cards (src/view-watch.mjs, task #289)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { viewCard, viewCards, viewUrl, readView, maybeViewWatch, ago } from '../src/view-watch.mjs';

const M = 60e3;
const now = Date.parse('2026-01-10T12:00:00Z');
const entry = { label: 'queue:ops', name: 'Queue ops', view: 'queue_status', everyMinutes: 5,
  max: { stuck: 0, oldest_stuck_minutes: 30 }, maxAgeMinutes: { last_sweep_at: 5 }, show: ['last_send_at'] };
const iso = (ms) => new Date(ms).toISOString();
const read = (row, at = now - M) => ({ at, row });

test('viewCard: healthy row is ok; display-only columns never amber', () => {
  const c = viewCard(entry, read({ stuck: 0, oldest_stuck_minutes: null, last_sweep_at: iso(now - 2 * M), last_send_at: iso(now - 9 * 24 * 60 * M) }), now);
  assert.equal(c.status, 'ok');
  assert.equal(c.label, 'queue:ops');
  assert.match(c.detail, /stuck 0 · oldest_stuck_minutes — · last_sweep_at 2m ago · last_send_at 9d ago/);
});

test('viewCard: each threshold ambers, breaches listed first', () => {
  assert.equal(viewCard(entry, read({ stuck: '2', oldest_stuck_minutes: 1, last_sweep_at: iso(now - M) }), now).status, 'warn');
  const old = viewCard(entry, read({ stuck: 0, oldest_stuck_minutes: 31.25, last_sweep_at: iso(now - M) }), now);
  assert.equal(old.status, 'warn');
  assert.match(old.detail, /^oldest_stuck_minutes 31\.3 > 30 — /);
  const stale = viewCard(entry, read({ stuck: 0, oldest_stuck_minutes: null, last_sweep_at: iso(now - 6 * M) }), now);
  assert.equal(stale.status, 'warn');
  assert.match(stale.detail, /last_sweep_at 6m ago > 5m/);
  const never = viewCard(entry, read({ stuck: 0, oldest_stuck_minutes: null, last_sweep_at: null }), now);
  assert.equal(never.status, 'warn', 'a null timestamp = not started, not healthy');
  assert.match(never.detail, /^last_sweep_at never — /);
});

test('viewCard: unreadable / empty / not yet read; never red', () => {
  assert.equal(viewCard(entry, { at: now, error: 'HTTP 404' }, now).detail, 'view unreadable (HTTP 404)');
  assert.equal(viewCard(entry, { at: now, error: 'HTTP 404' }, now).status, 'warn');
  assert.equal(viewCard(entry, { at: now }, now).detail, 'view unreadable (no row)');
  assert.equal(viewCard(entry, undefined, now).status, 'due');
  assert.deepEqual(viewCards({}, undefined, now), []);
  assert.deepEqual(viewCards({}, [], now), []);
  assert.equal(viewCards({}, [{ label: 'x' }], now).length, 0, 'an entry without a view is ignored');
});

test('viewUrl + ago', () => {
  assert.equal(viewUrl('https://db.example.test/rest/v1/beat?id=eq.1', 'queue_status'), 'https://db.example.test/rest/v1/queue_status?select=*&limit=1');
  assert.equal(viewUrl('', 'v'), null);
  assert.equal(ago(59 * M), '59m');
  assert.equal(ago(3 * 60 * M), '3h');
});

test('readView: sends the key as headers only, maps errors without echoing it', async () => {
  let seen;
  const ok = await readView('https://db.example.test/rest/v1/v', 'k-123', { now, fetchImpl: async (url, o) => { seen = { url, h: o.headers }; return { ok: true, json: async () => [{ stuck: 0 }] }; } });
  assert.deepEqual(ok, { at: now, row: { stuck: 0 } });
  assert.equal(seen.h.apikey, 'k-123');
  assert.ok(!seen.url.includes('k-123'));
  assert.deepEqual(await readView('u', 'k', { now, fetchImpl: async () => ({ ok: false, status: 401 }) }), { at: now, error: 'HTTP 401' });
  assert.deepEqual(await readView('u', 'k', { now, fetchImpl: async () => ({ ok: true, json: async () => [] }) }), { at: now, error: 'no row' });
  const net = await readView('u', 'k-123', { now, fetchImpl: async () => { throw new Error('connect k-123 refused'); } });
  assert.deepEqual(net, { at: now, error: 'network' });
});

test('maybeViewWatch: reads when due, stores rows not keys, logs readable/unreadable flips', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'vw-')), 'state.json');
  const secrets = { HEARTBEAT_URL: 'https://db.example.test/rest/v1/beat?id=eq.1', HEARTBEAT_KEY: 'k-123' };
  let calls = 0; let status = 200;
  const fetchImpl = async () => { calls++; return status === 200 ? { ok: true, json: async () => [{ stuck: 0 }] } : { ok: false, status }; };
  const lines = [];
  const record = async (k, t) => lines.push(t);
  await maybeViewWatch({ entries: [entry], secrets, now, file, fetchImpl, record });
  await maybeViewWatch({ entries: [entry], secrets, now: now + M, file, fetchImpl, record });
  assert.equal(calls, 1, 'not due again inside everyMinutes');
  const text = await readFile(file, 'utf8');
  assert.ok(!text.includes('k-123'));
  assert.deepEqual(JSON.parse(text)['queue:ops'].row, { stuck: 0 });
  status = 503;
  await maybeViewWatch({ entries: [entry], secrets, now: now + 6 * M, file, fetchImpl, record });
  assert.deepEqual(lines, ['queue:ops: view unreadable (HTTP 503)']);
  await maybeViewWatch({ entries: [entry], secrets: {}, now: now + 12 * M, file, fetchImpl, record });
  assert.equal(calls, 2, 'no secrets = no fetch');
  assert.equal(JSON.parse(await readFile(file, 'utf8'))['queue:ops'].error, 'no HEARTBEAT_URL/KEY in secrets');
});

test('a count-only review view: several zero limits, numeric show columns, a freshness stamp', () => {
  const review = { label: 'review:ops', name: 'Items needing review', view: 'review_status', everyMinutes: 5,
    max: { late_jobs: 0, unassigned: 0, check_unavailable: 0 }, maxAgeMinutes: { checked_at: 10 },
    show: ['late_items', 'oldest_age'] };
  const row = { late_jobs: 0, unassigned: 0, check_unavailable: 0, checked_at: new Date(now - 3 * M).toISOString(), late_items: 0, oldest_age: null };
  const ok = viewCard(review, { at: now, row }, now);
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /late_items 0 · oldest_age never/);
  const bad = viewCard(review, { at: now, row: { ...row, unassigned: 2, checked_at: new Date(now - 11 * M).toISOString() } }, now);
  assert.equal(bad.status, 'warn');
  assert.match(bad.detail, /^unassigned 2 > 0 · checked_at 11m ago > 10m — /);
});

test('maxAgeIfSet: an "oldest waiting" stamp ambers only when set and too old; ruled columns are not repeated by show', () => {
  const e = { label: 'queue:ops', name: 'Queue', view: 'q', max: { unavailable: 0, waiting: 0 }, maxAgeIfSet: { oldest_waiting_at: 60 },
    show: ['waiting', 'reserved'] };
  const base = { unavailable: 0, waiting: 0, reserved: 0, oldest_waiting_at: null };
  const none = viewCard(e, { at: now, row: base }, now);
  assert.equal(none.status, 'ok', 'nothing waiting = no stamp = fine');
  assert.match(none.detail, /oldest_waiting_at none/);
  assert.equal((none.detail.match(/waiting 0/g) || []).length, 1, 'a max column is not listed again by show');
  e.max = { unavailable: 0 };
  const fresh = viewCard(e, { at: now, row: { ...base, waiting: 3, oldest_waiting_at: new Date(now - 30 * M).toISOString() } }, now);
  assert.equal(fresh.status, 'ok');
  const old = viewCard(e, { at: now, row: { ...base, waiting: 3, oldest_waiting_at: new Date(now - 90 * M).toISOString() } }, now);
  assert.equal(old.status, 'warn');
  assert.match(old.detail, /^oldest_waiting_at 2h ago > 60m — /);
});
