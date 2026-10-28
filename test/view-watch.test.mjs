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
