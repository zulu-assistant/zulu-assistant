// node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectFailedRestore, isLiveClaude, isResumePicker, endsAtShellPrompt,
  parseWorkspaces, maybeHealFailedRestores, resetHealRestoreState, isPristineShell, pickRestorable, isLiveAgent,
} from '../src/heal-restore.mjs';

// ---- fixtures (trimmed from real `cmux read-screen` output) ----------------

const PROMPT = 'user@mac my-app %';
const SESSION = '14c8d9e4-1d11-41e6-bb6e-b0614d128cab';

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
  assert.equal(calls.length, 1);
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
