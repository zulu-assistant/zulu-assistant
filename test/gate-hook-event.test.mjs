// The gate hook must never turn an answer into silence because of TEXT in the call (#515).
// The shell script used to look for the after-call event's name anywhere in the raw hook input,
// which holds the call's own words: a held call whose command, comment or tool input spelled that
// name ended with no output, and no output from a before-call hook means the call runs.
// These tests feed the real scripts/gate-hook.sh the hook JSON as Claude Code sends it, in both
// field orders, board down: every held call must come back denied, whatever its text says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mentionRows } from '../scripts/gate-replay.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
const hook = (obj, extra = {}) => spawnSync('sh', [HOOK, '--env-board'], { input: typeof obj === 'string' ? obj : JSON.stringify(obj), env: { ...env, ...extra }, encoding: 'utf8' });
const decision = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'silent');
const POST = 'PostToolUse';
/** The same call in the field orders Claude Code is known to use: the event before the call's input, and after it. */
const shapes = (event, tool, input, more = {}) => [
  { session_id: 's', transcript_path: '/t.jsonl', cwd: ROOT, hook_event_name: event, tool_name: tool, tool_input: input, ...more },
  { session_id: 's', cwd: ROOT, tool_name: tool, tool_input: input, ...more, hook_event_name: event },
];
const HELD = 'gh pr merge 5 --squash';

test('a held shell call is denied whatever its text says about events', () => {
  const texts = [
    HELD,
    `${HELD} # ${POST}`,                                           // in a trailing comment
    `echo ${POST} && ${HELD}`,                                     // in an echo in front
    `echo "${POST}"; ${HELD}`,                                     // in a quoted string
    `cat <<'EOF'\n${POST}\nEOF\n${HELD}`,                           // in a heredoc
    `${HELD} # "hook_event_name":"${POST}"`,                       // the key and value spelled out, as text
    `${HELD} # \\"hook_event_name\\":\\"${POST}\\"`,
  ];
  for (const command of texts) for (const obj of shapes('PreToolUse', 'Bash', { command, description: `uses ${POST}` })) {
    const r = hook(obj);
    assert.equal(r.status, 0); assert.equal(decision(r), 'deny', command);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /board unreachable/, 'the Node step\'s own answer came through');
  }
  // a call that is not held stays a silent pass, with or without the word
  for (const command of ['ls -la', `echo ${POST}`]) for (const obj of shapes('PreToolUse', 'Bash', { command })) assert.equal(decision(hook(obj)), 'silent', command);
});

test('a held tool call whose input carries the name, as a value or as a key of its own, is denied', () => {
  const tool = 'mcp__claude_ai_Shopify__graphql_mutation';
  for (const input of [{ query: `mutation { x } # ${POST}` }, { query: 'mutation { x }', note: POST }, { query: 'mutation { x }', hook_event_name: POST }, { hook_event_name: POST, query: 'mutation { x }' }])
    for (const obj of shapes('PreToolUse', tool, input)) assert.equal(decision(hook(obj)), 'deny', JSON.stringify(input));
});

test('a call that already ran is never answered: the real after-call input stays silent', () => {
  for (const obj of shapes(POST, 'Bash', { command: HELD }, { tool_response: { stdout: 'merged' } })) {
    const r = hook(obj);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
});

test('when the Node step cannot answer, the shell reads the event from the input\'s own key only', () => {
  const broken = { GATE_NODE: '/nonexistent/node' };
  // a call that has not run: denied, and no text in it changes that
  for (const command of [HELD, `${HELD} # ${POST}`, `${HELD} # "hook_event_name":"${POST}"`]) for (const obj of shapes('PreToolUse', 'Bash', { command })) {
    const r = hook(obj, broken);
    assert.equal(decision(r), 'deny', command); assert.match(r.stdout, /the gate check failed \(fail closed\)/);
  }
  // a call that already ran: nothing to deny, in both field orders and with a space after the colon
  for (const obj of shapes(POST, 'Bash', { command: HELD }, { tool_response: { stdout: '' } })) assert.equal(hook(obj, broken).stdout, '');
  assert.equal(hook(`{"hook_event_name": "${POST}","tool_name":"Bash","tool_input":{"command":"${HELD}"}}`, broken).stdout, '');
  // a tool's own input with a real key of that name: the key occurs twice, so the shell does not
  // believe either and answers as for a call that has not run. For a before-call event that is the
  // deny it must be; for an after-call event it is a deny nobody acts on (the call has run).
  const tool = 'mcp__claude_ai_Shopify__graphql_mutation';
  for (const obj of shapes('PreToolUse', tool, { hook_event_name: POST, query: 'mutation { x }' })) assert.equal(decision(hook(obj, broken)), 'deny');
  for (const obj of shapes(POST, tool, { hook_event_name: 'PreToolUse', query: 'mutation { x }' })) assert.equal(decision(hook(obj, broken)), 'deny');
});

test('the script holds no test of the raw input for an event\'s bare name', () => {
  const sh = readFileSync(HOOK, 'utf8').split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.doesNotMatch(sh, /\*PostToolUse\*|\*PreToolUse\*/);
  assert.match(sh, /\*'"hook_event_name"'\*'"hook_event_name"'\*\) ;;/, 'the key twice is not believed');
  assert.ok(sh.indexOf('[ $code -eq 3 ] && exit 0') < sh.indexOf('post=0'), 'the Node step\'s "nothing to say" comes first');
});

test('gate-replay --mentions --list: when, who, which event and the answer for each past check that names a word, never its text', () => {
  const entries = [
    { at: '2026-01-05T10:00:00.000Z', event: 'pre', agent: 'builder', tool: 'Bash', decision: 'deny', task: 7, gate: 'g2', command: `gh pr merge 5 # ${POST}` },
    { at: '2026-01-05T10:01:00.000Z', event: 'post', agent: 'helper', tool: 'Bash', decision: 'pass', observed: true, command: 'x', full: `echo ${POST.toLowerCase()} and a long text` },
    { at: '2026-01-05T10:02:00.000Z', event: 'pre', agent: 'helper', tool: 'Bash', decision: 'pass', command: 'ls' },
  ];
  const rows = mentionRows(entries, POST);
  assert.deepEqual(rows, [
    { at: '2026-01-05T10:00:00.000Z', agent: 'builder', event: 'pre', tool: 'Bash', decision: 'deny', task: 7, gate: 'g2' },
    { at: '2026-01-05T10:01:00.000Z', agent: 'helper', event: 'post', tool: 'Bash', decision: 'pass', observed: true },
  ]);
  for (const r of rows) assert.equal('command' in r || 'full' in r, false);
});
