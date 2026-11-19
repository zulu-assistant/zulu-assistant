// node --test test/
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  detectFailedRestore, isLiveClaude, isResumePicker, endsAtShellPrompt,
  parseWorkspaces, maybeHealFailedRestores, resetHealRestoreState, isPristineShell, pickRestorable, isLiveAgent,
  parseCmuxRecords, pickFromRecord, RESIDENT_NOTICE_MS, bareResidentKey, lastSessionOf, sessionTimeIso,
  pickMissionControl, mcResumeLine, projectSlug,
} from '../src/heal-restore.mjs';
import { createLedger } from '../src/tasks.mjs';

// ---- fixtures (trimmed from real `cmux read-screen` output) ----------------

const PROMPT = 'user@mac my-app %';
const SESSION = '7f3a9c20-5b1e-4d2a-9e44-0c6d1b2a3f10';

const FAILED_SCROLLBACK = [
  PROMPT + ' cmux restore claude ' + SESSION,
  'Error: auth_required: Authentication required.',
  PROMPT,
].join('\n');

const FAILED_VIEWPORT = FAILED_SCROLLBACK;

const LIVE_CLAUDE = [
  '  ⎿  Compacted (ctrl+o to see full summary)',
  '────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent                    /rc',
].join('\n');

const PICKER = [
  '  Resume from summary (recommended)',
  '  Resume full session',
].join('\n');

const WS_LIST = [
  '  workspace:9 00000000-0000-4000-8000-000000000002  ✳ Set up secure remote login',
  '  workspace:2 00000000-0000-4000-8000-000000000003  ⌘ MISSION CONTROL',
  '* workspace:12 00000000-0000-4000-8000-000000000004  WEB DOCS  [selected]',
].join('\n');

// ---- detectors -------------------------------------------------------------

test('isLiveClaude recognises the claude UI and not a bare shell', () => {
  assert.equal(isLiveClaude(LIVE_CLAUDE), true);
  assert.equal(isLiveClaude(FAILED_VIEWPORT), false);
  assert.equal(isLiveClaude(''), false);
});

test('isLiveClaude recognises a session parked on a dialog (no mode footer)', () => {
  // real screens, 2026-08-05: a tool-approval prompt and a numbered option list
  const approval = ' This command requires approval\n\n Do you want to proceed?\n ❯ 1. Yes\n   3. No\n\n Esc to cancel · Tab to amend · ctrl+e to explain';
  const optionList = '  5. Type something.\n  6. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel';
  assert.equal(isLiveClaude(approval), true);
  assert.equal(isLiveClaude(optionList), true);
  assert.equal(detectFailedRestore(approval, FAILED_SCROLLBACK), null);
  assert.equal(detectFailedRestore(optionList, FAILED_SCROLLBACK), null);
});

test('isResumePicker needs both options on screen', () => {
  assert.equal(isResumePicker(PICKER), true);
  assert.equal(isResumePicker('Resume from summary (recommended)'), false);
  assert.equal(isResumePicker(LIVE_CLAUDE), false);
});

test('endsAtShellPrompt tolerates trailing blank lines, rejects typed commands', () => {
  assert.equal(endsAtShellPrompt(PROMPT + '\n\n\n'), true);
  assert.equal(endsAtShellPrompt('user@host ~ $'), true);
  assert.equal(endsAtShellPrompt(PROMPT + ' npm run build'), false);
  assert.equal(endsAtShellPrompt(''), false);
});

test('detectFailedRestore finds the session id on the exact signature', () => {
  assert.deepEqual(detectFailedRestore(FAILED_VIEWPORT, FAILED_SCROLLBACK), { sessionId: SESSION });
});

test('detectFailedRestore ignores a workspace with a live claude session', () => {
  assert.equal(detectFailedRestore(LIVE_CLAUDE, FAILED_SCROLLBACK + '\n' + LIVE_CLAUDE), null);
});

test('detectFailedRestore ignores a restore that succeeded (no auth error)', () => {
  const sb = PROMPT + ' cmux restore claude ' + SESSION + '\n' + PROMPT;
  assert.equal(detectFailedRestore(PROMPT, sb), null);
});

test('detectFailedRestore ignores a shell used after the failure', () => {
  const sb = FAILED_SCROLLBACK + '\n' + PROMPT + ' git status\nOn branch main\n' + PROMPT;
  assert.equal(detectFailedRestore(PROMPT, sb), null);
});

test('detectFailedRestore ignores a busy shell (no prompt at the end)', () => {
  assert.equal(detectFailedRestore(FAILED_SCROLLBACK + '\nbuilding...', FAILED_SCROLLBACK), null);
});

test('detectFailedRestore takes the most recent restore attempt', () => {
  const older = '00000000-0000-0000-0000-000000000000';
  const sb = [
    PROMPT + ' cmux restore claude ' + older,
    'Error: auth_required: Authentication required.',
    PROMPT + ' cmux restore claude ' + SESSION,
    'Error: auth_required: Authentication required.',
    PROMPT,
  ].join('\n');
  assert.deepEqual(detectFailedRestore(PROMPT, sb), { sessionId: SESSION });
});

test('parseWorkspaces reads refs, ids and names, stripping status glyphs', () => {
  assert.deepEqual(parseWorkspaces(WS_LIST), [
    { ref: 'workspace:9', id: '00000000-0000-4000-8000-000000000002', name: 'Set up secure remote login' },
    { ref: 'workspace:2', id: '00000000-0000-4000-8000-000000000003', name: '⌘ MISSION CONTROL' },
    { ref: 'workspace:12', id: '00000000-0000-4000-8000-000000000004', name: 'WEB DOCS' },
  ]);
});

// ---- the pass (fake cmux) --------------------------------------------------

// screens: { ref: [viewport-after-0-restores, viewport-after-1, ...] }
function fakeCmux(screens) {
  const calls = [];
  const restores = new Map();
  const cmux = async (args) => {
    calls.push(args.join(' '));
    const ref = args[args.indexOf('--workspace') + 1];
    if (args[0] === 'workspace') return { err: null, out: WS_LIST };
    if (args[0] === 'read-screen') {
      const seq = screens[ref];
      if (!seq) return { err: 'no such workspace', out: '' };
      const step = Math.min(restores.get(ref) || 0, seq.length - 1);
      const s = seq[step];
      return typeof s === 'object' ? s : { err: null, out: s };
    }
    if (args[0] === 'send-key' || (args[0] === 'send' && args.includes('restore'))) {
      restores.set(ref, (restores.get(ref) || 0) + (args[0] === 'send-key' ? 1 : 0));
    }
    return { err: null, out: '' };
  };
  return { cmux, calls };
}

// a throwaway password file: the tests never depend on the repo's gitignored data/
const PW_DIR = mkdtempSync(path.join(os.tmpdir(), 'mc-heal-'));
const PW_FILE = path.join(PW_DIR, 'cmux-socket-password');
writeFileSync(PW_FILE, 'test-password\n');
const opts = (cmux, log, clock) => ({
  cmux, log, sleep: async () => {}, now: () => clock.t, pwFile: PW_FILE,
});

test('a failed restore is re-sent, the picker answered, and the repair logged', async () => {
  resetHealRestoreState();
  const clock = { t: 1_000_000 };
  const logged = [];
  // ws:9 fails → after 1 enter shows the picker → after 2 enters is live claude
  const { cmux, calls } = fakeCmux({
    'workspace:9': [FAILED_VIEWPORT, PICKER, LIVE_CLAUDE],
    'workspace:2': [LIVE_CLAUDE],
    'workspace:12': [LIVE_CLAUDE],
  });
  const r = await maybeHealFailedRestores(opts(cmux, (t) => logged.push(t), clock));

  assert.equal(r.repaired.length, 1);
  assert.equal(r.repaired[0].ref, 'workspace:9');
  assert.equal(r.repaired[0].sessionId, SESSION);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /restore-retry: re-resumed/);
  // the restore was sent with the password supplied, and enter pressed twice
  const send = calls.find((c) => c.startsWith('send --workspace workspace:9'));
  assert.match(send, /CMUX_SOCKET_PASSWORD=\$\(cat .*cmux-socket-password"\)/);
  assert.match(send, new RegExp(`restore claude ${SESSION}$`));
  assert.equal(calls.filter((c) => c.startsWith('send-key --workspace workspace:9')).length, 2);
  // healthy workspaces were never written to
  assert.equal(calls.some((c) => c.startsWith('send') && c.includes('workspace:2')), false);
});

test('no enter is sent blind when there is no picker', async () => {
  resetHealRestoreState();
  const clock = { t: 2_000_000 };
  const { cmux, calls } = fakeCmux({
    'workspace:9': [FAILED_VIEWPORT, LIVE_CLAUDE],
    'workspace:2': [LIVE_CLAUDE],
    'workspace:12': [LIVE_CLAUDE],
  });
  const r = await maybeHealFailedRestores(opts(cmux, async () => {}, clock));
  assert.equal(r.repaired.length, 1);
  assert.equal(calls.filter((c) => c.startsWith('send-key --workspace workspace:9')).length, 1);
});

test('a workspace whose read-screen errors is skipped, not repaired', async () => {
  resetHealRestoreState();
  const clock = { t: 3_000_000 };
  const { cmux, calls } = fakeCmux({
    'workspace:9': [{ err: 'surface not ready', out: '' }],
    'workspace:2': [LIVE_CLAUDE],
    'workspace:12': [LIVE_CLAUDE],
  });
  const r = await maybeHealFailedRestores(opts(cmux, async () => {}, clock));
  assert.equal(r.repaired.length, 0);
  assert.equal(calls.some((c) => c.startsWith('send ')), false);
});

test('the socket being unhealthy short-circuits the whole pass', async () => {
  resetHealRestoreState();
  const clock = { t: 4_000_000 };
  const calls = [];
  const cmux = async (args) => {
    calls.push(args.join(' '));
    return args[0] === 'workspace' ? { err: 'ERROR: Invalid password', out: '' } : { err: null, out: '' };
  };
  const r = await maybeHealFailedRestores(opts(cmux, async () => {}, clock));
  assert.equal(r.skipped, 'socket-unhealthy');
  assert.ok(calls.every((c) => /^(list-windows|workspace list)/.test(c)), 'nothing but the listing was called');
});

test('passes are throttled and workspaces have a 10-minute cooldown', async () => {
  resetHealRestoreState();
  const clock = { t: 5_000_000 };
  const screens = {
    'workspace:9': [FAILED_VIEWPORT],   // never recovers — the retry loop bait
    'workspace:2': [LIVE_CLAUDE],
    'workspace:12': [LIVE_CLAUDE],
  };

  const a = fakeCmux(screens);
  await maybeHealFailedRestores(opts(a.cmux, async () => {}, clock));
  assert.equal(a.calls.filter((c) => c.startsWith('send ')).length, 1);

  // same minute: the pass itself is throttled
  clock.t += 30_000;
  const b = fakeCmux(screens);
  const rb = await maybeHealFailedRestores(opts(b.cmux, async () => {}, clock));
  assert.equal(rb.skipped, 'throttled');
  assert.equal(b.calls.length, 0);

  // pass throttle expired, workspace cooldown has not
  clock.t += 90_000;
  const c = fakeCmux(screens);
  await maybeHealFailedRestores(opts(c.cmux, async () => {}, clock));
  assert.equal(c.calls.filter((x) => x.startsWith('send ')).length, 0);

  // past the 10-minute cooldown it may try once more
  clock.t += 10 * 60_000;
  const d = fakeCmux(screens);
  await maybeHealFailedRestores(opts(d.cmux, async () => {}, clock));
  assert.equal(d.calls.filter((x) => x.startsWith('send ')).length, 1);
});

// ---- fresh shells after a relaunch with no auto-resume (task #118) ---------

// real shape, 2026-10-06 after the cmux 0.65.0 update relaunch (all 25 panes had the mail line)
const FRESH = ['Last login: Tue Oct  6 04:35:35 on ttys012', 'You have mail.', PROMPT].join('\n');
const USED = ['Last login: Tue Oct  6 04:35:35 on ttys012', PROMPT + ' ls', 'README.md', PROMPT].join('\n');
const WS9 = '00000000-0000-4000-8000-000000000002';
const WS2 = '00000000-0000-4000-8000-000000000003';
const WS12 = '00000000-0000-4000-8000-000000000004';
const CODEX_SID = '01a0d065-0000-7000-8000-000000000001';
const QWEN_SID = '01a10698-0000-7000-8000-000000000002';
const claudeMap = {
  activeSessionsByWorkspace: { [WS9.toUpperCase()]: { sessionId: SESSION, updatedAt: 100 } },
  sessions: { [SESSION]: { sessionId: SESSION, isRestorable: true, pid: 4242, launchCommand: { arguments: ['claude', '--name', 'x'] } } },
};
const codexMap = { sessions: {
  a: { sessionId: CODEX_SID, workspaceId: WS2.toUpperCase(), updatedAt: 200, pid: 4343, launchCommand: { arguments: ['codex', '-a', 'on-request'] } },
  b: { sessionId: QWEN_SID, workspaceId: WS12.toUpperCase(), updatedAt: 300, pid: 4444, launchCommand: { arguments: ['codex', '--profile', 'qwen'] } },
} };

test('isPristineShell: banner + prompts only; a used shell, a live UI or a running command is not', () => {
  assert.equal(isPristineShell(FRESH, FRESH), true, 'banner + "You have mail." + prompt (the real shape)');
  assert.equal(isPristineShell(FRESH, '\n' + FRESH + '\n' + PROMPT + '\n'), true, 'leading blanks, extra untouched prompts');
  assert.equal(isPristineShell(PROMPT, PROMPT), false, 'no banner: the window may start mid-output of an old command');
  assert.equal(isPristineShell(PROMPT, ['build finished', PROMPT].join('\n')), false, 'tail of an old command');
  assert.equal(isPristineShell(FRESH, [FRESH, 'You have mail.', PROMPT].join('\n')), false, 'noise AFTER the first prompt');
  assert.equal(isPristineShell(USED, USED), false, 'something was typed');
  assert.equal(isPristineShell(FAILED_VIEWPORT, FAILED_SCROLLBACK), false, 'the auth_required shape belongs to the first detector');
  assert.equal(isPristineShell(LIVE_CLAUDE, FRESH), false);
  assert.equal(isPristineShell('Last login: Tue Oct  6 04:35:35 on ttys012', 'Last login: Tue Oct  6 04:35:35 on ttys012'), false, 'no prompt yet');
});

test('pickRestorable: newest session across both maps; custom-profile Codex is skipped', () => {
  assert.deepEqual(pickRestorable(WS9, claudeMap, codexMap), { kind: 'claude', sessionId: SESSION, pid: 4242 });
  assert.deepEqual(pickRestorable(WS2, claudeMap, codexMap), { kind: 'codex', sessionId: CODEX_SID, pid: 4343 });
  assert.match(pickRestorable(WS12, claudeMap, codexMap).skip, /--profile qwen/);
  assert.equal(pickRestorable('00000000-0000-4000-8000-00000000dead', claudeMap, codexMap), null);
  const notRestorable = structuredClone(claudeMap);
  notRestorable.sessions[SESSION].isRestorable = false;
  assert.match(pickRestorable(WS9, notRestorable, {}).skip, /not restorable/);
  // a newer codex session in the same workspace wins over the claude one
  const both = { sessions: { c: { ...codexMap.sessions.a, workspaceId: WS9.toUpperCase(), updatedAt: 999 } } };
  assert.equal(pickRestorable(WS9, claudeMap, both).kind, 'codex');
});

const freshOpts = (cmux, log, clock, extra = {}) => ({
  ...opts(cmux, log, clock),
  sessionMaps: async () => ({ claude: claudeMap, codex: codexMap }),
  appStart: async () => clock.t - 10 * 60_000,   // cmux relaunched 10 minutes ago
  isAlive: () => false,
  ...extra,
});

test('fresh shells after a relaunch: Claude and Codex restored, custom profile left alone', async () => {
  resetHealRestoreState();
  const clock = { t: 5_000_000 };
  const logged = [];
  const { cmux, calls } = fakeCmux({
    'workspace:9': [FRESH, LIVE_CLAUDE],
    'workspace:2': [FRESH, LIVE_CLAUDE],
    'workspace:12': [FRESH],
  });
  const r = await maybeHealFailedRestores(freshOpts(cmux, (t) => logged.push(t), clock));
  assert.deepEqual(r.repaired.map((x) => [x.ref, x.kind]), [['workspace:9', 'claude'], ['workspace:2', 'codex']]);
  assert.match(calls.find((c) => c.startsWith('send --workspace workspace:9')), new RegExp(`restore claude ${SESSION}$`));
  assert.match(calls.find((c) => c.startsWith('send --workspace workspace:2')), new RegExp(`restore codex ${CODEX_SID}$`));
  assert.equal(calls.some((c) => c.startsWith('send') && c.includes('workspace:12')), false, 'qwen (--profile) is never typed into');
  assert.equal(logged.length, 2);
  assert.match(logged[0], /fresh shell after a cmux relaunch/);
});

test('fresh shells are left alone when cmux launched long ago, the session is alive, or the shell was used', async () => {
  for (const [why, extra, screens] of [
    ['old launch', { appStart: async () => 1 }, null],
    ['launch too recent (cmux may still be resuming)', { appStart: async () => 50_000_000 - 30_000 }, null],
    ['unknown launch', { appStart: async () => 0 }, null],
    ['session alive', { isAlive: () => true }, null],
    ['used shell', {}, { 'workspace:9': [USED], 'workspace:2': [USED], 'workspace:12': [USED] }],
  ]) {
    resetHealRestoreState();
    const clock = { t: 50_000_000 };
    const { cmux, calls } = fakeCmux(screens || { 'workspace:9': [FRESH], 'workspace:2': [FRESH], 'workspace:12': [FRESH] });
    const r = await maybeHealFailedRestores(freshOpts(cmux, () => {}, clock, extra));
    assert.equal(r.repaired.length, 0, why);
    assert.equal(calls.some((c) => c.startsWith('send')), false, `${why}: nothing typed`);
  }
});

test('dry run reports fresh-shell restores with kind and reason, types nothing', async () => {
  resetHealRestoreState();
  const clock = { t: 5_000_000 };
  const { cmux, calls } = fakeCmux({ 'workspace:9': [FRESH], 'workspace:2': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE] });
  const r = await maybeHealFailedRestores(freshOpts(cmux, () => {}, clock, { dryRun: true }));
  assert.equal(r.attempted.length, 1);
  assert.equal(r.attempted[0].kind, 'claude');
  assert.match(r.attempted[0].why, /fresh shell/);
  assert.equal(calls.some((c) => c.startsWith('send')), false);
});

test('isLiveAgent confirms Codex restores by name, not by accident', () => {
  const codex = ['› Ask Codex to do anything', '  gpt-5 high · ~/app', '  ← for agents · ? for shortcuts'].join('\n');
  assert.equal(isLiveAgent(codex), true);
  assert.equal(isLiveAgent('  Working (3s • esc to interrupt)'), true);
  assert.equal(isLiveAgent(LIVE_CLAUDE), true);
  assert.equal(isLiveAgent(FRESH), false);
});

// ---- #620: cmux's own record, a line for every pass-over, residents left bare -------------------

const REC_SID = 'cccccccc-1111-4222-8333-944455556666';
// a trimmed cmux session file: workspace 9 has a resume binding; the hook maps know nothing of it
const cmuxFile = (over = {}) => ({ windows: [{ tabManager: { workspaces: [
  { workspaceId: WS9, panels: [{ terminal: { resumeBinding: { kind: 'claude', checkpointId: REC_SID, launchCommand: { arguments: ['/x/claude', '--name', 'shipping'] }, updatedAt: 10, ...over } } }] },
  { workspaceId: WS2, panels: [{ terminal: {} }] },
] } }] });

test('parseCmuxRecords / pickFromRecord: the binding by workspace, with the hook maps\' checks', () => {
  const rec = parseCmuxRecords(cmuxFile());
  assert.deepEqual(Object.keys(rec), [WS9.toUpperCase()]);
  assert.deepEqual(pickFromRecord(WS9, rec), { kind: 'claude', sessionId: REC_SID, pid: null, source: 'cmux record' });
  assert.equal(pickFromRecord(WS2, rec), null);
  assert.match(pickFromRecord(WS9, parseCmuxRecords(cmuxFile({ checkpointId: 'nope' }))).skip, /malformed/);
  assert.match(pickFromRecord(WS9, parseCmuxRecords(cmuxFile({ kind: 'codex', launchCommand: { arguments: ['codex', '--profile', 'qwen'] } }))).skip, /--profile qwen/);
  assert.match(pickFromRecord(WS9, parseCmuxRecords(cmuxFile({ launchCommand: undefined }))).skip, /no launch command/);
  assert.match(pickFromRecord(WS9, parseCmuxRecords(cmuxFile({ kind: 'shell' }))).skip, /kind shell/);
  assert.deepEqual(parseCmuxRecords({}), {}); assert.deepEqual(parseCmuxRecords(null), {});
});

const recordOpts = (cmux, log, clock, extra = {}) => freshOpts(cmux, log, clock, {
  sessionMaps: async () => ({ claude: {}, codex: {}, records: parseCmuxRecords(cmuxFile()) }),
  runningIds: async () => new Set(),
  ...extra,
});

test('no hook-map entry: the session is resumed from cmux\'s record (not running anywhere, entry not closed)', async () => {
  resetHealRestoreState();
  const clock = { t: 5_000_000 };
  const logged = [];
  const { cmux, calls } = fakeCmux({ 'workspace:9': [FRESH, LIVE_CLAUDE], 'workspace:2': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE] });
  const r = await maybeHealFailedRestores(recordOpts(cmux, (t) => logged.push(t), clock));
  assert.deepEqual(r.repaired.map((x) => [x.ref, x.kind, x.sessionId]), [['workspace:9', 'claude', REC_SID]]);
  assert.match(calls.find((c) => c.startsWith('send --workspace workspace:9')), new RegExp(`restore claude ${REC_SID}$`));
  assert.match(logged[0], /cmux's own record/);
  for (const [why, extra] of [
    ['running in another process', { runningIds: async () => new Set([REC_SID]) }],
    ['running sessions unread', { runningIds: async () => null }],
    ['closed directory entry', { directory: async () => [{ workspaceId: WS9, name: 'shipping', kind: 'resident', status: 'closed' }] }],
  ]) {
    resetHealRestoreState();
    const c2 = fakeCmux({ 'workspace:9': [FRESH], 'workspace:2': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE] });
    const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
    try {
      const r2 = await maybeHealFailedRestores(recordOpts(c2.cmux, () => {}, { t: 5_000_000 }, extra));
      assert.equal(r2.repaired.length, 0, why);
    } finally { console.log = orig; }
    assert.equal(c2.calls.some((c) => c.startsWith('send')), false, `${why}: nothing typed`);
    assert.ok(lines.some((l) => /fresh shell, not restored/.test(l)), `${why}: one line says so`);
  }
});

test('a fresh shell with no session record anywhere is passed over with one line, once', async () => {
  resetHealRestoreState();
  const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    for (let i = 0; i < 2; i++) {
      const { cmux } = fakeCmux({ 'workspace:9': [FRESH], 'workspace:2': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE] });
      await maybeHealFailedRestores(freshOpts(cmux, () => {}, { t: 5_000_000 + i * 120_000 }, { sessionMaps: async () => ({ claude: {}, codex: {}, records: {} }), runningIds: async () => new Set() }));
    }
  } finally { console.log = orig; }
  assert.deepEqual(lines.filter((l) => /fresh shell/.test(l)), ['[heal-restore] Set up secure remote login: fresh shell, not restored (no session record)']);
});

// #678: one keyed task per episode (workspace + cmux launch), filed through a real ledger; a board restart (a new
// process: resetHealRestoreState) files nothing new; one ticker line a day naming the task; never restored
test('a registered resident still a bare shell after the window: one keyed task per episode, across board restarts', async () => {
  const ledger = createLedger(await mkdtemp(path.join(os.tmpdir(), 'bare-resident-')));
  const START = 50_000_000 - 3 * 3600_000;                         // the cmux launch: past the 2 h window
  const clock = { t: 50_000_000 };
  const logged = []; const filed = [];
  const dir = [{ workspaceId: WS9, name: 'shipping', kind: 'resident', status: 'active' }, { workspaceId: WS2, name: 'w', kind: 'worker', status: 'active' }];
  // the board's side, as in server.mjs: one create per call, the ledger dedupes the key
  const fileBareResident = async (f) => { filed.push(f); return ledger.create({ title: `Resident ${f.name} bare`, requester: 'board', owner: 'coordinator', priority: 'low', source: { via: 'heal-restore', key: f.key }, body: 'x' }); };
  const run = (start = START) => {
    const { cmux, calls } = fakeCmux({ 'workspace:9': [FRESH], 'workspace:2': [FRESH], 'workspace:12': [LIVE_CLAUDE] });
    return maybeHealFailedRestores(recordOpts(cmux, (t) => logged.push(t), clock, { appStart: async () => start, directory: async () => dir, fileBareResident }))
      .then((r) => ({ r, calls }));
  };
  resetHealRestoreState();
  const a = await run();
  assert.equal(a.r.repaired.length, 0); assert.equal(a.calls.some((c) => c.startsWith('send')), false);
  assert.equal(filed.length, 1, 'the worker is not a resident: one task, for shipping');
  assert.equal(filed[0].key, bareResidentKey(WS9, START)); assert.equal(filed[0].name, 'shipping'); assert.equal(filed[0].hours, 3);
  assert.equal(filed[0].lastSession.sessionId, REC_SID); assert.equal(filed[0].lastSession.source, 'cmux record');
  assert.match(filed[0].restore, new RegExp(`restore claude ${REC_SID}$`));
  assert.equal((await ledger.list({})).length, 1);
  assert.equal(logged.length, 1); assert.match(logged[0], /resident shipping is still a bare shell 3 h after the cmux relaunch: not restored on its own; .* \(#1\)$/);
  clock.t += 120_000; await run();                                // the same process, the next pass: nothing new
  assert.equal(filed.length, 1); assert.equal(logged.length, 1);
  // two board restarts in the same day: the ledger already holds the key, so still one task (the ticker line is per process)
  for (let i = 0; i < 2; i++) { resetHealRestoreState(); clock.t += 50 * 60_000; await run(); }
  assert.equal((await ledger.list({})).length, 1, 'restarts file nothing new');
  // a task closed for the episode keeps it quiet: the key is still taken
  await ledger.update(1, { op: 'cancel', actor: 'coordinator', text: 'folded' });
  resetHealRestoreState(); clock.t += RESIDENT_NOTICE_MS; await run();
  assert.equal((await ledger.list({})).length, 1);
  // the next cmux relaunch is a new episode: a new task
  resetHealRestoreState(); await run(clock.t - 3 * 3600_000);
  assert.equal((await ledger.list({})).length, 2);
  assert.notEqual((await ledger.get(2)).source.key, (await ledger.get(1)).source.key);
});

test('lastSessionOf: the newest session written for a workspace, from the hook maps or cmux\'s record', () => {
  const maps = { claude: { activeSessionsByWorkspace: { [WS9.toUpperCase()]: { sessionId: 's1', updatedAt: 5 } }, sessions: { s1: { sessionId: 's1' } } },
    codex: { sessions: { x: { workspaceId: WS9, sessionId: 's2', updatedAt: 7 } } }, records: { [WS9.toUpperCase()]: [{ kind: 'claude', sessionId: 's3', at: 6 }] } };
  assert.deepEqual(lastSessionOf(WS9, maps), { kind: 'codex', sessionId: 's2', at: 7, source: 'hook map' });
  assert.equal(lastSessionOf(WS2, maps), null);
  assert.equal(lastSessionOf('', maps), null);
});

// #682: both files keep Unix SECONDS with a fraction (values as read on this machine 11-16); the task said 1970
test('the last session time reads as its date, from the hook maps and from cmux\'s record (seconds with a fraction)', async () => {
  const CLAUDE_AT = 1794817180.989686; const RECORD_AT = 1794693479.0959911;
  assert.equal(sessionTimeIso(CLAUDE_AT), '2026-11-16T08:19:40.989Z');
  assert.equal(sessionTimeIso(RECORD_AT), '2026-11-14T21:57:59.095Z');
  assert.equal(sessionTimeIso(0), null); assert.equal(sessionTimeIso(undefined), null);
  // through a pass: the record only (a session that dropped out of the hook maps), then a newer hook-map entry wins
  const START = 50_000_000 - 3 * 3600_000;
  const dir = [{ workspaceId: WS9, name: 'shipping', kind: 'resident', status: 'active' }];
  const record = { windows: [{ tabManager: { workspaces: [{ workspaceId: WS9, panels: [{ terminal: { resumeBinding: { kind: 'claude', checkpointId: REC_SID, launchCommand: { arguments: ['/x/claude'] }, updatedAt: RECORD_AT } } }] }] } }] };
  for (const [maps, at, source] of [
    [{ claude: {}, codex: {}, records: parseCmuxRecords(record) }, '2026-11-14T21:57:59.095Z', 'cmux record'],
    [{ claude: { activeSessionsByWorkspace: { [WS9.toUpperCase()]: { sessionId: SESSION, updatedAt: CLAUDE_AT } }, sessions: { [SESSION]: { sessionId: SESSION, launchCommand: { arguments: [] } } } }, codex: {}, records: parseCmuxRecords(record) }, '2026-11-16T08:19:40.989Z', 'hook map'],
  ]) {
    resetHealRestoreState();
    const filed = [];
    const { cmux } = fakeCmux({ 'workspace:9': [FRESH], 'workspace:2': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE] });
    await maybeHealFailedRestores(freshOpts(cmux, () => {}, { t: 50_000_000 }, { sessionMaps: async () => maps, runningIds: async () => new Set(), appStart: async () => START, directory: async () => dir, fileBareResident: async (f) => { filed.push(f); return { id: 1 }; } }));
    assert.equal(filed.length, 1, source); assert.equal(filed[0].lastSession.at, at, source); assert.equal(filed[0].lastSession.source, source);
  }
});

// ---- #704: Mission Control comes back through its own launcher, never `cmux restore` ----------------

const MC_SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const NEWER_SID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const MC_ROOT = "/srv/the board's checkout";
const MC_DIR = [{ workspaceId: WS2, name: 'mission-control', kind: 'mission-control', status: 'active' }];
const TRUST = ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit', 'Enter to confirm · Esc to cancel'].join('\n');
// workspace:2 is Mission Control; the hook map also names a session for it (which `cmux restore` would have used)
const mcMaps = (sid = SESSION, pid = 4545) => ({ claude: {
  activeSessionsByWorkspace: { [WS9.toUpperCase()]: { sessionId: SESSION, updatedAt: 100 }, [WS2.toUpperCase()]: { sessionId: sid, updatedAt: 200 } },
  sessions: { [SESSION]: { sessionId: SESSION, isRestorable: true, pid: 4242, launchCommand: { arguments: ['claude'] } },
    [sid]: { sessionId: sid, isRestorable: true, pid, launchCommand: { arguments: ['/x/claude'] } } },
}, codex: {}, records: {} });
const mcOpts = (cmux, log, clock, extra = {}) => freshOpts(cmux, log, clock, {
  directory: async () => MC_DIR, sessionMaps: async () => mcMaps(), runningIds: async () => new Set(),
  mcSessionId: async () => MC_SID, transcriptAt: async (id) => ({ [MC_SID]: 1000 })[id] ?? null, repoRoot: MC_ROOT, ...extra,
});
const quiet = async (fn) => { const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' ')); try { return { r: await fn(), lines }; } finally { console.log = orig; } };

test('pickMissionControl / mcResumeLine: a strict UUID only, the hook map\'s session only when its transcript is here and newer', () => {
  assert.deepEqual(pickMissionControl(MC_SID, null, { [MC_SID]: 1 }), { sessionId: MC_SID, from: 'data/mission-control-session-id', other: null });
  const mapped = { kind: 'claude', sessionId: NEWER_SID, source: 'hook map' };
  assert.equal(pickMissionControl(MC_SID, mapped, { [MC_SID]: 1, [NEWER_SID]: 2 }).sessionId, NEWER_SID, 'newer transcript in the folder');
  assert.equal(pickMissionControl(MC_SID, mapped, { [MC_SID]: 2, [NEWER_SID]: 1 }).sessionId, MC_SID, 'older');
  assert.equal(pickMissionControl(MC_SID, mapped, { [MC_SID]: 1, [NEWER_SID]: null }).sessionId, MC_SID, 'not in this project folder');
  assert.equal(pickMissionControl(MC_SID, { ...mapped, kind: 'codex' }, { [MC_SID]: 1, [NEWER_SID]: 2 }).sessionId, MC_SID, 'codex');
  assert.equal(pickMissionControl(MC_SID, { ...mapped, source: 'cmux record' }, { [MC_SID]: 1, [NEWER_SID]: 2 }).sessionId, MC_SID, 'cmux record');
  assert.equal(pickMissionControl('', mapped, { [NEWER_SID]: 2 }).sessionId, NEWER_SID, 'no file: the hook map\'s, when its transcript is here');
  assert.match(pickMissionControl('', null, {}).skip, /no id/);
  assert.match(pickMissionControl(`${MC_SID}; rm -rf ~`, null, {}).skip, /not a UUID/);
  assert.match(pickMissionControl(MC_SID.slice(0, 35), null, {}).skip, /not a UUID/);
  assert.match(pickMissionControl(MC_SID, null, {}).skip, /no transcript/);
  assert.equal(mcResumeLine(MC_ROOT, MC_SID), `cd '/srv/the board'\\''s checkout' && scripts/mc-resume.sh ${MC_SID}`);
  assert.throws(() => mcResumeLine(MC_ROOT, `${MC_SID} && x`));
  assert.equal(projectSlug('/Users/me/Zulu Board/'), '-Users-me-Zulu-Board');
});

test('Mission Control\'s fresh pane gets its launcher with the recorded id, never `cmux restore`; residents unchanged', async () => {
  resetHealRestoreState();
  const clock = { t: 5_000_000 };
  const logged = []; const notes = [];
  const { cmux, calls } = fakeCmux({ 'workspace:9': [FRESH, LIVE_CLAUDE], 'workspace:2': [FRESH, PICKER, LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE] });
  const { r } = await quiet(() => maybeHealFailedRestores(mcOpts(cmux, (t) => logged.push(t), clock, { notify: async (...a) => notes.push(a) })));
  assert.deepEqual(r.repaired.map((x) => [x.ref, x.kind]), [['workspace:9', 'claude'], ['workspace:2', 'mission-control']]);
  const sends = calls.filter((c) => c.startsWith('send --workspace workspace:2 '));
  assert.deepEqual(sends, [`send --workspace workspace:2 -- cd '/srv/the board'\\''s checkout' && scripts/mc-resume.sh ${MC_SID}`]);
  assert.equal(calls.filter((c) => c === 'send-key --workspace workspace:2 enter').length, 2, 'enter, then the picker that was on screen');
  assert.match(calls.find((c) => c.startsWith('send --workspace workspace:9 ')), new RegExp(`restore claude ${SESSION}$`), 'a resident still comes back by cmux restore');
  assert.equal(calls.some((c) => c.includes('workspace:2') && /restore (claude|codex)/.test(c)), false);
  assert.ok(logged.some((l) => /re-resumed Mission Control .*mc-resume\.sh/.test(l)));
  assert.equal(notes.length, 1, 'one summary of the pass, no failure notice');
});

test('Mission Control not resumed: one ticker line and one owner notice, nothing typed (or, after the send, nothing answered)', async () => {
  for (const [why, extra, screens, re, typed] of [
    ['no id recorded', { mcSessionId: async () => '' }, null, /no id in data\/mission-control-session-id/, false],
    ['an id that is not a UUID', { mcSessionId: async () => `${MC_SID}; rm -rf ~` }, null, /not a UUID/, false],
    ['no transcript in the project folder', { transcriptAt: async () => null }, null, /no transcript/, false],
    ['running elsewhere', { runningIds: async () => new Set([MC_SID]) }, null, /running elsewhere/, false],
    ['running sessions unread', { runningIds: async () => null }, null, /could not be read/, false],
    ['its pid alive', { sessionMaps: async () => mcMaps(MC_SID, 777), isAlive: (p) => p === 777 }, null, /is running/, false],
    ['a used shell', {}, { 'workspace:2': [USED] }, /not a fresh shell/, false],
    ['the failed-restore shape', {}, { 'workspace:2': [FAILED_VIEWPORT] }, /not a fresh shell/, false],
    ['a trust dialog after the send', {}, { 'workspace:2': [FRESH, TRUST] }, /trust dialog/, true],
    ['no agent UI after the send', {}, { 'workspace:2': [FRESH, FRESH] }, /not confirmed/, true],
  ]) {
    resetHealRestoreState();
    const logged = []; const notes = [];
    const { cmux, calls } = fakeCmux({ 'workspace:9': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE], ...(screens || { 'workspace:2': [FRESH] }) });
    const { r } = await quiet(() => maybeHealFailedRestores(mcOpts(cmux, (t) => logged.push(t), { t: 5_000_000 }, { notify: async (...a) => notes.push(a), ...extra })));
    assert.equal(r.repaired.length, 0, why);
    assert.equal(calls.filter((c) => c.startsWith('send --workspace workspace:2')).length, typed ? 1 : 0, `${why}: typed`);
    assert.equal(calls.filter((c) => c === 'send-key --workspace workspace:2 enter').length, typed ? 1 : 0, `${why}: no answer to anything on screen`);
    assert.equal(logged.length, 1, why); assert.match(logged[0], re, why); assert.match(logged[0], /run scripts\/mc-resume\.sh in its pane/);
    assert.equal(notes.length, 1, `${why}: one owner notice`); assert.equal(notes[0][2], logged[0]);
  }
});

test('Mission Control: one try per cmux launch; a closed entry, a launch outside the window and a dry run type nothing', async () => {
  resetHealRestoreState();
  const logged = [];
  const screens = { 'workspace:9': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE], 'workspace:2': [FRESH, FRESH] };
  const start = 5_000_000 - 10 * 60_000;
  let c = fakeCmux(screens);
  await quiet(() => maybeHealFailedRestores(mcOpts(c.cmux, (t) => logged.push(t), { t: 5_000_000 }, { appStart: async () => start })));
  c = fakeCmux(screens);
  await quiet(() => maybeHealFailedRestores(mcOpts(c.cmux, (t) => logged.push(t), { t: 5_000_000 + 20 * 60_000 }, { appStart: async () => start })));
  assert.equal(c.calls.some((x) => x.startsWith('send')), false, 'the same launch: no second try');
  assert.equal(logged.length, 1);
  c = fakeCmux(screens);   // cmux launched again: a new try
  await quiet(() => maybeHealFailedRestores(mcOpts(c.cmux, (t) => logged.push(t), { t: 5_000_000 + 40 * 60_000 }, { appStart: async () => 5_000_000 + 30 * 60_000 })));
  assert.equal(c.calls.filter((x) => x.startsWith('send --workspace workspace:2')).length, 1);

  for (const [why, extra] of [
    ['closed entry', { directory: async () => [{ ...MC_DIR[0], status: 'closed' }] }],
    ['launch long ago', { appStart: async () => 5_000_000 - 3 * 3600_000 }],
    ['launch too recent', { appStart: async () => 5_000_000 - 30_000 }],
  ]) {
    resetHealRestoreState();
    const lines = []; const d = fakeCmux({ 'workspace:9': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE], 'workspace:2': [FRESH] });
    await quiet(() => maybeHealFailedRestores(mcOpts(d.cmux, (t) => lines.push(t), { t: 5_000_000 }, extra)));
    assert.equal(d.calls.some((x) => x.startsWith('send')), false, why);
    assert.equal(lines.length, 0, `${why}: no line`);
  }
  resetHealRestoreState();
  const d = fakeCmux({ 'workspace:9': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE], 'workspace:2': [FRESH] });
  const { r } = await quiet(() => maybeHealFailedRestores(mcOpts(d.cmux, () => {}, { t: 5_000_000 }, { dryRun: true })));
  assert.deepEqual(r.attempted.map((a) => [a.ref, a.kind, a.sessionId]), [['workspace:2', 'mission-control', MC_SID]]);
  assert.equal(d.calls.some((x) => x.startsWith('send')), false);
});

test('Mission Control: the hook map\'s newer session (transcript in this project folder) wins, and both ids are logged', async () => {
  resetHealRestoreState();
  const { cmux, calls } = fakeCmux({ 'workspace:9': [LIVE_CLAUDE], 'workspace:12': [LIVE_CLAUDE], 'workspace:2': [FRESH, LIVE_CLAUDE] });
  const { lines } = await quiet(() => maybeHealFailedRestores(mcOpts(cmux, () => {}, { t: 5_000_000 }, {
    sessionMaps: async () => mcMaps(NEWER_SID), transcriptAt: async (id) => ({ [MC_SID]: 1000, [NEWER_SID]: 2000 })[id] ?? null })));
  assert.match(calls.find((c) => c.startsWith('send --workspace workspace:2')), new RegExp(`mc-resume\\.sh ${NEWER_SID}$`));
  assert.ok(lines.some((l) => l.includes(NEWER_SID) && l.includes(MC_SID)), 'both ids in one line');
});
