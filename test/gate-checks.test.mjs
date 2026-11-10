import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, normalizeForTriggers, checkMode, inlineBodies, gatedPrefixes, parseCommand, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';
import { createGateService, policyProblems } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { readChecks, replay, render, parseSince, FIXED } from '../scripts/gate-replay.mjs';

// Zulu 1.3 slice 5: inline interpreter bodies, renamed programs, shell keywords, the replay tool.
// Neutral fixtures: repo /work/app, home /home/u. Sample strings are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODES = ['off', 'observe', 'enforce'];
const withChecks = (checks) => ({ ...structuredClone(DEFAULT_POLICY), checks });
const only = (name, mode) => withChecks({ ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), [name]: mode });
const ctx = { home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', git: () => null };
const run = (command, policy) => classify({ tool: 'Bash', command, cwd: '/work/app' }, policy, ctx);

// each form with the action at the end of the body and in the middle of the line
const INLINE = [
  `python3 -c "import os; os.system('git push origin main --force')"`,
  `python3 -c "import os; os.system('gh pr merge 5'); print(1)" && ls -la`,
  `python -Ic "import subprocess as s; s.run(['sh','-c','gh pr merge 5'])"`,
  `node -e "require('child_process').execSync('gh pr merge 5')"`,
  `node --eval="require('child_process').execSync('vercel deploy --prod')"; echo done`,
  `node -p "require('child_process').execSync('git push origin main')"`,
  `node -pe "require('child_process').execSync('gh pr merge 5')"`,
  `bun -e "Bun.spawnSync(['sh','-c','gh pr merge 5'])"`,
  `deno eval "await new Deno.Command('sh',{args:['-c','gh pr merge 5']}).output()"`,
  `perl -e 'system("gh pr merge 5")'`,
  `perl -ne 'system("git push origin main")' < /dev/null`,
  `ruby -e 'system("git push origin main")'`,
  `php -r 'system("gh pr merge 5");'`,
  `osascript -e 'do shell script "gh pr merge 5"'`,
  `osascript -e 'tell application "Terminal"' -e 'do script "gh pr merge 5"' -e 'end tell'`,
  `lua -e 'os.execute("gh pr merge 5")'`,
  `Rscript -e 'system("gh pr merge 5")'`,
  `cd /work/app && env X=1 python3 -c "import os; os.system('launchctl kickstart -k gui/501/com.example.sender')" | tail -1`,
];
const RENAMED = [
  './mygh pr merge 5', '/tmp/mygh pr merge 5', 'mygh pr merge 5', 'mygh -R acme/app pr merge 5 --merge',
  './g push origin main', 'mygit -C /work/app push origin main', 'mygh secret set TOKEN', './tool repo delete acme/app',
  'wrangler deploy', './git pr merge 3', 'ls && ./mygh pr merge 5 && ls',
];
// never held by either check, in any mode
const FREE = [
  `gh pr view 91 --json state | python3 -c "print('merge')"`,
  `node -e "const a = []; a.push(1); console.log(a)"`,
  `python3 -c "print('hello')"`,
  'git commit -m "push the fix"', 'cd deploy && ls', 'echo push', 'echo "pr merge later"', 'kubectl -n deploy get pods',
  '/usr/bin/git push origin feature-x', 'git push -u origin feature-x', 'grep -rn "secret" src | head -3; set -e',
  'for d in deploy push; do echo $d; done', 'case deploy in deploy) echo x;; esac', 'mkdir -p deploy && cp a deploy/', 'npm run deploy:check',
  'docker run -e MODE=push img', 'gh secret list', '/opt/homebrew/bin/vercel deploy --help', '/usr/local/bin/vercel deploy --help', 'node scripts/x.mjs && python3 scripts/y.py',
];
const HELD_TODAY = ['gh pr merge 5', 'git push origin main', 'vercel --prod', 'gh secret set TOKEN', `python3 -c "print('x')" && gh pr merge 5`];

test('switches: a missing key or an unknown value reads as observe; the shipped default names every check', () => {
  assert.deepEqual(Object.keys(DEFAULT_POLICY.checks).sort(), [...CHECKS].sort());
  for (const n of CHECKS) assert.equal(DEFAULT_POLICY.checks[n], 'observe');
  assert.equal(checkMode({}, 'inlineBodies'), 'observe');
  assert.equal(checkMode({ checks: { inlineBodies: 'loud' } }, 'inlineBodies'), 'observe');
  for (const m of MODES) assert.equal(checkMode({ checks: { renamedBins: m } }, 'renamedBins'), m);
  assert.deepEqual(JSON.parse(readFileSync(path.join(ROOT, 'examples', 'policy.json'), 'utf8')).checks, DEFAULT_POLICY.checks);
  assert.deepEqual(policyProblems(DEFAULT_POLICY), []);
  assert.ok(policyProblems(withChecks({ nope: 'observe' })).some((p) => /not a known check/.test(p)));
  assert.ok(policyProblems(withChecks({ inlineBodies: 'on' })).some((p) => /off\|observe\|enforce/.test(p)));
  assert.ok(policyProblems(withChecks([])).some((p) => /must be an object/.test(p)));
});

test('inline bodies: every interpreter form is read (the parser lists the body)', () => {
  assert.deepEqual(inlineBodies('node', ['node', '-e', 'a', '--eval=b', '-p', 'c', '--print', 'd', '-pe', 'e']), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(inlineBodies('python3.12', ['python3.12', '-uc', 'x', 'arg']), ['x']);
  assert.deepEqual(inlineBodies('perl', ['perl', '-lane', 'x', '-E', 'y', 'f']), ['x', 'y']);
  assert.deepEqual(inlineBodies('osascript', ['osascript', '-e', 'a', '-e', 'b']), ['a', 'b']);
  assert.deepEqual(inlineBodies('deno', ['deno', 'eval', '--quiet', 'code']), ['code']);
  assert.deepEqual(inlineBodies('php', ['php', '-r', 'x']), ['x']);
  assert.deepEqual(inlineBodies('node', ['node', 'x.mjs']), []);
  assert.deepEqual(inlineBodies('git', ['git', '-c', 'x=y', 'log']), []);
  const p = parseCommand(`echo $(python3 -c "print(1)") && bash -c "node -e 'x()'"`);
  assert.deepEqual(p.cmds.filter((c) => c.inlineBodies).map((c) => [c.bin, c.inlineBodies[0]]), [['python3', 'print(1)'], ['node', 'x()']]);
});

for (const [name, held] of [['inlineBodies', INLINE], ['renamedBins', RENAMED]]) {
  test(`${name} off: the verdict is today's and nothing is noted`, () => {
    for (const c of held) { const r = run(c, only(name, 'off')); assert.equal(r.verdict, 'clear', c); assert.equal(r.wouldHold, undefined, c); }
  });
  test(`${name} observe: the verdict is today's, and the reading names the check`, () => {
    for (const c of held) {
      const off = run(c, only(name, 'off')); const r = run(c, only(name, 'observe'));
      assert.equal(r.verdict, off.verdict, c); assert.equal(r.verdict, 'clear', c);
      assert.equal(r.wouldHold?.check, name, c); assert.equal(r.wouldHold.cls, 'opaque');
    }
  });
  test(`${name} enforce: held as opaque, tagged with the check`, () => {
    for (const c of held) { const r = run(c, only(name, 'enforce')); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'opaque', c); assert.equal(r.check, name, c); }
  });
  test(`${name}: free commands stay free and held commands keep their class, in every mode`, () => {
    for (const m of MODES) {
      for (const c of FREE) { const r = run(c, only(name, m)); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
      for (const c of HELD_TODAY) { const r = run(c, only(name, m)); assert.equal(r.verdict, 'gate', `${m}: ${c}`); assert.notEqual(r.cls, 'opaque', `${m}: ${c}`); assert.equal(r.check, undefined); }
    }
  });
}

test('renamed programs: only leading words that are a gated action count', () => {
  const words = gatedPrefixes(DEFAULT_POLICY).map((p) => p.words.join(' '));
  for (const w of ['pr merge', 'push', 'secret set', 'secret delete', 'variable set', 'repo delete', 'deploy', 'bootstrap']) assert.ok(words.includes(w), w);
  for (const w of ['load', 'enable', 'upgrade', 'rollback', 'publish']) assert.ok(!words.includes(w), w);
  const p = only('renamedBins', 'enforce');
  assert.match(run('./mygh pr merge 5', p).why, /run by path.*pr merge/);
  assert.match(run('mygh pr merge 5', p).why, /not a program the gate knows.*pr merge/);
  // a copy named like a system tool is still a copy when it is run from somewhere else
  assert.equal(run('/tmp/echo pr merge 5', p).verdict, 'gate');
  assert.equal(run('/bin/echo pr merge 5', p).verdict, 'clear');
  assert.equal(run('./git pr merge 3', p).verdict, 'gate');
  // a known program by its usual PATH folder is the bare name: its own rules decide (here: a merge, and a free deploy help)
  assert.equal(run('/opt/homebrew/bin/gh pr merge 5', p).cls, 'merge');
  assert.equal(run('/usr/local/bin/vercel deploy --help', p).verdict, 'clear');
});

test('a body with a rule of its own keeps that class (a rule is asked before the check)', () => {
  const D = 'x-mesh-' + 'decision';
  const r = run(`python3 -c "import urllib.request as u; u.urlopen(u.Request('http://localhost:1/api/tasks/5', method='PATCH', headers={'${D}':'t'}))"`, only('inlineBodies', 'enforce'));
  assert.equal(r.verdict, 'gate'); assert.equal(r.cls, 'self');
});

// ── shell keywords (a parser fix, no switch): the program is the word after then/do/if/! ──
const KEYWORD_HELD = [
  ['if true; then gh pr merge 5; fi', 'merge'], ['for i in 1 2; do gh pr merge $i; done', 'merge'],
  ['while true; do git push origin main; done', 'push'], ['! gh pr merge 5', 'merge'], ['if gh pr merge 5; then echo ok; fi', 'merge'],
  ['if false; then :; elif gh pr merge 5; then :; else vercel --prod; fi', 'merge'], ['if false; then :; else vercel --prod; fi', 'deploy'],
  ['until gh pr merge 5; do sleep 1; done', 'merge'], ['if ! gh secret set TOKEN; then echo no; fi', 'env'],
  ['if true\nthen\n  gh pr merge 5\nfi', 'merge'], ['coproc gh pr merge 5', 'merge'],
];
const KEYWORD_FREE = ['if [ -f x ]; then echo push; fi', 'for d in deploy push; do echo $d; done', 'if git diff --quiet; then echo clean; else git status; fi',
  'while read l; do echo "$l"; done < f', '[ ! -d deploy ] && mkdir deploy'];

test('shell keywords: a gated command after then, do, if, else, elif, until or ! is held under its own class', () => {
  const off = withChecks(Object.fromEntries(CHECKS.map((n) => [n, 'off'])));
  for (const [c, cls] of KEYWORD_HELD) { const r = run(c, off); assert.equal(r.verdict, 'gate', c); assert.equal(r.cls, cls, c); }
  for (const c of KEYWORD_FREE) assert.equal(run(c, off).verdict, 'clear', c);
  // the old reading, kept only so the replay tool can count what the fix newly holds
  assert.equal(classify({ tool: 'Bash', command: 'if true; then gh pr merge 5; fi', cwd: '/work/app' }, off, { ...ctx, legacyParser: true }).verdict, 'clear');
});

// ── the real hook script, real hook JSON, board down: a held call must come back denied ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'];   // the hook's whole file set
function hookCopy(checks) {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'gate checks-')), 'Repo With Space');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(withChecks(checks)));
  return dir;
}
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
const shapes = (command, cwd) => [
  { session_id: 's', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } },
  { session_id: 's', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },           // command last → `"}`
];
const hookOut = (dir, obj, extra = {}) => spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify(obj), env: { ...env, ...extra }, encoding: 'utf8' }).stdout;
const decisionOf = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass');

const dirs = Object.fromEntries(MODES.map((m) => [m, hookCopy(Object.fromEntries(CHECKS.map((n) => [n, m])))]));

test('real hook JSON, off and observe: the hook\'s answer is byte for byte the same, and newly read calls pass', () => {
  for (const c of [...INLINE, ...RENAMED, ...FREE, ...HELD_TODAY, ...KEYWORD_FREE]) {
    for (const s of shapes(c, dirs.off)) {
      const off = hookOut(dirs.off, s); const obs = hookOut(dirs.observe, { ...s, cwd: dirs.off });
      assert.equal(obs, off, c);
      if (!HELD_TODAY.includes(c)) assert.equal(off, '', c);
      else assert.equal(decisionOf(off), 'deny', c);
    }
  }
});

test('real hook JSON, enforce: inline bodies and renamed programs are denied; free calls stay silent', () => {
  for (const c of [...INLINE, ...RENAMED]) for (const s of shapes(c, dirs.enforce)) assert.equal(decisionOf(hookOut(dirs.enforce, s)), 'deny', c);
  for (const c of [...FREE, ...KEYWORD_FREE]) for (const s of shapes(c, dirs.enforce)) assert.equal(hookOut(dirs.enforce, s), '', c);
});

test('real hook JSON: a gated command behind a shell keyword is denied in every mode', () => {
  for (const m of MODES) for (const [c] of KEYWORD_HELD) for (const s of shapes(c, dirs[m])) assert.equal(decisionOf(hookOut(dirs[m], s)), 'deny', `${m}: ${c}`);
});

test('fast path: the new trigger lines match in grep and in JS alike, and a call with no trigger still never starts Node', () => {
  const lines = triggerLines(DEFAULT_POLICY);
  assert.deepEqual(readFileSync(path.join(ROOT, 'scripts', 'gate-triggers.default'), 'utf8').trim().split('\n'), lines);
  // with the check off the lines are not generated at all
  assert.ok(lines.length > triggerLines(only('renamedBins', 'off')).length);
  assert.equal(triggerLines(only('inlineBodies', 'off')).length, triggerLines(only('inlineBodies', 'enforce')).length);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-'));
  const file = path.join(dir, 'triggers'); writeFileSync(file, lines.join('\n') + '\n');
  const js = compileTriggers(DEFAULT_POLICY);
  for (const s of ['mygh secret set TOKEN', './tool repo delete acme/app', 'x variable delete NAME', 'the secret is set', 'git status', 'ls secrets', 'reset the repo', 'echo variables', ...FREE, ...RENAMED]) {
    const text = normalizeForTriggers(`tool_name:Bash ${s}`);
    assert.equal(spawnSync('/usr/bin/grep', ['-qiE', '-f', file], { input: text }).status === 0, js.some((t) => t.re.test(text)), s);
  }
  const marker = path.join(dir, 'ran'); const shim = path.join(dir, 'node');
  writeFileSync(shim, `#!/bin/sh\n: > "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  for (const c of ['git status && ls -la src && node --version', 'node -e "console.log(1)"', `python3 -c "print('hi')"`, './mytool status', 'npm test', 'cd src && ls secrets']) {
    assert.equal(hookOut(dirs.observe, shapes(c, dirs.observe)[0], { GATE_NODE: shim }), '', c);
    assert.equal(readdirSync(dir).includes('ran'), false, `the fast path started Node for: ${c}`);
  }
  hookOut(dirs.observe, shapes('mygh secret set TOKEN', dirs.observe)[0], { GATE_NODE: shim });
  assert.equal(readdirSync(dir).includes('ran'), true, 'a renamed-program hit should reach Node');
});

test('fast path timing: a call with no trigger is as fast with the new lines as before', () => {
  const input = JSON.stringify(shapes('git status && ls -la src && node -e "console.log(1)"', dirs.observe)[0]);
  const times = [];
  for (let i = 0; i < 60; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('sh', [path.join(dirs.observe, 'scripts', 'gate-hook.sh'), '--env-board'], { input, env, encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  assert.ok(median < (process.env.CI ? 150 : 35), `median ${median.toFixed(1)} ms`);   // the same ceilings as test/gate-hook.test.mjs
});

// ── the board side: observe leaves a reading and nothing else ──
async function board(policy) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-checks-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const events = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'),
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, recordEvent: async (k, t) => { events.push(t); },
  });
  const check = (command, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const lines = async (f) => (await readFile(path.join(dir, 'guardrails', f), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, ledger, check, lines, events };
}

for (const [name, sample] of [['inlineBodies', INLINE[0]], ['renamedBins', RENAMED[0]]]) {
  test(`board, ${name}: off passes silently; observe passes with one reading; enforce files a gate`, async () => {
    const off = await board(only(name, 'off'));
    assert.deepEqual(await off.check(sample), { decision: 'pass' });
    assert.deepEqual(await off.lines('observed.jsonl'), []);

    const obs = await board(only(name, 'observe'));
    assert.deepEqual(await obs.check(sample), { decision: 'pass' });                 // exactly the answer of `off`
    assert.deepEqual(await obs.check(sample, { event: 'post' }), { decision: 'pass' });
    const seen = await obs.lines('observed.jsonl');
    assert.equal(seen.length, 1); assert.equal(seen[0].wouldHold, name); assert.equal(seen[0].agent, 'builder'); assert.equal(seen[0].cls, 'opaque');
    assert.equal((await obs.lines('checks.jsonl')).filter((l) => l.wouldHold === name).length, 1);
    assert.deepEqual(await obs.ledger.list({}), []);                                  // observe never writes to tasks
    assert.ok(obs.events.some((e) => e.includes(`${name} would hold builder`)));
    // a call a rule holds anyway is not a reading of the check
    assert.equal((await obs.check('gh pr merge 5')).decision, 'deny');
    assert.equal((await obs.lines('observed.jsonl')).length, 1);

    const enf = await board(only(name, 'enforce'));
    const r = await enf.check(sample);
    assert.equal(r.decision, 'deny'); assert.match(r.reason, /waiting on the owner/i);
    const t = await enf.ledger.get(r.task);
    assert.equal(t.gates[0].cls, 'opaque'); assert.equal(t.gates[0].status, 'pending');
  });
}

test('board: with the whole policy in observe or off, a check reading is still only a pass', async () => {
  const b = await board(withChecks({ inlineBodies: 'observe', renamedBins: 'observe' }));
  await writeFile(path.join(b.dir, 'policy.json'), JSON.stringify({ ...withChecks({ inlineBodies: 'observe', renamedBins: 'observe' }), mode: 'off' }));
  assert.deepEqual(await b.check(INLINE[0]), { decision: 'pass' });
  assert.deepEqual(await b.lines('observed.jsonl'), []);
});

test('the check log keeps a long or multi-line command whole for the replay tool, and never a secret', async () => {
  const b = await board(withChecks({ inlineBodies: 'off', renamedBins: 'off' }));
  const long = `gh pr view 5 && echo ${'x'.repeat(300)}`;
  await b.check(long); await b.check('gh pr view 5\ngh pr list'); await b.check('gh pr view 5');
  await b.check(`gh pr view 5 && echo sk-ant-api03-${'A'.repeat(90)} ${'y'.repeat(200)}`);
  const l = await b.lines('checks.jsonl');
  assert.equal(l[0].command.length, 160); assert.equal(l[0].full, long);
  assert.equal(l[1].full, 'gh pr view 5\ngh pr list');
  assert.equal(l[2].full, undefined);
  assert.equal(l[3].full, undefined); assert.match(l[3].command, /withheld/);
});

// ── the replay tool ──
const line = (o) => JSON.stringify({ at: '2026-01-05T10:00:00.000Z', event: 'pre', agent: 'builder', tool: 'Bash', decision: 'pass', cwd: '/work/app', ...o });
const LOG = [
  line({ command: 'gh pr view 5' }),
  line({ at: '2026-01-05T11:00:00.000Z', command: INLINE[0] }),
  line({ at: '2026-01-05T12:00:00.000Z', command: './mygh pr merge 5', agent: 'helper' }),
  line({ at: '2026-01-05T13:00:00.000Z', command: 'if true; then gh pr merge 5; fi' }),
  line({ at: '2026-01-05T14:00:00.000Z', command: 'gh pr merge 5', decision: 'deny' }),               // held already: not new
  line({ at: '2026-01-05T15:00:00.000Z', event: 'post', command: './mygh pr merge 5' }),             // post lines are skipped
  line({ at: '2026-01-05T16:00:00.000Z', command: '[withheld: contains a secret]' }),
  line({ at: '2026-01-05T17:00:00.000Z', command: `python3 -c "import os; ${'#'.repeat(140)}`.slice(0, 160) }),   // cut at 160, as old lines are
  line({ at: '2026-01-05T18:00:00.000Z', command: 'python3 -c "import os; os.system(…', full: `python3 -c "import os\nos.system('gh pr merge 5')"` }),
  line({ at: '2026-01-06T10:00:00.000Z', tool: 'Read', command: '/work/app/README.md' }),
  'not json',
].join('\n');

test('replay: counts what each check would newly hold, by check and by agent, and prefers the whole text', () => {
  const entries = readChecks(LOG);
  assert.equal(entries.length, 8);
  const r = replay(entries, DEFAULT_POLICY, { home: '/home/u', root: '/work/board' });
  assert.equal(r.total, 8); assert.equal(r.cut, 1);
  assert.deepEqual(r.byCheck, { inlineBodies: 2, renamedBins: 1, [FIXED]: 1 });
  assert.deepEqual(r.byAgent, { builder: 3, helper: 1 });
  assert.ok(r.held.every((h) => h.cls));
  const text = render(r, { policyName: 'the shipped default policy' });
  assert.match(text, /8 recorded checks/); assert.match(text, /newly held with every check on: 4/);
  assert.match(text, /1 of them were cut at 160/); assert.match(text, /parserFixes \(parser fixes, no switch\): 1/);
  // one check at a time
  assert.deepEqual(replay(entries, DEFAULT_POLICY, { checks: ['renamedBins'], root: '/work/board' }).byCheck, { renamedBins: 1, [FIXED]: 1 });
  assert.equal(readChecks(LOG, { since: Date.parse('2026-01-05T17:30:00Z') }).length, 2);
  assert.equal(parseSince('2d', 10 * 86400e3), 8 * 86400e3); assert.equal(parseSince('soon'), null);
  assert.equal(render(replay([], DEFAULT_POLICY)), 'gate replay: no recorded checks to read');
});

test('replay CLI: reads a log and a policy by path, prints a reading or JSON, writes nothing, fails plainly', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  writeFileSync(path.join(dir, 'checks.jsonl'), LOG + '\n'); writeFileSync(path.join(dir, 'p.json'), JSON.stringify(DEFAULT_POLICY));
  const cli = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gate-replay.mjs'), ...a], { encoding: 'utf8' });
  const before = readdirSync(dir).sort();
  const out = cli('--file', path.join(dir, 'checks.jsonl'), '--policy', path.join(dir, 'p.json'));
  assert.equal(out.status, 0, out.stderr); assert.match(out.stdout, /newly held with every check on: 4/);
  const j = JSON.parse(cli('--file', path.join(dir, 'checks.jsonl'), '--policy', path.join(dir, 'p.json'), '--json', '--check', 'inlineBodies').stdout);
  assert.deepEqual(j.byCheck, { inlineBodies: 2, [FIXED]: 1 });
  assert.deepEqual(readdirSync(dir).sort(), before);
  const bad = cli('--file', path.join(dir, 'nope.jsonl'));
  assert.equal(bad.status, 1); assert.match(bad.stderr, /no recorded checks/);
  assert.equal(cli('--file', path.join(dir, 'checks.jsonl'), '--check', 'nope').status, 1);
  assert.match(cli('--help').stdout, /Read-only/);
});
