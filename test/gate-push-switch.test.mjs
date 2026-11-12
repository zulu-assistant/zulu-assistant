import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, branchSwitch, parseCommand, DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';

// #584: a push that goes through the current branch (no refspec, HEAD, @) was judged by the branch the folder stood
// on BEFORE the call, so `git switch main && git push origin` from a feature branch ran unasked (also in public 1.2.2).
// Now it is judged by the folder's branch AND every branch a switch in the same call names; nothing is ever removed
// from that set. A switch the gate cannot read is asked.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
const claudeInput = (command, cwd) => ({ session_id: 's', transcript_path: '/t/x.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } });
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
const git = (cwd, a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };

/** A private repository with main, feat-a and feat-b, a tag `rel`; the folder stands on `on`. */
async function repo(on) {
  const R = path.join(realpathSync(await mkdtemp(path.join(os.tmpdir(), 'push-switch-'))), 'app');
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'main', R); g('-C', R, 'remote', 'add', 'origin', 'https://github.com/acme/private-app.git');
  g('-C', R, 'commit', '-q', '--allow-empty', '-m', 'base'); g('-C', R, 'tag', 'rel');
  g('-C', R, 'branch', 'feat-a'); g('-C', R, 'branch', 'feat-b'); g('-C', R, 'switch', '-q', on);
  return R;
}
const read = (command, cwd) => {
  const i = hookInput(claudeInput(command, cwd), {});
  return classify({ tool: i.tool, command: i.command, cwd: i.cwd }, policy, { home: '/home/u', boardRoot: ROOT, git, repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']) });
};
const held = (v) => v.verdict === 'gate';
const HELD = /push to protected branch main|git push of the current branch after/;

test('B: a switch to a protected branch, then a push through the current branch, is held (every form of it)', async () => {
  const R = await repo('feat-a');
  for (const text of ['git switch main && git push origin', 'git checkout main && git push origin HEAD', 'git switch main && git push origin @',
    'git switch main && git push -u origin', 'git switch -q main && git push --set-upstream origin', 'git checkout -B main && git push origin',
    'git switch -C main && git push origin HEAD', 'git switch feat-b && git switch main && git push origin', `cd ${R} && git switch main && git push origin`,
    'git checkout main -- && git push origin', 'git checkout -q main -- && git push origin HEAD', 'git checkout -Bmain && git push origin',
    'git checkout -qB main && git push origin', 'git checkout main --quiet && git push origin', 'command git switch main && git push origin',
    '/usr/bin/git switch main && /usr/bin/git push origin', 'env git switch main && git push origin', 'git -c advice.detachedHead=false switch main && git push origin',
    'git switch main 2>&1 | tail -1; git push origin', '(git switch main && git push origin)', '{ git switch main; } && git push origin',
    'git switch main\ngit push origin', 'if git switch main; then git push origin; fi', 'git stash && git switch main && git stash pop && git push origin',
    'git checkout main; git merge feat-a; git push origin', 'bash -c "git switch main && git push origin"', 'sh -c "git switch main" && git push origin',
    'bash <<< "git switch main" && git push origin', 'git switch main && git pull --ff-only && git push origin',
    // the switch outside, the push inside a body handed to a shell
    'git switch main && bash -c "git push origin"', "git switch main && sh -c 'git push origin HEAD'", "git checkout main\nbash <<'EOF'\ngit push origin\nEOF",
    'git switch main && bash -lc "cd . && git push origin"', 'git switch main && bash <<< "git push origin"', 'git switch main && bash -c "bash -c \'git push origin\'"',
    // and command substitutions: out, in, both apart
    'git switch main && out=$(git push origin 2>&1)', 'out=$(git switch main 2>&1) && git push origin', 'out=$(git switch main 2>&1) && out=$(git push origin 2>&1)',
    'git switch main && out=`git push origin 2>&1`', 'out=`git switch main 2>&1` && git push origin', 'out=`git switch main 2>&1` && out=`git push origin 2>&1`',
    'git switch main && echo "$(git push origin 2>&1)"', 'echo "$(git switch main 2>&1)" && git push origin', 'echo "$(git switch main 2>&1)" && echo "$(git push origin 2>&1)"']) {
    const v = read(text, R);
    assert.ok(held(v), text); assert.match(v.why, HELD, text);
  }
});

test('only ever adds: on main, a switch away keeps main judged, whatever comes between', async () => {
  const R = await repo('main'); const X = await repo('main');
  for (const text of ['git switch feat-b && git push origin', 'git switch feat-b; git push origin', 'git switch feat-b || git push origin',
    '(git switch feat-b) && git push origin', `GIT_DIR=${X}/.git git switch feat-b && git push origin`, `git switch feat-b && GIT_DIR=${X}/.git git push origin`,
    'git() { command git "$@" || true; }; git switch feat-b && git push origin', 'alias git="git -C /nowhere"; git switch feat-b && git push origin',
    'git switch feat-b && ./x.sh && git push origin', 'git switch feat-b && echo "ref: refs/heads/main" > .git/HEAD && git push origin',
    'PATH=/tmp/evil:$PATH; git switch feat-b && git push origin', 'git switch -c feat && git push -u origin', 'git checkout -b feat && git add -A && git push -u origin HEAD',
    'git switch feat-b && git status && git push origin', 'git checkout no-such-branch && git push origin']) {
    const v = read(text, R);
    assert.ok(held(v), text); assert.match(v.why, HELD, text);
  }
  // a push that names its branch does not go through the current branch
  assert.equal(held(read('git switch -c feat && git push -u origin feat', R)), false);
});

test('a switch the gate cannot read is asked when the push goes through the current branch', async () => {
  const R = await repo('feat-a');
  git(R, ['config', 'alias.co', 'checkout']);
  for (const [text, what] of [['git switch - && git push origin', /git switch -/], ['git checkout @{-1} && git push origin', /git checkout @\{-1\}/],
    ['git switch --detach main && git push origin', /--detach/], ['git checkout --orphan x && git push origin', /--orphan/],
    ['git checkout $B && git push origin', /git checkout \$B/], ['git switch "feat-{a,b}" && git push origin', /git switch/],
    ['gh pr checkout 12 && git push origin', /gh pr checkout/], ['gh co 12 && git push origin', /gh pr checkout/], ['gh pr co 12 && git push origin', /gh pr checkout/],
    ['gh mine && git push origin', /gh mine/], ['git co main && git push origin', /git co \(a command the gate does not know/],
    ['git branch -m main && git push origin', /git branch -m/], ['git branch -fM main && git push origin', /git branch -m/],
    ['git branch --move --force main && git push origin', /git branch -m/], ['git branch --mov main && git push origin', /git branch --mov/],
    ['git branch --mo -f main && git push origin', /git branch --mo/], ['git switch -t origin/main && git push origin', /--track/],
    ['git checkout --track origin/main && git push origin HEAD', /--track/], ['git symbolic-ref HEAD refs/heads/main && git push origin', /symbolic-ref/],
    ['git bisect start && git push origin', /bisect/], ['git checkout 1234abcd && git push origin', /git checkout 1234abcd/],
    ['git checkout rel && git push origin', /checkout of rel, which is not a local branch/], ['git checkout --frobnicate main && git push origin', /--frobnicate/],
    ['git switch -x main && git push origin', /git switch -x/], ['git switch -Cmain && git push origin', /git push of the current branch after|protected branch main/]]) {
    const v = read(text, R);
    assert.ok(held(v), text); assert.match(v.why, what, text);
  }
  assert.equal(held(read('git switch - && git push origin feat-b', R)), false, 'a named branch does not go through the current one');
  // a new worktree: its folder does not exist when the gate reads it, so the current branch is unknown (asked)
  const v = read(`git worktree add -b feat ${R}-wt && cd ${R}-wt && git push origin`, R);
  assert.ok(held(v)); assert.match(v.why, /unknown current branch/);
});

test('stays unheld: feature-branch work that never visits a protected branch, and forms that are not switches', async () => {
  for (const [on, text] of [['main', 'git checkout -b feat && git push -u origin feat'], ['feat-a', 'git checkout -b feat && echo x && git push -u origin'],
    ['feat-a', 'git switch -c feat && git push -u origin'], ['feat-a', 'git switch -c feat && git push origin HEAD'], ['feat-a', 'git switch feat-b && git push origin'],
    ['feat-a', 'git switch feat-b && git push origin @'], ['feat-a', 'git switch main && git switch feat-a && git push origin feat-a'],
    ['feat-a', 'git checkout -- f && git push origin'], ['feat-a', 'git checkout main -- f && git push origin'], ['feat-a', 'git checkout main -- . && git push origin'],
    ['feat-a', 'git checkout main f && git push origin'], ['feat-a', 'git restore f && git push origin'], ['feat-a', 'git branch -d old && git push origin'],
    ['feat-a', 'git branch --list && git branch -vv && git push origin'], ['feat-a', 'git stage . && git commit -qm x && git push origin'],
    ['feat-a', 'gh pr view 12 && git push origin'], ['feat-a', 'git push origin'], ['feat-a', 'bash -c "git push origin"'], ['feat-a', 'git switch feat-b && bash -c "git push origin"'],
    ['feat-a', 'out=$(git push origin 2>&1)'], ['feat-a', 'out=$(git switch feat-b 2>&1) && git push origin']]) {
    const R = await repo(on);
    const v = read(text, R);
    assert.equal(held(v), false, `${on}: ${text} → ${v.why}`);
  }
});

test('push.default: upstream judges the upstream name too and asks after a branch change in the call; matching and a remote push refspec ask', async () => {
  const R = await repo('feat-a');
  git(R, ['config', 'branch.feat-a.remote', 'origin']); git(R, ['config', 'branch.feat-a.merge', 'refs/heads/main']);
  assert.equal(held(read('git push origin', R)), false, 'push.default unset: the same name');
  for (const mode of ['upstream', 'tracking']) {
    git(R, ['config', 'push.default', mode]);
    for (const text of ['git push origin', 'git push']) { const v = read(text, R); assert.ok(held(v), `${mode}: ${text}`); assert.match(v.why, /push to protected branch main/); }
  }
  const U = await repo('feat-b'); git(U, ['config', 'push.default', 'upstream']);
  for (const text of ['git branch -u origin/main && git push origin', 'git branch --set-upstream-to=origin/main && git push origin',
    'git switch -c new origin/main && git push origin', 'git checkout -b new origin/main && git push origin',
    'git pull --set-upstream origin main && git push origin', 'git fetch --set-upstream origin main && git push origin', 'git fetch --set-up origin main && git push origin']) {
    const v = read(text, U); assert.ok(held(v), text); assert.match(v.why, /push\.default upstream after a branch change in the same call/, text);
  }
  assert.equal(held(read('git switch -c new && git push -u origin new', U)), false, 'a named refspec is not moved by push.default');
  assert.equal(held(read('git pull --ff-only && git push origin', U)), false, 'a pull that sets no upstream changes nothing');
  assert.equal(held(read('git push origin feat-a', R)), false, 'a named refspec is not moved by push.default');
  const M = await repo('feat-a'); git(M, ['config', 'push.default', 'matching']);
  assert.match(read('git push origin', M).why, /push\.default matching/);
  const P = await repo('feat-a'); git(P, ['config', 'remote.origin.push', 'refs/heads/*:refs/heads/*']);
  assert.match(read('git push origin', P).why, /remote\.origin\.push set/);
  assert.equal(held(read('git push origin feat-a', P)), false, 'a named refspec is not widened by the remote setting');
});

test('what one command does to the current branch', () => {
  const one = (s) => branchSwitch(parseCommand(s).cmds[0]);
  assert.deepEqual(one('git switch main'), { branch: 'main', made: false });
  assert.deepEqual(one('git switch -c x'), { branch: 'x', made: true });
  assert.deepEqual(one('git switch --create=x'), { branch: 'x', made: true });
  assert.deepEqual(one('git checkout -B x origin/x'), { branch: 'x', made: true });
  assert.deepEqual(one('git checkout -Bx'), { branch: 'x', made: true });
  assert.deepEqual(one('git checkout main --'), { branch: 'main', made: false });
  assert.deepEqual(one('git stash branch x'), { branch: 'x', made: true });
  assert.deepEqual(one('git rebase main feat'), { branch: 'feat', made: false });
  assert.deepEqual(one('git branch -u origin/main'), { upstream: 'git branch -u' });
  assert.deepEqual(one('git branch --set-upstream-to origin/main'), { upstream: 'git branch -u' });
  for (const s of ['git checkout -- f', 'git checkout HEAD~1 -- f', 'git checkout -p', 'git restore f', 'git rebase main', 'git branch x', 'git branch -D x', 'git branch -c a b',
    'git branch --unset-upstream', 'git symbolic-ref HEAD', 'git checkout', 'git status', 'git stage .', 'git pack-refs --all'])
    assert.equal(one(s), null, s);
});

test('the real hook script, board down: the same answers as the board for B and for feature work', async () => {
  const onFeat = await repo('feat-a');
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', CMUX_AGENT_LAUNCH_KIND: '' };
  const run = (obj) => { const o = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify(obj), env, encoding: 'utf8', timeout: 30_000 }); return o.stdout ? JSON.parse(o.stdout).hookSpecificOutput.permissionDecision : 'pass'; };
  assert.equal(run(claudeInput('git switch main && git push origin', onFeat)), 'deny');
  assert.equal(run(claudeInput('git checkout main && git push origin HEAD', onFeat)), 'deny');
  // a pass needs every git read inside the hook's one-second limit; a loaded machine may hold it once (#565): three tries
  const tries = [];
  while (tries.length < 3 && tries.at(-1) !== 'pass') tries.push(run(claudeInput('git switch -c feat && git push -u origin', onFeat)));
  assert.equal(tries.at(-1), 'pass', `feature work never passed: ${tries.join(', ')}`);
});
