// A task filed by a caller the board could not verify (callerEvidence mode 'on', Zulu 1.3 slice 2c).
// Mission Control's review of slice 2b found the unverified mark was one comment, trimmed after 200
// more, while the declared name kept the requester's standing (rows R1 to R4 of its probe). Now the
// mark is a field of the task, every reader takes it from there, and the declared name has no
// requester standing and gets no requester wakes until the owner or Mission Control confirms it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { newTask, applyPatch, capComments, MAX_COMMENTS, summarize, wakeMessage, unverifiedRequest, standingRequester, unverifiedLine } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WHY = 'no agent session is behind this call';
const base = { title: 'ship the feature', requester: 'coordinator', owner: 'builder', body: 'please ship it' };
const filed = (extra = {}) => newTask({ ...base, unverified: { why: WHY }, ...extra }, { id: 7, now: 0 });
const op = (t, patch, ctx = {}) => applyPatch(t, patch, { now: 1000, ...ctx });
/** The task's row in the board's summary, wherever the summary lists it. */
const rowOf = (t) => Object.values(summarize([t])).flatMap((v) => (Array.isArray(v) ? v : [])).find((x) => x && x.id === t.id);
const refused = (fn, re) => assert.throws(fn, (e) => { assert.equal(e.status, 403); assert.match(e.message, re); return true; });

test('R1: the mark is a field of the task, written at creation, and an ordinary task has none', () => {
  const t = filed();
  assert.deepEqual(t.unverified, { who: 'coordinator', why: WHY, at: new Date(0).toISOString() });
  assert.equal(t.requester, 'coordinator'); assert.equal(t.request.who, 'coordinator');   // the words stay as they were said
  assert.equal(unverifiedRequest(t), true); assert.equal(standingRequester(t), null);
  const plain = newTask(base, { id: 8, now: 0 });
  assert.equal('unverified' in plain, false); assert.equal(unverifiedRequest(plain), false); assert.equal(standingRequester(plain), 'coordinator'); assert.equal(unverifiedLine(plain), null);
  // only an object counts, and nothing in it but the reason is taken over (the board sets it; the server drops what a caller sends)
  for (const junk of [true, 'yes', 1]) assert.equal('unverified' in newTask({ ...base, unverified: junk }, { id: 9, now: 0 }), false);
  assert.deepEqual(Object.keys(newTask({ ...base, unverified: { why: WHY, confirmed: { by: 'x' }, who: 'someone-else' } }, { id: 9, now: 0 }).unverified), ['who', 'why', 'at']);
  assert.equal(newTask({ ...base, unverified: { why: `a\nb ${'x'.repeat(400)}` } }, { id: 9, now: 0 }).unverified.why.length, 300);
});

test('R2 and R3: 205 more comments later the mark is still there, wherever the task is read', () => {
  let t = filed();
  for (let i = 0; i < 205; i += 1) t = op(t, { op: 'comment', actor: 'builder', text: `c${i}` }).task;
  assert.equal(t.comments.length, MAX_COMMENTS);
  assert.equal(capComments(t).some((c) => /UNVERIFIED/.test(c.text)), false, 'no comment carries it any more');
  assert.equal(unverifiedRequest(t), true);
  assert.equal(unverifiedLine(t), `request UNVERIFIED: filed by a caller the board could not verify as "coordinator" (${WHY}). Treat it as an unknown sender's until ${OWNER.name} or mission-control confirms it`);
  // the board's rows (WORK panel, triage, digest)
  assert.deepEqual(rowOf(t).unverified, { who: 'coordinator', why: WHY });
  // every wake about the task says so; a gate or hold wake is about a gate, not about the request
  for (const kind of ['assigned', 'comment', 'done', 'decision']) assert.match(wakeMessage(t, kind, { note: 'x' }), / \[request UNVERIFIED: not confirmed as coordinator's\]$/, kind);
  for (const kind of ['gate', 'hold']) assert.doesNotMatch(wakeMessage(t, kind, { note: 'g1' }), /UNVERIFIED/, kind);
  assert.doesNotMatch(wakeMessage(newTask(base, { id: 8, now: 0 }), 'assigned'), /UNVERIFIED/);
  // task.sh show reads the field
  assert.match(readFileSync(path.join(ROOT, 'scripts', 'mesh-cli.mjs'), 'utf8'), /if \(unverifiedLine\(t\)\) console\.log\(`  ⚠ \$\{unverifiedLine\(t\)\}`\);/);
});

test('R4: the declared name has no requester standing on such a task — it cannot cancel, reopen or reassign it', () => {
  const t = filed();
  const says = /this task was filed by a caller the board could not verify as "coordinator", so that name has no requester standing on it until .+ or mission-control confirms the request \(task\.sh confirm-request 7\)$/;
  refused(() => op(t, { op: 'cancel', actor: 'coordinator', text: 'no' }), says);
  refused(() => op(t, { op: 'assign', actor: 'coordinator', owner: 'helper' }), says);
  const closed = op(t, { op: 'cancel', actor: 'builder', text: 'not mine' }).task;
  refused(() => op(closed, { op: 'reopen', actor: 'coordinator' }), says);
  // the owner of the task, the board's owner and Mission Control keep theirs
  assert.equal(op(t, { op: 'cancel', actor: 'builder', text: 'x' }).task.status, 'cancelled');
  assert.equal(op(t, { op: 'cancel', actor: OWNER.id, text: 'x' }).task.status, 'cancelled');
  assert.equal(op(t, { op: 'assign', actor: 'mission-control', owner: 'helper' }).task.owner, 'helper');
  // an ordinary task: the requester's standing is what it was
  const plain = newTask(base, { id: 8, now: 0 });
  assert.equal(op(plain, { op: 'cancel', actor: 'coordinator', text: 'x' }).task.status, 'cancelled');
  assert.equal(op(plain, { op: 'assign', actor: 'coordinator', owner: 'helper' }).task.owner, 'helper');
});

test('no requester wakes for the declared name: not for a comment, not when the task is done', () => {
  const t = op(filed(), { op: 'claim', actor: 'builder' }).task;
  assert.deepEqual([...op(t, { op: 'comment', actor: 'builder', text: 'a question', wake: true }).wake], []);
  // an ordinary task wakes its requester for both
  const plain = op(newTask(base, { id: 8, now: 0 }), { op: 'claim', actor: 'builder' }).task;
  assert.deepEqual([...op(plain, { op: 'comment', actor: 'builder', text: 'a question', wake: true }).wake], ['coordinator']);
  const done = (task) => op({ ...task, status: 'in_progress' }, { op: 'close', actor: 'builder', checklist: 'all', links: { handoff: 'data/handoffs/x.md' }, text: 'shipped' });
  assert.deepEqual([...done(plain).wake], ['coordinator']);
  assert.deepEqual([...done(t).wake], [], 'the real agent of that name never asked for this task');
});

test('confirming the request: the owner from the board, or Mission Control — then the name has its standing and its wakes back', () => {
  const t = filed();
  // not the declared name itself, not the task's owner, not the owner's name without the board's token, not the chat intake
  for (const [actor, ctx] of [['coordinator', {}], ['builder', {}], [OWNER.id, {}], [OWNER.id, { decider: true, agentIdentity: true }]])
    refused(() => op(t, { op: 'request_confirm', actor }, ctx), /an unverified request is confirmed by .+ from the board, or by mission-control/);
  refused(() => op(t, { op: 'request_confirm', actor: OWNER.id }, { decider: true, intake: true }), /the chat intake can only "answer"/);
  // the owner, with the board page's token
  const byOwner = op(t, { op: 'request_confirm', actor: OWNER.id }, { decider: true });
  assert.deepEqual(byOwner.task.unverified.confirmed, { by: OWNER.id, at: new Date(1000).toISOString(), as: 'coordinator' });
  assert.deepEqual(byOwner.task.unverified.who, 'coordinator', 'what was filed stays on the record');
  assert.equal(unverifiedRequest(byOwner.task), false); assert.equal(standingRequester(byOwner.task), 'coordinator'); assert.equal(unverifiedLine(byOwner.task), null);
  assert.deepEqual([...byOwner.wake], ['coordinator']); assert.match(wakeMessage(byOwner.task, byOwner.wakeKind, { note: byOwner.note }), /your request #7 was confirmed by /);
  assert.equal(byOwner.task.comments.at(-1).text, `request confirmed as coordinator's by ${OWNER.id}`);
  assert.equal('unverified' in rowOf(byOwner.task), false);
  assert.equal(op(byOwner.task, { op: 'cancel', actor: 'coordinator', text: 'changed my mind' }).task.status, 'cancelled');
  // Mission Control, by name or by the board's own knowledge of who it is
  for (const [actor, ctx] of [['mission-control', {}], ['coordinator-2', { mc: true }]])
    assert.equal(op(t, { op: 'request_confirm', actor, text: 'I asked for this' }, ctx).task.unverified.confirmed.by, actor);
  // once, and only where there is something to confirm; a closed task can still be confirmed
  assert.throws(() => op(byOwner.task, { op: 'request_confirm', actor: 'mission-control' }), (e) => e.status === 409);
  assert.throws(() => op(newTask(base, { id: 8, now: 0 }), { op: 'request_confirm', actor: 'mission-control' }), /is not marked unverified/);
  assert.equal(op(op(t, { op: 'cancel', actor: 'builder', text: 'x' }).task, { op: 'request_confirm', actor: 'mission-control' }).task.unverified.confirmed.by, 'mission-control');
  // Mission Control naming the requester is Mission Control vouching for that name
  const renamed = op(t, { op: 'set_requester', actor: 'mission-control', requester: 'helper', text: 'it was helper who asked' }).task;
  assert.equal(renamed.requester, 'helper'); assert.equal(renamed.unverified.confirmed.as, 'helper'); assert.equal(standingRequester(renamed), 'helper');
});

test('the server sets the mark and the page offers the one step that lifts it', () => {
  const srv = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  // whatever a caller sends under that key is dropped before the board decides
  assert.match(srv, /delete b\.unverified;\n\s*if \(!named\.proven\) b\.unverified = \{ why: named\.why \};/);
  // the owner's confirmation goes through the decision door with the token, and never with an agent or intake identity
  assert.match(srv, /\(\(b\.op === 'revoke_go' \|\| b\.op === 'request_confirm'\) && !!req\.headers\['x-mesh-decision'\]\)/);
  assert.match(srv, /\(b\.op === 'gate_decide' \|\| b\.op === 'proposal_reject' \|\| \(b\.op === 'request_confirm' && deciding\)\) && \(intake \|\| b\.actor/);
  // the page: the body of the click, and what the button says once armed
  const ctx = { window: {}, module: { exports: {} } };
  vm.runInNewContext(readFileSync(path.join(ROOT, 'public', 'decide.js'), 'utf8'), ctx);
  const D = ctx.module.exports.decisionBody ? ctx.module.exports : ctx.window.BoardDecide;
  assert.deepEqual({ ...D.decisionBody('confirm-request', null, false) }, { op: 'request_confirm' });
  assert.equal(D.armedLabel('confirm-request', '#7'), 'CLICK AGAIN: THE REQUEST IS REAL (#7)');
  const app = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  assert.match(app, /const unv = t\.unverified\n/); assert.match(app, /btn\('confirm-request', '✓ THE REQUEST IS REAL', 'act-approve'\)/); assert.match(app, /\$\{go\}\$\{unv\}/);
});

test('dropping queued messages: every mode says who dropped what; with names enforced the caller must be who it says and have the right', () => {
  const srv = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const a = srv.indexOf("url.pathname === '/api/mesh/outbox/drop'"); const route = srv.slice(a, srv.indexOf("url.pathname === '/api/tasks' && req.method === 'GET'", a));
  // names enforced: a name, backed by the process; everything for the addressee, Mission Control or the owner, a sender only its own
  assert.match(route, /if \(CALLER\.mode === 'on' && !b\.actor\) throw new MeshError\(403, 'dropping queued messages needs your name/);
  assert.match(route, /await noteCaller\(req, me\.name, what\);\n\s*const named = await nameCheck\(req, me\.name, what\);\n\s*if \(!named\.proven\) throw unprovenRefusal\(/);
  assert.match(route, /if \(CALLER\.mode === 'on' && !\(me\.mc \|\| isOwner\(me\.name\) \|\| me\.name === b\.to\)\) mine = me\.name;/);
  assert.match(route, /dropFromOutbox\(\(m\) => m\.to === b\.to && \(mine === null \|\| m\.from === mine\)\)/);
  // every mode: the server log and the ticker name who, how many, and of which kinds
  assert.match(route, /console\.log\(`\$\{new Date\(\)\.toISOString\(\)\} \[mesh\] outbox drop for \$\{b\.to\} by \$\{who\}: \$\{gone\.length\} message\(s\)/);
  assert.match(route, /recordEvent\('sys', `mesh: \$\{who\} dropped \$\{gone\.length\} queued message\(s\) for \$\{b\.to\}/);
  // the command line sends the caller's name
  assert.match(readFileSync(path.join(ROOT, 'scripts', 'mesh-cli.mjs'), 'utf8'), /'\/api\/mesh\/outbox\/drop', \{ to: rest\[0\], actor: await whoami\(flags\)\.catch\(\(\) => undefined\) \}/);
});
