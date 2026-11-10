// Channel discovery (#365): visible-but-unrouted chat channels → one board task each.
// Neutral fixtures; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelsFrom, unmappedChannels, discoveryTask } from '../src/intake.mjs';
import { maybeChannelDiscovery, readUnmapped } from '../src/channel-discovery.mjs';

const CFG = channelsFrom({
  statusChannel: 'status',
  ignoreChannels: ['#General'],
  channels: [{ name: 'orders', owner: 'shop-agent' }],
});
const VISIBLE = new Map([
  ['orders', { id: 'C1', member: true }],
  ['status', { id: 'C2', member: true }],
  ['general', { id: 'C3', member: true }],
  ['blog-asks', { id: 'C5', member: false }],
  ['art', { id: 'C4', member: true }],
]);

test('unmapped = visible minus routes, the status channel and ignoreChannels (case/# folded), sorted', () => {
  assert.deepEqual(CFG.ignoreChannels, ['general']);
  assert.deepEqual(unmappedChannels(VISIBLE, CFG), [
    { name: 'art', id: 'C4', member: true },
    { name: 'blog-asks', id: 'C5', member: false },
  ]);
  assert.deepEqual(unmappedChannels(new Map(), CFG), []);
  assert.deepEqual(channelsFrom({}).ignoreChannels, []);
});

test('discovery task: board requester, a per-channel source key, and says when the bot is not invited', () => {
  const t = discoveryTask({ name: 'blog-asks', id: 'C5', member: false }, { owner: 'coordinator' });
  assert.equal(t.requester, 'board');
  assert.equal(t.owner, 'coordinator');
  assert.deepEqual(t.source, { via: 'channel-discovery', key: 'slack-channel:C5' });
  assert.match(t.title, /#blog-asks is not routed/);
  assert.match(t.body, /bot is not a member/);
  assert.match(t.body, /ignoreChannels/);
  assert.doesNotMatch(discoveryTask({ name: 'art', id: 'C4', member: true }).body, /not a member/);
});

function fakeLedger() {
  const byKey = new Map();
  let n = 0;
  return {
    calls: 0,
    async create(input) {
      this.calls++;
      const k = input.source.key;
      if (byKey.has(k)) return { ...byKey.get(k), existing: true };
      const t = { id: ++n, ...input };
      byKey.set(k, t);
      return t;
    },
  };
}

test('one pass files each new channel once, with one ticker line; repeats and existing tasks stay quiet', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'chan-disc-'));
  assert.deepEqual(await readUnmapped(dir), [], 'no status.json = intake not installed = nothing');
  await writeFile(path.join(dir, 'status.json'), JSON.stringify({ unmapped: unmappedChannels(VISIBLE, CFG) }));
  const ledger = fakeLedger();
  const lines = [];
  const woke = [];
  const seen = new Set();
  const opts = { stateDir: dir, ledger, owner: 'coordinator', record: (k, t) => lines.push([k, t]), afterCreate: async (t) => woke.push(t.id), seen };
  const made = await maybeChannelDiscovery(opts);
  assert.deepEqual(made.map((t) => t.title), ['Slack channel #art is not routed: map it or ignore it', 'Slack channel #blog-asks is not routed: map it or ignore it']);
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0], 'bad');
  assert.match(lines[1][1], /#blog-asks is not routed \(bot not invited\).*task #2/);
  assert.deepEqual(woke, [1, 2]);
  // the next poll: already handled this boot → no ledger calls at all
  assert.deepEqual(await maybeChannelDiscovery(opts), []);
  assert.equal(ledger.calls, 2);
  // after a board restart the ledger's source-key dedupe answers "existing": no new line, no wake
  const again = await maybeChannelDiscovery({ ...opts, seen: new Set() });
  assert.deepEqual(again, []);
  assert.equal(lines.length, 2);
  assert.deepEqual(woke, [1, 2]);
});
