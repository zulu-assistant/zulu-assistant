import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, rootedMatch, DEFAULT_POLICY } from '../src/gates.mjs';

// #436: the self class guards the policy files in every checkout of the board's repo, not only the live one.
const LISTING = 'worktree /work/board\nHEAD abc\nbranch refs/heads/main\n\nworktree /work/wt-7\nHEAD def\nbranch refs/heads/task/7\n';
const gitCalls = [];
const ctx = (over = {}) => ({ home: '/home/u', boardRoot: '/work/board', git: (cwd, args) => { gitCalls.push(args.join(' ')); return args[0] === 'worktree' ? LISTING : null; }, ...over });
const edit = (filePath, c = ctx()) => classify({ tool: 'Edit', filePath, cwd: '/work/wt-7', command: '' }, DEFAULT_POLICY, c);
const bash = (command, cwd = '/work/wt-7', c = ctx()) => classify({ tool: 'Bash', command, cwd }, DEFAULT_POLICY, c);

test('editing a policy file in a worktree of the repo is the self class, as in the live checkout', () => {
  for (const f of ['/work/wt-7/overlay/policy.json', '/work/wt-7/examples/policy.json', '/work/wt-7/policy.json', '/work/board/overlay/policy.json']) {
    const r = edit(f);
    assert.equal(r.verdict, 'gate', f);
    assert.equal(r.cls, 'self', f);
  }
});

test('a shell write to it gates too; reading it does not', () => {
  for (const c of ['cp /tmp/p.json overlay/policy.json', 'echo x > overlay/policy.json', 'sed -i "" s/a/b/ examples/policy.json']) {
    const r = bash(c);
    assert.equal(r.verdict, 'gate', c);
    assert.equal(r.cls, 'self', c);
  }
  for (const c of ['cat overlay/policy.json', 'grep -n upgrade examples/policy.json']) assert.equal(bash(c).verdict, 'clear', c);
});

test('the same names outside the repo stay clear, other files never ask git, and a git failure changes nothing for the live path', () => {
  assert.equal(edit('/elsewhere/overlay/policy.json').verdict, 'clear', 'not a checkout of this repo');
  gitCalls.length = 0;
  assert.equal(edit('/work/wt-7/src/app.mjs').verdict, 'clear');
  assert.equal(gitCalls.filter((c) => c.startsWith('worktree')).length, 0, 'no git call for an ordinary file');
  const noGit = ctx({ git: () => null });
  assert.equal(edit('/work/board/overlay/policy.json', noGit).cls, 'self');
  assert.equal(rootedMatch('<repo>/overlay/policy.json', '/work/wt-7/overlay/policy.json', ctx({ git: () => null })), false);
});

test('the listing is read once per check, and ~/ paths are untouched by it', () => {
  gitCalls.length = 0;
  const c = ctx();
  rootedMatch('<repo>/overlay/policy.json', '/work/wt-7/overlay/policy.json', c);
  rootedMatch('<repo>/policy.json', '/work/wt-7/policy.json', c);
  assert.equal(gitCalls.filter((x) => x.startsWith('worktree')).length, 1);
  assert.equal(rootedMatch('~/.claude/settings.json', '/home/u/.claude/settings.json', ctx()), true);
  assert.equal(rootedMatch('~/.claude/settings.json', '/work/wt-7/.claude/settings.json', ctx()), false);
});
