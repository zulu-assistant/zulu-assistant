import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Zulu 1.3 slice 6c (task #497): the bar for `selfProtect: enforce`. Groups 2 to 7 of the review of slice 6b:
// forms that read clear at enforce in the live checkout. Same fixture as test/gate-self-gaps.test.mjs.
// Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policyAt = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), selfProtect: mode } });
const L = '/home/u/Board Dir'; const W = '/home/u/wt-7'; const O = '/home/u/other';
const fixture = (policy, over = {}) => {
  const ctx = {
    home: '/home/u', boardRoot: L, ignoreCase: true, board: { pids: [4242], port: 3999, label: 'com.example.board', cmdline: '/opt/n/bin/node /home/u/Board Dir/server.mjs' },
    repoRoot: (d) => (d.startsWith(L) ? L : d.startsWith(W) ? W : d.startsWith(O) ? O : null),
    git: (cwd, a) => {
      if (a[0] === 'symbolic-ref') return 'origin/main';
      if (a.at(-1) === '@{u}') return over.upstream ?? 'origin/main';
      if (a[0] === 'worktree') return `worktree ${L}\nHEAD x\n\nworktree ${W}\nHEAD y\n`;
      if (a[0] === 'for-each-ref') return a.at(-1) === 'refs/remotes/*/task/9-dwim' ? 'refs/remotes/origin/task/9-dwim' : '';
      if (a[0] === 'rev-parse') { const w = String(a[3]).replace('^{commit}', ''); return ['some-branch', 'HEAD~3', ...(over.refs || [])].includes(w) ? 'sha' : null; }
      return null;
    },
    ...over.ctx,
  };
  ctx.triggers = compileTriggers(policy, ctx);
  return ctx;
};
const bash = (command, mode = 'enforce', cwd = L, over = {}) => { const p = policyAt(mode); return classify({ tool: 'Bash', command, cwd }, p, fixture(p, over)); };
const file = (tool, filePath) => { const p = policyAt('enforce'); return classify({ tool, command: '', filePath, cwd: W }, p, fixture(p)); };
const held = (c, cwd = L, over) => { const r = bash(c, 'enforce', cwd, over); assert.equal(r.verdict, 'gate', `${JSON.stringify(c)} → ${r.why}`); assert.equal(r.cls, 'self', c); assert.equal(r.check, 'selfProtect', c);
  assert.equal(bash(c, 'off', cwd, over).verdict, 'clear', `off: ${c}`); assert.equal(bash(c, 'observe', cwd, over).wouldHold?.check, 'selfProtect', `observe: ${c}`); return r; };
const free = (c, cwd = L, over) => { for (const m of ['off', 'observe', 'enforce']) { const r = bash(c, m, cwd, over); assert.equal(r.verdict, 'clear', `${m}: ${JSON.stringify(c)} → ${r.cls}: ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); } };

test('2. the index and HEAD of the live checkout: what moves them to another commit is held', () => {
  for (const c of ['git reset some-branch', 'git reset --soft some-branch', 'git reset --mixed some-branch', 'git reset some-branch -- src/gates.mjs', 'git reset -q HEAD~3',
    'git read-tree some-branch', 'git read-tree -u -m some-branch', 'git update-index --cacheinfo 100644,abc,src/gates.mjs', 'git update-index --add --cacheinfo 100644 abc src/gates.mjs', 'git update-index --index-info',
    'git update-ref HEAD abc123', 'git update-ref refs/heads/main abc123', 'git update-ref -d refs/heads/main', 'git symbolic-ref HEAD refs/heads/x',
    'git fetch -u origin x:main', 'git fetch origin x:main', 'git fetch origin x:refs/heads/main', 'git fetch --update-head-ok origin x:y', 'git branch -f main some-branch', 'git branch -M main', 'git branch -m main old',
    'git replace HEAD some-branch']) held(c);
  // the same from a worktree, with the live checkout named
  for (const c of [`git -C "${L}" reset some-branch`, `git --git-dir="${L}/.git" reset some-branch`, `git -C "${L}" update-ref refs/heads/main abc`, `git --git-dir="${L}/.git" update-ref HEAD abc`, `git -C "${L}" read-tree some-branch`]) held(c, W);
  // refs are shared with every worktree: the default branch and a replacement moved from one are held too
  for (const c of ['git update-ref refs/heads/main abc123', 'git update-ref refs/heads/origin/main abc', 'git update-ref refs/tags/origin/main abc', 'git update-ref refs/replace/abc def']) held(c, W);
  // what stays free: unstaging, a reset to where HEAD is, the free restores the design keeps, a worktree's own refs
  for (const c of ['git reset', 'git reset HEAD', 'git reset -- src/gates.mjs', 'git reset src/gates.mjs', 'git reset HEAD -- src/gates.mjs', 'git read-tree HEAD', 'git update-index --refresh', 'git update-index --really-refresh -q',
    'git symbolic-ref HEAD', 'git symbolic-ref --short HEAD', 'git fetch', 'git fetch origin', 'git fetch origin main', 'git fetch --prune origin', 'git fetch origin x:refs/heads/y', 'git branch', 'git branch -a', 'git branch new-thing', 'git branch -d old-thing',
    'git stash', 'git checkout -- .', 'git restore .', 'git checkout-index -f -a', 'git replace -l', 'git status', 'git log --oneline -3']) free(c);
  for (const c of ['git reset some-branch', 'git reset --hard', 'git update-ref refs/heads/task/7-x abc', 'git update-ref HEAD abc', 'git branch -f task/7-x some-branch', 'git fetch origin x:y', 'git read-tree some-branch', 'git symbolic-ref HEAD refs/heads/x']) free(c, W);
});

test('3. another repo\'s index written into the live tree', () => {
  for (const c of [`git --work-tree="${L}" checkout -- .`, `git --work-tree="${L}" restore .`, `git --work-tree="${L}" checkout-index -f -a`, `GIT_WORK_TREE="${L}" git checkout -- .`, `GIT_WORK_TREE="${L}" git stash`,
    `git checkout-index -f -a --prefix="${L}/"`, `git checkout-index -a --prefix="${L}/src/"`, `export GIT_DIR=${W}/.git GIT_WORK_TREE="${L}"; git reset --hard`, `export GIT_DIR=${W}/.git GIT_WORK_TREE="${L}"\ngit checkout -- .`,
    `export GIT_WORK_TREE="${L}" && git restore .`, `git --work-tree="${L}" clean -fd`]) held(c, W);
  // from inside the live checkout with another repo as the git dir: the work tree is the folder the call runs in
  for (const c of ['git --git-dir=/tmp/x/.git checkout -- .', 'GIT_DIR=/tmp/x/.git git restore .', 'git --git-dir=/tmp/x/.git checkout-index -f -a', 'export GIT_DIR=/tmp/x/.git; git checkout -- .']) held(c);
  // reads through a named work tree, the live checkout naming itself, and a worktree's own index written into a scratch folder
  for (const c of [`git --work-tree="${L}" status`, `git --work-tree="${L}" diff`, `git --git-dir="${L}/.git" log -1`]) free(c, W);
  for (const c of [`git --git-dir="${L}/.git" --work-tree="${L}" checkout -- .`, `git --git-dir="${L}/.git" status`]) free(c);
  for (const c of ['git checkout-index -f -a --prefix=/tmp/claude-x/out/', 'git --work-tree=/tmp/claude-x/tree checkout -- .', 'git checkout -- .', 'git restore .']) free(c, W);
});

test('4. names git reads another way', () => {
  held('git checkout task/9-dwim');                                 // only a remote has it: git makes the branch and switches
  free('git checkout --no-guess task/9-dwim'); free('git checkout src/gates.mjs'); free('git checkout .');
  // a local branch or tag that reads like the remote's default branch
  for (const c of ['git branch origin/main some-branch', 'git tag origin/main', 'git tag -f origin/main some-branch', 'git branch refs/remotes/origin/main', 'git fetch origin x:origin/main', 'git branch FETCH_HEAD']) held(c);
  held('git merge --ff-only origin/main', L, { refs: ['refs/heads/origin/main'] }); held('git merge --ff-only origin/main', L, { refs: ['refs/tags/origin/main'] });
  free('git merge --ff-only origin/main'); held('git merge --ff-only origin/main some-branch');
  for (const c of ['git remote set-head origin x', 'git remote set-head origin -d', 'git remote set-branches origin x', 'git fetch --refmap=+refs/heads/x:refs/remotes/origin/main origin', 'git fetch --refmap= origin x',
    'git pull --ff-only origin main x', 'git pull --ff-only --upload-pack=/tmp/p origin main', 'git fetch --upload-pack /tmp/p origin']) held(c);
  for (const c of ['git pull --ff-only origin main', 'git pull --ff-only', 'git tag v9.9.9', 'git tag -l', 'git tag -d origin/main', 'git remote -v', 'git remote show origin']) free(c);
});

test('5. one-call settings, stored keys that run a program, and git\'s own files', () => {
  for (const c of ['git -c remote.origin.url=/tmp/evil pull --ff-only origin main', 'git -c url./tmp/evil.insteadOf=https://github.com/ fetch origin', 'git -c include.path=/tmp/x pull --ff-only', 'git -c remote.origin.fetch=+refs/heads/x:refs/remotes/origin/main fetch',
    'git -c core.sshCommand=/tmp/p pull --ff-only origin main', 'git -c core.fsmonitor=/tmp/p stash', 'git --config-env=remote.origin.url=VAR pull --ff-only origin main', 'git --config-env remote.origin.url=VAR fetch origin',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=/tmp/evil git pull --ff-only origin main', 'GIT_CONFIG_GLOBAL=/tmp/gc git pull --ff-only', 'GIT_SSH_COMMAND=/tmp/p git fetch origin',
    "GIT_CONFIG_PARAMETERS=\"'core.hookspath=/tmp/h'\" git checkout -- .", 'export GIT_SSH_COMMAND=/tmp/p; git pull --ff-only origin main', 'GIT_CONFIG_GLOBAL=/tmp/gc git merge --ff-only origin/main']) held(c);
  // stored settings, in the live checkout and in a worktree (one settings file for both)
  for (const cwd of [L, W]) for (const c of ['git config filter.x.smudge /tmp/p', 'git config core.attributesFile /tmp/a', 'git config diff.external /tmp/p', 'git config core.pager /tmp/p', 'git config core.editor /tmp/p',
    'git config credential.helper /tmp/p', 'git config core.gitProxy /tmp/p', 'git config --edit', 'git config -e', 'git config set core.pager /tmp/p', 'git config --unset core.hooksPath', 'git config remote.origin.url /tmp/evil']) held(c, cwd);
  // direct writes to what git keeps
  for (const c of ['echo ref: refs/heads/x > .git/HEAD', 'cp /tmp/i .git/index', 'echo abc > .git/refs/heads/main', 'echo x >> .git/packed-refs', 'echo "* filter=x" > .git/info/attributes', 'echo "* filter=x" >> .gitattributes', 'rm .git/index']) held(c);
  for (const p of ['.git/HEAD', '.git/index', '.git/refs/heads/main', '.git/packed-refs', '.git/info/attributes', '.gitattributes']) { const r = file('Write', `${L}/${p}`); assert.equal(r.verdict, 'gate', p); assert.equal(r.check, 'selfProtect'); }
  // free: who the committer is, reads, a one-call setting on a command that brings nothing in, another repo, a worktree's own tracked file
  for (const cwd of [L, W]) for (const c of ['git config user.name x', 'git config user.email x@example.com', 'git config --get core.pager', 'git config -l', 'git config core.pager', 'git config list']) free(c, cwd);
  for (const c of ['git -c core.pager=cat log -3', 'git -c color.ui=false diff', 'git -c core.quotepath=off status', 'GIT_PAGER=cat git log -1', 'GIT_EDITOR=true git commit --amend --no-edit']) free(c);
  for (const c of ['git config core.pager less', 'git config filter.x.smudge /tmp/p', 'git -c core.sshCommand=/tmp/p pull --ff-only origin main', 'GIT_SSH_COMMAND=x git fetch origin']) free(c, O);
  free('GIT_SSH_COMMAND=x git pull --ff-only origin main', W); free('echo "*.png binary" >> .gitattributes', W);
  assert.equal(file('Write', `${W}/.gitattributes`).verdict, 'clear');
});

test('6. writers the check did not know, and other spellings of a target', () => {
  // a pattern as the source
  for (const c of ['cp /tmp/x/* src/', 'cp /tmp/x/* .', 'install /tmp/x/* scripts/', 'cp $SRC/gates.mjs src/', 'ln -s /tmp/x/* public/']) held(c);
  // downloads named by their address
  for (const c of ['curl -sO https://example.com/gates.mjs', 'curl --output-dir src -O https://example.com/x', 'curl --remote-name-all https://example.com/a https://example.com/b', 'curl -sLOJ https://example.com/x', 'wget https://example.com/x', 'wget -q -P src https://example.com/x']) held(c, c.includes('src') ? L : `${L}/src`);
  // unpackers and editors
  for (const c of ['gunzip src/gates.mjs.gz', 'gzip -d src/gates.mjs.gz', 'gzip server.mjs', 'bunzip2 src/gates.mjs.bz2', 'xz -d src/gates.mjs.xz', 'cpio -id < /tmp/a.cpio', 'pax -r -f /tmp/a.pax', '7z x /tmp/a.7z', '7z x /tmp/a.7z -osrc',
    'bsdtar -xf /tmp/a.tar', 'bsdtar -xf /tmp/a.tar -C src', 'ex -sc "%s/a/b/|x" src/gates.mjs', 'vim -es -c "%s/a/b/" -c wq server.mjs', 'ed -s src/gates.mjs']) held(c);
  // target spellings
  for (const c of ['echo x > "$(pwd)/src/gates.mjs"', 'echo x > `pwd`/src/gates.mjs', 'cp /tmp/g "$(pwd)/server.mjs"', 'echo x > src/$F', 'echo x > "src/${F}.mjs"', 'cp /tmp/g src/gates.{mjs,bak}', 'rm src/gates.{bak,mjs}', 'cp /tmp/g src/gate?.mjs', 'echo x > src/gate[s].mjs',
    'rm src/gate*.mjs', 'tee public/$NAME < /tmp/x', 'echo x > ./$F', 'sed -i "" s/a/b/ src/gates.{mjs,bak}']) held(c);
  held('echo x >> ~u/.zshrc', W); held(`echo x > ~u/"Board Dir"/src/gates.mjs`, W);
  // free: the same forms where no gate file can be reached
  for (const c of ['cp /tmp/x/* docs/', 'curl -sO https://example.com/x', 'wget https://example.com/x', 'gunzip docs/a.gz', 'tar -xf /tmp/a.tar -C docs', '7z x /tmp/a.7z -odocs', 'echo x > docs/$F', 'rm docs/*.bak', 'cp /tmp/g docs/a.{md,txt}',
    'echo x > /tmp/claude-x/$F', 'gzip -c src/gates.mjs > /tmp/claude-x/g.gz', 'gunzip -c /tmp/a.gz', 'curl -s https://example.com/x', 'curl -s -o /tmp/claude-x/y https://example.com/x', 'wget -O /tmp/claude-x/y https://example.com/x',
    'rm src/*.bak', 'echo x > src/note?.txt', '7z l /tmp/a.7z',
    // a sed expression is not a file (a row from the replay of past traffic)
    "sed -i '' -e '/^<<<<<<< HEAD$/d' -e '/^=======$/d' docs/CHANGELOG.md", 'sed -i "" "/$x/d" docs/a.md']) free(c, c.startsWith('curl -sO') || c.startsWith('wget https') ? `${L}/docs` : L);
  for (const c of ['cp /tmp/x/* src/', 'curl -sO https://example.com/gates.mjs', 'echo x > src/$F', 'gunzip src/gates.mjs.gz', 'bsdtar -xf /tmp/a.tar', 'cp /tmp/g src/gates.{mjs,bak}', 'echo x > "$(pwd)/src/gates.mjs"', 'ex -sc x src/gates.mjs']) free(c, W);
});

test('7. stopping the board', () => {
  for (const c of ['kill $(pgrep -u u node)', 'kill $(pgrep -U 501 node)', 'kill $(pgrep -u u)', 'kill $(pidof node)', 'kill `pidof node`', "ps aux | grep node | awk '{print $2}' | xargs kill", "ps aux | grep '[n]ode' | awk '{print $2}' | xargs kill -9",
    "ps -eo pid,comm | awk '/node/ {print $1}' | xargs kill", 'ps -o pid= | xargs kill', 'fuser -k 3999/tcp', 'fuser -k -n tcp 3999', 'kill-port 3999', 'kill -- -4242', 'kill -TERM -- -4242', 'kill $((4242))', 'P=4242; kill $P', 'P=4242\nkill -9 "$P"',
    'pkill -U u', 'pkill -u u', 'pkill -t ttys001', 'sudo reboot', 'reboot', 'sudo shutdown -r now', 'shutdown -h now', 'sudo halt', 'launchctl reboot', 'launchctl reboot userspace',
    `osascript -e 'tell application "System Events" to restart'`, `osascript -e 'tell app "System Events" to shut down'`, `osascript -e 'tell application "Finder" to restart'`]) held(c, W);
  // free: other processes, a look, the board's own restart, an unrelated script
  for (const c of ['kill $(pgrep -u u vite)', 'kill $(pidof vite)', "ps aux | grep vite | awk '{print $2}' | xargs kill", 'fuser -k 5173/tcp', 'fuser 3999/tcp', 'kill-port 5173', 'kill -- -777', 'kill $((777))', 'P=777; kill $P', 'kill -9 777',
    'pkill -u u vite', 'pkill -P 777', 'pgrep -u u node', 'ps aux | grep node', 'launchctl kickstart -k gui/501/com.example.board', `osascript -e 'display notification "restart needed"'`, `osascript -e 'tell application "Notes" to activate'`,
    'echo "reboot later"', 'git commit -m "shutdown hook fixed"']) free(c, W);
});

test('the three files of the settings-change check are on the gate code list, in the default and its twin', () => {
  for (const f of ['src/gate-integrity.mjs', 'scripts/gate-config-hook.sh', 'scripts/gate-config-hook.mjs']) {
    assert.ok(DEFAULT_POLICY.lists.gateCode.includes(`<live>/${f}`), f);
    const r = file('Edit', `${L}/${f}`); assert.equal(r.verdict, 'gate', f); assert.equal(r.check, 'selfProtect');
    assert.equal(file('Edit', `${W}/${f}`).verdict, 'clear', `worktree copy: ${f}`);
    held(`echo x >> ${f.replace(/^[^/]+\//, (d) => d)}`);
  }
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: the new forms reach the Node step and are denied at enforce; off and observe answer alike; ordinary calls never start Node', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate enforce-')));
  const dirs = {};
  for (const m of ['off', 'observe', 'enforce']) {
    const dir = path.join(base, m, 'Board Dir');
    for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
    writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policyAt(m)));
    mkdirSync(path.join(dir, 'data', 'guardrails'), { recursive: true });
    writeFileSync(path.join(dir, 'data', 'guardrails', 'triggers'), triggerLines(policyAt(m), { boardRoot: dir, home: os.homedir() }).join('\n') + '\n');   // the lines the board would write
    dirs[m] = dir;
  }
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const run = (dir, command, cwd = dir) => spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
  const decision = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass');
  const rows = ['git reset some-branch -- src/gates.mjs', 'git update-ref refs/heads/main abc123', 'git read-tree some-branch', 'git -c remote.origin.url=/tmp/evil pull --ff-only origin main', 'GIT_SSH_COMMAND=/tmp/p git fetch origin',
    'cp /tmp/x/* src/', 'curl --output-dir src -O https://example.com/x', 'echo x > src/$F', 'cp /tmp/g src/gates.{mjs,bak}', 'gunzip src/gates.mjs.gz', 'echo x > .git/HEAD', 'git config core.pager /tmp/p', 'sudo reboot', 'pkill -U u'];
  for (const c of rows) {
    const off = run(dirs.off, c); assert.equal(off, '', `off: ${c}`); assert.equal(run(dirs.observe, c), off, `observe: ${c}`);
    assert.equal(decision(run(dirs.enforce, c)), 'deny', `enforce: ${c}`);
  }
  for (const c of ['npm test', 'git status', 'ls -la', 'node --test "test/*.test.mjs"']) assert.equal(run(dirs.enforce, c), '', c);
  // the lines the shell greps are the ones the board reads
  const p = policyAt('enforce'); const opts = { boardRoot: dirs.enforce, home: os.homedir() };
  assert.equal(triggerLines(p, opts).length, compileTriggers(p, opts).length);
});

test('the 6c lines while the check only observes: they route the call and never hold it (off and observe answer alike)', () => {
  const py = (body) => `python3 - <<'PY'\n${body}\nPY`;
  const rows = [
    [py('print("then gunzip the archive and cp it over")'), L], [py('print("write with > out/$name")'), L], [py('print(open(".git/HEAD").read())'), L], [py('print(".gitattributes and .git/packed-refs")'), L],
    [py('print("a reboot is needed")'), W], [py('print("fuser and kill-port are tools")'), W], [py('print("git update-ref refs/heads/main is held")'), W], [py('print("osascript can ask for a restart")'), W],
    ['NOTE="git config core.pager less"; echo "$NOTE"', W], ['F=.git/HEAD; wc -c "$F"', L], ['X="sudo shutdown -h now"; echo "$X" | wc -c', W],
  ];
  for (const [c, cwd] of rows) {
    const off = bash(c, 'off', cwd); const obs = bash(c, 'observe', cwd);
    assert.equal(off.verdict, 'clear', `off: ${JSON.stringify(c)} → ${off.why}`);
    assert.equal(obs.verdict, 'clear', `observe must answer like off: ${JSON.stringify(c)} → ${obs.why}`);
  }
  // at enforce the same text in a program the rules cannot read is held, and the hold names the check
  // (the body has to name the checkout itself: a relative name inside an interpreter's program is slice 9's reading)
  const body = py(`print(open("${L}/.git/HEAD").read())`);
  const enf = bash(body, 'enforce', W); assert.equal(enf.verdict, 'gate', enf.why); assert.equal(enf.check, 'selfProtect');
  assert.equal(bash(body, 'off', W).verdict, 'clear'); assert.equal(bash(body, 'observe', W).verdict, 'clear'); assert.equal(bash(body, 'observe', W).wouldHold?.check, 'selfProtect');
});
