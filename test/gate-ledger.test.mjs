import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, applyPatch } from '../src/tasks.mjs';
import { createGateService, policyProblems, normTool } from '../src/gate-service.mjs';
import { gatesResolved, auditRows } from '../src/gate-ledger.mjs';
import { DEFAULT_POLICY, shippedRulesMissing } from '../src/gates.mjs';
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
  // SETTINGS.paneAnswers 'direct' (the behaviour before 1.3): the record is the decision
  const rec = applyPatch(t, { op: 'gate_record', actor: 'coordinator', gate: 'g1', decision: 'approve', text: 'owner typed yes in the pane 10:02' }, { mc: true, paneAnswers: 'direct' });
  assert.equal(rec.task.gates[0].via, 'pane'); assert.equal(rec.task.gates[0].recorded_by, 'coordinator');
  // 'confirm' (the default): the same record is only a proposal — the gate is still pending (test/pane-answers.test.mjs)
  const heard = applyPatch(t, { op: 'gate_record', actor: 'coordinator', gate: 'g1', decision: 'approve', text: 'owner typed yes in the pane 10:02' }, { mc: true, paneAnswers: 'confirm' });
  assert.equal(heard.task.gates[0].status, 'pending'); assert.equal(heard.task.gates[0].via, null); assert.equal(heard.task.gates[0].proposal.by, 'coordinator');
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
    // 'pane' = SETTINGS.paneAnswers 'direct' (before 1.3). Under 'confirm' a recorded answer grants no go: test/pane-answers.test.mjs
    : await s.ledger.update(task.id, { op: 'record_decision', actor: 'builder', decision: 'approve', text: 'owner said go in the pane 12:35' }, { paneAnswers: 'direct' });
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

// PR 103 review, finding 1: a landing can name its repo without the repo flag. The standing check must
// judge THAT repo, never the checkout's own, and ask the owner when it cannot read the name.
test('a program go judges the repo a landing names by PR URL or GH_REPO, not the checkout\'s origin', async () => {
  const asked = [];
  const s = await setup({ policy: { lists: { ...DEFAULT_POLICY.lists, publicRemotes: ['acme-public/*'], deployOnPush: ['acme/site'] } },
    git: origin('git@github.com:acme/app.git'), isPrivateRepo: async (slug) => { asked.push(slug); return slug === 'acme/app' ? true : null; } });
  await withGo(s);
  const why = async (c) => { const r = await s.check(c); const t = (await s.ledger.list({ owner: 'builder', status: 'live' }))[0]; return { decision: r.decision, why: t.gates.find((g) => g.command === c)?.why || '' }; };
  // the checkout's own repo, by number and by its URL: allowed under the go
  assert.equal((await s.check('gh pr merge 12 --squash')).decision, 'allow');
  assert.equal((await s.check('gh pr merge https://github.com/acme/app/pull/13 --squash')).decision, 'allow');
  assert.equal((await s.check('GH_REPO=acme/app gh pr merge 14')).decision, 'allow');
  // another repo named by URL
  let r = await why('gh pr merge https://github.com/acme-public/tool/pull/3 --squash');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /not under the program go: acme-public\/tool is public/);
  r = await why('gh pr merge https://github.com/acme/site/pull/9');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /acme\/site deploys on push/);
  r = await why('gh pr merge github.com/other/unknown/pull/1');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /other\/unknown is not confirmed private/);
  // named by GH_REPO in the command, both forms
  r = await why('GH_REPO=acme-public/tool gh pr merge 3');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /acme-public\/tool is public/);
  r = await why('export GH_REPO=acme-public/tool; gh pr merge 4');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /the landing is not the whole command/);   // 13b: two commands in one text
  r = await why('GH_REPO=github.com/acme/site gh pr merge 5');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /acme\/site deploys on push/);
  // a name the board cannot read: unknown, so it asks
  r = await why('GH_REPO="$TARGET" gh pr merge 6');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /the landing is not the whole command/);   // 13b: not a readable assignment
  r = await why('gh pr merge https://example.test/acme/app/pull/7');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /the target repo is unknown/);
  // second read of the review: the board does not rank the forms. Every repo the command names must
  // agree; a disagreement, an unreadable name, another host or GH_HOST is unknown, and the call asks.
  const unknown = [
    'gh pr merge https://github.com/acme-public/tool/pull/8 -R acme/app',
    'gh pr merge -R acme/app https://github.com/acme-public/tool/pull/8',
    'gh pr merge https://github.com/acme-public/tool/pull/8 --repo=acme/app',
    'GH_REPO=acme-public/tool gh pr merge 3; echo GH_REPO=acme/app',
    'GH_REPO=acme-public/tool gh pr merge 3 # GH_REPO=acme/app',
    'GH_REPO=acme-public/tool gh pr merge 3 && GH_REPO=acme/app true',
    'export GH_REPO=acme-public/tool\ngh pr merge 3\nGH_REPO=acme/app :',
    'GH_HOST=ghe.example.test gh pr merge 3',
    'gh pr merge 3 --repo ghe.example.test/acme/app',
    'GH_REPO=acme/app gh pr merge https://github.com/acme/app/pull/8 -R acme-public/tool',
  ];
  for (const c of unknown) { r = await why(c); assert.equal(r.decision, 'deny', c); assert.match(r.why, /the target repo is unknown|the landing is not the whole command/, c); }
  // the value attached to the short flag is read
  r = await why('gh pr merge 3 -Racme-public/tool');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /acme-public\/tool is public/);
  // forms that agree are one repo: the checkout's own, named three ways at once, still runs under the go
  assert.equal((await s.check('GH_REPO=acme/app gh pr merge https://github.com/acme/app/pull/15 -R acme/app')).decision, 'allow');
  assert.equal((await s.check('gh -R acme/app pr merge 16')).decision, 'allow');
  r = await why('gh --repo acme-public/tool pr merge 17');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /acme-public\/tool is public/);
  assert.ok(asked.includes('other/unknown') && !asked.includes('acme-public/tool'), 'a listed repo is refused without a lookup; an unlisted one is looked up by ITS name');
});

test('namedRepos: every repo a landing names; readRepoName: github.com owner/name or nothing', async () => {
  const { namedRepos, readRepoName } = await import('../src/gate-service.mjs');
  const n = (cmd) => namedRepos(cmd.replace(/^(?:\w+=\S+ )+/, '').replace(/ #.*$/, '').split(' '), cmd);   // words as the parser gives them: no prefix assignments, no comment
  assert.deepEqual(n('gh pr merge 12 --squash'), { names: [], unknown: false, any: false, admin: false });
  assert.deepEqual(n('gh pr merge feature/x'), { names: [], unknown: false, any: false, admin: false }, 'a branch name is not a repo');
  assert.deepEqual(n('gh pr merge https://github.com/a/b/pull/3 --squash').names, ['a/b']);
  assert.deepEqual(n('gh pr merge github.com/A/b.c/pull/3/files').names, ['a/b.c']);
  assert.deepEqual(n('gh pr merge 3 -R a/b').names, ['a/b']);
  assert.deepEqual(n('gh pr merge 3 -Ra/b').names, ['a/b']);
  assert.deepEqual(n('gh pr merge 3 --repo=github.com/a/b').names, ['a/b']);
  assert.deepEqual(n('GH_REPO=a/b gh pr merge https://github.com/a/b/pull/3 -R A/B'), { names: ['a/b'], unknown: false, any: true, admin: false }, 'three forms, one repo');
  assert.deepEqual(n('GH_REPO=a/b gh pr merge 1 -R c/d').names.sort(), ['a/b', 'c/d']);
  assert.equal(n('gh pr merge https://ghe.example.test/a/b/pull/3').unknown, true);
  assert.equal(n('GH_REPO=$X gh pr merge 1').unknown, true);
  assert.equal(n('GH_REPO= gh pr merge 1').unknown, true);
  assert.equal(n('GH_HOST=x.test gh pr merge 1').unknown, true);
  assert.equal(n('gh pr merge 1 # GH_REPO=c/d').names[0], 'c/d', 'a comment counts: the board cannot tell which assignment applies');
  assert.equal(n('gh pr merge 1 # MY_GH_REPO=a/b').any, false);
  for (const [v, want] of [['a/b', 'a/b'], ['github.com/a/b', 'a/b'], ['https://github.com/a/b.git', 'a/b'], ['git@github.com:a/b.git', 'a/b'],
    ['ghe.test/a/b', null], ['https://ghe.test/a/b', null], ['a', null], ['a/b/c/d', null], ['$X', null], ['', null], [undefined, null]]) assert.equal(readRepoName(v), want, String(v));
});

// Slice 13b (third read of the PR 103 review): what could still auto-run into another repo under a go.
const gitFor = ({ remotes = { origin: 'git@github.com:acme/app.git' }, resolved = '' } = {}) => (cwd, args) => {
  if (args[0] === 'remote' && args.length === 1) return Object.keys(remotes).join('\n');
  if (args[0] === 'remote' && args[1] === 'get-url') return remotes[args[2]] || null;
  if (args[0] === 'config' && args[1] === '--get-regexp') return resolved || null;
  return null;
};
const goBoard = async (git) => {
  const s = await setup({ policy: { lists: { ...DEFAULT_POLICY.lists, publicRemotes: ['acme-public/*'] } }, git, isPrivateRepo: async (slug) => (slug === 'acme/app' ? true : null) });
  await withGo(s);
  const why = async (c) => { const r = await s.check(c); const t = (await s.ledger.list({ owner: 'builder', status: 'live' }))[0]; return { ...r, why: t.gates.find((g) => g.command === c)?.why || '' }; };
  return { s, why };
};

test('13b A: the repo flag inside a group of short flags is read', async () => {
  const { s, why } = await goBoard(gitFor());
  for (const c of ['gh pr merge 3 -sR acme-public/tool', 'gh pr merge 3 -sdR acme-public/tool', 'gh pr merge 3 -sRacme-public/tool', 'gh pr merge 3 -sR=acme-public/tool', 'gh pr merge -dsR acme-public/tool 3']) {
    const r = await why(c);
    assert.equal(r.decision, 'deny', c); assert.match(r.why, /acme-public\/tool is public/, c);
  }
  // the same group naming the checkout's own repo still runs; a group without R is just flags
  assert.equal((await s.check('gh pr merge 4 -sR acme/app')).decision, 'allow');
  assert.equal((await s.check('gh pr merge 5 -sd')).decision, 'allow');
  const { namedRepos } = await import('../src/gate-service.mjs');
  assert.deepEqual(namedRepos(['gh', 'pr', 'merge', '3', '-sRd'], '').unknown, true, 'a value it cannot read only asks');
});

test('13b B + C (one text): a landing runs by itself only as the whole command, and the agent is told so', async () => {
  const { s, why } = await goBoard(gitFor());
  const held = [
    ': ${GH_REPO:=acme-public/tool}; export GH_REPO; gh pr merge 3',
    'export GH_REPO; GH_REPO+=acme-public/tool; gh pr merge 3',
    'printf -v GH_REPO %s acme-public/tool; export GH_REPO; gh pr merge 3',
    'read GH_REPO <<< acme-public/tool; export GH_REPO; gh pr merge 3',
    'git remote add upstream https://github.com/acme-public/tool.git && gh pr merge 3',
    'git config remote.origin.gh-resolved acme-public/tool; gh pr merge 3',
    'gh repo set-default acme-public/tool && gh pr merge 3',
    'gh pr merge 3 && echo done',
    'gh pr merge 3 | cat',
    'GH_HOST=ghe.example.test gh pr merge 3',
    'gh pr merge 3 # GH_REPO=acme/app',
  ];
  for (const c of held) {
    const r = await why(c);
    assert.equal(r.decision, 'deny', c);
    assert.match(r.why, /not under the program go: the landing is not the whole command/, c);
    assert.match(r.reason, /run the gh call as its own command/, c);
  }
  // the whole command, with what is allowed around it
  for (const c of ['gh pr merge 12 --squash --delete-branch', 'cd /work/app && gh pr merge 13 --squash', 'GH_REPO=acme/app gh pr merge 14', 'env GH_REPO=acme/app gh pr merge 15', 'gh pr merge 16 --subject "one; two"'])
    assert.equal((await s.check(c)).decision, 'allow', c);
  // another hold reason does not carry the hint
  const pub = await why('gh pr merge 3 -R acme-public/tool');
  assert.doesNotMatch(pub.reason, /as its own command/);
  const { landingAlone } = await import('../src/gate-service.mjs');
  assert.equal(landingAlone('  gh pr merge 3  '), true);
  assert.equal(landingAlone('gh pr merge 3\ngh pr merge 4'), false);
  assert.equal(landingAlone('gh pr merge $(cat n)'), false);
  assert.equal(landingAlone('gh pr merge 3 > out.txt'), false);
});

test('13b C (earlier calls): every remote and every gh-resolved key must be the origin\'s repo', async () => {
  // a plain numbered landing in a one-remote checkout still runs
  let b = await goBoard(gitFor());
  assert.equal((await b.s.check('gh pr merge 12 --squash')).decision, 'allow');
  // two remotes for the same repo (https and ssh), and "base" on the origin: still one repo
  b = await goBoard(gitFor({ remotes: { origin: 'git@github.com:acme/app.git', mirror: 'https://github.com/Acme/App.git' }, resolved: 'remote.origin.gh-resolved base' }));
  assert.equal((await b.s.check('gh pr merge 12')).decision, 'allow');
  // origin private plus a remote named upstream that is public: gh acts on upstream
  b = await goBoard(gitFor({ remotes: { origin: 'git@github.com:acme/app.git', upstream: 'https://github.com/acme-public/tool.git' } }));
  let r = await b.why('gh pr merge 3');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /the target repo is unknown/);
  // one remote, the resolved key names another repo that is not a remote at all
  b = await goBoard(gitFor({ resolved: 'remote.origin.gh-resolved acme-public/tool' }));
  r = await b.why('gh pr merge 3');
  assert.equal(r.decision, 'deny'); assert.match(r.why, /the target repo is unknown/);
  // the key naming the origin's own repo is fine; a remote whose address cannot be read is not
  b = await goBoard(gitFor({ resolved: 'remote.origin.gh-resolved acme/app' }));
  assert.equal((await b.s.check('gh pr merge 3')).decision, 'allow');
  b = await goBoard(gitFor({ remotes: { origin: 'git@github.com:acme/app.git', odd: null } }));
  assert.equal((await b.s.check('gh pr merge 3')).decision, 'deny');
  // naming the repo outright does not need the remotes to agree: the name is what gh uses
  b = await goBoard(gitFor({ remotes: { origin: 'git@github.com:acme/app.git', upstream: 'https://github.com/acme-public/tool.git' } }));
  assert.equal((await b.s.check('gh pr merge 3 -R acme/app')).decision, 'allow');
});

// PR 113 review, finding 1: a flag that takes a value hides the real target. Read-only checks on gh 2.102:
//   gh pr list --search --repo=<other> --state all --limit 1 --json url   → a pull request of THIS repo (the repo flag was the search text)
//   gh pr list -L -R<other>    → invalid argument "-R<other>" for "-L, --limit"   (a short value flag takes the next word)
//   gh pr list -LR<other>      → invalid argument "R<other>" for "-L, --limit"    (in a group, the first value letter takes the rest)
test('13b: the walk reads the words as gh does: a value flag takes the next word, and ends a short group', async () => {
  // a PUBLIC checkout: gh acts here; the words after a value flag only LOOK like a private target
  const pub = () => goBoard(gitFor({ remotes: { origin: 'git@github.com:acme-public/tool.git' } }));
  const { s, why } = await pub();
  const rows = [
    'gh pr merge 3 -t -Racme/app', 'gh pr merge 3 --subject --repo=acme/app', 'gh pr merge 3 --subject "--repo=acme/app"', "gh pr merge 3 --subject '-Racme/app'",
    'gh pr merge 3 -b --repo=acme/app', 'gh pr merge 3 --body -Racme/app', 'gh pr merge 3 -F -Racme/app', 'gh pr merge 3 -A -Racme/app',
    'gh pr merge 3 --match-head-commit -Racme/app', 'gh pr merge -t -R acme/app', 'gh pr merge -t https://github.com/acme/app/pull/3',
    'gh pr merge 3 --body https://github.com/acme/app/pull/3', 'gh pr merge -- -Racme/app', 'gh pr merge 3 -tRacme/app', 'gh pr merge 3 -stRacme/app',
    'gh pr merge 3 --subject=x --body-file -Racme/app', 'gh pr merge 3 -sdt --repo=acme/app',
  ];
  for (const c of rows) {
    const r = await why(c);
    assert.equal(r.decision, 'deny', c);
    assert.match(r.why, /acme-public\/tool is public|the target repo is unknown/, c);
    assert.doesNotMatch(r.why, /acme\/app/, `${c}: the private name must not be what was judged`);
  }
  // from a private checkout, the cd form into the public one
  const mixed = await goBoard((cwd, args) => gitFor({ remotes: { origin: cwd === '/work/public' ? 'git@github.com:acme-public/tool.git' : 'git@github.com:acme/app.git' } })(cwd, args));
  const r2 = await mixed.why('cd /work/public && gh pr merge 3 -t -Racme/app');
  assert.equal(r2.decision, 'deny'); assert.doesNotMatch(r2.why, /acme\/app is/);
  // a flag the walk does not know, a second positional, a bare dash: unknown
  for (const c of ['gh pr merge 3 --some-new-flag', 'gh pr merge 3 4', 'gh pr merge 3 -x', 'gh pr merge 3 -']) {
    const r = await why(c); assert.equal(r.decision, 'deny', c); assert.match(r.why, /the target repo is unknown/, c);
  }
  void s;
  // and nothing over-asks: every plain landing in a private checkout still runs
  const priv = await goBoard(gitFor());
  for (const c of ['gh pr merge 3', 'gh pr merge 3 --squash --delete-branch', 'gh pr merge 3 -sd', 'gh pr merge 3 -m -t "the subject" -b "the body"', 'gh pr merge 3 --subject=x --body=y --rebase',
    'gh pr merge 3 -st "subject here"', 'gh pr merge 3 --match-head-commit 0123abc', 'gh pr merge 3 --auto', 'gh pr merge feature/x', 'gh pr merge', 'gh pr merge 3 -R acme/app -t -Rnot-a-repo',
    'gh pr merge https://github.com/acme/app/pull/3 -s', 'gh -R acme/app pr merge 3'])
    assert.equal((await priv.s.check(c)).decision, 'allow', c);
  const { namedRepos } = await import('../src/gate-service.mjs');
  assert.deepEqual(namedRepos(['gh', 'pr', 'merge', '3', '-tRacme/app'], ''), { names: [], unknown: false, any: false, admin: false });
  assert.deepEqual(namedRepos(['gh', 'pr', 'merge', '3', '-sRacme/app'], '').names, ['acme/app']);
  assert.equal(namedRepos(['gh', 'pr', 'merge', '--body', 'https://github.com/a/b/pull/3'], '').any, false, 'an address counts only as the positional');
  assert.equal(namedRepos(['gh', 'pr', 'view', '3'], '').unknown, true);
});

test('13b: the admin flag never runs by itself', async () => {
  const { s, why } = await goBoard(gitFor());
  for (const c of ['gh pr merge 3 --admin', 'gh pr merge 3 -s --admin --delete-branch']) {
    const r = await why(c); assert.equal(r.decision, 'deny', c); assert.match(r.why, /not under the program go: the admin flag is set/, c);
  }
  assert.equal((await s.check('gh pr merge 3 -t --admin')).decision, 'allow', 'as a subject it is only text');
});

// ── rules an older policy file does not have (#398) ──
test('shippedRulesMissing: an older policy is counted by class and rule; the owner\'s lists and additions never count', () => {
  assert.deepEqual(shippedRulesMissing(DEFAULT_POLICY), { count: 0, classes: [] });
  const shipped = JSON.parse(readFileSync(new URL('../examples/policy.json', import.meta.url), 'utf8'));
  assert.deepEqual(shippedRulesMissing(shipped), { count: 0, classes: [] }, 'the example file carries every shipped rule');
  const old = structuredClone(DEFAULT_POLICY);
  const upgrade = old.classes.find((c) => c.id === 'upgrade'); old.classes = old.classes.filter((c) => c.id !== 'upgrade');
  old.classes.find((c) => c.id === 'self').rules.pop();
  assert.deepEqual(shippedRulesMissing(old), { count: upgrade.rules.length + 1, classes: ['self', 'upgrade'].sort((a, b) => DEFAULT_POLICY.classes.findIndex((c) => c.id === a) - DEFAULT_POLICY.classes.findIndex((c) => c.id === b)) });
  const mine = structuredClone(DEFAULT_POLICY);
  mine.lists.paidOrOutbound = ['com.example.sender']; mine.defaultMode = 'enforce';
  mine.classes.push({ id: 'mine', label: 'my own', rules: [{ bin: 'mytool' }] }); mine.classes[0].rules.push({ bin: 'another' });
  mine.classes[0].rules = mine.classes[0].rules.map((r) => Object.fromEntries(Object.entries(r).reverse()));
  assert.deepEqual(shippedRulesMissing(mine), { count: 0, classes: [] }, 'lists, additions and key order do not count');
  assert.deepEqual(shippedRulesMissing({}).classes.length, DEFAULT_POLICY.classes.length, 'no classes at all: everything is missing');
});

test('the guardrails card says how many shipped rules are missing, without changing its colour', async () => {
  const current = await setup();
  assert.doesNotMatch((await current.svc.card([])).detail, /shipped rule/);
  const classes = structuredClone(DEFAULT_POLICY.classes).filter((c) => c.id !== 'upgrade');
  const s = await setup({ policy: { classes } });
  const n = DEFAULT_POLICY.classes.find((c) => c.id === 'upgrade').rules.length;
  const base = await current.svc.card([]);
  const card = await s.svc.card([]);
  assert.match(card.detail, new RegExp(`${n} shipped rules are not in yours \\(upgrade; INSTALL 7b\\)`));
  assert.equal(card.status, base.status);
});
