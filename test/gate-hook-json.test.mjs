import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// #343 pilot failure (b): `… && node rename.mjs --commit` ran ungated. The flag trigger only accepted a
// space after the flag, but in the hook's JSON a flag that ENDS the command is followed by `",` / `"}`.
// These tests feed the real gate-hook.sh the JSON exactly as Claude Code sends it — with the action at
// the end of the command, mid-command, and with `command` as the last field — board down, so every
// gated call must come back denied (fail closed) and nothing else may.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '' };

const shapes = (command) => [
  { session_id: 's', transcript_path: '/t.jsonl', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } },
  { session_id: 's', cwd: ROOT, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } },           // command last → `"}`
  { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, timeout: 120000, description: 'y' }, cwd: ROOT },
];
const hook = (obj) => spawnSync('sh', [HOOK], { input: JSON.stringify(obj), env, encoding: 'utf8' });
const decision = (obj) => { const r = hook(obj); return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'pass'; };

const GATED = [
  'node rename.mjs --commit',
  'cd ~/"My Zulu/data/handoffs/x-1" && node rename.mjs --commit',
  'python3 scripts/archive.py --apply',
  'bash import.sh --live',
  './publish.sh --go',
  'npx tsx sync.ts --execute',
  'node build.mjs --commit=all',
  'gh pr merge 5',
  'gh pr merge 5 --merge --delete-branch',
  'vercel --prod',
  'git push origin main',
  'git push --force',
  'launchctl bootout gui/501/com.example.web',
  'crontab -r',
  'rm -rf ~/Downloads/x',
  'rm -rf /tmp/other',
  'curl -X POST https://slack.com/api/chat.postMessage -d @msg.json',
  'gh secret set TOKEN',
];
const FREE = ['git status', 'ls -la', 'node --test', 'gh pr view 5', 'npm test', 'python3 scripts/archive.py'];

for (const command of GATED) {
  test(`real hook JSON, board down: denied — ${command}`, () => {
    for (const s of shapes(command)) assert.equal(decision(s), 'deny', JSON.stringify(s.tool_input));
  });
}

test('real hook JSON: ordinary commands stay silent', () => {
  for (const command of FREE) for (const s of shapes(command)) assert.equal(decision(s), 'pass', command);
});

test('MCP and file tools in real hook JSON (arguments after the name) are denied too', () => {
  assert.equal(decision({ hook_event_name: 'PreToolUse', tool_name: 'mcp__shop__Shopify__graphql_mutation', tool_input: { query: 'mutation {x}' }, cwd: ROOT }), 'deny');
  assert.equal(decision({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(ROOT, 'data', 'mesh-decision-token') }, cwd: ROOT }), 'deny');
});
