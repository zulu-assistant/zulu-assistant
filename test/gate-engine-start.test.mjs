import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

// Task #510, check `engineStart` (1.3): a session an agent starts from its own shell. A child session
// started with settings of its own can run with no gate hook (seen live), and the gate sees only the
// parent's command. Every headless start gets a reading; only the forms that weaken the gate are held,
// and only at enforce. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODES = ['off', 'observe', 'enforce'];
const policyAt = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), engineStart: mode } });
const ctx = { home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', git: () => null, ignoreCase: false };
const run = (command, mode = 'enforce') => classify({ tool: 'Bash', command, cwd: '/work/app' }, policyAt(mode), { ...ctx });

// forms that leave the gate hook out of the new session, or stop it asking
const WEAK = [
  'claude -p "do it" --setting-sources project,local', 'claude --setting-sources=local -p x', 'claude --setting-sources "" -p x', 'claude -p x --setting-sources project',
  'claude --settings /tmp/s.json -p x', 'claude -p x --settings \'{"disableAllHooks":true}\'', 'claude --settings=/tmp/s.json -p x', 'claude --settings=\'{"disableAllHooks":true}\' -p x',
  'claude --bare -p x', 'claude -p x --dangerously-skip-permissions', 'claude -p x --allow-dangerously-skip-permissions', 'claude -p x --permission-mode bypassPermissions', 'claude --permission-mode=bypassPermissions -p x',
  'CLAUDE_CONFIG_DIR=/tmp/c claude -p x', 'HOME=/tmp/h claude -p x', 'XDG_CONFIG_HOME=/tmp/x claude -p x', 'export HOME=/tmp/h; claude -p x', 'export CLAUDE_CONFIG_DIR=/tmp/c\nclaude -p x', 'env -i claude -p x', 'env -u HOME claude -p x',
  'env HOME=/tmp/h claude -p x', 'timeout 60 claude -p x --setting-sources project', 'nohup claude -p x --settings /tmp/s.json &', 'cd /tmp && claude -p x --bare',
  // a weakening form is read whether or not the start is headless
  'claude --settings /tmp/s.json', 'claude --dangerously-skip-permissions "fix it"',
  // the freeing words free only as the first word
  'claude -p x --setting-sources project --version', 'claude --settings /tmp/s.json --help -p x', 'claude -p --settings /tmp/s.json mcp',
  'codex exec --dangerously-bypass-approvals-and-sandbox "do it"', 'codex --yolo', 'codex exec -s danger-full-access x', 'codex exec --sandbox danger-full-access x', 'codex exec -c hooks.enabled=false x',
  'codex exec --config shell_environment_policy.inherit=none x', 'CODEX_HOME=/tmp/c codex exec x', 'HOME=/tmp/h codex exec x',
];
// a plain headless start: a reading in observe and at enforce, never a hold
const PLAIN = ['claude -p "summarise the diff"', 'claude --print "x"', 'claude -p x --setting-sources user,project,local', 'claude -p x --permission-mode acceptEdits', 'claude -p x --model claude-haiku-5-5 --output-format json',
  'cat notes.md | claude -p "summarise"', 'claude -p x --mcp-config /tmp/m.json', 'codex exec "do it"', 'codex exec --full-auto x', 'timeout 120 claude -p x'];
// starts no session, or is not the program at all
const FREE = ['claude --version', 'claude -v', 'claude --help', 'claude mcp list', 'claude mcp add x -- npx y', 'claude config list', 'claude doctor', 'claude update', 'codex --version', 'codex login', 'codex mcp list',
  'echo "Co-Authored-By: Claude"', 'git commit -m "claude -p notes and --settings docs"', 'grep -rn "claude -p" scripts', 'cat ~/.claude/settings.json | head -3', 'ls ~/.claude', 'scripts/task.sh comment 5 "run claude -p --setting-sources project to see it"',
  'which claude', 'npm test', 'git status'];

test('the weakening forms: clear with the check off, a reading in observe, held at enforce in a class of their own', () => {
  for (const c of WEAK) {
    const off = run(c, 'off'); assert.equal(off.verdict, 'clear', `off: ${c} → ${off.why}`); assert.equal(off.wouldHold, undefined, `off: ${c}`);
    const obs = run(c, 'observe'); assert.equal(obs.verdict, 'clear', `observe: ${c} → ${obs.why}`); assert.equal(obs.wouldHold?.check, 'engineStart', `observe: ${c}`); assert.equal(obs.wouldHold.cls, 'engine-start');
    const enf = run(c); assert.equal(enf.verdict, 'gate', `enforce: ${c} → ${enf.why}`); assert.equal(enf.cls, 'engine-start', c); assert.equal(enf.check, 'engineStart'); assert.match(enf.why, /session the gate may not see/);
  }
  const cls = DEFAULT_POLICY.classes.find((c) => c.id === 'engine-start');
  assert.ok(cls && !cls.standing, 'a program go never covers a session start'); assert.equal(DEFAULT_POLICY.checks.engineStart, 'observe');
});

test('a plain headless start is a reading in observe AND at enforce, and is never held', () => {
  for (const c of PLAIN) {
    assert.equal(run(c, 'off').verdict, 'clear', `off: ${c}`); assert.equal(run(c, 'off').wouldHold, undefined, `off: ${c}`);
    for (const m of ['observe', 'enforce']) {
      const r = run(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.why}`);
      assert.equal(r.wouldHold?.check, 'engineStart', `${m}: ${c}`); assert.match(r.wouldHold.why, /a reading: plain starts are not held/);
    }
  }
});

test('what starts no session is free in every mode, and so is text that only names the program', () => {
  for (const m of MODES) for (const c of FREE) { const r = run(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.cls}: ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
});

test('the check only adds: every call answers the same with it off as on main, and observe never changes an answer', () => {
  const main = { ...structuredClone(DEFAULT_POLICY) }; main.checks = Object.fromEntries(CHECKS.filter((n) => n !== 'engineStart').map((n) => [n, 'off']));
  main.classes = main.classes.filter((c) => c.id !== 'engine-start');
  for (const c of [...WEAK, ...PLAIN, ...FREE, 'gh pr merge 5', 'git push origin main', 'claude -p "then run gh pr merge 5"']) {
    const before = classify({ tool: 'Bash', command: c, cwd: '/work/app' }, main, { ...ctx });
    for (const m of ['off', 'observe']) { const r = run(c, m); assert.equal(r.verdict, before.verdict, `${m}: ${c}`); assert.equal(r.cls, before.cls, `${m}: ${c}`); }
    if (before.verdict === 'gate') assert.equal(run(c, 'enforce').verdict, 'gate', `a call held before stays held: ${c}`);
  }
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: off and observe answer alike (nothing), enforce denies the weakening forms and lets a plain start run', () => {
  const dirs = {};
  for (const m of MODES) {
    const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate eng-'))), 'Board Dir');
    for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
    writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policyAt(m)));
    dirs[m] = dir;
  }
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const hook = (dir, command) => spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
  const decision = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass');
  const weak = ['claude -p x --setting-sources project,local', 'claude --settings /tmp/s.json -p x', 'claude -p x --dangerously-skip-permissions', 'CLAUDE_CONFIG_DIR=/tmp/c claude -p x', 'HOME=/tmp/h claude -p x', 'claude --bare -p x',
    'codex exec --dangerously-bypass-approvals-and-sandbox x', 'timeout 60 claude -p x --permission-mode bypassPermissions'];
  for (const c of weak) { const off = hook(dirs.off, c); assert.equal(off, '', `off: ${c}`); assert.equal(hook(dirs.observe, c), off, `observe: ${c}`); assert.equal(decision(hook(dirs.enforce, c)), 'deny', `enforce: ${c}`); }
  for (const c of ['claude -p "summarise"', 'codex exec "do it"', 'claude --version', 'claude mcp list', 'npm test']) for (const m of MODES) assert.equal(hook(dirs[m], c), '', `${m}: ${c}`);
  // the fast path sends every start to the Node step, and ordinary calls never
  const lines = compileTriggers(policyAt('observe'));
  for (const c of [...WEAK, ...PLAIN]) assert.ok(lines.some((t) => t.re.test(`tool_name:Bash ${c.replace(/["'\\`]/g, '')} `)), c);
  for (const c of ['npm test', 'git status', 'ls ~/.claude', 'which claude']) assert.ok(!compileTriggers(policyAt('enforce')).filter((t) => t.route).some((t) => t.re.test(`tool_name:Bash ${c} `)), c);
});

// ── the board side: one reading per start, so the first week gives the count ──
async function board(mode) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-eng-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policyAt(mode)));
  const events = []; const t = Date.parse('2026-01-05T10:00:00Z');
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', git: () => null, isPrivateRepo: async () => null, prInfo: async () => null,
    now: () => t, recordEvent: async (k, x) => { events.push(x); } });
  const sh = (command) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const observed = async () => String(await readFile(path.join(dir, 'guardrails', 'observed.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ledger, sh, observed, events };
}

test('the board, observe: every start passes and leaves one observed line and one ticker line; nothing is written to a task', async () => {
  const b = await board('observe');
  for (const c of ['claude -p "summarise"', 'claude -p x --setting-sources project,local', 'codex exec "do it"', 'claude -p "summarise"']) assert.deepEqual(await b.sh(c), { decision: 'pass' }, c);
  assert.deepEqual(await b.sh('claude --version'), { decision: 'pass' });
  const obs = await b.observed();
  assert.equal(obs.length, 4); assert.ok(obs.every((l) => l.wouldHold === 'engineStart' && l.cls === 'engine-start' && l.agent === 'builder'));
  assert.match(obs[0].why, /plain starts are not held/); assert.match(obs[1].why, /leaves out the user settings/);
  assert.equal(b.events.filter((e) => /guardrails \(observe\): engineStart would hold builder/.test(e)).length, 4);
  assert.deepEqual(await b.ledger.list({}), []);
});

test('the board, enforce: a weakening form waits for the owner; a plain start passes with its reading', async () => {
  const b = await board('enforce');
  const held = await b.sh('claude -p x --setting-sources project,local');
  assert.equal(held.decision, 'deny'); assert.match(held.reason, /Start an agent session the gate may not see/);
  assert.deepEqual(await b.sh('claude -p "summarise"'), { decision: 'pass' });
  const obs = await b.observed(); assert.equal(obs.filter((l) => l.wouldHold === 'engineStart').length, 1); assert.match(obs.at(-1).why, /plain starts are not held/);
  const twin = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'policy.json'), 'utf8'));
  assert.equal(twin.checks.engineStart, 'observe'); assert.ok(twin.classes.find((c) => c.id === 'engine-start'));
});

// ── the review of PR 136 ──
test('review 1: another settings home in front of the call, or an emptied environment, is read whatever else the line carries', () => {
  for (const c of ['HOME=/tmp/h claude "fix it"', 'CLAUDE_CONFIG_DIR=/tmp/c claude', 'CLAUDE_CONFIG_DIR=/tmp/c claude --resume abc', 'env -i claude "fix it"', 'HOME=/tmp/h codex "do it"', 'CODEX_HOME=/tmp/c codex',
    'XDG_CONFIG_HOME=/tmp/x claude --continue', 'export CLAUDE_CONFIG_DIR=/tmp/c; claude', 'env -u HOME claude "fix it"', 'env CODEX_HOME=/tmp/c codex "do it"']) {
    assert.equal(run(c, 'off').verdict, 'clear', `off: ${c}`); assert.equal(run(c, 'observe').wouldHold?.check, 'engineStart', `observe: ${c}`);
    const enf = run(c); assert.equal(enf.verdict, 'gate', `enforce: ${c} → ${enf.why}`); assert.equal(enf.cls, 'engine-start', c);
  }
  // the lines that send these calls to the rule only route: text that happens to line up is not held, in any mode
  for (const m of MODES) for (const c of ['env | grep claude', 'env | grep -i codex', 'HOME=/tmp/x npm test && echo claude', 'env FOO=1 node scripts/claude.mjs', 'export HOME=/tmp/x; ls ~/.claude', 'env | sort',
    'X="claude -p --bare"; echo "$X"', 'claude "fix it"', 'claude --resume abc', 'codex "do it"']) { const r = run(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.cls}: ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
});

test('review 2: codex e is exec: a plain start gets its reading, a weakening form behind it is held', () => {
  for (const m of ['observe', 'enforce']) { const r = run('codex e "do it"', m); assert.equal(r.verdict, 'clear', m); assert.equal(r.wouldHold?.check, 'engineStart', m); assert.match(r.wouldHold.why, /plain starts are not held/); }
  for (const c of ['CODEX_HOME=/tmp/c codex e "do it"', 'codex e --dangerously-bypass-approvals-and-sandbox x', 'codex e -s danger-full-access x', 'codex e -c hooks.enabled=false x']) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'engine-start'); }
});

test('review 3: a setting-sources flag given more than once must keep the user settings every time', () => {
  for (const c of ['claude -p x --setting-sources user --setting-sources project', 'claude -p x --setting-sources project --setting-sources user', 'claude --setting-sources=user,project --setting-sources=local -p x']) {
    const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.match(r.why, /leaves out the user settings/);
  }
  const ok = run('claude -p x --setting-sources user,project --setting-sources user,local'); assert.equal(ok.verdict, 'clear'); assert.equal(ok.wouldHold?.check, 'engineStart');
});

test('the fast-path lines of the check: every start reaches the Node step through the real shell grep, and they are route lines', () => {
  const lines = compileTriggers(policyAt('observe')).filter((t) => /claude|codex/.test(t.ere) && t.route);
  assert.equal(lines.length, 9);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-eng-')); const tfile = path.join(dir, 'triggers'); writeFileSync(tfile, lines.map((t) => t.ere).join('\n') + '\n');
  const grep = (command) => spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: JSON.stringify({ cwd: '/work/app', tool_name: 'Bash', tool_input: { command } }).replace(/\\[nt]/g, ' ').replace(/["'\\`]/g, '') }).status === 0;
  for (const c of ['HOME=/tmp/h claude "fix it"', 'CLAUDE_CONFIG_DIR=/tmp/c claude', 'env -i claude "fix it"', 'CODEX_HOME=/tmp/c codex', 'codex e "do it"', 'claude -p x', 'codex exec x', 'claude --settings /tmp/s.json']) assert.equal(grep(c), true, c);
  for (const c of ['ls ~/.claude', 'which claude', 'npm test', 'cat ~/.codex/config.toml']) assert.equal(grep(c), false, c);
});

test('the second read of PR 136: a start behind a variable or a substitution in program position is held', () => {
  // held on the first head as unreadable, clear on the head that made the lines route-only: the plainest ways to start
  // the program without writing its name where the parser looks for a program
  for (const c of ['X="claude -p x --bare"; $X', 'B=claude; $B -p x --bare', '$(which claude) -p x --bare', '"$(command -v claude)" -p x --bare', 'B=codex; $B exec --yolo x', 'C=claude; HOME=/tmp/h $C', 'E=$(which claude); "$E" --settings /tmp/s.json',
    'X="claude -p x"; eval "$X" --bare; $X']) {
    assert.equal(run(c, 'off').verdict, 'clear', `off: ${c}`);
    const obs = run(c, 'observe'); assert.equal(obs.verdict, 'clear', `observe: ${c}`); assert.equal(obs.wouldHold?.check, 'engineStart', `observe: ${c}`);
    const enf = run(c); assert.equal(enf.verdict, 'gate', `enforce: ${c} → ${enf.why}`); assert.equal(enf.check, 'engineStart', c);
  }
  // free in every mode: the variable is an argument, not the program; or no line of the check matched at all
  for (const m of MODES) for (const c of ['X="claude -p --bare"; echo "$X"', 'env | grep claude', 'HOME=/tmp/x npm test && echo claude', 'echo "claude -p is how it is done"', 'git commit -m "claude -p notes"', '$EDITOR notes.md', 'F=jq; $F --version',
    'MSG="claude --settings x"; scripts/task.sh comment 5 "$MSG"']) { const r = run(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.cls}: ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
});

// On the combined tree (the runner reading of #501 is in): the forms Mission Control's second read left for it.
test('a session start behind eval, xargs or a package runner is read by the runners check; a pipe into a shell is unreadable for this check', () => {
  const mk = (o) => ({ ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, o[n] || o.rest])) });
  const ctx = { home: '/home/u', boardRoot: '/work/board', repoRoot: () => null, git: () => null };
  const at = (c, p) => classify({ tool: 'Bash', command: c, cwd: '/work/app' }, p, ctx);
  const both = mk({ rest: 'enforce' }); const only = mk({ rest: 'observe', engineStart: 'enforce' }); const off = mk({ rest: 'enforce', engineStart: 'off' });
  for (const c of ['eval "claude -p x --bare"', 'echo x | xargs claude -p --bare', 'npx claude -p x --bare']) {
    const r = at(c, both); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'engine-start', c); assert.equal(r.check, 'runners', c);
    assert.equal(at(c, only).verdict, 'clear', `runners observing: ${c}`); assert.equal(at(c, only).wouldHold?.check, 'runners', c);
  }
  for (const c of ['echo "claude -p x --bare" | sh', 'printf "%s" "codex exec x --yolo" | bash']) {
    const r = at(c, only); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.check, 'engineStart', c);
    assert.equal(at(c, off).verdict, 'clear', `check off: ${c}`);
  }
  // free: a pipe into a shell with no session start named, and the name piped into a reader
  for (const c of ['echo "ls -la" | sh', 'echo "claude -p x --bare" | cat', 'grep -rn "claude -p" docs | head -n 5']) assert.equal(at(c, both).verdict, 'clear', c);
});
