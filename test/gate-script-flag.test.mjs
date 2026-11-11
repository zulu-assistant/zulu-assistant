import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, parseCommand, scriptPath, scriptWords, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Task #530: for an interpreter or a shell "the script" was the first word that looks like a script, and a
// flag's value is such a word (`node --import ./pre.mjs scripts/upgrade.mjs --to v9`). A rule that names a
// script was then matched against the flag's value and the gated script behind it read clear. Now a script
// rule is tried on every script-looking word of the call, and the flags that take a value are known, so
// "the script" is the right word. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = '/work/board';
const ctx = () => ({ home: '/home/u', boardRoot: APP, ignoreCase: false, repoRoot: () => null, git: () => null });
const shipped = structuredClone(DEFAULT_POLICY);
const allOn = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'enforce'])) };
const run = (command, policy = shipped) => classify({ tool: 'Bash', command, cwd: APP }, policy, ctx());

// [command, class]: every clear row of the finding, and the rows that were held before
const HELD = [
  ['node scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node --import ./noop.mjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node -r ./noop.cjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node --require ./noop.cjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node --env-file ./conf/local.env scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node --loader ./l.mjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node --cpu-prof-dir ./prof scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node --import=./noop.mjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['bash install.sh upgrade', 'upgrade'],
  ['bash --rcfile ./rc.sh install.sh upgrade', 'upgrade'],
  ['bash --init-file ./rc.sh install.sh upgrade', 'upgrade'],
  ['bash scripts/task.sh gate 5 g1 approve', 'self'],
  ['bash --rcfile ./rc.sh scripts/task.sh gate 5 g1 approve', 'self'],
  ['node scripts/mesh-cli.mjs task gate 5 g1 approve', 'self'],
  ['node --import ./noop.mjs scripts/mesh-cli.mjs task gate 5 g1 approve', 'self'],
  ['python3 -X importtime -W ./w scripts/upgrade.py --apply', 'write'],
  // a flag the list does not know, and the script as a word of another script: asked, the safe side
  ['node --some-new-flag ./x.mjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['node ./other.mjs scripts/upgrade.mjs', 'upgrade'],
  ['node --import ./a.mjs --require ./b.cjs scripts/upgrade.mjs --to v9', 'upgrade'],
  ['zsh --rcfile ./rc.sh scripts/task.sh gate 5 g1 approve', 'self'],
  ['bash -c "node --import ./noop.mjs scripts/upgrade.mjs --to v9"', 'upgrade'],
];
const FREE = [
  'node scripts/upgrade.mjs --check',
  'node --import ./noop.mjs scripts/upgrade.mjs --check',
  'echo "node --import ./noop.mjs scripts/upgrade.mjs --to v9"',
  'grep -rn upgrade.mjs scripts',
  'bash --rcfile ./rc.sh scripts/task.sh show 5',
  'node --import ./noop.mjs scripts/task-helper.mjs list',
  'node --import ./noop.mjs scripts/mesh-cli.mjs agents',
  'bash install.sh check',
  'bash --rcfile ./rc.sh install.sh check',
];

test('a gated script behind a flag with a path-like value is held, at the shipped default and with every check on', () => {
  for (const [c, cls] of HELD) for (const p of [shipped, allOn]) {
    const r = run(c, p);
    assert.equal(r.verdict, 'gate', `${c} → ${r.why}`);
    assert.equal(r.cls, cls, c);
  }
});

test('what was free stays free: the check form, text that names the line, another word of the same script', () => {
  for (const c of FREE) for (const p of [shipped, allOn]) assert.equal(run(c, p).verdict, 'clear', `${c} → ${run(c, p).why}`);
});

test('"the script" is the script, not a flag\'s value; an unknown flag falls back to the first script-looking word', () => {
  const sp = (c) => scriptPath(parseCommand(c).cmds[0]);
  assert.equal(sp('node --import ./noop.mjs scripts/rename.mjs --commit'), 'scripts/rename.mjs');
  assert.equal(sp('node -r ./a.cjs --env-file ./conf/x.env scripts/rename.mjs'), 'scripts/rename.mjs');
  assert.equal(sp('bash --rcfile ./rc.sh install.sh upgrade'), 'install.sh');
  assert.equal(sp('ruby -I ./lib scripts/run.rb'), 'scripts/run.rb');
  assert.equal(sp('node scripts/rename.mjs ./data/in.js'), 'scripts/rename.mjs');
  assert.equal(sp('bash -x a.sh b.sh'), 'a.sh');               // -x takes no value in a shell
  assert.equal(sp('node --import ./only.mjs'), './only.mjs');   // nothing else: the value is all there is
  assert.equal(sp('node --new-flag ./x.mjs scripts/y.mjs'), './x.mjs');
  assert.deepEqual(scriptWords(parseCommand('node --import ./noop.mjs scripts/rename.mjs out.js').cmds[0]), ['./noop.mjs', 'scripts/rename.mjs', 'out.js']);
  assert.deepEqual(scriptWords(parseCommand('gh pr view 5').cmds[0]), []);
});

test('the reason names the script the rule matched, and its words are read after that script', () => {
  const r = run('node --import ./noop.mjs scripts/mesh-cli.mjs task gate 5 g1 approve');
  assert.match(r.why, /mesh-cli\.mjs/);
  assert.doesNotMatch(r.why, /noop/);
  // the rule's words must follow the script itself: the same words in front of it are another program's
  assert.equal(run('node ./gate.mjs task gate scripts/mesh-cli.mjs agents').verdict, 'clear');
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: the forms behind a flag are denied, the free forms pass', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate flag-')));
  const dir = path.join(base, 'Board Dir'); const home = path.join(base, 'home');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(shipped)); mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const hook = (command) => { const out = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  for (const c of ['node --import ./noop.mjs scripts/upgrade.mjs --to v9', 'node -r ./noop.cjs scripts/upgrade.mjs --to v9', 'bash --rcfile ./rc.sh install.sh upgrade',
    'bash --rcfile ./rc.sh scripts/task.sh gate 5 g1 approve', 'node --import ./noop.mjs scripts/mesh-cli.mjs task gate 5 g1 approve']) assert.equal(hook(c), 'deny', c);
  for (const c of ['node --import ./noop.mjs scripts/upgrade.mjs --check', 'bash --rcfile ./rc.sh scripts/task.sh show 5', 'node --import ./noop.mjs scripts/task-helper.mjs list']) assert.equal(hook(c), 'pass', c);
});
