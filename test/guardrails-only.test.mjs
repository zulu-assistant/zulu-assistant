// The Guardrails-only install (1.3): SETTINGS.profile 'guardrails', the short installer path, and a
// board that runs with no cmux on PATH.
//
// Nothing here touches the real HOME, the real LaunchAgents or the live board: the installer runs
// in a COPY of this checkout under a temp HOME with ZULU_NO_LAUNCHD=1, and the board under test is
// started from that copy on its own port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, lstat, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { profileOf, findCmux, PROFILES } from '../src/profile.mjs';
import { setProfile, runsFullBoard } from '../scripts/guardrails-profile.mjs';
import { denyText, cannotWake } from '../src/gate-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MAC = process.platform === 'darwin';
const NODE_DIR = path.dirname(process.execPath);
// no Homebrew, no cmux: the Node that runs the tests, and the system tools
const BARE_PATH = `${NODE_DIR}:/usr/bin:/bin:/usr/sbin:/sbin`;

test('profileOf: guardrails only when it says so; anything else is the full board', () => {
  assert.deepEqual(PROFILES, ['full', 'guardrails']);
  assert.equal(profileOf({ profile: 'guardrails' }), 'guardrails');
  for (const s of [undefined, null, {}, { profile: 'full' }, { profile: 'GUARDRAILS' }, { profile: true }]) assert.equal(profileOf(s), 'full');
});

test('findCmux: the configured path when it exists, else PATH, else absent (and never null)', () => {
  const exists = (set) => (p) => set.includes(p);
  assert.deepEqual(findCmux('/opt/x/cmux', { env: { PATH: '/a:/b' }, exists: exists(['/opt/x/cmux', '/b/cmux']) }), { bin: '/opt/x/cmux', present: true, from: 'configured' });
  assert.deepEqual(findCmux('/opt/x/cmux', { env: { PATH: '/a:/b' }, exists: exists(['/b/cmux']) }), { bin: '/b/cmux', present: true, from: 'path' });
  assert.deepEqual(findCmux('/opt/x/cmux', { env: { PATH: '/a:/b' }, exists: exists([]) }), { bin: '/opt/x/cmux', present: false, from: 'none' });
  assert.deepEqual(findCmux(undefined, { env: {}, exists: exists([]) }), { bin: 'cmux', present: false, from: 'none' });
});

test('deny text: a session nobody can wake is told to run the command again; a registered agent\'s text is unchanged', () => {
  const g = { id: 'g1', label: 'Merge a pull request', ttlMinutes: 120 };
  assert.ok(cannotWake('unregistered:app') && cannotWake('headless:triage') && !cannotWake('builder') && !cannotWake(''));
  assert.equal(denyText.pending(7, g), "GATE: Merge a pull request — not run. Waiting on the owner, task #7 (gate g1). You'll be woken when they decide; do not retry it or work around it.");
  assert.equal(denyText.waiting(7, g), "GATE: still waiting on the owner — task #7 gate g1. Do not retry; you'll be woken.");
  const p = denyText.pending(7, g, { noWake: true });
  assert.match(p, /This session cannot be woken: run the same command again after the owner approves \(an approval lasts 120 minutes\)/);
  assert.doesNotMatch(p, /You'll be woken/);
  assert.match(denyText.waiting(7, g, { noWake: true }), /run the same command again once the owner has approved/);
});

test('setProfile: a dry run writes nothing; apply sets the profile and holds every session; your own defaultMode is kept', async () => {
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'zulu profile-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  const rules = path.join(overlay, 'policy.json');
  await writeFile(rules, JSON.stringify({ version: 1, mode: 'enforce', enforceFor: ['*'], classes: [] }, null, 2));
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ owner: { id: 'sam', name: 'Sam' }, settings: { brand: 'Mine' } }));
  const dry = await setProfile({ overlay });
  assert.deepEqual(dry.map((r) => r.written), [false, false]);
  assert.equal(JSON.parse(await readFile(rules, 'utf8')).defaultMode, undefined);
  const done = await setProfile({ overlay, apply: true });
  assert.deepEqual(done.map((r) => r.written), [true, true]);
  const local = JSON.parse(await readFile(path.join(overlay, 'config', 'local.json'), 'utf8'));
  assert.deepEqual(local, { owner: { id: 'sam', name: 'Sam' }, settings: { brand: 'Mine', profile: 'guardrails' } }, 'what setup wrote before is kept');
  const p = JSON.parse(await readFile(rules, 'utf8'));
  assert.deepEqual(Object.keys(p), ['version', 'mode', 'defaultMode', 'enforceFor', 'classes']);
  assert.equal(p.defaultMode, 'enforce');
  assert.deepEqual((await setProfile({ overlay, apply: true })).map((r) => r.written), [false, false], 'idempotent');
  // a value the owner set is never changed
  await writeFile(rules, JSON.stringify({ version: 1, mode: 'enforce', defaultMode: 'observe' }));
  await setProfile({ overlay, apply: true });
  assert.equal(JSON.parse(await readFile(rules, 'utf8')).defaultMode, 'observe');
  // back to the full board: the profile key goes, the rules stay
  await setProfile({ overlay, profile: 'full', apply: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(overlay, 'config', 'local.json'), 'utf8')).settings, { brand: 'Mine' });
});

// ── a checkout-shaped copy: what a `git clone` of the product gives, with no overlay/ and no data/ ──
async function cloneCheckout() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'zulu guardrails-'));     // a space, like a real home folder can have
  const root = path.join(base, 'zulu assistant'); const home = path.join(base, 'home');
  await mkdir(root, { recursive: true }); await mkdir(home, { recursive: true });
  const skip = /^(overlay|publish|test|data|logs|graphify-out|\.github|\.claude)\//;
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0')
    .filter((f) => f && !skip.test(f) && existsSync(path.join(ROOT, f)));
  for (const f of files) {
    const st = await lstat(path.join(ROOT, f));
    if (!st.isFile()) continue;                                              // never follow the compat symlinks into overlay/: that is the owner's config
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await copyFile(path.join(ROOT, f), path.join(root, f));
    await chmod(path.join(root, f), st.mode & 0o777);
  }
  const env = { HOME: home, PATH: BARE_PATH, NODE_BIN_DIR: NODE_DIR, ZULU_NO_LAUNCHD: '1', ZULU_NO_OPEN: '1', ZULU_NO_NOTIFY: '1', TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' };
  return { base, root, home, env };
}
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const installOnce = (c, args = ['--yes']) => spawnSync('/bin/bash', [path.join(c.root, 'install.sh'), '--guardrails', ...args], { cwd: c.root, env: { ...c.env, MC_PORT: String(c.port || 1) }, encoding: 'utf8' });

test('install.sh --guardrails --dry-run: the plan, and nothing written', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)' }, async () => {
  const c = await cloneCheckout();
  try {
    const r = installOnce(c, ['--dry-run']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /1\/5 Node[\s\S]*2\/5 your config[\s\S]*3\/5 the Guardrails-only profile[\s\S]*4\/5 the board \(one LaunchAgent\)[\s\S]*5\/5 the gate hook/);
    assert.match(r.stdout, /would\s+write .*\.master-console\.plist and load/);
    assert.match(r.stdout, /\(dry run: nothing was written\)/);
    assert.ok(!existsSync(path.join(c.root, 'overlay')) && !existsSync(path.join(c.home, 'Library')) && !existsSync(path.join(c.home, '.claude', 'settings.json')));
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('install.sh --guardrails: five steps, one LaunchAgent, the hook; no Homebrew, no cask, no triage job, no brain', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  try {
    const r = installOnce(c);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout;
    assert.doesNotMatch(out, /brew install|--cask|Homebrew|graphify|Obsidian|mission-control-triage|cmux\.json|Codex CLI|uv tool|npm install/i, 'the short path installs none of the full toolchain');
    assert.match(out, /skip\s+launchctl bootstrap \S+\.master-console \(ZULU_NO_LAUNCHD\)/);
    assert.match(out, /hook installed: restart your Claude Code sessions/);
    assert.match(out, /try it: in a Claude Code session/);
    // exactly one plist, and it is the board's
    const agents = await readdir(path.join(c.home, 'Library', 'LaunchAgents'));
    assert.equal(agents.length, 1); assert.match(agents[0], /\.master-console\.plist$/);
    const plist = await readFile(path.join(c.home, 'Library', 'LaunchAgents', agents[0]), 'utf8');
    assert.ok(plist.includes(`${c.root}/scripts/start.sh`) && !plist.includes('__'));
    // the profile and the rule that holds every session
    assert.equal(JSON.parse(await readFile(path.join(c.root, 'overlay/config/local.json'), 'utf8')).settings.profile, 'guardrails');
    assert.equal(JSON.parse(await readFile(path.join(c.root, 'overlay', 'policy.json'), 'utf8')).defaultMode, 'enforce');
    // the hook, and nothing else, in the user's Claude settings
    const settings = await readFile(path.join(c.home, '.claude', 'settings.json'), 'utf8');
    assert.ok(settings.includes(`${c.root}/scripts/gate-hook.sh`));
    assert.ok(!existsSync(path.join(c.home, '.claude', 'skills')) && !existsSync(path.join(c.home, '.config', 'cmux')) && !existsSync(path.join(c.root, 'data', 'setup-state.json')));
    // a second run changes nothing and removes nothing
    const again = installOnce(c);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /skip\s+plist \S+\.master-console up to date/);
    assert.match(again.stdout, /profile is already "guardrails"/);
    assert.equal((await readdir(path.join(c.home, 'Library', 'LaunchAgents'))).length, 1, 'no backup copy when nothing changed');
    assert.equal(JSON.parse(await readFile(path.join(c.home, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.length, JSON.parse(settings).hooks.PreToolUse.length, 'the hook is not added twice');
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('install.sh --guardrails asks before it writes your Claude settings (driven with expect)', { skip: (!MAC || !existsSync('/usr/bin/expect')) && 'needs macOS and expect', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  try {
    const script = `set timeout 60
spawn /bin/bash {${path.join(c.root, 'install.sh')}} --guardrails
expect "Add the hook to ~/.claude/settings.json now"
send "n\\r"
expect eof
catch wait result
exit [lindex $result 3]`;
    const r = spawnSync('/usr/bin/expect', ['-c', script], { cwd: c.root, env: { ...c.env, MC_PORT: '1', TERM: 'dumb' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /when you are ready: scripts\/guardrails-install\.sh --apply/);
    assert.ok(!existsSync(path.join(c.home, '.claude', 'settings.json')), 'a "no" writes nothing there');
    assert.equal(JSON.parse(await readFile(path.join(c.root, 'overlay/config/local.json'), 'utf8')).settings.profile, 'guardrails', 'the rest of the install is done');
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

// ── the board itself, started from the installed copy, with no cmux anywhere ──
const getJson = async (url, opts) => { const r = await fetch(url, opts); return { status: r.status, body: await r.json().catch(() => null) }; };
test('a Guardrails-only board with no cmux on PATH: no collector, mesh or heal; the real hook is held, approved and runs once', { skip: !MAC && 'the installer path is macOS', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  c.port = await freePort();
  let child = null;
  try {
    assert.equal(installOnce(c).status, 0);
    // The decision door (SETTINGS.callerEvidence.tripwire, shipped 'agent') refuses an owner decision that an
    // agent session is behind. This test may itself be run by an agent, so its "owner click" below would be
    // refused depending on who runs the suite. The door has its own tests (test/caller.test.mjs); here it is off.
    const localFile = path.join(c.root, 'overlay/config/local.json');
    const local = JSON.parse(await readFile(localFile, 'utf8'));
    await writeFile(localFile, JSON.stringify({ ...local, settings: { ...local.settings, callerEvidence: { mode: 'off', tripwire: false } } }));
    assert.equal(spawnSync('/bin/sh', ['-c', 'command -v cmux'], { env: c.env }).status !== 0, true, 'no cmux on this PATH');
    // the shipped registry names no fixed Homebrew path: cmux is looked up on PATH (scripts/env.sh adds Homebrew's folders for launchd)
    assert.doesNotMatch(await readFile(path.join(c.root, 'examples/config/jobs.mjs'), 'utf8'), /cmuxBin: '\//);
    const seen = spawnSync(process.execPath, ['-e', "import('./src/config.mjs').then((m) => console.log(JSON.stringify([m.PROFILE, m.CMUX_PRESENT])))"], { cwd: c.root, env: c.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(seen.stdout), ['guardrails', false], seen.stderr);
    child = spawn(process.execPath, ['server.mjs'], { cwd: c.root, env: { ...c.env, MC_PORT: String(c.port) }, stdio: ['ignore', 'ignore', 'pipe'] });
    let errs = ''; child.stderr.on('data', (d) => { errs += d; });
    const base = `http://127.0.0.1:${c.port}`;
    let status = null;
    // wait for a whole poll: 'events' is its last stage here. (Waiting for 'guardrails-card', the FIRST stage,
    // let the status be read between two stages, and the check below then missed 'board-cards'.)
    for (let i = 0; i < 100 && !status?.poll?.stages?.events; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      status = (await getJson(`${base}/api/status`).catch(() => null))?.body;
    }
    assert.ok(status, `the board answered (${errs.slice(0, 400)})`);
    assert.equal(status.profile, 'guardrails', JSON.stringify({ stages: Object.keys(status.poll?.stages || {}), demo: status.demo, errs: errs.slice(0, 300) }));
    assert.ok(!status.demo);
    // which stages ran: the board's own cards, the ledger, the gate card. No collector, no mesh, no heal.
    const ran = Object.keys(status.poll.stages);
    for (const s of ['board-cards', 'alerts', 'work', 'events', 'guardrails-card']) assert.ok(ran.includes(s), `${s} ran (${ran})`);
    for (const s of ['snapshot', 'mesh-reconcile', 'outbox', 'heal', 'demo']) assert.ok(!ran.includes(s), `${s} must not run in this profile (${ran})`);
    for (const s of ran) assert.equal(status.poll.stages[s].failures, 0, `${s}: ${status.poll.stages[s].error}`);
    // the cards: the gate, and nothing that claims a cmux connection or a fleet
    const labels = status.jobs.map((j) => j.label);
    assert.ok(labels.includes('guardrails'), labels.join(','));
    assert.ok(!labels.includes('cmux:bridge') && !labels.includes('disk:/') && !labels.includes('mem:'));
    assert.doesNotMatch(JSON.stringify(status), /socket auth OK/);
    assert.deepEqual(status.sessions, []);
    const card = status.jobs.find((j) => j.label === 'guardrails');
    assert.equal(card.status, 'ok', card.detail);
    assert.match(card.detail, /enforce for every session/);

    // the REAL hook script, with the JSON Claude Code sends, from a session that is in no mesh
    const hook = (command) => {
      const r = spawnSync('sh', [path.join(c.root, 'scripts', 'gate-hook.sh'), '--env-board'], {
        input: JSON.stringify({ session_id: 's1', cwd: c.base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'merge it' } }),
        env: { ...c.env, GATE_NODE: process.execPath, MESH_BOARD: base, CMUX_WORKSPACE_ID: '' }, encoding: 'utf8' });
      return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : { permissionDecision: 'pass' };
    };
    assert.equal(hook('ls -la').permissionDecision, 'pass');
    const held = hook('gh pr merge 7 --merge');
    assert.equal(held.permissionDecision, 'deny');
    assert.match(held.permissionDecisionReason, /Waiting on the owner, task #1 \(gate g1\)/);
    assert.match(held.permissionDecisionReason, /This session cannot be woken: run the same command again after the owner approves/);
    assert.match(hook('gh pr merge 7 --merge').permissionDecisionReason, /still waiting on the owner[\s\S]*run the same command again once the owner has approved/);

    // the owner's click: the page's token, no agent identity
    const page = await fetch(`${base}/`).then((r) => r.text());
    const token = /<meta name="mesh-decision" content="([0-9a-f]+)"/.exec(page)[1];
    const t1 = (await getJson(`${base}/api/tasks/1`)).body;
    assert.equal(t1.gates[0].status, 'pending');
    assert.match(t1.gates[0].agent, /^unregistered:/);
    const ok = await getJson(`${base}/api/tasks/1`, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-mesh-decision': token }, body: JSON.stringify({ op: 'gate_decide', gate: 'g1', decision: 'approve' }) });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    // a single run: allow once, then a new gate
    assert.equal(hook('gh pr merge 7 --merge').permissionDecision, 'allow');
    const second = hook('gh pr merge 7 --merge');
    assert.equal(second.permissionDecision, 'deny');
    assert.match(second.permissionDecisionReason, /Waiting on the owner, task #2 \(gate g1\)/, 'a second run is a new request (no agent names here: each gate lands on its own board-owned task)');
    const after = (await getJson(`${base}/api/tasks/1`)).body;
    assert.deepEqual(after.gates.map((g) => g.status), ['executed']);
    assert.ok(after.comments.some((cm) => /released to run once/.test(cm.text)), 'the receipt');
    // the page: the profile reaches it, and the row says this session is not woken
    assert.match(await readFile(path.join(c.root, 'public', 'app.js'), 'utf8'), /classList\.toggle\('profile-guardrails', data\.profile === 'guardrails'\)/);
    // nothing was queued for an agent that cannot exist here
    assert.ok(!existsSync(path.join(c.root, 'data', 'mesh-outbox.json')) || JSON.parse(await readFile(path.join(c.root, 'data', 'mesh-outbox.json'), 'utf8')).length === 0);
    assert.doesNotMatch(errs, /cmux|ENOENT/i, `no cmux call was attempted: ${errs.slice(0, 600)}`);
  } finally {
    if (child) { child.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 100)); }
    await rm(c.base, { recursive: true, force: true });
  }
});

test('the full profile on a Mac without cmux says so on the bridge card, and the page marks a no-wake session', async () => {
  const status = await readFile(path.join(ROOT, 'src', 'status.mjs'), 'utf8');
  assert.match(status, /status: !CMUX_PRESENT \? 'warn' : bridge\.ok \? 'ok' : 'down'/);
  assert.match(status, /!CMUX_PRESENT \? `cmux is not installed/);
  const vm = await import('node:vm');
  const ctx = {};
  vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: ctx });
  const esc = (x) => String(x).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const row = (agent) => ctx.BoardDecide.gateRowHtml({ id: 'g1', cls: 'merge', label: 'Merge', agent, cwd: '/w', tool: 'Bash', why: 'a merge', command: 'gh pr merge 7' }, { key: '1:g1', esc, age: '1m', open: false, actions: '' });
  assert.match(row('unregistered:app'), /this session is not woken after you decide: it runs the same command again itself/);
  assert.doesNotMatch(row('builder'), /not woken/);
});

// ── PR 110 review: the short installer on a machine that already runs the full board ──
// a made-up workspace id, built here so the publish scrub does not read the fixture as a real one
const WS = (n) => ['ABCDEF01', '2345', '4678', '9ABC', `DEF01234567${n}`].join('-');
const REAL_AGENT = { name: 'builder', title: 'BUILDER', workspaceId: WS(8), vendor: 'claude', kind: 'resident', status: 'active' };

test('runsFullBoard: registered agents or a board LaunchAgent from this checkout; never the example placeholders, never an install already in the profile', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'zulu full-'));
  const overlay = path.join(base, 'overlay'); const home = path.join(base, 'home'); const root = path.join(base, 'checkout');
  await mkdir(path.join(overlay, 'config'), { recursive: true }); await mkdir(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });
  const dirFile = path.join(overlay, 'config', 'agents.json');
  const o = { overlay, root, home };
  assert.deepEqual(await runsFullBoard(o), [], 'nothing installed');
  await copyFile(path.join(ROOT, 'examples', 'config', 'agents.json'), dirFile);
  assert.deepEqual(await runsFullBoard(o), [], 'the shipped example directory is not a mesh');
  await writeFile(dirFile, JSON.stringify({ version: 2, agents: [REAL_AGENT, { ...REAL_AGENT, name: 'gone', workspaceId: WS(9), status: 'closed' }] }));
  assert.match((await runsFullBoard(o))[0], /the mesh directory has 1 registered agent$/);
  await writeFile(path.join(home, 'Library', 'LaunchAgents', 'com.example.master-console.plist'), `<string>${root}/scripts/start.sh</string>`);
  assert.equal((await runsFullBoard(o)).length, 2);
  await writeFile(dirFile, JSON.stringify({ version: 2, agents: [] }));
  assert.match((await runsFullBoard(o))[0], /LaunchAgent \(com\.example\.master-console\.plist\) runs from this checkout/);
  assert.deepEqual(await runsFullBoard({ ...o, root: path.join(base, 'another checkout') }), [], 'a board that runs from another checkout is not this install');
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { profile: 'guardrails' } }));
  assert.deepEqual(await runsFullBoard(o), [], 'already in the profile: a re-run is not a switch');
});

test('install.sh --guardrails on a full install: it says what would change and stops; --yes alone never switches; --switch does', { skip: !MAC && 'the board runs as a LaunchAgent (macOS)', timeout: 120000 }, async () => {
  const c = await cloneCheckout();
  try {
    // a full install: its config in place, and an agent registered in the mesh directory
    assert.equal(spawnSync('/bin/bash', [path.join(c.root, 'install.sh'), 'init'], { cwd: c.root, env: c.env, encoding: 'utf8' }).status, 0);
    const dirFile = path.join(c.root, 'overlay/config/agents.json');
    await writeFile(dirFile, JSON.stringify({ version: 2, agents: [REAL_AGENT] }));
    const rules = path.join(c.root, 'overlay', 'policy.json');
    const rulesBefore = await readFile(rules, 'utf8');
    for (const args of [['--yes'], ['-y'], []]) {
      const r = installOnce(c, args);
      assert.equal(r.status, 3, r.stdout + r.stderr);
      assert.match(r.stdout, /this install already runs the full board:\s+the mesh directory has 1 registered agent/);
      assert.match(r.stdout, /would\s+overlay\/config\/local\.json: settings\.profile: "full" → "guardrails"/);
      assert.match(r.stdout, /Nothing was written\. To switch on purpose: \.\/install\.sh --guardrails --switch/);
    }
    assert.ok(!existsSync(path.join(c.root, 'overlay/config/local.json')), 'the profile was not set');
    assert.equal(await readFile(rules, 'utf8'), rulesBefore, 'the rules file was not touched');
    assert.ok(!existsSync(path.join(c.home, 'Library')) && !existsSync(path.join(c.home, '.claude', 'settings.json')), 'no LaunchAgent, no hook');
    // the step that writes refuses by itself too
    const direct = spawnSync(process.execPath, [path.join(c.root, 'scripts', 'guardrails-profile.mjs'), '--apply'], { cwd: c.root, env: c.env, encoding: 'utf8' });
    assert.equal(direct.status, 3); assert.match(direct.stderr, /refused: this install already runs the full board/);
    assert.ok(!existsSync(path.join(c.root, 'overlay/config/local.json')));
    // the dry run is free and says the real run needs the flag
    const dry = installOnce(c, ['--dry-run']);
    assert.equal(dry.status, 0); assert.match(dry.stdout, /the real run needs --switch/);
    // on purpose
    const sw = installOnce(c, ['--switch', '--yes']);
    assert.equal(sw.status, 0, sw.stdout + sw.stderr);
    assert.equal(JSON.parse(await readFile(path.join(c.root, 'overlay/config/local.json'), 'utf8')).settings.profile, 'guardrails');
    assert.equal(JSON.parse(await readFile(rules, 'utf8')).defaultMode, 'enforce');
    // and from then on it is an install in the profile: a plain re-run is not a switch
    assert.equal(installOnce(c, ['--yes']).status, 0);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('the short installer is held for an agent (class self) in the shipped rules and the example rules file; its dry run is free', async () => {
  const { classify, DEFAULT_POLICY } = await import('../src/gates.mjs');
  const { hookInput } = await import('../scripts/gate-hook.mjs');
  const example = JSON.parse(await readFile(path.join(ROOT, 'examples', ['policy', 'json'].join('.')), 'utf8'));
  // the JSON Claude Code sends to the hook, through the hook's own mapping
  const verdict = (command, rulesFile) => {
    const input = hookInput({ session_id: 's', cwd: '/work/zulu', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'install it' } }, {});
    return classify({ tool: input.tool, command: input.command, filePath: input.filePath, cwd: input.cwd }, rulesFile, { home: '/home/u', boardRoot: '/work/zulu', git: () => null, repoRoot: () => null });
  };
  for (const [name, rulesFile] of [['shipped default', DEFAULT_POLICY], ['example file', example]]) {
    for (const c of ['./install.sh --guardrails --yes', 'bash install.sh guardrails -y', './install.sh --guardrails', '/Users/x/zulu-assistant/install.sh --guardrails --switch --yes', 'cd ~/zulu-assistant && ./install.sh guardrails',
      'zulu --guardrails --yes', 'zulu guardrails -y', './bin/zulu --guardrails --yes', '/Users/x/zulu-assistant/bin/zulu --guardrails --switch --yes', 'cd /tmp && zulu guardrails']) {
      const r = verdict(c, rulesFile);
      assert.equal(r.verdict, 'gate', `${name}: ${c}`); assert.equal(r.cls, 'self', `${name}: ${c}`);
    }
    for (const c of ['./install.sh --guardrails --dry-run', './install.sh guardrails --dry-run', './install.sh --demo', './install.sh check', './install.sh --help',
      'zulu --guardrails --dry-run', 'zulu guardrails --dry-run', './bin/zulu --guardrails --dry-run', 'zulu --demo', 'zulu check'])
      assert.equal(verdict(c, rulesFile).verdict, 'clear', `${name}: ${c}`);
  }
  // the fast path knows the words, so the call reaches the classifier at all
  const triggers = await readFile(path.join(ROOT, 'scripts', 'gate-triggers.default'), 'utf8');
  assert.match(triggers, /install\\\.sh.*guardrails/);
  assert.match(triggers, /zulu.*guardrails/);
});
