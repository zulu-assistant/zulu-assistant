// Pane answers (SETTINGS.paneAnswers, Zulu 1.3): an approval the owner gave in an agent's pane is
// typed into the ledger by an agent, under a name the agent declares for itself. Under 'confirm'
// (the default) that record is a PROPOSAL: no grant, no program go and no plan approval until the
// owner confirms it on the board. 'direct' keeps the behaviour before 1.3.
// Neutral fixtures, temp dirs only; the one running board is the demo board on a spare port.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { newTask, applyPatch, createLedger, paneAnswersMode, activeProgramGo, summarize, wakeMessage } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { auditRows, gatesResolved, openProposal, pendingGates } from '../src/gate-ledger.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONFIRM = { paneAnswers: 'confirm' };
const DIRECT = { paneAnswers: 'direct' };
const base = { title: 'ship the feature', requester: 'helper', owner: 'builder', body: 'please ship it' };
const SAID = 'owner said yes in the pane 10:02';

/** A claimed task with an approval request waiting on the owner. */
function asking(kind = null, extra = {}) {
  const claimed = applyPatch(newTask({ ...base, ...extra }, { id: 7, now: 0 }), { op: 'claim', actor: 'builder' }).task;
  return applyPatch(claimed, { op: 'request_approval', actor: 'builder', policy_item: 'outward writes', ...(kind ? { kind } : {}) }, { now: 1000 }).task;
}

test('the switch: only the exact word "direct" is direct; absent, misspelt or anything else is confirm', () => {
  assert.equal(paneAnswersMode('direct'), 'direct');
  for (const v of [undefined, null, '', 'confirm', 'Direct', 'on', true, {}]) assert.equal(paneAnswersMode(v), 'confirm', String(v));
});

test('confirm: a recorded approval is a proposal — the request still waits on the owner and nothing is decided', () => {
  const t = asking();
  const r = applyPatch(t, { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 });
  assert.equal(r.task.status, 'needs_approval');
  assert.deepEqual(r.task.blocked_on, [OWNER.id]);
  assert.equal(r.task.approval.decision, null); assert.equal(r.task.approval.decided_by, null); assert.equal(r.task.approval.via, undefined);
  assert.deepEqual(r.task.approval.proposal, { decision: 'approve', text: SAID, by: 'builder', at: new Date(2000).toISOString() });
  assert.ok(r.task.comments.some((c) => /PANE ANSWER recorded by builder: ".*" — it counts when .* confirms it on the board/.test(c.text)));
  assert.match(r.events[0], /pane answer recorded by builder — waiting for .* to confirm on the board/);
  assert.deepEqual(r.wake, []); assert.deepEqual(r.notifyMC, []);                // it was already on the owner's strip
  // the board's payload carries the proposal, so the row can quote it
  assert.equal(summarize([r.task]).needsApproval[0].approval.proposal.by, 'builder');
  // recording again replaces the waiting record (the latest words), and still decides nothing
  const again = applyPatch(r.task, { op: 'record_decision', actor: 'builder', text: 'owner said yes again 10:09' }, { ...CONFIRM, now: 3000 }).task;
  assert.equal(again.approval.proposal.text, 'owner said yes again 10:09'); assert.equal(again.approval.decision, null);
});

test('confirm: the owner\'s click settles the proposal either way, and the receipt says which', () => {
  const heard = applyPatch(asking(), { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 }).task;
  const yes = applyPatch(heard, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true, now: 3000 });
  assert.equal(yes.task.status, 'in_progress'); assert.equal(yes.task.approval.decision, 'approve'); assert.equal(yes.task.approval.decided_by, OWNER.id);
  assert.equal(yes.task.approval.proposal.confirmed_at, new Date(3000).toISOString());
  assert.equal(openProposal(yes.task.approval), null);
  assert.ok(yes.task.comments.some((c) => c.who === OWNER.id && /APPROVED by .* — confirming the pane answer recorded by builder/.test(c.text)));
  assert.deepEqual(yes.wake, ['builder']);
  const no = applyPatch(heard, { op: 'decide', actor: OWNER.id, decision: 'decline' }, { decider: true, now: 3000 });
  assert.equal(no.task.status, 'blocked'); assert.equal(no.task.approval.proposal.overruled_at, new Date(3000).toISOString());
  assert.ok(no.task.comments.some((c) => /DECLINED by .* — the pane answer recorded by builder said approve/.test(c.text)));
  // an agent still cannot make that click
  assert.throws(() => applyPatch(heard, { op: 'decide', actor: 'builder', decision: 'approve' }, CONFIRM), (e) => e.status === 403);
});

test('confirm: a recorded "go" for a program starts NO program go; only the owner\'s own approval does', () => {
  const t = asking('program');
  // the task's own owner records it (this is the self-approval the switch closes), then Mission Control tries too
  for (const who of [{ actor: 'builder', ctx: {} }, { actor: 'coordinator', ctx: { mc: true } }]) {
    const r = applyPatch(t, { op: 'record_decision', actor: who.actor, text: 'owner said go for the whole program' }, { ...CONFIRM, ...who.ctx });
    assert.equal(r.task.program_go, undefined, who.actor);
    assert.equal(activeProgramGo(r.task), null);
    assert.equal(r.task.status, 'needs_approval');
  }
  const heard = applyPatch(t, { op: 'record_decision', actor: 'builder', text: 'owner said go' }, CONFIRM).task;
  const ok = applyPatch(heard, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true }).task;
  assert.equal(ok.program_go.id, 'go1'); assert.equal(ok.program_go.via, 'board'); assert.equal(ok.program_go.recorded_by, null);
  // 'direct' (before 1.3): the record alone granted it
  const old = applyPatch(t, { op: 'record_decision', actor: 'builder', text: 'owner said go' }, DIRECT).task;
  assert.equal(old.program_go.via, 'pane'); assert.equal(old.program_go.recorded_by, 'builder');
});

test('confirm: a recorded "yes" does not approve a plan-first plan; the close stays refused until the owner reviews it', () => {
  const claimed = applyPatch(newTask({ ...base, plan_first: true }, { id: 8, now: 0 }), { op: 'claim', actor: 'builder' }).task;
  const planned = applyPatch(claimed, { op: 'plan', actor: 'builder', text: '1. read the request 2. draft 3. hand back' }).task;
  assert.equal(planned.approval.kind, 'plan');
  const heard = applyPatch(planned, { op: 'record_decision', actor: 'builder', text: 'owner said the plan is fine' }, CONFIRM).task;
  assert.equal(heard.plan_approved_at, undefined);
  assert.throws(() => applyPatch(heard, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'r.md' } }), /plan-first/);
  const ok = applyPatch(heard, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true }).task;
  assert.ok(ok.plan_approved_at);
  // 'direct' (before 1.3): the owner of the task could approve its own plan by recording a pane answer
  assert.ok(applyPatch(planned, { op: 'record_decision', actor: 'builder', text: 'owner said fine' }, DIRECT).task.plan_approved_at);
});

test('confirm: a live task that had moved on waits on the owner again; a closed one keeps its settlement', () => {
  const started = applyPatch(asking(), { op: 'start', actor: 'builder' }, { now: 1500 }).task;
  assert.equal(started.approval.decision, 'unrecorded'); assert.equal(started.status, 'in_progress');
  const r = applyPatch(started, { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 });
  assert.equal(r.task.status, 'needs_approval'); assert.ok(r.task.blocked_on.includes(OWNER.id));
  assert.equal(r.task.approval.decision, null); assert.equal(r.task.approval.inferred_from, undefined);
  assert.deepEqual(r.notifyMC, ['approval']);                                    // it is back on the owner's strip: ring
  const closed = applyPatch(started, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'r.md' } }).task;
  const late = applyPatch(closed, { op: 'record_decision', actor: 'builder', text: SAID }, CONFIRM);
  assert.equal(late.task.status, 'done'); assert.equal(late.task.approval.decision, 'unrecorded'); assert.equal(late.task.approval.inferred_from, 'start');
  assert.equal(late.task.approval.proposal.by, 'builder');
  assert.ok(late.task.comments.some((c) => /not confirmed on the board \(the task is done\)/.test(c.text)));
});

test('a recorded DECLINE takes effect at once in both modes; who may record is unchanged; secrets are refused', () => {
  const t = asking();
  for (const ctx of [CONFIRM, DIRECT]) {
    const d = applyPatch(t, { op: 'record_decision', actor: 'builder', decision: 'decline', text: 'owner said no' }, ctx).task;
    assert.equal(d.status, 'blocked'); assert.equal(d.approval.decision, 'decline'); assert.equal(d.approval.via, 'pane');
  }
  // a waiting "yes" followed by a recorded "no": the no stands, and the receipt keeps both
  const heard = applyPatch(t, { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 }).task;
  const then = applyPatch(heard, { op: 'record_decision', actor: 'builder', decision: 'decline', text: 'owner changed their mind' }, { ...CONFIRM, now: 3000 }).task;
  assert.equal(then.approval.decision, 'decline'); assert.equal(then.approval.proposal.overruled_at, new Date(3000).toISOString());
  assert.throws(() => applyPatch(t, { op: 'record_decision', actor: 'stranger', text: SAID }, CONFIRM), (e) => e.status === 403);
  assert.throws(() => applyPatch(t, { op: 'record_decision', actor: 'builder' }, CONFIRM), (e) => e.status === 400);
  assert.throws(() => applyPatch(t, { op: 'record_decision', actor: 'builder', text: 'owner said the password: hunter2hunter2 is fine' }, CONFIRM), /looks like it contains a secret/);
});

test('"not what I said": the owner\'s board only; it decides nothing, keeps the rejected record and tells the recorder', () => {
  const heard = applyPatch(asking(), { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 }).task;
  const patch = { op: 'proposal_reject', actor: OWNER.id };
  assert.throws(() => applyPatch(heard, patch, {}), /from the board \(WORK panel\) only/);
  assert.throws(() => applyPatch(heard, { ...patch, actor: 'builder' }, {}), (e) => e.status === 403);
  assert.throws(() => applyPatch(heard, patch, { decider: true, agentIdentity: true }), (e) => e.status === 403);
  assert.throws(() => applyPatch(heard, patch, { decider: true, intake: true }), /intake can only/);
  const r = applyPatch(heard, patch, { decider: true, now: 3000 });
  assert.equal(r.task.status, 'needs_approval'); assert.equal(r.task.approval.decision, null);   // still the owner's to decide
  assert.equal(r.task.approval.proposal, undefined);
  assert.deepEqual(r.task.approval.disowned, [{ decision: 'approve', text: SAID, by: 'builder', at: new Date(2000).toISOString(), rejected_at: new Date(3000).toISOString(), rejected_by: OWNER.id }]);
  assert.ok(r.task.comments.some((c) => c.who === OWNER.id && /^NOT WHAT .* SAID: the pane answer recorded by builder for the approval request was rejected/.test(c.text)));
  assert.match(r.events[0], /pane answer recorded by builder REJECTED by /);
  assert.deepEqual([...r.wake].sort(), ['builder', 'mission-control']);            // the recorder, and Mission Control once
  // a hold: a notice that must not be replaced in the outbox, and that says what it is about
  assert.equal(r.wakeKind, 'hold'); assert.deepEqual(r.wakeRef, { approval: true }); assert.equal(r.noteBoard, true); assert.match(r.note, /not what was said\. Still waiting; do not act on it\.$/);
  assert.ok(r.note.length <= 160);
  assert.throws(() => applyPatch(r.task, patch, { decider: true }), (e) => e.status === 409);     // nothing left to reject
  // recorded by Mission Control: it is told once, not twice
  const byMc = applyPatch(asking(), { op: 'record_decision', actor: 'coordinator', text: SAID }, { ...CONFIRM, mc: true }).task;
  assert.equal(byMc.approval.proposal.by_mc, true);
  assert.deepEqual([...applyPatch(byMc, patch, { decider: true }).wake].sort(), ['builder', 'coordinator']);
  // a later record and the owner's own approval still work, and the rejected record stays on the receipt
  const again = applyPatch(r.task, { op: 'record_decision', actor: 'builder', text: 'owner said yes, properly this time' }, CONFIRM).task;
  const ok = applyPatch(again, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true }).task;
  assert.equal(ok.approval.decision, 'approve'); assert.equal(ok.approval.disowned.length, 1);
});

// ── gates: the real gate service over a temp dir (same fixtures as gate-ledger.test.mjs) ──
async function board() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pane answers-'));   // a space, like the live checkout
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const ledger = createLedger(path.join(dir, 'tasks'));
  let t = Date.parse('2026-01-05T10:00:00Z');
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, now: () => t,
  });
  const check = (command) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  // what server.mjs does after a PATCH: the grant is minted only for a gate that is approved.
  // (ledger writes use the real clock, as the gate service's own do, so the receipt rows sort in the order they happened)
  const patch = async (p, ctx = {}) => { const r = await ledger.update(task.id, p, ctx); if (['gate_decide', 'gate_record'].includes(p.op) && p.decision !== 'decline') await svc.afterDecision(r.task, p.gate); return r; };
  const grants = async () => JSON.parse(await readFile(path.join(dir, 'guardrails', 'grants.json'), 'utf8').catch(() => '[]'));
  return { dir, ledger, svc, check, patch, grants, id: task.id, tick: (ms) => { t += ms; } };
}
const CMD = 'gh pr merge 7 --merge';
const record = (b, gate = 'g1', ctx = CONFIRM) => b.patch({ op: 'gate_record', actor: 'coordinator', gate, decision: 'approve', text: SAID }, { mc: true, ...ctx });

test('confirm: a pane answer recorded for a gate mints nothing; the call is still denied until the owner confirms on the board', async () => {
  const b = await board();
  assert.equal((await b.check(CMD)).decision, 'deny');
  // only Mission Control records, as before — and now even its record is only a proposal
  await assert.rejects(b.patch({ op: 'gate_record', actor: 'builder', gate: 'g1', decision: 'approve', text: SAID }, CONFIRM), /only mission-control records/);
  b.tick(1000);
  const r = await record(b);
  const g = r.task.gates[0];
  assert.equal(g.status, 'pending'); assert.equal(g.decision, null); assert.equal(g.via, null); assert.equal(g.expires_at, null);
  assert.deepEqual({ ...g.proposal, at: null }, { decision: 'approve', text: SAID, by: 'coordinator', at: null, by_mc: true });
  assert.ok(g.proposal.at >= g.requested_at);
  assert.equal(r.task.status, 'needs_approval');
  assert.deepEqual(await b.grants(), [], 'no grant was minted');
  assert.equal(pendingGates(r.task)[0].proposal.by, 'coordinator');               // the row can quote it
  assert.ok(r.task.comments.some((c) => c.gate?.event === 'proposed' && /answer in a pane, recorded by coordinator: ".*" — it counts when .* confirms it on the board/.test(c.text)));
  // the gated agent is told not to retry, in the board's own words
  assert.deepEqual(r.wake, ['builder']); assert.equal(r.wakeKind, 'hold'); assert.deepEqual(r.wakeRef, { gate: 'g1' }); assert.equal(r.noteBoard, true);
  assert.match(r.note, /^gate g1: not approved yet\. .* must confirm on the board the answer coordinator recorded\. Do not retry\.$/);
  assert.ok(r.note.length <= 160, 'the whole instruction survives the wake line\'s 160-character cut');
  assert.match(wakeMessage(r.task, r.wakeKind, { note: r.note, noteBoard: r.noteBoard }), /Do not retry\.$/);
  // the call itself: still held, any number of times
  for (let i = 0; i < 2; i += 1) { const again = await b.check(CMD); assert.equal(again.decision, 'deny'); assert.match(again.reason, /still waiting on the owner/); }
  // and the task cannot close around it
  assert.equal(gatesResolved(await b.ledger.get(b.id)).ok, false);
  // the owner confirms on the board: now it is approved, minted, and runs exactly once
  b.tick(1000);
  const ok = await b.patch({ op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' }, { decider: true });
  assert.equal(ok.task.gates[0].status, 'approved'); assert.equal(ok.task.gates[0].via, 'board'); assert.equal(ok.task.gates[0].recorded_by, null);
  assert.ok(ok.task.gates[0].proposal.confirmed_at);
  assert.ok(ok.task.comments.some((c) => c.who === OWNER.id && /GATE g1 APPROVED by .* — confirming the pane answer recorded by coordinator/.test(c.text)));
  assert.equal((await b.grants()).length, 1);
  assert.equal((await b.check(CMD)).decision, 'allow');
  assert.equal((await b.check(CMD)).decision, 'deny');                            // single use: a second run is a new gate
  const rows = auditRows(await b.ledger.get(b.id)).filter((x) => x.gate === 'g1');
  assert.deepEqual(rows.map((x) => x.event), ['requested', 'pane answer recorded', 'approved', 'released (run once)']);
  assert.equal(rows[1].actor, 'coordinator'); assert.equal(rows[1].via, 'confirmed by the owner on the board'); assert.equal(rows[1].reason, SAID);
  assert.match(rows[2].via, /board · confirming the pane answer recorded by coordinator/);
});

test('confirm: the owner can reject the record ("not what I said") or decide otherwise; a recorded decline is direct; "direct" keeps the old behaviour', async () => {
  const b = await board();
  await b.check(CMD);
  await record(b);
  const patch = { op: 'proposal_reject', actor: OWNER.id, gate: 'g1' };
  await assert.rejects(b.patch(patch, {}), /from the board \(WORK panel\) only/);
  await assert.rejects(b.patch({ ...patch, gate: 'g9' }, { decider: true }), /no gate g9/);
  b.tick(1000);
  const r = await b.patch(patch, { decider: true });
  assert.equal(r.task.gates[0].status, 'pending'); assert.equal(r.task.gates[0].proposal, undefined); assert.equal(r.task.gates[0].disowned.length, 1);
  assert.ok(r.task.comments.some((c) => c.gate?.event === 'proposal_rejected' && /pane answer recorded by coordinator for gate g1 was rejected on the board\. The gate still waits/.test(c.text)));
  assert.deepEqual([...r.wake].sort(), ['builder', 'coordinator']);
  assert.equal((await b.check(CMD)).decision, 'deny'); assert.deepEqual(await b.grants(), []);
  await assert.rejects(b.patch(patch, { decider: true }), /no recorded pane answer is waiting on gate g1/);
  assert.deepEqual(auditRows(r.task).map((x) => x.event), ['requested', 'pane answer recorded', 'pane answer rejected']);
  // a record, then the owner declines on the board: declined, and the receipt says what the record claimed
  await record(b);
  const no = await b.patch({ op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'decline' }, { decider: true });
  assert.equal(no.task.gates[0].status, 'declined'); assert.ok(no.task.gates[0].proposal.overruled_at);
  assert.ok(no.task.comments.some((c) => /GATE g1 DECLINED by .* — the pane answer recorded by coordinator said approve/.test(c.text)));
  // a decline heard in a pane is recorded at once (it only reduces what runs)
  await b.check('gh pr merge 8');
  const dec = await b.patch({ op: 'gate_record', actor: 'coordinator', gate: 'g2', decision: 'decline', text: 'owner said no in the pane' }, { mc: true, ...CONFIRM });
  assert.equal(dec.task.gates[1].status, 'declined'); assert.equal(dec.task.gates[1].via, 'pane'); assert.equal(dec.task.gates[1].recorded_by, 'coordinator');
  // 'direct' (before 1.3): the record is the approval, and the call runs on Mission Control's say-so
  await b.check('gh pr merge 9');
  const old = await record(b, 'g3', DIRECT);
  assert.equal(old.task.gates[2].status, 'approved'); assert.equal(old.task.gates[2].via, 'pane');
  assert.equal((await b.check('gh pr merge 9')).decision, 'allow');
});

// ── the real hook script, as an agent's session runs it, against a temp-dir board over HTTP ──
test('the real hook: after a recorded pane answer the call is still denied; after the owner confirms, it runs once', { timeout: 40000 }, async () => {
  const b = await board();
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      if (req.method !== 'POST' || req.url !== '/api/gates/check') { res.writeHead(404); return res.end(); }
      const out = await b.svc.check(JSON.parse(body)).catch((e) => ({ decision: 'deny', reason: e.message }));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: `http://127.0.0.1:${server.address().port}`, CMUX_WORKSPACE_ID: 'W1', MESH_GATE_IDENTITY: '', GATE_TIMEOUT_MS: '8000' };
  // the hook JSON as Claude Code sends it; spawn (not spawnSync) so this process can answer the hook
  const hook = (command) => new Promise((resolve, reject) => {
    const p = spawn('sh', [path.join(ROOT, 'scripts', 'gate-hook.sh'), '--env-board'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput : { permissionDecision: 'pass' }));
    p.stdin.end(JSON.stringify({ session_id: 's1', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'land it' } }));
  });
  try {
    const first = await hook(CMD);
    assert.equal(first.permissionDecision, 'deny'); assert.match(first.permissionDecisionReason, /Waiting on the owner, task #\d+ \(gate g1\)/);
    await record(b);                                                               // "the owner said yes in the pane", says an agent
    const still = await hook(CMD);
    assert.equal(still.permissionDecision, 'deny', 'a recorded pane answer releases nothing');
    assert.match(still.permissionDecisionReason, /still waiting on the owner/);
    await b.patch({ op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' }, { decider: true });
    const run = await hook(CMD);
    assert.equal(run.permissionDecision, 'allow'); assert.match(run.permissionDecisionReason, /approved by the owner .* runs once/);
    assert.equal((await hook(CMD)).permissionDecision, 'deny', 'and only once');
  } finally { server.close(); }
});

// ── the page logic (public/decide.js): the row quotes the record, escaped, and offers the third button ──
const pageCtx = {};
vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: pageCtx });
const { BoardDecide } = pageCtx;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

test('the row: a waiting pane answer is quoted (escaped) with who recorded it; settled or absent → no line', () => {
  const p = { decision: 'approve', text: 'yes <b>go</b> "now" & then', by: 'mc<x>', at: '2026-01-05T10:02:00.000Z' };
  const line = BoardDecide.proposalHtml(p, esc);
  assert.match(line, /class="gate-meta gate-heard"/);
  assert.match(line, /mc&lt;x&gt; recorded your answer in a pane at 10:02Z: “yes &lt;b&gt;go&lt;\/b&gt; &quot;now&quot; &amp; then”\. It counts only when you confirm it here\./);
  assert.ok(!line.includes('<b>'));
  for (const none of [null, undefined, { ...p, confirmed_at: 'x' }, { ...p, overruled_at: 'x' }]) assert.equal(BoardDecide.proposalHtml(none, esc), '');
  const gate = { id: 'g1', cls: 'merge', label: 'Merge a pull request', why: '', agent: 'builder', cwd: '/work/app', tool: 'Bash', command: CMD, requested_at: '2026-01-05T10:00:00Z', dryRun: { required: false } };
  const row = (g) => BoardDecide.gateRowHtml(g, { key: '7:g1', esc, age: '3m', open: false, actions: '<button>X</button>' });
  assert.ok(!row(gate).includes('gate-heard'));
  const withP = row({ ...gate, proposal: p });
  assert.ok(withP.indexOf('gate-heard') < withP.indexOf('task-actions'), 'the quoted record sits above the buttons');
  assert.ok(withP.indexOf('task-actions') < withP.indexOf('gate-cmd'), 'and the buttons stay above the command');
});

test('the buttons: what a click sends, and what the second-click label says', async () => {
  assert.deepEqual({ ...BoardDecide.decisionBody('approve', 'g1', false) }, { op: 'gate_decide', gate: 'g1', decision: 'approve' });
  assert.deepEqual({ ...BoardDecide.decisionBody('decline', null, false) }, { op: 'decide', decision: 'decline' });
  assert.deepEqual({ ...BoardDecide.decisionBody('disown', 'g1', false) }, { op: 'proposal_reject', gate: 'g1' });
  assert.deepEqual({ ...BoardDecide.decisionBody('disown', null, false) }, { op: 'proposal_reject' });
  assert.deepEqual({ ...BoardDecide.decisionBody('revoke', null, true) }, { op: 'revoke_go' });
  assert.equal(BoardDecide.armedLabel('approve', 'g1'), 'CLICK AGAIN TO APPROVE g1');
  assert.equal(BoardDecide.armedLabel('disown', '#7'), 'CLICK AGAIN: NOT WHAT I SAID (#7)');
  // the page wires them: the third button only on a row that carries a waiting record, never a window.confirm
  const app = await readFile(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /heard \? btn\('disown', H\.disown, 'act-decline act-disown'\) : ''/);
  assert.match(app, /const H = BoardDecide\.heardLabels\(g\.proposal\);/);
  assert.match(app, /\(heard \? btn\('disown', H\.disown, 'act-decline act-disown'\) : ''\)/);
  assert.match(app, /body: JSON\.stringify\(BoardDecide\.decisionBody\(decision, gate, revoke\)\)/);
  assert.ok(!/window\.confirm\(/.test(app));
});

// ── the running server (demo mode, a spare port): the token rules for the new operation, and no go over HTTP ──
function request(port, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(out); } catch { /* not json */ } resolve({ status: res.statusCode, json, text: out }); });
    });
    r.on('error', reject);
    r.end(data);
  });
}

test('a running board: a recorded "go" grants nothing over HTTP; "not what I said" needs the owner\'s token and no agent identity', { timeout: 40000 }, async () => {
  const port = 39700 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, MC_DEMO: '1', MC_DEMO_POLL: '1', MC_PORT: String(port) }, stdio: 'ignore' });
  try {
    let status = null;
    for (let i = 0; i < 100 && !status; i += 1) {
      await new Promise((r) => setTimeout(r, 150));
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    }
    assert.ok(status?.demo, 'demo board answered');
    const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    const token = /<meta name="mesh-decision" content="([0-9a-f]+)"/.exec(page)[1];
    const { agents } = await fetch(`http://127.0.0.1:${port}/api/agents`).then((r) => r.json());
    const mc = agents.find((a) => a.kind === 'mission-control');
    const worker = agents.find((a) => a.kind !== 'mission-control' && a.status !== 'closed');
    const created = await request(port, 'POST', '/api/tasks', { title: 'pane answers check', requester: mc.name, owner: worker.name });
    assert.equal(created.status, 201, created.text);
    const id = created.json.task.id;
    const patch = (body, headers) => request(port, 'PATCH', `/api/tasks/${id}`, body, headers);
    const T = { 'x-mesh-decision': token };
    assert.equal((await patch({ op: 'claim', actor: worker.name })).status, 200);
    assert.equal((await patch({ op: 'request_approval', actor: worker.name, policy_item: 'program: ship the feature', kind: 'program' })).status, 200);

    // the worker records "the owner said go" for its own program: a proposal, and no program go
    const rec = await patch({ op: 'record_decision', actor: worker.name, decision: 'approve', text: 'owner said go for the whole program, in the pane' });
    assert.equal(rec.status, 200, rec.text);
    assert.equal(rec.json.task.status, 'needs_approval'); assert.equal(rec.json.task.program_go, undefined);
    assert.equal(rec.json.task.approval.proposal.by, worker.name); assert.equal(rec.json.task.approval.decision, null);

    // "not what I said": no token, a wrong token, the token with an agent identity → 403; the owner's page → done
    assert.equal((await patch({ op: 'proposal_reject' })).status, 403);
    assert.equal((await patch({ op: 'proposal_reject' }, { 'x-mesh-decision': 'f'.repeat(48) })).status, 403);
    const asAgent = await patch({ op: 'proposal_reject', actor: worker.name }, T);
    assert.equal(asAgent.status, 403); assert.match(asAgent.json.msg, /owner's board only/);
    assert.equal((await patch({ op: 'proposal_reject' }, { ...T, 'x-mesh-agent': worker.name })).status, 403);
    assert.equal((await patch({ op: 'proposal_reject' }, { ...T, origin: 'https://evil.example' })).status, 403);
    const gone = await patch({ op: 'proposal_reject' }, { ...T, origin: `http://127.0.0.1:${port}` });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(gone.json.task.approval.proposal, undefined); assert.equal(gone.json.task.approval.disowned.length, 1);
    assert.equal(gone.json.task.status, 'needs_approval'); assert.equal(gone.json.task.program_go, undefined);
    assert.equal((await patch({ op: 'proposal_reject' }, T)).status, 409);

    // recorded again, then the owner's own click from the page: now, and only now, the program go exists
    assert.equal((await patch({ op: 'record_decision', actor: worker.name, decision: 'approve', text: 'owner said go, 10:20' })).status, 200);
    const ok = await patch({ op: 'decide', decision: 'approve' }, { ...T, origin: `http://127.0.0.1:${port}` });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.task.program_go.id, 'go1'); assert.equal(ok.json.task.program_go.via, 'board');
    assert.ok(ok.json.task.approval.proposal.confirmed_at);
  } finally { child.kill(); }
});
