import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { relayConfig, waitingItems, payloadFor, inQuiet, planRings, relayPass, relayCard, postPush } from '../src/relay.mjs';

// Push approvals (#415). The transport is always a stub: these tests never POST anywhere.
const SELF = { mode: 'on', url: 'http://relay.test:2586', topic: 'zulu-owner', boardUrl: 'http://board.test:3210' };
const FALLBACK = { mode: 'on', url: 'https://ntfy.sh', topic: 'z'.repeat(40), boardUrl: 'http://board.test:3210' };
const SECRETS = { RELAY_TOKEN: 'tk_test_only' };
const CMD = 'cd ~/repo && gh pr merge 77 --merge --delete-branch';
const at = (h, m = 0) => new Date(2026, 10, 7, h, m).getTime();          // local time, like quiet hours
const task = (over = {}) => ({
  id: 401, title: 'Ship it for Customer Jane Doe', owner: 'agent-mesh', status: 'needs_approval',
  gates: [{ id: 'g3', status: 'pending', label: 'Merge a pull request', cls: 'merge', agent: 'agent-mesh', command: CMD, requested_at: new Date(at(12)).toISOString() }],
  ...over,
});
const stub = () => { const calls = []; return { calls, fetchImpl: async (url, o) => { calls.push({ url, ...o }); return { ok: true, status: 200 }; } }; };
const tmp = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'relay tests-')), 'state.json');

test('config: off by default; on without a token or with a short public topic falls back to observe', () => {
  assert.equal(relayConfig(null).mode, 'off');
  assert.equal(relayConfig({ mode: 'off' }).mode, 'off');
  assert.equal(relayConfig(SELF, SECRETS).mode, 'on');
  assert.match(relayConfig(SELF, {}).warn, /RELAY_TOKEN missing/);
  assert.equal(relayConfig(SELF, {}).mode, 'observe');
  assert.equal(relayConfig(FALLBACK, {}).mode, 'on', 'the public fallback needs no token');
  assert.match(relayConfig({ ...FALLBACK, topic: 'short' }).warn, /32\+ random/);
  assert.deepEqual(relayConfig(SELF, SECRETS).reRingMinutes, [30, 90]);
});

test('payload is an allow-list: never the command; fallback drops the title too; the link only highlights', () => {
  const [item] = waitingItems([task()]);
  const self = payloadFor(item, relayConfig(SELF, SECRETS));
  const flat = JSON.stringify(self);
  assert.ok(!flat.includes('gh pr merge') && !flat.includes('--delete-branch') && !flat.includes('~/repo'), 'no command text, ever');
  assert.equal(self.headers.Title, 'GATE g3 · #401');
  assert.equal(self.headers.Priority, 'high');
  assert.equal(self.headers.Click, 'http://board.test:3210/?dock=1&item=401:g3');
  assert.match(self.body, /Merge a pull request · agent-mesh · Ship it for Customer Jane Doe/);
  const fb = payloadFor(item, relayConfig(FALLBACK, {}));
  assert.ok(!JSON.stringify(fb).includes('Jane Doe'), 'fallback (public topic): no task title');
  assert.equal(fb.body, 'Merge a pull request · agent-mesh');
  const noLink = payloadFor(item, relayConfig({ ...SELF, boardUrl: '' }, SECRETS));
  assert.equal(noLink.headers.Click, undefined, 'boardUrl stays explicit: no link without it');
  const appr = waitingItems([{ id: 9, title: 'T', owner: 'x', status: 'needs_approval', approval: { policy_item: 'spend > $50 for Jane Doe', requested_at: new Date(at(12)).toISOString() } }]);
  assert.equal(payloadFor(appr[0], relayConfig(FALLBACK, {})).body, 'approval · x', 'fallback: no policy text either');
});

test('quiet hours: crosses midnight; gates ring at default priority; others wait for the morning', () => {
  const q = { from: '22:00', to: '07:00' };
  assert.equal(inQuiet(at(23), q), true); assert.equal(inQuiet(at(3), q), true);
  assert.equal(inQuiet(at(7), q), false); assert.equal(inQuiet(at(12), q), false);
  const cfg = relayConfig(SELF, SECRETS);
  const items = waitingItems([task(), { id: 9, title: 'T', owner: 'x', status: 'needs_approval', approval: { policy_item: 'p', requested_at: new Date(at(23)).toISOString() } }]);
  const night = planRings(items, {}, cfg, at(23, 5));
  assert.deepEqual(night.send.map((s) => s.item.key), ['t401g3']);
  assert.deepEqual(night.hold, ['t9a']);
  assert.equal(payloadFor(night.send[0].item, cfg, { quiet: true }).headers.Priority, 'default');
});

test('rings once, re-rings at 30 and 90 min, then stops; re-rings obey quiet hours; a restart never re-rings', async () => {
  const file = await tmp(); const s = stub(); const lines = [];
  const run = (now, tasks = [task()]) => relayPass({ cfg: SELF, secrets: SECRETS, tasks, now, file, fetchImpl: s.fetchImpl, record: (k, t) => lines.push(t) });
  assert.deepEqual((await run(at(12, 1))).sent, ['t401g3']);
  assert.deepEqual((await run(at(12, 2))).sent, [], 'same item: no second ring');
  assert.deepEqual((await run(at(12, 31))).sent, ['t401g3'], 're-ring at 30 min');
  assert.deepEqual((await run(at(13, 0))).sent, []);
  assert.deepEqual((await run(at(13, 31))).sent, ['t401g3'], 're-ring at 90 min');
  assert.deepEqual((await run(at(15, 0))).sent, [], 'then stop');
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[0].headers.Authorization, 'Bearer tk_test_only');
  assert.equal(s.calls[0].url, 'http://relay.test:2586/zulu-owner');
  assert.match(s.calls[1].headers.Title, /still waiting/);
  // a gate filed at 21:50: the first ring goes out, the 30-min re-ring falls in quiet hours and waits for 07:00
  const f2 = await tmp(); const s2 = stub();
  const late = [task({ gates: [{ ...task().gates[0], requested_at: new Date(at(21, 50)).toISOString() }] })];
  const run2 = (now) => relayPass({ cfg: SELF, secrets: SECRETS, tasks: late, now, file: f2, fetchImpl: s2.fetchImpl });
  assert.deepEqual((await run2(at(21, 51))).sent, ['t401g3']);
  assert.deepEqual((await run2(at(22, 25))).held, ['t401g3'], 'the re-ring is held in quiet hours');
  assert.deepEqual((await run2(new Date(2026, 10, 8, 7, 0).getTime())).sent, ['t401g3'], 'held: sent at 07:00');
  assert.deepEqual((await run2(new Date(2026, 10, 8, 7, 1).getTime())).sent, [], 'ONCE: that ring also covers the missed 90-min one');
  assert.deepEqual((await run2(new Date(2026, 10, 8, 12, 0).getTime())).sent, [], 'and nothing after');
  assert.equal(s2.calls.length, 2);
});

test('snoozed items get no re-ring; the end of the snooze rings once and restarts the 30/90 clock (#412 + #415)', async () => {
  const file = await tmp(); const s = stub();
  const run = (now, snoozed = new Set()) => relayPass({ cfg: SELF, secrets: SECRETS, tasks: [task()], snoozed, now, file, fetchImpl: s.fetchImpl });
  const asleep = new Set(['gate:401:g3']);
  assert.deepEqual((await run(at(12, 1), asleep)).sent, ['t401g3'], 'a first ring is never held back by a snooze');
  assert.deepEqual((await run(at(12, 10), asleep)).snoozed, ['t401g3']);
  assert.deepEqual((await run(at(12, 31), asleep)).sent, [], 'no 30-min re-ring while snoozed');
  assert.deepEqual((await run(at(13, 31), asleep)).sent, [], 'no 90-min re-ring either');
  assert.deepEqual((await run(at(14, 0))).sent, ['t401g3'], 'the snooze ended and it still waits: one ring');
  assert.match(s.calls.at(-1).headers.Title, /still waiting/);
  assert.equal(s.calls.at(-1).headers.Priority, 'default');
  assert.deepEqual((await run(at(14, 5))).sent, [], 'ONCE');
  assert.deepEqual((await run(at(14, 31))).sent, ['t401g3'], 'the clock restarted at the wake ring: 30 min later');
  assert.deepEqual((await run(at(15, 31))).sent, ['t401g3'], 'and 90 min later');
  assert.deepEqual((await run(at(18, 0))).sent, [], 'then stop');
  assert.equal(s.calls.length, 4);
  const st = JSON.parse(await readFile(file, 'utf8')).sent.t401g3;
  assert.equal(st.snoozed, undefined, 'the snooze mark is cleared by the wake ring');
  assert.equal(st.total, 4);
  // a different gate on the same task is a new item: not snoozed, rings at once
  const two = [task({ gates: [...task().gates, { id: 'g4', status: 'pending', label: 'Push', cls: 'push', agent: 'agent-mesh', requested_at: new Date(at(14, 40)).toISOString() }] })];
  const r = await relayPass({ cfg: SELF, secrets: SECRETS, tasks: two, snoozed: asleep, now: at(14, 41), file, fetchImpl: s.fetchImpl });
  assert.deepEqual(r.sent, ['t401g4']);
  // approvals and plans map to the attention ring's decision:<task> id
  const { attentionId } = await import('../src/relay.mjs');
  assert.equal(attentionId({ kind: 'approval', task: 9 }), 'decision:9');
  assert.equal(attentionId({ kind: 'plan', task: 9 }), 'decision:9');
  assert.equal(attentionId({ kind: 'gate', task: 9, gate: 'g2' }), 'gate:9:g2');
});

test('a wake ring that falls in quiet hours waits for the morning like any re-ring', async () => {
  const file = await tmp(); const s = stub();
  const late = [task({ gates: [{ ...task().gates[0], requested_at: new Date(at(21, 0)).toISOString() }] })];
  const run = (now, snoozed = new Set()) => relayPass({ cfg: SELF, secrets: SECRETS, tasks: late, snoozed, now, file, fetchImpl: s.fetchImpl });
  await run(at(21, 1));
  await run(at(21, 10), new Set(['gate:401:g3']));
  assert.deepEqual((await run(at(23, 0))).held, ['t401g3'], 'the snooze ran out at night: held');
  assert.deepEqual((await run(new Date(2026, 10, 8, 7, 0).getTime())).sent, ['t401g3'], 'rung at 07:00');
  assert.equal(s.calls.length, 2);
});

test('observe = a would-push line and no fetch; failures amber the card and tell the ticker; decided items are done', async () => {
  const file = await tmp(); const s = stub(); const lines = [];
  const r = await relayPass({ cfg: { ...SELF, mode: 'observe' }, secrets: SECRETS, tasks: [task()], now: at(12, 1), file, fetchImpl: s.fetchImpl, record: (k, t) => lines.push(t) });
  assert.deepEqual(r.observed, ['t401g3']);
  assert.equal(s.calls.length, 0, 'observe never touches the network');
  assert.match(lines[0], /^relay \(observe\): would push GATE g3 · #401 · Merge a pull request/);
  assert.ok(!lines[0].includes('gh pr merge'));
  const f2 = await tmp(); const fails = []; const down = async () => ({ ok: false, status: 401 });
  for (let i = 0; i < 3; i++) await relayPass({ cfg: SELF, secrets: SECRETS, tasks: [task()], now: at(12, 1 + i), file: f2, fetchImpl: down, record: (k, t) => fails.push(t) });
  const st = JSON.parse(await readFile(f2, 'utf8'));
  assert.equal(st.failures, 3);
  assert.equal(relayCard(st, SELF, SECRETS).status, 'warn');
  assert.match(relayCard(st, SELF, SECRETS).detail, /desk ping still fires/);
  assert.equal(fails.length, 2, 'the first failure and the third, not every pass');
  const ok = stub();
  await relayPass({ cfg: SELF, secrets: SECRETS, tasks: [task()], now: at(12, 5), file: f2, fetchImpl: ok.fetchImpl });
  await relayPass({ cfg: SELF, secrets: SECRETS, tasks: [task({ gates: [{ ...task().gates[0], status: 'approved' }], status: 'in_progress' })], now: at(12, 6), file: f2, fetchImpl: ok.fetchImpl });
  assert.ok(JSON.parse(await readFile(f2, 'utf8')).sent.t401g3.done, 'a decided gate is marked done');
  assert.equal(relayCard({}, null), null, 'off: no card');
  assert.match(relayCard({}, SELF, {}).detail, /observing only: RELAY_TOKEN missing/);
});

test('postPush never throws; the fallback never sends the token', async () => {
  const r = await postPush({ headers: {}, body: 'x' }, relayConfig(SELF, SECRETS), { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.deepEqual([r.ok, r.error], [false, 'ECONNREFUSED']);
  const s = stub();
  await postPush({ headers: {}, body: 'x' }, relayConfig(FALLBACK, SECRETS), { fetchImpl: s.fetchImpl });
  assert.equal(s.calls[0].headers.Authorization, undefined);
});
