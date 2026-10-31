import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLedger, applyPatch } from '../src/tasks.mjs';
import { createGateService, policyProblems, normTool } from '../src/gate-service.mjs';
import { gatesResolved, auditRows } from '../src/gate-ledger.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { OWNER } from '../src/config.mjs';

// neutral fixtures: agents "builder" (ws W1) and "helper" (ws W2), repo /work/app, no git, a manual clock
async function setup(over = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gates-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  const policy = { ...structuredClone(DEFAULT_POLICY), ...(over.policy || {}) };
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  let t = Date.parse('2026-01-05T10:00:00Z');
  const woken = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder', W2: 'helper' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator',
    git: over.git || (() => null), isPrivateRepo: over.isPrivateRepo || (async () => null), prInfo: over.prInfo || (async () => null),
    now: () => t, afterTaskChange: async (task, r) => { woken.push(...(r.wake || [])); },
  });
  const check = (command, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const decide = async (id, gate, decision, reason) => {
    const r = await ledger.update(id, { op: 'gate_decide', actor: OWNER.id, gate, decision, reason }, { decider: true, now: t });
    if (decision === 'approve') await svc.afterDecision(r.task, gate);
    return r;
  };
  return { dir, ledger, svc, check, decide, woken, tick: (ms) => { t += ms; } };
}

test('policy validation catches broken policies; the shipped default and Codex tool names are fine', () => {
  assert.deepEqual(policyProblems(DEFAULT_POLICY), []);
  assert.ok(policyProblems({ version: 2, classes: [] }).length >= 2);
  assert.ok(policyProblems({ version: 1, classes: [{ id: 'x', rules: [{ tool: '(' }] }] }).some((p) => /regex/.test(p)));
  assert.ok(policyProblems({ version: 1, classes: [{ id: 'x', rules: [{ pathAny: ['@nope'] }] }] }).some((p) => /not defined/.test(p)));
  assert.equal(normTool('exec_command'), 'Bash'); assert.equal(normTool('mcp__x__y'), 'mcp__x__y');
});

test('not gated → pass and nothing written; gated → one gate on the agent\'s only live task, owner asked, agent told', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  assert.deepEqual(await s.check('git status && npm test'), { decision: 'pass' });
  const r = await s.check('gh pr merge 7 --merge');
  assert.equal(r.decision, 'deny'); assert.equal(r.task, task.id); assert.equal(r.gate, 'g1');
  assert.match(r.reason, /waiting on the owner, task #\d+ \(gate g1\)/i);
  const t = await s.ledger.get(task.id);
  assert.equal(t.status, 'needs_approval'); assert.ok(t.blocked_on.includes(OWNER.id));
  assert.equal(t.gates[0].status, 'pending'); assert.equal(t.gates[0].cls, 'merge'); assert.equal(t.gates[0].agent, 'builder');
  assert.equal(t.gates[0].command, 'gh pr merge 7 --merge');
  assert.ok(t.comments.some((c) => c.gate?.event === 'requested' && /GATE g1 requested · merge/.test(c.text)));
  // the same call again: still waiting, no second gate
  const again = await s.check('gh pr merge 7 --merge');
  assert.match(again.reason, /still waiting/); assert.equal((await s.ledger.get(task.id)).gates.length, 1);
  assert.equal((await s.ledger.get(task.id)).gates[0].attempts, 2);
});

test('approve → a single-use grant: the exact call runs once, a repeat is a new gate; the task returns to work', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  await s.check('gh pr merge 7 --merge');
  const d = await s.decide(task.id, 'g1', 'approve');
  assert.equal(d.task.status, 'in_progress'); assert.ok(!d.task.blocked_on.includes(OWNER.id));
  assert.deepEqual(d.wake, ['builder']); assert.equal(d.wakeKind, 'gate');
  // a different command, or another agent, does not ride the grant
  assert.equal((await s.check('gh pr merge 8 --merge')).decision, 'deny');
  assert.equal((await s.check('gh pr merge 7 --merge', { workspaceId: 'W2' })).decision, 'deny');
  const run = await s.check('gh pr merge 7 --merge');
  assert.equal(run.decision, 'allow'); assert.match(run.reason, /runs once/);
  const t = await s.ledger.get(task.id);
  assert.equal(t.gates[0].status, 'executed'); assert.ok(t.gates[0].executed_at);
  assert.ok(t.comments.some((c) => c.gate?.event === 'executed'));
  const twice = await s.check('gh pr merge 7 --merge');
  assert.equal(twice.decision, 'deny'); assert.notEqual(twice.gate, 'g1');
  // the grant never leaves data/guardrails/ and is 0600
  const st = await stat(path.join(s.dir, 'guardrails', 'grants.json'));
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await s.ledger.get(task.id)).includes(JSON.parse(await readFile(path.join(s.dir, 'guardrails', 'grants.json'), 'utf8'))[0].id));
});

test('an approval lasts 120 min; once it expires unused the next attempt asks again and says it was approved before (never re-armed)', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  await s.check('vercel --prod');
  const d = await s.decide(task.id, 'g1', 'approve');
  assert.equal(Date.parse(d.task.gates[0].expires_at) - Date.parse(d.task.gates[0].decided_at), 120 * 60e3);
  s.tick(121 * 60e3);
  const r = await s.check('vercel --prod');
  assert.equal(r.decision, 'deny');
  assert.match(r.reason, /approved before \(\d\d:\d\dZ, g1\) but expired unused, so the owner is asked again/);
  const t = await s.ledger.get(task.id);
  assert.equal(t.gates[0].status, 'expired'); assert.equal(t.gates[1].status, 'pending');
  assert.deepEqual(t.gates[1].previously, { gate: 'g1', task: task.id, at: t.gates[0].decided_at });
  assert.match(t.gates[1].why, /previously approved \d\d:\d\dZ \(#\d+ g1\), expired unused/);
});

test('decline: the agent is told, a re-attempt is counted and blocks the close until waived with a reason', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  await s.check('launchctl bootout gui/501/com.example.web');
  await s.decide(task.id, 'g1', 'decline', 'not during the sale');
  const r = await s.check('launchctl bootout gui/501/com.example.web');
  assert.match(r.reason, /declined by the owner .*not during the sale/);
  const t = await s.ledger.get(task.id);
  assert.equal(t.gates[0].rerunsAfterDecline, 1);
  assert.equal(gatesResolved(t).ok, false);
  const close = { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'data/handoffs/x.md' } };
  await assert.rejects(s.ledger.update(task.id, close), /gates_resolved not verified/);
  const done = await s.ledger.update(task.id, { ...close, waive: { gates_resolved: 'the owner asked for it on the call' } });
  assert.equal(done.task.status, 'done'); assert.equal(done.task.verify_waived.gates_resolved, 'the owner asked for it on the call');
  assert.ok(auditRows(done.task).some((x) => /re-attempted/.test(x.event)));
});

test('a pending gate blocks the close', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await s.check('crontab -r');
  await assert.rejects(s.ledger.update(task.id, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'h.md' } }), /gate g1 still waiting/);
});

test('dry run first: the write form is refused until the dry form ran to completion in this task', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'archive', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  const first = await s.check('python3 scripts/archive.py --commit');
  assert.match(first.reason, /run the dry form first.*python3 scripts\/archive\.py/);
  let t = await s.ledger.get(task.id);
  assert.equal(t.gates[0].status, 'dry_required'); assert.equal(t.status, 'in_progress');   // informational, not blocking
  // started but not completed does not count
  await s.check('python3 scripts/archive.py');
  assert.match((await s.check('python3 scripts/archive.py --commit')).reason, /dry form first/);
  await s.svc.check({ event: 'post', engine: 'claude', tool: 'Bash', command: 'python3 scripts/archive.py', cwd: '/work/app', workspaceId: 'W1' });
  const r = await s.check('python3 scripts/archive.py --commit');
  assert.match(r.reason, /waiting on the owner/i);
  t = await s.ledger.get(task.id);
  const g = t.gates.find((x) => x.status === 'pending');
  assert.ok(g.dryRun.required && g.dryRun.seen_at);
  // the hook now watches that script (its name is in the trigger file)
  assert.match(await readFile(path.join(s.dir, 'guardrails', 'triggers'), 'utf8'), /archive\\\.py/);
  // a chained dry+write in one call never counts as "dry first"
  assert.equal((await s.check('python3 scripts/other.py && python3 scripts/other.py --commit')).decision, 'deny');
});

test('task resolution (condition C): focus wins; one live task; zero → a new task; two without focus → set focus first', async () => {
  const s = await setup();
  const none = await s.check('gh pr merge 1');
  const created = await s.ledger.get(none.task);
  assert.match(created.title, /^GATE: Merge a pull request — gh pr merge 1/); assert.equal(created.owner, 'builder');
  const a = await s.ledger.create({ title: 'a', requester: 'helper', owner: 'builder' });
  const two = await s.check('gh pr merge 2');
  assert.match(two.reason, /set it first: task\.sh focus/i); assert.equal(two.task, undefined);
  await s.svc.setFocus('builder', a.id);
  assert.equal((await s.check('gh pr merge 2')).task, a.id);
  // fix 3: '*' means registered agents — an unregistered session is only observed…
  assert.deepEqual(await s.check('gh pr merge 3', { workspaceId: 'W9' }), { decision: 'pass', observed: true });
  // …unless the policy names 'unregistered'; then its gate lands on mission control
  const e = await setup({ policy: { enforceFor: ['*', 'unregistered'] } });
  const u = await e.check('gh pr merge 3', { workspaceId: 'W9' });
  assert.equal((await e.ledger.get(u.task)).owner, 'coordinator');
});

test('observe mode (condition G) and enforceFor: logged, never written to the task, never blocked', async () => {
  const s = await setup({ policy: { enforceFor: ['helper'] } });
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  const r = await s.check('gh pr merge 5');
  assert.deepEqual(r, { decision: 'pass', observed: true });
  assert.equal((await s.ledger.get(task.id)).gates, undefined);
  const log = (await readFile(path.join(s.dir, 'guardrails', 'observed.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(log[0].cls, 'merge'); assert.equal(log[0].agent, 'builder');
});

test('redaction before storage (condition E): a secret in the command never reaches gates[], comments or the observe log', async () => {
  const secret = 'ghp_' + 'A'.repeat(36);
  const s = await setup();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  const r = await s.check(`GH_TOKEN=${secret} gh pr merge 9`);
  assert.equal(r.decision, 'deny');
  const t = await s.ledger.get(task.id);
  assert.ok(!JSON.stringify(t).includes(secret));
  assert.equal(t.gates[0].commandRedacted, true); assert.equal(t.gates[0].bin, 'gh'); assert.equal(t.gates[0].cwd, '/work/app');
  const o = await setup({ policy: { mode: 'observe' } });
  await o.check(`GH_TOKEN=${secret} gh pr merge 9`);
  assert.ok(!(await readFile(path.join(o.dir, 'guardrails', 'observed.jsonl'), 'utf8')).includes(secret));
});

test('who may decide (condition H): only the owner\'s board; never intake, an agent identity or a plain agent call; gate_request is board-internal', async () => {
  const s = await setup();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await s.check('gh pr merge 4');
  const t = await s.ledger.get(task.id);
  const patch = { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' };
  assert.throws(() => applyPatch(t, patch, {}), /board \(WORK panel\) only/);
  assert.throws(() => applyPatch(t, patch, { decider: true, intake: true }), /intake can only/);
  assert.throws(() => applyPatch(t, patch, { decider: true, agentIdentity: true }), /board \(WORK panel\) only/);
  assert.throws(() => applyPatch(t, { op: 'gate_request', actor: 'builder', gate: { cls: 'merge' } }, {}), /gate service only/);
  assert.throws(() => applyPatch(t, { op: 'gate_event', actor: 'builder', gate: 'g1', event: 'executed' }, {}), /gate service only/);
  // the pane fallback (fix 4): only mission control records the owner's in-pane answer — never the gated agent
  assert.throws(() => applyPatch(t, { op: 'gate_record', actor: 'builder', gate: 'g1', decision: 'approve', text: 'owner said yes' }, {}), /only mission-control records/);
  assert.throws(() => applyPatch(t, { op: 'gate_record', actor: 'mission-control', gate: 'g1', decision: 'approve' }, {}), /needs text/);
  const rec = applyPatch(t, { op: 'gate_record', actor: 'mc-coo', gate: 'g1', decision: 'approve', text: 'owner typed yes in the pane 10:02' }, { mc: true });
  assert.equal(rec.task.gates[0].via, 'pane'); assert.equal(rec.task.gates[0].recorded_by, 'mc-coo');
});

test('a broken policy keeps the last good one and says so; the card reports it', async () => {
  const s = await setup();
  await s.svc.loadPolicy();
  await writeFile(path.join(s.dir, 'policy.json'), '{ not json');
  s.tick(1000);
  await s.svc.loadPolicy();
  assert.match(s.svc.policyError(), /policy invalid .*keeping the last good policy/);
  const card = await s.svc.card([]);
  assert.equal(card.status, 'failed'); assert.match(card.detail, /policy invalid/);
});

// ── standing approval (program go) — MC amendment 2026-10-31 ──
const origin = (url) => (cwd, args) => (args[0] === 'remote' ? url : null);
async function withGo(s, via = 'board') {
  const task = await s.ledger.create({ title: 'program', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  await s.ledger.update(task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: ship the feature', kind: 'program' });
  const d = via === 'board'
    ? await s.ledger.update(task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true })
    : await s.ledger.update(task.id, { op: 'record_decision', actor: 'builder', decision: 'approve', text: 'owner said go in the pane 12:35' });
  return d.task;
}

test('a program go approves standing classes on its task: a private-repo merge and a local load run at once, with receipts', async () => {
  const s = await setup({ git: origin('git@github.com:acme/app.git'), isPrivateRepo: async (slug) => slug === 'acme/app' });
  const task = await withGo(s);
  assert.equal(task.program_go.id, 'go1'); assert.equal(task.program_go.via, 'board');
  const m = await s.check('gh pr merge 12 --merge');
  assert.equal(m.decision, 'allow'); assert.match(m.reason, /auto-approved under program go go1/);
  const l = await s.check('launchctl bootout gui/501/com.example.web');
  assert.equal(l.decision, 'allow');
  const t = await s.ledger.get(task.id);
  assert.deepEqual(t.gates.map((g) => [g.cls, g.status, g.via, g.go]), [['merge', 'executed', 'standing', 'go1'], ['deploy-local', 'executed', 'standing', 'go1']]);
  assert.equal(t.status, 'in_progress');                                          // never waited
  assert.ok(t.comments.some((c) => c.gate?.event === 'auto_approved' && /auto-approved under program go go1 · merge/.test(c.text)));
  assert.ok(auditRows(t).some((r) => r.event === 'auto-approved' && r.via === 'program go go1'));
  assert.ok(gatesResolved(t).ok);
});

test('a program go never covers outward or irreversible classes, public or deploy-on-push repos, or an unconfirmed repo', async () => {
  const s = await setup({ policy: { lists: { ...DEFAULT_POLICY.lists, paidOrOutbound: ['com.example.sender'], publicRemotes: ['acme-public/*'], deployOnPush: ['acme/site'] } },
    git: origin('git@github.com:acme/app.git'), isPrivateRepo: async (slug) => (slug === 'acme/app' ? true : slug === 'acme/unknown' ? null : true) });
  await withGo(s);
  for (const c of ['vercel --prod', 'launchctl bootout gui/501/com.example.sender', 'git push origin main', 'crontab -r', 'gh secret set X',
    'gh pr merge 3 -R acme-public/tool', 'gh pr merge 4 --repo acme/site', 'gh pr merge 5 -R acme/unknown'])
    assert.equal((await s.check(c)).decision, 'deny', c);
  const t = (await s.ledger.list({ owner: 'builder', status: 'live' }))[0];
  const why = Object.fromEntries(t.gates.filter((g) => g.cls === 'merge').map((g) => [g.command, g.why]));
  assert.match(why['gh pr merge 3 -R acme-public/tool'], /not under the program go: acme-public\/tool is public/);
  assert.match(why['gh pr merge 4 --repo acme/site'], /deploys on push/);
  assert.match(why['gh pr merge 5 -R acme/unknown'], /not confirmed private/);
});

test('no go, a revoked go, or a closed task: standing classes ask per action again', async () => {
  const s = await setup({ git: origin('git@github.com:acme/app.git'), isPrivateRepo: async () => true });
  const plain = await s.ledger.create({ title: 'no go', requester: 'helper', owner: 'builder' });
  assert.equal((await s.check('gh pr merge 1')).decision, 'deny');
  await s.ledger.update(plain.id, { op: 'cancel', actor: 'helper' });
  const task = await withGo(s, 'pane');
  assert.equal(task.program_go.via, 'pane');
  assert.equal((await s.check('gh pr merge 2')).decision, 'allow');
  const r = await s.ledger.update(task.id, { op: 'revoke_go', actor: OWNER.id }, { decider: true });
  assert.ok(r.task.program_go.revoked_at); assert.deepEqual(r.wake, ['builder']);
  assert.equal((await s.check('gh pr merge 3')).decision, 'deny');
  assert.throws(() => applyPatch(r.task, { op: 'revoke_go', actor: 'helper' }, {}), /owned by builder/);
  // a fresh go, then close: the go ends with the task
  const t2 = await withGo(s);
  await s.svc.setFocus('builder', t2.id);
  const closed = await s.ledger.update(t2.id, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'h.md' } });
  assert.ok(closed.task.program_go.ended_at);
  // the board refuses to stamp an auto approval without an active go
  assert.throws(() => applyPatch(closed.task, { op: 'gate_request', actor: 'board', gate: { cls: 'merge', auto: { go: 'go1' } } }, { gateSystem: true }));
});

test('every answer the board gives leaves one line in checks.jsonl (pass, deny, observe), secrets withheld', async () => {
  const s = await setup({ policy: { enforceFor: ['builder'] } });
  await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await s.check('git status');
  await s.check('gh pr merge 3');
  await s.check('gh pr merge 4', { workspaceId: 'W2' });                     // helper: observed
  await s.check('GH_TOKEN=ghp_' + 'B'.repeat(36) + ' gh pr view 1');
  const lines = (await readFile(path.join(s.dir, 'guardrails', 'checks.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => [l.agent, l.decision, !!l.observed]), [['builder', 'pass', false], ['builder', 'deny', false], ['helper', 'pass', true], ['builder', 'pass', false]]);
  assert.equal(lines[1].task, 1); assert.equal(lines[1].gate, 'g1'); assert.equal(lines[1].command, 'gh pr merge 3');
  assert.equal(lines[3].command, '[withheld: contains a secret]');
});
