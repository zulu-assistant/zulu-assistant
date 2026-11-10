import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, normalizeForTriggers, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';
import { readChecks, mentions } from '../scripts/gate-replay.mjs';

// Task #499 (review of PR 114, finding 4): the pre-filter line for a single guarded file was its folder
// and name side by side, so a call that reached the file another way was answered "no trigger" and
// never got to the rule. The line is now the bare name. Fixture: board checkout /home/u/Board Dir.
// Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
const L = '/home/u/Board Dir'; const NAME = 'mesh-decision-token';
const ctx = () => { const c = { home: '/home/u', boardRoot: L, ignoreCase: false, repoRoot: () => L, git: () => null }; c.triggers = compileTriggers(policy, c); return c; };
const bash = (command, cwd = L) => classify({ tool: 'Bash', command, cwd }, policy, ctx());
const file = (tool, filePath) => classify({ tool, command: '', filePath, cwd: L }, policy, ctx());

// [command, the folder the call is made from]
const HELD = [
  [`cat data/${NAME}`, L], [`cat data/./${NAME}`, L], [`cat data//${NAME}`, L], [`cat ./data/../data/${NAME}`, L],
  [`cd data && cat ${NAME}`, L], [`(cd data; cat ${NAME})`, L], [`cat ${NAME}`, `${L}/data`], [`head -c 20 ./${NAME}`, `${L}/data`], [`cp ${NAME} /tmp/t`, `${L}/data`],
  [`cat "/System/Volumes/Data${L}/data/${NAME}"`, '/tmp'], [`cd /System/Volumes/Data/home/u/"Board Dir"/data && cat ${NAME}`, '/tmp'],
  ['cd overlay && echo x > policy.json', L], ['echo x > overlay/./policy.json', L], ['sed -i "" s/a/b/ policy.json', `${L}/overlay`],
  ['cd data/guardrails && cat grants.json', L], ['cat grants.json', `${L}/data/guardrails`],
  ['cd ~/.claude && echo "{}" > settings.json', L], ['echo x > hooks.json', '/home/u/.codex'],
];
const FREE = [[`cat ${NAME}`, '/work/app'], ['cat policy.json', '/work/app'], ['echo "{}" > settings.json', '/work/app/.vscode'], [`cat data/${NAME}.md`, L], ['ls data', L], ['cat hooks.json', '/work/app'],
  ['cat settings.json', '/home/u/.claude'], ['git status', L]];

test('a guarded file is held however the call reaches it: dot segments, doubled slashes, a cd into its folder, a call made from inside it', () => {
  for (const [c, cwd] of HELD) { const r = bash(c, cwd); assert.equal(r.verdict, 'gate', `${c} (from ${cwd}) → ${r.why}`); assert.equal(r.cls, 'self', c); }
  for (const [c, cwd] of FREE) assert.equal(bash(c, cwd).verdict, 'clear', `${c} (from ${cwd})`);
  for (const [tool, f] of [['Read', `${L}/data/./${NAME}`], ['Read', `${L}/data//${NAME}`], ['Edit', `${L}/overlay/./policy.json`], ['Read', `/System/Volumes/Data${L}/data/${NAME}`],
    ['Write', `${L}/data/guardrails/../guardrails/grants.json`]]) assert.equal(file(tool, f).cls, 'self', `${tool} ${f}`);
  assert.equal(file('Read', `${L}/docs/policy.json.md`).verdict, 'clear');
});

test('the lines: one file is its bare name, a folder its path with no closing slash; grep and the JS twins agree on every form', () => {
  const lines = triggerLines(policy);
  // a single file's line is its bare name at a path boundary (webhooks.json is not hooks.json); a folder's is its path
  const bare = (n) => `(^|[^[:alnum:]_.-])${n}([^[:alnum:]_-]|$)`;
  for (const want of [bare(NAME), bare('policy\\.json'), bare('settings\\.json'), bare('hooks\\.json'), 'data/guardrails', 'Library/LaunchAgents']) assert.ok(lines.includes(want), want);
  for (const gone of [NAME, 'settings\\.json', 'hooks\\.json']) assert.ok(!lines.includes(gone), `unanchored: ${gone}`);
  const hit = (text) => compileTriggers(policy).some((t) => t.path && t.re.test(normalizeForTriggers(text)));
  for (const t of ['cat webhooks.json', 'cat app-settings.json', 'cat qwen.config.toml', `cat x${NAME}`]) assert.equal(hit(t), false, t);
  for (const t of ['cat hooks.json', 'cat ./settings.json', 'cat "a/settings.json"', `cat data/${NAME}`]) assert.equal(hit(t), true, t);
  for (const gone of [`data/${NAME}`, 'overlay/policy\\.json', '\\.claude/settings\\.json', 'data/guardrails/']) assert.ok(!lines.includes(gone), gone);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-pre-')); const tfile = path.join(dir, 'triggers'); writeFileSync(tfile, lines.join('\n') + '\n');
  const js = compileTriggers(policy);
  for (const [command, cwd] of [...HELD, ...FREE]) {
    const sh = spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: normalizeForTriggers(JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } })) }).status === 0;
    const node = js.some((t) => t.re.test(normalizeForTriggers(`tool_name:Bash ${command} `)));
    if (node) assert.equal(sh, true, `the shell must send what the board would read: ${command}`);
  }
  // every held form reaches the Node step
  for (const [command, cwd] of HELD) assert.equal(spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: normalizeForTriggers(JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } })) }).status, 0, command);
});

test('real hook JSON, board down: each form is denied from the checkout it guards; a same-named file elsewhere passes', () => {
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
  const hook = (obj) => { const out = spawnSync('sh', [path.join(ROOT, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', ...obj }), env, encoding: 'utf8' }).stdout; return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  const sh = (command, cwd = ROOT) => hook({ cwd, tool_name: 'Bash', tool_input: { command, description: 'x' } });
  for (const c of [`cat data/./${NAME}`, `cat data//${NAME}`, `cd data && cat ${NAME}`, `(cd data; cat ${NAME})`, 'cd examples && echo x > policy.json']) assert.equal(sh(c), 'deny', c);
  assert.equal(sh(`cat ${NAME}`, path.join(ROOT, 'data')), 'deny');
  assert.equal(hook({ cwd: ROOT, tool_name: 'Read', tool_input: { file_path: path.join(ROOT, 'data', '.', NAME).replace(`data${path.sep}${NAME}`, `data${path.sep}.${path.sep}${NAME}`) } }), 'deny');
  assert.equal(hook({ cwd: ROOT, tool_name: 'Read', tool_input: { file_path: `${ROOT.replace(/\/$/, '')}/data//${NAME}` } }), 'deny');
  if (process.platform === 'darwin') assert.equal(sh(`cat "/System/Volumes/Data${path.join(ROOT, 'data', NAME)}"`, os.tmpdir()), 'deny');
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'pre-else-'));
  assert.equal(sh(`cat ${NAME}`, elsewhere), 'pass'); assert.equal(sh('cat policy.json', elsewhere), 'pass'); assert.equal(sh('git status'), 'pass');
});

test('replay --mentions: how often recorded calls name a word, as a rough measure of what a bare-name line will send to the board', () => {
  const line = (o) => JSON.stringify({ at: '2026-01-05T10:00:00.000Z', event: 'pre', agent: 'builder', tool: 'Bash', decision: 'pass', cwd: '/work/app', ...o });
  const log = [line({ command: 'cat .vscode/settings.json' }), line({ at: '2026-01-06T10:00:00.000Z', command: 'gh pr view 5' }), line({ at: '2026-01-07T10:00:00.000Z', command: 'x', full: 'echo y > Settings.JSON' }),
    line({ event: 'post', command: 'cat settings.json' })].join('\n');
  const m = mentions(readChecks(log), ['settings.json', 'policy.json']);
  assert.deepEqual(m.counts, { 'settings.json': 2, 'policy.json': 0 }); assert.equal(m.total, 3); assert.equal(m.days.toFixed(1), '2.0');
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gate-replay.mjs'), '--file', (() => { const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'men-')), 'c.jsonl'); writeFileSync(f, log + '\n'); return f; })(), '--mentions', 'settings.json,policy.json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.match(cli.stdout, /settings\.json: 2 of 3 recorded checks/); assert.match(cli.stdout, /only calls that already reached the board/);
});

// ── a guarded file, however the call reaches it ──
const APP = '/work/app';
const py = (body) => `python3 - <<'PY'\n${body}\nPY`;
const nodeDoc = (body) => `node - <<'JS'\n${body}\nJS`;
test('review 1 and 2: a bare name routes, it never decides. A script elsewhere that only names such a file is clear, as before', () => {
  const clear = [
    [py('import json\nprint(json.load(open(".vscode/settings.json")))'), APP],                      // B1
    [nodeDoc('const s = require("./app-settings.json"); console.log(s)'), APP],                        // B2
    [nodeDoc('const r = await fetch("https://x.example/admin/api/2025-01/webhooks.json")'), APP],      // B3
    [nodeDoc('const h = require("./hooks.json"); console.log(h)'), APP],                               // B4
    [py('import tomllib\nprint(tomllib.load(open("supabase/config.toml","rb")))'), APP],              // B5
    [py('import os\nprint(os.listdir(os.path.expanduser("~/Library/LaunchAgents")))'), APP],          // B6
    [py(`print("the file ${NAME} holds the key")`), '/home/u/wt-9'],                                    // B10
    ['CFG=.vscode/settings.json; wc -c "$CFG"', APP],                                                   // B17
    ['P=~/Library/LaunchAgents; grep -l selfheal $P/*.plist', APP],
  ];
  for (const [c, cwd] of clear) { const r = bash(c, cwd); assert.equal(r.verdict, 'clear', `${JSON.stringify(c)} (from ${cwd}) → ${r.why}`); }
  // …and the same bodies where the guarded place is really meant
  const heldRows = [
    [`cd data && ${py(`print(open("${NAME}").read())`)}`, L], [py(`print(open("${NAME}").read())`), `${L}/data`], [py(`print(open("data/${NAME}").read())`), L],
    [`cd ~/.claude && ${py('open("settings.json","w").write("{}")')}`, APP], [py('open("settings.json","w").write("{}")'), '/home/u/.claude'],
    [py('import os\nos.remove(os.path.expanduser("~/.claude/settings.json"))'), APP], [nodeDoc('require("fs").writeFileSync("overlay/policy.json", "{}")'), L],
    ['CFG=~/.claude/settings.json; echo "{}" > "$CFG"', APP],
    // the rules file at a checkout's top has no folder in its guarded path: its name alone decided on main too, and still does
    [py('print(open("policy.json").read())'), APP],
  ];
  for (const [c, cwd] of heldRows) { const r = bash(c, cwd); assert.equal(r.verdict, 'gate', `${JSON.stringify(c)} (from ${cwd}) → ${r.why}`); }
});

test('review 3: going into a write-guarded folder is not a write; what is written there still is', () => {
  const LA = '/home/u/Library/LaunchAgents';
  for (const c of ['cd ~/Library/LaunchAgents', 'cd ~/Library/LaunchAgents && for f in *.plist; do plutil -p "$f"; done', 'cd ~/Library/LaunchAgents/ && ls', 'pushd ~/Library/LaunchAgents && ls && popd']) assert.equal(bash(c, APP).verdict, 'clear', c);
  assert.equal(bash('ls', LA).verdict, 'clear');
  for (const [c, cwd] of [['cd ~/Library/LaunchAgents && cp /tmp/x.plist .', APP], ['cp /tmp/x.plist .', LA], ['echo x > com.x.plist', LA], ['cp /tmp/x.plist ~/Library/LaunchAgents/', APP]]) { const r = bash(c, cwd); assert.equal(r.cls, 'schedule', `${c} → ${r.why}`); }
});

test('review 4: an interpreter program run from inside a guarded folder is opaque; a plain listing there is not', () => {
  const G = `${L}/data/guardrails`;
  for (const [c, cwd] of [[py('print(open("grants.json").read())'), G], [`cd data/guardrails && ${py('import glob\nprint(glob.glob("*"))')}`, L], [nodeDoc('console.log(require("fs").readdirSync("."))'), `${G}/dry`],
    [py('import os\nos.listdir(".")'), '/home/u/Library/LaunchAgents']]) { const r = bash(c, cwd); assert.equal(r.verdict, 'gate', `${JSON.stringify(c)} (from ${cwd}) → ${r.why}`); }
  assert.equal(bash('ls', `${L}/data`).verdict, 'clear'); assert.equal(bash(py('print(1)'), `${L}/data`).verdict, 'clear'); assert.equal(bash(py('print(1)'), APP).verdict, 'clear');
});

test('review 6: a dotted or doubled path into a guarded folder is seen by the shell line too', () => {
  const lines = triggerLines(policy); const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-dot-')); const tfile = path.join(dir, 'triggers'); writeFileSync(tfile, lines.join('\n') + '\n');
  const sed = (text) => spawnSync('sh', ['-c', `sed -e 's/\\\\[nt]/ /g' -e 's/["\`\\\\]//g' -e "s/'//g" -e 's#/\\(\\./\\)\\{1,\\}#/#g' -e 's#\\([^:/]\\)//*#\\1/#g'`], { input: text, encoding: 'utf8' }).stdout;
  for (const c of ['cat data/./guardrails/grants.json', 'cat data//guardrails/grants.json', 'ls data/././guardrails/', 'cat "data/./guardrails/x"']) {
    const json = JSON.stringify({ cwd: L, tool_name: 'Bash', tool_input: { command: c } });
    assert.equal(sed(json), normalizeForTriggers(json), `shell and JS strip alike: ${c}`);
    assert.equal(spawnSync('/usr/bin/grep', ['-qiE', '-f', tfile], { input: sed(json) }).status, 0, c);
    assert.equal(bash(c).cls, 'self', c);
  }
  assert.equal(normalizeForTriggers('curl https://example.com//x'), 'curl https://example.com/x');   // the // after a scheme stays
  // the hook script carries the same two expressions
  const hookText = readFileSync(path.join(ROOT, 'scripts', 'gate-hook.sh'), 'utf8');
  assert.ok(hookText.includes("-e 's#/\\(\\./\\)\\{1,\\}#/#g' -e 's#\\([^:/]\\)//*#\\1/#g'"));
});

test('an observing check never changes the answer: its lines route the call and give a reading, they do not hold it', () => {
  const at = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, mode])) });
  const run = (command, cwd, mode) => { const p = at(mode); const c = { home: '/home/u', boardRoot: L, ignoreCase: false, repoRoot: () => L, git: () => null }; c.triggers = compileTriggers(p, c); return classify({ tool: 'Bash', command, cwd }, p, c); };
  const rows = [
    [py('import os\nprint(os.listdir(os.path.expanduser("~/.config/cmux/")))'), APP], [py('print(open("/home/u/.cmuxterm/claude-hook-sessions.json").read())'), APP],
    [py('import os\nprint(os.listdir(".git/hooks/"))'), APP], [py('print(open("/home/u/.zshenv").read())'), APP], [py('print(open("/home/u/.codex/config.toml").read())'), APP],
    ['H=.git/hooks/pre-commit; wc -c "$H"', APP], ['Z=~/.zshenv; wc -c "$Z"', APP], [py('print("next: secret set, then the rest")'), APP], [nodeDoc('console.log("repo delete")'), APP],
  ];
  for (const [c, cwd] of rows) {
    const off = run(c, cwd, 'off'); const obs = run(c, cwd, 'observe');
    assert.equal(obs.verdict, off.verdict, `observe must answer like off: ${JSON.stringify(c)} → ${obs.why}`);
    assert.equal(off.verdict, 'clear', JSON.stringify(c));
  }
  // at enforce the same lines may decide, and the hold says which check it came from
  const enf = run(py('print(open("/home/u/.zshenv").read())'), APP, 'enforce'); assert.equal(enf.verdict, 'gate'); assert.equal(enf.check, 'selfProtect');
  assert.equal(run(py('print(open("/home/u/.zshenv").read())'), APP, 'observe').wouldHold?.check, 'selfProtect');
  // lines no check owns decide as they always did
  for (const m of ['off', 'observe']) assert.equal(run(py('import subprocess\nsubprocess.run(["gh","pr","merge","5"])'), APP, m).verdict, 'gate', m);
});
