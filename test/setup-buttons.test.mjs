// Buttons on the setup page (src/setup-buttons.mjs): four fixed command lines. The table, the child's
// environment, the switch, the browser evidence the route asks for, one run at a time, the check before the
// Guardrails write, a real backup and restore check in a copy, the page, and a real demo board.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, readdir, stat, cp, chmod, utimes } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  BUTTONS, BUTTON_IDS, NEVER_FLAGS, CHECK_MINUTES, MAX_OUTPUT, RUNS_DIR, ButtonRefused, buttonsOffered, browserProven, bareEnv,
  newestArchive, commandFor, shownOutput, runAttached, runDetached, lastRun, createButtons, demoButton, buttonList,
} from '../src/setup-buttons.mjs';
import { isOwnerOnly } from '../src/private-file.mjs';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/setup-write.js'), { globalThis: ctx });
const view = ctx.SetupWrite;
const tmp = (name) => mkdtemp(path.join(os.tmpdir(), `setup-buttons-${name}-`));
const refused = (status, re) => (e) => e instanceof ButtonRefused && e.status === status && re.test(e.message);

/** A runner with stand-ins: `outs` answers the attached runs in order; every call is recorded. */
function fake({ outs = [], clock = { t: 1e6 } } = {}) {
  const calls = [];
  const children = [];
  const attached = async (cmd, args, o) => { calls.push({ kind: 'attached', cmd, args, env: o.env }); return outs.shift() ?? { code: 0, out: 'ok\n' }; };
  const detached = async (cmd, args, o) => {
    calls.push({ kind: 'detached', cmd, args, env: o.env });
    const child = { handlers: {}, once(ev, fn) { this.handlers[ev] = fn; } };
    children.push(child);
    return { log: path.join(o.root, RUNS_DIR, 'guardrails-x.log'), child };
  };
  return { calls, children, clock, buttons: (root) => createButtons({ root, node: '/opt/node/bin/node', attached, detached, now: () => clock.t }) };
}

/** A temp root with a backups folder holding the named archives (oldest first). */
async function rootWith(names = []) {
  const root = await tmp('root');
  await mkdir(path.join(root, 'data', 'backups'), { recursive: true });
  for (const [i, n] of names.entries()) {
    const f = path.join(root, 'data', 'backups', n);
    await writeFile(f, 'x');
    await utimes(f, 1000 + i, 1000 + i);
  }
  return root;
}

// ---- the table ----
test('the table: four buttons, frozen, and no word in any command line is a flag a button may never pass', () => {
  assert.deepEqual([...BUTTON_IDS], ['guardrails-check', 'guardrails', 'backup', 'restore-check']);
  assert.ok(Object.isFrozen(BUTTONS));
  for (const id of BUTTON_IDS) {
    assert.ok(Object.isFrozen(BUTTONS[id]) && Object.isFrozen(BUTTONS[id].args), `${id} is frozen`);
    for (const a of BUTTONS[id].args) if (typeof a === 'string') assert.ok(!NEVER_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)), `${id} passes ${a}`);
  }
  for (const f of ['--switch', '--remove', '--allow-older-claude', '--codex', '--apply', '--with-secrets', '--full']) assert.ok(NEVER_FLAGS.includes(f));
  assert.deepEqual([...BUTTONS['guardrails-check'].args], ['install.sh', '--guardrails', '--dry-run']);
  assert.deepEqual([...BUTTONS.guardrails.args], ['install.sh', '--guardrails', '--yes']);
  assert.deepEqual([...BUTTONS.backup.args], ['scripts/backup.mjs', 'backup']);
  assert.equal(BUTTONS['restore-check'].args.length, 3);
  assert.deepEqual(BUTTONS['restore-check'].args.slice(0, 2), ['scripts/backup.mjs', 'restore']);
  // the write says in plain words what it changes, before the second click
  assert.match(BUTTONS.guardrails.says, /rules file/);
  assert.match(BUTTONS.guardrails.says, /enforce default/);
  assert.match(BUTTONS.guardrails.says, /board restarts/);
  assert.match(BUTTONS.guardrails.says, /settings file/);
});

test('a command line: the script by its full path, this Node program, and nothing from anywhere else', async () => {
  const root = await rootWith(['a.tgz']);
  assert.deepEqual(await commandFor('backup', { root, node: '/n/node' }), { cmd: '/n/node', args: [path.join(root, 'scripts/backup.mjs'), 'backup'] });
  assert.deepEqual(await commandFor('guardrails', { root }), { cmd: '/bin/bash', args: [path.join(root, 'install.sh'), '--guardrails', '--yes'] });
  assert.deepEqual(await commandFor('guardrails-check', { root }), { cmd: '/bin/bash', args: [path.join(root, 'install.sh'), '--guardrails', '--dry-run'] });
});

test('an id that is not in the table is refused, whatever it is, and nothing is started', async () => {
  const f = fake();
  const b = f.buttons(await rootWith());
  for (const id of ['', 'full', 'guardrails --switch', 'restore', 'rollback', '__proto__', 'constructor', 'toString', 'Backup', null, undefined, 7, ['backup'], { id: 'backup' }]) {
    await assert.rejects(b.run(id), refused(400, /does not exist/), String(id));
    await assert.rejects(commandFor(id), refused(400, /does not exist/));
    assert.throws(() => demoButton(id), refused(400, /does not exist/));
  }
  assert.equal(f.calls.length, 0);
});

// ---- the newest archive ----
test('the restore check reads the newest archive, picked here; an odd name is not taken; none = a plain sentence', async () => {
  const root = await rootWith(['zulu-state-1.tgz', 'manual.tgz', 'before-restore-2.tgz']);
  assert.equal(await newestArchive(root), path.join(root, 'data', 'backups', 'before-restore-2.tgz'));
  const odd = path.join(root, 'data', 'backups', '--apply.tgz');
  await writeFile(odd, 'x');                      // newer than the rest, and it must never become an argument
  await writeFile(path.join(root, 'data', 'backups', 'notes.txt'), 'x');
  await mkdir(path.join(root, 'data', 'backups', 'folder.tgz'));
  assert.equal(await newestArchive(root), path.join(root, 'data', 'backups', 'before-restore-2.tgz'));
  const c = await commandFor('restore-check', { root, node: '/n/node' });
  assert.deepEqual(c.args, [path.join(root, 'scripts/backup.mjs'), 'restore', path.join(root, 'data', 'backups', 'before-restore-2.tgz')]);
  const empty = await rootWith();
  assert.equal(await newestArchive(empty), null);
  assert.equal(await newestArchive(await tmp('nofolder')), null);
  const f = fake();
  await assert.rejects(f.buttons(empty).run('restore-check'), refused(409, /no backup in data\/backups/));
  assert.equal(f.calls.length, 0);
});

// ---- the child's environment ----
test('the environment is built from nothing: no board token, no mesh or cmux variable, no secret, no loader option', () => {
  const env = bareEnv({
    node: '/opt/node/bin/node',
    env: { HOME: '/h', USER: 'u', LOGNAME: 'u', TMPDIR: '/t', LANG: 'en_US.UTF-8', PATH: '/evil:/usr/bin', MESH_BOARD_TOKEN: 't', MESH_BOARD: 'x', MESH_GATE_IDENTITY: 'triage', CMUX_WORKSPACE_ID: 'w', CMUX_SOCKET_PASSWORD: 'p', NODE_OPTIONS: '--require x', MC_OVERLAY: '/o', SMTP_PASS: 'p', GH_TOKEN: 'g', ZULU_NO_LAUNCHD: '1' },
  });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LOGNAME', 'PATH', 'TMPDIR', 'USER', 'ZULU_NO_LAUNCHD']);
  assert.equal(env.PATH, '/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /^(MESH_|CMUX_|NODE_|MC_|GH_)|TOKEN|PASS|KEY|SECRET/);
});

test('a real child sees only that environment, attached and detached, and the detached log is owner-only', async () => {
  const root = await tmp('child');
  const script = path.join(root, 'env.sh');
  await writeFile(script, '#!/bin/bash\nenv\necho "args:$*"\n');
  await chmod(script, 0o755);
  const had = { ...process.env };
  process.env.MESH_BOARD_TOKEN = 'board-token-value';
  process.env.CMUX_WORKSPACE_ID = 'ws';
  try {
    const env = bareEnv();
    const a = await runAttached('/bin/bash', [script, 'one', 'two; echo injected'], { root, env });
    assert.equal(a.code, 0);
    assert.doesNotMatch(a.out, /MESH_|CMUX_|board-token-value/);
    assert.match(a.out, /^args:one two; echo injected$/m, 'an argument array: no shell reads the words');
    assert.doesNotMatch(a.out, /^injected$/m);
    const d = await runDetached('/bin/bash', [script], { root, env });
    d.child.ref();                                 // the runner let go of it; the test waits for its end
    await new Promise((res) => d.child.once('exit', res));
    assert.ok(isOwnerOnly((await stat(d.log)).mode), 'the log is owner-only');
    assert.equal(path.dirname(d.log), path.join(root, RUNS_DIR));
    const text = await readFile(d.log, 'utf8');
    assert.match(text, /^HOME=/m);
    assert.doesNotMatch(text, /MESH_|CMUX_|board-token-value/);
    assert.match((await lastRun(root)).text, /^HOME=/m);
  } finally {
    for (const k of ['MESH_BOARD_TOKEN', 'CMUX_WORKSPACE_ID']) { if (had[k] === undefined) delete process.env[k]; else process.env[k] = had[k]; }
  }
  assert.equal(await lastRun(await tmp('norun')), null);
});

test('a child that fails or runs out of time is reported, never thrown', async () => {
  const root = await tmp('fail');
  assert.deepEqual(await runAttached('/bin/bash', ['-c', 'echo no; exit 3'], { root, env: bareEnv() }), { code: 3, out: 'no\n' });
  const slow = await runAttached('/bin/bash', ['-c', 'sleep 5'], { root, env: bareEnv(), timeoutMs: 200 });
  assert.equal(slow.code, null);
  assert.equal(slow.timedOut, true);
  const f = fake({ outs: [{ code: null, timedOut: true, out: 'part\n' }, { code: 3, out: 'refused\n' }] });
  const b = f.buttons(await rootWith());
  assert.deepEqual(await b.run('backup'), { ok: false, id: 'backup', code: null, timedOut: true, checked: false, output: 'part\n' });
  const r = await b.run('guardrails-check');
  assert.equal(r.ok, false);
  assert.equal(r.checked, false);
  assert.equal(b.checkedAt(), null, 'a check that failed does not open the write');
});

// ---- the switch and the door ----
test('offered only with write mode, their own key and a door that refuses what is not a browser', () => {
  assert.equal(buttonsOffered({ mode: 'write', buttons: true }, 'browser'), true);
  for (const [cfg, trip] of [[{ mode: 'write', buttons: true }, 'agent'], [{ mode: 'write', buttons: true }, null], [{ mode: 'write' }, 'browser'], [{ mode: 'on', buttons: true }, 'browser'], [{ mode: 'write', buttons: 'true' }, 'browser'], [{ mode: 'write', buttons: 1 }, 'browser'], [{ mode: 'write', alerts: true }, 'browser'], [null, 'browser'], [undefined, 'browser']])
    assert.equal(buttonsOffered(cfg, trip), false, JSON.stringify([cfg, trip]));
});

test('the examples and the code ship the key off', async () => {
  const ex = await read('examples/config/jobs.mjs');
  assert.match(ex, /setupPage: \{ mode: 'off' \}/);
  assert.match(ex, /conversationView: \{ mode: 'off' \}/);
  assert.doesNotMatch(ex.replace(/^\s*\/\/.*$/gm, ''), /buttons:\s*true/);
});

test('positive evidence of a browser: a lookup that failed, a sender that has left, another device and no evidence are all refused', () => {
  assert.equal(browserProven({ kind: 'local', browser: true, agentAncestor: false }), true);
  for (const ev of [
    null, undefined, {},
    { kind: 'unknown', browser: false, agentAncestor: false, why: 'lookup failed: timeout' },
    { kind: 'gone', browser: false, agentAncestor: false, why: 'the sender has left' },
    { kind: 'remote', browser: false, agentAncestor: false },
    { kind: 'local', browser: false, agentAncestor: false },
    { kind: 'local', browser: true, agentAncestor: true },
    { kind: 'agent', browser: true, agentAncestor: true },
    { kind: 'unknown', browser: true, agentAncestor: false },
    { kind: 'gone', browser: true, agentAncestor: false },
    { kind: 'remote', browser: true, agentAncestor: false },
    { kind: 'local', browser: 'yes', agentAncestor: false },
  ]) assert.equal(browserProven(ev), false, JSON.stringify(ev));
});

test('the route: off = 404; this Mac; the door; no agent or intake name; the token; then the browser evidence, before anything runs', async () => {
  const src = await read('server.mjs');
  const at = src.indexOf("url.pathname === '/api/setup/button'");
  assert.ok(at > 0);
  const route = src.slice(at, src.indexOf('// setup writes (src/setup-write.mjs', at));
  const order = ['!setupButtonsOn', '!localOnly(req)', 'decisionDoor(req, what)', "req.headers['x-mesh-agent']", '!isDecider(req)', '!browserProven(door.ev)', 'setupButtons.run(id'];
  let last = -1;
  for (const o of order) { const i = route.indexOf(o, last + 1); assert.ok(i > last, `${o} comes in order`); last = i; }
  assert.match(route, /if \(DEMO\) return sendJson\(res, 200, demoButton\(id\)\)/);
  assert.ok(route.indexOf('if (DEMO)') > route.indexOf('!browserProven(door.ev)'), 'a demo board asks for the evidence too');
  // the body gives the id and nothing else
  assert.deepEqual(route.match(/\bb\.[a-zA-Z_]+/g).sort(), ['b.actor', 'b.id']);
  assert.match(route, /setupButtons\.run\(id, \{ busy: /);
  assert.match(src, /const setupButtonsOn = setupWrite && buttonsOffered\(SETTINGS\.setupPage, CALLER\.tripwire\);/);
  assert.match(src, /const setupButtons = createButtons\(\);/, 'the board gives the runner nothing of its own');
});

// ---- one at a time ----
test('a click while a run is in flight is refused, not queued; the next one runs once it has ended', async () => {
  const root = await rootWith();
  let release;
  const calls = [];
  const attached = (cmd, args) => { calls.push(args); return new Promise((res) => { release = () => res({ code: 0, out: 'done\n' }); }); };
  const b = createButtons({ root, attached, detached: async () => assert.fail('not this one') });
  const first = b.run('backup');
  await new Promise((res) => setImmediate(res));
  assert.equal(b.running(), 'backup');
  await assert.rejects(b.run('backup'), refused(409, /still running/));
  await assert.rejects(b.run('guardrails-check'), refused(409, /"BACK UP NOW" is still running/));
  assert.equal(calls.length, 1, 'the second click started nothing');
  release();
  assert.equal((await first).ok, true);
  assert.equal(b.running(), null);
  const again = b.run('backup');
  await new Promise((res) => setImmediate(res));
  release();
  assert.equal((await again).ok, true);
  assert.equal(calls.length, 2);
});

test('the Guardrails write stays in flight until its child ends; a refusal or a failure releases at once', async () => {
  const f = fake();
  const b = f.buttons(await rootWith());
  await b.run('guardrails-check');
  const r = await b.run('guardrails');
  assert.equal(r.started, true);
  assert.equal(r.log, path.join(RUNS_DIR, 'guardrails-x.log'));
  assert.equal(b.running(), 'guardrails');
  await assert.rejects(b.run('backup'), refused(409, /still running/));
  f.children[0].handlers.exit();
  assert.equal(b.running(), null);
  await assert.rejects(b.run('nope'), refused(400, /does not exist/));
  assert.equal(b.running(), null);
  await assert.rejects(b.run('backup', { busy: 'an upgrade is running' }), refused(409, /an upgrade is running: nothing is started/));
  assert.equal(b.running(), null);
});

// ---- the check before the write ----
test('the Guardrails write: not without a check, not after ten minutes, not when the check reads differently, and one check opens one write', async () => {
  const root = await rootWith();
  let f = fake();
  let b = f.buttons(root);
  await assert.rejects(b.run('guardrails'), refused(409, /run the check first/));
  assert.equal(f.calls.length, 0);

  // a check, then the write: the check is run again first, with the dry-run line, and only then the write
  f = fake({ outs: [{ code: 0, out: 'would add\n' }, { code: 0, out: 'would add\n' }] });
  b = f.buttons(root);
  const c = await b.run('guardrails-check');
  assert.deepEqual(c, { ok: true, id: 'guardrails-check', code: 0, timedOut: false, checked: true, output: 'would add\n' });
  const w = await b.run('guardrails');
  assert.equal(w.started, true);
  assert.deepEqual(f.calls.map((x) => [x.kind, x.args.slice(1).join(' ')]), [['attached', '--guardrails --dry-run'], ['attached', '--guardrails --dry-run'], ['detached', '--guardrails --yes']]);
  for (const x of f.calls) assert.deepEqual(Object.keys(x.env).filter((k) => /MESH|CMUX|TOKEN/.test(k)), []);
  f.children[0].handlers.exit();
  await assert.rejects(b.run('guardrails'), refused(409, /run the check first/), 'one check, one write');

  // the check reads differently at the write click
  f = fake({ outs: [{ code: 0, out: 'would add A\n' }, { code: 0, out: 'would add A and B\n' }] });
  b = f.buttons(root);
  await b.run('guardrails-check');
  await assert.rejects(b.run('guardrails'), refused(409, /reads differently now.*nothing was written/));
  assert.equal(f.calls.filter((x) => x.kind === 'detached').length, 0);
  await assert.rejects(b.run('guardrails'), refused(409, /run the check first/), 'the old check no longer counts');

  // the second check fails (the installer refuses): nothing written
  f = fake({ outs: [{ code: 0, out: 'same\n' }, { code: 3, out: 'same\n' }] });
  b = f.buttons(root);
  await b.run('guardrails-check');
  await assert.rejects(b.run('guardrails'), refused(409, /reads differently/));
  assert.equal(f.calls.filter((x) => x.kind === 'detached').length, 0);

  // too old
  f = fake();
  b = f.buttons(root);
  await b.run('guardrails-check');
  f.clock.t += CHECK_MINUTES * 60e3 + 1;
  await assert.rejects(b.run('guardrails'), refused(409, /run the check first/));
  assert.equal(f.calls.length, 1);
});

// ---- what is shown ----
test('output for the page: the last 16 KB from a line start, a line that looks like a secret withheld', () => {
  const made = ['sk', 'ant', 'abcdefghijklmnopqrstuvwx'].join('-');
  const shown = shownOutput(`ok one\nkey ${made}\nok two\n`);
  assert.ok(!shown.includes(made));
  assert.match(shown, /^ok one\n\(a line withheld: it looks like a secret\)\nok two\n$/);
  const long = `${'x'.repeat(40)}\n`.repeat(2000);
  const cut = shownOutput(long);
  assert.ok(cut.length <= MAX_OUTPUT);
  assert.ok(cut.startsWith('x'.repeat(40)), 'never half a line at the top');
  assert.equal(shownOutput(null), '');
});

test('the page gets titles and sentences, never a command line', () => {
  const list = buttonList();
  assert.deepEqual(list.map((b) => b.id), [...BUTTON_IDS]);
  for (const b of list) assert.deepEqual(Object.keys(b).sort(), ['id', 'needsCheck', 'says', 'title']);
  assert.deepEqual(list.filter((b) => b.needsCheck).map((b) => b.id), ['guardrails']);
  assert.doesNotMatch(JSON.stringify(list), /install\.sh|backup\.mjs|--/);
  assert.equal(demoButton('backup').output, 'demo: would run "BACK UP NOW" (nothing was started)');
});

test('the page script: buttons only when the reading lists them, text escaped, the write closed until a check, the id the only thing sent', async () => {
  const none = view.render({ write: { steps: ['owner', 'watch', 'engines'] }, installed: true });
  assert.doesNotMatch(none, /data-buttons|sw-run/);
  assert.equal(view.buttonsBlock(null), '');
  assert.equal(view.buttonsBlock([]), '');
  const html = view.render({ write: { steps: ['owner', 'watch', 'engines'], buttons: JSON.parse(JSON.stringify(buttonList())) }, installed: true });
  for (const id of BUTTON_IDS) assert.ok(html.includes(`data-button="${id}"`));
  assert.match(html, /data-button="guardrails" data-needs-check="1" disabled/);
  assert.equal((html.match(/ disabled/g) || []).length, 1);
  assert.ok(html.includes('the rules file gets the enforce default'));
  const evil = view.buttonsBlock([{ id: '"><script>x</script>', title: '<b>t</b>', says: '<img src=x>' }]);
  assert.doesNotMatch(evil, /<script>|<b>|<img/);
  // a hand-built board gets no buttons
  assert.doesNotMatch(view.render({ write: { steps: [], buttons: JSON.parse(JSON.stringify(buttonList())) }, installed: false }), /sw-run/);
  assert.deepEqual(JSON.parse(JSON.stringify(view.buttonOutcome(200, { ok: true, started: true }))), { bad: false, text: 'started: the board restarts now, the result shows here when it is back' });
  assert.equal(view.buttonOutcome(200, { ok: false, code: 3 }).bad, true);
  assert.equal(view.buttonOutcome(200, { ok: false, timedOut: true }).text, 'it ran out of time and was stopped');
  assert.equal(view.buttonOutcome(409, { msg: 'still running' }).text, 'still running');
  const js = await read('public/setup-write.js');
  assert.match(js, /fetch\('\/api\/setup\/button', \{ method: 'POST', headers: \{ 'content-type': 'application\/json', 'x-mesh-decision': token \}, body: JSON\.stringify\(\{ id \}\) \}\)/);
  assert.match(js, /p\.textContent = text/, 'output is set as text, never as markup');
  assert.doesNotMatch(js, /window\.confirm\(|localStorage|sessionStorage/);
});

// ---- a real backup and a real restore check, in a copy ----
test('a real run in a copy of the scripts: BACK UP NOW writes one archive without secrets, the restore check reads it and changes nothing', async () => {
  const root = await tmp('copy');
  for (const d of ['scripts', 'src', 'migrations']) await cp(path.join(ROOT, d), path.join(root, d), { recursive: true });
  await mkdir(path.join(root, 'data', 'tasks'), { recursive: true });
  await mkdir(path.join(root, 'overlay', 'config'), { recursive: true });
  await writeFile(path.join(root, 'data', 'tasks', '1.json'), '{"id":1,"title":"kept"}\n');
  await writeFile(path.join(root, 'overlay', 'config', 'local.json'), '{"dropExamples":true}\n');
  const planted = ['hook', 'value', 'never', 'in', 'a', 'backup'].join('-');
  await writeFile(path.join(root, 'data', 'secrets.env'), `SMS_WEBHOOK_KEY="${planted}"\n`);
  const b = createButtons({ root });
  const made = await b.run('backup');
  assert.equal(made.ok, true, made.output);
  const archives = (await readdir(path.join(root, 'data', 'backups'))).filter((n) => n.endsWith('.tgz'));
  assert.equal(archives.length, 1);
  assert.match(made.output, /secrets left out/);
  const snap = async () => {
    const out = {};
    for (const rel of ['data/tasks/1.json', 'overlay/config/local.json', 'data/secrets.env']) out[rel] = createHash('sha256').update(await readFile(path.join(root, rel))).digest('hex');
    out.backups = (await readdir(path.join(root, 'data', 'backups'))).sort();
    return out;
  };
  const before = await snap();
  await writeFile(path.join(root, 'data', 'tasks', '1.json'), '{"id":1,"title":"changed since"}\n');
  const changed = await snap();
  const check = await b.run('restore-check');
  assert.equal(check.ok, true, check.output);
  assert.match(check.output, /1 changed/);
  assert.match(check.output, /nothing written/);
  assert.ok(!check.output.includes(planted));
  assert.deepEqual(await snap(), changed, 'the restore check wrote nothing');
  assert.notDeepEqual(before, changed);
});

// ---- a real demo board ----
async function board(settings, extra, fn) {
  const overlay = await tmp('overlay');
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { setupPage: settings } }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1', ...extra }), stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    const token = (await (await fetch(`${base}/?setup=1`)).text()).match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    await fn(base, { 'content-type': 'application/json', 'x-mesh-decision': token });
  } finally { child.kill(); }
}
const click = (base, headers, id) => fetch(`${base}/api/setup/button`, { method: 'POST', headers, body: JSON.stringify({ id }) });

test('a real board with the key and no browser door: no buttons in the reading, and a click is a 404', async () => {
  await board({ mode: 'write', buttons: true }, {}, async (base, headers) => {
    assert.equal((await (await fetch(`${base}/api/setup`)).json()).write.buttons, undefined);
    assert.equal((await click(base, headers, 'backup')).status, 404);
    assert.equal((await fetch(`${base}/api/setup/button`, { headers })).status, 404);
  });
});

test('a real board with the browser door and no key: no buttons, a click is a 404', async () => {
  await board({ mode: 'write' }, { MC_DEMO_CALLER: 'on,browser' }, async (base, headers) => {
    assert.equal((await (await fetch(`${base}/api/setup`)).json()).write.buttons, undefined);
    assert.equal((await click(base, headers, 'backup')).status, 404);
  });
});

test('a real board with the key and the browser door: the buttons are listed, and a click that is not from a browser is refused, token or not, known id or not', async () => {
  await board({ mode: 'write', buttons: true }, { MC_DEMO_CALLER: 'on,browser' }, async (base, headers) => {
    const reading = await (await fetch(`${base}/api/setup`)).json();
    assert.deepEqual(reading.write.buttons.map((b) => b.id), [...BUTTON_IDS]);
    for (const id of [...BUTTON_IDS, 'nope']) assert.equal((await click(base, headers, id)).status, 403, id);
    assert.equal((await click(base, { 'content-type': 'application/json' }, 'backup')).status, 403);
    assert.equal((await click(base, { ...headers, 'x-mesh-agent': 'someone' }, 'backup')).status, 403);
    // without the json content type the write guard answers first
    assert.equal((await fetch(`${base}/api/setup/button`, { method: 'POST', headers: { 'x-mesh-decision': headers['x-mesh-decision'] }, body: '{"id":"backup"}' })).status, 415);
    // the read of the last run needs the token
    assert.equal((await fetch(`${base}/api/setup/button`)).status, 403);
    const last = await (await fetch(`${base}/api/setup/button`, { headers })).json();
    assert.deepEqual(last, { ok: true, running: null, last: null });
  });
});
