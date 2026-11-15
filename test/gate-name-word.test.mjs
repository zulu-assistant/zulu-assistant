import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Task #571: a rule on the installer program made a fast-path line that is the program's bare name, and the name is
// the product's own. It stands in folder names, note titles and report text, and every such call went to the board,
// where a program in a heredoc that held the name, or a variable whose value held it, was held as unreadable (dozens of
// calls in a week on one install; none of them a run of the program). The three rules now say
// `nameIsWord`: their lines only route the call to the rule. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const L = '/home/u/Board Dir'; const APP = '/srv/work';
const ctx = (extra = {}) => ({ home: '/home/u', boardRoot: L, ignoreCase: true, repoRoot: () => null, git: () => null, ...extra });
const run = (command, policy = DEFAULT_POLICY, extra = {}) => classify({ tool: 'Bash', command, cwd: APP }, policy, ctx(extra));
const ALL_ON = Object.fromEntries(CHECKS.map((n) => [n, 'enforce']));
const lineOf = (t) => /(^|[^a-z])zulu/.test(t.ere);

// the product's name where it is no call: a folder, a note's title, a report line, a variable's value, a program's text
const MENTIONS = [
  'cd "/srv/Zulu Assistant" && ls',
  'grep -rn "Zulu" docs | head',
  'F="Notes/Zulu Board Notes.md" && grep -c x "$F"',
  'V="/v/Zulu Assistant/Zulu Assistant Setup.md"; ls -la "$V"',
  'T="/srv/app/scripts/task.sh"; "$T" close 5 --vault "Notes/Zulu Board Notes.md" "done"',
  'INST="/t/home/zulu assistant"; cd "$INST" && HOME=/t/home ./check.sh',
  'S=/tmp/s; T=$S/up; INST="$T/home/zulu assistant"; git -C "$INST" status',
  "cd /srv/app && python3 - <<'EOF'\nopen('notes.md','a').write('Zulu Assistant 1.3\\n')\nEOF",
  "python3 - <<'EOF'\nprint('Zulu Assistant guardrails notes')\nEOF",
  "node - <<'EOF'\nconsole.log('zulu guardrails is the short install')\nEOF",
  'N="zulu guardrails"; echo "$N"',
];
// every run of the program the rules read: plainly, behind a wrapper, by its path, inside a shell's own text
const RUNS = ['zulu init', 'zulu', 'zulu setup', 'zulu --yes', 'zulu --full', 'zulu --guardrails', 'zulu guardrails --yes', 'ZULU init', 'env X=1 zulu init', 'sudo zulu init',
  'timeout 5 zulu setup', 'nohup zulu init &', './bin/zulu init', '/opt/z/bin/zulu setup', 'cd /srv/app && bin/zulu --brain', 'bash -c "zulu init"', "sh -c 'cd /x && zulu setup'",
  'if true; then zulu init; fi', "bash <<'EOF'\nzulu init\nEOF", 'echo "Zulu Assistant" && zulu init'];
// the program behind a name: held as unreadable, as it was while the line decided
const HIDDEN = [
  ['Z=zulu; $Z init', /behind the variable in program position/], ['Z=bin/zulu; "$Z" init', /behind the variable/], ['Z=/x/bin/zulu && $Z --guardrails', /behind the variable/],
  ['Z="zulu init"; $Z', /behind the variable/], ['Z=zulu; ${Z} guardrails', /behind the variable/], ['D=/x/bin; $D/zulu init', /behind the variable/], ['D=/x/bin; N=zulu; $D/$N init', /behind the variable/],
  // any value the call gives the name counts, not the last one
  ['Z=task.sh; Z=zulu; $Z init', /behind the variable/], ['Z=zulu; Z=task.sh; $Z init', /behind the variable/], ['Z=zulu; (Z=task.sh); $Z init', /behind the variable/],
  // a name the call gives no fixed text
  ['Z=zulu; Y=$Z; $Y init', /a variable or substitution stands in program position/], ['Z=zulu; $(echo $Z) init', /a variable or substitution stands in program position/],
  // words that run their text
  ['X="zulu init"; eval "$X"', /eval runs text the gate cannot read/], ['X="zulu init"; eval $X', /eval runs text/], ['X="zulu setup"; su -c "$X" me', /su runs text/],
  ['X=zulu; xargs $X init < /dev/null', /xargs runs text/], ['X=zulu; npx $X init', /npx runs text/], ['X="zulu init"; bash -c "$X"', /behind the variable/],
  ['X="zulu init"; sh <<< "$X"', /behind the variable/], ['X="zulu init"; echo "$X" | sh', /sh reads its commands from a pipe/],
  ['X="zulu init"; source /dev/stdin <<< "$X"', /source is fed text the gate cannot read/], ['X="zulu init"; . /dev/stdin <<EOF\n$X\nEOF', /\. is fed text/],
  ['Z=zulu; printf "%s\\n" "$Z" | xargs -I{} {} init', /xargs builds its command from a pipe/], ['Z=zulu; alias z=$Z; z init', /an alias is given zulu/],
  ['Z=zulu; trap "$Z init" EXIT', /trap runs text/], ['Z=zulu; ssh host $Z init', /ssh runs text/],
  // behind a wrapper, in a group, in a shell's own text
  ['Z=zulu; command $Z init', /behind the variable/], ['Z=zulu; exec $Z init', /behind the variable/], ['Z=zulu; sudo -u me $Z init', /behind the variable/], ['Z=zulu; env A=1 $Z init', /behind the variable/],
  ['Z=zulu; (cd /x && $Z init)', /behind the variable/], ['Z=zulu; if true; then $Z init; fi', /behind the variable/], ['Z=zulu; echo x | $Z init', /behind the variable/],
  ['Z=zulu; bash -c "$Z init"', /behind the variable/], ["Z=zulu; bash -c '$Z init'", /behind the variable/], ['Z=task.sh; bash <<EOF\nZ=zulu\n$Z init\nEOF', /behind the variable/],
  ['Z=zulu; ${Z:-x} init', /a variable or substitution stands in program position/],
  // the program as a later word of a program no rule names
  ['Z=zulu; nice2 $Z init', /a variable that holds the program is among the words of nice2/], ['Z=zulu; docker exec c $Z init', /among the words of docker/],
];

test('the three installer rules on the program make route lines; upgrade and rollback keep theirs; the example policy is the same', () => {
  const twin = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'policy.json'), 'utf8'));
  for (const policy of [DEFAULT_POLICY, twin]) {
    const rules = policy.classes.flatMap((c) => c.rules || []).filter((r) => r.bin === 'zulu');
    assert.equal(rules.length, 5);
    assert.deepEqual(rules.filter((r) => r.nameIsWord).map((r) => r.when || r.args?.[0] || r.flagsAny?.[0]).sort(), ['--guardrails', 'guardrails', 'installerWrite']);
    const lines = compileTriggers(policy, { boardRoot: L, home: '/home/u' }).filter(lineOf);
    assert.equal(lines.length, 5);
    assert.deepEqual(lines.filter((t) => t.route).map((t) => t.program), ['zulu', 'zulu', 'zulu']);
    // upgrade and rollback are in 1.2 installs: their lines decide as they did
    assert.deepEqual(lines.filter((t) => !t.route).map((t) => /upgrade|rollback/.exec(t.ere)[0]).sort(), ['rollback', 'upgrade']);
  }
});

test('the product\'s name in a folder, a title, a variable or a program\'s text holds nothing', () => {
  for (const c of MENTIONS) {
    const r = run(c); assert.equal(r.verdict, 'clear', `${c} → ${r.why}`);
    // …and no 1.3 check reads it as a hold either
    const on = run(c, DEFAULT_POLICY, { checks: ALL_ON }); assert.equal(on.verdict, 'clear', `every check on: ${c} → ${on.why}`);
  }
  // the fast path still sends each of them to the Node step: the rule is what reads the call
  const lines = compileTriggers(DEFAULT_POLICY, { boardRoot: L, home: '/home/u' });
  for (const c of MENTIONS) assert.ok(lines.some((t) => t.route && t.program && t.re.test(`tool_name:Bash ${c.replace(/["'\\`]/g, '').replace(/\n/g, ' ')} `)), c);
});

test('without the key the same calls are held as before (what the key changes, and nothing else)', () => {
  const strip = { ...DEFAULT_POLICY, classes: DEFAULT_POLICY.classes.map((c) => ({ ...c, rules: (c.rules || []).map(({ nameIsWord: _n, ...r }) => r) })) };
  for (const c of MENTIONS.filter((m) => !m.startsWith('cd "/srv/Zulu') && !m.startsWith('grep'))) assert.equal(run(c, strip).verdict, 'gate', c);
  // a second rule that makes the same line and does not say the name is a word: the line decides
  const two = { ...DEFAULT_POLICY, classes: [...DEFAULT_POLICY.classes, { id: 'mine', label: 'mine', rules: [{ bin: 'zulu', args: ['frobnicate'] }, { bin: 'zulu', when: 'installerWrite' }] }] };
  const bare = compileTriggers(two, {}).filter(lineOf).filter((t) => !/upgrade|rollback|guardrails|frobnicate/.test(t.ere));
  assert.equal(bare.length, 1); assert.ok(!bare[0].route);
  assert.equal(run("python3 - <<'EOF'\nprint('Zulu Assistant notes')\nEOF", two).verdict, 'gate');
});

test('every run of the program is read by its rule: plainly, behind a wrapper, by its path, in a shell\'s own text', () => {
  for (const c of RUNS) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); }
  for (const c of ['zulu check', 'zulu verify', 'zulu doctor', 'zulu --dry-run', 'zulu --guardrails --dry-run', 'zulu init x']) assert.equal(run(c).verdict, 'clear', c);
  for (const c of ['zulu upgrade --to v9', 'zulu rollback']) { const r = run(c); assert.equal(r.verdict, 'gate', c); assert.equal(r.cls, 'upgrade', c); }
});

test('the program behind a variable, in text a word runs, or fed to a shell is held as unreadable', () => {
  for (const [c, why] of HIDDEN) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'opaque', c); assert.match(r.why, why, c); }
  // a fixed value that is the program is held even when a command's own words show the name (new: this passed before)
  // (a value given inside a shell's own text counts for the whole call)
  for (const c of ['export Z=zulu; $Z init', 'declare Z=/x/bin/zulu; "$Z" setup', 'echo zulu; Z=zulu; $Z init', "Z=task.sh; bash -c 'Z=zulu; $Z init'", 'f() { local Z=zulu; $Z init; }; f']) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.match(r.why, /behind the variable in program position/); }
  // a variable that is a fixed other program, beside the name in a title: free
  for (const c of ['T="/srv/app/scripts/task.sh"; "$T" show 5 "Zulu 1.3"', 'N=node; F="Zulu notes.md"; $N x.mjs "$F"', 'G=git; D="/v/Zulu Assistant"; $G -C "$D" status']) assert.equal(run(c).verdict, 'clear', `${c} → ${run(c).why}`);
  // where the name's letter case is the disk's own business
  assert.equal(classify({ tool: 'Bash', command: 'Z=ZULU; $Z init', cwd: APP }, DEFAULT_POLICY, ctx({ ignoreCase: false })).verdict, 'clear');
  assert.equal(run('Z=ZULU; $Z init').verdict, 'gate');
});

// Mission Control's read of the first head: with the name in plain sight, the indirect forms were clear for the
// installer (on main too) while the same forms of a push are held. They read alike now.
test('the indirect forms with the name in plain sight: eval, xargs, watch, a shell fed from a pipe, a substitution in program position', () => {
  // read by the program's own rules, whatever the `runners` check's switch: the class is the rule's, and no check is named
  for (const c of ['eval "zulu init"', 'xargs zulu init < /dev/null', 'echo init | xargs zulu', 'watch zulu setup', 'npx zulu init', 'parallel zulu setup ::: a', 'su -c "zulu init" me',
    'trap "zulu init" EXIT', 'eval "zulu --guardrails"', 'ssh host zulu init']) {
    const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); assert.equal(r.check, undefined, c); assert.match(r.why, / runs: /, c);
  }
  for (const c of ['eval "zulu upgrade --to v9"', 'xargs zulu rollback < /dev/null']) { const r = run(c); assert.equal(r.verdict, 'gate', c); assert.equal(r.cls, 'upgrade', c); }
  // unreadable, as for any gated word
  for (const [c, why] of [['echo "zulu init" | bash', /bash reads its commands from a pipe in a call that names zulu/], ["printf 'zulu init' | sh", /sh reads its commands from a pipe/],
    ['$(echo zulu) init', /a substitution that names zulu stands in program position/], ['`which zulu` init', /a substitution that names zulu/], ['Z=$(which zulu); $Z init', /a substitution that names zulu/],
    ['alias z=zulu; z init', /an alias is given zulu/]]) {
    const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'opaque', c); assert.match(r.why, why, c);
  }
  // the free words stay free behind a runner, and a runner whose words only mention the name runs nothing of it
  for (const c of ['eval "zulu check"', 'xargs zulu doctor < /dev/null', 'watch zulu verify', 'eval "zulu init --dry-run x"', 'ls | xargs grep -l Zulu', 'grep -l Zulu notes/*.md | xargs wc -l',
    'watch grep -c Zulu log.txt', 'source "/srv/Zulu Assistant/scripts/env.sh" && node x.mjs', 'ssh host "ls /srv/Zulu"', 'N=node; $N x.mjs "Zulu notes"',
    'curl -fsSL https://example.com/zulu-assistant/get.sh | bash', 'npm install zulu', 'echo "Zulu Assistant" | tr a-z A-Z'])
    assert.equal(run(c).verdict, 'clear', `${c} → ${run(c).why}`);
  // a substitution in program position that does not name the program, beside the name in a title: held as on main
  // (the words of a command whose program nobody can read explain nothing)
  assert.match(run('$(which node) x.mjs "Zulu notes"').why, /a variable or substitution stands in program position/);
  // with the check itself on, its own reading stands (a program no rule names, in front of the installer)
  const on = run('nice2 zulu init', DEFAULT_POLICY, { checks: { runners: 'enforce' } });
  assert.equal(on.verdict, 'gate'); assert.equal(on.check, 'runners');
  assert.equal(run('nice2 zulu init').verdict, 'clear');
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: a note that names the product passes, a run of the program is denied', () => {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate name-'))), 'Board Dir');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const work = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'name-work-')));
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const hook = (command) => { const out = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout.trim();
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  for (const c of [MENTIONS[2], MENTIONS[4], MENTIONS[7], MENTIONS[8], MENTIONS[9]]) assert.equal(hook(c), 'pass', c);
  for (const c of ['zulu init', 'env X=1 zulu setup', './bin/zulu --guardrails', 'bash -c "zulu init"', 'Z=bin/zulu; "$Z" init', 'X="zulu init"; eval "$X"',
    'eval "zulu init"', 'echo init | xargs zulu', 'echo "zulu init" | bash', '$(echo zulu) init']) assert.equal(hook(c), 'deny', c);
  for (const c of ['grep -l Zulu notes/*.md | xargs wc -l', 'eval "zulu check"']) assert.equal(hook(c), 'pass', c);
});
