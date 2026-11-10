import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, normalizeForTriggers, parseCommand, writeTargets, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';
import { createGateService, policyProblems } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';

// Zulu 1.3 slice 6: gate self-protection (check `selfProtect`). Neutral fixtures: the board's live
// checkout is "/home/u/Board Dir", a git worktree of it is /home/u/wt-7. Samples are classified, never run,
// except the update recipe, which runs in throwaway repositories.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODES = ['off', 'observe', 'enforce'];
const policyAt = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), selfProtect: mode } });
const L = '/home/u/Board Dir'; const W = '/home/u/wt-7';
const STASHES = { 'stash@{0}': 'overlay/config/agents.json\noverlay/config/mesh.json', 'stash@{1}': 'src/gates.mjs\noverlay/config/agents.json' };
const fixture = (policy) => {
  const ctx = {
    home: '/home/u', boardRoot: L, board: { pids: [4242], port: 3999, label: 'com.example.board' },
    repoRoot: (d) => (d.startsWith(L) ? L : d.startsWith(W) ? W : null),
    git: (cwd, a) => (a[0] === 'symbolic-ref' || a.at(-1) === '@{u}' ? 'origin/main'
      : a[0] === 'rev-parse' ? (['some-branch', 'HEAD~3', 'abc1234'].includes(String(a[3]).replace('^{commit}', '')) ? 'sha' : null)
        : a[0] === 'stash' ? STASHES[a.at(-1)] ?? null : null),
  };
  ctx.triggers = compileTriggers(policy, ctx);
  return ctx;
};
const bash = (command, mode = 'enforce', cwd = L) => { const p = policyAt(mode); return classify({ tool: 'Bash', command, cwd }, p, fixture(p)); };
const file = (tool, filePath, mode = 'enforce', cwd = W) => { const p = policyAt(mode); return classify({ tool, command: '', filePath, cwd }, p, fixture(p)); };

// every row of the free and held table in docs/GUARDRAILS.md, in the live checkout
const GIT_HELD = [
  'git pull', 'git pull --ff-only fork main', 'git pull --ff-only origin feature', 'git pull --rebase', 'git pull --ff-only --rebase',
  'git merge feature', 'git merge --no-ff origin/main', 'git merge --ff-only feature', 'git rebase origin/main', 'git cherry-pick abc1234', 'git revert abc1234',
  'git apply fix.patch', 'git am 0001.patch', 'git checkout some-branch', 'git checkout -b new-branch', 'git switch some-branch', 'git switch -c x',
  'git reset --hard', 'git reset --hard HEAD~1', 'git reset --merge', 'git reset --keep HEAD~1', 'git stash pop stash@{1}', 'git stash apply stash@{1}',
  'git stash branch b', 'git stash pop stash@{7}', 'git restore --source HEAD~3 src/gates.mjs', 'git restore --source=HEAD~3 .', 'git restore -s HEAD~3 public',
  'git checkout HEAD~3 -- src/gates.mjs', 'git checkout abc1234 -- scripts/gate-hook.sh README.md',
];
const GIT_FREE = [
  'git pull --ff-only --autostash', 'git pull --ff-only', 'git pull --ff-only origin main', 'git merge --ff-only origin/main', 'git merge --ff-only --autostash origin/main',
  'git fetch', 'git fetch origin', 'git stash', 'git stash push -m wip', 'git stash pop', 'git stash apply', 'git stash list', 'git stash drop',
  'git restore src/gates.mjs', 'git restore --staged src/gates.mjs', 'git checkout -- src/gates.mjs', 'git checkout src/x.mjs', 'git checkout HEAD~3 -- README.md',
  'git restore --source HEAD~3 README.md', 'git status', 'git diff src/gates.mjs', 'git log --oneline -3 -- server.mjs', 'git add -A', 'git commit -m "merge and reset notes"',
  'git reset', 'git reset HEAD README.md', 'git merge --abort', 'git rebase --abort', 'git apply --check fix.patch', 'git worktree add ../wt-9 -b task/9 origin/main', 'git branch -a',
];
const ANYWHERE_HELD = [
  ['git config core.hooksPath /tmp/h', 'self'], ['git config --global user.name x', 'self'], ['git config --system core.editor vi', 'self'], ['git config alias.co checkout', 'self'],
  ['git config set --global user.name x', 'self'], ['git config --global --unset user.name', 'self'], ['git config --unset core.hooksPath', 'self'],
  ['git update-ref refs/remotes/origin/main 0123456789abcdef0123456789abcdef01234567', 'self'], ['git update-ref -d refs/remotes/origin/main', 'self'],
  ['git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/x', 'self'], ['git remote set-url origin https://example.com/other.git', 'self'],
  ['git remote add fork https://example.com/f.git', 'self'], ['git remote rename origin old', 'self'], ['git remote remove origin', 'self'],
  ['git clean -fdx', 'delete'], ['git clean -xdf', 'delete'], ['git clean -fX', 'delete'], ['git -C /somewhere clean -fdx', 'delete'],
];
const ANYWHERE_FREE = ['git config core.hooksPath', 'git config --global --get user.name', 'git config --global -l', 'git config user.name x', 'git config get --global user.name',
  'git symbolic-ref --short refs/remotes/origin/HEAD', 'git remote -v', 'git remote show origin', 'git remote get-url origin', 'git clean -fd', 'git clean -nfdx', 'git clean -fdx --dry-run'];
const KILL_HELD = ['kill 4242', 'kill -9 4242', 'kill -s TERM 4242', 'kill $(lsof -ti :3999)', 'kill -9 `lsof -ti tcp:3999`', 'lsof -ti :3999 | xargs kill', 'pgrep -f server.mjs | xargs kill -9',
  'kill $(pgrep -f server.mjs)', 'pkill -f server.mjs', 'pkill -f "node .*server"', 'pkill node', 'killall node', 'killall -9 node',
  'launchctl kill TERM gui/501/com.example.board', 'launchctl stop com.example.board'];
const KILL_FREE = ['kill 12345', 'kill %1', 'kill $!', 'kill $(lsof -ti :8080)', 'kill $(cat /tmp/x.pid)', 'pkill -f "node --test"', 'pkill -f vite', 'killall Finder',
  'launchctl stop com.example.other', 'launchctl kickstart -k gui/501/com.example.board', 'launchctl print gui/501/com.example.board', 'lsof -ti :3999'];

// every guarded path of the shipped default, as an absolute path in the fixture
const expand = (g) => g.replace('<live>', L).replace(/^~/, '/home/u').replace(/^\*\*\//, '/home/u/proj/').replace(/\/\*\*$/, '/x.txt');
const GUARDED = [...DEFAULT_POLICY.lists.gateCode, ...DEFAULT_POLICY.lists.guardGate].map(expand);
const writeForms = (p) => [`echo x > "${p}"`, `echo x >> ${p.replace(/ /g, '\\ ')}`, `echo x | tee "${p}"`, `cp /tmp/new "${p}"`, `mv /tmp/new "${p}"`, `mv "${p}" /tmp/gone`,
  `sed -i '' 's/a/b/' "${p}"`, `rm -f "${p}"`, `curl -s -o "${p}" https://example.com/x`];
// a copy INTO the folder names the file in two pieces. The fast path catches it when the board's lines name the
// live checkout (then the file's own name is a line); it is a stated limit for the paths outside the checkout.
const intoFolder = (p) => `cp /tmp/${path.basename(p)} "${path.dirname(p)}/"`;
const readForms = (p) => [`cat "${p}"`, `sed -n 1,5p "${p}"`, `grep -n x "${p}"`, `cp "${p}" /tmp/copy`, `node --check "${p}"`, `wc -l < "${p}"`, `diff "${p}" /tmp/other`];

test('the switch: off and observe keep today\'s verdict; observe says what would be held; the twin file matches', () => {
  assert.equal(DEFAULT_POLICY.checks.selfProtect, 'observe');
  const { _doc, ...twin } = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'policy.json'), 'utf8'));
  assert.deepEqual(twin, JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  assert.deepEqual(policyProblems(DEFAULT_POLICY), []);
  for (const c of [...GIT_HELD, ...ANYWHERE_HELD.map((x) => x[0]), ...KILL_HELD, ...writeForms(GUARDED[0]), ...writeForms('/home/u/.zshrc')]) {
    const off = bash(c, 'off'); const obs = bash(c, 'observe');
    assert.equal(off.verdict, 'clear', `off: ${c} → ${off.why}`); assert.equal(off.wouldHold, undefined, c);
    assert.equal(obs.verdict, 'clear', `observe: ${c}`); assert.equal(obs.wouldHold?.check, 'selfProtect', `observe: ${c}`);
  }
  for (const m of MODES) for (const c of [...GIT_FREE, ...ANYWHERE_FREE, ...KILL_FREE, ...readForms(GUARDED[0])]) {
    const r = bash(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`);
  }
  // a rule that held before still holds under its own class, with the check in any mode
  for (const m of MODES) { assert.equal(bash('gh pr merge 5', m).cls, 'merge'); assert.equal(file('Edit', '/home/u/.claude/settings.json', m).cls, 'self'); assert.equal(bash('git push origin main', m).cls, 'push'); }
  assert.ok(policyProblems({ ...policyAt('observe'), classes: [{ id: 'x', rules: [{ pathGuard: ['@nope'] }] }] }).some((p) => /not defined/.test(p)));
  assert.ok(policyProblems({ ...policyAt('observe'), classes: [{ id: 'x', rules: [{ bin: 'git', check: 'nope' }] }] }).some((p) => /not a known check/.test(p)));
  assert.ok(policyProblems({ ...policyAt('observe'), classes: [{ id: 'x', rules: [{ bin: 'git', when: 'sometimes' }] }] }).some((p) => /when/.test(p)));
});

test('guarded paths: every listed path is held for Edit, Write and each write form; reads are free', () => {
  for (const p of GUARDED) {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) { const r = file(tool, p); assert.equal(r.verdict, 'gate', `${tool} ${p}`); assert.equal(r.cls, 'self'); assert.equal(r.check, 'selfProtect'); }
    assert.equal(file('Read', p).verdict, 'clear', `Read ${p}`);
    for (const c of [...writeForms(p), ...(p.startsWith(L) && !p.endsWith('/x.txt') ? [intoFolder(p)] : [])]) { const r = bash(c, 'enforce', '/home/u/elsewhere'); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); }
    for (const c of readForms(p)) assert.equal(bash(c, 'enforce', '/home/u/elsewhere').verdict, 'clear', c);
  }
});

test('guarded paths: relative paths from inside the live checkout, folders above a guarded file, and what stays free', () => {
  for (const c of ['echo x > src/gates.mjs', 'cp /tmp/gates.mjs src/', 'cp /tmp/h.sh scripts/gate-hook.sh', 'echo x | tee -a server.mjs', 'mv server.mjs server.bak', 'rm -rf public',
    'rm -rf data', 'rm -rf src', 'mv src src.old', 'sed -i "" s/a/b/ public/app.js', 'echo "{}" > .claude/settings.local.json', 'cp /tmp/h .git/hooks/pre-commit',
    'perl -pi -e s/a/b/ src/tasks.mjs', 'cd src && echo x > gates.mjs', 'echo MC_PORT=4000 > data/local.env', 'dd if=/tmp/x of=server.mjs', 'truncate -s 0 data/tasks/5.json']) {
    const r = bash(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c);
  }
  for (const c of ['echo x > README.md', 'cp src/gates.mjs /tmp/', 'node --check src/gates.mjs', 'node --test "test/*.test.mjs"', 'rm -rf node_modules', 'mkdir -p data/handoffs/x && echo hi > data/handoffs/x/note.md',
    'git diff src/gates.mjs > /tmp/d.patch', 'sed -n 1,9p server.mjs', 'echo x > .claude/RESIDENT-STATE.md', 'mv /tmp/a /tmp/b']) assert.equal(bash(c).verdict, 'clear', c);
});

test('live only: the same file in a git worktree of the checkout is free; hook settings and shell files are guarded anywhere', () => {
  for (const c of ['echo x > src/gates.mjs', 'cp /tmp/h.sh scripts/gate-hook.sh', 'sed -i "" s/a/b/ server.mjs', 'rm -rf public', 'mv src/tasks.mjs /tmp/', ...GIT_HELD.filter((g) => !/stash@\{7\}/.test(g))])
    assert.equal(bash(c, 'enforce', W).verdict, 'clear', `worktree: ${c}`);
  for (const f of ['src/gates.mjs', 'scripts/gate-hook.sh', 'public/decide.js', 'server.mjs', 'overlay/config/agents.json']) assert.equal(file('Edit', `${W}/${f}`).verdict, 'clear', f);
  for (const c of ['echo "{}" > .claude/settings.local.json', 'cp /tmp/s.json .claude/settings.json', "echo 'export X=1' >> ~/.zshrc", 'cp /tmp/h .git/hooks/pre-commit'])
    assert.equal(bash(c, 'enforce', W).cls, 'self', `worktree: ${c}`);
  assert.equal(file('Edit', `${W}/.claude/settings.json`).cls, 'self');
  // from a worktree, reaching into the live checkout is held
  assert.equal(bash(`cp /tmp/h.sh "${L}/scripts/gate-hook.sh"`, 'enforce', W).cls, 'self');
  assert.equal(bash(`git -C "${L}" reset --hard`, 'enforce', W).cls, 'self');
  assert.equal(bash(`cd "${L}" && git checkout some-branch`, 'enforce', W).cls, 'self');
  assert.equal(bash('cd ~/"Board Dir" && git rebase origin/main', 'enforce', W).cls, 'self');
});

test('git: each row of the free and held table, in the live checkout', () => {
  for (const c of GIT_HELD) { const r = bash(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); assert.equal(r.check, 'selfProtect'); assert.match(r.why, /live checkout/, c); }
  for (const c of GIT_FREE) assert.equal(bash(c).verdict, 'clear', c);
  assert.match(bash('git stash pop stash@{1}').why, /would rewrite src\/gates\.mjs/);
  assert.match(bash('git stash pop stash@{7}').why, /cannot read/);
  // after a cd the gate cannot resolve, a session that started in the live checkout is still judged as in it
  assert.equal(bash('cd "$X" && git reset --hard').cls, 'self');
  assert.equal(bash('cd "$X" && git reset --hard', 'enforce', W).verdict, 'clear');
});

test('git anywhere: hooks path, aliases, user and system config, remote-tracking refs, remotes, clean of ignored files', () => {
  for (const cwd of [L, W, '/home/u/other']) {
    for (const [c, cls] of ANYWHERE_HELD) { const r = bash(c, 'enforce', cwd); assert.equal(r.verdict, 'gate', `${cwd}: ${c} → ${r.why}`); assert.equal(r.cls, cls, c); }
    for (const c of ANYWHERE_FREE) assert.equal(bash(c, 'enforce', cwd).verdict, 'clear', `${cwd}: ${c}`);
  }
});

test('kill: the board by pid, by its port, by name or by its label is held; other processes are not', () => {
  for (const c of KILL_HELD) { const r = bash(c, 'enforce', W); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); }
  for (const c of KILL_FREE) assert.equal(bash(c, 'enforce', W).verdict, 'clear', c);
});

test('write targets: the destination of a copy is a write, its source is not', () => {
  const t = (c) => writeTargets(parseCommand(c).cmds[0]);
  assert.deepEqual(t('cp a b'), ['b', 'b/a']); assert.deepEqual(t('cp -r a b dir'), ['dir', 'dir/a', 'dir/b']);
  assert.deepEqual(t('mv a b'), ['a', 'b', 'b/a']); assert.deepEqual(t('tee -a x y'), ['x', 'y']);
  assert.deepEqual(t('sed -n 1p x'), []); assert.deepEqual(t("sed -i '' s/a/b/ x"), ['', 's/a/b/', 'x']);
  assert.deepEqual(t('curl -s -o out https://example.com'), ['out']); assert.deepEqual(t('dd if=a of=b'), ['b']); assert.deepEqual(t('cat x'), []);
});

// ── parser fixes this slice needed (no switch): the word after `>` or `<<<` is that operator's, quoted or not ──
test('parser: a quoted redirect target is a redirect, and a quoted here-string to a shell is read as commands', () => {
  assert.deepEqual(parseCommand('echo x > "a b.txt" extra').cmds[0].redirects, ['a b.txt']);
  assert.deepEqual(parseCommand('echo x > "a b.txt" extra').cmds[0].tokens, ['echo', 'x', 'extra']);
  assert.deepEqual(parseCommand("echo x >> 'f' 2>&1").cmds[0].redirects, ['f']);
  assert.deepEqual(parseCommand('echo x > $(mktemp)').cmds.find((c) => c.bin === 'echo').redirects, ['$(mktemp)']);
  const off = policyAt('off');
  for (const c of ['bash <<< "gh pr merge 5"', "bash <<< 'gh pr merge 5'", 'sh <<<"git push origin main"', 'zsh <<< "vercel --prod"']) {
    assert.equal(classify({ tool: 'Bash', command: c, cwd: W }, off, fixture(off)).verdict, 'gate', c);
    assert.equal(classify({ tool: 'Bash', command: c, cwd: W }, off, { ...fixture(off), legacyParser: true }).verdict, 'clear', `the old reading, for the replay tool: ${c}`);
  }
  for (const c of ['cat <<< "gh pr merge later"', 'echo hi > "out.txt"', 'grep -c x <<< "push"']) assert.equal(classify({ tool: 'Bash', command: c, cwd: W }, off, fixture(off)).verdict, 'clear', c);
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'];   // the hook's whole file set
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function hookCopy(mode) {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate self-'))), 'Live Checkout');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policyAt(mode)));
  return dir;
}
const hookOut = (dir, obj, extra = {}) => spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify(obj), env: { ...env, ...extra }, encoding: 'utf8' }).stdout;
const decisionOf = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass');
const bashJson = (command, cwd) => ({ session_id: 's', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });
const fileJson = (tool, file_path, cwd) => ({ session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: tool === 'Write' ? { file_path, content: 'x' } : { file_path, old_string: 'a', new_string: 'b' } });
const dirs = Object.fromEntries(MODES.map((m) => [m, hookCopy(m)]));
const home = os.homedir();
const real = (g, live) => g.replace('<live>', live).replace(/^~/, home).replace(/^\*\*\//, '/tmp/some-project/').replace(/\/\*\*$/, '/x.txt');

test('real hook JSON, enforce: every guarded path is denied for Edit, Write and the Bash write forms; reads and the worktree copy pass', () => {
  const live = dirs.enforce; const wt = path.join(path.dirname(live), 'wt-7');
  for (const g of [...DEFAULT_POLICY.lists.gateCode, ...DEFAULT_POLICY.lists.guardGate]) {
    const p = real(g, live);
    assert.equal(decisionOf(hookOut(live, fileJson('Edit', p, wt))), 'deny', `Edit ${p}`);
    assert.equal(decisionOf(hookOut(live, fileJson('Write', p, wt))), 'deny', `Write ${p}`);
    for (const c of [`echo x > "${p}"`, `echo x | tee "${p}"`, `cp /tmp/new "${p}"`, `mv /tmp/new "${p}"`, `sed -i '' 's/a/b/' "${p}"`]) assert.equal(decisionOf(hookOut(live, bashJson(c, wt))), 'deny', c);
    assert.equal(hookOut(live, bashJson(`cat "${p}"`, wt)), '', `cat ${p}`);
    if (g.startsWith('<live>/')) {
      const copy = real(g, wt);
      assert.equal(hookOut(live, fileJson('Edit', copy, wt)), '', `worktree Edit ${copy}`);
      assert.equal(hookOut(live, bashJson(`echo x > "${copy}"`, wt)), '', `worktree redirect ${copy}`);
    }
  }
});

test('real hook JSON: off and observe answer byte for byte alike, and pass what enforce denies', () => {
  const samples = (live) => [...writeForms(real('<live>/src/gates.mjs', live)), 'git clean -fdx', 'git config core.hooksPath /tmp/h', 'git remote set-url origin https://example.com/o.git',
    'pkill -f server.mjs', 'killall node', 'echo "{}" > .claude/settings.local.json', "echo 'export X=1' >> ~/.zshrc", 'git status', 'kill 12345', 'gh pr merge 5', 'bash <<< "gh pr merge 5"'];
  const [offS, obsS, enfS] = [samples(dirs.off), samples(dirs.observe), samples(dirs.enforce)];
  offS.forEach((c, k) => {
    const off = hookOut(dirs.off, bashJson(c, '/tmp')); const obs = hookOut(dirs.observe, bashJson(obsS[k], '/tmp'));
    assert.equal(obs, off, c);
    assert.equal(decisionOf(off), /gh pr merge/.test(c) ? 'deny' : 'pass', c);
    if (!['git status', 'kill 12345'].includes(c)) assert.equal(decisionOf(hookOut(dirs.enforce, bashJson(enfS[k], '/tmp'))), 'deny', `enforce: ${enfS[k]}`);
  });
  for (const c of ['git status', 'kill 12345', 'git clean -nfdx', 'git config --global --get user.name', 'pkill -f vite']) assert.equal(hookOut(dirs.enforce, bashJson(c, '/tmp')), '', c);
});

// ── the update recipe, in throwaway repositories: an origin, the "live" checkout, a worktree of it ──
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repos() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate-recipe-')));
  const origin = path.join(base, 'origin'); const live = path.join(base, 'Live Checkout'); const wt = path.join(base, 'wt-7');
  mkdirSync(origin);
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(origin, f));
  writeFileSync(path.join(origin, 'policy.json'), JSON.stringify(policyAt('enforce')));
  for (const f of ['directory.json', 'switches.json', 'state.md', 'notes.md']) writeFileSync(path.join(origin, f), `${f} v1\n`);
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env });
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'first');
  execFileSync('git', ['clone', '-q', origin, live], { env });
  git(live, 'worktree', 'add', '-q', '-b', 'task/7', wt, 'origin/main');
  const land = (file, text) => { writeFileSync(path.join(origin, file), text); git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', `change ${file}`); };
  const dirty = () => { for (const f of ['directory.json', 'switches.json', 'state.md']) writeFileSync(path.join(live, f), `${f} edited here\n`); };
  const intact = () => ['directory.json', 'switches.json', 'state.md'].every((f) => readFileSync(path.join(live, f), 'utf8') === `${f} edited here\n`);
  const sh = (cwd, command) => spawnSync('sh', ['-c', command], { cwd, env, encoding: 'utf8' });
  const ask = (command, cwd = live) => decisionOf(hookOut(live, bashJson(command, cwd)));
  return { origin, live, wt, land, dirty, intact, sh, ask };
}

test('update recipe: the one-command fast-forward with autostash passes the hook and keeps the three local files', () => {
  const r = repos(); r.dirty(); r.land('notes.md', 'notes v2\n');
  assert.equal(r.ask('git pull --ff-only --autostash'), 'pass');
  const run = r.sh(r.live, 'git pull --ff-only --autostash');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(readFileSync(path.join(r.live, 'notes.md'), 'utf8'), 'notes v2\n');
  assert.ok(r.intact()); assert.equal(git(r.live, 'stash', 'list'), '');
});

test('update recipe: the three-step form passes at every step; a stash that holds a classifier file is denied at the pop', () => {
  const r = repos(); r.dirty(); r.land('notes.md', 'notes v2\n');
  for (const step of ['git stash', 'git pull --ff-only', 'git stash pop']) {
    assert.equal(r.ask(step), 'pass', step);
    assert.equal(r.sh(r.live, step).status, 0, step);
  }
  assert.ok(r.intact()); assert.equal(readFileSync(path.join(r.live, 'notes.md'), 'utf8'), 'notes v2\n');
  // now a stash that also carries the classifier
  writeFileSync(path.join(r.live, 'src', 'gates.mjs'), readFileSync(path.join(r.live, 'src', 'gates.mjs'), 'utf8') + '\n// local edit\n');
  assert.equal(r.sh(r.live, 'git stash').status, 0);
  assert.equal(r.ask('git stash pop'), 'deny');
  assert.equal(r.ask('git stash apply stash@{0}'), 'deny');
  assert.equal(r.ask('git stash drop'), 'pass');
});

test('update recipe: a plain pull, a pull from another remote, a hard reset and a branch change are denied in the live checkout and free in its worktree', () => {
  const r = repos();
  for (const c of ['git pull', 'git pull --ff-only fork main', 'git reset --hard', 'git reset --hard HEAD~1', 'git checkout task/7', 'git rebase origin/main', 'git restore --source HEAD~0 src/gates.mjs']) {
    assert.equal(r.ask(c), 'deny', `live: ${c}`);
    assert.equal(r.ask(c, r.wt), 'pass', `worktree: ${c}`);
  }
  assert.equal(r.ask(`git -C "${r.live}" reset --hard`, r.wt), 'deny');
  assert.equal(r.ask(`cd "${r.live}" && git pull`, r.wt), 'deny');
  for (const c of ['git status', 'git fetch', 'git checkout -- notes.md', 'git checkout notes.md', 'git restore notes.md', 'git log --oneline -2']) assert.equal(r.ask(c), 'pass', `live: ${c}`);
});

test('the row names the file: with the board up, a pop that would rewrite the classifier is a gate that says which file', async () => {
  const r = repos();
  writeFileSync(path.join(r.live, 'src', 'gates.mjs'), '// local edit\n'); assert.equal(r.sh(r.live, 'git stash').status, 0);
  const state = await mkdtemp(path.join(os.tmpdir(), 'gate-self-state-'));
  const ledger = createLedger(path.join(state, 'tasks'));
  const svc = createGateService({ root: r.live, ledger, policyFile: path.join(r.live, 'policy.json'), stateDir: path.join(state, 'guardrails'), identifyWs: async () => 'builder', home,
    mcName: async () => 'coordinator', isPrivateRepo: async () => null, prInfo: async () => null, board: { pids: [4242], port: 3999, label: 'com.example.board' },
    git: (cwd, a) => { try { return execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } } });
  const ans = await svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: 'git stash pop', cwd: r.live, workspaceId: 'W1' });
  assert.equal(ans.decision, 'deny');
  const g = (await ledger.get(ans.task)).gates[0];
  assert.equal(g.cls, 'self'); assert.match(g.why, /would rewrite src\/gates\.mjs/);
  assert.equal((await svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: 'kill 4242', cwd: r.wt, workspaceId: 'W1' })).decision, 'deny');
  assert.deepEqual(await svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: 'kill 4243', cwd: r.wt, workspaceId: 'W1' }), { decision: 'pass' });
});

// ── the board side: observe leaves a reading only ──
async function board(mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-self-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policyAt(mode)));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), identifyWs: async () => 'builder', home: '/home/u',
    mcName: async () => 'coordinator', git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, board: { pids: [4242], port: 3999, label: 'com.example.board' } });
  const check = (input) => svc.check({ event: 'pre', engine: 'claude', cwd: '/work/app', workspaceId: 'W1', ...input });
  const lines = async (f) => (await readFile(path.join(dir, 'guardrails', f), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, ledger, check, lines };
}

test('board: off is silent, observe passes with one reading per call, enforce files a self gate; the trigger file names the checkout', async () => {
  const calls = (dir) => [{ tool: 'Bash', command: 'git clean -fdx' }, { tool: 'Edit', filePath: path.join(dir, 'src', 'gates.mjs'), toolInput: { file_path: path.join(dir, 'src', 'gates.mjs'), old_string: 'a', new_string: 'b' } },
    { tool: 'Bash', command: 'pkill -f server.mjs' }];
  const off = await board('off');
  for (const c of calls(off.dir)) assert.deepEqual(await off.check(c), { decision: 'pass' });
  assert.deepEqual(await off.lines('observed.jsonl'), []);
  const obs = await board('observe');
  for (const c of calls(obs.dir)) assert.deepEqual(await obs.check(c), { decision: 'pass' });
  const seen = await obs.lines('observed.jsonl');
  assert.equal(seen.length, 3); assert.ok(seen.every((l) => l.wouldHold === 'selfProtect'));
  assert.deepEqual(seen.map((l) => l.cls), ['delete', 'self', 'self']);
  assert.deepEqual(await obs.ledger.list({}), []);
  const enf = await board('enforce');
  for (const c of calls(enf.dir)) assert.equal((await enf.check(c)).decision, 'deny');
  const gates = (await enf.ledger.list({})).flatMap((t) => t.gates || []);
  assert.deepEqual(gates.map((g) => g.cls).sort(), ['delete', 'self', 'self']);
  // the lines the board writes for the hook put the checkout's own folder next to the guarded names
  const trig = await readFile(path.join(enf.dir, 'guardrails', 'triggers'), 'utf8');
  assert.ok(trig.includes(path.basename(enf.dir)) || trig.includes(enf.dir));
  assert.ok(!(await readFile(path.join(off.dir, 'guardrails', 'triggers'), 'utf8')).includes('gate-hook'));
});

// ── fast path ──
test('fast path: with the board\'s lines, a call that does not name the live checkout never starts Node, and timing holds', () => {
  const live = dirs.observe; const policy = policyAt('observe');
  const lines = triggerLines(policy, { boardRoot: live, home: path.dirname(path.dirname(live)) });
  mkdirSync(path.join(live, 'data', 'guardrails'), { recursive: true });
  writeFileSync(path.join(live, 'data', 'guardrails', 'triggers'), lines.join('\n') + '\n');
  const js = compileTriggers(policy, { boardRoot: live, home: path.dirname(path.dirname(live)) });
  const tdir = mkdtempSync(path.join(os.tmpdir(), 'trig-self-')); const tfile = path.join(tdir, 'triggers'); writeFileSync(tfile, lines.join('\n') + '\n');
  const wt = path.join(path.dirname(live), 'wt-7');
  const shim = path.join(tdir, 'node'); const marker = path.join(tdir, 'ran');
  writeFileSync(shim, `#!/bin/sh\n: > "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  const quiet = [bashJson('git status && ls -la src && node --version', live), bashJson('git reset --hard && git checkout main && git pull', wt), bashJson('echo x > src/gates.mjs && mv public public.old', wt),
    fileJson('Edit', path.join(wt, 'src', 'gates.mjs'), wt), fileJson('Edit', path.join(wt, 'server.mjs'), wt), bashJson('npm test', live), bashJson('git log --oneline -3 && git diff --stat', live)];
  for (const q of quiet) {
    const text = normalizeForTriggers(JSON.stringify(q));
    assert.equal(spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: text }).status, 1, JSON.stringify(q.tool_input));
    assert.equal(hookOut(live, q, { GATE_NODE: shim }), '');
    assert.equal(readdirSync(tdir).includes('ran'), false, `the fast path started Node for ${JSON.stringify(q.tool_input)}`);
  }
  // grep on the hook JSON and the JS twins (command text plus the call's folder for the live lines) agree
  for (const [command, cwd] of [['git reset --hard', live], ['git reset --hard', wt], [`git -C "${live}" reset --hard`, wt], ['echo x > src/gates.mjs', live], ['cp /tmp/gates.mjs src/', live],
    ['rm -rf data', live], ['rm -rf data', wt], ['git clean -fdx', wt], ['kill 1', wt], ['echo "{}" > .claude/settings.local.json', wt], ['git status', live]]) {
    const sh = spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: normalizeForTriggers(JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } })) }).status === 0;
    const text = normalizeForTriggers(`tool_name:Bash ${command} `);
    const node = js.some((t) => t.re.test(t.live ? `${text} ${normalizeForTriggers(cwd)}` : text));
    assert.equal(sh, node, `${command} in ${cwd}: grep ${sh} vs js ${node}`);
  }
  hookOut(live, bashJson('git reset --hard', live), { GATE_NODE: shim });
  assert.equal(readdirSync(tdir).includes('ran'), true, 'a live-checkout hit should reach Node');
  const input = JSON.stringify(quiet[0]); const times = [];
  for (let i = 0; i < 60; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('sh', [path.join(live, 'scripts', 'gate-hook.sh'), '--env-board'], { input, env, encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
  times.sort((a, b) => a - b);
  assert.ok(times[30] < (process.env.CI ? 150 : 35), `median ${times[30].toFixed(1)} ms`);   // the same ceilings as test/gate-hook.test.mjs
});

test('the shipped fallback trigger file is the default policy\'s lines with no checkout named', () => {
  assert.deepEqual(readFileSync(path.join(ROOT, 'scripts', 'gate-triggers.default'), 'utf8').trim().split('\n'), triggerLines(DEFAULT_POLICY));
  assert.ok(triggerLines(policyAt('off')).length < triggerLines(policyAt('observe')).length);
});
