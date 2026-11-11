import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, scriptsRun, DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService, namesPrRepo } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

// #548: a Codex shell call runs in a folder of its own choosing (exec_command's `workdir`), and Codex gives the hook
// only `{ command }` with the SESSION's folder as `cwd` (codex-rs 0.162.1, exec_command.rs pre_tool_use_payload; seen
// in live use: a push dry run that the board described against another repository). Such a call's
// repository is never read from the session folder: what depends on it asks, and the row says it was not read.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');

/** A PreToolUse input exactly as Codex 0.162.1 sends it for exec_command (the field list of its hook docs). */
const codexInput = (command, cwd, extra = {}) => ({ session_id: 's1', transcript_path: '/t/rollout.jsonl', cwd, hook_event_name: 'PreToolUse', model: 'gpt-x',
  permission_mode: 'default', turn_id: 'turn-1', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command, ...extra } });
const claudeInput = (command, cwd) => ({ session_id: 's2', transcript_path: '/t/x.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } });

const policyOff = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
const withPublic = { ...policyOff, lists: { ...(policyOff.lists || {}), publicRemotes: ['acme/public-app'] } };

async function repos() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'codex-folder-')));          // /var → /private/var on macOS
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  g('init', '-q', '-b', 'main', 'priv'); g('-C', 'priv', 'remote', 'add', 'origin', 'https://github.com/acme/private-app.git');
  g('init', '-q', '-b', 'feature', 'pub'); g('-C', 'pub', 'remote', 'add', 'origin', 'https://github.com/acme/public-app.git');
  return { priv: path.join(dir, 'priv'), pub: path.join(dir, 'pub') };
}
const git = (cwd, a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
const read = (j, policy = withPublic) => {
  const i = hookInput(j, {});
  return classify({ tool: i.tool, command: i.command, cwd: i.cwd, ...(i.folderUnread ? { folderUnread: true } : {}) }, policy,
    { home: '/home/u', boardRoot: ROOT, git, repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']) });
};

test('hook input: a Codex shell call without a workdir has an unread folder; a workdir is used; Claude is unchanged', () => {
  const x = hookInput(codexInput('git push origin feature', '/work/session'), {});
  assert.equal(x.engine, 'codex'); assert.equal(x.cwd, '/work/session'); assert.equal(x.folderUnread, true);
  const w = hookInput(codexInput('git push origin feature', '/work/session', { workdir: '../other' }), {});
  assert.equal(w.cwd, '/work/other'); assert.equal(w.folderUnread, undefined); assert.equal(w.folderFrom, 'workdir');
  const c = hookInput(claudeInput('git push origin feature', '/work/app'), {});
  assert.equal(c.engine, 'claude'); assert.equal(c.cwd, '/work/app'); assert.equal(c.folderUnread, undefined);
  // not a shell call: an edit or an MCP call names its own target
  assert.equal(hookInput({ ...codexInput(null, '/w'), tool_name: 'apply_patch', tool_input: { command: undefined, patch: 'x' } }, {}).folderUnread, undefined);
  assert.equal(hookInput({ ...codexInput(null, '/w'), tool_name: 'mcp__fs__read', tool_input: { path: '/a' } }, {}).folderUnread, undefined);
});

test('the case in point: a plain-branch push to a public remote, from a session whose folder is a private repo, is held', async () => {
  const r = await repos();
  // before #548 this read the session's private origin and came back clear
  const held = read(codexInput('git push origin feature', r.priv));
  assert.equal(held.verdict, 'gate'); assert.equal(held.cls, 'push');
  assert.match(held.why, /in a folder Codex did not name: repository not read \(name it: git -C \/abs\/path push/);
  // the same words from Claude Code: its cwd IS the shell's folder, so the reading stands (private, plain branch: free)
  assert.equal(read(claudeInput('git push origin feature', r.priv)).verdict, 'clear');
  // a folder named from the root is known again, and read: the public remote is said by name
  assert.match(read(codexInput(`git -C ${r.pub} push origin feature`, r.priv)).why, /push to public remote acme\/public-app/);
  assert.match(read(codexInput(`cd ${r.pub} && git push origin feature`, r.priv)).why, /push to public remote acme\/public-app/);
  assert.equal(read(codexInput(`cd ${r.priv} && git push origin feature`, r.pub)).verdict, 'clear');
  // a relative folder hangs off the unknown one
  assert.match(read(codexInput('cd ../pub && git push origin feature', r.priv)).why, /folder Codex did not name/);
  assert.match(read(codexInput('git -C sub push origin feature', r.priv)).why, /folder Codex did not name/);
});

test('a folder change that may not apply anchors nothing (MC review, section 1)', async () => {
  const r = await repos();
  const P = r.priv;
  for (const text of [`cd /nonexistent-xyz ; git push origin feature`, `cd /nonexistent-xyz || true; git push origin feature`,
    `pushd ${P} && popd && git push origin feature`, `cd ${P} | true; git push origin feature`, `cd ${P} && true & git push origin feature`,
    `false && cd ${P}; git push origin feature`, `test -d x && cd ${P}; git push origin feature`, `if false; then cd ${P}; fi; git push origin feature`,
    `a || cd ${P} && git push origin feature`, `cd /x; cd ${path.basename(P)} && git push origin feature`]) {
    const v = read(codexInput(text, r.pub));
    assert.equal(v.verdict, 'gate', text); assert.match(v.why, /folder Codex did not name/, text);
  }
  // certain: every link from the cd to the command is &&, a subshell keeps its own, git -C stops when its folder is wrong
  for (const text of [`cd ${P} && git push origin feature`, `true && cd ${P} && git status && git push origin feature`, `(cd ${P} && git push origin feature)`,
    `cd /x; cd ${P} && git push origin feature`, `cd ${P} && git push origin feature | tee /tmp/log`, `pushd ${P} && git push origin feature`])
    assert.equal(read(codexInput(text, r.pub)).verdict, 'clear', text);
});

test('one list of shell tool names; the engine is Codex by turn_id; a workdir is believed from Codex only', async () => {
  for (const name of ['shell', 'exec_command', 'local_shell', 'container.exec', 'unified_exec', 'Bash'])
    assert.equal(hookInput({ ...codexInput('git push origin x', '/w'), tool_name: name }, {}).folderUnread, true, name);
  // no other file spells the list out again
  const { readdirSync } = await import('node:fs');
  for (const dir of ['src', 'scripts']) for (const f of readdirSync(path.join(ROOT, dir)).filter((n) => /\.(mjs|js)$/.test(n))) {
    if (dir === 'src' && f === 'gates.mjs') continue;
    assert.ok(!/exec_command\|local_shell|local_shell\|container/.test(await readFile(path.join(ROOT, dir, f), 'utf8')), `${dir}/${f} has its own list of shell tool names`);
  }
  // Codex's input always carries turn_id (a required field of its hook input); without it and outside cmux it is Claude Code's
  const noTurn = { ...codexInput('git push origin x', '/w') }; delete noTurn.turn_id;
  assert.equal(hookInput(noTurn, {}).engine, 'claude');
  assert.equal(hookInput(noTurn, { CMUX_AGENT_LAUNCH_KIND: 'codex' }).engine, 'codex');
  assert.equal(hookInput(codexInput('ls', '/w'), {}).engine, 'codex');
  // a workdir in a Claude-shaped input moves nothing
  const c = hookInput({ ...claudeInput('git push origin x', '/work/app'), tool_input: { command: 'git push origin x', workdir: '/elsewhere' } }, {});
  assert.equal(c.cwd, '/work/app'); assert.equal(c.folderFrom, undefined);
});

test('other readings of the repository: a relative delete, gh on a public repo, a relative script', async () => {
  const r = await repos();
  const del = read(codexInput('rm -rf build', r.priv));
  assert.equal(del.verdict, 'gate'); assert.match(del.why, /on build in a folder Codex did not name/);
  assert.equal(read(codexInput(`cd ${r.priv} && rm -rf build`, r.priv)).verdict, 'clear');
  assert.equal(read(claudeInput('rm -rf build', r.priv)).verdict, 'clear');
  // (a gh comment on a public repo is read by the remoteWrite check, which 1.2 does not have)
  // scripts: a relative path in an unread folder is not the session folder's file of that name
  assert.deepEqual(scriptsRun('node tools/x.mjs --commit', '/w', { baseUnread: true }), [{ path: 'tools/x.mjs', cwd: '/w', unread: true }]);
  assert.deepEqual(scriptsRun('node /abs/x.mjs --commit', '/w', { baseUnread: true }), [{ path: '/abs/x.mjs', cwd: '/w' }]);
  assert.deepEqual(scriptsRun('cd /repo && node tools/x.mjs --commit', '/w', { baseUnread: true }), [{ path: 'tools/x.mjs', cwd: '/repo' }]);
  assert.deepEqual(scriptsRun('node tools/x.mjs --commit', '/w'), [{ path: 'tools/x.mjs', cwd: '/w' }]);
});

test('the real hook script, board down: the Codex form is denied, the Claude form passes', async () => {
  const r = await repos();
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', CMUX_AGENT_LAUNCH_KIND: '' };
  const run = (obj) => { const o = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(obj), env, encoding: 'utf8' }); return o.stdout ? JSON.parse(o.stdout).hookSpecificOutput.permissionDecision : 'pass'; };
  assert.equal(run(codexInput('git push origin feature', r.priv)), 'deny');
  assert.equal(run(claudeInput('git push origin feature', r.priv)), 'pass');
});

// ── the board: row, binding, program go ──
async function service() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-folder-svc-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(withPublic));
  const prCalls = []; const gitCalls = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true,
    now: () => Date.parse('2026-01-05T10:00:00Z'),
    prInfo: async (cmd, cwd, opts) => { prCalls.push({ cwd, ...(opts || {}) }); return { number: 12, title: 'T', head: 'f', base: 'main', headOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', repo: 'acme/app' }; },
    git: (cwd, args) => { gitCalls.push(cwd); return args[0] === 'remote' ? (args[1] === 'get-url' ? 'git@github.com:acme/app.git' : 'origin')
      : args[0] === 'rev-parse' && args.includes('--verify') ? 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' : args[0] === 'rev-parse' ? 'main' : null; },
  });
  const task = await ledger.create({ title: 'ship', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const codex = (command) => { const i = hookInput(codexInput(command, '/work/session'), {}); return svc.check({ ...i, workspaceId: 'W1' }); };
  const gates = async () => (await ledger.get(task.id)).gates || [];
  return { ledger, svc, task, codex, gates, prCalls, gitCalls };
}

test('board: a Codex push the board cannot read is refused unfiled, saying how to restate it; restated, it is read', async () => {
  const s = await service();
  const d = await s.codex('git push --dry-run origin HEAD:refs/heads/main');      // the command of the live case
  assert.equal(d.decision, 'deny'); assert.equal(d.unfiled, true);
  assert.match(d.reason, /not run and not filed .*Codex does not tell the gate which folder.*git -C \/abs\/path/);
  assert.deepEqual(await s.gates(), []);                                         // the owner gets no row bound to nothing
  assert.ok(!s.gitCalls.includes('/work/session'), 'nothing was read from the session folder');
  // restated with its folder: read, bound and filed as usual
  const again = await s.codex('git -C /work/notes push --dry-run origin HEAD:refs/heads/main');
  assert.equal(again.decision, 'deny'); assert.equal(again.unfiled, undefined, again.reason);
  const [g] = await s.gates();
  assert.equal(g.cls, 'push'); assert.equal(g.folderUnread, undefined);          // (1.2 binds no approval to the pushed commit)
  assert.ok(s.gitCalls.includes('/work/notes'));
});

test('board: a Codex merge with no repo named is refused unfiled; named, it is read and runs under the program go', async () => {
  const s = await service();
  await s.ledger.update(s.task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: ship', kind: 'program' });
  await s.ledger.update(s.task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  const plain = await s.codex('gh pr merge 12 --squash');
  assert.equal(plain.decision, 'deny'); assert.equal(plain.unfiled, true); assert.match(plain.reason, /no repo named \(name it: --repo owner\/name\)/);
  assert.equal(s.prCalls.length, 0); assert.deepEqual(await s.gates(), []);
  const named = await s.codex('gh pr merge 12 --squash -R acme/app');
  assert.equal(named.decision, 'allow'); assert.match(named.reason, /auto-approved under program go/);
  assert.equal(s.prCalls.length, 1);
  assert.equal(namesPrRepo({ tokens: ['gh', 'pr', 'merge', 'https://github.com/acme/app/pull/12'] }), true);
  assert.equal(namesPrRepo({ tokens: ['gh', 'pr', 'merge', '12'] }), false);
});

test('board: one rule (#551): every held Codex call with an unread folder is refused unfiled, unless a gh call names its repo', async () => {
  const s = await service();
  const rel = await s.codex('node scripts/rename.mjs --commit');
  assert.equal(rel.unfiled, true); assert.match(rel.reason, /in a folder Codex did not name \(name it: cd \/abs\/path && …/);
  // MC's examples: a delete, an absolute script whose effect depends on the folder, a deploy tool, gh with no repo named
  for (const c of ['rm -rf build', 'node /work/tools/rename.mjs --commit', 'vercel deploy --prod', 'gh repo delete --yes']) assert.equal((await s.codex(c)).unfiled, true, c);
  assert.match((await s.codex('gh repo delete --yes')).reason, /with no repo named \(name it: --repo owner\/name\)/);
  assert.deepEqual(await s.gates(), []);
  // named: filed as usual, and the row's folder is where the call runs
  for (const c of ['cd /work/app && vercel deploy --prod', 'gh repo delete acme/old-app --yes', 'cd /work/app && node tools/rename.mjs --commit']) assert.equal((await s.codex(c)).unfiled, undefined, c);
  const gs = await s.gates();
  assert.equal(gs.length, 3);
  assert.deepEqual(gs.map((g) => !!g.folderUnread), [false, true, false]);      // the gh row: its repo is named, so where it runs does not matter
});

test('the row: a Codex gate whose folder was not told says so in place of the folder', async () => {
  const ctx = {}; vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: ctx });
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const g = { id: 'g1', cls: 'push', label: 'Push', agent: 'sales-codex', cwd: '/work/session', tool: 'Bash', why: 'a push', command: 'git push origin feature' };
  const row = (x) => ctx.BoardDecide.gateRowHtml(x, { key: '1:g1', esc, age: '1m', open: false, actions: '' });
  assert.match(row({ ...g, folderUnread: true }), /sales-codex · folder not told by Codex \(session in \/work\/session\): repository not read · Bash/);
  assert.match(row(g), /sales-codex · \/work\/session · Bash/);
});
