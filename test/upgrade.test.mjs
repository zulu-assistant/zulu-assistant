import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh } from '../src/worktree.mjs';
import { parseSemver, cmpSemver, pickRelease, upgradeConfig, repoOfRemote, releaseInstall, upgradeCard, requestAllowed, upgradePlist, maybeUpgradeCheck } from '../src/upgrade.mjs';
import { preflight, runUpgrade } from '../scripts/upgrade.mjs';
import { migrate } from '../scripts/migrate.mjs';

// One-click upgrade (#346): real git in temp dirs under a path WITH A SPACE. The "public repo" is a
// local bare remote reached through a github.com URL (url.<path>.insteadOf), so nothing touches the network.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
});
const REPO = 'acme/zulu';
const URL_ = `https://github.com/${REPO}.git`;
const g = async (cwd, ...args) => { const r = await sh('git', ['-C', cwd, ...args]); assert.ok(r.ok, `git ${args.join(' ')}: ${r.err}`); return r.out; };
const CFG = { mode: 'on', repo: REPO };

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'upgrade tests-')));
  const origin = path.join(base, 'origin.git');
  await sh('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const dev = path.join(base, 'dev repo');
  await sh('git', ['clone', '-q', origin, dev]);
  await writeFile(path.join(dev, '.gitignore'), 'data/\noverlay/\n');
  await writeFile(path.join(dev, 'a.txt'), 'v1.0.0');
  await g(dev, 'add', '.'); await g(dev, 'commit', '-qm', 'release 1.0.0'); await g(dev, 'tag', 'v1.0.0');
  await writeFile(path.join(dev, 'a.txt'), 'v1.0.1');
  await g(dev, 'commit', '-qam', 'release 1.0.1'); await g(dev, 'tag', 'v1.0.1');
  await g(dev, 'push', '-q', 'origin', 'main', '--tags');
  // the install: a clone at v1.0.0 whose origin reads as the GitHub repo
  const inst = path.join(base, 'zulu install');
  await sh('git', ['clone', '-q', origin, inst]);
  await g(inst, 'reset', '-q', '--hard', 'v1.0.0');
  await g(inst, 'remote', 'set-url', 'origin', URL_);
  await g(inst, 'config', `url.${origin}.insteadOf`, URL_);
  await mkdir(path.join(inst, 'overlay', 'config'), { recursive: true });
  await writeFile(path.join(inst, 'overlay', 'config', 'owner.json'), '{"mine":true}');
  const tagSha = async (t) => g(dev, 'rev-list', '-n', '1', t);
  return { base, origin, dev, inst, tagSha };
}

const rels = [{ tag_name: 'v1.0.1', html_url: 'https://x/1.0.1' }, { tag_name: 'v1.0.0' }];
function steps(f, over = {}) {
  const calls = [];
  const ok = (name) => async (...a) => { calls.push(name); return { ok: true, detail: name }; };
  return { calls, s: {
    freeMb: async () => 10000, releases: async () => rels, verifyTag: async ({ tag }) => f.tagSha(tag),
    restorePoint: ok('restorePoint'), migrate: ok('migrate'), tests: ok('tests'), install: ok('install'),
    restart: ok('restart'), health: ok('health'), bootId: async () => 'boot1', bootout: async () => {}, ...over,
  } };
}

test('semver order, channels, config, remotes', () => {
  assert.deepEqual(parseSemver('v1.2.3-beta.4'), { major: 1, minor: 2, patch: 3, pre: ['beta', 4] });
  assert.equal(parseSemver('main'), null);
  assert.ok(cmpSemver('v1.0.0-beta.4', 'v1.0.0') < 0, 'a prerelease sorts before its release');
  assert.ok(cmpSemver('v1.0.10', 'v1.0.9') > 0);
  assert.ok(cmpSemver('v0.1.0-beta.10', 'v0.1.0-beta.9') > 0);
  const list = [{ tag_name: 'v1.1.0-beta.1', prerelease: true }, { tag_name: 'v1.0.1' }, { tag_name: 'v1.0.0' }, { tag_name: 'v2.0.0', draft: true }];
  assert.equal(pickRelease(list, 'v1.0.0').tag, 'v1.0.1', 'stable skips prereleases and drafts');
  assert.equal(pickRelease(list, 'v1.0.0', 'pre').tag, 'v1.1.0-beta.1');
  assert.equal(pickRelease(list, 'v1.0.1'), null, 'nothing newer');
  assert.deepEqual(upgradeConfig(null), { mode: 'off' });
  assert.equal(upgradeConfig(undefined, 'https://github.com/a/b').mode, 'on', 'an overlay without the key keeps checking');
  assert.equal(upgradeConfig(undefined, 'https://github.com/a/b').repo, 'a/b');
  assert.deepEqual(upgradeConfig({ mode: 'on' }, ''), { mode: 'off' }, 'no repo = off');
  assert.equal(repoOfRemote('git@github.com:Acme/Zulu.git'), 'acme/zulu');
  assert.equal(repoOfRemote('https://github.com/acme/zulu'), 'acme/zulu');
  assert.equal(repoOfRemote('/some/local/path'), '');
});

test('release install: only origin = the public repo AND HEAD exactly on a release tag', async () => {
  const f = await fixture();
  assert.deepEqual((await releaseInstall({ root: f.inst, repo: REPO })).tag, 'v1.0.0');
  assert.match((await releaseInstall({ root: f.inst, repo: 'other/repo' })).why, /origin is not other\/repo/);
  await writeFile(path.join(f.inst, 'b.txt'), 'local'); await g(f.inst, 'add', 'b.txt'); await g(f.inst, 'commit', '-qm', 'local');
  assert.match((await releaseInstall({ root: f.inst, repo: REPO })).why, /not a release tag/);
});

test('upgrade happy path: preflight, backup, ff-only to the tag, every step in order, state recorded', async () => {
  const f = await fixture();
  const { calls, s } = steps(f);
  const pre = await preflight({ root: f.inst, cfg: CFG, steps: s });
  assert.deepEqual([pre.ok, pre.from, pre.to, pre.commits], [true, 'v1.0.0', 'v1.0.1', ['release 1.0.1']], pre.why);
  const lines = [];
  const r = await runUpgrade({ root: f.inst, cfg: CFG, steps: s, log: (l) => lines.push(l) });
  assert.equal(r.ok, true, r.reason);
  assert.equal(await g(f.inst, 'describe', '--tags', '--exact-match', 'HEAD'), 'v1.0.1');
  assert.deepEqual(calls, ['restorePoint', 'migrate', 'tests', 'install', 'restart', 'health']);
  assert.ok(existsSync(path.join(r.backup, 'overlay', 'config', 'owner.json')), 'overlay backed up');
  assert.equal(JSON.parse(await readFile(path.join(r.backup, 'prev.json'), 'utf8')).tag, 'v1.0.0');
  const st = JSON.parse(await readFile(path.join(f.inst, 'data', 'upgrade-state.json'), 'utf8'));
  assert.deepEqual([st.lastRun.ok, st.lastRun.to, st.running], [true, 'v1.0.1', null]);
  assert.ok(lines.some((l) => /v1\.0\.1 healthy/.test(l)));
  assert.ok(!existsSync(path.join(f.inst, 'data', 'upgrade.lock')), 'lock released');
  assert.equal((await runUpgrade({ root: f.inst, cfg: CFG, steps: s })).upToDate, true);
});

test('refusals change nothing: dirty tree, tag commit differs from GitHub, not a fast-forward, a held lock', async () => {
  const f = await fixture();
  const head = await g(f.inst, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.inst, 'a.txt'), 'edited');
  let r = await runUpgrade({ root: f.inst, cfg: CFG, steps: steps(f).s });
  assert.match(r.reason, /working tree has changes/);
  await g(f.inst, 'checkout', '-q', '--', 'a.txt');
  r = await runUpgrade({ root: f.inst, cfg: CFG, steps: steps(f, { verifyTag: async () => 'f'.repeat(40) }).s });
  assert.match(r.reason, /on GitHub: refusing/);
  // a rewritten history: v1.0.2 on an orphan branch
  await g(f.dev, 'checkout', '-q', '--orphan', 'rewrite'); await writeFile(path.join(f.dev, 'a.txt'), 'v1.0.2');
  await g(f.dev, 'add', '.'); await g(f.dev, 'commit', '-qm', 'rewritten'); await g(f.dev, 'tag', 'v1.0.2'); await g(f.dev, 'push', '-q', 'origin', 'v1.0.2');
  r = await runUpgrade({ root: f.inst, cfg: CFG, to: 'v1.0.2', steps: steps(f).s });
  assert.match(r.reason, /not a fast-forward/);
  await mkdir(path.join(f.inst, 'data'), { recursive: true }); await writeFile(path.join(f.inst, 'data', 'upgrade.lock'), '');
  r = await runUpgrade({ root: f.inst, cfg: CFG, steps: steps(f).s });
  assert.match(r.reason, /another upgrade is running/);
  assert.equal(await g(f.inst, 'rev-parse', 'HEAD'), head, 'HEAD never moved');
});

test('a failing step after the code moved rolls back to the exact sha with overlay/ restored', async () => {
  const f = await fixture();
  const head = await g(f.inst, 'rev-parse', 'HEAD');
  const after = [];
  const { s } = steps(f, {
    tests: async () => {                                                  // the new code also "changed" the overlay
      await writeFile(path.join(f.inst, 'overlay', 'config', 'owner.json'), '{"mine":false}');
      await writeFile(path.join(f.inst, 'overlay', 'config', 'new.json'), '{}');
      return { ok: false, detail: 'tests failed (2 failing)' };
    },
    install: async () => { after.push('install'); return { ok: true, detail: '' }; },
    restart: async () => { after.push('restart'); return { ok: true, detail: '' }; },
    health: async ({ commit }) => { after.push(`health ${commit === head ? 'prev' : 'other'}`); return { ok: true, detail: '' }; },
  });
  const r = await runUpgrade({ root: f.inst, cfg: CFG, steps: s });
  assert.deepEqual([r.ok, r.step, r.rolledBack, r.healthy], [false, 'tests', true, true]);
  assert.equal(await g(f.inst, 'rev-parse', 'HEAD'), head, 'back on the exact previous sha');
  assert.equal(await readFile(path.join(f.inst, 'overlay', 'config', 'owner.json'), 'utf8'), '{"mine":true}');
  assert.ok(!existsSync(path.join(f.inst, 'overlay', 'config', 'new.json')));
  assert.deepEqual(after, ['install', 'restart', 'health prev'], 'reinstalled, restarted and checked on the old code');
  const card = upgradeCard({ ...JSON.parse(await readFile(path.join(f.inst, 'data', 'upgrade-state.json'), 'utf8')), checkedAt: Date.now(), release: true, current: 'v1.0.0', available: { tag: 'v1.0.1' } }, CFG);
  assert.match(card.detail, /last upgrade to v1\.0\.1 failed at tests: tests failed \(2 failing\) \(rolled back to v1\.0\.0, healthy\)/);
  const bad = steps(f, { tests: async () => ({ ok: false, detail: 'x' }), health: async () => ({ ok: false, detail: 'no board' }) }).s;
  const r2 = await runUpgrade({ root: f.inst, cfg: CFG, steps: bad });
  assert.equal(r2.unhealthy, true);
  assert.equal(upgradeCard(JSON.parse(await readFile(path.join(f.inst, 'data', 'upgrade-state.json'), 'utf8')), CFG).status, 'down', 'the one red case');
});

test('migrate: idempotent, add-only in overlay/, every touched file backed up, schema stamped', async () => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'migrate tests-')));
  const root = path.join(base, 'a root'); const mdir = path.join(root, 'migrations'); const backup = path.join(base, 'bk');
  await mkdir(mdir, { recursive: true }); await mkdir(path.join(root, 'overlay'), { recursive: true }); await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'overlay', 'set.json'), JSON.stringify({ keep: 'owner value', nested: { a: 1 } }));
  await writeFile(path.join(root, 'data', 'thing.json'), '{"v":1}');
  await writeFile(path.join(mdir, '001-a.mjs'), `export const id='001-a'; export async function up(ctx){
    await ctx.addDefault('overlay/set.json','keep','CHANGED'); await ctx.addDefault('overlay/set.json','nested.b',2);
    await ctx.writeJson('data/thing.json',{v:2}); }`);
  const badDir = path.join(base, 'bad migrations'); await mkdir(badDir);
  await writeFile(path.join(badDir, '002-bad.mjs'), `export const id='002-bad'; export async function up(ctx){ await ctx.writeJson('overlay/set.json',{}); }`);
  await assert.rejects(migrate({ root, backup, dir: badDir }), /owner's overlay/, 'a migration may not rewrite overlay/');
  assert.ok(!existsSync(path.join(root, 'data', 'schema-version.json')), 'a failed run stamps nothing');
  const r = await migrate({ root, backup: backup + '2' });
  assert.deepEqual(r.ran, ['001-a']);
  const set = JSON.parse(await readFile(path.join(root, 'overlay', 'set.json'), 'utf8'));
  assert.deepEqual(set, { keep: 'owner value', nested: { a: 1, b: 2 } }, 'only the missing key was added');
  assert.deepEqual(JSON.parse(await readFile(path.join(backup + '2', 'migrated.json'), 'utf8')).sort(), ['data/schema-version.json', 'data/thing.json', 'overlay/set.json']);
  assert.ok(r.log.some((l) => /added overlay\/set\.json nested\.b = 2/.test(l)));
  assert.deepEqual((await migrate({ root })).ran, [], 'idempotent: applied ids are skipped');
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data', 'schema-version.json'), 'utf8')), { version: 1, applied: ['001-a'] });
  const shipped = await migrate({ root: base, dir: path.join(process.cwd(), 'migrations'), dryRun: true });
  assert.deepEqual(shipped.ran, ['001-schema-stamp', '002-nobackup-markers'], 'the shipped migrations load and run');
});

test('the UPDATE route (demo board): token required, agent identity refused, /api/version answers', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process');
  const port = 39000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: process.cwd(), env: { ...process.env, MC_DEMO: '1', MC_DEMO_POLL: '1', MC_PORT: String(port) }, stdio: 'ignore' });
  try {
    const at = (p, o) => fetch(`http://127.0.0.1:${port}${p}`, o);
    let v = null;
    for (let i = 0; i < 80 && !v; i += 1) { await new Promise((r) => setTimeout(r, 150)); v = await at('/api/version').then((r) => (r.ok ? r.json() : null)).catch(() => null); }
    assert.ok(v?.bootId && v.demo, 'version answers with a bootId');
    const page = await at('/').then((r) => r.text());
    const token = /name="mesh-decision" content="([^"]+)"/.exec(page)[1];
    const post = (headers, body = { to: 'v1.0.1' }) => at('/api/upgrade', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({})).status, 403, 'no token');
    assert.equal((await post({ 'x-mesh-decision': token, 'x-mesh-agent': 'some-agent' })).status, 403, 'condition H: an agent identity is refused even with the token');
    assert.equal((await post({ 'x-mesh-decision': token }, { to: 'v1.0.1', actor: 'some-agent' })).status, 403);
    const ok = await post({ 'x-mesh-decision': token });
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).msg, /demo: would upgrade to v1\.0\.1/);
    const s = await at('/api/status').then((r) => r.json());
    assert.equal(s.jobs.find((j) => j.label === 'update')?.upgrade?.to, 'v1.0.1', 'the demo card carries the button');
  } finally { child.kill(); }
});

test('card, request rule, plist, observe check', async () => {
  const now = Date.now();
  assert.equal(upgradeCard({}, { mode: 'observe', repo: REPO }), null, 'observe shows no card');
  const owner = upgradeCard({ checkedAt: now, release: false, why: 'origin is not acme/zulu (me/private)', newest: 'v1.0.1' }, CFG, '', now);
  assert.equal(owner.upgrade, undefined, 'no button off a release install');
  assert.match(owner.detail, /no UPDATE button: origin is not/);
  const avail = upgradeCard({ checkedAt: now, release: true, current: 'v1.0.0', commit: 'abc', available: { tag: 'v1.0.1', notesUrl: 'u' } }, CFG, '', now);
  assert.deepEqual([avail.status, avail.upgrade.to], ['warn', 'v1.0.1']);
  assert.equal(upgradeCard({ checkedAt: now - 30 * 3600e3, release: true, current: 'v1.0.1', commit: 'abc' }, CFG, '', now).status, 'stale');
  const st = { release: true, available: { tag: 'v1.0.1' } };
  assert.equal(requestAllowed(st, CFG, '', 'v1.0.1').ok, true);
  assert.match(requestAllowed(st, CFG, '', 'v9.9.9').why, /available release is v1\.0\.1/);
  assert.match(requestAllowed({ ...st, release: false, why: 'x' }, CFG, '', 'v1.0.1').why, /not a release install/);
  assert.match(requestAllowed(st, { mode: 'observe', repo: REPO }, '', 'v1.0.1').why, /mode is observe/);
  assert.match(requestAllowed({ ...st, running: { from: 'a', to: 'b' } }, CFG, '', 'v1.0.1').why, /already running/);
  const pl = upgradePlist({ label: 'x.zulu-upgrade', node: '/n/node', script: '/a b/scripts/upgrade.mjs', root: '/a b', log: '/a b/logs/u.log' });
  assert.match(pl, /<key>RunAtLoad<\/key><true\/>/); assert.match(pl, /<key>KeepAlive<\/key><false\/>/); assert.match(pl, /--from-request/);
  const f = await fixture();
  const lines = []; const file = path.join(f.base, 'state.json');
  const fetchImpl = async () => ({ ok: true, json: async () => rels });
  const s1 = await maybeUpgradeCheck({ cfg: { mode: 'observe', repo: REPO }, root: f.inst, file, now, fetchImpl, record: (k, t) => lines.push(t) });
  assert.deepEqual([s1.release, s1.current, s1.available.tag, s1.newest], [true, 'v1.0.0', 'v1.0.1', 'v1.0.1']);
  assert.match(lines[0], /upgrade \(observe\): newest acme\/zulu release is v1\.0\.1; this install is v1\.0\.0/);
  assert.equal(await maybeUpgradeCheck({ cfg: { mode: 'observe', repo: REPO }, root: f.inst, file, now: now + 60e3, fetchImpl }), null, 'rate limited');
  const down = await maybeUpgradeCheck({ cfg: CFG, root: f.inst, file, now, force: true, fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.match(down.lastError, /HTTP 403/);
  assert.equal(lines.length, 1, 'no repeat line for the same release');
});
