import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { triggerLines, compileTriggers, normalizeForTriggers, DEFAULT_POLICY } from '../src/gates.mjs';
import { hookInput, hookOutput, localVerdict, localAgent } from '../scripts/gate-hook.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
// a board that is never there: every hit must fail closed
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '' };
const call = (obj, extra = {}) => spawnSync('sh', [HOOK], { input: JSON.stringify(obj), env: { ...env, ...extra }, encoding: 'utf8' });
const bash = (command, ev = 'PreToolUse') => ({ hook_event_name: ev, tool_name: 'Bash', tool_input: { command }, cwd: ROOT, session_id: 's1' });

test('the shipped default trigger file is exactly the default policy\'s trigger lines', () => {
  assert.deepEqual(readFileSync(path.join(ROOT, 'scripts', 'gate-triggers.default'), 'utf8').trim().split('\n'), triggerLines(DEFAULT_POLICY));
});

test('grep -iE and the JS twins agree on every sample (the shell and the board decide the same hits)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-'));
  const file = path.join(dir, 'triggers');
  writeFileSync(file, triggerLines(DEFAULT_POLICY).join('\n') + '\n');
  const js = compileTriggers(DEFAULT_POLICY);
  const samples = ['gh pr merge 3', 'gh "pr" merge 3', 'git push origin main', 'git status', 'ls -la', 'vercel --prod', 'python3 x.py --commit',
    'python3 x.py --committed', 'rm -rf build', 'rm -f x', 'launchctl kickstart -k gui/501/x', 'crontab -l', 'npm test', 'echo deploy-notes',
    'cat ~/.claude/settings.json', 'curl -X POST https://slack.com/api/chat.postMessage', 'psql -c "DROP TABLE x"', '$g pr merge 1'];
  for (const s of samples) {
    const text = normalizeForTriggers(`tool_name:Bash ${s}`);
    const sh = spawnSync('grep', ['-qiE', '-f', file], { input: text }).status === 0;
    const node = js.some((t) => t.re.test(text));
    assert.equal(sh, node, `"${s}": grep ${sh} vs js ${node}`);
  }
});

test('fast path: a call with no trigger prints nothing, exits 0, well inside the 50 ms budget', () => {
  const input = JSON.stringify(bash('git status && ls -la src && node --version'));
  const times = [];
  for (let i = 0; i < 60; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('sh', [HOOK], { input, env, encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  assert.ok(median < 35, `median ${median.toFixed(1)} ms`);
});

test('fail closed: a gated call with the board down is denied; non-gated calls are untouched', () => {
  const r = call(bash('gh pr merge 12 --merge'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'deny'); assert.match(out.permissionDecisionReason, /board unreachable.*fail closed/);
  // a hit the parser clears (feature-branch push) passes even with the board down
  assert.equal(call(bash('echo "remember to gh pr merge later"')).stdout, '');
});

test('fail closed: if the Node step itself fails on a hit, the call is denied — but never on PostToolUse', () => {
  const r = call(bash('vercel --prod'), { GATE_NODE: '/usr/bin/false' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /gate check failed \(fail closed\)/);
  assert.equal(call(bash('vercel --prod', 'PostToolUse'), { GATE_NODE: '/usr/bin/false' }).stdout, '');
});

test('MCP and file tools reach the gate too (store writes, sends, the gate\'s own files)', () => {
  const mcp = call({ hook_event_name: 'PreToolUse', tool_name: 'mcp__shop__Shopify__graphql_mutation', tool_input: { query: 'mutation {}' }, cwd: ROOT });
  assert.equal(JSON.parse(mcp.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const read = call({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(ROOT, 'data', 'mesh-decision-token') }, cwd: ROOT });
  assert.equal(JSON.parse(read.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(call({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(ROOT, 'README.md') }, cwd: ROOT }).stdout, '');
});

test('hook input: Claude and Codex shapes; output: allow/deny JSON, nothing for pass or PostToolUse', () => {
  const c = hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w', session_id: 's' }, { CMUX_WORKSPACE_ID: 'W1', CMUX_AGENT_LAUNCH_KIND: 'claude' });
  assert.deepEqual(c, { event: 'pre', engine: 'claude', tool: 'Bash', command: 'ls', filePath: null, cwd: '/w', session: 's', workspaceId: 'W1' });
  const x = hookInput({ hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['gh', 'pr', 'merge', '1'] }, turn_id: 't', cwd: '/w' }, {});
  assert.equal(x.engine, 'codex'); assert.deepEqual(x.command, ['gh', 'pr', 'merge', '1']);
  assert.equal(localVerdict({ ...x, cwd: '/w' }).verdict, 'gate');
  assert.equal(hookInput({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }, {}).event, 'post');
  assert.deepEqual(JSON.parse(hookOutput('deny', 'why')), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'why' } });
  assert.equal(hookOutput('pass', ''), ''); assert.equal(hookOutput('allow', 'x', 'post'), '');
});

test('fix 1: board down, the local verdict honors mode and enforceFor; an unknown identity is enforced', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'lv-'));
  const mk = (p) => { writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ ...DEFAULT_POLICY, ...p })); };
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'agents.json'), JSON.stringify({ agents: [{ name: 'pilot', workspaceId: 'W-P' }, { name: 'other', workspaceId: 'W-O' }] }));
  const v = (ws) => localVerdict({ tool: 'Bash', command: 'gh pr merge 1', cwd: '/w', workspaceId: ws }, { root }).verdict;
  mk({ enforceFor: ['pilot'] });
  assert.equal(localAgent('w-p', { root }), 'pilot');
  assert.equal(v('W-P'), 'gate'); assert.equal(v('W-O'), 'clear'); assert.equal(v('W-UNKNOWN'), 'gate'); assert.equal(v(null), 'gate');
  mk({ mode: 'observe' }); assert.equal(v('W-P'), 'clear');
  mk({ mode: 'off' }); assert.equal(v('W-P'), 'clear');
});

// ── paths with spaces (#343 blocker): a checkout can live in a folder like "~/My Zulu" ──
import { cpSync } from 'node:fs';
function spacedCopy() {
  const dir = path.join(mkdtempSync(path.join(os.tmpdir(), 'gate space-')), 'Repo With Space');
  for (const f of ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'scripts/merge-hooks.mjs', 'src/gates.mjs', 'examples/policy.json', 'examples/claude/guardrails-hooks.json.tmpl'])
    cpSync(path.join(ROOT, f), path.join(dir, f));
  return dir;
}

test('from a path with a space: a hit with the board down is DENIED, a cleared hit and a non-hit stay silent', () => {
  const dir = spacedCopy();
  const hook = path.join(dir, 'scripts', 'gate-hook.sh');
  const run = (command) => spawnSync('sh', [hook], { input: JSON.stringify(bash(command)), env, encoding: 'utf8' });
  const hit = run('gh pr merge 12 --merge');
  assert.equal(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(hit.stdout).hookSpecificOutput.permissionDecisionReason, /board unreachable/);
  assert.equal(run('echo "gh pr merge later"').stdout, '');
  assert.equal(run('git status').stdout, '');
});

test('silence is never an allow: a Node step that exits 0 with no output is denied', () => {
  const dir = spacedCopy();
  const quiet = path.join(dir, 'quiet node');
  writeFileSync(quiet, '#!/bin/sh\ncat >/dev/null\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh')], { input: JSON.stringify(bash('vercel --prod')), env: { ...env, GATE_NODE: quiet }, encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('from a path with a space: merge-hooks.mjs actually runs (dry run reports, apply writes)', () => {
  const dir = spacedCopy();
  const tpl = path.join(dir, 'tpl.json');
  writeFileSync(tpl, readFileSync(path.join(dir, 'examples/claude/guardrails-hooks.json.tmpl'), 'utf8').replace(/__REPO__/g, dir).replace(/__NODE_BIN_DIR__/g, '/n'));
  const settings = path.join(dir, 'home dir', 'settings.json');
  mkdirSync(path.dirname(settings), { recursive: true }); writeFileSync(settings, '{}');
  const mh = path.join(dir, 'scripts', 'merge-hooks.mjs');
  const dry = spawnSync(process.execPath, [mh, tpl, settings, '--dry-run'], { encoding: 'utf8' });
  assert.match(dry.stdout, /would\s+merge 2 hook\(s\)/);
  const apply = spawnSync(process.execPath, [mh, tpl, settings], { encoding: 'utf8' });
  assert.match(apply.stdout, /done\s+2 hook\(s\) merged/);
  assert.equal((readFileSync(settings, 'utf8').match(/gate-hook\.sh/g) || []).length, 2);
});

test('every script main guard compares real paths (spaces and symlinks in the checkout path)', () => {
  // a file scan, not git grep: the published edition has no .git
  const lines = [];
  for (const d of ['scripts', 'src', 'bin']) {
    let names = []; try { names = readdirSync(path.join(ROOT, d)); } catch { continue; }
    for (const n of names) {
      const f = path.join(ROOT, d, n);
      if (!statSync(f).isFile()) continue;
      readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (l.includes('import.meta.url ===')) lines.push(`${d}/${n}:${i + 1}: ${l.trim()}`); });
    }
  }
  assert.ok(lines.length >= 10);
  const bad = lines.filter((l) => !l.includes('pathToFileURL(realpathSync(process.argv[1])).href'));
  assert.deepEqual(bad, []);
});
