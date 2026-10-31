import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, summarize } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { cmdHash, canonicalJson, describeToolCall, HASH_VERSION, DEFAULT_POLICY } from '../src/gates.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

// A grant binds the exact call. For non-shell tools that is the whole tool input:
// two different mutations on one MCP tool, or two different edits of one file, never share a grant.
const MUTATE = 'mcp__shop__Shopify__graphql_mutation';

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate input-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'),
    ownerId: OWNER.id, identifyWs: async () => 'builder', git: () => null, home: '/home/u', prInfo: async () => null });
  const task = await ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const call = (tool, toolInput, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool, toolInput, filePath: toolInput.file_path || null, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const approve = async (gate) => {
    const r = await ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true });
    await svc.afterDecision(r.task, gate);
  };
  return { dir, ledger, svc, task, call, approve };
}

test('canonical JSON: key order never matters, values always do; the hash version is bound', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 's' } }), canonicalJson({ a: { c: 's', d: [1, { x: 1, y: 2 }] }, b: 1 }));
  assert.notEqual(canonicalJson({ a: 'x' }), canonicalJson({ a: 'x ' }));
  const h = (toolInput) => cmdHash({ cwd: '/w', tool: MUTATE, toolInput });
  assert.equal(h({ query: 'mutation A', variables: { id: 1 } }), h({ variables: { id: 1 }, query: 'mutation A' }));
  assert.notEqual(h({ query: 'mutation A', variables: { id: 1 } }), h({ query: 'mutation A', variables: { id: 2 } }));
  assert.equal(HASH_VERSION, 'gate-v2');
  // a shell command still binds its text, not its description/timeout
  assert.equal(cmdHash({ cwd: '/w', command: 'gh pr merge 1' }), cmdHash({ cwd: '/w', command: 'gh pr merge 1', toolInput: { command: 'gh pr merge 1', description: 'x' } }));
});

test('the hook sends the whole input of a non-shell tool (and nothing extra for a shell)', () => {
  const m = hookInput({ hook_event_name: 'PreToolUse', tool_name: MUTATE, tool_input: { query: 'mutation A', variables: { id: 1 } } }, {});
  assert.deepEqual(m.toolInput, { query: 'mutation A', variables: { id: 1 } });
  const e = hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/w/p.json', old_string: 'a', new_string: 'b' } }, {});
  assert.equal(e.filePath, '/w/p.json'); assert.equal(e.toolInput.new_string, 'b');
  assert.equal(hookInput({ tool_name: 'Bash', tool_input: { command: 'ls' } }, {}).toolInput, undefined);
});

test('two different mutations on the same MCP tool do not share a grant', async () => {
  const s = await setup();
  const A = { query: 'mutation { productUpdate(input:{id:"gid://p/1", title:"A"}) { product { id } } }' };
  const B = { query: 'mutation { productDelete(input:{id:"gid://p/1"}) { deletedProductId } }' };
  const first = await s.call(MUTATE, A);
  assert.equal(first.decision, 'deny');
  await s.approve(first.gate);
  const other = await s.call(MUTATE, B);
  assert.equal(other.decision, 'deny', 'B must not ride A\'s grant');
  assert.notEqual(other.gate, first.gate);
  assert.equal((await s.call(MUTATE, { query: A.query })).decision, 'allow');       // A itself, once
  assert.equal((await s.call(MUTATE, A)).decision, 'deny');                          // and only once
});

test('two different edits of the same file do not share a grant', async () => {
  const s = await setup();
  const file = path.join(s.dir, 'policy.json');                                     // the gate's own config → class self
  const e1 = { file_path: file, old_string: '"mode": "enforce"', new_string: '"mode": "observe"' };
  const e2 = { file_path: file, old_string: '"mode": "enforce"', new_string: '"mode": "off"' };
  // guardConfig names <repo>/policy.json, and this service's root is s.dir
  const first = await s.call('Edit', e1);
  assert.equal(first.decision, 'deny', JSON.stringify(first));
  await s.approve(first.gate);
  assert.equal((await s.call('Edit', e2)).decision, 'deny');
  assert.equal((await s.call('Edit', e1)).decision, 'allow');
});

test('the approval row shows the full input (an edit as old/new, an MCP call as its arguments); secrets are withheld', async () => {
  const s = await setup();
  await s.call(MUTATE, { query: 'mutation { inventorySetQuantities(input: {reason: "correction"}) { userErrors { message } } }', variables: { q: 3 } });
  const t = await s.ledger.get(s.task.id);
  const g = t.gates.at(-1);
  assert.match(g.command, /^mcp__shop__Shopify__graphql_mutation \{/);
  assert.match(g.command, /inventorySetQuantities/); assert.match(g.command, /"q": 3/);
  assert.equal(g.commandRedacted, false);
  const row = summarize([t]).needsApproval[0].gates[0];
  assert.match(row.command, /inventorySetQuantities/);
  assert.ok(t.comments.some((c) => /GATE g1 requested · store · mcp__shop__Shopify__graphql_mutation \{ …\(full text in gates\[\]\)/.test(c.text)));
  // a secret in the input never reaches the ledger, but class/tool stay visible
  const secret = 'shpat_' + 'a'.repeat(32);
  await s.call(MUTATE, { query: 'mutation x', variables: { token: secret } });
  const t2 = await s.ledger.get(s.task.id);
  assert.ok(!JSON.stringify(t2).includes(secret));
  assert.equal(t2.gates.at(-1).commandRedacted, true); assert.match(t2.gates.at(-1).command, /withheld.*tool input.*mcp__shop__Shopify__graphql_mutation/);
  assert.match(describeToolCall('Edit', { file_path: '/w/a', old_string: 'x', new_string: 'y' }), /^Edit \/w\/a\n--- old\nx\n\+\+\+ new\ny$/);
});

test('a very large input: the row is capped, gates[] keeps up to 20k chars, comments stay one line', async () => {
  const s = await setup();
  const big = 'mutation { ' + 'x'.repeat(30000) + ' }';
  const r = await s.call(MUTATE, { query: big });
  assert.equal(r.decision, 'deny');
  const t = await s.ledger.get(s.task.id);
  const g = t.gates.at(-1);
  assert.ok(g.command.length > 19000 && g.command.length < 20200); assert.match(g.command, /cut at 20000 chars/);
  const row = summarize([t]).needsApproval[0].gates[0];
  assert.ok(row.command.length < 1700); assert.match(row.command, /more chars — full text: task\.sh audit/);
  assert.ok(t.comments.every((c) => c.text.length <= 2000));
});
