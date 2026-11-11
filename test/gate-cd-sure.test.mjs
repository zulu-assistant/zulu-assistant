import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, parseCommand, DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

// #551: a folder change that fails or does not apply was believed, for Claude Code input too (and in public 1.2.1).
// The command then runs in the real folder while the gate judged another. Now a change counts only when it certainly
// applies (every link from it to the command is `&&`); otherwise the command is read in every folder it may run in,
// and held when any of them holds it. Also read: `cd --`, `chdir`, `pushd -n`, a cd with extra words, and git told its
// repository (`--git-dir`, `GIT_DIR` inline or exported). Tables: Mission Control's review of PR 147, section 1 and
// "Second read". Real hook input, two scratch repositories (one private, one on the public list).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
const claudeInput = (command, cwd) => ({ session_id: 's', transcript_path: '/t/x.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } });
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
policy.lists = { ...(policy.lists || {}), publicRemotes: ['acme/public-app'] };

async function repos() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'cd-sure-')));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'feature', 'priv'); g('-C', 'priv', 'remote', 'add', 'origin', 'https://github.com/acme/private-app.git');
  g('init', '-q', '-b', 'feature', 'pub'); g('-C', 'pub', 'remote', 'add', 'origin', 'https://github.com/acme/public-app.git');
  return { priv: path.join(dir, 'priv'), pub: path.join(dir, 'pub') };
}
const git = (cwd, a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
const read = (command, cwd) => {
  const i = hookInput(claudeInput(command, cwd), {});
  return classify({ tool: i.tool, command: i.command, cwd: i.cwd }, policy, { home: '/home/u', boardRoot: ROOT, git, repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']) });
};

test('the change does not apply: real folder public, the text names the private one (MC section 1 and second read)', async () => {
  const { priv: P, pub } = await repos();
  for (const text of [`cd /nonexistent-xyz ; git push origin feature`, `cd /nonexistent-xyz || true; git push origin feature`, `cd ${P} | true; git push origin feature`,
    `cd ${P} && true & git push origin feature`, `false && cd ${P}; git push origin feature`, `test -d x && cd ${P}; git push origin feature`,
    `if false; then cd ${P}; fi; git push origin feature`, `pushd ${P} && popd && git push origin feature`, `pushd -n ${P}; git push origin feature`,
    `pushd -n ${P} && git push origin feature`, `cd ${P} extra-word; git push origin feature`, `cd ${P}\ngit push origin feature`, `a || cd ${P} && git push origin feature`]) {
    const v = read(text, pub);
    assert.equal(v.verdict, 'gate', text);
    assert.match(v.why, /push to public remote acme\/public-app|folder the gate cannot resolve/, text);
  }
});

test('the text moves to the public repository unseen: real folder private (second read)', async () => {
  const { priv, pub } = await repos();
  for (const text of [`cd -- ${pub} && git push origin feature`, `chdir ${pub} && git push origin feature`, `GIT_DIR=${pub}/.git git push origin feature`,
    `export GIT_DIR=${pub}/.git; git push origin feature`, `git --git-dir ${pub}/.git push origin feature`, `git -c core.worktree=${pub} --git-dir=${pub}/.git push origin feature`]) {
    const v = read(text, priv);
    assert.equal(v.verdict, 'gate', text); assert.match(v.why, /push to public remote acme\/public-app/, text);
  }
});

test('what is read as before: a sure change, a change that is wrong in every folder, both folders private', async () => {
  const { priv: P, pub } = await repos();
  for (const text of [`cd ${P} && git push origin feature`, `true && cd ${P} && git status && git push origin feature`, `(cd ${P} && git push origin feature)`,
    `cd /x; cd ${P} && git push origin feature`, `cd -- ${P} && git push origin feature`, `pushd ${P} && git push origin feature`, `git -C ${P} push origin feature`])
    assert.equal(read(text, pub).verdict, 'clear', text);
  // an unsure change between two private repositories: private in every folder it may run in
  assert.equal(read(`cd ${P}; git push origin feature`, P).verdict, 'clear');
  assert.equal(read(`cd /nonexistent-xyz ; git status`, pub).verdict, 'clear');
  // the hold names the folder the other reading came from
  assert.match(read(`cd ${P}; git push origin feature`, pub).why, new RegExp(`push to public remote acme/public-app \\(if a folder change in the call did not apply, it runs in ${pub}\\)`));
});

test('parser: which changes are sure, and the forms read as a change', () => {
  const at = (s) => parseCommand(s).cmds.find((c) => c.tokens[1] === 'push');
  assert.deepEqual(at('cd -- /p && git push').cdTargets, ['/p']);
  assert.deepEqual(at('chdir /p && git push').cdTargets, ['/p']);
  assert.deepEqual(at('pushd -n /p && git push').cdTargets, []);
  assert.equal(at('cd /p extra && git push').cdUnknown, true);
  assert.equal(at('pushd +1 && git push').cdUnknown, true);
  assert.equal(at('cd /p && git push').cdUnsure, undefined);
  for (const s of ['cd /p; git push', 'cd /p || x; git push', 'cd /p | x; git push', 'false && cd /p; git push', '! cd /p && git push', 'pushd /p && popd && git push']) assert.equal(at(s).cdUnsure, true, s);
});

test('the real hook script, board down: the unsure form is denied, the sure form passes', async () => {
  // the hook's own policy here (no test list of public remotes): the session's repository is on main, the named one on a branch
  const { priv: P } = await repos();
  const onMain = path.join(path.dirname(P), 'on-main');
  execFileSync('git', ['init', '-q', '-b', 'main', onMain], { stdio: 'ignore' });
  for (const d of [P, onMain]) execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { stdio: 'ignore' });   // a branch git can name
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', CMUX_AGENT_LAUNCH_KIND: '' };
  const run = (obj) => { const o = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(obj), env, encoding: 'utf8' }); return o.stdout ? JSON.parse(o.stdout).hookSpecificOutput.permissionDecision : 'pass'; };
  assert.equal(run(claudeInput(`cd ${P} ; git push origin HEAD`, onMain)), 'deny');     // if the cd fails, HEAD is main
  assert.equal(run(claudeInput(`cd ${P} && git push origin HEAD`, onMain)), 'pass');
});

test('board: an unsure folder reads no repository; the row names every folder the call may run in', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cd-sure-svc-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const gitCalls = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, now: () => Date.parse('2026-01-05T10:00:00Z'),
    prInfo: async () => null,
    git: (cwd, args) => { gitCalls.push([cwd, args[0]]); return args[0] === 'remote' ? (cwd === '/work/pub' ? 'git@github.com:acme/public-app.git' : 'git@github.com:acme/app.git') : args[0] === 'rev-parse' ? 'feature' : null; },
  });
  const task = await ledger.create({ title: 'ship', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const d = await svc.check({ ...hookInput(claudeInput('cd /work/app; git push origin feature', '/work/pub'), {}), workspaceId: 'W1' });
  assert.equal(d.decision, 'deny');
  const [g] = (await ledger.get(task.id)).gates;
  assert.deepEqual(g.folderUnsure, ['/work/app', '/work/pub']);
  // (1.2 binds no approval to a commit: the row's reason is the reading, with the folder it came from)
  assert.match(g.why, /push to public remote acme\/public-app \(if a folder change in the call did not apply, it runs in \/work\/pub\)/);
  const ctx = {}; vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: ctx });
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  assert.match(ctx.BoardDecide.gateRowHtml(g, { key: '1:g1', esc, age: '1m', open: false, actions: '' }), /runs in \/work\/app or \/work\/pub \(a folder change may not apply\): repository not read/);
});
