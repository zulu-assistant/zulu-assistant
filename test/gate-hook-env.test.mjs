// The gate hook does not believe the session's environment, and answers before its time limit
// (Zulu 1.3 slice 10b). Two things were seen live on Claude Code 2.1.321, with scratch hooks in
// scratch folders: a settings file's env block reaches every hook process, and a PreToolUse hook
// that answers after its registered time limit lets the call run. These tests drive the real
// scripts/gate-hook.sh with a hostile environment and with a Node step that hangs. The board is a
// dead port, so a gated call must come back denied by the hook's own offline judgment, and a call
// that is not gated must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync, cpSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { boardWait, BOARD_WAIT_MS, boardAddress, hostPort } from '../scripts/gate-hook.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
const base = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', MC_PORT: '', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
const pre = (command) => ({ session_id: 's', transcript_path: '/t.jsonl', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });
const post = (command) => ({ ...pre(command), hook_event_name: 'PostToolUse', tool_response: { stdout: '' } });
// `--env-board`: the tests' way to say "the address in the environment is the board I mean" (see the last tests)
const run = (obj, env = {}, { args = ['--env-board'], sh = 'sh' } = {}) => spawnSync(sh, [HOOK, ...args], { input: JSON.stringify(obj), env: { ...base, ...env }, encoding: 'utf8' });
const verdict = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null);
const GATED = 'gh pr merge 5 --squash';
const FREE = 'ls -la';
const scratch = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate env-')));

test('the baseline these tests lean on: board down, a gated call is denied by the Node step, anything else passes in silence', () => {
  const r = run(pre(GATED));
  assert.equal(r.status, 0); assert.equal(verdict(r).permissionDecision, 'deny');
  assert.match(verdict(r).permissionDecisionReason, /board unreachable/, 'the Node step ran and judged the call itself');
  const f = run(pre(FREE));
  assert.equal(f.status, 0); assert.equal(f.stdout, '');
});

test('a folder put first on PATH does not replace the tools the script runs', () => {
  const dir = scratch(); const bin = path.join(dir, 'bin'); mkdirSync(bin);
  // each of these would let a gated call through, or break the check, if the script ran it:
  //   cat: the hook input becomes "{}" (no trigger: pass) · sed: the text the triggers are matched on is emptied (pass)
  //   dirname: the script looks for itself elsewhere · sleep: the deadline's timer ends at once · pkill: nothing is killed
  const marker = path.join(dir, 'ran');
  for (const [name, body] of [['cat', 'echo "{}"'], ['sed', 'exit 0'], ['dirname', 'echo /nonexistent'], ['sleep', 'exit 0'], ['pkill', 'exit 0']])
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho ${name} >> '${marker}'\n${body}\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const r = run(pre(GATED), env);
  assert.equal(verdict(r)?.permissionDecision, 'deny'); assert.match(verdict(r).permissionDecisionReason, /board unreachable/);
  assert.equal(run(pre(FREE), env).stdout, '');
  assert.equal(existsSync(marker), false, 'none of them ran');
});

test('NODE_OPTIONS and the other variables that load code are cleared before Node starts', () => {
  const dir = scratch(); const marker = path.join(dir, 'preload-ran');
  const preload = path.join(dir, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(3);\n`);   // exit 3 reads as "not gated"
  const r = run(pre(GATED), { NODE_OPTIONS: `--require=${preload}`, NODE_PATH: dir, BASH_ENV: preload, ENV: preload });
  assert.equal(verdict(r)?.permissionDecision, 'deny'); assert.match(verdict(r).permissionDecisionReason, /board unreachable/);
  assert.equal(existsSync(marker), false);
  const sh = readFileSync(HOOK, 'utf8');
  const cleared = /^unset (.+)$/m.exec(sh)[1].split(' ');
  for (const v of ['NODE_OPTIONS', 'NODE_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'BASH_ENV', 'ENV', 'CDPATH']) assert.ok(cleared.includes(v), v);
  assert.match(sh, /^PATH="\/usr\/bin:\/bin:\/usr\/sbin:\/sbin\$\{PATH:\+:\$PATH\}"; export PATH$/m);
  assert.ok(sh.indexOf('\nPATH=') < sh.indexOf('$(cat)') && sh.indexOf('\nunset ') < sh.indexOf('$(cat)'), 'before the first program is run');
});

test('a Node step that hangs is answered by the script itself, inside the registered limit: deny, never silence', () => {
  const dir = scratch();
  // a "node" that never answers, and leaves a child behind that holds its output open
  const slow = path.join(dir, 'slow-node'); writeFileSync(slow, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
  const shells = ['sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];
  for (const sh of shells) {
    let t0 = Date.now();
    let r = run(pre(GATED), { GATE_NODE: slow }, { args: ['--deadline', '1', '--env-board'], sh });
    assert.equal(r.status, 0, sh); assert.equal(verdict(r).permissionDecision, 'deny', sh);
    assert.equal(verdict(r).permissionDecisionReason, 'GATE: the gate check did not answer in 1 s (fail closed) - the command was not run. Tell the owner; do not work around it.');
    assert.ok(Date.now() - t0 < 5000, `${sh}: answered in ${Date.now() - t0} ms`);
    // after the call there is nothing to deny: a late step just ends, with no output
    t0 = Date.now();
    r = run(post(GATED), { GATE_NODE: slow }, { args: ['--deadline', '1', '--env-board'], sh });
    assert.equal(r.status, 0, sh); assert.equal(r.stdout, '', sh);
    assert.ok(Date.now() - t0 < 5000, `${sh}: answered in ${Date.now() - t0} ms`);
    // no Node at all: denied at once, as before
    r = run(pre(GATED), { GATE_NODE: '/nonexistent/node' }, { sh });
    assert.match(verdict(r).permissionDecisionReason, /^GATE: the gate check failed \(fail closed\)/, sh);
    // and the ordinary answers still come through under that shell
    assert.match(verdict(run(pre(GATED), {}, { sh })).permissionDecisionReason, /board unreachable/, sh);
    assert.equal(run(pre(FREE), {}, { sh }).stdout, '', sh);
  }
});

test('the Node program is the one the registered command names: an assignment on the command line beats the environment, and nothing is looked up on PATH', () => {
  const dir = scratch(); const bin = path.join(dir, 'bin'); mkdirSync(bin);
  const marker = path.join(dir, 'stand-in-ran');
  // a stand-in "node" that answers allow, first on PATH and named by GATE_NODE in the environment
  const standIn = path.join(bin, 'node');
  writeFileSync(standIn, `#!/bin/sh\necho x >> '${marker}'\nprintf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'\n`, { mode: 0o755 });
  const hostile = { ...base, GATE_NODE: standIn, PATH: `${bin}:${process.env.PATH}` };
  // the registered form, as Claude Code runs it: the real Node step runs, the stand-in does not
  // (no board argument here, as in a real registration: the dead port in the environment is "another board")
  const registered = spawnSync('sh', ['-c', `GATE_NODE='${process.execPath}' '${HOOK}'`], { input: JSON.stringify(pre(GATED)), env: hostile, encoding: 'utf8' });
  assert.equal(verdict(registered).permissionDecision, 'deny'); assert.match(verdict(registered).permissionDecisionReason, /names another board/);
  assert.equal(existsSync(marker), false);
  // registered WITHOUT its Node path: no `node` is looked up on the session's PATH; a hit is denied and says what to do
  const noNode = { ...base, PATH: `${bin}:${process.env.PATH}` }; delete noNode.GATE_NODE;
  for (const env of [noNode, { ...noNode, GATE_NODE: 'node' }, { ...noNode, GATE_NODE: '' }, { ...noNode, GATE_NODE: './node' }]) {
    const r = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(pre(GATED)), env, encoding: 'utf8' });
    assert.equal(verdict(r).permissionDecision, 'deny', JSON.stringify(env.GATE_NODE));
    assert.match(verdict(r).permissionDecisionReason, /^GATE: the hook is registered without the path of its Node program \(GATE_NODE\), and it does not look one up on the session's PATH\. Run scripts\/guardrails-install\.sh again/);
    // a call with no trigger never needed Node, and one that already ran is never answered
    assert.equal(spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(pre(FREE)), env, encoding: 'utf8' }).stdout, '');
    assert.equal(spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(post(GATED)), env, encoding: 'utf8' }).stdout, '');
  }
  assert.equal(existsSync(marker), false, 'the stand-in on PATH never ran');
  // what the script cannot tell: an ABSOLUTE GATE_NODE in the environment when the script is started without
  // one on its command line. That is a registration without the Node path, which the guardrails card reports.
});

test('the limits fit inside each other: the wait for the board, the script\'s deadline, the registered limit', () => {
  const sh = readFileSync(HOOK, 'utf8');
  const deadline = Number(/^deadline=(\d+)$/m.exec(sh)[1]);
  assert.ok(BOARD_WAIT_MS / 1000 < deadline, 'the Node step gives up on the board before the script gives up on the Node step');
  for (const [file, unit] of [['examples/claude/guardrails-hooks.json.tmpl', 1], ['examples/codex/guardrails-hooks.json.tmpl', 1000]]) {
    const tmpl = JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
    const limits = Object.entries(tmpl.hooks).flatMap(([, groups]) => groups.flatMap((g) => g.hooks)).filter((h) => /gate-hook\.sh'$/.test(h.command)).map((h) => h.timeout / unit);
    assert.ok(limits.length >= 2, file);
    for (const l of limits) assert.ok(deadline < l, `${file}: the script answers at ${deadline} s, the registered limit is ${l} s`);
  }
  // the environment may shorten the wait for the board, never lengthen it
  assert.equal(boardWait({ GATE_TIMEOUT_MS: '300' }), 300);
  for (const v of ['600000', '8001', '0', '-5', 'abc', '', undefined]) assert.equal(boardWait({ GATE_TIMEOUT_MS: v }), BOARD_WAIT_MS, String(v));
});

// ── where the board is ──────────────────────────────────────────────────────
test('the board\'s address: this checkout\'s own file, else the default port — the environment only with the tests\' argument', () => {
  const none = () => { throw new Error('ENOENT'); };
  const at = (o) => boardAddress({ env: {}, args: [], root: '/b', read: none, ...o });
  assert.deepEqual(at({}), { url: 'http://127.0.0.1:3210', own: 'http://127.0.0.1:3210', named: null });
  assert.equal(at({ read: (f) => { assert.equal(f, '/b/data/local.env'); return 'OTHER=1\nMC_PORT=3344\n'; } }).url, 'http://127.0.0.1:3344');
  // the environment names another address: it is not used, and it is named (host and port only)
  assert.deepEqual(at({ env: { MESH_BOARD: 'http://127.0.0.1:4999' } }), { url: 'http://127.0.0.1:3210', own: 'http://127.0.0.1:3210', named: '127.0.0.1:4999' });
  assert.equal(at({ env: { MC_PORT: '4999' } }).named, '127.0.0.1:4999');
  assert.equal(at({ env: { MESH_BOARD: 'http://user:s3cret@elsewhere.example:8080/x?token=abc' } }).named, 'elsewhere.example:8080');
  assert.equal(at({ env: { MESH_BOARD: 'not a url' } }).named, 'an address that does not parse');
  assert.equal(at({ env: { MESH_BOARD: 'https://127.0.0.1:3210' } }).named, '127.0.0.1:3210', 'another scheme is another board');
  // the environment names this board: nothing to say
  for (const same of ['http://127.0.0.1:3210', 'http://localhost:3210', 'http://127.0.0.1:3210/'])
    assert.equal(at({ env: { MESH_BOARD: same } }).named, null, same);
  assert.equal(at({ env: { MC_PORT: '3344' }, read: () => 'MC_PORT=3344\n' }).named, null);
  // the tests' argument: the environment is believed, and nothing is "named"
  assert.deepEqual(at({ env: { MESH_BOARD: 'http://127.0.0.1:4999' }, args: ['--env-board'] }), { url: 'http://127.0.0.1:4999', own: 'http://127.0.0.1:3210', named: null });
  assert.equal(at({ args: ['--env-board'] }).url, 'http://127.0.0.1:3210');
  assert.equal(hostPort('http://[::1]:99/x'), '[::1]:99');
});

const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'];   // the hook's whole file set
/** A stand-in board: counts what it is asked and answers every check the same way. */
function standIn(answer) {
  const got = [];
  const srv = createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer)); }); });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, got, close: () => new Promise((r) => srv.close(r)) })));
}
const runAsync = (hook, obj, env, args = []) => new Promise((resolve) => {
  const p = spawn('sh', [hook, ...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  let out = ''; p.stdout.on('data', (c) => { out += c; });
  p.on('close', (status) => resolve({ status, stdout: out }));
  p.stdin.end(JSON.stringify(obj));
});

test('an environment that names another board: nobody is asked, a gated call is denied and says why, anything else passes', async () => {
  const dir = path.join(scratch(), 'Live Checkout');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  const own = await standIn({ decision: 'pass' });                                   // the checkout's own board says "not gated"
  const other = await standIn({ decision: 'allow', reason: 'the other one says yes' });   // what a redirect would point at
  mkdirSync(path.join(dir, 'data'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'local.env'), `MC_PORT=${own.port}\n`);
  const hook = path.join(dir, 'scripts', 'gate-hook.sh');
  const env = { ...base, MESH_BOARD: `http://127.0.0.1:${other.port}` };
  try {
    // a settings file's env block would look exactly like this to the hook
    let r = await runAsync(hook, pre(GATED), env);
    assert.equal(verdict(r).permissionDecision, 'deny');
    assert.equal(verdict(r).permissionDecisionReason, `GATE: this session's environment names another board (127.0.0.1:${other.port}), and the gate hook only asks its own (127.0.0.1:${own.port}) — gated command not run (fail closed). Tell the owner: MESH_BOARD or MC_PORT is set by a settings file's env block or a shell profile.`);
    r = await runAsync(hook, pre('echo "kickstart nothing"'), env);                  // reaches the Node step, is not gated
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
    r = await runAsync(hook, post(GATED), env);
    assert.equal(r.stdout, '');
    assert.deepEqual([own.got, other.got], [[], []], 'neither board was asked: a test that forgets the argument cannot reach a live board either');
    // the same through MC_PORT
    r = await runAsync(hook, pre(GATED), { ...base, MESH_BOARD: '', MC_PORT: String(other.port) });
    assert.match(verdict(r).permissionDecisionReason, /names another board/);
    assert.deepEqual([own.got, other.got], [[], []]);
    // no address in the environment, or this board's own: the checkout's board is asked and its answer stands
    r = await runAsync(hook, pre(GATED), { ...base, MESH_BOARD: '' });
    assert.equal(r.stdout, ''); assert.deepEqual(own.got, ['POST /api/gates/check']);
    r = await runAsync(hook, pre(GATED), { ...base, MESH_BOARD: `http://localhost:${own.port}` });
    assert.equal(r.stdout, ''); assert.equal(own.got.length, 2); assert.deepEqual(other.got, []);
    // with the tests' argument the environment is believed
    r = await runAsync(hook, pre(GATED), env, ['--env-board']);
    assert.equal(verdict(r).permissionDecision, 'allow'); assert.deepEqual(other.got, ['POST /api/gates/check']); assert.equal(own.got.length, 2);
  } finally { await own.close(); await other.close(); }
});

test('every test that starts the gate hook says which board it means', () => {
  // A test puts a dead port or a temp board in the environment. Without `--env-board` the hook
  // would take that for a redirect and judge the call itself, so the test would not test the board
  // path at all. This fails with the place to fix when a new test forgets the word.
  const dir = path.join(ROOT, 'test'); const missing = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.test.mjs') && n !== 'gate-hook-env.test.mjs')) {
    readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/spawn(Sync)?\(\s*['"](sh|bash|dash)['"]/.test(line) && /gate-hook\.sh|\[\s*(HOOK|hook)\b/.test(line) && !line.includes('--env-board')) missing.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(missing, [], `add '--env-board' after the script's path: ${missing.join(', ')}`);
});
