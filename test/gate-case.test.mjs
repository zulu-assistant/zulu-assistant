import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, globMatch, rootedMatch, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Letter case (review of PR 111, finding 1). On a disk that ignores case, another spelling of a guarded
// path, of a guarded script or of a program is the same file. The rules that are enforced today matched
// case exactly. No switch: this closes a gap in rules that already hold calls. Fixture: board checkout
// /home/u/Board Dir, a worktree of it at /home/u/wt-7. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
const L = '/home/u/Board Dir'; const W = '/home/u/wt-7';
const ctx = (ignoreCase) => { const c = { home: '/home/u', boardRoot: L, ignoreCase, repoRoot: () => '/work/app', git: (cwd, a) => (a[0] === 'worktree' ? `worktree ${L}\nworktree ${W}` : null) }; c.triggers = compileTriggers(policy, c); return c; };
const bash = (command, ignoreCase = true, cwd = '/work/app') => classify({ tool: 'Bash', command, cwd }, policy, ctx(ignoreCase));
const file = (tool, filePath, ignoreCase = true) => classify({ tool, command: '', filePath, cwd: '/work/app' }, policy, ctx(ignoreCase));

const FILES = [
  ['Edit', `${L}/overlay/POLICY.JSON`], ['Edit', `${L}/Overlay/policy.json`], ['Write', '/home/u/board dir/overlay/policy.json'], ['Edit', `${W}/OVERLAY/policy.json`],
  ['Edit', `${L}/data/guardrails/GRANTS.JSON`], ['Read', `${L}/data/Guardrails/grants.json`], ['Read', `${L}/DATA/guardrails/grants.json`], ['Read', '/home/u/board dir/data/mesh-decision-token'],
  ['Edit', '/home/u/.Claude/settings.json'], ['Write', '/home/u/.claude/SETTINGS.JSON'], ['Edit', '/home/u/.CODEX/hooks.json'],
];
const COMMANDS = [
  [`echo x > "${L}/overlay/POLICY.JSON"`, 'self'], [`cat "${L}/data/guardrails/GRANTS.JSON"`, 'self'], [`cp "${L}/data/Guardrails/grants.json" /tmp/g.json`, 'self'],
  [`head -c 400 "/home/u/board dir/data/guardrails/grants.json"`, 'self'], [`rm -rf "${L}/data/GUARDRAILS"`, 'delete'], [`cat "${L}/data/MESH-DECISION-TOKEN"`, 'self'],
  ['sed -i "" s/a/b/ ~/.Claude/Settings.json', 'self'], ['cp x.plist ~/library/launchagents/com.x.plist', 'schedule'],
  // a guarded script, and the owner's own forms, under another spelling of the script's name
  ['scripts/TASK.SH gate 5 g1 approve', 'self'], ['scripts/Task.sh comment 5 "do it" --as owner --signed', 'self'], ['node scripts/MESH-CLI.MJS task gate 5 g1 approve', 'self'],
  // a program under another spelling of its name
  ['GH pr merge 5', 'merge'], ['Gh pr merge 5 --merge', 'merge'], ['GIT push origin main', 'push'], ['Vercel --prod', 'deploy'], ['/opt/homebrew/bin/GH pr merge 5', 'merge'], ['CRONTAB -r', 'schedule'],
  ['LAUNCHCTL bootout gui/501/com.example.web', 'deploy-local'], ['BASH -c "gh pr merge 5"', 'merge'], ['RM -rf ~/Downloads/x', 'delete'],
];

test('where the disk ignores case: every guarded path, script and program is held under another spelling too', () => {
  for (const [tool, f] of FILES) { const r = file(tool, f); assert.equal(r.verdict, 'gate', `${tool} ${f}`); assert.equal(r.cls, 'self', f); }
  for (const [c, cls] of COMMANDS) { const r = bash(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, cls, c); }
  // the exact spelling is held as before, and what was free stays free
  assert.equal(file('Edit', `${L}/overlay/policy.json`).cls, 'self'); assert.equal(bash('gh pr merge 5').cls, 'merge');
  for (const c of ['gh pr view 5', 'GH pr view 5', 'cat README.MD', 'git status', 'GIT STATUS', 'echo POLICY.JSON']) assert.equal(bash(c).verdict, 'clear', c);
  assert.equal(file('Read', `${L}/README.MD`).verdict, 'clear');
});

test('where case matters (the context says so), another spelling is another file and another program', () => {
  // (left out: a file in the gate state folder spelled exactly is held whatever the file is called, and a
  // recursive delete outside the repo is a delete in any spelling)
  const exact = (x) => x.includes(`${L}/data/guardrails/`) || x.startsWith('rm -rf');
  for (const [tool, f] of FILES.filter(([, f]) => !exact(f))) assert.equal(file(tool, f, false).verdict, 'clear', `${tool} ${f}`);
  for (const [c] of COMMANDS.filter(([c]) => !exact(c))) assert.equal(bash(c, false).verdict, 'clear', c);
  assert.equal(file('Edit', `${L}/overlay/policy.json`, false).cls, 'self'); assert.equal(bash('gh pr merge 5', false).cls, 'merge');
});

test('a wrapper in another case is still a wrapper: the program behind it is read (review of PR 114, finding 1)', () => {
  for (const c of ['ENV gh pr merge 5', 'Env GH pr merge 5', '/usr/bin/ENV gh pr merge 5', 'SUDO gh pr merge 5', 'NOHUP gh pr merge 5', 'NICE -n 5 gh pr merge 5', 'TIME gh pr merge 5',
    '/usr/bin/TIME gh pr merge 5', 'CAFFEINATE gh pr merge 5', 'ENV FOO=1 gh pr merge 5', 'TIMEOUT 30 gh pr merge 5', 'scripts/TASK.SH test 5 -- gh pr merge 5', 'BASH scripts/Task.sh test 5 -- GH pr merge 5']) {
    const r = bash(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'merge', c);
    assert.equal(bash(c, false).verdict, 'clear', `case matters: ${c}`);
  }
  for (const c of ['env gh pr merge 5', 'sudo gh pr merge 5', 'scripts/task.sh test 5 -- gh pr merge 5']) assert.equal(bash(c, false).cls, 'merge', c);
  for (const c of ['ENV gh pr view 5', 'TIME ls -la', 'NOHUP npm test']) assert.equal(bash(c).verdict, 'clear', c);
});

test('a rule whose program name has a capital holds every spelling where the disk ignores case, and only its own where case matters (finding 2)', () => {
  const p = structuredClone(policy); p.classes.push({ id: 'mine', label: 'An owner rule', rules: [{ bin: 'MyDeploy' }] });
  const run = (command, ignoreCase) => { const c = { home: '/home/u', boardRoot: L, ignoreCase, repoRoot: () => '/work/app', git: () => null }; return classify({ tool: 'Bash', command, cwd: '/work/app' }, p, c); };
  for (const c of ['MyDeploy now', 'mydeploy now', 'MYDEPLOY now', '/opt/tools/MyDeploy now']) assert.equal(run(c, true).cls, 'mine', c);
  assert.equal(run('MyDeploy now', false).cls, 'mine'); assert.equal(run('mydeploy now', false).verdict, 'clear'); assert.equal(run('MYDEPLOY now', false).verdict, 'clear');
  // renamed programs: a ruled name in another case is still the ruled name, not an unknown program
  const q = { ...p, checks: { ...p.checks, renamedBins: 'enforce' } };
  assert.equal(classify({ tool: 'Bash', command: 'MYDEPLOY push', cwd: '/work/app' }, q, { home: '/home/u', ignoreCase: true, git: () => null }).cls, 'mine');
});

test('the decision header in any case is the decision header (finding 3)', () => {
  const D = 'x-mesh-' + 'decision';
  for (const h of [D, 'X-Mesh-Decision', D.toUpperCase()]) for (const ic of [true, false]) {
    const r = bash(`curl -s -X PATCH http://localhost:3999/api/tasks/5 -H '${h}: abc' -H 'content-type: application/json' -d '{}'`, ic);
    assert.equal(r.verdict, 'gate', `${h} (${ic})`); assert.equal(r.cls, 'self');
  }
  assert.equal(bash(`grep -rn "${D.toUpperCase()}" src`).verdict, 'clear', 'reading the code is still free');
});

test('the helpers: a glob and a rooted path with and without case', () => {
  assert.equal(globMatch('/a/B/**', '/A/b/c.txt'), false); assert.equal(globMatch('/a/B/**', '/A/b/c.txt', { nocase: true }), true);
  assert.equal(rootedMatch('<repo>/overlay/policy.json', `${W}/Overlay/POLICY.json`, ctx(true)), true);
  assert.equal(rootedMatch('<repo>/overlay/policy.json', `${W}/Overlay/POLICY.json`, ctx(false)), false);
  assert.equal(rootedMatch('<repo>/overlay/policy.json', `${W}/overlay/policy.json`, ctx(false)), true);
});

test('real hook JSON on this machine: where the disk ignores case, another spelling is denied with the board down', { skip: process.platform !== 'darwin' && process.platform !== 'win32' }, () => {
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
  const hook = (obj) => { const out = spawnSync('sh', [path.join(ROOT, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', cwd: ROOT, hook_event_name: 'PreToolUse', ...obj }), env, encoding: 'utf8' }).stdout; return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  assert.equal(hook({ tool_name: 'Read', tool_input: { file_path: path.join(ROOT, 'data', 'MESH-DECISION-TOKEN') } }), 'deny');
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'GH pr merge 5' } }), 'deny');
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'scripts/TASK.SH gate 5 g1 approve' } }), 'deny');
  assert.equal(hook({ tool_name: 'Bash', tool_input: { command: 'GH pr view 5' } }), 'pass');
});
