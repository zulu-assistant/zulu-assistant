// node --test "test/*.test.mjs" — #636 (PR 1): the gate integrity read off the board's event loop, one budget.
// The board ran its git reads with execFileSync: each held the whole loop (HTTP, gate checks, the door's lookup) for
// up to 3 s, and a first check after a restart could add up to minutes (11-14 22:56Z: the card stage took 55 s).
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChild, createBudget, RanOut, firstWord, readsRunning, BOARD_MAX_READS,
  createGateIntegrity, integritySettings, KEEP_LAST_POLLS, gateDirs, remoteTargetReads, remoteTarget } from '../src/gate-integrity.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'reads async-')));
const stand = (name, body) => { const f = path.join(dir, name); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f; };
const HANG = stand('hang', 'sleep 30');
const NO = stand('no', 'exit 1');
const SLOW = stand('slow', 'sleep 1.2; echo done');
const SHORT = stand('short', 'sleep 0.3; echo ok');

test('a hung read runs out inside its budget, and the loop keeps answering meanwhile', async () => {
  let ticks = 0; const timer = setInterval(() => { ticks += 1; }, 50);
  const t0 = Date.now();
  const r = await readChild(HANG, ['rev-parse', 'HEAD'], { limitMs: 3000, budget: createBudget(600), label: 'test', log: () => {} });
  clearInterval(timer);
  assert.equal(r.ranOut, true); assert.equal(r.code, null);
  assert.ok(Date.now() - t0 < 1500, `ran out in ${Date.now() - t0} ms`);
  assert.ok(ticks >= 8, `the loop ran ${ticks} timers while the read hung (a synchronous read runs none)`);
});

test('an answered "no" is an answer, not a read that ran out; an exhausted budget starts nothing', async () => {
  const no = await readChild(NO, ['merge-base', '--is-ancestor', 'a', 'b'], { log: () => {} });
  assert.deepEqual([no.code, no.ranOut], [1, false]);
  const b = createBudget(0);
  const none = await readChild(SHORT, ['x'], { budget: b, log: () => {} });
  assert.equal(none.ranOut, true); assert.equal(b.ranOut, true);
  const missing = await readChild(path.join(dir, 'no-such-program'), ['x'], { log: () => {} });
  assert.equal(missing.ranOut, true, 'a program that cannot start gives no answer');
});

test('a read over 1 s logs one line: the program and its first word, never paths or refs', async () => {
  const lines = [];
  const r = await readChild(SLOW, ['-C', '/secret/place', 'ls-tree', '-r', 'abc123', '--', 'src/x'], { label: 'integrity', log: (l) => lines.push(l) });
  assert.equal(r.code, 0); assert.equal(lines.length, 1);
  assert.match(lines[0], /\[slow-read\] .*slow ls-tree \d+\.\d s \(integrity\)$/);
  assert.doesNotMatch(lines[0], /secret|abc123|src\/x/);
  assert.equal(firstWord(['-C', '/a b', '-c', 'x=y', 'rev-parse', 'HEAD']), 'rev-parse');
});

test('reads running at once are capped board-wide', async () => {
  let most = 0; const timer = setInterval(() => { most = Math.max(most, readsRunning().running); }, 20);
  await Promise.all(Array.from({ length: BOARD_MAX_READS + 4 }, () => readChild(SHORT, ['x'], { log: () => {} })));
  clearInterval(timer);
  assert.ok(most <= BOARD_MAX_READS, `at most ${BOARD_MAX_READS} at once (saw ${most})`);
  assert.deepEqual(readsRunning(), { running: 0, waiting: 0 });
});

// ── the integrity card when its reads run out (MC's condition 5) ──
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const FILES = ['scripts/gate-hook.sh', 'src/gates.mjs'];
function clone() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'reads integrity-')));
  const origin = path.join(base, 'origin'); const live = path.join(base, 'Live Checkout');
  for (const f of FILES) { mkdirSync(path.dirname(path.join(origin, f)), { recursive: true }); writeFileSync(path.join(origin, f), `// ${f}\n`); }
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env });
  execFileSync('git', ['-C', origin, 'add', '-A'], { env }); execFileSync('git', ['-C', origin, 'commit', '-q', '-m', 'first'], { env });
  execFileSync('git', ['clone', '-q', origin, live], { env });
  return { origin, live, head: () => execFileSync('git', ['-C', origin, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim() };
}
function checker(r, { behindMinutes = 30 } = {}) {
  let t = Date.parse('2026-11-16T10:00:00Z'); let saved = null; let writes = 0;
  const mode = { hang: false };
  const gi = createGateIntegrity({
    root: r.live, files: () => FILES, budgetMs: 1000,
    // the board's reader: real git, asynchronous, under the check's budget; a hang runs the budget out
    git: async (args, budget) => {
      if (mode.hang) { await new Promise((res) => setTimeout(res, budget.left() + 5)); throw new RanOut(`git ${args[0]}`); }
      const x = await readChild('git', ['-C', r.live, ...args], { budget, log: () => {} });
      if (x.ranOut) throw new RanOut(`git ${args[0]}`);
      return x.code === 0 ? x.out.trim() : null;
    },
    readFile: (p) => readFile(path.join(r.live, p)),
    readState: async () => saved, writeState: async (s) => { writes += 1; saved = structuredClone(s); },
    readRemoteHead: async () => r.head(), now: () => t, settings: integritySettings({ mode: 'on', behindMinutes }),
  });
  return { gi, mode, tick: (min) => { t += min * 60e3; }, writes: () => writes };
}

test('integrity: reads that run out are "not checked this poll", never red by themselves; then amber, then red at behindMinutes', async () => {
  const r = clone(); const c = checker(r);
  // no full reading yet: as the first poll
  c.mode.hang = true;
  let v = await c.gi.check();
  assert.equal(v.status, 'unknown'); assert.match(v.detail, /^gate files not checked this poll \(git ran out after 1 s\)$/);
  // a full reading, then reads that run out: the last judgment holds for a few polls, with the note
  c.mode.hang = false; v = await c.gi.check(); assert.equal(v.status, 'ok'); assert.equal(v.state, 'current');
  const writes = c.writes();
  c.mode.hang = true;
  for (let i = 1; i <= KEEP_LAST_POLLS; i++) {
    c.tick(1); v = await c.gi.check();
    assert.equal(v.status, 'ok', `poll ${i}`); assert.match(v.detail, /· not checked this poll \(git ran out/);
  }
  c.tick(1); v = await c.gi.check();
  assert.equal(v.status, 'warn'); assert.match(v.detail, /^gate files not checked for 4 polls \(git ran out\); last full reading: /);
  c.tick(30); v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.match(v.detail, /^gate files not checked for 3\d min \(git ran out at every poll\)$/);
  assert.equal(c.writes(), writes, 'nothing is written to the state file from a poll that read nothing');
  // a full reading ends it
  c.mode.hang = false; c.tick(1); v = await c.gi.check(); assert.equal(v.status, 'ok'); assert.doesNotMatch(v.detail, /not checked/);
});

// MC's read of cf04e33 (1): with no full reading since the start it stayed "unknown" for ever
test('integrity: no full reading yet and reads that keep running out: unknown, then amber, then red at behindMinutes', async () => {
  const r = clone(); const c = checker(r);
  c.mode.hang = true;
  let v;
  for (let i = 1; i <= KEEP_LAST_POLLS; i++) { v = await c.gi.check(); assert.equal(v.status, 'unknown', `poll ${i}`); c.tick(1); }
  v = await c.gi.check();
  assert.equal(v.status, 'warn'); assert.match(v.detail, /^gate files not checked for 4 polls \(git ran out\); no full reading since the board started$/);
  c.tick(30); v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.match(v.detail, /^gate files not checked for 3\d min \(git ran out at every poll\)$/);
});

// MC's read of cf04e33 (2): a behind judgment's own clock keeps counting through unread polls; the earlier clock wins
test('integrity: behind, then reads run out: red at behindMinutes from when it fell behind, not from the first unread poll', async () => {
  const r = clone(); const c = checker(r);
  // a commit lands on the origin and is not fetched here: behind (amber) from now
  writeFileSync(path.join(r.origin, 'src/gates.mjs'), '// landed later\n');
  execFileSync('git', ['-C', r.origin, 'commit', '-qam', 'later'], { env });
  let v = await c.gi.check(); assert.equal(v.status, 'warn'); assert.equal(v.state, 'behind');
  c.tick(20); v = await c.gi.check(); assert.equal(v.status, 'warn'); assert.match(v.detail, /\(20 min\)/);
  // now the reads run out: 9 min later the unread clock is at 9 min, but the behind clock is at 29, then 30
  c.mode.hang = true;
  c.tick(9); v = await c.gi.check(); assert.equal(v.status, 'warn'); assert.match(v.detail, /not checked this poll/);
  c.tick(1); v = await c.gi.check();
  assert.equal(v.status, 'down', v.detail); assert.match(v.detail, /^gate files behind for 30 min, and not checked since \(git ran out at every poll\)$/);
});

test('integrity: an unread poll never clears a red', async () => {
  const r = clone(); const c = checker(r);
  writeFileSync(path.join(r.live, 'src/gates.mjs'), '// changed here\n');
  let v = await c.gi.check(); assert.equal(v.status, 'down'); assert.deepEqual(v.changed, ['src/gates.mjs']);
  c.mode.hang = true;
  for (let i = 0; i < KEEP_LAST_POLLS + 2; i++) { c.tick(1); v = await c.gi.check(); assert.equal(v.status, 'down'); assert.match(v.detail, /src\/gates\.mjs.*not checked this poll/); }
});

test('integrity helpers: the folders to ls-tree, and remoteTarget from answers read first', () => {
  assert.deepEqual(gateDirs(['<live>/scripts/gate-hook.sh', '<live>/public/**', '<repo>/src/gates/**', 'elsewhere/**']), ['public', 'src/gates']);
  const S = integritySettings('on');
  const answers = new Map(remoteTargetReads(S).map((a) => [a.join(' '), null]));
  answers.set('symbolic-ref -q --short HEAD', 'main'); answers.set('symbolic-ref -q --short refs/remotes/origin/HEAD', 'origin/trunk');
  assert.equal(remoteTarget({ settings: S, git: (a) => answers.get(a.join(' ')) ?? null }).ref, 'heads/trunk');
});

test('the board has no synchronous child process in its own file, and its integrity reads go through the budgeted reader', () => {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.doesNotMatch(src, /execFileSync|spawnSync|execSync/);
  assert.match(src, /const liveGit = async \(args, budget = null\) => \{\n\s*const r = await readChild\('git', \['-C', LIVE, \.\.\.args\], \{ limitMs: 3000, budget, label: 'integrity' \}\);\n\s*if \(r\.ranOut\) throw new RanOut/);
});
