// node --test "test/*.test.mjs" — #787 part 2: a pane the board cannot read is told once per episode
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  drainOutbox, enqueue, deliverNow, deliveryDecision, markUnread, unreadableTargets, unreadableNotices, unreadableText, UNREAD_REASON, UNREAD_TELL_MS,
} from '../src/mesh.mjs';

const MIN = 60e3;
const T0 = 1_000_000;
const AGENT = { name: 'sales-agent', workspaceId: 'W1' };
// a fresh folder per state (never a delete inside one)
const box = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'outbox-unread-')), 'outbox.json');

function screen() {
  let state = 'unknown';
  return {
    set: (s) => { state = s; },
    deliver: async () => (state === 'ready' ? { delivered: true }
      : state === 'busy' ? { queued: 'target busy (will deliver when idle; --wake to queue it inside the session now)' }
        : { queued: UNREAD_REASON }),
  };
}

test('#787 an unreadable target: 4 min nothing, 6 min one notice, 20 min still one', async () => {
  const file = await box();
  await enqueue({ to: 'sales-agent', line: 'L1', queuedAt: T0 }, file);
  await enqueue({ to: 'sales-agent', line: 'L2', queuedAt: T0 }, file);
  const s = screen();
  const resolve = async () => AGENT;
  let r = await drainOutbox({ file, now: T0, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, []);
  r = await drainOutbox({ file, now: T0 + 4 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, []);
  r = await drainOutbox({ file, now: T0 + 6 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, [{ to: 'sales-agent', minutes: 6, count: 2 }]);
  r = await drainOutbox({ file, now: T0 + 20 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, [], 'one notice per episode');
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(saved.every((m) => m.unreadSince === T0 && m.toldAt === T0 + 6 * MIN));
});

test('#787 through the real classifier: a screen it does not recognise starts the clock and is told at 5 min', async () => {
  const file = await box();
  await enqueue({ to: 'sales-agent', line: 'L1', queuedAt: T0 }, file);
  const calls = [];
  // a pane whose screen matches no known shape (no input line, no footer, no dialog, no prompt)
  const run = async (args) => { calls.push(args); return args[0] === 'read-screen' ? { err: null, out: 'loading…\n\n\n   ░░░ some splash art ░░░\n' } : { err: null, out: 'OK' }; };
  const agent = { name: 'sales-agent', workspaceId: 'W1', vendor: 'claude' };
  const deliver = (a, line, o) => deliverNow(a, line, { ...o, run, sleep: async () => {} });
  const resolve = async () => agent;
  let r = await drainOutbox({ file, now: T0, resolve, deliver });
  assert.equal(r.still[0].lastReason, UNREAD_REASON, 'the classifier\'s own reason, not a copy of its words');
  assert.equal(r.still[0].unreadSince, T0);
  r = await drainOutbox({ file, now: T0 + 5 * MIN, resolve, deliver });
  assert.deepEqual(r.unreadable, [{ to: 'sales-agent', minutes: 5, count: 1 }]);
  assert.ok(!calls.some((a) => a[0] === 'send' || a[0] === 'send-key'), 'nothing typed into an unreadable pane');
  assert.equal(deliveryDecision('unknown').queue, UNREAD_REASON);
});

test('#787 the clock starts when the screen stops being readable, not when the message was queued', async () => {
  const file = await box();
  await enqueue({ to: 'sales-agent', line: 'L1', queuedAt: T0 }, file);
  const s = screen();
  const resolve = async () => AGENT;
  s.set('busy');
  await drainOutbox({ file, now: T0 + 30 * MIN, resolve, deliver: s.deliver });
  s.set('unknown');
  let r = await drainOutbox({ file, now: T0 + 31 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, []);
  r = await drainOutbox({ file, now: T0 + 36 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, [{ to: 'sales-agent', minutes: 5, count: 1 }]);
});

test('#787 a readable screen ends the episode; the next one is told again', async () => {
  const file = await box();
  await enqueue({ to: 'sales-agent', line: 'L1', queuedAt: T0 }, file);
  const s = screen();
  const resolve = async () => AGENT;
  await drainOutbox({ file, now: T0, resolve, deliver: s.deliver });
  let r = await drainOutbox({ file, now: T0 + 6 * MIN, resolve, deliver: s.deliver });
  assert.equal(r.unreadable.length, 1);
  // the pane reads busy for a while: the episode is over, its marks are gone
  s.set('busy');
  await drainOutbox({ file, now: T0 + 7 * MIN, resolve, deliver: s.deliver });
  let saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved[0].unreadSince, undefined);
  assert.equal(saved[0].toldAt, undefined);
  // unreadable again: a new episode, told again after 5 min
  s.set('unknown');
  await drainOutbox({ file, now: T0 + 8 * MIN, resolve, deliver: s.deliver });
  r = await drainOutbox({ file, now: T0 + 13 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.unreadable, [{ to: 'sales-agent', minutes: 5, count: 1 }]);
  // a ready read delivers it: nothing left to tell about
  s.set('ready');
  r = await drainOutbox({ file, now: T0 + 14 * MIN, resolve, deliver: s.deliver });
  assert.deepEqual(r.delivered.map((m) => m.line), ['L1']);
  saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(saved, []);
});

test('#787 targets are told separately; a message queued during a told episode does not tell again', () => {
  const now = T0 + 10 * MIN;
  const msgs = [
    { to: 'a', unreadSince: T0 }, { to: 'a', unreadSince: T0 + 9 * MIN },
    { to: 'b', unreadSince: T0 + 8 * MIN },
    { to: 'c', unreadSince: T0, toldAt: T0 + 5 * MIN }, { to: 'c', unreadSince: now },
    { to: 'd' },
  ];
  assert.deepEqual(unreadableTargets(msgs, now), [{ to: 'a', minutes: 10, count: 2 }]);
  assert.equal(UNREAD_TELL_MS, 5 * MIN);
  assert.deepEqual(markUnread({ to: 'a', lastReason: UNREAD_REASON }, 5), { to: 'a', lastReason: UNREAD_REASON, unreadSince: 5 });
  assert.deepEqual(markUnread({ to: 'a', lastReason: UNREAD_REASON, unreadSince: 1 }, 5).unreadSince, 1);
  assert.deepEqual(markUnread({ to: 'a', lastReason: 'target busy', unreadSince: 1, toldAt: 2 }, 5), { to: 'a', lastReason: 'target busy' });
});

test('#787 Mission Control hears about other panes, never its own (ticker only); the words are the board\'s', () => {
  const names = { 'mission-control': 'mission-control-main', 'mission-control-main': 'mission-control-main', sales: 'sales-agent' };
  const out = unreadableNotices([
    { to: 'sales', minutes: 6, count: 2 },
    { to: 'mission-control', minutes: 7, count: 1 },
    { to: 'mission-control-main', minutes: 8, count: 1 },
    { to: 'unknown-name', minutes: 9, count: 1 },
  ], { mcName: 'mission-control-main', nameOf: (x) => names[x] || null });
  assert.deepEqual(out.map((n) => n.tellMc), [true, false, false, true]);
  assert.equal(out[0].text, 'sales has not been readable for 6 min; 2 message(s) waiting; check its pane');
  assert.equal(unreadableText({ to: 'x', minutes: 1, count: 1 }), 'x has not been readable for 1 min; 1 message(s) waiting; check its pane');
});
