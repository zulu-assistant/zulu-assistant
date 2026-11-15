// The anchor (scripts/guardrails-anchor.sh, Zulu 1.3 slice 17): the gate hook's registration in
// Claude Code's managed settings. The script writes nothing with administrator rights; it stages
// the file and prints one line for the owner to type. These tests check the file, the line, and
// the line's effect in a folder that stands in for the filesystem root (the same line with `sudo`
// and the ownership options taken out, since a test is not an administrator).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, statSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { ANCHOR_FILE, managedDir, sha256, anchorHooks, anchorText, anchorState, installLine, removeLine, registeredElsewhere, writableWithoutAdmin } from '../scripts/guardrails-anchor.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = '/home/u/Board Dir';
const rendered = (repo = REPO) => JSON.parse(readFileSync(path.join(ROOT, 'examples', 'claude', 'guardrails-hooks.json.tmpl'), 'utf8').replaceAll('__REPO__', repo).replaceAll('__NODE_BIN_DIR__', '/opt/node/bin'));
const scratch = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate anchor-')));

test('the managed file holds the installer\'s own gate entries, unchanged, and nothing else', () => {
  const tmpl = rendered();
  const hooks = anchorHooks({ ...tmpl, hooks: { ...tmpl.hooks, PreToolUse: [...tmpl.hooks.PreToolUse, { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo not ours' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] }, permissions: { allow: ['Bash'] } });
  // every entry of the template that runs one of the gate's scripts, byte for byte: Claude Code runs a
  // handler once when the same one is in two settings files, so the user-level entry and this one do not double
  assert.deepEqual(hooks, tmpl.hooks);
  for (const groups of Object.values(hooks)) for (const g of groups) for (const h of g.hooks) assert.match(h.command, /^GATE_NODE='\/opt\/node\/bin\/node' '\/home\/u\/Board Dir\/scripts\/gate-(config-)?hook\.sh'$/);
  assert.ok(hooks.PreToolUse && hooks.PostToolUse);
  const text = anchorText(tmpl);
  assert.deepEqual(JSON.parse(text), { hooks: tmpl.hooks }); assert.ok(text.endsWith('}\n'));
  assert.throws(() => anchorText({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } }), /holds no gate hook entry/);
  assert.equal(managedDir('darwin'), '/Library/Application Support/ClaudeCode'); assert.equal(managedDir('linux'), '/etc/claude-code'); assert.equal(managedDir('win32'), null);
  assert.equal(ANCHOR_FILE, '50-zulu-guardrails.json');
});

test('anchored, absent, different, unreadable', () => {
  const want = anchorText(rendered());
  const gone = () => { const e = new Error('no such file'); e.code = 'ENOENT'; throw e; };
  const denied = () => { const e = new Error('permission denied'); e.code = 'EACCES'; throw e; };
  assert.equal(anchorState(want, gone), 'absent');
  assert.equal(anchorState(want, denied), 'unreadable');
  assert.equal(anchorState(want, () => want), 'anchored');
  assert.equal(anchorState(want, () => JSON.stringify(JSON.parse(want))), 'anchored', 'the same JSON, spaced differently');
  assert.equal(anchorState(want, () => anchorText(rendered('/home/u/Another Checkout'))), 'differs');
  assert.equal(anchorState(want, () => '{ "hooks": '), 'differs');
});

test('the line the owner types: full paths, the copy kept from other readers until its hash has matched, moved into place whole', () => {
  const line = installLine({ staged: "/home/u/Board Dir/data/anchor/it's.json", sha: 'abc123', dir: '/Library/Application Support/ClaudeCode' });
  const d = "'/Library/Application Support/ClaudeCode/managed-settings.d";
  assert.equal(line, `sudo /bin/mkdir -p -m 755 '/Library/Application Support/ClaudeCode' ${d}' && sudo /usr/bin/install -m 600 -o root -g wheel '/home/u/Board Dir/data/anchor/it'\\''s.json' ${d}/.50-zulu-guardrails.json.new' && [ "$(sudo /usr/bin/shasum -a 256 ${d}/.50-zulu-guardrails.json.new' | /usr/bin/cut -d' ' -f1)" = abc123 ] && sudo /bin/chmod 644 ${d}/.50-zulu-guardrails.json.new' && sudo /bin/mv -f ${d}/.50-zulu-guardrails.json.new' ${d}/50-zulu-guardrails.json' && echo anchored || { sudo /bin/rm -f ${d}/.50-zulu-guardrails.json.new'; echo 'NOT anchored: the staged file is not the one that was shown, or a step failed'; }`);
  // every program is named by its full path: nothing is looked up on PATH while it runs as an administrator
  for (const m of line.matchAll(/sudo (\S+)/g)) assert.match(m[1], /^\/(usr\/)?bin\//, m[1]);
  // the copy waits under a hidden name, which Claude Code does not read, until its hash is checked
  assert.ok(line.indexOf('.50-zulu-guardrails.json.new') < line.indexOf('shasum') && line.indexOf('shasum') < line.indexOf('/bin/mv'));
  // the order that keeps a root-only file from other readers: copied 600, hashed with administrator rights
  // (a redirect would be opened by the owner's own shell), opened to readers only after the hash, then renamed
  const at = (w) => line.indexOf(w);
  assert.ok(at('install -m 600') > 0 && at('install -m 600') < at('sudo /usr/bin/shasum') && at('sudo /usr/bin/shasum') < at('/bin/chmod 644') && at('/bin/chmod 644') < at('/bin/mv -f'));
  assert.doesNotMatch(line, /-m 644/); assert.doesNotMatch(line, / < /, 'no redirect: the copy cannot be read without administrator rights');
  assert.match(installLine({ staged: '/s', sha: 'x', dir: '/etc/claude-code', group: 'root', sum: '/usr/bin/sha256sum' }), /-m 600 -o root -g root .*sudo \/usr\/bin\/sha256sum '/);
  assert.equal(removeLine({ dir: '/etc/claude-code' }), "sudo /bin/rm -f '/etc/claude-code/managed-settings.d/50-zulu-guardrails.json' && echo 'anchor removed'");
});

test('which checkout the user\'s own settings register', () => {
  assert.equal(registeredElsewhere(rendered(), REPO), null);
  assert.equal(registeredElsewhere(rendered('/home/u/Live Checkout'), REPO), '/home/u/Live Checkout');
  for (const none of [null, {}, { hooks: {} }, { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo x' }] }] } }]) assert.equal(registeredElsewhere(none, REPO), null);
});

// ── the script itself, against a folder that stands in for the filesystem root ──
const SH = path.join(ROOT, 'scripts', 'guardrails-anchor.sh');
function setup() {
  const dir = scratch();
  const root = path.join(dir, 'Root Dir'); const stage = path.join(dir, 'staged.json'); const user = path.join(dir, 'user-settings.json');
  writeFileSync(user, JSON.stringify(rendered(ROOT)));          // the user's own settings register THIS checkout's hook
  const run = (...args) => spawnSync('bash', [SH, '--root', root, '--stage', stage, '--user-settings', user, ...args], { encoding: 'utf8' });
  const target = path.join(root, managedDir(), 'managed-settings.d', ANCHOR_FILE);
  return { dir, root, stage, user, run, target };
}
/** What the owner would type, made runnable by a test: no sudo, no change of owner. */
const asTest = (line) => `umask 022; ${line.replaceAll('sudo ', '').replaceAll(/ -o root -g \w+/g, '')}`;
const lineOf = (out) => out.split('\n').find((l) => l.trim().startsWith('sudo /bin/mkdir')).trim();

test('the script: shows the file, stages it, prints the line; the line anchors; a swapped file does not go live', { skip: !managedDir() && 'no managed settings folder on this platform' }, () => {
  const s = setup();
  let r = s.run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^not anchored: no managed file \(/);
  const staged = readFileSync(s.stage, 'utf8');
  assert.match(r.stdout, new RegExp(`sha256 +${sha256(staged)}`));
  assert.ok(Object.keys(JSON.parse(staged).hooks).length >= 2);
  for (const l of staged.trimEnd().split('\n')) assert.ok(r.stdout.includes(`  ${l}`), 'the file is shown whole');
  assert.equal(s.run('--check').status, 3);
  // the file is swapped after it was shown: the line copies it, the hash does not match, nothing goes live
  const line = lineOf(r.stdout);
  writeFileSync(s.stage, JSON.stringify({ hooks: {}, env: { MESH_BOARD: 'http://127.0.0.1:4999' } }));
  let typed = spawnSync('sh', ['-c', asTest(line)], { encoding: 'utf8' });
  assert.match(typed.stdout, /^NOT anchored: the staged file is not the one that was shown/);
  assert.equal(existsSync(s.target), false); assert.deepEqual(readdirSync(path.dirname(s.target)), [], 'the copy under the hidden name is gone too');
  // the real thing
  r = s.run();
  typed = spawnSync('sh', ['-c', asTest(lineOf(r.stdout))], { encoding: 'utf8' });
  assert.equal(typed.stdout.trim(), 'anchored', typed.stderr);
  assert.equal(readFileSync(s.target, 'utf8'), readFileSync(s.stage, 'utf8'));
  assert.deepEqual(readdirSync(path.dirname(s.target)), [ANCHOR_FILE]);
  r = s.run('--check'); assert.equal(r.status, 0); assert.match(r.stdout, /^anchored: the managed settings hold this checkout's hook entries/);
  assert.match(s.run().stdout, /^anchored: .*\n[\s\S]*Nothing to do\./);
  // somebody edits the managed file: no longer what this checkout would write
  writeFileSync(s.target, JSON.stringify({ hooks: {} }));
  r = s.run('--check'); assert.equal(r.status, 3); assert.match(r.stdout, /^NOT anchored: a managed file is there, and it is not what this checkout would write/);
  // taking it out: a line of its own, again nothing run here
  r = s.run('--remove'); assert.equal(r.status, 0);
  const rm = r.stdout.split('\n').find((l) => l.trim().startsWith('sudo /bin/rm')).trim();
  assert.equal(spawnSync('sh', ['-c', asTest(rm)], { encoding: 'utf8' }).stdout.trim(), 'anchor removed');
  assert.equal(existsSync(s.target), false);
});

test('the script refuses to anchor a checkout the user\'s own settings do not register', { skip: !managedDir() && 'no managed settings folder on this platform' }, () => {
  const s = setup();
  writeFileSync(s.user, JSON.stringify(rendered('/home/u/Live Checkout')));
  let r = s.run();
  assert.equal(r.status, 3);
  assert.match(r.stdout, /Your own settings register the gate hook of another checkout:\n  \/home\/u\/Live Checkout\nThis script runs from:\n/);
  assert.doesNotMatch(r.stdout, /sudo /); assert.equal(existsSync(s.stage), false, 'nothing staged');
  r = s.run('--anyway'); assert.equal(r.status, 0); assert.match(r.stdout, /sudo \/bin\/mkdir -p /);
  // no user-level registration at all: said, and the anchor is still offered
  writeFileSync(s.user, '{}');
  r = s.run(); assert.equal(r.status, 0); assert.match(r.stdout, /Note: your own settings file does not register the gate hook/);
  // the script never asks for administrator rights itself
  for (const f of ['guardrails-anchor.sh', 'guardrails-anchor.mjs']) assert.doesNotMatch(readFileSync(path.join(ROOT, 'scripts', f), 'utf8').split('\n').filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l) && !/`sudo |'sudo |sudo \/bin\/r?m/.test(l)).join('\n'), /\bsudo\b/, f);
});

// ── the copy is not readable by others before its hash has matched (Mission Control's review of PR 121) ──
test('a staged path swapped for a link to another file: the copy is mode 600 while it is hashed, never opened to readers, and removed', { skip: !managedDir() && 'no managed settings folder on this platform' }, () => {
  const s = setup();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr);
  const shown = readFileSync(s.stage, 'utf8');
  const dir = path.join(s.root, managedDir());
  const hidden = path.join(dir, 'managed-settings.d', `.${ANCHOR_FILE}.new`);
  // a hash program that first writes down the mode of the file it is given, then hashes it as the real one would
  const seen = path.join(s.dir, 'mode-seen.txt');
  const recorder = path.join(s.dir, 'record sum.mjs');
  writeFileSync(recorder, `import { statSync, readFileSync, appendFileSync } from 'node:fs';\nimport { createHash } from 'node:crypto';\nconst f = process.argv[2];\nappendFileSync(${JSON.stringify(seen)}, (statSync(f).mode & 0o777).toString(8) + '\\n');\nprocess.stdout.write(createHash('sha256').update(readFileSync(f)).digest('hex') + '  ' + f + '\\n');\n`);
  const sum = `'${process.execPath}' '${recorder}'`;
  const line = () => asTest(installLine({ staged: s.stage, sha: sha256(shown), dir, sum }));

  // the swap: after the file was shown, the staged path becomes a link to a file the owner did not mean to copy
  const secret = path.join(s.dir, 'only root may read this');
  writeFileSync(secret, 'a secret\n'); chmodSync(secret, 0o600);
  rmSync(s.stage); symlinkSync(secret, s.stage);
  let typed = spawnSync('sh', ['-c', line()], { encoding: 'utf8' });
  assert.match(typed.stdout, /^NOT anchored: the staged file is not the one that was shown/, typed.stderr);
  assert.equal(readFileSync(seen, 'utf8'), '600\n', 'while the hash ran, the copy could be read by its owner only');
  assert.equal(existsSync(hidden), false, 'the copy is removed'); assert.equal(existsSync(s.target), false);

  // the right file: hashed at 600, opened to readers only afterwards, then in place
  rmSync(s.stage); writeFileSync(s.stage, shown); rmSync(seen);
  typed = spawnSync('sh', ['-c', line()], { encoding: 'utf8' });
  assert.equal(typed.stdout.trim(), 'anchored', typed.stderr);
  assert.equal(readFileSync(seen, 'utf8'), '600\n');
  assert.equal((statSync(s.target).mode & 0o777).toString(8), '644', 'every session can read the managed file once it is the right one');
  assert.equal(readFileSync(s.target, 'utf8'), shown);
});

test('"anchored" needs a folder only an administrator can write: owner and mode of the managed folder, the drop-in folder and the file', { skip: !managedDir() && 'no managed settings folder on this platform' }, () => {
  const paths = ['/m', '/m/managed-settings.d', '/m/managed-settings.d/f.json'];
  const st = (over = {}) => (p) => ({ uid: 0, mode: p.endsWith('.json') ? 0o100644 : 0o40755, ...(over[p] || {}) });
  assert.deepEqual(writableWithoutAdmin(paths, st()), []);
  assert.deepEqual(writableWithoutAdmin(paths, st({ '/m': { uid: 501 } })), ['/m'], 'a folder made under the user\'s name');
  assert.deepEqual(writableWithoutAdmin(paths, st({ '/m/managed-settings.d': { mode: 0o40775 } })), ['/m/managed-settings.d'], 'group may write');
  assert.deepEqual(writableWithoutAdmin(paths, st({ '/m/managed-settings.d/f.json': { mode: 0o100646 } })), ['/m/managed-settings.d/f.json'], 'others may write');
  assert.deepEqual(writableWithoutAdmin(paths, () => null), paths, 'what cannot be read is not vouched for');
  assert.deepEqual(writableWithoutAdmin(paths, st(), 501), paths, 'owned by somebody else than expected');

  // the script: anchored in text, in a drop-in folder others can write = not anchored in effect, exit 3
  const s = setup();
  const r = s.run();
  assert.equal(spawnSync('sh', ['-c', asTest(lineOf(r.stdout))], { encoding: 'utf8' }).stdout.trim(), 'anchored');
  assert.equal(s.run('--check').status, 0);
  chmodSync(path.dirname(s.target), 0o777);
  const loose = s.run('--check');
  assert.equal(loose.status, 3);
  assert.match(loose.stdout, /^NOT anchored in effect: the managed file holds this checkout's hook entries, but .*managed-settings\.d can be written without administrator rights/);
  assert.match(s.run().stdout, /^NOT anchored in effect/, 'the plain run says so too, and prints no line');
  assert.doesNotMatch(s.run().stdout, /sudo \/bin\/mkdir/);
  // taking it out is still offered
  assert.match(s.run('--remove').stdout, /sudo \/bin\/rm -f /);
  chmodSync(path.dirname(s.target), 0o755);
  assert.equal(s.run('--check').status, 0);
});
