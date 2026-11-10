import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, DEFAULT_POLICY } from '../src/gates.mjs';

// #438: the fast path reads the whole line, so words from separate commands can line up into a bin
// rule's trigger. The classifier judges each command; only a command that really matches a rule gates.
const run = (command) => classify({ tool: 'Bash', command, cwd: '/work/app' }, DEFAULT_POLICY, { home: '/home/u' });

test('words from separate commands lining up are clear, and the reason says so', () => {
  for (const c of [
    'gh pr view 91 --json state && git merge --abort',
    'gh pr view 91 --json state; git merge origin/main --no-edit',
    `gh pr view 91 --json state | python3 -c "print('merge')"`,
    `gh pr list --json number && echo "ready to merge"`,
  ]) {
    const r = run(c);
    assert.equal(r.verdict, 'clear', c);
  }
  assert.match(run('gh pr view 91 --json state && git merge --abort').why, /separate commands/);
});

test('a real merge still gates, wherever it sits on the line and however it is written', () => {
  for (const c of [
    'gh pr merge 91',
    'cd /work/app && gh pr merge 91 --merge',
    'gh pr view 91 --json state && gh pr merge 91',
    'git status; gh pr merge 91; git status',
    'gh --repo acme/widget pr merge 91',
    'gh -R acme/widget --jq "a|b" pr merge 91',
    // gh takes a subcommand's flags before it too, and a flag's value then reads as a positional (#438)
    'gh --subject x pr merge 91',
    'gh --body hello --match-head-commit abc pr merge 91',
    'gh pr \\\n  merge 91',
    'gh "pr" merge 91',
    `gh pr 'mer'ge 91`,
    '(gh pr merge 91)',
    'true && (cd /work/app && gh pr merge 91)',
    'echo $(gh pr merge 91)',
    'echo `gh pr merge 91`',
    'bash -c "gh pr merge 91"',
    `sh -c 'git status; gh pr merge 91'`,
  ]) {
    const r = run(c);
    assert.equal(r.verdict, 'gate', c);
    assert.equal(r.cls, 'merge', c);
  }
});

test('what the parser cannot see stays held: it never turns into a clear', () => {
  for (const c of [
    'eval "gh pr merge 91"',
    'gh pr view 91 && eval "gh pr merge 91"',
    'X=gh; $X pr merge 91',
    'echo gh pr merge 91 | sh',
    'echo gh pr merge 91 | xargs -I{} sh -c {}',
    'cat <<EOF | sh\ngh pr merge 91\nEOF',
  ]) {
    assert.equal(run(c).verdict, 'gate', c);
  }
});

test('gh flags before or between the subcommand words: a real merge holds, a read stays clear', () => {
  assert.equal(run('gh --title x secret set TOKEN').cls, 'env');
  assert.equal(run('gh --yes x repo delete acme/widget').cls, 'delete');
  // MC's review of #94: a value flag BETWEEN the two words
  for (const [c, cls] of [
    ['gh pr --subject x merge 91', 'merge'],
    ['gh pr -R acme/widget --body b merge 91', 'merge'],
    ['gh pr -R acme/widget --jq .x merge 91', 'merge'],
    ['gh pr --body b --match-head-commit abc merge 91', 'merge'],
    ['gh pr --match-head-commit abc --merge merge 91', 'merge'],
    ['gh --subject x pr --body y merge 91', 'merge'],
    ['gh pr --subject=x merge 91', 'merge'],
    ['gh repo --yes delete acme/widget', 'delete'],
    ['gh secret --app actions set TOKEN', 'env'],
  ]) {
    const r = run(c);
    assert.equal(r.verdict, 'gate', c);
    assert.equal(r.cls, cls, c);
  }
  for (const c of ['gh pr view merge', 'gh pr view 91 --json state --jq .state', 'gh --json state pr view 91', 'gh pr list --search merge', 'gh issue list --search merge', 'gh pr view 91 --jq merge', 'gh pr checks 91 merge']) {
    assert.equal(run(c).verdict, 'clear', c);
  }
});

test('other bin rules behave the same way', () => {
  assert.equal(run('git log --oneline -1 && echo push').verdict, 'clear');
  assert.equal(run('launchctl list | grep bootstrap').verdict, 'clear');
  assert.equal(run('git status && git push origin main').cls, 'push');
  assert.equal(run('gh secret list && gh secret set X').cls, 'env');
});
