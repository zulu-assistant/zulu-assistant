// node --test "test/*.test.mjs" — #627: in a Codex session the gate binds the run, not only the release.
// Part 1: Codex's own permission request is answered `allow` only for the call the board just released.
// Part 2 (the merge pin) is in test/gate-binding.test.mjs. Part 3: the receipt says whether the call ran.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_POLICY, CHECKS, ownPin } from '../src/gates.mjs';
import { createGateService, RELEASE_MS } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { auditRows, RUN_SEEN_MINUTES } from '../src/gate-ledger.mjs';
import { hookInput, hookOutput } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = path.join(ROOT, 'scripts', 'gate-hook.sh');
const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const MERGE = `gh pr merge 7 --squash --match-head-commit ${A}`;
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-run-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const world = { t: Date.now(), changes: [] };   // the ledger stamps its own writes with the real clock
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder', W2: 'other' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, now: () => world.t,
    prInfo: async () => ({ number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: A, repo: 'acme/app' }),
    afterTaskChange: async (task, u) => { world.changes.push({ task: task.id, notifyMC: u?.notifyMC || [] }); },
    git: (cwd, args) => (args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : null),
  });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const call = (event, extra = {}) => ({ event, engine: 'codex', tool: 'Bash', command: MERGE, cwd: '/work/app', workspaceId: 'W1', session: 'S1', turn: 'T1', ...extra });
  const check = (event, extra = {}, opts = {}) => svc.check(call(event, extra), opts);
  const approve = async (gate) => { const r = await ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate, decision: 'approve' }, { decider: true, now: world.t }); await svc.afterDecision(r.task, gate); };
  const gate = async (id = 'g1') => (await ledger.get(task.id)).gates.find((g) => g.id === id);
  // held, approved, released to the Codex session as call U1
  const release = async () => {
    assert.equal((await check('pre', { toolUseId: 'U0' })).decision, 'deny');
    await approve('g1');
    const r = await check('pre', { toolUseId: 'U1' });
    assert.equal(r.decision, 'allow');
    return r;
  };
  return { dir, ledger, svc, world, task, check, approve, gate, release };
}

test('the hook reads Codex\'s permission request, and answers it only with allow, with no other field', () => {
  const j = { hook_event_name: 'PermissionRequest', session_id: 'S1', turn_id: 'T1', cwd: '/w', tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default', model: 'm', transcript_path: null };
  const i = hookInput(j, {});
  assert.equal(i.event, 'permission'); assert.equal(i.engine, 'codex'); assert.equal(i.turn, 'T1'); assert.equal(i.session, 'S1'); assert.equal('toolUseId' in i, false);
  assert.equal(hookInput({ ...j, hook_event_name: 'PreToolUse', tool_use_id: 'U1' }, {}).toolUseId, 'U1');
  assert.equal(hookOutput('allow', 'r', 'permission'), '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}');
  assert.equal(hookOutput('deny', 'r', 'permission'), '');
  assert.equal(hookOutput('pass', 'r', 'permission'), '');
  // Codex PreToolUse: an approved call gets nothing (its `allow` is "unsupported"); a hold is still a deny
  assert.equal(hookOutput('allow', 'r', 'pre', { command: 'x' }, 'codex'), '');
  assert.equal(JSON.parse(hookOutput('deny', 'no', 'pre', null, 'codex')).hookSpecificOutput.permissionDecision, 'deny');
  // Claude: byte for byte as before
  assert.equal(hookOutput('allow', 'ok', 'pre', { command: 'x' }), '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"ok","updatedInput":{"command":"x"}}}');
  assert.equal(hookOutput('allow', 'ok', 'pre', { command: 'x' }, 'claude'), hookOutput('allow', 'ok', 'pre', { command: 'x' }));
});

test('ownPin reads only the form the board hands out', () => {
  assert.deepEqual(ownPin(MERGE), { head: A, bare: 'gh pr merge 7 --squash' });
  for (const c of ['gh pr merge 7', `gh pr merge 7 --match-head-commit ${A} && echo x`, `gh pr merge 7 --match-head-commit=${A}`,
    `gh pr merge 7 --match-head-commit ${A} --match-head-commit ${A}`, `echo gh pr merge 7 --match-head-commit ${A}`, `gh pr merge 7 # x --match-head-commit ${A}`])
    assert.equal(ownPin(c), null, c);
});

test('a released call: Codex\'s own question is answered allow once, for that call only', async () => {
  const s = await setup();
  await s.release();
  // not this call: another session, turn, command, folder, tool, or agent
  for (const extra of [{ session: 'S2' }, { turn: 'T2' }, { command: `${MERGE} --admin` }, { cwd: '/work/other' }, { tool: 'mcp__x__y' }, { workspaceId: 'W2' }, { session: null }])
    assert.equal((await s.check('permission', extra)).decision, 'pass', JSON.stringify(extra));
  // the evidence names another session's agent: not answered, whatever the declared ids say
  assert.equal((await s.check('permission', {}, { evidence: async () => ({ kind: 'agent', name: 'other' }) })).decision, 'pass');
  const ok = await s.check('permission', {}, { evidence: async () => ({ kind: 'agent', name: 'builder' }) });
  assert.equal(ok.decision, 'allow'); assert.match(ok.reason, /task #1 gate g1/);
  // single use
  assert.equal((await s.check('permission')).decision, 'pass');
  // Claude's own permission request is never answered by the board
  assert.equal((await s.svc.check({ ...{ event: 'permission', engine: 'claude', tool: 'Bash', command: MERGE, cwd: '/work/app', workspaceId: 'W1', session: 'S1', turn: 'T1' } })).decision, 'pass');
});

test('nothing to answer: no release, a release older than 30 s, a Post that came first', async () => {
  const none = await setup();
  assert.equal((await none.check('permission')).decision, 'pass');
  const late = await setup();
  await late.release();
  late.world.t += RELEASE_MS + 1;
  assert.equal((await late.check('permission')).decision, 'pass');
  const post = await setup();
  await post.release();
  await post.check('post', { toolUseId: 'U1' });
  assert.equal((await post.check('permission')).decision, 'pass');
});

test('the receipt: ran from the call\'s own result; no run seen after 30 min, with a cc to Mission Control; a late run still counts', async () => {
  const s = await setup();
  await s.release();
  let g = await s.gate();
  assert.equal(g.status, 'executed'); assert.equal(g.released_tool_use, 'U1'); assert.equal(g.ran_at, undefined);
  await s.check('post', { toolUseId: 'U9' });                       // another call's result changes nothing
  assert.equal((await s.gate()).ran_at, undefined);
  await s.check('post', { toolUseId: 'U1' });
  g = await s.gate();
  assert.equal(g.status, 'executed'); assert.ok(g.ran_at); assert.equal(g.ran_late, undefined);
  assert.ok(auditRows(await s.ledger.get(s.task.id)).some((r) => r.gate === 'g1' && r.event === 'ran'));
  assert.ok((await s.ledger.get(s.task.id)).comments.some((c) => /^GATE g1 ran \d\d:\d\d:\d\dZ/.test(c.text)));
  assert.equal((await s.svc.expireRunOut()).unseen, undefined);    // ran: never "no run seen"

  const n = await setup();
  await n.release();
  n.world.t += (RUN_SEEN_MINUTES - 1) * 60_000;
  assert.equal((await n.svc.expireRunOut()).unseen, undefined);
  n.world.t += 2 * 60_000;
  assert.deepEqual((await n.svc.expireRunOut()).unseen, ['#1 g1']);
  assert.ok((await n.gate()).not_seen_at);
  assert.ok(n.world.changes.some((c) => c.notifyMC.includes('not_seen')));
  assert.ok((await n.ledger.get(n.task.id)).comments.some((c) => /GATE g1 released \d\d:\d\dZ, no run seen in 30 min/.test(c.text)));
  assert.equal((await n.svc.expireRunOut()).unseen, undefined);    // once
  await n.check('post', { toolUseId: 'U1' });
  const g2 = await n.gate();
  assert.ok(g2.ran_at); assert.equal(g2.ran_late, true);
  assert.ok(auditRows(await n.ledger.get(n.task.id)).some((r) => r.event === 'ran (seen late)'));
  // the receipt chain holds: neither event is an approval, neither is a change outside a decision
  const v = await n.svc.verifyChain();
  assert.equal(v.ok, true, JSON.stringify(v));
});

test('a closed task still takes the run events; a Claude release has no call id and never gets "no run seen"', async () => {
  const s = await setup();
  await s.release();
  await s.ledger.update(s.task.id, { op: 'close', actor: 'builder', summary: 'done', checklist: [] }).catch(() => {});
  await s.ledger.update(s.task.id, { op: 'cancel', actor: 'helper', text: 'stop' }).catch(() => {});
  assert.ok(['done', 'cancelled'].includes((await s.ledger.get(s.task.id)).status), (await s.ledger.get(s.task.id)).status);
  s.world.t += (RUN_SEEN_MINUTES + 1) * 60_000;
  assert.deepEqual((await s.svc.expireRunOut()).unseen, ['#1 g1']);

  const c = await setup();
  const claude = (extra = {}) => c.svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: 'gh pr merge 7 --squash', cwd: '/work/app', workspaceId: 'W1', session: 'S1', toolUseId: 'U1', ...extra });
  await claude(); await c.approve('g1');
  assert.equal((await claude()).decision, 'allow');
  assert.equal((await c.gate()).released_tool_use, undefined);
  c.world.t += (RUN_SEEN_MINUTES + 1) * 60_000;
  assert.equal((await c.svc.expireRunOut()).unseen, undefined);
  assert.equal((await c.svc.check({ event: 'permission', engine: 'codex', tool: 'Bash', command: 'gh pr merge 7 --squash', cwd: '/work/app', workspaceId: 'W1', session: 'S1', turn: 'T1' })).decision, 'pass');
});

test('the real hook script with no board: a permission request gets nothing at all, a held PreToolUse is still denied', () => {
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', CMUX_AGENT_LAUNCH_KIND: '' };
  const base = { session_id: 'S1', turn_id: 'T1', cwd: '/work/app', tool_name: 'Bash', tool_input: { command: MERGE }, permission_mode: 'default', model: 'm', transcript_path: null };
  const perm = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify({ ...base, hook_event_name: 'PermissionRequest' }), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(perm.status, 0); assert.equal(perm.stdout, '');
  const pre = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify({ ...base, hook_event_name: 'PreToolUse', tool_use_id: 'U1' }), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(JSON.parse(pre.stdout).hookSpecificOutput.permissionDecision, 'deny');
  // the Node step fails outright (no Node program): still nothing for the permission request
  const nonode = spawnSync('sh', [HOOK, '--env-board'], { input: JSON.stringify({ ...base, hook_event_name: 'PermissionRequest' }), env: { ...env, GATE_NODE: '' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(nonode.stdout, '');
});

// The real hook script, end to end, against a stand-in board that runs a real gate service (MC's read of fc5b65d:
// the shell must print the Node step's allow for a permission request, not fall through to its silent fallback).
function runHook(obj, env) {
  return new Promise((resolve) => {
    const p = spawn('sh', [HOOK, '--env-board'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', (b) => { out += b; });
    p.on('close', (status) => resolve({ status, stdout: out }));
    p.stdin.end(JSON.stringify(obj));
  });
}
test('end to end: the real hook script and a stand-in board — held, approved, released silently, Codex\'s question answered allow once', async () => {
  const s = await setup();
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const answer = req.url === '/api/gates/check' ? await s.svc.check(JSON.parse(body)) : {};
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: `http://127.0.0.1:${server.address().port}`, CMUX_WORKSPACE_ID: 'W1', CMUX_AGENT_LAUNCH_KIND: '' };
    const base = { session_id: 'S1', turn_id: 'T1', cwd: '/work/app', tool_name: 'Bash', tool_input: { command: MERGE, workdir: '/work/app' }, permission_mode: 'default', model: 'm', transcript_path: null };
    const pre = (id) => runHook({ ...base, hook_event_name: 'PreToolUse', tool_use_id: id }, env);
    const perm = () => runHook({ ...base, hook_event_name: 'PermissionRequest' }, env);
    // held: a deny, and Codex's question for it gets nothing from the board
    assert.equal(JSON.parse((await pre('U0')).stdout).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal((await perm()).stdout, '');
    await s.approve('g1');
    // released: the PreToolUse answer is silent for Codex, and Codex's own question is answered allow, once
    const rel = await pre('U1');
    assert.equal(rel.status, 0); assert.equal(rel.stdout, '');
    assert.equal((await s.gate()).status, 'executed');
    const allow = await perm();
    assert.equal(allow.status, 0);
    assert.deepEqual(JSON.parse(allow.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    assert.equal((await perm()).stdout, '');
    // the call's own result: the row says it ran
    await runHook({ ...base, hook_event_name: 'PostToolUse', tool_use_id: 'U1', tool_response: {} }, env);
    assert.ok((await s.gate()).ran_at);
  } finally { server.close(); }
});

test('the Codex hook template registers the permission request on the same script', async () => {
  const t = JSON.parse((await import('node:fs')).readFileSync(path.join(ROOT, 'examples', 'codex', 'guardrails-hooks.json.tmpl'), 'utf8'));
  assert.deepEqual(Object.keys(t.hooks).sort(), ['PermissionRequest', 'PostToolUse', 'PreToolUse']);
  assert.equal(t.hooks.PermissionRequest[0].hooks[0].command, t.hooks.PreToolUse[0].hooks[0].command);
});
