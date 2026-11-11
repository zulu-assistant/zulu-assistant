import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Task #532 (follow-up to #530): a script handed to an interpreter or a shell on its input, by a redirect or
// through a pipe from cat, was not read as a run of that script: the rules that name a script did not see
// it, and for the redirect form the rules on a flag did not either. The input is now read as the script when
// the call names none itself. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const APP = '/work/board';
const ctx = () => ({ home: '/home/u', boardRoot: APP, ignoreCase: false, repoRoot: () => null, git: () => null });
const shipped = structuredClone(DEFAULT_POLICY);
const allOn = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'enforce'])) };
const run = (command, policy = shipped) => classify({ tool: 'Bash', command, cwd: APP }, policy, ctx());

const HELD = [
  // rules that name a script
  ['node < scripts/upgrade.mjs', 'upgrade'], ['node --input-type=module < scripts/upgrade.mjs', 'upgrade'], ['cat scripts/upgrade.mjs | node', 'upgrade'],
  ['cat install.sh | bash -s upgrade', 'upgrade'], ['cat install.sh | bash -s -- rollback', 'upgrade'],
  ['bash -s upgrade < install.sh', 'upgrade'], ['bash -s -- rollback < install.sh', 'upgrade'],
  ['sh -s -- gate 5 g1 approve < scripts/task.sh', 'self'], ['bash - gate 5 g1 approve < scripts/task.sh', 'self'], ['cat scripts/task.sh | sh -s -- gate 5 g1 approve', 'self'],
  ['cat scripts/mesh-cli.mjs | node - task gate 5 g1 approve', 'self'], ['node -r ./pre.cjs < scripts/upgrade.mjs', 'upgrade'],
  // rules on a flag
  ['node - --commit < scripts/rename.mjs', 'write'], ['cat scripts/rename.mjs | node - --commit', 'write'], ['python3 - --apply < tools/sync.py', 'write'],
  ['bash -s -- --apply < tools/sync.sh', 'write'], ['bash -s -- --apply <<< "$(cat tools/sync.sh)"', 'write'], ['bash -s -- --apply < <(cat tools/sync.sh)', 'write'],
  // a here-string that is one file's content
  ['bash -s upgrade <<< "$(cat install.sh)"', 'upgrade'], ['bash -s -- rollback <<< "$(< install.sh)"', 'upgrade'], ['sh -s -- gate 5 g1 approve <<< "$(cat scripts/task.sh)"', 'self'], ['cd tools && bash -s -- --commit < sync.sh', 'write'],
];
const FREE = [
  // the call names its own script or program: the input is data
  'node scripts/x.mjs < data/in.json', 'cat README.md | node tools/md.mjs', 'node -e "1" < scripts/upgrade.mjs', 'bash -c "wc -l" < install.sh', 'node scripts/upgrade.mjs --check < /dev/null',
  // a script with nothing gated about it, and files that are not scripts of a rule
  'bash < notes.txt', 'node < data/in.json', 'bash < scripts/task.sh', 'sh -s -- show 5 < scripts/task.sh', 'bash -s check < install.sh', 'bash -s -- check < scripts/bootstrap.sh', 'bash -n < install.sh',
  // readers of the same files
  'wc -l < install.sh', 'grep x < scripts/upgrade.mjs', 'sort < scripts/task.sh', 'cat install.sh | wc -l', 'cat install.sh | grep bash', 'cat scripts/task.sh | grep gate', 'cat scripts/task.sh | head -n 5',
  // text that only looks like it
  'bash <<< "ls -la"', 'bash <<< "$(cat notes.txt)"', 'grep x <<< "$(cat install.sh)"',
  'scripts/task.sh comment 5 "see cat task.sh | wc"', 'echo "bash < install.sh"',
];

test('a script on the input of an interpreter or a shell is a run of it: rules that name a script and rules on a flag', () => {
  for (const [c, cls] of HELD) for (const p of [shipped, allOn]) {
    const r = run(c, p);
    assert.equal(r.verdict, 'gate', `${c} → ${r.why}`);
    assert.equal(r.cls, cls, c);
  }
});

test('what stays free: input that is data, scripts no rule holds, readers of the same files, text', () => {
  for (const c of FREE) for (const p of [shipped, allOn]) { const r = run(c, p); assert.equal(r.verdict, 'clear', `${c} → ${r.cls}: ${r.why}`); }
});

test('an input form reads as its plain form does: in 1.2 the bare installer and bootstrap install are not held, by either form', () => {
  for (const [input, plain] of [['bash < install.sh', 'bash install.sh'], ['cat install.sh | bash -s -- --yes', 'bash install.sh --yes'], ['bash <<< "$(cat install.sh)"', 'bash install.sh'],
    ['bash -s -- install < scripts/bootstrap.sh', 'bash scripts/bootstrap.sh install']]) {
    for (const p of [shipped, allOn]) assert.equal(run(input, p).verdict, run(plain, p).verdict, `${input} / ${plain}`);
  }
});

test('the dry form of a held flag call is the plain run without the flag', () => {
  const r = run('node - --commit < scripts/rename.mjs');
  assert.equal(r.requireDryRun, true);
  assert.deepEqual(r.dryTokens, ['node', 'scripts/rename.mjs']);
});

test('the fast path: the input forms of a subcommand script reach the board by route lines that never hold by themselves', () => {
  const lines = triggerLines(DEFAULT_POLICY);
  assert.equal(readFileSync(path.join(ROOT, 'scripts', 'gate-triggers.default'), 'utf8'), lines.join('\n') + '\n');
  const route = compileTriggers(DEFAULT_POLICY).filter((t) => t.route);
  assert.ok(route.length >= 2);
  for (const c of ['sh -s -- gate 5 g1 approve < scripts/task.sh', 'cat scripts/task.sh | sh -s -- gate 5 g1 approve']) assert.ok(route.some((t) => t.re.test(c)), c);
  // a route line matched and no rule did: clear, not "a pattern the parser could not attribute"
  for (const c of ['sort < scripts/task.sh', 'cat scripts/task.sh | grep gate', 'python3 - <<EOF\nprint("cat task.sh | grep x")\nEOF']) assert.equal(run(c).verdict, 'clear', c);
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: the input forms are denied, the free forms pass', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate input-')));
  const dir = path.join(base, 'Board Dir'); const home = path.join(base, 'home');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(shipped)); mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const hook = (command) => { const out = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  for (const c of ['node < scripts/upgrade.mjs', 'bash -s -- rollback < install.sh', 'cat install.sh | bash -s upgrade', 'sh -s -- gate 5 g1 approve < scripts/task.sh', 'cat scripts/task.sh | sh -s -- gate 5 g1 approve', 'node - --commit < scripts/rename.mjs',
    'sh -s -- gate 5 g1 approve <<< "$(cat scripts/task.sh)"', 'bash -s upgrade <<< "$(cat install.sh)"'])
    assert.equal(hook(c), 'deny', c);
  for (const c of ['wc -l < install.sh', 'cat scripts/task.sh | grep gate', 'sh -s -- show 5 < scripts/task.sh', 'bash -s check < install.sh', 'node scripts/x.mjs < data/in.json']) assert.equal(hook(c), 'pass', c);
});
