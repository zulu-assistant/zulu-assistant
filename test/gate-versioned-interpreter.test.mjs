import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, parseCommand, isScript, scriptPath, progName, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// The interpreter and shell sets were exact names, so `python3.13`,
// `pypy3`, `node22`, `nodejs`, `ruby3.3`, `perl5.36`, `php8.3`, `bash5` and `ksh93` were not read as what they are.
// A write form run by one passed, a program text handed to one passed, and by absolute path the row was bound to
// the interpreter instead of the script. Now one reading of the name (progName) is used wherever the sets are
// asked. Each case is judged with the plain name and the versioned one: the answers must agree. Never run.
const APP = '/work/board';
const ctx = () => ({ home: '/home/u', boardRoot: APP, ignoreCase: false, repoRoot: () => null, git: () => null });
const shipped = structuredClone(DEFAULT_POLICY);
const allOn = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'enforce'])) };
const run = (command, policy = shipped) => classify({ tool: 'Bash', command, cwd: APP }, policy, ctx());
const said = (r) => (r.verdict === 'clear' ? 'clear' : `${r.verdict}:${r.cls}${r.opaque ? ':opaque' : ''}`);
const firstCmd = (command) => parseCommand(command).cmds.find((c) => c.bin);

test('progName: a versioned or packaged interpreter or shell name reads as the plain one; other names are kept', () => {
  const plain = {
    python3: ['python3.13', 'python3.12', 'python3.9', 'python3.14', 'pypy3', 'pypy3.10', 'python3.13t', 'python3.13d', 'python3-intel64',
      'python3.13-intel64', 'pythonw', 'pythonw3.13', 'ipython', 'ipython3'],
    python: ['python2', 'python2.7', 'pypy'],
    node: ['node22', 'node20.11', 'nodejs'], ruby: ['ruby3.3'], perl: ['perl5.36', 'perl5.34'], php: ['php8.3', 'php82'],
    bash: ['bash5', 'bash5.2', 'bash-5.2'], ksh: ['ksh93'], zsh: ['zsh5.9', 'zsh-5.9'],
  };
  for (const [want, names] of Object.entries(plain)) for (const n of names) assert.equal(progName(n), want, n);
  for (const n of ['python3', 'node', 'bash', 'sh', 'dash', 'osascript', 'deno', 'bun', 'tsx', 'csh', 'tcsh']) assert.equal(progName(n), n, n);
  for (const n of ['python3-config', 'python-config', 'nodemon', 'node-gyp', 'bashcov', 'shasum', 'php-fpm', 'phpunit', 'perldoc', 'rubocop', 'gh', 'ksh-x', 'zsh-x', null, undefined]) assert.equal(progName(n), n, String(n));
});

// [plain form, versioned forms]: each plain form is held by the shipped rules, and every versioned form must be held the same way
const PAIRS = [
  ['python3 tools/apply.py --commit', ['python3.13 tools/apply.py --commit', 'pypy3 tools/apply.py --commit', '/opt/homebrew/opt/python@3.13/bin/python3.13 -I tools/apply.py --commit']],
  ['python tools/apply.py --commit', ['python2.7 tools/apply.py --commit']],
  ['node tools/apply.mjs --commit', ['node22 tools/apply.mjs --commit', 'nodejs tools/apply.mjs --commit']],
  ['ruby tools/apply.rb --commit', ['ruby3.3 tools/apply.rb --commit']],
  ['perl tools/apply.pl --commit', ['perl5.36 tools/apply.pl --commit']],
  ['php tools/apply.php --commit', ['php8.3 tools/apply.php --commit']],
  ['bash tools/apply.sh --commit', ['bash5 tools/apply.sh --commit', 'ksh93 tools/apply.sh --commit']],
  // a program text handed to the interpreter, with a held action in it (heredoc and here-string)
  ['python3 - <<\'EOF\'\nimport os; os.system("gh pr merge 5")\nEOF', ['python3.13 - <<\'EOF\'\nimport os; os.system("gh pr merge 5")\nEOF', 'pypy3 - <<\'EOF\'\nimport os; os.system("gh pr merge 5")\nEOF']],
  ['python3 <<< \'import os; os.system("gh pr merge 5")\'', ['python3.12 <<< \'import os; os.system("gh pr merge 5")\'']],
  ['node <<\'EOF\'\nrequire("child_process").execSync("git push origin main")\nEOF', ['node22 <<\'EOF\'\nrequire("child_process").execSync("git push origin main")\nEOF']],
  // a shell's own text: -c, a heredoc
  ['bash -c "gh pr merge 5"', ['bash5 -c "gh pr merge 5"', 'ksh93 -c "gh pr merge 5"', 'zsh-5.9 -c "gh pr merge 5"']],
  // the shells on neither list until #612: csh and tcsh ship with macOS
  ['bash -c "git push origin main"', ['tcsh -c "git push origin main"', 'csh -c "git push origin main"', 'ash -c "git push origin main"', 'mksh -c "git push origin main"', 'rbash -c "git push origin main"']],
  ['bash <<\'EOF\'\ngh pr merge 5\nEOF', ['bash5 <<\'EOF\'\ngh pr merge 5\nEOF', 'tcsh <<\'EOF\'\ngh pr merge 5\nEOF']],
  // a guarded script under a shell (the installer's guardrails word, shipped rule)
  ['bash install.sh --guardrails', ['bash5 install.sh --guardrails', 'ksh93 install.sh --guardrails', 'tcsh install.sh --guardrails']],
  // python's further names: build letters, the -intel64 build, the window-less one, IPython
  ['python3 tools/apply.py --commit', ['python3.13t tools/apply.py --commit', 'python3-intel64 tools/apply.py --commit', 'pythonw tools/apply.py --commit', 'ipython3 tools/apply.py --commit']],
  ['python3 - <<\'EOF\'\nimport os; os.system("gh pr merge 5")\nEOF', ['pythonw - <<\'EOF\'\nimport os; os.system("gh pr merge 5")\nEOF', 'python3.13t - <<\'EOF\'\nimport os; os.system("gh pr merge 5")\nEOF']],
  // a script on the interpreter's input
  ['python3 - --commit < tools/apply.py', ['python3.13 - --commit < tools/apply.py']],
];

test('a versioned interpreter or shell is held as the plain name is (shipped rules)', () => {
  for (const [plain, versioned] of PAIRS) {
    const want = said(run(plain));
    assert.notEqual(want, 'clear', `the plain form is held: ${plain}`);
    for (const v of versioned) assert.equal(said(run(v)), want, v);
  }
});

test('with every check at enforce the answers still agree', () => {
  for (const [plain, versioned] of PAIRS) {
    const want = said(run(plain, allOn));
    for (const v of versioned) assert.equal(said(run(v, allOn)), want, v);
  }
});

test('the row is bound to the script, not to the interpreter file', () => {
  for (const [command, script] of [
    ['/opt/homebrew/opt/python@3.13/bin/python3.13 -I tools/apply.py --commit', 'tools/apply.py'],
    ['python3.13 -X importtime tools/apply.py --commit', 'tools/apply.py'],
    ['/usr/local/bin/node22 --import ./pre.mjs tools/apply.mjs --commit', 'tools/apply.mjs'],
    ['bash5 --rcfile ./rc.sh tools/apply.sh --commit', 'tools/apply.sh'],
  ]) {
    const c = firstCmd(command);
    assert.equal(isScript(c), true, command);
    assert.equal(scriptPath(c), script, command);
  }
});

// A versioned name was an unknown program before, and `renamedBins` at enforce read it so. Only the names literally on
// the two lists skip that reading, so the fix frees nothing (adds holds only).
test('a versioned name keeps the unknown program\'s reading at enforce (nothing is freed)', () => {
  for (const n of ['python3.13', 'pypy3', 'node22', 'nodejs', 'ruby3.3', 'perl5.34', 'php8.3', 'tcsh']) {
    assert.notEqual(said(run(`${n} pr merge 5`, allOn)), 'clear', n);
  }
});

// A ruled program that is itself a script (vercel and shopify are node scripts, bin/zulu is a bash script), handed to
// an interpreter or a shell by its file, was clear everywhere. It is now also read as that program by the `bin` rules.
test('a ruled program handed to its interpreter or a shell by its file is held as the program is', () => {
  for (const [plain, through] of [
    ['vercel deploy --prod', ['node /opt/homebrew/bin/vercel deploy --prod', 'node node_modules/.bin/vercel deploy --prod', 'node22 /opt/homebrew/bin/vercel --prod']],
    ['zulu upgrade', ['bash bin/zulu upgrade', 'sh /opt/zulu/bin/zulu upgrade', 'bash zulu upgrade', 'bash -x zulu upgrade', 'bash -- zulu upgrade', 'bash5 ./bin/zulu upgrade --to v9', '. bin/zulu upgrade', 'source ./bin/zulu upgrade']],
    ['zulu rollback', ['sh bin/zulu rollback', 'tcsh bin/zulu rollback']],
    ['zulu guardrails', ['bash bin/zulu guardrails', 'zsh ./bin/zulu guardrails']],
    ['crontab -r', ['bash /usr/bin/crontab -r']],
  ]) {
    const want = said(run(plain));
    assert.notEqual(want, 'clear', plain);
    for (const t of through) { assert.equal(said(run(t)), want, t); assert.equal(said(run(t, allOn)), want, `${t} (all checks)`); }
  }
  // on the input: a pipe into `bash -s -- upgrade` (`bash -s upgrade < bin/zulu` is not routed by this release's trigger lines)
  assert.notEqual(said(run('cat bin/zulu | bash -s -- upgrade')), 'clear', 'cat | bash -s -- upgrade');
  // a flag-looking word after the script is the script's own word: held as the plain program with the same words.
  // A shell's syntax check of the program's file is held too: no exemption (a flag's value, `-n +n`, defeated each
  // reading of one); a held syntax check is the cheaper error.
  for (const [through, plain] of [['sh bin/zulu upgrade -n', 'zulu upgrade -n'], ['zsh ./bin/zulu guardrails -n', 'zulu guardrails -n'],
    ['bash bin/zulu rollback -version', 'zulu rollback -version'], ['bash bin/zulu upgrade --to v9 -n', 'zulu upgrade --to v9 -n'],
    ['bash -x bin/zulu upgrade -xn', 'zulu upgrade -xn'], ['bash -- bin/zulu upgrade -n', 'zulu upgrade -n']]) {
    assert.notEqual(said(run(plain)), 'clear', plain);
    assert.equal(said(run(through)), said(run(plain)), through);
  }
  for (const held of ['bash -n bin/zulu upgrade', 'bash --rcfile -n bin/zulu upgrade', 'bash -O -n bin/zulu upgrade', 'bash -o -n bin/zulu rollback', 'bash -n +n bin/zulu upgrade', 'bash --init-file -n bin/zulu guardrails']) {
    assert.notEqual(said(run(held)), 'clear', held);
  }
  for (const free of ['bash bin/zulu guardrails --dry-run', 'node /opt/homebrew/bin/vercel --version', 'bash scripts/build.sh', 'bash -c "echo zulu"', 'python3 -m zulu']) {
    assert.equal(said(run(free)), 'clear', free);
  }
});

test('what was clear with the plain name stays clear with the versioned one', () => {
  for (const [plain, versioned] of [
    ['python3 tools/report.py', ['python3.13 tools/report.py', 'pypy3 tools/report.py']],
    ['node --version', ['node22 --version', 'nodejs --version']],
    ['python3 -c "print(1)"', ['python3.13 -c "print(1)"']],
    ['bash -c "ls -la"', ['bash5 -c "ls -la"']],
    ['python3 - <<\'EOF\'\nprint("hello")\nEOF', ['python3.13 - <<\'EOF\'\nprint("hello")\nEOF']],
  ]) {
    assert.equal(said(run(plain)), 'clear', plain);
    for (const v of versioned) assert.equal(said(run(v)), 'clear', v);
  }
});
