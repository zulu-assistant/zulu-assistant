import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseLsTree, publishSet, diffTrees, parseLog, quietWeek, driftCard, driftDigestLines, planEpisode,
  episodeBody, readDrift, maybeReleaseDrift, readStateSync,
} from '../src/release-drift.mjs';

const DAY = 864e5;
const NOW = Date.parse('2026-03-20T12:00:00Z');
const CFG = { repo: 'example/widget', everyHours: 6, amberDays: 3, owner: 'builder', queued: ['tidy the README'] };
const MANIFEST = { publicRoot: 'publish/public', public: ['src/**', 'LICENSE'], private: ['overlay/**', 'NOTES.md'] };
const sha = (c) => c.repeat(40);

test('ls-tree parse keeps regular blobs, drops symlinks', () => {
  const m = parseLsTree(`100644 blob ${sha('a')}\tsrc/a.mjs\n120000 blob ${sha('b')}\tconfig/x\n100755 blob ${sha('c')}\tbin/run\n`);
  assert.deepEqual([...m.keys()], ['src/a.mjs', 'bin/run']);
});

test('publish set maps publicRoot files and skips private ones; diff finds changed/added/removed', () => {
  const priv = new Map([['src/a.mjs', sha('a')], ['src/b.mjs', sha('b')], ['publish/public/README.md', sha('r')], ['NOTES.md', sha('n')], ['LICENSE', sha('l')]]);
  const pub = publishSet(priv, MANIFEST);
  assert.deepEqual([...pub.keys()].sort(), ['LICENSE', 'README.md', 'src/a.mjs', 'src/b.mjs']);
  assert.equal(pub.get('README.md').src, 'publish/public/README.md');
  const remote = new Map([['src/a.mjs', sha('a')], ['README.md', sha('0')], ['LICENSE', sha('l')], ['src/gone.mjs', sha('g')]]);
  assert.deepEqual(diffTrees(pub, remote), { changed: ['README.md'], added: ['src/b.mjs'], removed: ['src/gone.mjs'] });
  assert.deepEqual(diffTrees(pub, new Map([...pub].map(([p, v]) => [p, v.sha]))), { changed: [], added: [], removed: [] });
});

test('git log lines parse newest-first', () => {
  assert.deepEqual(parseLog('200\tsecond\n100\tfirst\n'), [{ at: 200e3, subject: 'second' }, { at: 100e3, subject: 'first' }]);
});

test('card: due, identical, young drift, amber, stale', () => {
  assert.equal(driftCard({}, null), null);
  assert.equal(driftCard({}, CFG).status, 'due');
  const base = { lastOk: NOW, tag: 'v1.2.0' };
  assert.match(driftCard({ ...base, files: [] }, CFG, NOW).detail, /= v1\.2\.0 \(identical\)/);
  const young = driftCard({ ...base, files: ['src/a.mjs'], oldestAt: NOW - DAY, oldestSubject: 'feat' }, CFG, NOW);
  assert.equal(young.status, 'ok'); assert.match(young.detail, /1 file behind v1\.2\.0.*not amber yet/);
  const old = driftCard({ ...base, files: ['a', 'b'], oldestAt: NOW - 5 * DAY, episode: { task: 7 } }, CFG, NOW);
  assert.equal(old.status, 'warn'); assert.match(old.detail, /2 files behind.*\(5d\).*ask #7/);
  assert.equal(driftCard({ ...base, lastOk: NOW - 2 * DAY, files: [] }, CFG, NOW).status, 'stale');
  assert.equal(driftCard({ ...base, files: ['a'], oldestAt: NOW - 9 * DAY }, CFG, NOW).status !== 'red', true);
});

test('quiet week needs a full week of history below the floor', () => {
  const views = {}; for (let i = 1; i <= 8; i++) views[new Date(NOW - i * DAY).toISOString().slice(0, 10)] = { count: 3, uniques: 1 };
  const stats = { repos: { 'example/widget': { since: '2026-03-01', views } } };
  assert.equal(quietWeek(stats, 'example/widget', 10, NOW), true);
  views[new Date(NOW - 2 * DAY).toISOString().slice(0, 10)] = { count: 12, uniques: 4 };
  assert.equal(quietWeek(stats, 'example/widget', 10, NOW), false);
  assert.equal(quietWeek({ repos: { 'example/widget': { since: '2026-03-18', views: {} } } }, 'example/widget', 10, NOW), false);
  assert.equal(quietWeek(stats, 'example/widget', 0, NOW), false);
});

test('digest lines: identical, behind, channel note only when quiet and unposted', () => {
  assert.deepEqual(driftDigestLines({ lastOk: NOW, tag: 'v1', files: [] }, CFG, {}, NOW), ['  public edition: identical to v1']);
  const st = { lastOk: NOW, tag: 'v1', files: ['a', 'b', 'c'], oldestAt: Date.parse('2026-03-10T00:00:00Z'), episode: { task: 9 } };
  assert.deepEqual(driftDigestLines(st, CFG, {}, NOW), ['  public edition: 3 files behind v1, oldest change 2026-03-10 · task #9']);
  const stats = { repos: { 'example/widget': { since: '2026-01-01', views: {} } } };
  const withNag = driftDigestLines(st, { ...CFG, minViewsPerDay: 5, unposted: ['Forum A', 'Site B'], drafts: 'drafts.md' }, stats, NOW);
  assert.equal(withNag.length, 2); assert.match(withNag[1], /launch channels unposted: Forum A, Site B — repo views < 5\/day for 7 days \(drafts: drafts\.md\)/);
  assert.equal(driftDigestLines(st, { ...CFG, minViewsPerDay: 5, unposted: [] }, stats, NOW).length, 1);
});

test('episodes: nothing while young, create when amber, quiet on same set, comment on change, cancel on zero', () => {
  const next = { tag: 'v1', files: ['src/a.mjs', 'docs/x.md'], oldestAt: NOW - DAY, commits: [{ at: NOW - DAY, subject: 'feat: a' }] };
  assert.deepEqual(planEpisode({}, next, CFG, NOW), []);
  const [c] = planEpisode({}, { ...next, oldestAt: NOW - 4 * DAY }, CFG, NOW);
  assert.equal(c.kind, 'create'); assert.equal(c.input.requester, 'board'); assert.equal(c.input.owner, 'builder');
  assert.match(c.input.title, /2 files behind v1 since/);
  assert.match(c.input.body, /docs\/ x\.md/); assert.match(c.input.body, /feat: a/); assert.match(c.input.body, /tidy the README/);
  const ep = { task: 5, sig: next.files.join('\n'), count: 2 };
  const live = { id: 5, status: 'blocked' };
  assert.deepEqual(planEpisode({ episode: ep }, next, CFG, NOW, live), []);
  const [m] = planEpisode({ episode: ep }, { ...next, files: [...next.files, 'src/b.mjs'] }, CFG, NOW, live);
  assert.equal(m.kind, 'comment'); assert.match(m.text, /3 files behind v1 \(was 2\)/);
  assert.deepEqual(planEpisode({ episode: ep }, { tag: 'v2', files: [] }, CFG, NOW, live), [{ kind: 'cancel', id: 5, text: 'shipped in v2: drift 0' }]);
  assert.deepEqual(planEpisode({ episode: ep }, { tag: 'v2', files: [] }, CFG, NOW, null), []);
});

test('body caps the file list', () => {
  const files = Array.from({ length: 60 }, (_, i) => `src/f${i}.mjs`);
  const body = episodeBody({ tag: 'v1', files, oldestAt: NOW }, CFG);
  assert.match(body, /\(\+20\)/); assert.match(body, /say "release <next tag>" to builder/);
});

// fake gh + git for readDrift / maybeReleaseDrift
async function fixtureRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'drift-'));
  await mkdir(path.join(root, 'publish'), { recursive: true });
  await writeFile(path.join(root, 'publish/manifest.json'), JSON.stringify(MANIFEST));
  return root;
}
function fakeRun({ remote, local, log = '' }) {
  const calls = [];
  const run = (cmd, args, _o, cb) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'gh' && args[1].includes('/releases?')) return cb(null, JSON.stringify([{ tag_name: 'v1', published_at: '2026-03-01T00:00:00Z' }]));
    if (cmd === 'gh' && args[1].includes('/git/trees/')) return cb(null, JSON.stringify({ truncated: false, tree: Object.entries(remote).map(([p, s]) => ({ path: p, sha: s, type: 'blob', mode: '100644' })) }));
    if (cmd === 'git' && args.includes('ls-tree')) return cb(null, Object.entries(local).map(([p, s]) => `100644 blob ${s}\t${p}`).join('\n'));
    if (cmd === 'git' && args.includes('log')) return cb(null, log);
    return cb(new Error(`unexpected ${cmd} ${args.join(' ')}`));
  };
  return { run, calls };
}

test('readDrift: age from the oldest commit since the release, falls back to the release date', async () => {
  const root = await fixtureRoot();
  const { run, calls } = fakeRun({ remote: { 'src/a.mjs': sha('a') }, local: { 'src/a.mjs': sha('b'), 'NOTES.md': sha('n') }, log: '1773700000\tnewer\n1773600000\tolder\n' });
  const r = await readDrift({ cfg: CFG, root, run });
  assert.deepEqual(r.files, ['src/a.mjs']); assert.equal(r.oldestAt, 1773600000e3); assert.equal(r.oldestSubject, 'older');
  assert.ok(calls.some((c) => c.includes('log --since=2026-03-01T00:00:00.000Z') && c.endsWith('-- src/a.mjs')));
  const r2 = await readDrift({ cfg: CFG, root, run: fakeRun({ remote: { 'src/a.mjs': sha('a') }, local: { 'src/a.mjs': sha('b') } }).run });
  assert.equal(r2.oldestAt, Date.parse('2026-03-01T00:00:00Z'));
});

function fakeLedger() {
  const tasks = new Map(); let id = 0; const ops = [];
  return {
    ops, tasks,
    async create(input) { const t = { id: ++id, status: 'open', ...input }; tasks.set(t.id, t); return t; },
    async get(i) { return tasks.get(i) || null; },
    async update(i, patch) { ops.push([i, patch.op, patch.actor]); const t = tasks.get(i); if (patch.op === 'block') t.status = 'blocked'; if (patch.op === 'cancel') t.status = 'cancelled'; return t; },
  };
}

test('maybeReleaseDrift: files one blocked ask, then cancels it when drift returns to zero', async () => {
  const root = await fixtureRoot(); const file = path.join(root, 'state.json'); const ledger = fakeLedger();
  const old = `${Math.floor((NOW - 5 * DAY) / 1000)}\tfeat: a`;
  await maybeReleaseDrift({ cfg: CFG, ledger, now: NOW, file, root, run: fakeRun({ remote: { 'src/a.mjs': sha('a') }, local: { 'src/a.mjs': sha('b') }, log: old }).run });
  let st = readStateSync(file);
  assert.equal(st.episode.task, 1); assert.deepEqual(ledger.ops, [[1, 'block', 'builder']]);
  // not due again inside everyHours
  await maybeReleaseDrift({ cfg: CFG, ledger, now: NOW + 3600e3, file, root, run: () => { throw new Error('should not run'); } });
  // same set later: no comment
  await maybeReleaseDrift({ cfg: CFG, ledger, now: NOW + 7 * 3600e3, file, root, run: fakeRun({ remote: { 'src/a.mjs': sha('a') }, local: { 'src/a.mjs': sha('b') }, log: old }).run });
  assert.equal(ledger.ops.length, 1);
  // shipped
  await maybeReleaseDrift({ cfg: CFG, ledger, now: NOW + 14 * 3600e3, file, root, run: fakeRun({ remote: { 'src/a.mjs': sha('b') }, local: { 'src/a.mjs': sha('b') } }).run });
  st = readStateSync(file);
  assert.deepEqual(ledger.ops.at(-1), [1, 'cancel', 'board']); assert.equal(st.episode, undefined); assert.deepEqual(st.files, []);
});

test('maybeReleaseDrift: a failed read keeps the last reading and records the error', async () => {
  const root = await fixtureRoot(); const file = path.join(root, 'state.json');
  await writeFile(file, JSON.stringify({ lastOk: NOW - 7 * 3600e3, tag: 'v1', files: [] }));
  await maybeReleaseDrift({ cfg: CFG, now: NOW, file, root, run: (_c, _a, _o, cb) => cb(new Error('network down')) });
  const st = readStateSync(file);
  assert.equal(st.tag, 'v1'); assert.match(st.lastError, /network down/);
});

test('real ledger accepts the episode create, block (as owner) and cancel (as requester board)', async () => {
  const { createLedger } = await import('../src/tasks.mjs');
  const root = await fixtureRoot(); const ledger = createLedger(path.join(root, 'tasks')); const file = path.join(root, 'state.json');
  const old = `${Math.floor((NOW - 5 * DAY) / 1000)}\tfeat: a`;
  await maybeReleaseDrift({ cfg: CFG, ledger, now: NOW, file, root, run: fakeRun({ remote: { 'src/a.mjs': sha('a') }, local: { 'src/a.mjs': sha('b') }, log: old }).run });
  const t = await ledger.get(readStateSync(file).episode.task);
  assert.equal(t.status, 'blocked'); assert.equal(t.requester, 'board'); assert.equal(t.owner, 'builder'); assert.equal(t.blocked_on.length, 1);
  await maybeReleaseDrift({ cfg: CFG, ledger, now: NOW + 7 * 3600e3, file, root, run: fakeRun({ remote: { 'src/a.mjs': sha('b') }, local: { 'src/a.mjs': sha('b') } }).run });
  const done = await ledger.get(t.id);
  assert.equal(done.status, 'cancelled'); assert.match(done.comments.at(-1).text, /shipped in v1: drift 0/);
});
