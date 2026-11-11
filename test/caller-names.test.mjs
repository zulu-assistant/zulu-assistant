// Zulu 1.3 slice 2b — what is built on caller evidence (src/caller.mjs) once its switches are turned up:
//   mode 'on'            names enforced: a declared name the calling process does not back earns none
//                        of that name's standing and its words are marked; the gate hook's identity
//                        comes from the session behind the call, not from what the hook declares
//   tripwire 'browser'   an approval typed in a terminal becomes a row the owner confirms on the board
// and two things Mission Control asked for after the pane-answer change: the "not approved yet"
// notice can no longer be replaced in the outbox, and "not what I said" puts a task that had moved
// on back where it was.
// Pure rules first, then the gate service and the ledger over temp dirs, then the demo board on a
// spare port. As in test/caller.test.mjs, nothing here may assume WHO runs the suite: a request
// that must have no session behind it is made by a process the test detaches on purpose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { nameVerdict, hookIdentity, resolveChain } from '../src/caller.mjs';
import { newTask, applyPatch, createLedger, holdOpen, wakeMessage, summarize } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { auditRows, pendingGates, proposalWhat } from '../src/gate-ledger.mjs';
import { enqueue, drainOutbox, readOutbox, NEVER_SUPERSEDED, HOLD_KIND } from '../src/mesh.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { OWNER } from '../src/config.mjs';
import { demoEnv } from './demo-board.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const iso = (ms) => new Date(ms).toISOString();
const session = (name, extra = {}) => ({ kind: 'agent', name, workspaceId: 'w1', basis: 'session-map', agentAncestor: true, underCmux: true, browser: false, ...extra });
const NOBODY = { kind: 'local', agentAncestor: false, underCmux: false, browser: false };            // a plain terminal, a script, a detached job
const OUTSIDE = { kind: 'local', agentAncestor: true, underCmux: false, browser: false };            // an agent session that does not run under cmux
const UNNAMED = { kind: 'local', agentAncestor: true, underCmux: true, browser: false };             // under cmux, but nobody could name it
const FAILED = { kind: 'unknown', agentAncestor: false, browser: false };
const GONE = { kind: 'gone', agentAncestor: false, browser: false, why: 'no process holds the client end' };   // it wrote the request and left
const PHONE = { kind: 'remote', agentAncestor: false, browser: false };

// ── names: the pure rule ────────────────────────────────────────────────────
test('names: a name is proven by the process behind the call — an agent\'s by its own session, a job\'s by its mapping, the owner\'s by the token with no agent behind it', () => {
  const isOwner = (n) => n === 'boss';
  const V = (ev, name, o = {}) => nameVerdict(ev, name, { isOwner, ...o });
  // proven
  assert.deepEqual(V(session('builder'), 'builder'), { proven: true, why: 'the calling process is this agent\'s session' });
  assert.equal(V(session('builder'), 'Builder').proven, true, 'a name is compared in lower case, as the directory keeps it');
  assert.equal(V({ kind: 'job', name: 'headless:triage', agentAncestor: false }, 'headless:triage').proven, true);
  assert.equal(V({ kind: 'job', name: 'builder', agentAncestor: false }, 'builder').proven, true, 'a scheduled job the owner mapped to an agent\'s name keeps working');
  assert.equal(V({ kind: 'board', agentAncestor: false }, 'board').proven, true);
  assert.equal(V(null, 'board', { boardToken: true }).proven, true);
  for (const ev of [NOBODY, PHONE, FAILED, null]) assert.equal(V(ev, 'boss', { ownerToken: true }).proven, true, `the owner's token from ${ev?.kind}`);
  // not proven, and why
  const no = (ev, name, re, o) => { const v = V(ev, name, o); assert.equal(v.proven, false, `${name} / ${ev?.kind}`); assert.match(v.why, re); };
  no(session('helper'), 'builder', /^the calling process is helper's session$/);          // one agent using another's name
  no(session(null), 'builder', /an unregistered session/);
  no(NOBODY, 'builder', /no agent session is behind the call \(a plain terminal, a script or a detached job\)/);
  no(OUTSIDE, 'builder', /an agent process is behind the call, but no session could be named/);
  no(UNNAMED, 'builder', /no session could be named/);
  no(PHONE, 'builder', /another device/);
  no(FAILED, 'builder', /could not be looked up/);
  no(GONE, 'builder', /the sender left before the board could see who it was/);
  no(null, 'builder', /was not looked up/);
  no({ kind: 'job', name: 'headless:triage', agentAncestor: false }, 'builder', /the job headless:triage/);
  no({ kind: 'board', agentAncestor: false }, 'builder', /the board's own child/);
  // the owner's name: never without the token, and never from a process an agent session is behind
  no(NOBODY, 'boss', /needs the decision token/);
  no(session('boss'), 'boss', /needs the decision token/);
  for (const ev of [session('builder'), OUTSIDE, UNNAMED]) no(ev, 'boss', /the decision token came from a process an agent session is behind/, { ownerToken: true });
  // …nor from a sender that left before the board could look: the token only says "someone on this machine"
  no(GONE, 'boss', /the decision token came from a sender that left/, { ownerToken: true });
  // the token proves the owner's name only: an agent's name still needs that agent's session
  no(session('builder'), 'helper', /builder's session/, { ownerToken: true });
  no(NOBODY, 'builder', /no agent session/, { ownerToken: true, boardToken: true });
  // "board" is the board's own process
  no(session('builder'), 'board', /belongs to the board's own process/);
  no(NOBODY, 'board', /belongs to the board's own process/);
});

// ── the gate hook's identity: the pure rule ─────────────────────────────────
test('hook identity: the session behind the call, never the declared id; a lookup that fails, or a cmux session nobody could name, is enforced as declared', () => {
  const id = (ev, o = {}) => hookIdentity(ev, { declared: 'helper', folder: 'app', ...o });
  assert.deepEqual(id(session('builder')), { agent: 'builder', force: false, basis: 'session-map' });
  assert.deepEqual(id(session('builder', { basis: 'env' })), { agent: 'builder', force: false, basis: 'env' });
  // a session cmux knows that is not in the directory: unregistered, unless the board started it for a dispatch
  assert.deepEqual(id(session(null, { workspaceId: 'w9' })), { agent: 'unregistered:app', force: false, basis: 'session-map' });
  assert.equal(id(session(null, { workspaceId: 'w9' }), { headlessWs: (ws) => (ws === 'w9' ? 'headless:dispatch' : null) }).agent, 'headless:dispatch');
  assert.equal(id(session('builder', { workspaceId: 'w9' }), { headlessWs: () => 'headless:dispatch' }).agent, 'builder', 'once registered, the name wins');
  // a mapped job: its name only when the policy knows it
  const job = { kind: 'job', name: 'headless:triage', agentAncestor: false };
  assert.deepEqual(id(job, { okJob: (n) => n === 'headless:triage' }), { agent: 'headless:triage', force: false, basis: 'job' });
  assert.equal(id(job).agent, 'unregistered:app');
  // a session outside cmux, or no agent at all: unregistered, exactly as a session without a workspace id was before
  for (const ev of [NOBODY, OUTSIDE, { kind: 'board', agentAncestor: false }]) assert.deepEqual({ ...id(ev), basis: '' }, { agent: 'unregistered:app', force: false, basis: '' });
  // fail closed: the declared name is kept and ENFORCED whatever it is
  for (const ev of [FAILED, GONE, PHONE, null, undefined, UNNAMED, { ...OUTSIDE, mapped: true }]) {
    const r = id(ev);
    assert.equal(r.agent, 'helper'); assert.equal(r.force, true, String(ev?.kind));
  }
  assert.match(id(GONE).basis, /the sender had left/);
  assert.equal(hookIdentity(FAILED, { folder: 'app' }).agent, 'unregistered:app', 'nothing declared and no lookup: still someone, still enforced');
  assert.equal(hookIdentity(FAILED, { folder: 'app' }).force, true);
});

test('the chain: a session cmux\'s map lists but that cannot be named is flagged, so the hook never mistakes it for a session outside cmux', () => {
  const CMUX = '/Applications/cmux.app/Contents/MacOS/cmux';
  const link = (pid, ppid, comm) => ({ pid, ppid, start: pid, comm });
  const sessions = new Map([[40, { workspaceId: 'w1', start: 40, vendor: 'claude' }]]);
  const under = [link(50, 40, '/usr/bin/node'), link(40, 30, '/opt/bin/claude'), link(30, 20, '/bin/zsh'), link(20, 1, CMUX)];
  const cut = [link(50, 40, '/usr/bin/node'), link(40, 1, '/opt/bin/claude')];                 // its chain no longer reaches the app
  assert.equal(resolveChain(under, { sessions, envOf: () => 'w1' }).kind, 'agent');
  const disagree = resolveChain(under, { sessions, envOf: () => 'w2' });
  assert.equal(disagree.kind, 'local'); assert.equal(disagree.mapped, true); assert.equal(disagree.underCmux, true);
  const orphan = resolveChain(cut, { sessions, envOf: () => 'w1' });
  assert.equal(orphan.kind, 'local'); assert.equal(orphan.mapped, true); assert.equal(orphan.underCmux, false);
  for (const ev of [disagree, orphan]) assert.equal(hookIdentity(ev, { declared: 'builder', folder: 'app' }).force, true);
  // a session cmux has never heard of, outside cmux: an ordinary unregistered session
  const plain = resolveChain(cut, { sessions: new Map(), envOf: () => null });
  assert.equal(plain.mapped, undefined); assert.equal(hookIdentity(plain, { declared: 'builder', folder: 'app' }).force, false);
});

// ── the gate service with names enforced ────────────────────────────────────
const CMD = 'gh pr merge 7 --merge';
async function gateBoard({ headlessWs = () => null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caller names-'));   // a space, like the live checkout
  // builder and the two headless roles are enforced; helper is observed; so is a session with no identity
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ ...DEFAULT_POLICY, enforceFor: ['builder', 'headless:triage', 'headless:dispatch'] }));
  const ledger = createLedger(path.join(dir, 'tasks'));
  const events = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder', W2: 'helper' }[ws] || null), headlessWs, home: '/home/u', mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, recordEvent: async (k, t) => { events.push(t); },
  });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const input = (command, extra = {}) => ({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', ...extra });
  const lines = async () => (await readFile(path.join(dir, 'guardrails', 'checks.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const gateOf = async (r) => (await ledger.get(r.task)).gates.find((g) => g.id === r.gate);
  return { dir, ledger, svc, events, input, lines, gateOf, id: task.id };
}
const says = (ev) => ({ names: true, evidence: async () => ev });

test('gate check, names enforced: a hook that declares an observed agent\'s workspace is judged as the session it really runs in', async () => {
  const b = await gateBoard();
  const asHelper = b.input(CMD, { workspaceId: 'W2' });
  // before (and in observe): the declared id alone decides — claiming the observed agent's workspace is a way out
  assert.deepEqual(await b.svc.check(asHelper), { decision: 'pass', observed: true });
  assert.deepEqual(await b.svc.check(asHelper, { evidence: async () => session('builder') }), { decision: 'pass', observed: true });
  // names enforced: the call came from the enforced builder's session, so it is held, on builder's task
  const r = await b.svc.check(asHelper, says(session('builder')));
  assert.equal(r.decision, 'deny'); assert.equal(r.task, b.id);
  assert.equal((await b.gateOf(r)).agent, 'builder');
  const line = (await b.lines()).pop();
  assert.equal(line.agent, 'builder'); assert.equal(line.declared, 'helper'); assert.equal(line.caller, 'builder'); assert.equal(line.callerMismatch, true);
  assert.ok(b.events.some((e) => /\[caller mismatch\] gate check: the hook declared helper, but the call came from builder's session — judged as builder/.test(e)));
  // the other way round: declaring the enforced agent does not make an observed session enforced
  assert.deepEqual(await b.svc.check(b.input('gh pr merge 8', { workspaceId: 'W1' }), says(session('helper', { workspaceId: 'w2' }))), { decision: 'pass', observed: true });
  // a plain pass never looks the caller up, names or not
  let asked = 0;
  assert.deepEqual(await b.svc.check(b.input('git status', { workspaceId: 'W2' }), { names: true, evidence: async () => { asked += 1; return session('builder'); } }), { decision: 'pass' });
  assert.equal(asked, 0);
});

test('gate check, names enforced: a failed lookup or an unnameable cmux session is enforced as declared; a session outside cmux is unregistered as before', async () => {
  const b = await gateBoard();
  let n = 10;
  const asHelper = () => b.input(`gh pr merge ${n += 1}`, { workspaceId: 'W2' });           // a fresh call each time: no gate to bump into
  const never = { names: true, evidence: () => new Promise(() => {}), noteBudgetMs: 40 };      // a lookup that does not answer in time
  for (const [what, opts] of [['the lookup threw', { names: true, evidence: async () => { throw new Error('lsof exploded'); } }], ['unknown', says(FAILED)], ['a sender that left', says(GONE)], ['no evidence function', { names: true }], ['an unnameable cmux session', says(UNNAMED)], ['a lookup past its time limit', never]]) {
    const r = await b.svc.check(asHelper(), opts);
    assert.equal(r.decision, 'deny', what);
    assert.equal((await b.gateOf(r)).agent, 'helper', 'filed under the declared name: nothing better is known');
    const line = (await b.lines()).pop();
    assert.equal(line.agent, 'helper'); assert.equal(line.enforcedUnknown, true, what); assert.equal(line.declared, undefined);
    if (opts === never) assert.match(line.callerNotRead, /took longer than 40 ms/);
  }
  assert.equal(b.svc.callerReadings().notRead, 1, 'counted once: the note does not wait for the same lookup again');
  // an agent session that does not run under cmux, declaring the enforced builder: it is nobody the directory knows
  for (const ev of [OUTSIDE, NOBODY]) {
    assert.deepEqual(await b.svc.check(b.input(`gh pr merge ${n += 1}`, { workspaceId: 'W1' }), says(ev)), { decision: 'pass', observed: true });
    const line = (await b.lines()).pop();
    assert.equal(line.agent, 'unregistered:app'); assert.equal(line.declared, 'builder'); assert.equal(line.enforcedUnknown, undefined);
  }
});

test('gate check, names enforced: a headless run is named by its launchd job or by the workspace the board started — the role variable is ignored', async () => {
  const b = await gateBoard({ headlessWs: (ws) => (String(ws).toLowerCase() === 'w9' ? 'dispatch' : null) });
  const job = (name) => ({ kind: 'job', name, agentAncestor: false, browser: false });
  // observe (before): the launcher's variable names the run, and any session without a workspace can set it
  const declared = await b.svc.check(b.input('gh pr merge 21', { identity: 'triage' }));
  assert.equal(declared.decision, 'deny'); assert.equal((await b.gateOf(declared)).agent, 'headless:triage');
  // names enforced: the same variable from an observed agent's session changes nothing
  assert.deepEqual(await b.svc.check(b.input('gh pr merge 22', { identity: 'triage' }), says(session('helper', { workspaceId: 'w2' }))), { decision: 'pass', observed: true });
  // …and the real triage job needs no variable: the board asked launchd whose process it is
  const triage = await b.svc.check(b.input('gh pr merge 23'), says(job('headless:triage')));
  assert.equal(triage.decision, 'deny'); assert.equal((await b.gateOf(triage)).agent, 'headless:triage');
  assert.equal((await b.ledger.get(triage.task)).owner, 'coordinator', 'a headless run\'s gate lands on a task Mission Control owns');
  // a job mapped to a name the policy does not know as a role is nobody
  assert.deepEqual(await b.svc.check(b.input('gh pr merge 24'), says(job('headless:nope'))), { decision: 'pass', observed: true });
  assert.equal((await b.lines()).pop().agent, 'unregistered:app');
  // a card dispatch: the workspace the board itself started, until the reconciler registers it
  const fix = await b.svc.check(b.input('gh pr merge 25', { workspaceId: 'W9' }), says(session(null, { workspaceId: 'w9' })));
  assert.equal(fix.decision, 'deny'); assert.equal((await b.gateOf(fix)).agent, 'headless:dispatch');
  // any other workspace nobody registered stays unregistered
  assert.deepEqual(await b.svc.check(b.input('gh pr merge 26'), says(session(null, { workspaceId: 'w8' }))), { decision: 'pass', observed: true });
});

// ── typed approvals on the ledger ───────────────────────────────────────────
const SAID = 'owner said yes in the pane 10:02';
const TYPED = { decider: true, typed: true };
async function board() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caller typed-'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const ledger = createLedger(path.join(dir, 'tasks'));
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null,
  });
  const check = (command) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  // what server.mjs does after a PATCH: the grant is minted only for a gate that is approved
  const patch = async (p, ctx = {}) => { const r = await ledger.update(task.id, p, ctx); if (['gate_decide', 'gate_record'].includes(p.op) && p.decision !== 'decline') await svc.afterDecision(r.task, p.gate); return r; };
  const grants = async () => JSON.parse(await readFile(path.join(dir, 'guardrails', 'grants.json'), 'utf8').catch(() => '[]'));
  return { ledger, svc, check, patch, grants, id: task.id };
}
const approve = { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' };

test('a typed approval: kept on the gate as a row to confirm — nothing decided, nothing minted, the agent told to wait; the owner\'s click then approves it', async () => {
  const b = await board();
  assert.equal((await b.check(CMD)).decision, 'deny');
  // still the owner's token or nothing; and only an approval is kept
  await assert.rejects(b.patch(approve, { typed: true }), /from the board \(WORK panel\) only/);
  await assert.rejects(b.patch(approve, { ...TYPED, agentIdentity: true }), /from the board \(WORK panel\) only/);
  await assert.rejects(b.patch({ ...approve, decision: 'decline' }, TYPED), /only an approval typed in a terminal is kept .* decline on the board page/);
  await assert.rejects(b.patch({ ...approve, reason: 'the password: hunter2hunter2 is fine' }, TYPED), /looks like it contains a secret/);
  const r = await b.patch({ ...approve, reason: 'looks right' }, TYPED);
  const g = r.task.gates[0];
  assert.equal(g.status, 'pending'); assert.equal(g.decision, null); assert.equal(g.via, null); assert.equal(g.expires_at, null);
  assert.deepEqual({ ...g.proposal, at: null }, { decision: 'approve', text: 'looks right', by: 'terminal', at: null, kind: 'typed' });
  assert.equal(r.task.status, 'needs_approval');
  assert.deepEqual(await b.grants(), [], 'no grant was minted');
  assert.equal(pendingGates(r.task)[0].proposal.kind, 'typed');                       // the row can say what it is
  assert.equal(proposalWhat(g.proposal), 'the approval typed in a terminal');
  // the record is the board's, under nobody's name: the board cannot tell who typed it
  const c = r.task.comments.find((x) => x.gate?.event === 'proposed');
  assert.equal(c.who, 'board');
  assert.match(c.text, /^GATE g1: an approval was typed in a terminal on this machine, not on the board page\. The board cannot tell who typed it — it counts when .* confirms it on the board$/);
  assert.ok(!r.task.comments.some((x) => /APPROVED/.test(x.text)));
  assert.match(r.events[0], /GATE g1 approval typed in a terminal — waiting for .* to confirm on the board/);
  // the gated agent hears a hold: not approved yet, do not retry
  assert.deepEqual(r.wake, ['builder']); assert.equal(r.wakeKind, 'hold'); assert.deepEqual(r.wakeRef, { gate: 'g1' }); assert.equal(r.noteBoard, true);
  assert.match(r.note, /^gate g1: not approved yet\. An approval was typed in a terminal; .* must confirm it on the board\. Do not retry\.$/);
  assert.ok(r.note.length <= 160);
  // the call is still held; typing it again adds nothing
  assert.match((await b.check(CMD)).reason, /still waiting on the owner/);
  await assert.rejects(b.patch(approve, TYPED), /gate g1 on #\d+ already has an answer waiting: confirm it on the board page/);
  assert.equal((await b.ledger.get(b.id)).gates[0].proposal.text, 'looks right');
  // the owner's own click on the board: approved, minted, runs exactly once
  const ok = await b.patch(approve, { decider: true });
  assert.equal(ok.task.gates[0].status, 'approved'); assert.equal(ok.task.gates[0].via, 'board'); assert.ok(ok.task.gates[0].proposal.confirmed_at);
  assert.ok(ok.task.comments.some((x) => x.who === OWNER.id && /GATE g1 APPROVED by .* — confirming the approval typed in a terminal/.test(x.text)));
  assert.equal((await b.grants()).length, 1);
  assert.equal((await b.check(CMD)).decision, 'allow');
  const rows = auditRows(await b.ledger.get(b.id)).filter((x) => x.gate === 'g1');
  assert.deepEqual(rows.map((x) => x.event), ['requested', 'typed approval recorded', 'approved', 'released (run once)']);
  assert.equal(rows[1].actor, 'a terminal on this machine'); assert.equal(rows[1].via, 'confirmed by the owner on the board'); assert.equal(rows[1].reason, 'looks right');
  assert.match(rows[2].via, /board · confirming the approval typed in a terminal/);
});

test('a typed approval the owner did not type: rejected on the board and kept on the receipt; Mission Control hears of it; a waiting pane answer is never replaced', async () => {
  const b = await board();
  await b.check(CMD);
  await b.patch(approve, TYPED);
  const reject = { op: 'proposal_reject', actor: OWNER.id, gate: 'g1' };
  const r = await b.patch(reject, { decider: true });
  const g = r.task.gates[0];
  assert.equal(g.status, 'pending'); assert.equal(g.proposal, undefined); assert.equal(g.disowned.length, 1); assert.equal(g.disowned[0].kind, 'typed');
  assert.ok(r.task.comments.some((c) => c.who === OWNER.id && c.gate?.event === 'proposal_rejected' && /^NOT TYPED BY .*: the approval typed in a terminal for gate g1 was rejected on the board\. The gate still waits on /.test(c.text)));
  assert.match(r.events[0], /approval typed in a terminal REJECTED by .* \(gate g1\)/);
  // nobody recorded it, so there is no recorder to tell: the waiting agent, and Mission Control
  assert.deepEqual([...r.wake].sort(), ['builder', 'mission-control']);
  assert.equal(r.wakeKind, 'hold'); assert.deepEqual(r.wakeRef, { gate: 'g1' });
  assert.match(r.note, /rejected the approval typed in a terminal for gate g1: not typed by the owner\. Still waiting; do not act on it\.$/);
  assert.ok(r.note.length <= 160);
  const rows = auditRows(r.task);
  assert.deepEqual(rows.map((x) => x.event), ['requested', 'typed approval recorded', 'typed approval rejected']);
  assert.equal(rows[1].via, 'rejected by the owner'); assert.equal(rows[2].via, 'board · not typed by the owner');
  assert.equal((await b.check(CMD)).decision, 'deny'); assert.deepEqual(await b.grants(), []);
  // a pane answer Mission Control recorded already waits: a typed approval does not take its place
  await b.patch({ op: 'gate_record', actor: 'coordinator', gate: 'g1', decision: 'approve', text: SAID }, { mc: true, paneAnswers: 'confirm' });
  await assert.rejects(b.patch(approve, TYPED), /already has an answer waiting/);
  assert.equal((await b.ledger.get(b.id)).gates[0].proposal.by, 'coordinator');
  await b.patch(reject, { decider: true });
  // typed, then the owner declines on the board: declined, and the receipt says what had been typed
  await b.patch(approve, TYPED);
  const no = await b.patch({ ...approve, decision: 'decline' }, { decider: true });
  assert.equal(no.task.gates[0].status, 'declined'); assert.ok(no.task.gates[0].proposal.overruled_at);
  assert.ok(no.task.comments.some((c) => /GATE g1 DECLINED by .* — the approval typed in a terminal said approve/.test(c.text)));
  assert.equal(no.task.gates[0].disowned.length, 2, 'both rejected records stay on the receipt');
});

// ── "not what I said" on a task that had moved on ───────────────────────────
const base = { title: 'ship the feature', requester: 'helper', owner: 'builder', body: 'please ship it' };
function asking() {
  const claimed = applyPatch(newTask(base, { id: 7, now: 0 }), { op: 'claim', actor: 'builder' }).task;
  return applyPatch(claimed, { op: 'request_approval', actor: 'builder', policy_item: 'outward writes' }, { now: 1000 }).task;
}
const CONFIRM = { paneAnswers: 'confirm' };

test('"not what I said" on a task that had moved on puts it back where it was; a request that was really waiting goes on waiting', () => {
  // the task moved on without a recorded answer: in_progress, the request settled by the ledger as "unrecorded"
  const started = applyPatch(asking(), { op: 'start', actor: 'builder' }, { now: 1500 }).task;
  assert.equal(started.status, 'in_progress'); assert.equal(started.approval.decision, 'unrecorded');
  const heard = applyPatch(started, { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 }).task;
  assert.equal(heard.status, 'needs_approval');                                    // the record put it back in front of the owner
  // exactly where it was: status, what it was blocked on, and how the request had been settled
  assert.deepEqual(heard.approval.proposal.prev, { status: started.status, blocked_on: started.blocked_on, approval: { decided_by: null, decision: 'unrecorded', decided_at: iso(1500), via: 'inferred', recorded_by: 'builder', inferred_from: 'start' } });
  const r = applyPatch(heard, { op: 'proposal_reject', actor: OWNER.id }, { decider: true, now: 3000 });
  assert.equal(r.task.status, 'in_progress'); assert.deepEqual(r.task.blocked_on, started.blocked_on);
  assert.equal(r.task.approval.decision, 'unrecorded'); assert.equal(r.task.approval.inferred_from, 'start'); assert.equal(r.task.approval.decided_at, iso(1500));
  assert.equal(r.task.approval.proposal, undefined);
  assert.equal(r.task.approval.disowned.length, 1); assert.equal(r.task.approval.disowned[0].prev, undefined, 'the receipt keeps the record, not the bookkeeping');
  assert.deepEqual(summarize([r.task]).needsApproval, [], 'no APPROVE / DECLINE row is left standing for a question nobody asks');
  assert.ok(r.task.comments.some((c) => c.who === OWNER.id && /was rejected on the board\. Nothing was approved: the task is back to in_progress, as it was before the record\.$/.test(c.text)));
  assert.match(r.note, /not what was said\. Nothing was approved; #7 is back to in_progress\.$/); assert.ok(r.note.length <= 160);
  assert.equal(r.wakeKind, 'hold'); assert.deepEqual(r.wakeRef, { approval: true });
  assert.equal(holdOpen(r.task, r.wakeRef), true, 'the notice is still true after the task went back: nothing was approved');
  // blocked on the owner for a question before the record: back to blocked, still on the owner
  const stuck = applyPatch(started, { op: 'block', actor: 'builder', blocked_on: OWNER.id, text: 'which colour?' }, { now: 1700 }).task;
  const stuckHeard = applyPatch(stuck, { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 }).task;
  const back = applyPatch(stuckHeard, { op: 'proposal_reject', actor: OWNER.id }, { decider: true, now: 3000 }).task;
  assert.equal(back.status, 'blocked'); assert.deepEqual(back.blocked_on, [OWNER.id]);
  // the owner confirms instead: an ordinary approval, and the bookkeeping is gone
  const yes = applyPatch(heard, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true, now: 3000 }).task;
  assert.equal(yes.status, 'in_progress'); assert.equal(yes.approval.decision, 'approve'); assert.ok(yes.approval.proposal.confirmed_at); assert.equal(yes.approval.proposal.prev, undefined);
  // a request that was really waiting when the answer was recorded: nothing to go back to
  const waiting = applyPatch(asking(), { op: 'record_decision', actor: 'builder', text: SAID }, { ...CONFIRM, now: 2000 }).task;
  assert.equal(waiting.approval.proposal.prev, undefined);
  const still = applyPatch(waiting, { op: 'proposal_reject', actor: OWNER.id }, { decider: true, now: 3000 });
  assert.equal(still.task.status, 'needs_approval'); assert.match(still.note, /Still waiting; do not act on it\.$/);
});

// ── the hold wake ───────────────────────────────────────────────────────────
test('a hold ("not approved yet") is never replaced by a later message, and is dropped once the thing it is about was decided', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'caller hold-')), 'outbox.json');
  assert.ok(NEVER_SUPERSEDED.has(HOLD_KIND));
  const msg = (line, kind, at, extra = {}) => ({ to: 'builder', line, from: 'coordinator', taskId: 7, kind, queuedAt: at, attempts: 0, ...extra });
  await enqueue(msg('Task #7: gate g1: not approved yet.', HOLD_KIND, 1000, { ref: { gate: 'g1' } }), file);
  await enqueue(msg('comment on #7: carry on', 'message', 2000), file);
  await enqueue(msg('comment on #7: and another', 'message', 3000), file);
  // the comments replaced one another, as before; the hold is still queued
  assert.deepEqual((await readOutbox(file)).map((m) => [m.kind, m.line]), [[HOLD_KIND, 'Task #7: gate g1: not approved yet.'], ['message', 'comment on #7: and another']]);
  const resolve = async (name) => ({ name });
  const busy = async () => ({ queued: 'busy' });
  // still waiting, or not consulted: kept and retried
  let r = await drainOutbox({ file, now: 4000, resolve, deliver: busy, holdOpen: async () => true });
  assert.equal(r.dropped.length, 0); assert.equal(r.still.length, 2);
  r = await drainOutbox({ file, now: 4000, resolve, deliver: busy });
  assert.equal(r.dropped.length, 0); assert.equal(r.still.length, 2);
  // decided since: dropped with the reason, so it can never arrive after "APPROVED — run it". Only a hold is asked about.
  const asked = [];
  r = await drainOutbox({ file, now: 5000, resolve, deliver: busy, holdOpen: async (m) => { asked.push(m.ref); return false; } });
  assert.deepEqual(asked, [{ gate: 'g1' }]);
  assert.equal(r.dropped.length, 1); assert.equal(r.dropped[0].kind, HOLD_KIND); assert.equal(r.dropped[0].dropReason, 'decided since this was queued');
  assert.deepEqual((await readOutbox(file)).map((m) => m.kind), ['message']);

  // what "still waiting" means
  const t = { status: 'needs_approval', gates: [{ id: 'g1', status: 'pending' }, { id: 'g2', status: 'approved' }], approval: { requested_at: iso(1), decision: null } };
  assert.equal(holdOpen(t, { gate: 'g1' }), true); assert.equal(holdOpen(t, { gate: 'g2' }), false); assert.equal(holdOpen(t, { gate: 'g9' }), false);
  assert.equal(holdOpen(t, { approval: true }), true);
  for (const d of ['approve', 'decline']) assert.equal(holdOpen({ ...t, approval: { decision: d } }, { approval: true }), false);
  assert.equal(holdOpen({ ...t, approval: { decision: 'unrecorded' } }, { approval: true }), true, 'a request the ledger settled by itself was not decided by the owner');
  assert.equal(holdOpen(null, { gate: 'g1' }), false);
  for (const ref of [null, undefined, {}, 'g1']) assert.equal(holdOpen(t, ref), undefined);
  // the wake line: the board's own words, with the task id
  assert.equal(wakeMessage({ id: 7, title: 'ship it' }, 'hold', { note: 'gate g1: not approved yet. Do not retry.' }), 'Task #7: gate g1: not approved yet. Do not retry.');
  assert.match(wakeMessage({ id: 7, title: 'ship it', requester: 'github' }, 'hold', { note: 'gate g1: not approved yet. Do not retry.' }), /^Task #7: gate g1: not approved yet\./);
});

// ── the board page ──────────────────────────────────────────────────────────
const pageCtx = {};
vm.runInNewContext(readFileSync(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: pageCtx });
const { BoardDecide } = pageCtx;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

test('the row for a typed approval names nobody, quotes the reason escaped, and offers "I did not type this"', () => {
  const p = { decision: 'approve', text: 'ok <b>go</b>', by: 'terminal', at: '2026-01-05T10:02:00.000Z', kind: 'typed' };
  const line = BoardDecide.proposalHtml(p, esc);
  assert.match(line, /class="gate-meta gate-heard"/);
  assert.match(line, /An approval was typed in a terminal on this machine at 10:02Z: “ok &lt;b&gt;go&lt;\/b&gt;”\. The board cannot tell who typed it\. It counts only when you confirm it here\./);
  assert.ok(!line.includes('recorded your answer')); assert.ok(!line.includes('<b>'));
  assert.match(BoardDecide.proposalHtml({ ...p, text: '' }, esc), /on this machine at 10:02Z\. The board cannot tell who typed it\./);
  for (const settled of [{ ...p, confirmed_at: 'x' }, { ...p, overruled_at: 'x' }]) assert.equal(BoardDecide.proposalHtml(settled, esc), '');
  assert.deepEqual({ ...BoardDecide.heardLabels(p) }, { approve: '✓ CONFIRM', decline: '✕ DECLINE', disown: '⚑ I DID NOT TYPE THIS' });
  for (const pane of [{ by: 'coordinator' }, null, undefined]) assert.deepEqual({ ...BoardDecide.heardLabels(pane) }, { ...BoardDecide.HEARD_LABELS });
  assert.equal(BoardDecide.armedLabel('disown', 'g1', p), 'CLICK AGAIN: I DID NOT TYPE THIS (g1)');
  assert.equal(BoardDecide.armedLabel('disown', 'g1'), 'CLICK AGAIN: NOT WHAT I SAID (g1)');
  assert.equal(BoardDecide.armedLabel('approve', 'g1', p), 'CLICK AGAIN TO APPROVE g1');
  // the click sends the same request whichever kind of record waits
  assert.deepEqual({ ...BoardDecide.decisionBody('disown', 'g1', false) }, { op: 'proposal_reject', gate: 'g1' });
  assert.deepEqual({ ...BoardDecide.decisionBody('approve', 'g1', false) }, { op: 'gate_decide', gate: 'g1', decision: 'approve' });
});

// ── the running demo board (never the live one) ─────────────────────────────
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).status === 0;
const HAS_LSOF = has('lsof');
const HAS_CURL = has('curl');
const J = { 'content-type': 'application/json' };
async function demoBoard(caller, portBase) {
  const port = portBase + Math.floor(Math.random() * 40);
  // the shipped policy (every registered agent enforced), whatever policy this checkout's overlay holds
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'caller overlay-'));
  await writeFile(path.join(overlay, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: demoEnv({ MC_DEMO_CALLER: caller, MC_PORT: String(port), MC_OVERLAY: overlay }), stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  let status = null;
  for (let i = 0; i < 100 && !status; i += 1) { await new Promise((r) => setTimeout(r, 150)); status = await fetch(`${url}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null); }
  const get = (p) => fetch(`${url}${p}`).then((r) => r.json());
  const post = (p, body) => fetch(`${url}${p}`, { method: 'POST', headers: J, body: JSON.stringify(body) });
  const patch = (id, body) => fetch(`${url}/api/tasks/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify(body) });
  return { child, url, status, get, post, patch };
}

test('a running board, names enforced: a name this test process declares is not backed by it — its words go out marked, the name\'s standing is refused', { skip: !HAS_LSOF && 'lsof is not installed', timeout: 60000 }, async () => {
  const b = await demoBoard('on,agent', 39800);
  try {
    assert.ok(b.status?.demo, 'demo board answered');
    assert.equal(b.status.caller.mode, 'on'); assert.equal(b.status.caller.tripwire, 'agent');
    const { agents } = await b.get('/api/agents');
    const mc = agents.find((a) => a.kind === 'mission-control');
    const worker = agents.find((a) => a.kind !== 'mission-control' && a.status !== 'closed' && a.workspaceId);
    // a new task: filed, never dropped — and it says, where its owner reads it, that the requester was not verified
    const created = await b.post('/api/tasks', { title: 'names check', requester: mc.name, owner: worker.name });
    assert.equal(created.status, 201);
    const c = await created.json();
    assert.equal(c.unverifiedSender, true); assert.match(c.note, /could not verify the name/);
    const id = c.task.id;
    let t = await b.get(`/api/tasks/${id}`);
    assert.equal(t.requester, mc.name);
    assert.ok(t.comments.some((x) => x.who === 'board' && x.text.startsWith(`filed by an UNVERIFIED caller calling itself "${mc.name}" (`)));
    // a comment: recorded under the board's name, marked, with the reason
    const said = await b.patch(id, { op: 'comment', actor: worker.name, text: 'on it' });
    assert.equal(said.status, 200);
    const sb = await said.json();
    assert.equal(sb.unverifiedSender, true);
    const last = sb.task.comments[sb.task.comments.length - 1];
    assert.equal(last.who, 'board');
    assert.ok(last.text.startsWith(`comment from an UNVERIFIED caller calling itself "${worker.name}" (`)); assert.ok(last.text.endsWith('): on it'));
    // anything that needs the name's standing is refused, and says what to do instead
    for (const body of [{ op: 'claim', actor: worker.name }, { op: 'start', actor: worker.name }, { op: 'cancel', actor: mc.name, text: 'no' }, { op: 'gate_record', actor: mc.name, gate: 'g1', decision: 'approve', text: 'said yes' }]) {
      const r = await b.patch(id, body);
      assert.equal(r.status, 403, body.op);
      assert.match((await r.json()).msg, /^the board could not verify that you are ".+" \(.+\), so ".+" on task #\d+ is refused\. Run it from .+'s own pane, without --as /);
    }
    const focus = await b.post('/api/gates/focus', { actor: worker.name, task: id });
    assert.equal(focus.status, 403); assert.match((await focus.json()).msg, /could not verify that you are/);
    t = await b.get(`/api/tasks/${id}`);
    assert.equal(t.status, 'open'); assert.equal(t.owner, worker.name);          // nothing moved
    // a message: delivered marked, and the ledger line is the board's
    const sent = await b.post('/api/mesh/send', { to: worker.name, from: mc.name, text: 'please start', task: id });
    assert.equal(sent.status, 200); assert.equal((await sent.json()).unverifiedSender, true);
    t = await b.get(`/api/tasks/${id}`);
    assert.ok(t.comments.some((x) => x.who === 'board' && x.text.includes(`from an UNVERIFIED sender calling itself "${mc.name}": please start`)));
    // the board's own count: one per name it could not verify
    const caller = (await b.get('/api/status')).caller;
    assert.equal(caller.unverified, 8); assert.equal(caller.lastUnverified.declared, mc.name); assert.equal(caller.lastUnverified.what, 'a mesh message');
    // the gate hook: the workspace id it declares names nobody. Who runs this suite decides what the
    // board saw: a session it cannot name is enforced as declared, anyone else is not the agent declared.
    const why = caller.lastUnverified.why;
    const check = await (await b.post('/api/gates/check', { event: 'pre', engine: 'claude', tool: 'Bash', command: 'gh secret set DEMO_KEY', cwd: os.tmpdir(), workspaceId: worker.workspaceId })).json();
    if (/unregistered session|no agent session is behind/.test(why)) {
      assert.deepEqual(check, { decision: 'pass', observed: true }, 'the declared workspace id did not make this caller the agent');
      const { gates } = await b.get('/api/gates?status=all');
      assert.ok(!gates.some((g) => g.agent === worker.name && /DEMO_KEY/.test(g.command)));
    } else if (/could not be looked up/.test(why)) assert.equal(check.decision, 'deny', 'a failed lookup is enforced');
    else assert.ok(['pass', 'deny'].includes(check.decision));
  } finally { b.child.kill(); }
});

/**
 * A request with NO session behind it, whoever runs this suite: curl started by a shell that exits
 * at once, so it belongs to the init process — as an ordinary `cmd &` does, and as a command typed
 * in a plain terminal looks to the board. → { code, body }
 */
async function detached(url, token, body) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caller typed-'));
  const out = path.join(dir, 'body.json'); const code = path.join(dir, 'code');
  const cmd = `curl -s -m 20 -o "${out}" -w '%{http_code}' -X PATCH -H 'content-type: application/json' -H 'x-mesh-via: cli' -H 'x-mesh-decision: ${token}' -d '${JSON.stringify(body)}' "${url}" > "${code}.part" && mv "${code}.part" "${code}" &`;
  const sh = spawn('/bin/sh', ['-c', cmd], { stdio: 'ignore' });
  await new Promise((r) => sh.on('close', r));
  let c = '';
  for (let i = 0; i < 200 && !c; i += 1) { await new Promise((r) => setTimeout(r, 100)); c = await readFile(code, 'utf8').catch(() => ''); }
  assert.ok(c, 'the detached request was answered');
  return { code: Number(c), body: JSON.parse(await readFile(out, 'utf8').catch(() => '{}') || '{}') };
}

test('a running board, tripwire "browser": an approval typed in a terminal becomes a row to confirm; a typed decline is refused; nothing runs', { skip: (!HAS_LSOF || !HAS_CURL) && 'lsof or curl is not installed', timeout: 90000 }, async () => {
  const b = await demoBoard('observe,browser', 39845);
  try {
    assert.ok(b.status?.demo, 'demo board answered');
    assert.equal(b.status.caller.mode, 'observe'); assert.equal(b.status.caller.tripwire, 'browser');
    const token = /<meta name="mesh-decision" content="([0-9a-f]+)"/.exec(await (await fetch(`${b.url}/`)).text())[1];
    const { agents } = await b.get('/api/agents');
    const busy = new Set((await b.get('/api/tasks?status=live')).tasks.map((t) => t.owner));
    const agent = agents.find((a) => a.kind !== 'mission-control' && a.status !== 'closed' && a.workspaceId && !busy.has(a.name));
    assert.ok(agent, 'the demo seed has an agent with no live task (its gate then gets a task of its own)');
    // a gated call from that agent's hook (names are only observed on this board, so the declared workspace counts)
    const hook = () => b.post('/api/gates/check', { event: 'pre', engine: 'claude', tool: 'Bash', command: 'gh secret set DEMO_KEY', cwd: os.tmpdir(), workspaceId: agent.workspaceId }).then((r) => r.json());
    const held = await hook();
    assert.equal(held.decision, 'deny', JSON.stringify(held)); assert.ok(held.task && held.gate);
    const task = `${b.url}/api/tasks/${held.task}`;
    const approve = { op: 'gate_decide', gate: held.gate, decision: 'approve' };
    const gate = async () => (await b.get(`/api/tasks/${held.task}`)).gates.find((x) => x.id === held.gate);
    // typed in a terminal, with the real token: kept as a row, not decided
    const typed = await detached(task, token, { ...approve, reason: 'typed by hand' });
    assert.equal(typed.code, 202, JSON.stringify(typed.body)); assert.equal(typed.body.proposed, true); assert.match(typed.body.msg, /^kept as a row for .* to confirm on the board page \(one click\)\. Nothing was approved/);
    let g = await gate();
    assert.equal(g.status, 'pending'); assert.equal(g.decision, null);
    assert.equal(g.proposal.kind, 'typed'); assert.equal(g.proposal.by, 'terminal'); assert.equal(g.proposal.text, 'typed by hand');
    assert.match((await hook()).reason, /still waiting on the owner/);
    // the board's payload carries the row for the page
    const row = (await b.get('/api/status')).work.needsApproval.find((t) => t.id === held.task)?.gates?.find((x) => x.id === held.gate);
    assert.equal(row?.proposal?.kind, 'typed');
    // a typed decline is not kept: decline on the board page
    const no = await detached(task, token, { ...approve, decision: 'decline' });
    assert.equal(no.code, 403); assert.match(no.body.msg, /Decide on the board page/);
    // typing it again adds nothing; a wrong token is still a wrong token
    const again = await detached(task, token, approve);
    assert.equal(again.code, 409); assert.match(again.body.msg, /already has an answer waiting/);
    const bad = await detached(task, 'f'.repeat(48), approve);
    assert.equal(bad.code, 403); assert.match(bad.body.msg, /decision token rejected/);
    // rejecting the row is a decision like any other: from the board page only
    const disown = await detached(task, token, { op: 'proposal_reject', gate: held.gate });
    assert.equal(disown.code, 403); assert.match(disown.body.msg, /Decide on the board page/);
    g = await gate();
    assert.equal(g.status, 'pending'); assert.equal(g.proposal.kind, 'typed'); assert.equal(g.disowned, undefined);
    const caller = (await b.get('/api/status')).caller;
    assert.equal(caller.typedKept, 1, 'one typed approval was kept; the repeat and the wrong token were not');
    assert.equal(caller.refusedNotBrowser, 2); assert.equal(caller.refusedAgent, 0); assert.equal(caller.failed, 0);
  } finally { b.child.kill(); }
});

// ── wiring ──────────────────────────────────────────────────────────────────
test('the server and the command line wire it in: the typed row, the hold, the dispatch record, the notes a caller sees', () => {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  // a typed approval reaches the ledger as `typed`, is answered 202, and its wake is the board's
  assert.match(src, /ledger\.update\(tm\[1\], b, \{ decider, intake, typed, /);
  assert.match(src, /const speaker = typed \? 'board' : b\.actor;/);
  assert.match(src, /if \(typed\) return sendJson\(res, 202, \{ ok: true, task: r\.task, deliveries, proposed: true, /);
  // a hold keeps its kind and its ref into the outbox, and the drain asks the ledger whether it still holds
  assert.match(src, /ref: kind === 'hold' \? wakeRef : null/);
  assert.match(src, /holdOpen: async \(m\) => \(m\.taskId && m\.ref \? holdOpen\(await ledger\.get\(m\.taskId\), m\.ref\) : undefined\)/);
  // a card dispatch is known by the workspace the board started, not by a variable in its environment
  assert.match(src, /dispatchWorkspaces\.set\(String\(ws\.id\)\.toLowerCase\(\), Date\.now\(\)\);/);
  assert.match(src, /headlessWs: \(ws\) => \{/);
  // an unproven name: a comment is kept and marked, anything else is refused
  assert.match(src, /if \(b\.op !== 'comment'\) throw unprovenRefusal\(/);
  const cli = readFileSync(path.join(ROOT, 'scripts', 'mesh-cli.mjs'), 'utf8');
  assert.match(cli, /if \(r\.proposed\) return console\.log\(`#\$\{id\} \$\{gate\}: NOT approved yet\./);
  assert.equal((cli.match(/if \(r\.unverifiedSender\) console\.log\(/g) || []).length, 3);
});
