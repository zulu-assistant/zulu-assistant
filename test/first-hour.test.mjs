// A lighter first hour (1.3): the default install is the board and nothing you did not ask for, the
// board shows your own sessions without cmux, the wizard requires four steps, and a new install shows
// no example placeholders.
//
// The installer and the board run from a COPY of this checkout under a temp HOME with
// ZULU_NO_LAUNCHD=1. Nothing here touches the real HOME, the real LaunchAgents or the live board.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, lstat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { STEPS, NEXT_STEPS, setupCard, summarize } from '../src/setup.mjs';
import { plainSessions, lifecycleOf, transcriptFor } from '../src/sessions-plain.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAC = process.platform === 'darwin';
const NODE_DIR = path.dirname(process.execPath);
const BARE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`;

test('the wizard requires four steps: GitHub, an engine, who you are, the final check', () => {
  assert.deepEqual(STEPS.filter((s) => s.required).map((s) => s.id), ['github', 'engines', 'owner', 'verify']);
  assert.deepEqual(STEPS.map((s) => s.id), ['github', 'engines', 'owner', 'watch', 'alerts', 'vault', 'brain', 'macos', 'residents', 'verify'], 'no step was removed');
  // skipping every optional step leaves a clean card
  const doc = { steps: Object.fromEntries(STEPS.map((s) => [s.id, { status: s.required ? 'done' : 'skipped' }])) };
  assert.equal(setupCard(doc).status, 'ok');
  assert.deepEqual(summarize(doc).skippedRequired, []);
  doc.steps.engines = { status: 'skipped' };
  assert.equal(setupCard(doc).status, 'warn'); assert.match(setupCard(doc).detail, /skipped: AI engines/);
});

test('a light install shows a next-steps card (info only), then the usual checklist once setup is started', () => {
  const light = { installedAt: 1, mode: 'light', steps: {}, answers: {} };
  const card = setupCard(light);
  assert.equal(card.status, 'ok'); assert.equal(card.name, 'Next steps');
  for (const n of NEXT_STEPS) assert.ok(card.detail.includes(n.run), n.run);
  assert.deepEqual(NEXT_STEPS.map((n) => n.run), ['./install.sh --guardrails', './install.sh --full', './install.sh --brain', 'zulu setup --step watch']);
  assert.match(card.detail, /triage costs money/);
  light.steps.github = { status: 'done' };
  assert.equal(setupCard(light).status, 'due'); assert.match(setupCard(light).detail, /^setup 1\/10/);
  // an install made by the full installer (no mode) is the checklist from the start
  assert.equal(setupCard({ steps: {} }).status, 'due');
});

test('sessions without cmux: live entries of Claude Code\'s own registry become read-only tiles', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zulu sessions-'));
  const dir = path.join(home, '.claude', 'sessions');
  await mkdir(dir, { recursive: true });
  const entry = (pid, o) => writeFile(path.join(dir, `${pid}.json`), JSON.stringify({ pid, sessionId: `sid-${pid}`, cwd: path.join(home, 'work', 'my app'), startedAt: 1000, ...o }));
  await entry(11, { name: 'feature-work', status: 'busy', statusUpdatedAt: 5000 });
  await entry(12, { status: 'idle', updatedAt: 4000 });
  await entry(13, { name: 'gone', status: 'busy', statusUpdatedAt: 9000 });        // its process has exited
  await entry(14, { name: 'asks', status: 'waiting_for_input', statusUpdatedAt: 3000 });
  await writeFile(path.join(dir, '15.json'), '{ half-writ');                       // a file being written
  await writeFile(path.join(dir, '11.abc.key'), 'not a session');
  const seen = [];
  const out = await plainSessions({ dir, home, alive: (pid) => pid !== 13, gaugeFor: async (tp) => { seen.push(tp); return tp.includes('sid-11') ? { pct: 42, band: 'ok' } : null; } });
  assert.deepEqual(out.map((s) => [s.id, s.lifecycle, s.workspace, s.cwd, s.active, s.workspaceId]), [
    ['sid-11', 'running', 'feature-work', '~/work/my app', true, ''],
    ['sid-12', 'idle', 'my app', '~/work/my app', true, ''],
    ['sid-14', 'needsInput', 'asks', '~/work/my app', true, ''],
  ]);
  assert.equal(out[0].source, 'claude-registry'); assert.deepEqual(out[0].ctx, { pct: 42, band: 'ok' }); assert.equal(out[1].ctx, undefined);
  assert.equal(seen[0], transcriptFor(home, path.join(home, 'work', 'my app'), 'sid-11'));
  assert.match(transcriptFor('/h', '/Users/sam/my app.v2', 'abc'), /^\/h\/\.claude\/projects\/-Users-sam-my-app-v2\/abc\.jsonl$/);
  assert.deepEqual(['busy', 'idle', 'permission', '', undefined].map(lifecycleOf), ['running', 'idle', 'needsInput', 'unknown', 'unknown']);
  assert.deepEqual(await plainSessions({ dir: path.join(home, 'none') }), []);
  // the collector uses it exactly when there is no cmux hook file (a Mac where cmux never ran)
  const viaCollector = spawnSync(process.execPath, ['-e', "import('./src/collect.mjs').then(async (m) => console.log(JSON.stringify((await m.getSessions()).map((s) => [s.id, s.source]))))"],
    { cwd: ROOT, env: { HOME: home, PATH: BARE_PATH, MC_OVERLAY: path.join(home, 'no-overlay') }, encoding: 'utf8' });
  await writeFile(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-live', cwd: home, status: 'idle' }));
  const again = spawnSync(process.execPath, ['-e', "import('./src/collect.mjs').then(async (m) => console.log(JSON.stringify((await m.getSessions()).map((s) => [s.id, s.source]))))"],
    { cwd: ROOT, env: { HOME: home, PATH: BARE_PATH, MC_OVERLAY: path.join(home, 'no-overlay') }, encoding: 'utf8' });
  assert.equal(viaCollector.status, 0, viaCollector.stderr);
  assert.deepEqual(JSON.parse(again.stdout).filter(([id]) => id === 'sid-live'), [['sid-live', 'claude-registry']], again.stderr);
});

test('the page: an empty registry says "nothing watched yet" with the scan command; a read-only tile says why', async () => {
  const ctx = {};
  vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: ctx });
  const html = ctx.BoardDecide.nothingWatchedHtml({ watching: 0, profile: 'full' });
  assert.match(html, /nothing watched yet/); assert.match(html, /<code>zulu setup --step watch<\/code>/);
  for (const d of [{ watching: 3, profile: 'full' }, { watching: 0, profile: 'guardrails' }, { watching: 0, demo: true }, { profile: 'full' }, null]) assert.equal(ctx.BoardDecide.nothingWatchedHtml(d), '');
  const app = await readFile(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /\$\('domains'\)\.innerHTML = BoardDecide\.nothingWatchedHtml\(data\) \+ domains\.map/);
  assert.match(app, /s\.source === 'claude-registry' \? 'read-only: this session is not in cmux/);
  assert.match(await readFile(path.join(ROOT, 'server.mjs'), 'utf8'), /ctx: contextCache\.get\(s\.workspaceId\) \|\| s\.ctx \|\| null/);
});

// ── the installer, in a checkout-shaped copy (never the owner's overlay: lstat, no symlinks followed) ──
async function cloneCheckout() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'zulu first hour-'));
  const root = path.join(base, 'zulu assistant'); const home = path.join(base, 'home');
  await mkdir(root, { recursive: true }); await mkdir(home, { recursive: true });
  const skip = /^(overlay|publish|test|data|logs|graphify-out|\.github|\.claude)\//;
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0')
    .filter((f) => f && !skip.test(f) && existsSync(path.join(ROOT, f)));
  for (const f of files) {
    const st = await lstat(path.join(ROOT, f));
    if (!st.isFile()) continue;
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await copyFile(path.join(ROOT, f), path.join(root, f));
    await chmod(path.join(root, f), st.mode & 0o777);
  }
  // CLAUDE_BIN: the hook installer refuses to write on a Claude Code that is too old for its entries (#503), and the
  // Node folder on this PATH may hold whatever claude this machine has. No claude at all is a note, on any machine.
  const env = { HOME: home, PATH: BARE_PATH, NODE_BIN_DIR: NODE_DIR, ZULU_NO_LAUNCHD: '1', ZULU_NO_OPEN: '1', ZULU_NO_NOTIFY: '1', TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', CLAUDE_BIN: path.join(home, 'no-claude-here') };
  return { base, root, home, env };
}
const install = (c, args = []) => spawnSync('/bin/bash', [path.join(c.root, 'install.sh'), ...args], { cwd: c.root, env: { ...c.env, MC_PORT: String(c.port || 1) }, encoding: 'utf8' });
const HEAVY = /brew install|--cask|Homebrew|graphify|Obsidian|uv tool|npm install|prereqs|mission-control-triage|cmux\.json|ghostty|settings\.json|merge-hooks/i;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });

test('the default plan lists no cask, no paid job and no write to the user\'s Claude settings', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)' }, async () => {
  const c = await cloneCheckout();
  try {
    const r = install(c, ['--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const plan = r.stdout.slice(0, r.stdout.indexOf('4/4 next steps'));       // what it would DO (the next-steps list names the opt-ins)
    assert.match(plan, /1\/4 Node[\s\S]*2\/4 your config[\s\S]*3\/4 the board \(one LaunchAgent\)/);
    assert.doesNotMatch(plan, HEAVY);
    assert.match(r.stdout, /triage COSTS MONEY/);
    assert.match(r.stdout, /\(dry run: nothing was written\)/);
    assert.ok(!existsSync(path.join(c.root, 'overlay')) && !existsSync(path.join(c.home, 'Library')) && !existsSync(path.join(c.home, '.claude')));
    // the full install is still there, by name, and its own flags still reach it
    const sh = await readFile(path.join(c.root, 'install.sh'), 'utf8');
    assert.match(sh, /--full\|full\) shift; do_full "\$@" ;;/);
    assert.match(sh, /""\|--dry-run\|--yes\|-y\) do_light "\$@" ;;/);
    assert.match(sh, /--force\|--deadman\|--sandbox\) do_full "\$@" ;;/);
    assert.match(await readFile(path.join(c.root, 'get.sh'), 'utf8'), /bash -s -- --full/);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('the default install: one LaunchAgent and your config; nothing in ~/.claude, no example cards', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  try {
    const r = install(c);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout.slice(0, r.stdout.indexOf('4/4 next steps')), HEAVY);
    const agents = await readdir(path.join(c.home, 'Library', 'LaunchAgents'));
    assert.equal(agents.length, 1); assert.match(agents[0], /\.master-console\.plist$/);
    assert.ok(!existsSync(path.join(c.home, '.claude')), 'nothing is written to your Claude settings or skills');
    assert.ok(!existsSync(path.join(c.home, '.config')), 'no cmux or terminal config');
    assert.deepEqual(JSON.parse(await readFile(path.join(c.root, 'overlay/config/local.json'), 'utf8')), { dropExamples: true });
    assert.equal(JSON.parse(await readFile(path.join(c.root, 'data/setup-state.json'), 'utf8')).mode, 'light');
    // the last line names the repo and asks nothing (no gh, no [y/N]); it is recorded so a re-run stays quiet
    const lines = r.stdout.trim().split('\n');
    assert.match(lines.at(-1), /^note\s+.*a star on https:\/\/github\.com\/\S+ helps others find it\.$/);
    assert.doesNotMatch(r.stdout, /\[y\/N\]/);
    assert.ok(JSON.parse(await readFile(path.join(c.root, 'data/star-prompt.json'), 'utf8')).installerLine?.at > 0);
    // the registry a new install reads: no example placeholders
    const reg = spawnSync(process.execPath, ['-e', "import('./src/config.mjs').then((m) => console.log(JSON.stringify([m.JOBS.length, m.DOCKER_CONTAINERS.length, m.ENDPOINTS.length, m.PROFILE])))"], { cwd: c.root, env: c.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(reg.stdout), [0, 0, 0, 'full'], reg.stderr);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('a re-run on an existing install removes nothing and keeps what is there', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  try {
    const first = install(c);
    assert.equal(first.status, 0);
    assert.match(first.stdout, /helps others find it/);
    // what a fuller install would have left: a second LaunchAgent, Claude settings with hooks, setup answers, a started checklist
    const la = path.join(c.home, 'Library', 'LaunchAgents');
    await writeFile(path.join(la, 'com.zulu-assistant.mission-control-triage.plist'), '<plist/>');
    await mkdir(path.join(c.home, '.claude', 'skills', 'mine'), { recursive: true });
    const settings = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: '/x/scripts/gate-hook.sh' }] }] }, mine: true });
    await writeFile(path.join(c.home, '.claude', 'settings.json'), settings);
    const answers = JSON.stringify({ owner: { id: 'sam', name: 'Sam' }, jobs: [{ label: 'com.acme.sync', name: 'Sync', domain: 'infra' }], dropExamples: true });
    await writeFile(path.join(c.root, 'overlay/config/local.json'), answers);
    await writeFile(path.join(c.root, 'overlay/config/models.json'), '{"master":"my-model"}');
    await writeFile(path.join(c.root, 'data/setup-state.json'), JSON.stringify({ installedAt: 5, steps: { github: { status: 'done' } }, answers: {} }));
    const before = (await readdir(la)).sort();
    const r = install(c);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /skip\s+overlay\/ already has every example file/);
    assert.match(r.stdout, /skip\s+plist \S+\.master-console up to date/);
    assert.doesNotMatch(r.stdout, /helps others find it/, 'the star line is printed once, never on a re-run');
    assert.deepEqual((await readdir(la)).sort(), before, 'no LaunchAgent removed, no backup copy made');
    assert.equal(await readFile(path.join(c.home, '.claude', 'settings.json'), 'utf8'), settings);
    assert.ok(existsSync(path.join(c.home, '.claude', 'skills', 'mine')));
    assert.equal(await readFile(path.join(c.root, 'overlay/config/local.json'), 'utf8'), answers);
    assert.equal(await readFile(path.join(c.root, 'overlay/config/models.json'), 'utf8'), '{"master":"my-model"}');
    assert.deepEqual(JSON.parse(await readFile(path.join(c.root, 'data/setup-state.json'), 'utf8')).steps, { github: { status: 'done' } }, 'a started setup is not reset to "light"');
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('Guardrails as a next step of a default install: the gate is added, the board keeps its profile, no --switch', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  try {
    assert.equal(install(c).status, 0);
    const { lightInstall, runsFullBoard } = await import(path.join(c.root, 'scripts', 'guardrails-profile.mjs'));
    const o = { overlay: path.join(c.root, 'overlay'), root: c.root, home: c.home };
    assert.equal(await lightInstall(o), true);
    assert.equal((await runsFullBoard(o)).length, 1, 'the board LaunchAgent runs from this checkout: without the light rule this would be refused');
    const dry = install(c, ['--guardrails', '--dry-run']);
    assert.equal(dry.status, 0, dry.stdout + dry.stderr); assert.doesNotMatch(dry.stdout, /needs --switch/);
    const r = install(c, ['--guardrails', '--yes']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /profile stays "full" \(a light install/);
    assert.deepEqual(JSON.parse(await readFile(path.join(c.root, 'overlay/config/local.json'), 'utf8')), { dropExamples: true }, 'the profile is not changed');
    assert.equal(JSON.parse(await readFile(path.join(c.root, 'overlay/policy.json'), 'utf8')).defaultMode, 'enforce');
    assert.match(await readFile(path.join(c.home, '.claude', 'settings.json'), 'utf8'), /gate-hook\.sh/);
    // once agents are registered in a mesh it is a full board, whatever the state file says: refused without --switch
    await writeFile(path.join(c.root, 'overlay/config/agents.json'), JSON.stringify({ agents: [{ name: 'resident', workspaceId: ['1b2c3d4e', '5f60', '4a7b', '8c9d', '0e1f2a3b4c5d'].join('-') }] }));
    assert.equal(await lightInstall(o), false);
    const full = install(c, ['--guardrails', '--yes']);
    assert.equal(full.status, 3, full.stdout + full.stderr); assert.match(full.stdout, /To switch on purpose/);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('the board of a default install with no cmux: your sessions, the next-steps card, "nothing watched", no failing stage', { skip: !MAC && 'the installer path is macOS', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  c.port = await freePort();
  let child = null;
  try {
    assert.equal(install(c).status, 0);
    const sdir = path.join(c.home, '.claude', 'sessions');
    await mkdir(sdir, { recursive: true });
    await writeFile(path.join(sdir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'sid-fixture', cwd: path.join(c.home, 'proj'), name: 'my-session', status: 'busy', statusUpdatedAt: Date.now() }));
    child = spawn(process.execPath, ['server.mjs'], { cwd: c.root, env: { ...c.env, MC_PORT: String(c.port) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errs = ''; child.stderr.on('data', (d) => { errs += d; });
    let status = null;
    for (let i = 0; i < 200 && !status?.poll?.stages?.work; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      status = await fetch(`http://127.0.0.1:${c.port}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    assert.ok(status?.poll?.stages?.work, `the board answered and polled (${errs.slice(0, 400)})`);
    assert.equal(status.profile, 'full'); assert.equal(status.watching, 0);
    assert.deepEqual(status.sessions.map((s) => [s.id, s.workspace, s.lifecycle, s.source]), [['sid-fixture', 'my-session', 'running', 'claude-registry']]);
    const labels = status.jobs.map((j) => j.label);
    assert.ok(!labels.some((l) => /example/i.test(l)), labels.join(','));
    const next = status.jobs.find((j) => j.label === 'setup:');
    assert.equal(next.name, 'Next steps'); assert.equal(next.status, 'ok');
    // a light install asked for neither cmux nor Guardrails: no card for either, so the first board has no amber
    // card for something that was never installed (the next-steps card names both, with their commands)
    assert.ok(!labels.includes('cmux:bridge'), labels.join(','));
    assert.ok(!labels.includes('guardrails'), labels.join(','));
    assert.match(next.detail, /install\.sh --guardrails/); assert.match(next.detail, /install\.sh --full/);
    // the disk and memory gauges read THIS machine (1.3.1): a full disk or high swap is the host's state, not the
    // install's, and an upgrade runs this suite on the user's machine, so judging them here would roll it back
    const HOST_GAUGES = new Set(['disk:/', 'mem:']);
    assert.deepEqual(status.jobs.filter((j) => !HOST_GAUGES.has(j.label) && !['ok', 'due'].includes(j.status)).map((j) => `${j.label}:${j.status}`), [], 'no coloured card on a fresh light board');
    assert.ok(!Object.keys(status.poll.stages).includes('heal'), 'nothing to heal without cmux');
    for (const [name, st] of Object.entries(status.poll.stages)) assert.equal(st.failures, 0, `${name}: ${st.error}`);
  } finally {
    if (child) { child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 100)); }
    await rm(c.base, { recursive: true, force: true });
  }
});
