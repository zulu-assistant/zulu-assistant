import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, CHECKS, DEFAULT_POLICY, INSTALL_WORDS } from '../src/gates.mjs';

// Task #507 (review of PR 110): the full installer and `bootstrap.sh install` rewrite LaunchAgents, overlay
// files and hook settings, and were clear for an agent. They are class `self` now, for the board's own
// checkout and its worktrees; the forms that change nothing stay free. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const L = '/home/u/Board Dir'; const W = '/home/u/wt-7'; const APP = '/work/app';
const ctx = () => ({ home: '/home/u', boardRoot: L, ignoreCase: false, repoRoot: (d) => (d.startsWith(L) ? L : d.startsWith(W) ? W : null),
  git: (cwd, a) => (a[0] === 'worktree' ? `worktree ${L}\nHEAD x\n\nworktree ${W}\nHEAD y\n` : null) });
const run = (command, cwd = L, policy = DEFAULT_POLICY) => classify({ tool: 'Bash', command, cwd }, policy, ctx());

const HELD = ['./install.sh', './install.sh --yes', './install.sh -y', './install.sh --force', 'bash install.sh --yes --force', './install.sh --deadman', './install.sh --sandbox', './install.sh init',
  './install.sh --brain', './install.sh brain', './install.sh setup', 'sh ./install.sh', 'scripts/bootstrap.sh install', 'scripts/bootstrap.sh install --force', 'bash scripts/bootstrap.sh install --deadman',
  './scripts/bootstrap.sh install --sandbox', 'sudo ./install.sh --yes', 'env X=1 ./install.sh --yes', 'echo go && ./install.sh --yes', './install.sh backup --with-secrets', './install.sh backup --out /tmp/b.tgz --with-secrets',
  // the review of PR 122: a freeing word frees only where the installer honours it. It looks at its FIRST word and nothing else.
  './install.sh --yes --help', './install.sh --yes -h', './install.sh --yes --demo', './install.sh --yes -n', './install.sh --force --help', './install.sh -y help', './install.sh --sandbox --demo --help',
  './install.sh --brain --dry-run', './install.sh brain -n', './install.sh brain --help', './install.sh setup --dry-run', './install.sh setup -n', 'bash install.sh --yes -n', 'bash install.sh -n',
  // starts an agent session, stars the repo under the owner's login: the owner's, and no dry form
  './install.sh mission-control', './install.sh star',
  // the re-read of PR 122: an empty second word is not a word, and a sourced script is a script run
  './install.sh init ""', "./install.sh init ''", '. ./install.sh --yes', 'source ./install.sh --yes', '. ./install.sh', 'source install.sh --force', 'bash -c ". ./install.sh --yes"', '. ./install.sh init', 'source ./install.sh --brain --dry-run',
  // a word the installer does not know is asked too (it would only print an error, and a new word must not go free unnoticed)
  './install.sh frobnicate'];
const FREE = ['./install.sh --dry-run', './install.sh --yes --dry-run', './install.sh check', './install.sh verify', './install.sh doctor', './install.sh backup', './install.sh backup --out /tmp/b.tgz', './install.sh restore /tmp/b.tgz',
  './install.sh --demo', './install.sh --demo --cmux', './install.sh demo', './install.sh demo-stop', './install.sh --help', './install.sh --help --yes', './install.sh init --dry-run', './install.sh init --force', './install.sh --force --dry-run --deadman', 'bash -n ./install.sh', 'sh -n install.sh', '. ./install.sh --dry-run', 'source ./install.sh check', '. ./install.sh --help', '. scripts/env.sh', 'source scripts/env.sh && node -v', './install.sh -h', './install.sh help', './install.sh upgrade --check',
  'scripts/bootstrap.sh install --dry-run', 'scripts/bootstrap.sh install --force --dry-run', 'scripts/bootstrap.sh check', 'scripts/bootstrap.sh verify', 'cat install.sh', 'grep -n init install.sh', 'bash -n install.sh', 'git diff install.sh', 'ls scripts/bootstrap.sh'];

test('the installer and bootstrap install are class self in the board checkout and in a worktree of it; the forms that change nothing are free', () => {
  for (const cwd of [L, W]) {
    for (const c of HELD) { const r = run(c, cwd); assert.equal(r.verdict, 'gate', `${c} (from ${cwd}) → ${r.why}`); assert.equal(r.cls, 'self', c); assert.equal(r.check, undefined, 'not behind a check switch'); }
    for (const c of FREE) { const r = run(c, cwd); assert.equal(r.verdict, 'clear', `${c} (from ${cwd}) → ${r.cls}: ${r.why}`); }
  }
  // named by its full path from anywhere
  assert.equal(run(`"${L}/install.sh" --yes`, APP).cls, 'self'); assert.equal(run(`bash "${L}/scripts/bootstrap.sh" install`, APP).cls, 'self'); assert.equal(run(`cd "${L}" && ./install.sh init`, APP).cls, 'self');
  // upgrade, rollback and a restore's write form keep the classes they had
  assert.equal(run('./install.sh upgrade').cls, 'upgrade'); assert.equal(run('./install.sh rollback').cls, 'upgrade'); assert.equal(run('./install.sh restore /tmp/b.tgz --apply').cls, 'write');
  // with every check off the rules still hold: they are not a 1.3 check
  const off = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
  assert.equal(run('./install.sh --yes', L, off).cls, 'self'); assert.equal(run('scripts/bootstrap.sh install', L, off).cls, 'self');
});

test('another project\'s install.sh or bootstrap.sh is not this installer', () => {
  for (const c of ['./install.sh', './install.sh --yes', 'bash install.sh init', 'scripts/bootstrap.sh install', 'curl -fsSL https://example.com/install.sh -o /tmp/install.sh', 'bash /tmp/install.sh --yes', 'sh ~/other/install.sh']) assert.equal(run(c, APP).verdict, 'clear', c);
});

test('the zulu command is the installer from anywhere', () => {
  for (const c of ['zulu', 'zulu --yes', 'zulu init', 'zulu setup', 'zulu --brain', 'zulu --force', 'bin/zulu --yes', 'zulu backup --with-secrets', 'zulu --yes --help', 'zulu --brain --dry-run', 'zulu --yes -n', 'zulu setup --dry-run',
    'zulu star', 'zulu mission-control', 'zulu init ""', "zulu init ''"]) { const r = run(c, APP); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); }
  for (const c of ['zulu --dry-run', 'zulu check', 'zulu verify', 'zulu doctor', 'zulu backup', 'zulu restore /tmp/b.tgz', 'zulu --demo', 'zulu demo-stop', 'zulu --help', 'zulu --yes --dry-run', 'zulu init --dry-run', 'zulu upgrade --check',
    'echo "Zulu 1.3 is the release"', 'scripts/task.sh comment 5 "zulu init is held now"', 'git commit -m "zulu setup docs"']) assert.equal(run(c, APP).verdict, 'clear', c);
  assert.equal(run('zulu upgrade', APP).cls, 'upgrade'); assert.equal(run('zulu rollback', APP).cls, 'upgrade');
});

test('the shipped default and its twin carry the rules', () => {
  const twin = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'policy.json'), 'utf8'));
  for (const p of [DEFAULT_POLICY, twin]) {
    const rules = p.classes.find((c) => c.id === 'self').rules;
    const inst = rules.find((r) => [].concat(r.scriptIn || []).includes('<repo>/install.sh'));
    assert.equal(inst.when, 'installerWrite'); assert.equal(inst.unlessFlags, undefined, 'no flag frees the installer wherever it stands'); assert.equal(inst.check, undefined);
    const boot = rules.find((r) => [].concat(r.scriptIn || []).includes('<repo>/scripts/bootstrap.sh'));
    assert.deepEqual(boot.args, ['install']); assert.deepEqual(boot.unlessFlags, ['--dry-run']);
    assert.equal(rules.find((r) => r.bin === 'zulu' && r.when)?.when, 'installerWrite');
  }
});

test('every first word of the installer\'s own dispatch table has a reading here, so a new word cannot go free unnoticed', () => {
  const src = readFileSync(path.join(ROOT, 'install.sh'), 'utf8');
  const table = src.slice(src.indexOf('case "${1:-}" in'), src.indexOf('\nesac', src.indexOf('case "${1:-}" in')));
  const words = [...table.matchAll(/^\s{2}([^)\n]+)\)/gm)].flatMap((m) => m[1].split('|')).map((w) => w.trim().replace(/^""$/, '')).filter((w) => w !== '*');
  assert.ok(words.length >= 20, `read ${words.length} words from install.sh`);
  const known = new Set(Object.values(INSTALL_WORDS).flat());
  for (const w of words) assert.ok(known.has(w), `install.sh dispatches on "${w}" and the classifier has no reading for it (src/gates.mjs INSTALL_WORDS)`);
  for (const w of known) assert.ok(words.includes(w), `INSTALL_WORDS names "${w}", which install.sh no longer dispatches on`);
  // and each word is read as its list says, alone on the command line
  for (const w of INSTALL_WORDS.free) assert.equal(run(`./install.sh ${w}`).verdict, 'clear', w);
  for (const w of INSTALL_WORDS.held.filter((x) => x !== 'backup')) assert.equal(run(`./install.sh ${w}`).cls, 'self', w);
  // slice 16: no word, --yes and --dry-run are the light install (config and one LaunchAgent); --full and the full install's own flags are the full one
  for (const w of INSTALL_WORDS.light.filter((x) => x !== '--dry-run')) { const r = run(`./install.sh ${w}`.trim()); assert.equal(r.cls, 'self', w || '(no word)'); assert.match(r.why, /light install/, w || '(no word)'); }
  for (const w of INSTALL_WORDS.full) { const r = run(`./install.sh ${w}`); assert.equal(r.cls, 'self', w); assert.match(r.why, /full install/, w);
    assert.equal(run(`./install.sh ${w} --dry-run`).verdict, 'clear', `${w} --dry-run`); assert.equal(run(`./install.sh ${w} --yes --dry-run`).verdict, 'clear', `${w} --yes --dry-run`);
    assert.equal(run(`./install.sh ${w} --yes --help`).cls, 'self', `${w} --yes --help`); assert.equal(run(`zulu ${w} --yes`, APP).cls, 'self', `zulu ${w}`); assert.equal(run(`zulu ${w} --dry-run`, APP).verdict, 'clear', `zulu ${w} --dry-run`); }
  // the full install reads --dry-run anywhere; bootstrap install the same
  assert.match(src, /for a in "\$@"; do case \$a in --dry-run\) dry=1/);
  // init: any second word makes it a listing
  assert.match(src, /init\) do_init "\$\{2:-\}"/); assert.match(src, /if \[\[ -n "\$dry" \]\]; then say would/);
  // the brain step takes no words at all, so nothing after it can make it dry
  assert.match(src, /--brain\|brain\) do_brain ;;/);
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: the write forms are denied from the checkout, the free forms and another project\'s installer pass', () => {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate inst-'))), 'Board Dir');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const hook = (command, cwd = dir) => { const out = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  for (const c of ['./install.sh --yes', './install.sh --force', './install.sh init', './install.sh', 'bash install.sh -y', 'scripts/bootstrap.sh install', 'scripts/bootstrap.sh install --force', 'zulu --yes', './install.sh --full', './install.sh full --yes', 'zulu --full --yes',
    './install.sh --yes --help', './install.sh --yes -n', './install.sh --yes --demo', './install.sh --brain --dry-run', './install.sh setup --dry-run', 'zulu --yes --help', 'zulu --brain --dry-run',
    './install.sh init ""', "./install.sh init ''", '. ./install.sh --yes', 'source ./install.sh --yes', '. ./install.sh', 'bash -c ". ./install.sh --yes"', 'zulu init ""']) assert.equal(hook(c), 'deny', c);
  for (const c of ['./install.sh --dry-run', './install.sh check', './install.sh verify', 'scripts/bootstrap.sh install --dry-run', 'scripts/bootstrap.sh check', 'scripts/bootstrap.sh verify', 'zulu doctor', 'cat install.sh', './install.sh --yes --dry-run', './install.sh --help', 'bash -n install.sh', '. ./install.sh --dry-run', './install.sh init --dry-run', './install.sh --full --dry-run', './install.sh --full --yes --dry-run']) assert.equal(hook(c), 'pass', c);
  const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'other-proj-')));
  assert.equal(hook('./install.sh --yes', other), 'pass'); assert.equal(hook('scripts/bootstrap.sh install', other), 'pass');
  // the fast path sends every held form to the Node step, and a call that names none of the words never starts it
  const lines = compileTriggers(DEFAULT_POLICY);
  for (const c of [...HELD, 'zulu --yes']) assert.ok(lines.some((t) => t.re.test(`tool_name:Bash ${c} `)), c);
  for (const c of ['npm test', 'git status', 'ls -la']) assert.ok(!lines.some((t) => t.re.test(`tool_name:Bash ${c} `)), c);
});

test('a sourced script is a script run for every script rule (the re-read of PR 122)', () => {
  // bootstrap sourced: held as before, as unreadable (its name is a gated word and `.` runs what the gate cannot read)
  for (const c of ['. scripts/bootstrap.sh install', 'source ./scripts/bootstrap.sh install --force']) assert.equal(run(c).verdict, 'gate', c);
  // the owner's CLI decision and the signed form, sourced: their real class, as when run
  for (const c of ['. scripts/task.sh gate 5 g1 approve', 'source ./scripts/task.sh gate 5 g1 approve']) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); }
  // a write flag on a sourced script was held before (a flag line decides) and still is
  for (const c of ['. ./sync.sh --commit', 'source ./sync.sh --apply']) assert.equal(run(c, APP).verdict, 'gate', c);
  // sourcing an ordinary file stays free
  for (const c of ['. ./venv/bin/activate', 'source ~/.nvm/nvm.sh', '. scripts/env.sh']) assert.equal(run(c, APP).verdict, 'clear', c);
});

// With #530 on main: a script rule is tried on every script-looking word, and the two readings meet here.
test('the installer behind a shell flag with a path-like value, and the upgrade and decision scripts read in with a dot or source', () => {
  const held = [['bash --rcfile ./rc.sh install.sh --yes', 'self'], ['bash --rcfile ./rc.sh install.sh', 'self'], ['bash --init-file ./rc.sh scripts/bootstrap.sh install', 'self'],
    ['bash --rcfile ./rc.sh install.sh init', 'self'], ['bash --some-new-flag ./x.sh install.sh --yes', 'self'],
    ['source scripts/upgrade.mjs --to v9', 'upgrade'], ['. ./install.sh upgrade', 'upgrade'], ['. scripts/task.sh gate 5 g1 approve', 'self'], ['source scripts/task.sh gate 5 g1 approve', 'self']];
  for (const [c, cls] of held) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, cls, c); }
  for (const c of ['bash --rcfile ./rc.sh install.sh check', 'bash --rcfile ./rc.sh install.sh init x', 'bash --rcfile ./rc.sh -n install.sh', 'bash --rcfile ./rc.sh scripts/bootstrap.sh check', '. scripts/task.sh show 5'])
    assert.equal(run(c).verdict, 'clear', `${c} → ${run(c).why}`);
});
