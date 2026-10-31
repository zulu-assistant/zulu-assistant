import { test } from 'node:test';
import assert from 'node:assert/strict';
import { socketMode } from '../src/intake-slack.mjs';
import { catchupOldest, parseSince, seenFloor, historyEvents, missedByLink, linkHealth, linkStatePatch, publishBackoff } from '../src/intake.mjs';
import { linkCard } from '../src/status.mjs';

// ── fakes: a WebSocket that only does what the test says, and manual timers ──
function fakeClock(start = 1_000_000) {
  let t = start; let seq = 0; const q = new Map();
  return {
    now: () => t,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; q.set(id, { at: t + ms, fn }); return id; },
      clearTimeout(id) { q.delete(id); },
      setInterval(fn, ms) { const id = ++seq; q.set(id, { at: t + ms, fn, every: ms }); return id; },
      clearInterval(id) { q.delete(id); },
    },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, x] = due; t = x.at;
        if (x.every) x.at += x.every; else q.delete(id);
        x.fn();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
      await new Promise((r) => setImmediate(r));
    },
  };
}
function fakeWs() {
  const made = [];
  class WS {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.l = {}; this.sent = []; this.closed = false; made.push(this); }
    addEventListener(k, fn) { (this.l[k] ||= []).push(fn); }
    send(x) { this.sent.push(x); }
    close() { this.closed = true; this.readyState = 2; }            // a half-dead link: close() never fires 'close'
    emit(k, data) { for (const fn of this.l[k] || []) fn(data); }
    frame(obj) { this.readyState = 1; this.emit('message', { data: JSON.stringify(obj) }); }
  }
  return { WS, made };
}
const okOpen = async () => ({ status: 200, json: async () => ({ ok: true, url: 'wss://example.test/link' }) });
const tick = () => new Promise((r) => setImmediate(r));

test('a disconnect frame dials a new socket at once, without waiting for close', async () => {
  const c = fakeClock(); const { WS, made } = fakeWs(); const log = []; let events = 0;
  const s = socketMode({ appToken: 'a', onEvent: () => { events++; }, WebSocketImpl: WS, fetchImpl: okOpen, timers: c.timers, now: c.now, log: (x) => log.push(x), exit: () => assert.fail('no exit') });
  await tick(); await tick();
  made[0].frame({ type: 'hello' });
  made[0].frame({ type: 'disconnect', reason: 'warning' });
  await tick(); await tick();
  assert.equal(made.length, 2); assert.equal(made[0].closed, true);
  // frames from the dropped socket are ignored
  made[0].frame({ type: 'events_api', envelope_id: 'e1', payload: { event: { type: 'message' } } });
  assert.equal(events, 0); assert.equal(made[0].sent.length, 0);
  made[1].frame({ type: 'events_api', envelope_id: 'e2', payload: { event: { type: 'message' } } });
  await tick();
  assert.equal(events, 1); assert.deepEqual(made[1].sent, [JSON.stringify({ envelope_id: 'e2' })]);
  s.stop();
});

test('the watchdog revives a socket stuck in CLOSING / CONNECTING', async () => {
  const c = fakeClock(); const { WS, made } = fakeWs();
  const s = socketMode({ appToken: 'a', onEvent() {}, WebSocketImpl: WS, fetchImpl: okOpen, timers: c.timers, now: c.now, log: () => {}, exit: () => assert.fail('no exit') });
  await tick(); await tick();
  made[0].frame({ type: 'hello' });
  made[0].readyState = 2;                       // went CLOSING on its own, no close event
  await c.advance(65_000);
  assert.equal(made.length, 2);
  s.stop();
});

test('no hello for maxDownMs → exit(1) for the service manager; auth errors never exit', async () => {
  const c = fakeClock(); const { WS, made } = fakeWs(); const exits = [];
  socketMode({ appToken: 'a', onEvent() {}, WebSocketImpl: WS, fetchImpl: okOpen, timers: c.timers, now: c.now, log: () => {}, exit: (n) => exits.push(n), maxDownMs: 5 * 60e3 });
  await tick(); await tick();
  assert.equal(made.length, 1);                 // dialled, but Slack never says hello
  await c.advance(6 * 60e3);
  assert.deepEqual(exits, [1]);

  const c2 = fakeClock(); const exits2 = [];
  const authFail = async () => ({ status: 200, json: async () => ({ ok: false, error: 'invalid_auth' }) });
  const s2 = socketMode({ appToken: 'a', onEvent() {}, WebSocketImpl: fakeWs().WS, fetchImpl: authFail, timers: c2.timers, now: c2.now, log: () => {}, exit: (n) => exits2.push(n), maxDownMs: Infinity });
  await c2.advance(60 * 60e3);
  assert.deepEqual(exits2, []);
  s2.stop();
});

test('repeated connections.open failures (not auth) → exit(1)', async () => {
  const c = fakeClock(); const exits = [];
  const down = async () => ({ status: 200, json: async () => ({ ok: false, error: 'internal_error' }) });
  socketMode({ appToken: 'a', onEvent() {}, WebSocketImpl: fakeWs().WS, fetchImpl: down, timers: c.timers, now: c.now, log: () => {}, exit: (n) => exits.push(n), maxOpenFailures: 3, maxDownMs: Infinity });
  await c.advance(30 * 60e3);
  assert.deepEqual(exits, [1]);
});

test('hello reports reconnect: false first, true after a reconnect; kick() forces one', async () => {
  const c = fakeClock(); const { WS, made } = fakeWs(); const hellos = [];
  const s = socketMode({ appToken: 'a', onEvent() {}, onHello: (h) => hellos.push(h.reconnect), WebSocketImpl: WS, fetchImpl: okOpen, timers: c.timers, now: c.now, log: () => {}, exit: () => {} });
  await tick(); await tick();
  made[0].frame({ type: 'hello' });
  s.kick('test');
  await tick(); await tick();
  made[1].frame({ type: 'hello' });
  assert.deepEqual(hellos, [false, true]); assert.equal(made[0].closed, true);
  s.stop();
});

// ── catch-up (pure) ──
const NOW = Date.parse('2026-04-10T12:00:00Z');
const ts = (iso) => (Date.parse(iso) / 1000).toFixed(6);

test('catch-up start: the cursor, else the service start (never the past); a manual window reaches back; 7-day cap', () => {
  assert.equal(catchupOldest({ cursor: ts('2026-04-10T10:00:00Z'), now: NOW }), ts('2026-04-10T10:00:00Z'));
  assert.equal(catchupOldest({ now: NOW }), (NOW / 1000).toFixed(6));
  assert.equal(catchupOldest({ cursor: ts('2026-03-01T00:00:00Z'), now: NOW }), ((NOW - 7 * 864e5) / 1000).toFixed(6));
  assert.equal(catchupOldest({ now: NOW, since: Date.parse('2026-04-09T00:00:00Z') }), ts('2026-04-09T00:00:00Z'));
  assert.equal(catchupOldest({ cursor: ts('2026-04-08T00:00:00Z'), since: Date.parse('2026-04-09T00:00:00Z'), now: NOW }), ts('2026-04-08T00:00:00Z'));
  assert.equal(catchupOldest({ now: NOW, since: Date.parse('2026-01-01T00:00:00Z') }), ((NOW - 7 * 864e5) / 1000).toFixed(6));
});

test('--since parses ISO times and h/d offsets', () => {
  assert.equal(parseSince('12h', NOW), NOW - 12 * 3600e3);
  assert.equal(parseSince('2d', NOW), NOW - 2 * 864e5);
  assert.equal(parseSince('2026-04-09T08:00:00Z', NOW), Date.parse('2026-04-09T08:00:00Z'));
  assert.equal(parseSince('soon', NOW), null);
  assert.equal(parseSince('', NOW), null);
});

test('history: top-level messages after oldest, oldest first, thread replies left out', () => {
  const msgs = [
    { ts: '300.0', text: 'c' }, { ts: '250.0', thread_ts: '100.0', text: 'reply' },
    { ts: '200.0', thread_ts: '200.0', text: 'thread parent' }, { ts: '90.0', text: 'too old' },
    { ts: '260.0', thread_ts: '100.0', subtype: 'thread_broadcast', text: 'also sent to channel' },
  ];
  const out = historyEvents(msgs, 'C1', '100.0');
  assert.deepEqual(out.map((e) => e.ts), ['200.0', '260.0', '300.0']);
  assert.ok(out.every((e) => e.channel === 'C1' && e.type === 'message'));
});

test('missed by the link: older than the grace and unseen', () => {
  const ev = { channel: 'C1', ts: ts('2026-04-10T11:58:00Z') };
  assert.equal(missedByLink(ev, () => false, NOW), true);
  assert.equal(missedByLink(ev, (k) => k === `C1:${ev.ts}`, NOW), false);
  assert.equal(missedByLink({ channel: 'C1', ts: ts('2026-04-10T11:59:30Z') }, () => false, NOW), false);
});

// ── health card ──
const iso = (minAgo) => new Date(NOW - minAgo * 60e3).toISOString();

test('link health: ok, quiet → warn, long quiet / long down → down; not configured is ok', () => {
  assert.equal(linkHealth({ state: 'connected', connectedAt: iso(300), lastFrameAt: iso(200), lastSweepOkAt: iso(3) }, { now: NOW }).level, 'ok');
  assert.equal(linkHealth({ state: 'connected', connectedAt: iso(300), lastFrameAt: iso(20), lastSweepOkAt: iso(15) }, { now: NOW }).level, 'warn');
  assert.equal(linkHealth({ state: 'connected', connectedAt: iso(3000), lastFrameAt: iso(2900), lastSweepOkAt: null }, { now: NOW }).level, 'down');
  assert.equal(linkHealth({ state: 'connecting', since: iso(70), downSince: iso(70) }, { now: NOW }).level, 'down');
  assert.equal(linkHealth({ state: 'starting', since: iso(2) }, { now: NOW }).level, 'ok');
  assert.equal(linkHealth({ state: 'not configured', since: iso(9999) }, { now: NOW }).level, 'ok');
  assert.match(linkHealth({ state: 'connected', connectedAt: iso(300), lastFrameAt: iso(1), lastSweepOkAt: iso(2), reconnects: 4 }, { now: NOW }).why, /4 reconnect/);
});

test('linkCard maps health onto board statuses (red = down = alert ladder)', () => {
  const job = { linkStatus: { file: 'x.json', warnMin: 10, redMin: 60 } };
  const at = (st) => linkCard(job, 42, NOW, () => st);
  assert.equal(at({ state: 'connected', connectedAt: iso(100), lastSweepOkAt: iso(1) }).status, 'ok');
  assert.match(at({ state: 'connected', connectedAt: iso(100), lastSweepOkAt: iso(30) }).detail, /pid 42 · link QUIET/);
  assert.equal(at({ state: 'disconnected', downSince: iso(90) }).status, 'down');
  assert.equal(linkCard(job, 42, NOW, () => { throw new Error('missing'); }).status, 'ok');
});

test('publish backoff: 3 tries (now, +1 min, +5 min), permanent errors drop at once', () => {
  assert.equal(publishBackoff('chat.postMessage: ratelimited', 1), 60e3);
  assert.equal(publishBackoff('chat.postMessage: ratelimited', 2), 300e3);
  assert.equal(publishBackoff('chat.postMessage: ratelimited', 3), null);
  assert.equal(publishBackoff('chat.postMessage: invalid_arguments', 1), null);
});

test('no cursor: the floor is the service start, even when seen.json holds older messages (MC #340 blocker)', () => {
  const seenKeys = [`C1:${ts('2026-04-03T09:00:00Z')}`, `C1:${ts('2026-04-01T09:00:00Z')}`];
  assert.equal(seenFloor(seenKeys, 'C1'), ts('2026-04-03T09:00:00Z'));          // shown by --check only
  const start = catchupOldest({ now: NOW });                                       // what the first sweep reads from
  assert.equal(start, (NOW / 1000).toFixed(6));
  // a request posted before the service started (already filed by hand) is never picked up
  const before = { ts: ts('2026-04-10T09:13:00Z'), text: 'earlier request' };
  const after = { ts: ts('2026-04-10T12:00:30Z'), text: 'new request' };
  assert.deepEqual(historyEvents([after, before], 'C1', start).map((e) => e.ts), [after.ts]);
});

test('a socket close is logged with its code and reason, then redialled', async () => {
  const c = fakeClock(); const { WS, made } = fakeWs(); const log = []; const states = [];
  const s = socketMode({ appToken: 'a', onEvent: () => {}, onState: (st, why) => states.push([st, why]), WebSocketImpl: WS, fetchImpl: okOpen, timers: c.timers, now: c.now, log: (x) => log.push(x), exit: () => assert.fail('no exit') });
  await tick(); await tick();
  made[0].frame({ type: 'hello' });
  made[0].emit('close', { code: 1006, reason: '' });
  assert.ok(log.includes('[chat-intake] socket closed (code 1006) — reconnecting'), log.join('\n'));
  assert.deepEqual(states.find(([st]) => st === 'disconnected'), ['disconnected', 'socket closed (code 1006)']);
  await c.advance(1000); await tick();
  assert.equal(made.length, 2);
  made[1].emit('close', { code: 1001, reason: 'going away' });
  assert.ok(log.includes('[chat-intake] socket closed (code 1001, going away) — reconnecting'));
  made[0].emit('close', { code: 1000 });          // an old socket's late close says nothing
  assert.equal(log.filter((x) => x.includes('socket closed')).length, 2);
  s.stop();
});

test('status patch: a good hello clears the last error and counts the reconnect', () => {
  const at = '2026-01-02T00:00:00.000Z';
  const prev = { state: 'error', lastError: 'fetch failed', connectedAt: '2026-01-01T00:00:00.000Z', reconnects: 2, downSince: '2026-01-01T23:59:00.000Z' };
  assert.deepEqual(linkStatePatch('connected', undefined, prev, at), { state: 'connected', connectedAt: at, downSince: null, lastFrameAt: at, lastError: null, reconnects: 3 });
  assert.deepEqual(linkStatePatch('connected', undefined, {}, at).reconnects, 0);
  assert.deepEqual(linkStatePatch('error', 'fetch failed', prev, at), { state: 'error', lastError: 'fetch failed' });
  assert.deepEqual(linkStatePatch('disconnected', 'socket closed (code 1006)', prev, at), { state: 'disconnected', downSince: prev.downSince, lastError: 'socket closed (code 1006)' });
  assert.deepEqual(linkStatePatch('connecting', undefined, prev, at), { state: 'connecting' });
});
