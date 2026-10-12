// node --test "test/*.test.mjs"
import test from 'node:test';
import { OWNER } from '../src/config.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  newTask, applyPatch, createLedger, missingChecklist, summarize, containsSecret, MeshError, CHECKLIST, checklistFrom, DEFAULT_CHECKLIST, undecidedApproval,
} from '../src/tasks.mjs';
import {
  buildDirectory, resolveTarget, reconcile, slugTitle, nameDrift, generatedAnchorIds, classifyScreen, deliveryDecision, deliverNow, drainOutbox,
  enqueue, kickSession, formatWake, validateMessage, expectedRestoreName, staleReason, ghostVerdict, mayProbe, PROBE_STABLE_MS,
  parseCreatedWorkspace, findWorkspace, resolveNewWorkspace,
} from '../src/mesh.mjs';
import { allowedSource, localOnly } from '../src/guard.mjs';

// ---- screen fixtures (trimmed from real `cmux read-screen` output, 2026-09-26) ----

const CLAUDE_READY = [
  '⏺ PONG',
  '✻ Worked for 2s · done 5:31 PM',
  '──────────────────────────────────────────── mesh-probe-gamma ─',
  '❯ ',
  '────────────────────────────────────────────────────────────────',
  '  ⏸ manual mode on · ? for shortcuts · ← 1 agent',
].join('\n');

const CLAUDE_BUSY = [
  '⏺ Reading 3 files…',
  '✻ Sautéing… (12s · ↓ 2.1k tokens · esc to interrupt)',
  '────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

const CLAUDE_DRAFT = [
  '────────────────────────────────────────────────────────────────',
  '❯ someone was typing somethi',
  '────────────────────────────────────────────────────────────────',
  '  ⏵⏵ accept edits on (shift+tab to cycle)',
].join('\n');

const CLAUDE_PERMISSION = [
  ' Bash command',
  '   git push origin agent-mesh',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and don\'t ask again for git push commands',
  '   3. No, and tell Claude what to do differently (esc)',
].join('\n');

const CLAUDE_TRUST = [
  ' Quick safety check: Is this a project you created or one you trust?',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

const CODEX_READY = [
  '  updated, and the vault is synced and verified on GitHub.',
  '  Worked for 2h 21m 39s · 3:18 PM',
  '                                Tip: Use /vim to toggle Vim editing in the composer.',
  '› Ask Codex to do anything',
  '  gpt-5 high · ~/my-app · Continue the staging deployment',
  '  ← for agents · ? for shortcuts                            ⚠ 1 warning · f2 to view',
].join('\n');

const CODEX_APPROVAL = [
  '  $ node /tmp/release-status.cjs',
  '› 1. Yes, proceed (y)',
  '  2. Yes, and don\'t ask again for commands that start with `node /tmp/release-',
  '     status.cjs` (p)',
  '  3. No, and tell Codex what to do differently (esc)',
  '  Press enter to confirm or esc to cancel',
].join('\n');

const SHELL = 'Last login: Sat Sep 26\nuser@mac probe % ';

// ---- screen classification + routing rule --------------------------------------

test('classifyScreen recognises ready/busy/draft/dialog/shell', () => {
  assert.equal(classifyScreen(CLAUDE_READY).state, 'ready');
  assert.equal(classifyScreen(CLAUDE_BUSY).state, 'busy');
  assert.deepEqual(classifyScreen(CLAUDE_DRAFT).state, 'draft');
  assert.equal(classifyScreen(CLAUDE_DRAFT).draft, 'someone was typing somethi');
  assert.equal(classifyScreen(CLAUDE_PERMISSION).state, 'dialog');
  assert.equal(classifyScreen(CLAUDE_TRUST).state, 'dialog');
  assert.equal(classifyScreen(CODEX_READY).state, 'ready');
  assert.equal(classifyScreen(CODEX_APPROVAL).state, 'dialog');
  assert.equal(classifyScreen(SHELL).state, 'shell');
});

test('dialog words far up the conversation do not block delivery', () => {
  const old = ['Do you want to proceed? (from an old answer)', ...Array(20).fill('⏺ some output')].join('\n');
  assert.equal(classifyScreen(old + '\n' + CLAUDE_READY).state, 'ready');
});

test('deliveryDecision: dialogs and drafts always queue, busy only with --wake', () => {
  assert.ok(deliveryDecision('ready').deliver);
  assert.ok(deliveryDecision('dialog', { wake: true }).queue);
  assert.ok(deliveryDecision('draft', { wake: true }).queue);
  assert.ok(deliveryDecision('shell', { wake: true }).queue);
  assert.ok(deliveryDecision('busy').queue);
  assert.ok(deliveryDecision('busy', { wake: true }).deliver);
});

function fakeCmux(screens) {
  const calls = [];
  let i = 0;
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'read-screen') return { err: null, out: screens[Math.min(i++, screens.length - 1)] };
    return { err: null, out: 'OK' };
  };
  return { run, calls };
}
const noSleep = async () => {};
const AGENT = { name: 'sales-agent', vendor: 'codex', kind: 'resident', workspaceId: '00000000-0000-4000-8000-000000000001' };

test('deliverNow never types into a pane showing a permission dialog', async () => {
  const { run, calls } = fakeCmux([CODEX_APPROVAL]);
  const r = await deliverNow(AGENT, '[mesh] hi', { run, sleep: noSleep, wake: true });
  assert.ok(r.queued);
  assert.ok(!calls.some((c) => c[0] === 'send' || c[0] === 'send-key'), 'no keystrokes sent');
});

test('deliverNow types + enters into a ready pane', async () => {
  const { run, calls } = fakeCmux([CODEX_READY, CODEX_READY]);
  const r = await deliverNow(AGENT, '[mesh] hi', { run, sleep: noSleep });
  assert.equal(r.delivered, true);
  assert.deepEqual(calls.find((c) => c[0] === 'send'), ['send', '--workspace', AGENT.workspaceId, '--', '[mesh] hi']);
  assert.equal(calls.filter((c) => c[0] === 'send-key').length, 1);
});

test('deliverNow presses Enter again if the line is still in the input box', async () => {
  const stuck = CLAUDE_READY.replace('❯ ', '❯ [mesh] from x: hello there');
  const { run, calls } = fakeCmux([CLAUDE_READY, stuck]);
  await deliverNow({ ...AGENT, vendor: 'claude' }, '[mesh] from x: hello there', { run, sleep: noSleep });
  assert.equal(calls.filter((c) => c[0] === 'send-key').length, 2);
});

test('mayProbe: only a text that sat unchanged for PROBE_STABLE_MS, never a proven draft', () => {
  const seen = new Map();
  assert.equal(mayProbe(seen, 'w', 'abc', 0), false, 'first sight');
  assert.equal(mayProbe(seen, 'w', 'abc', PROBE_STABLE_MS - 1), false, 'not stable long enough');
  assert.equal(mayProbe(seen, 'w', 'abcd', PROBE_STABLE_MS), false, 'someone is typing: clock restarts');
  assert.equal(mayProbe(seen, 'w', 'abcd', 2 * PROBE_STABLE_MS), true);
  seen.get('w').verdict = 'draft';
  assert.equal(mayProbe(seen, 'w', 'abcd', 9 * PROBE_STABLE_MS), false);
});

test('ghostVerdict: one probe character tells a prompt suggestion from a real draft (task #90)', () => {
  assert.equal(ghostVerdict('go ahead and pin v24', 'x'), 'ghost', 'a suggestion is replaced whole');
  assert.equal(ghostVerdict('fix the footer', 'fix the footerx'), 'draft', 'a typed draft gets the char appended');
  assert.equal(ghostVerdict('fix the footer', null), 'unknown');
  assert.equal(ghostVerdict('fix the footer', 'something else'), 'unknown');
});

test('deliverNow: an idle Claude pane showing a suggestion is probed, restored, then delivered (task #90)', async () => {
  const ghost = CLAUDE_READY.replace('❯ ', '❯ go ahead and pin v24');
  const probed = CLAUDE_READY.replace('❯ ', '❯ x');
  const seen = new Map();
  const first = fakeCmux([ghost]);
  const r0 = await deliverNow({ ...AGENT, vendor: 'claude' }, '[mesh] hi', { run: first.run, sleep: noSleep, seen, now: 0 });
  assert.ok(r0.queued, 'first sight: text not yet stable, no probe');
  assert.ok(!first.calls.some((c) => c[0] === 'send' || c[0] === 'send-key'));
  const { run, calls } = fakeCmux([ghost, probed, CLAUDE_READY]);
  const r = await deliverNow({ ...AGENT, vendor: 'claude' }, '[mesh] hi', { run, sleep: noSleep, seen, now: PROBE_STABLE_MS });
  assert.equal(r.delivered, true);
  const keys = calls.filter((c) => c[0] === 'send' || c[0] === 'send-key').map((c) => c.at(-1));
  assert.deepEqual(keys, ['x', 'backspace', '[mesh] hi', 'enter'], 'probe, undo, then the message');
});

test('deliverNow: a real draft in a Claude pane is probed, restored and the message queues with the text shown (task #90)', async () => {
  const draft = CLAUDE_READY.replace('❯ ', '❯ fix the footer');
  const appended = CLAUDE_READY.replace('❯ ', '❯ fix the footerx');
  const seen = new Map([['00000000-0000-4000-8000-000000000001', { text: 'fix the footer', since: 0, verdict: null }]]);
  const { run, calls } = fakeCmux([draft, appended]);
  const r = await deliverNow({ ...AGENT, vendor: 'claude' }, '[mesh] hi', { run, sleep: noSleep, seen, now: PROBE_STABLE_MS });
  assert.match(r.queued, /half-typed draft.*"fix the footer"/);
  const keys = calls.filter((c) => c[0] === 'send' || c[0] === 'send-key').map((c) => c.at(-1));
  assert.deepEqual(keys, ['x', 'backspace'], 'only the probe and its undo; the message is never typed');
  const again = fakeCmux([draft]);
  await deliverNow({ ...AGENT, vendor: 'claude' }, '[mesh] hi', { run: again.run, sleep: noSleep, seen, now: 10 * PROBE_STABLE_MS });
  assert.ok(!again.calls.some((c) => c[0] === 'send' || c[0] === 'send-key'), 'a proven draft is never probed again');
});

test('deliverNow: Codex panes and busy Claude panes are never probed', async () => {
  const draft = CODEX_READY.replace(/› .*/, '› fix the footer');
  const a = fakeCmux([draft]);
  await deliverNow(AGENT, '[mesh] hi', { run: a.run, sleep: noSleep });
  assert.ok(!a.calls.some((c) => c[0] === 'send' || c[0] === 'send-key'));
});

test('outbox: queued message delivers once the dialog is gone; expires after 24h', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-'));
  const file = path.join(dir, 'outbox.json');
  await enqueue({ to: 'sales-agent', line: 'L1', wake: false, queuedAt: 1000 }, file);
  await enqueue({ to: 'sales-agent', line: 'L1', wake: false, queuedAt: 1000 }, file);   // deduped
  await enqueue({ to: 'sales-agent', line: 'OLD', wake: false, queuedAt: 0 }, file);
  const resolve = async () => AGENT;
  let open = false;
  const deliver = async () => (open ? { delivered: true } : { queued: 'dialog' });
  let r = await drainOutbox({ file, now: 2000, resolve, deliver });
  assert.equal(r.still.length, 2);
  open = true;
  r = await drainOutbox({ file, now: 24 * 3600e3 + 500, resolve, deliver });
  assert.deepEqual(r.delivered.map((m) => m.line), ['L1']);
  assert.deepEqual(r.expired.map((m) => m.line), ['OLD']);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
});

test('messages are one short line that links to the task', () => {
  assert.match(formatWake({ from: 'a', text: 'do\nthing', taskId: 7 }), /^\[mesh\] from a: do thing \(task #7: curl -s localhost:3210\/api\/tasks\/7\)$/);
  assert.ok(validateMessage('x'.repeat(601)));
  assert.equal(validateMessage('fine'), null);
});

// ---- launch kick -----------------------------------------------------------------

test('kickSession waits for ready, submits, confirms busy', async () => {
  const splash = 'Welcome to Claude Code';
  const { run, calls } = fakeCmux([splash, splash, CLAUDE_READY, CLAUDE_BUSY]);
  let t = 0;
  const r = await kickSession({ workspace: 'W', line: 'Read the brief: /x', name: 'w1', run, sleep: noSleep, now: () => (t += 1000), registry: async () => [] });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.find((c) => c[0] === 'send'), ['send', '--workspace', 'W', '--', 'Read the brief: /x']);
});

test('kickSession re-presses Enter when the prompt sat unsubmitted (the 2.1.280 race)', async () => {
  const stuck = CLAUDE_READY.replace('❯ ', '❯ Read the brief: /x');
  const { run, calls } = fakeCmux([CLAUDE_READY, stuck, CLAUDE_BUSY]);
  let t = 0;
  const r = await kickSession({ workspace: 'W', line: 'Read the brief: /x', name: 'w1', run, sleep: noSleep, now: () => (t += 1000), registry: async () => [] });
  assert.equal(r.ok, true);
  assert.equal(r.attempt, 2);
  assert.equal(calls.filter((c) => c[0] === 'send').length, 1, 'text typed once');
});

test('kickSession never answers a trust dialog — reports it', async () => {
  const { run, calls } = fakeCmux([CLAUDE_TRUST]);
  let t = 0;
  const r = await kickSession({ workspace: 'W', line: 'x', name: 'w1', run, sleep: noSleep, now: () => (t += 5000), registry: async () => [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /dialog/);
  assert.ok(!calls.some((c) => c[0] === 'send' || c[0] === 'send-key'));
});

// ---- directory ---------------------------------------------------------------------

const AGENTS = [
  { name: 'mission-control-main', aliases: ['mission-control'], title: '⌘ MISSION CONTROL - MAIN', workspaceId: 'WS-MC', vendor: 'claude', kind: 'mission-control' },
  { name: 'app-ops', title: 'APP OPS', workspaceId: 'WS-SS', vendor: 'claude', kind: 'resident' },
  { name: 'web-docs', title: 'WEB DOCS', workspaceId: 'WS-DOCS', vendor: 'claude', kind: 'resident' },
  { name: 'web-ui', title: 'WEB UI (Codex)', workspaceId: 'WS-UI', vendor: 'codex', kind: 'resident' },
];
const REGISTRY = [
  { sessionId: 'aaaaaa11-0000', name: 'feature-integration', nameSource: 'auto', status: 'idle', pid: 1 },
  { sessionId: 'bbbbbb22-0000', name: 'app-ops', nameSource: 'user', status: 'busy', pid: 2 },
];
const MAP = { activeSessionsByWorkspace: { 'WS-MC': { sessionId: 'aaaaaa11-0000' }, 'WS-SS': { sessionId: 'bbbbbb22-0000' } }, sessions: {} };
const WS = [{ id: 'WS-MC', ref: 'workspace:1', title: '⌘ MISSION CONTROL - MAIN' }, { id: 'WS-SS', ref: 'workspace:28', title: 'APP OPS' }];

test('buildDirectory joins live sessions and flags drifted names', () => {
  const d = buildDirectory({ agents: AGENTS, registry: REGISTRY, sessionMap: MAP, workspaces: WS });
  const mc = d.find((e) => e.name === 'mission-control-main');
  assert.equal(mc.live.liveName, 'feature-integration');
  assert.equal(mc.live.nameOk, false);
  assert.equal(mc.ref, 'workspace:1');
  const ss = d.find((e) => e.name === 'app-ops');
  assert.equal(ss.live.status, 'busy');
  assert.equal(ss.live.nameOk, true);
  assert.equal(d.find((e) => e.name === 'web-ui').live, null);
});

test('resolveTarget: name, title, ref, uuid, prefix, ambiguity', () => {
  const d = buildDirectory({ agents: AGENTS, registry: REGISTRY, sessionMap: MAP, workspaces: WS });
  assert.equal(resolveTarget('app-ops', d).agent.name, 'app-ops');
  assert.equal(resolveTarget('MISSION CONTROL - MAIN', d).agent.name, 'mission-control-main');
  assert.equal(resolveTarget('mission-control', d).agent.name, 'mission-control-main', 'role alias');
  assert.equal(resolveTarget('workspace:28', d).agent.name, 'app-ops');
  assert.equal(resolveTarget('ws-docs', d).agent.name, 'web-docs');
  assert.equal(resolveTarget('feature-integration', d).agent.name, 'mission-control-main');
  assert.equal(resolveTarget('mission-control-main [aaaaaa]', d).agent.name, 'mission-control-main');
  const amb = resolveTarget('web', d);
  assert.ok(amb.error && amb.candidates.length === 2);
  assert.ok(resolveTarget('nobody', d).error);
});

test('resolveTarget: short fragments and closed agents never fuzzy-match; identities resolve exactly (task #78)', () => {
  const d = buildDirectory({ agents: AGENTS, registry: REGISTRY, sessionMap: MAP, workspaces: WS });
  const closed = [...d, { name: 'mesh-test-beta', title: 'MESH TEST BETA', status: 'closed', workspaceId: 'ws-beta' }];
  // the #76/#77 bug: "me" prefix-matched the only (closed) agent starting with it
  const me = resolveTarget('me', closed);
  assert.equal(me.agent, undefined);
  assert.match(me.error, /no agent "me"/);
  assert.equal(resolveTarget('mesh', closed).agent, undefined, 'prefix never lands on a closed agent');
  assert.equal(resolveTarget('mesh-test-beta', closed).agent.name, 'mesh-test-beta', 'an exact name still finds history');
  assert.equal(resolveTarget('app', closed).agent.name, 'app-ops', 'prefix ≥ 3 chars on an open agent still works');
  const ex = resolveTarget('app', closed, { exact: true });
  assert.equal(ex.agent, undefined, 'identities never prefix-match');
  assert.ok(ex.candidates.some((c) => c.startsWith('app-ops')), 'but the error names the near miss');
  assert.equal(resolveTarget('mission-control', closed, { exact: true }).agent.name, 'mission-control-main', 'role alias is exact');
});

// ---- ledger --------------------------------------------------------------------------

const base = { title: 'Rebuild search index', requester: 'mission-control', owner: 'app-ops' };

test('newTask validates required fields, enums and secrets', () => {
  const t = newTask(base, { id: 1, now: 0 });
  assert.equal(t.status, 'open');
  assert.deepEqual(Object.keys(t.checklist), CHECKLIST);
  assert.throws(() => newTask({ requester: 'x' }, { id: 1 }), /title/);
  assert.throws(() => newTask({ title: 't' }, { id: 1 }), /requester/);
  assert.throws(() => newTask({ ...base, priority: 'asap' }, { id: 1 }), /priority/);
  assert.throws(() => newTask({ ...base, links: { evil: 'x' } }, { id: 1 }), /unknown link/);
  assert.throws(() => newTask({ ...base, body: 'use key ' + 'sk-ant-' + 'api03-abcdefghijklmnopqrstuvwxyz' }, { id: 1 }), /secret/);
  // secret-shaped fixtures are assembled at runtime so no literal token ships (gitleaks in CI)
  assert.ok(containsSecret('SUPABASE_KEY=' + ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJyb2xlIjoic2VydmljZV9yb2xlIn0', 'abcdefghijklmnop'].join('.')));
  assert.ok(!containsSecret('the token budget is fine'));
});

test('close is rejected until the whole checklist + a report link are in', () => {
  let t = newTask(base, { id: 1, now: 0 });
  t = applyPatch(t, { op: 'claim', actor: 'app-ops' }).task;
  try { applyPatch(t, { op: 'close', actor: 'app-ops' }); assert.fail('should reject'); } catch (e) {
    assert.ok(e instanceof MeshError);
    assert.equal(e.status, 409);
    assert.deepEqual(e.extra.missing, CHECKLIST);
  }
  // the checklist is configurable (SETTINGS.ledger.checklist) — build from whatever this skin has
  const partial = Object.fromEntries(CHECKLIST.filter((k) => k !== 'report_written').map((k) => [k, true]));
  assert.throws(() => applyPatch(t, { op: 'close', actor: 'app-ops', checklist: partial }), /report_written/);
  const all = { ...partial, report_written: true };
  assert.throws(() => applyPatch(t, { op: 'close', actor: 'app-ops', checklist: all }), /links.handoff/);
  const r = applyPatch(t, { op: 'close', actor: 'app-ops', checklist: all, links: { handoff: 'data/handoffs/x.report.md' } });
  assert.equal(r.task.status, 'done');
  assert.deepEqual(missingChecklist(r.task), []);
  assert.deepEqual(r.wake, ['mission-control'], 'requester hears about completion');
});

test('ownership: one owner, only the owner closes, claim conflicts 409', () => {
  let t = newTask(base, { id: 1, now: 0 });
  assert.throws(() => applyPatch(t, { op: 'claim', actor: 'web-docs' }), (e) => e.status === 409);
  t = applyPatch(t, { op: 'claim', actor: 'app-ops' }).task;
  assert.throws(() => applyPatch(t, { op: 'block', actor: 'web-docs', blocked_on: OWNER.id }), (e) => e.status === 403);
});

test('approval flow: request → only the board decider can approve', () => {
  let t = applyPatch(newTask(base, { id: 3, now: 0 }), { op: 'claim', actor: 'app-ops' }).task;
  const req = applyPatch(t, { op: 'request_approval', actor: 'app-ops', policy_item: 'external writes' });
  assert.equal(req.task.status, 'needs_approval');
  assert.deepEqual(req.task.blocked_on, [OWNER.id]);
  assert.deepEqual(req.notifyMC, ['approval']);
  t = req.task;
  assert.throws(() => applyPatch(t, { op: 'decide', actor: 'app-ops', decision: 'approve' }), (e) => e.status === 403);
  const ok = applyPatch(t, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  assert.equal(ok.task.status, 'in_progress');
  assert.equal(ok.task.approval.decided_by, OWNER.id);
  assert.deepEqual(ok.wake, ['app-ops']);
  const no = applyPatch(t, { op: 'decide', actor: OWNER.id, decision: 'decline' }, { decider: true });
  assert.equal(no.task.status, 'blocked');
});

test('approval answered in the pane: owner records it; nothing stays pending', () => {
  const claimed = applyPatch(newTask(base, { id: 30, now: 0 }), { op: 'claim', actor: 'app-ops' }).task;
  const t = applyPatch(claimed, { op: 'request_approval', actor: 'app-ops', policy_item: 'external writes' }).task;
  // only the task owner (or MC) records, and only with the owner's words
  assert.throws(() => applyPatch(t, { op: 'record_decision', actor: 'web-docs', text: 'ok' }), (e) => e.status === 403);
  assert.throws(() => applyPatch(t, { op: 'record_decision', actor: 'app-ops' }), (e) => e.status === 400);
  const rec = applyPatch(t, { op: 'record_decision', actor: 'app-ops', text: 'owner said go in pane 10:58' });
  assert.equal(rec.task.status, 'in_progress');
  assert.deepEqual(rec.task.blocked_on, []);
  assert.equal(rec.task.approval.decision, 'approve');
  assert.equal(rec.task.approval.via, 'pane');
  assert.equal(rec.task.approval.decided_by, OWNER.id);
  assert.equal(rec.task.approval.recorded_by, 'app-ops');
  assert.deepEqual(rec.wake, []);
  assert.throws(() => applyPatch(rec.task, { op: 'record_decision', actor: 'app-ops', text: 'again' }), (e) => e.status === 409);
  const dec = applyPatch(t, { op: 'record_decision', actor: 'mission-control', decision: 'decline', text: 'owner said no' });
  assert.equal(dec.task.status, 'blocked');
  assert.deepEqual(dec.task.blocked_on, [OWNER.id]);
  // board decisions are never overwritten
  const board = applyPatch(t, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true }).task;
  assert.throws(() => applyPatch(board, { op: 'record_decision', actor: 'app-ops', text: 'x' }), (e) => e.status === 409);
});

test('approval: moving on without a decision settles it as unrecorded; cancel withdraws; record can follow on a done task', () => {
  const claimed = applyPatch(newTask(base, { id: 31, now: 0 }), { op: 'claim', actor: 'app-ops' }).task;
  const t = applyPatch(claimed, { op: 'request_approval', actor: 'app-ops', policy_item: 'external writes' }).task;
  assert.equal(undecidedApproval(t), true);
  const started = applyPatch(t, { op: 'start', actor: 'app-ops' }).task;
  assert.equal(started.approval.decision, 'unrecorded');
  assert.equal(started.approval.inferred_from, 'start');
  assert.equal(started.approval.decided_by, null);
  assert.equal(undecidedApproval(started), false);
  const closed = applyPatch(started, { op: 'close', actor: 'app-ops', checklist: 'all', links: { handoff: 'r.md' } }).task;
  const late = applyPatch(closed, { op: 'record_decision', actor: 'app-ops', text: 'owner approved in pane' }).task;
  assert.equal(late.status, 'done');
  assert.equal(late.approval.decision, 'approve');
  assert.equal(applyPatch(t, { op: 'cancel', actor: 'app-ops' }).task.approval.decision, 'withdrawn');
  // a comment while waiting leaves it pending
  assert.equal(applyPatch(t, { op: 'comment', actor: 'app-ops', text: 'still waiting' }).task.approval.decision, null);
});

test('ledger load settles approvals left undecided on tasks that moved on (backfill)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  const stale = { ...newTask(base, { id: 1, now: 0 }), status: 'done', approval: { policy_item: 'x', requested_at: 'a', requested_by: 'w', decided_by: null, decision: null, decided_at: null } };
  const live = { ...newTask(base, { id: 2, now: 0 }), status: 'needs_approval', approval: { ...stale.approval } };
  await writeFile(path.join(dir, '1.json'), JSON.stringify(stale));
  await writeFile(path.join(dir, '2.json'), JSON.stringify(live));
  const ledger = createLedger(dir);
  assert.equal((await ledger.get(1)).approval.decision, 'unrecorded');
  assert.equal((await ledger.get(2)).approval.decision, null, 'a real pending approval stays pending');
  assert.equal(JSON.parse(await readFile(path.join(dir, '1.json'), 'utf8')).approval.inferred_from, 'backfill');
});

test('set_requester: mission-control only, needs a reason, works on done tasks (task #78)', () => {
  const t = { ...newTask({ ...base, requester: 'mesh-test-beta' }, { id: 76, now: 0 }), status: 'done' };
  assert.throws(() => applyPatch(t, { op: 'set_requester', actor: 'app-ops', requester: 'mission-control-main', text: 'x' }), (e) => e.status === 403);
  assert.throws(() => applyPatch(t, { op: 'set_requester', actor: 'mission-control', requester: 'mission-control-main' }), (e) => e.status === 400);
  const r = applyPatch(t, { op: 'set_requester', actor: 'mission-control', requester: 'mission-control-main', requester_ws: 'WS-MC', text: '--as me misresolved' });
  assert.equal(r.task.requester, 'mission-control-main');
  assert.equal(r.task.requester_ws, 'WS-MC');
  assert.equal(r.task.status, 'done');
  assert.match(r.task.comments.at(-1).text, /mesh-test-beta → mission-control-main/);
  assert.deepEqual(r.wake, []);
});

test('comments wake nobody unless --wake', () => {
  const t = applyPatch(newTask(base, { id: 4, now: 0 }), { op: 'claim', actor: 'app-ops' }).task;
  assert.deepEqual(applyPatch(t, { op: 'comment', actor: 'app-ops', text: 'fyi' }).wake, []);
  assert.deepEqual(applyPatch(t, { op: 'comment', actor: 'app-ops', text: 'q?', wake: true }).wake, ['mission-control']);
  assert.throws(() => applyPatch(t, { op: 'comment', actor: 'x', text: 'y'.repeat(2001) }), /too long/);
});

test('ledger store: sequential ids, atomic files, survives reload, summary buckets', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tasks-'));
  const l1 = createLedger(dir);
  const [a, b] = await Promise.all([l1.create(base), l1.create({ ...base, owner: null })]);
  assert.deepEqual([a.id, b.id].sort(), [1, 2]);
  await l1.update(1, { op: 'claim', actor: 'app-ops' });
  await l1.update(1, { op: 'block', actor: 'app-ops', blocked_on: ['#2', OWNER.id] });
  const l2 = createLedger(dir);                       // fresh process view
  const t1 = await l2.get(1);
  assert.equal(t1.status, 'blocked');
  assert.deepEqual(t1.blocked_on, [2, OWNER.id]);
  assert.equal((await l2.list({ status: 'live' })).length, 2);
  assert.equal((await l2.list({ owner: 'app-ops' })).length, 1);
  const s = summarize(await l2.list());
  assert.equal(s.counts.blocked, 1);
  assert.equal(s.counts.open, 1);
});

// ---- API source guard ----------------------------------------------------------------

test('source guard: localhost + tailnet only; LAN refused; event/send localhost-only', () => {
  const req = (ip) => ({ socket: { remoteAddress: ip } });
  assert.ok(allowedSource(req('127.0.0.1')));
  assert.ok(allowedSource(req('::ffff:127.0.0.1')));
  assert.ok(allowedSource(req('100.101.102.103')));
  assert.ok(!allowedSource(req('192.168.1.20')));
  assert.ok(!allowedSource(req('100.200.1.1')));     // outside 100.64/10
  assert.ok(localOnly(req('::1')));
  assert.ok(!localOnly(req('100.101.102.103')));
});

// ---- identity = workspace title; reconciler ------------------------------------------

test('slugTitle derives the address from the workspace title', () => {
  assert.equal(slugTitle('⌘ MISSION CONTROL - MAIN'), 'mission-control-main');
  assert.equal(slugTitle('⚙ RESIDENT: WEB DOCS'), 'resident-web-docs');
  assert.equal(slugTitle('Mobile UI (Codex)'), 'mobile-ui-codex');
  assert.equal(slugTitle('✳ Report runner: nightly batch'), 'report-runner-nightly-batch');
});

test('a renamed workspace adopts the new name; old name still resolves', () => {
  const doc = { agents: AGENTS.map((a) => ({ ...a, status: 'active' })) };
  const ws = [...WS, { id: 'WS-DOCS', ref: 'workspace:22', title: 'DOCS DESK' }, { id: 'WS-UI', ref: 'workspace:4', title: 'WEB UI (Codex)' }];
  const { doc: out, changes } = reconcile(doc, { workspaces: ws });
  assert.deepEqual(changes.renamed.map((r) => [r.from, r.to]), [['web-docs', 'docs-desk'], ['web-ui', 'web-ui-codex']]);
  const docs = out.agents.find((a) => a.workspaceId === 'WS-DOCS');
  assert.equal(docs.name, 'docs-desk');
  assert.deepEqual(docs.previousNames, ['web-docs']);
  const d = buildDirectory({ agents: out.agents, workspaces: ws });
  assert.equal(resolveTarget('web-docs', d).agent.name, 'docs-desk');
});

test('reconciler auto-registers new workspaces and closes vanished ones (never on an empty listing)', () => {
  const doc = { agents: AGENTS.map((a) => ({ ...a, status: 'active' })) };
  const ws = [
    { id: 'WS-MC', ref: 'workspace:1', title: '⌘ MISSION CONTROL - MAIN' },
    { id: 'WS-NEW', ref: 'workspace:40', title: 'Hand Made Workspace' },
  ];
  const sessionMap = { activeSessionsByWorkspace: { 'WS-NEW': { sessionId: 's1' } }, sessions: { s1: { cwd: '/Users/me/project' } } };
  const { doc: out, changes } = reconcile(doc, { workspaces: ws, sessionMap });
  assert.equal(changes.added.length, 1);
  const n = changes.added[0];
  assert.equal(n.name, 'hand-made-workspace');
  assert.equal(n.vendor, 'claude');
  assert.equal(n.repo, '~/project');
  assert.equal(n.needsOwnership, true);
  assert.deepEqual(changes.closed.map((a) => a.name).sort(), ['app-ops', 'web-docs', 'web-ui']);
  assert.ok(out.agents.every((a) => a.name), 'history kept, nothing deleted');
  assert.equal(out.agents.length, 5);
  const empty = reconcile(doc, { workspaces: [] });
  assert.equal(empty.changes.closed.length, 0);
  assert.ok(empty.skipped);
  const again = reconcile(out, { workspaces: ws, sessionMap });
  assert.equal(again.changes.added.length, 0, 'idempotent');
});

test('nameDrift lists live Claude sessions whose name differs from the title-derived one', () => {
  const d = buildDirectory({ agents: AGENTS, registry: REGISTRY, sessionMap: MAP, workspaces: WS });
  assert.deepEqual(nameDrift(d).map((a) => a.name), ['mission-control-main']);
});

test('restore name: captured --name launch arg beats a later /rename; else transcript name', () => {
  assert.equal(expectedRestoreName(['--name', 'mesh-test-alpha', '--model', 'x'], 'mesh-test-beta'), 'mesh-test-alpha');
  assert.equal(expectedRestoreName(['--name=a'], 'b'), 'a');
  assert.equal(expectedRestoreName(['--model', 'x'], 'mesh-test-beta'), 'mesh-test-beta');
  assert.equal(expectedRestoreName(['--model', 'x'], null), null);
});

// ---- cmux-generated group anchors are not agents (2026-09-27 sync-groups incident) ----

const GROUPS = { groups: [
  { name: 'OPS', ref: 'workspace_group:1', anchor_workspace_is_generated: true, anchor_workspace_provenance: 'generated', anchor_workspace_ref: 'workspace:22' },
  { name: 'APP', ref: 'workspace_group:2', anchor_workspace_is_generated: false, anchor_workspace_provenance: 'captured', anchor_workspace_ref: 'workspace:8' },
] };

test('generatedAnchorIds maps generated anchors (only) to workspace UUIDs', () => {
  const ws = [{ ref: 'workspace:22', id: 'WS-GEN' }, { ref: 'workspace:8', id: 'WS-SS' }];
  assert.deepEqual([...generatedAnchorIds(GROUPS, ws)], ['WS-GEN']);
  assert.equal(generatedAnchorIds(null, ws).size, 0);
});

test('reconcile never registers a generated anchor and purges placeholder entries for them', () => {
  const doc = { agents: [
    ...AGENTS.map((a) => ({ ...a, status: 'active' })),
    { name: 'ops', title: 'OPS', workspaceId: 'WS-GEN', kind: 'unassigned', needsOwnership: true, owns: [], status: 'active' },
    { name: 'kept', title: 'KEPT', workspaceId: 'WS-GEN2', kind: 'resident', owns: ['real work'], status: 'active' },
  ] };
  const ws = [...WS, { id: 'WS-GEN', ref: 'workspace:22', title: 'OPS' }, { id: 'WS-GEN2', ref: 'workspace:30', title: 'KEPT' },
    { id: 'WS-GEN3', ref: 'workspace:31', title: 'APP' }];
  const { doc: out, changes } = reconcile(doc, { workspaces: ws, ignoreIds: new Set(['WS-GEN', 'WS-GEN2', 'WS-GEN3']) });
  assert.deepEqual(changes.purged.map((a) => a.name), ['ops']);
  assert.deepEqual(changes.added, [], 'a fresh generated anchor is not auto-registered');
  assert.ok(!out.agents.some((a) => a.workspaceId === 'WS-GEN'));
  assert.ok(out.agents.some((a) => a.name === 'kept'), 'an entry someone gave ownership to is kept');
});

// ---- stale wakes (2026-09-27: "Task #5 assigned" delivered after #5 was cancelled) ----

test('staleReason: assigned/cc wakes die when their task ends; approval never; done notices expire after 2h', () => {
  const now = 10 * 3600e3;
  const assigned = { taskId: 5, kind: 'assigned', taskStatus: 'open', queuedAt: now - 60e3 };
  assert.match(staleReason(assigned, 'cancelled', now), /cancelled since this was queued/);
  assert.match(staleReason(assigned, 'done', now), /done since/);
  assert.equal(staleReason(assigned, 'in_progress', now), null, 'live task → keep retrying');
  assert.match(staleReason(assigned, null, now), /no longer exists/);
  assert.equal(staleReason({ ...assigned, kind: 'approval' }, 'cancelled', now), null, 'approval wakes are never dropped');
  const doneNotice = { taskId: 10, kind: 'done', taskStatus: 'done', queuedAt: now - 30 * 60e3 };
  assert.equal(staleReason(doneNotice, 'done', now), null, 'a fresh completion notice is kept');
  assert.match(staleReason({ ...doneNotice, queuedAt: now - 3 * 3600e3 }, 'done', now), /older than 2h/);
  assert.equal(staleReason({ line: 'x', kind: 'message' }, 'cancelled', now), null, 'task-less messages are not judged');
});

test('drainOutbox drops stale task wakes without delivering them; enqueue supersedes older wakes per task', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-stale-'));
  const file = path.join(dir, 'outbox.json');
  const now = 5 * 3600e3;
  await enqueue({ to: 'mission-control-main', line: 'Task #5 assigned', taskId: 5, kind: 'assigned', taskStatus: 'open', queuedAt: now - 1000 }, file);
  await enqueue({ to: 'mission-control-main', line: 'Task #6 assigned', taskId: 6, kind: 'assigned', taskStatus: 'open', queuedAt: now - 1000 }, file);
  await enqueue({ to: 'mission-control-main', line: 'Task #6 blocked', taskId: 6, kind: 'cc', taskStatus: 'blocked', queuedAt: now - 500 }, file);
  let box = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(box.map((m) => m.line), ['Task #5 assigned', 'Task #6 blocked'], 'newer wake for #6 superseded the older one');
  const delivered = [];
  const r = await drainOutbox({
    file, now,
    resolve: async () => AGENT,
    deliver: async (_a, line) => { delivered.push(line); return { queued: 'busy' }; },
    taskStatus: async (id) => ({ 5: 'cancelled', 6: 'blocked' }[id]),
  });
  assert.deepEqual(r.dropped.map((m) => m.line), ['Task #5 assigned']);
  assert.deepEqual(delivered, ['Task #6 blocked'], 'the dropped wake was never typed');
  box = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(box.map((m) => m.line), ['Task #6 blocked']);
});

// ---- wake labels come from the op, not the task state (task #20) ----------------------
import { wakeMessage } from '../src/tasks.mjs';

test('a comment wakes owner/requester as a COMMENT, never "assigned"/"done", and never the commenter', () => {
  let t = applyPatch(newTask({ title: 'Release publish', requester: 'mission-control-main', owner: 'api-resident' }, { id: 19, now: 0 }),
    { op: 'claim', actor: 'api-resident' }).task;
  const c = applyPatch(t, { op: 'comment', actor: 'mission-control-main', text: 'R1 test item = #1001\nmore', wake: true });
  assert.deepEqual(c.wake, ['api-resident']);
  assert.equal(c.wakeKind, 'comment');
  assert.equal(wakeMessage(c.task, c.wakeKind, { note: c.note }), 'comment on #19 (Release publish): R1 test item = #1001');
  const d = applyPatch(t, { op: 'close', actor: 'api-resident', checklist: 'all', links: { pr: 'x' } });
  assert.equal(d.wakeKind, 'done');
  assert.deepEqual(d.wake, ['mission-control-main'], 'the done notice fires once, on the transition');
  const later = applyPatch(d.task, { op: 'comment', actor: 'mission-control-main', text: 'thanks', wake: true });
  assert.deepEqual(later.wake, ['api-resident']);
  assert.equal(later.wakeKind, 'comment', 'a later comment on a done task is not another "done"');
  const quiet = applyPatch(d.task, { op: 'comment', actor: 'api-resident', text: 'fyi' });
  assert.deepEqual(quiet.wake, []);
  assert.equal(quiet.wakeKind, null);
});

test('"assigned" wakes only on an owner change', () => {
  const t = newTask({ title: 'x', requester: 'mission-control-main', owner: 'web-app' }, { id: 18, now: 0 });
  const same = applyPatch(t, { op: 'assign', actor: 'mission-control-main', owner: 'web-app' });
  assert.deepEqual(same.wake, []);
  const moved = applyPatch(t, { op: 'assign', actor: 'mission-control-main', owner: 'app-ops' });
  assert.deepEqual([moved.wake, moved.wakeKind], [['app-ops'], 'assigned']);
});

test('a queued done notice is not superseded by a later comment wake for the same task', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mesh-done-'));
  const file = path.join(dir, 'outbox.json');
  await enqueue({ to: 'mission-control-main', line: 'Task #19 done', taskId: 19, kind: 'done', taskStatus: 'done', queuedAt: 1 }, file);
  await enqueue({ to: 'mission-control-main', line: 'comment on #19', taskId: 19, kind: 'message', taskStatus: 'done', queuedAt: 2 }, file);
  await enqueue({ to: 'mission-control-main', line: 'comment 2 on #19', taskId: 19, kind: 'message', taskStatus: 'done', queuedAt: 3 }, file);
  const box = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(box.map((m) => m.line), ['Task #19 done', 'comment 2 on #19']);
});

test('close checklist: registry-configured, default docs + report, "all" ticks every item', () => {
  assert.deepEqual(checklistFrom({}), DEFAULT_CHECKLIST);
  assert.deepEqual(DEFAULT_CHECKLIST, ['docs_updated', 'report_written']);
  assert.deepEqual(checklistFrom({ ledger: { checklist: ['a_b', 'a_b', 'c'] } }), ['a_b', 'c']);
  assert.throws(() => checklistFrom({ ledger: { checklist: ['Bad Item'] } }), /bad item/);
  let t = newTask(base, { id: 1, now: 0 });
  t = applyPatch(t, { op: 'claim', actor: 'app-ops' }).task;
  const r = applyPatch(t, { op: 'close', actor: 'app-ops', checklist: 'all', links: { handoff: 'x.report.md' } });
  assert.equal(r.task.status, 'done');
  assert.ok(CHECKLIST.every((k) => r.task.checklist[k] === true));
  assert.throws(() => applyPatch(t, { op: 'checklist', actor: 'app-ops', checklist: { not_an_item: true } }), /unknown checklist item/);
});

// ---- just-created workspaces (task #138) -----------------------------------------

const NEW_OUT = 'OK workspace:1000000031 (00000000-0000-4000-8000-0000000000aa) surface:1000000040 (00000000-0000-4000-8000-0000000000BB)';
const LIST = [
  { ref: 'workspace:1000000000', id: '00000000-0000-4000-8000-0000000000CC', title: '⌘ MISSION CONTROL - MAIN' },
  { ref: 'workspace:1000000031', id: '00000000-0000-4000-8000-0000000000AA', title: 'fix: lead sync' },
];

test('parseCreatedWorkspace: the UUID cmux prints with --id-format both (workspace, not surface)', () => {
  assert.equal(parseCreatedWorkspace(NEW_OUT), '00000000-0000-4000-8000-0000000000AA');
  assert.equal(parseCreatedWorkspace('OK workspace:1000000031'), null, 'refs-only output');
  assert.equal(parseCreatedWorkspace(''), null);
});

test('findWorkspace: by ref, else a unique title', () => {
  assert.equal(findWorkspace(LIST, 'workspace:1000000031', null), LIST[1].id);
  assert.equal(findWorkspace(LIST, 'workspace:9', 'fix: lead sync'), LIST[1].id);
  assert.equal(findWorkspace([...LIST, { ...LIST[1], ref: 'workspace:7', id: 'X' }], null, 'fix: lead sync'), null, 'ambiguous title');
});

test('resolveNewWorkspace: output first; else retries the listing until the ref appears; else title', async () => {
  let calls = 0;
  const list = async () => (++calls < 3 ? LIST.slice(0, 1) : LIST);   // the new ref shows up on the 3rd read
  const sleep = async () => {};
  assert.deepEqual(await resolveNewWorkspace({ out: NEW_OUT, list, sleep }), { id: LIST[1].id, via: 'new-workspace output' });
  assert.equal(calls, 0, 'no listing needed when cmux printed the UUID');
  const r = await resolveNewWorkspace({ out: 'OK workspace:1000000031', ref: 'workspace:1000000031', list, sleep });
  assert.equal(r.id, LIST[1].id);
  assert.match(r.via, /try 3/);
  const t = await resolveNewWorkspace({ ref: 'workspace:404', title: 'fix: lead sync', list: async () => LIST, sleep, tries: 2 });
  assert.deepEqual(t, { id: LIST[1].id, via: 'unique title match' });
  assert.deepEqual(await resolveNewWorkspace({ ref: 'workspace:404', list: async () => LIST, sleep, tries: 2 }), { id: null });
});

// ---- listings across every cmux window + demo isolation (task #152) ---------------

import { parseWindows, acrossWindows, isDemoWorkspace, DEMO_TITLE_PREFIX } from '../src/mesh.mjs';

const WIN_A = '00000000-0000-4000-8000-00000000000A';
const WIN_B = '00000000-0000-4000-8000-00000000000B';

test('parseWindows reads cmux list-windows rows', () => {
  const out = `* 0: ${WIN_A} selected_workspace=x workspaces=27\n  1: ${WIN_B} selected_workspace=y workspaces=7\n`;
  assert.deepEqual(parseWindows(out), [WIN_A, WIN_B]);
  assert.deepEqual(parseWindows(''), []);
});

test('acrossWindows: one window = the old call; two = every window; any failure fails it all', async () => {
  const calls = [];
  const fake = (wins, fail = null) => async (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'list-windows') return { err: null, out: wins.map((w, i) => `${i ? ' ' : '*'} ${i}: ${w} workspaces=1`).join('\n') };
    const w = args[args.indexOf('--window') + 1];
    if (fail && w === fail) return { err: 'boom', out: '' };
    if (args.includes('--json')) return { err: null, out: JSON.stringify({ workspaces: [{ id: `ws-in-${args.includes('--window') ? w : 'current'}` }] }) };
    return { err: null, out: `workspace:1 in ${args.includes('--window') ? w : 'current'}` };
  };
  const one = await acrossWindows(fake([WIN_A]), ['workspace', 'list']);
  assert.equal(one.out, 'workspace:1 in current');
  assert.ok(!calls.some((c) => c.includes('--window')), 'single window: unchanged call');
  const two = await acrossWindows(fake([WIN_A, WIN_B]), ['workspace', 'list']);
  assert.match(two.out, new RegExp(`in ${WIN_A}[\\s\\S]*in ${WIN_B}`));
  const js = JSON.parse((await acrossWindows(fake([WIN_A, WIN_B]), ['workspace', 'list', '--json'])).out);
  assert.deepEqual(js.workspaces.map((w) => w.id), [`ws-in-${WIN_A}`, `ws-in-${WIN_B}`]);
  const bad = await acrossWindows(fake([WIN_A, WIN_B], WIN_B), ['workspace', 'list']);
  assert.equal(bad.err, 'boom', 'a partial listing must never look like "the rest closed"');
});

test('isDemoWorkspace: the demo title prefix or a recorded demo id, nothing else', () => {
  assert.equal(isDemoWorkspace({ id: 'x', title: `${DEMO_TITLE_PREFIX} · needs-input` }), true);
  assert.equal(isDemoWorkspace({ id: 'x', name: 'zulu demo' }), true);
  assert.equal(isDemoWorkspace({ id: WIN_A.toLowerCase(), title: 'anything' }, new Set([WIN_A])), true);
  assert.equal(isDemoWorkspace({ id: 'x', title: 'app — resident' }), false);
  assert.equal(isDemoWorkspace({ id: 'x', title: 'my zulu demo notes' }), false, 'prefix only');
});

test('reconcile never registers a demo workspace (server passes them as ignoreIds)', () => {
  const doc = { agents: [] };
  const workspaces = [
    { ref: 'workspace:1', id: WIN_A, title: 'app — resident' },
    { ref: 'workspace:2', id: WIN_B, title: `${DEMO_TITLE_PREFIX} · working` },
  ];
  const ignoreIds = new Set(workspaces.filter((w) => isDemoWorkspace(w)).map((w) => w.id));
  const r = reconcile(doc, { workspaces, sessionMap: {}, registry: [], ignoreIds });
  assert.deepEqual(r.changes.added.map((a) => a.workspaceId), [WIN_A]);
});
