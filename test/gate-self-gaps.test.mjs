import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, normalizeForTriggers, parseCommand, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Zulu 1.3 slice 6b (task #490): the forms the review of slice 6 found reading clear with `selfProtect`
// at enforce. Same fixture as test/gate-self.test.mjs. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policyAt = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), selfProtect: mode } });
const L = '/home/u/Board Dir'; const W = '/home/u/wt-7';
const fixture = (policy, over = {}) => {
  const ctx = {
    home: '/home/u', boardRoot: L, ignoreCase: true, board: { pids: [4242], port: 3999, label: 'com.example.board', cmdline: '/opt/n/bin/node /home/u/Board Dir/server.mjs' },
    repoRoot: (d) => (d.startsWith(L) ? L : d.startsWith(W) ? W : null),
    git: (cwd, a) => (a[0] === 'symbolic-ref' ? 'origin/main' : a.at(-1) === '@{u}' ? (over.upstream ?? 'origin/main')
      : a[0] === 'rev-parse' ? (['some-branch', 'HEAD~3'].includes(String(a[3]).replace('^{commit}', '')) ? 'sha' : null) : null),
    ...over.ctx,
  };
  ctx.triggers = compileTriggers(policy, ctx);
  return ctx;
};
const bash = (command, mode = 'enforce', cwd = L, over = {}) => { const p = policyAt(mode); return classify({ tool: 'Bash', command, cwd }, p, fixture(p, over)); };
const file = (tool, filePath, over = {}) => { const p = policyAt('enforce'); return classify({ tool, command: '', filePath, cwd: W }, p, fixture(p, over)); };
const held = (c, cls = 'self', cwd = L, over) => { const r = bash(c, 'enforce', cwd, over); assert.equal(r.verdict, 'gate', `${JSON.stringify(c)} → ${r.why}`); assert.equal(r.cls, cls, c); assert.equal(r.check, 'selfProtect', c);
  assert.equal(bash(c, 'off', cwd, over).verdict, 'clear', `off: ${c}`); assert.equal(bash(c, 'observe', cwd, over).wouldHold?.check, 'selfProtect', `observe: ${c}`); return r; };
const free = (c, cwd = L, over) => { for (const m of ['off', 'observe', 'enforce']) { const r = bash(c, m, cwd, over); assert.equal(r.verdict, 'clear', `${m}: ${JSON.stringify(c)} → ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); } };

const MULTILINE = [
  'echo x > src/gates.mjs\necho done', 'echo done\necho x > src/gates.mjs', 'set -e\ncp /tmp/g.mjs src/gates.mjs\nnode --test', 'git reset --hard\necho ok', 'git checkout some-branch\nnpm test',
  'cat > src/gates.mjs <<EOF\nexport const x = 1;\nEOF', "cat > src/gates.mjs <<'EOF'\nline one\nline two\nEOF\necho written", 'tee src/gates.mjs <<EOF\nx\nEOF', 'tee -a server.mjs <<-EOF\n\tx\n\tEOF',
  'sed -i "" s/a/b/ src/gates.mjs && \\\necho ok', 'cd src\necho x > gates.mjs', 'git config \\\n  --global user.name x', 'echo a\r\ngit reset --hard\r\necho b', 'git stash\ngit rebase origin/main\ngit stash pop',
];

test('1. multi-line commands and heredocs are read like the one line the hook sends', () => {
  for (const c of MULTILINE) held(c);
  free('git status\ngit log --oneline -3\necho done'); free('cat > /tmp/notes.md <<EOF\nreset the hard way: git reset --hard\nEOF', W);
  free('echo one\necho two', L);
  // grep on the hook JSON and the board's reading agree on multi-line samples
  const p = policyAt('enforce'); const opts = { boardRoot: L, home: '/home/u' };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-gaps-')); const tfile = path.join(dir, 'triggers'); writeFileSync(tfile, triggerLines(p, opts).join('\n') + '\n');
  const js = compileTriggers(p, opts);
  for (const [command, cwd] of [...MULTILINE.map((c) => [c, L]), ...MULTILINE.map((c) => [c, W]), ['git status\necho ok', L], ['echo x > README.md\necho y', L]]) {
    const sh = spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: normalizeForTriggers(JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } })) }).status === 0;
    const text = normalizeForTriggers(`tool_name:Bash ${command} `); const flat = text.replace(/[\n\r\t]+/g, ' ');
    const node = js.some((t) => t.re.test(t.live ? `${flat} ${normalizeForTriggers(cwd)}` : t.flat ? flat : text));
    assert.equal(sh, node, `${JSON.stringify(command)} in ${cwd}: grep ${sh} vs js ${node}`);
  }
  // the older lines keep their reading: only lines that belong to a 1.3 check are matched on one line
  assert.ok(js.filter((t) => !t.flat).length > 20); assert.ok(js.filter((t) => t.flat).length > 5);
});

test('2. letter case: on a volume that ignores case, another spelling is the same file', () => {
  for (const c of ['echo x > SRC/GATES.MJS', 'echo x > Src/gates.mjs', 'cp /tmp/g.mjs "/home/u/board dir/src/gates.mjs"', 'rm -rf PUBLIC', "echo 'x' >> /home/u/.ZSHRC"]) held(c);
  held('git reset --hard', 'self', '/home/u/board dir/SRC');
  for (const [tool, f] of [['Edit', `${L}/Src/Gates.mjs`], ['Write', '/home/u/board dir/src/gates.mjs'], ['Edit', '/home/u/.Claude/settings.json'], ['Edit', '/home/u/.ZSHRC']]) assert.equal(file(tool, f).cls, 'self', f);
  // where case does matter (ctx says so), another spelling is another file
  const strict = { ctx: { ignoreCase: false } };
  assert.equal(bash('echo x > SRC/GATES.MJS', 'enforce', L, strict).verdict, 'clear'); assert.equal(file('Edit', `${L}/Src/Gates.mjs`, strict).verdict, 'clear');
  assert.equal(bash('echo x > src/gates.mjs', 'enforce', L, strict).cls, 'self');
});

test('3. what "landed" means cannot be moved with a free command', () => {
  for (const c of ['git config remote.origin.url https://example.com/other.git', 'git config url.https://example.com/.insteadOf https://github.com/', 'git config remote.origin.fetch "+refs/heads/x:refs/remotes/origin/main"',
    'git config branch.main.remote fork', 'git config branch.main.merge refs/heads/x', 'git config include.path /tmp/extra', 'git config core.fsmonitor /tmp/prog', 'git config core.sshCommand "ssh -i /tmp/k"',
    'git config -f .git/config user.name x', 'git config --file ~/.gitconfig user.name x', 'git config --file=/home/u/.gitconfig user.name x', 'git config set remote.origin.url https://example.com/o.git',
    'git branch -u origin/x', 'git branch --set-upstream-to=origin/x', 'git branch --set-upstream-to origin/x main', 'git branch --unset-upstream',
    'git fetch origin x:refs/remotes/origin/main', 'git fetch origin +x:refs/remotes/origin/main', 'git fetch . x:refs/remotes/origin/main', 'git push . x:refs/remotes/origin/main',
    'git -c core.hooksPath=/tmp/h pull --ff-only', "git -c alias.x='!sh /tmp/a.sh' x", 'git -c core.hookspath=/tmp/h status']) held(c);
  // a bare pull follows the branch's upstream: free only while that is origin's default branch
  free('git pull --ff-only'); free('git pull --ff-only --autostash');
  held('git pull --ff-only', 'self', L, { upstream: 'origin/x' }); held('git pull --ff-only --autostash', 'self', L, { upstream: 'fork/main' });
  for (const c of ['git config remote.origin.url', 'git config --get remote.origin.url', 'git config -f .git/config --get user.name', 'git config -l', 'git config user.email x@example.com', 'git branch -a', 'git branch -vv',
    'git branch new-topic', 'git fetch origin', 'git fetch origin main', 'git fetch origin x:refs/heads/y', 'git -c color.ui=false status', 'git -c user.name=x commit -m y']) free(c);
  // the same config keys in a worktree are that worktree's business (the user and system files are held anywhere)
  for (const c of ['git config branch.task/7.remote origin', 'git branch -u origin/task/7', 'git config remote.origin.url https://example.com/o.git']) free(c, W);
  held('git config remote.origin.gh-resolved acme-public/tool', 'self', W); held('git config --unset remote.upstream.gh-resolved', 'self', W); free('git config remote.origin.gh-resolved', W);
  held('git fetch origin x:refs/remotes/origin/main', 'self', W); held('git config --file ~/.gitconfig user.name x', 'self', W); held('git -c core.hooksPath=/tmp/h commit -m x', 'self', W);
});

test('4. git forms that rewrite or remove gate files', () => {
  for (const c of ['git rm -f src/gates.mjs', 'git rm -r public', 'git mv src/gates.mjs src/old.mjs', 'git checkout -', 'git restore -s HEAD~3 :/', "git restore -s HEAD~3 'src/*.mjs'",
    'git restore -s HEAD~3 ":(top)src/gates.mjs"', 'git restore --source HEAD~3 -- src', 'git read-tree -u --reset HEAD~3', 'git bisect start HEAD HEAD~3', 'git bisect reset']) held(c);
  for (const c of [`git --git-dir="${L}/.git" --work-tree="${L}" reset --hard`, `GIT_DIR="${L}/.git" GIT_WORK_TREE="${L}" git reset --hard`, `GIT_WORK_TREE="${L}" git checkout some-branch`,
    `git -C "${L}" rm -f src/gates.mjs`, `git -C "${L}" mv server.mjs s.mjs`]) held(c, 'self', W);
  for (const c of ['git rm --cached notes.md', 'git rm old-notes.md', 'git mv README.md docs/README.md', 'git restore -s HEAD~3 README.md', "git restore -s HEAD~3 'docs/*.md'", 'git bisect log', 'git read-tree HEAD']) free(c);
  for (const c of ['git rm -f src/gates.mjs', 'git checkout -', 'git read-tree -u --reset HEAD~3', `git --git-dir="${W}/.git" --work-tree="${W}" reset --hard`]) free(c, W);
});

test('5. bulk writers into the checkout, a patch that names no file, and two redirect forms', () => {
  for (const c of ['cp -R /tmp/src .', 'cp -r /tmp/newsrc/ src', 'cp -a /tmp/x/. scripts', 'rsync -a /tmp/x/ src/', 'ditto /tmp/x public', 'tar -xf /tmp/x.tar', 'tar xzf /tmp/x.tgz', 'tar -xf /tmp/x.tar -C src',
    'unzip -o /tmp/x.zip -d public', 'unzip /tmp/x.zip', 'patch -p1 < /tmp/fix.diff', 'echo x >| src/gates.mjs', 'exec > server.mjs', 'exec >> src/gates.mjs 2>&1', '> src/gates.mjs']) held(c);
  held(`cp -R /tmp/src "${L}"`, 'self', W); held(`tar -xf /tmp/x.tar -C "${L}/src"`, 'self', W);
  for (const c of ['cp -R /tmp/docs docs', 'cp -r /tmp/x test/fixtures', 'tar -xf /tmp/x.tar -C /tmp/out', 'tar -tf /tmp/x.tar', 'tar -czf /tmp/out.tgz src', 'unzip -l /tmp/x.zip', 'unzip /tmp/x.zip -d /tmp/out',
    'rsync -a src/ /tmp/backup/', 'patch -p1 --dry-run -d /tmp/other < /tmp/fix.diff', 'exec > /tmp/log.txt', 'echo x >| /tmp/out.txt']) free(c);
  for (const c of ['cp -R /tmp/src .', 'tar -xf /tmp/x.tar', 'patch -p1 < /tmp/fix.diff', 'exec > server.mjs', 'rsync -a /tmp/x/ src/']) free(c, W);
  assert.deepEqual(parseCommand('echo x >| out.txt').cmds.map((c) => [c.bin, c.redirects]), [['echo', ['out.txt']]]);
});

test('6. a variable in the target: $HOME and $PWD are known; any other one with a guarded file name behind it asks', () => {
  for (const c of ['printf x > "$PWD/src/gates.mjs"', 'printf x > ${PWD}/server.mjs', 'printf x > $HOME/.zshrc', 'echo x >> "${HOME}/.gitconfig"', 'cp /tmp/s.json "$HOME/.claude.json"',
    'printf x > "$ROOT/src/gates.mjs"', 'cp /tmp/h "${DIR}/scripts/gate-hook.sh"', 'echo x | tee "$X/.claude/settings.json"']) held(c);
  for (const c of ['printf x > "$PWD/README.md"', 'printf x > "$TMPDIR/out.txt"', 'echo x > "$F"', 'cp a "$DEST/notes.md"', 'printf x > $HOME/notes.txt']) free(c);
  free('printf x > "$PWD/src/gates.mjs"', W);
});

test('7. stopping the board: lookups by process name or checkout, launchctl remove; signal 0 only asks', () => {
  for (const c of ['kill $(pgrep node)', 'kill -9 $(pgrep -f "Board Dir")', 'pkill -f bin/node', 'pgrep -f "Board Dir" | xargs kill', 'kill `pgrep -f server.mjs`', 'launchctl remove com.example.board', 'pkill -f "Board Dir/server"'])
    held(c, 'self', W);
  for (const c of ['kill -0 4242', 'pkill -0 node', 'kill -s 0 4242', 'kill $(pgrep vite)', 'kill $(pgrep -f "next dev")', 'pkill -f webpack', 'launchctl remove com.example.other', 'pgrep node']) free(c, W);
});

// ── through the real hook script, real hook JSON, board down ──
// every file the hook needs to run from a copy (src/caller.mjs joins them with the caller-evidence slice)
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
function hookCopy(mode) {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate gaps-'))), 'Live Checkout');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policyAt(mode)));
  mkdirSync(path.join(dir, 'data', 'guardrails'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'guardrails', 'triggers'), triggerLines(policyAt(mode), { boardRoot: dir, home: os.homedir() }).join('\n') + '\n');   // the lines the board would write
  return dir;
}
const decision = (dir, command, cwd = dir) => {
  const out = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass';
};

test('real hook JSON with the board\'s own lines: multi-line calls, heredocs and the new forms are denied in the live checkout', () => {
  const live = hookCopy('enforce'); const obs = hookCopy('observe');
  const samples = [...MULTILINE.filter((c) => !/git (checkout|stash|rebase)|--global/.test(c)), 'git rm -f src/gates.mjs', 'cp -R /tmp/src .', 'tar -xf /tmp/x.tar', 'patch -p1 < /tmp/fix.diff', 'echo x >| src/gates.mjs', 'exec > server.mjs',
    'printf x > "$PWD/src/gates.mjs"', 'git config remote.origin.url https://example.com/o.git', 'git branch -u origin/x', 'git -c core.hooksPath=/tmp/h pull --ff-only', 'git read-tree -u --reset HEAD~3'];
  for (const c of samples) { assert.equal(decision(live, c), 'deny', JSON.stringify(c)); assert.equal(decision(obs, c), 'pass', `observe: ${JSON.stringify(c)}`); }
  for (const c of ['git status\ngit log --oneline -3', 'echo one\necho two', 'cp -R /tmp/docs docs', 'tar -tf /tmp/x.tar', 'exec > /tmp/log.txt']) assert.equal(decision(live, c), 'pass', JSON.stringify(c));
  if (process.platform === 'darwin') for (const c of ['echo x > SRC/GATES.MJS', `cp /tmp/g.mjs "${live.toLowerCase()}/src/gates.mjs"`]) assert.equal(decision(live, c), 'deny', c);
});
