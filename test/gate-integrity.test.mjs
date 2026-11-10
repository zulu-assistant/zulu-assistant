// Gate integrity (src/gate-integrity.mjs, Zulu 1.3 slice 10): are the gate's own files, as they
// run in the live checkout, what has landed on the default branch? Pure rules first, then real
// temporary repositories: an origin, and a clone of it standing in for the live checkout. The
// "what the remote says" reader and the clock are injected; nothing here touches a real remote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blobId, algoOf, integritySettings, noteHead, newestHead, fileState, judge, MAX_HEADS, createGateIntegrity,
  CLAUDE_MATCHER, isHookCommand, matcherCovers, hookEntries, registrationProblems, disablesHooks, configChangeVerdict, portProblem,
  HOOK_ENV, hookEnvSet, settingsProblem, sessionVerdict, isBareHookCommand,
  gatePaths, remoteTarget, readRemoteRef, integrityCard, OWN_FILES, CONFIG_HOOK,
} from '../src/gate-integrity.mjs';
import { settingsFileFor, sessionFolders, judgeChange, blockOutput, boardUrl } from '../scripts/gate-config-hook.mjs';
import { DEFAULT_POLICY, triggerLines } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { writeFile as writeFileP } from 'node:fs/promises';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha = (n) => String(n).repeat(40).slice(0, 40);
const T0 = Date.parse('2026-01-05T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// ── pure ────────────────────────────────────────────────────────────────────
test('blob ids are git\'s own; settings: absent = off, only "on" switches it on', () => {
  for (const text of ['', 'hello\n', '// a file\nconst x = 1;\n']) {
    const want = execFileSync('git', ['hash-object', '--stdin'], { input: text, encoding: 'utf8' }).trim();
    assert.equal(blobId(Buffer.from(text)), want);
  }
  assert.equal(algoOf(sha('a')), 'sha1'); assert.equal(algoOf('a'.repeat(64)), 'sha256');
  for (const off of [undefined, null, false, 'off', {}, { mode: 'observe' }]) assert.equal(integritySettings(off).mode, 'off');
  assert.deepEqual(integritySettings({ mode: 'on' }), { mode: 'on', behindMinutes: 30, readEveryMinutes: 10, branch: null, remote: 'origin' });
  assert.equal(integritySettings('on').mode, 'on');
  assert.deepEqual({ ...integritySettings({ mode: 'on', behindMinutes: 5, readEveryMinutes: 2, branch: 'trunk', remote: 'up' }) }, { mode: 'on', behindMinutes: 5, readEveryMinutes: 2, branch: 'trunk', remote: 'up' });
  for (const never of [0, false]) assert.equal(integritySettings({ mode: 'on', behindMinutes: never }).behindMinutes, 0, 'never red for being behind');
  assert.equal(integritySettings({ mode: 'on', behindMinutes: -5 }).behindMinutes, 30);
});

test('the heads the remote reported: newest last, no repeats, the last 20 kept, anything that is not a commit id ignored', () => {
  let s = noteHead(null, sha('a'), iso(T0));
  assert.deepEqual(s.heads, [{ sha: sha('a'), at: iso(T0) }]); assert.equal(newestHead(s), sha('a')); assert.equal(s.readAt, iso(T0));
  s = noteHead(s, sha('a'), iso(T0 + 1000));
  assert.equal(s.heads.length, 1, 'the same head again is not a new entry');
  s = noteHead(s, sha('b'), iso(T0 + 2000));
  s = noteHead(s, sha('a'), iso(T0 + 3000));                       // the remote moved back to an older head: it is the newest thing it said
  assert.deepEqual(s.heads.map((h) => h.sha), [sha('b'), sha('a')]);
  for (const bad of ['', null, 'main', 'zz', sha('a').slice(0, 39)]) assert.deepEqual(noteHead(s, bad, iso(T0)).heads, s.heads);
  for (let i = 0; i < 30; i += 1) s = noteHead(s, String(i).padStart(2, '0').repeat(20), iso(T0 + i));
  assert.equal(s.heads.length, MAX_HEADS); assert.equal(newestHead(s), '29'.repeat(20));
  assert.equal(newestHead({}), null); assert.equal(newestHead(null), null);
});

test('one file: equal to the newest landed content = current; equal to the checkout\'s own landed commit = behind; anything else = changed', () => {
  assert.equal(fileState({ live: 'x', atNewest: 'x', atHead: 'x', headOk: true }), 'current');
  assert.equal(fileState({ live: 'x', atNewest: 'x', atHead: 'w', headOk: false }), 'current', 'it holds the newest landed content, whatever commit the checkout is on');
  assert.equal(fileState({ live: 'w', atNewest: 'x', atHead: 'w', headOk: true }), 'behind');
  assert.equal(fileState({ live: 'w', atNewest: undefined, atHead: 'w', headOk: true }), 'behind', 'the newest head is not in the local repository yet');
  assert.equal(fileState({ live: 'w', atNewest: 'x', atHead: 'w', headOk: false }), 'changed', 'a commit that never landed is no basis for "behind"');
  assert.equal(fileState({ live: 'z', atNewest: 'x', atHead: 'w', headOk: true }), 'changed');
  assert.equal(fileState({ live: null, atNewest: 'x', atHead: 'x', headOk: true }), 'changed', 'the file is gone');
  assert.equal(fileState({ live: null, atNewest: null, atHead: 'x', headOk: true }), 'current', 'deleted upstream and deleted here');
});

test('the judgment: green, amber with a clock, red — and never red only because the remote could not be read', () => {
  const f = (o) => ({ path: 'src/gates.mjs', live: 'a', atNewest: 'a', atHead: 'a', ...o });
  const base = { head: sha('1'), newest: sha('1'), newestHere: true, landed: true, back: false, forward: true, now: T0 };
  // current
  let r = judge({ ...base, files: [f(), f({ path: 'public/app.js' })] });
  assert.equal(r.status, 'ok'); assert.equal(r.state, 'current'); assert.match(r.detail, /^gate files match 1111111 \(2 files\)$/); assert.equal(r.next.passedAt, sha('1'));
  // never read: unknown, with the reason, nothing red
  r = judge({ ...base, newest: null, files: [f()], state: { readError: 'gh: not logged in' } });
  assert.equal(r.status, 'unknown'); assert.equal(r.state, 'unread'); assert.match(r.detail, /the remote head has not been read \(gh: not logged in\)/);
  // behind: amber, the clock starts now, and the commit the checkout is on still passes
  const behind = { ...base, newest: sha('2'), files: [f({ atNewest: 'b' })], commitsBehind: 2 };
  r = judge(behind);
  assert.equal(r.status, 'warn'); assert.equal(r.state, 'behind'); assert.match(r.detail, /^gate files are behind by 2 commits \(0 min\): fast-forward the live checkout$/);
  assert.equal(r.next.behindSince, iso(T0)); assert.equal(r.next.behindOf, sha('1')); assert.equal(r.next.passedAt, sha('1'));
  // …the clock runs on from the kept state; past the limit it is red and says a landed change is not running
  const kept = r.next;
  r = judge({ ...behind, state: kept, now: T0 + 29 * 60e3 });
  assert.equal(r.status, 'warn'); assert.match(r.detail, /\(29 min\)/);
  r = judge({ ...behind, state: kept, now: T0 + 30 * 60e3 });
  assert.equal(r.status, 'down'); assert.match(r.detail, /^a gate change has landed and is NOT running here: behind by 2 commits for 30 min \(src\/gates\.mjs\)/);
  // with the limit switched off it stays amber however long it takes
  r = judge({ ...behind, state: kept, now: T0 + 3 * 24 * 3600e3, behindMinutes: 0 });
  assert.equal(r.status, 'warn');
  // the newer head is not in the local repository: the board can say a commit landed, not what it touches
  r = judge({ ...behind, newestHere: false, files: [f({ atNewest: undefined })], state: kept, now: T0 + 5 * 60e3 });
  assert.equal(r.status, 'warn'); assert.deepEqual(r.behind, []); assert.match(r.detail, /^a newer commit has landed and is not fetched here yet \(5 min\): fetch and fast-forward the live checkout$/);
  r = judge({ ...behind, newestHere: false, files: [f({ atNewest: undefined })], state: kept, now: T0 + 31 * 60e3 });
  assert.equal(r.status, 'down'); assert.match(r.detail, /^a newer commit landed 31 min ago and is NOT running here \(not fetched yet/);
  // a new commit to be behind restarts the clock (the checkout was fast-forwarded part of the way)
  r = judge({ ...behind, head: sha('3'), state: kept, now: T0 + 40 * 60e3 });
  assert.equal(r.next.behindSince, iso(T0 + 40 * 60e3)); assert.equal(r.status, 'warn');
  // changed: red at once, and it names the file
  r = judge({ ...base, files: [f({ live: 'z' }), f({ path: 'public/app.js' })] });
  assert.equal(r.status, 'down'); assert.equal(r.state, 'changed'); assert.deepEqual(r.changed, ['src/gates.mjs']);
  assert.match(r.detail, /^gate files differ from 1111111: src\/gates\.mjs — the files differ from what landed$/);
  // behind and changed together: red at once
  r = judge({ ...behind, files: [f({ atNewest: 'b' }), f({ path: 'public/app.js', live: 'z', atNewest: 'b' })] });
  assert.equal(r.status, 'down'); assert.equal(r.state, 'changed'); assert.deepEqual(r.changed, ['public/app.js']); assert.deepEqual(r.behind, ['src/gates.mjs']);
  // the checkout moved back to an older commit: a downgrade, not a delay
  r = judge({ ...behind, back: true });
  assert.equal(r.status, 'down'); assert.match(r.detail, /the checkout moved back to an older commit/);
  // the checkout is on a commit that never landed
  r = judge({ ...behind, landed: false });
  assert.equal(r.status, 'down'); assert.match(r.detail, /a commit that has not landed/);
  // a local commit on top that leaves the gate files alone: green, but it is not the new mark
  r = judge({ ...base, head: sha('9'), landed: false, files: [f()], state: { passedAt: sha('1') } });
  assert.equal(r.status, 'ok'); assert.equal(r.next.passedAt, sha('1'));
  // many files: the text stays short
  r = judge({ ...base, files: ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => f({ path: p, live: 'z' })) });
  assert.match(r.detail, /a, b, c, d and 2 more/);
});

// ── registration ────────────────────────────────────────────────────────────
const REPO = '/home/u/Board Dir';
const CMD = `GATE_NODE='/opt/node/bin/node' '${REPO}/scripts/gate-hook.sh'`;
const entry = (matcher, command = CMD) => ({ ...(matcher === null ? {} : { matcher }), hooks: [{ type: 'command', command, timeout: 15 }] });
const installed = () => ({ permissions: {}, hooks: { PreToolUse: [entry(CLAUDE_MATCHER)], PostToolUse: [entry('Bash')] } });

test('a first start on a checkout that has not fetched the newest head is "behind, not fetched", not "changed" (review finding 2)', () => {
  const f = (o) => ({ path: 'src/gates.mjs', live: 'a', atNewest: undefined, atHead: 'a', ...o });
  // no kept state, the newest head not in the local repository, so nothing can say the checkout's commit has landed
  const first = { head: sha('1'), newest: sha('2'), newestHere: false, landed: false, back: false, forward: true, now: T0, state: {} };
  let r = judge({ ...first, files: [f(), f({ path: 'server.mjs' })] });
  assert.equal(r.status, 'warn'); assert.equal(r.state, 'behind'); assert.deepEqual(r.changed, []);
  assert.match(r.detail, /^a newer commit has landed and is not fetched here yet \(0 min\): fetch and fast-forward the live checkout$/);
  assert.equal(r.next.passedAt, null, 'an unproven commit is not made the mark');
  // red after the limit, like any checkout left behind
  r = judge({ ...first, files: [f()], state: r.next, now: T0 + 31 * 60000 });
  assert.equal(r.status, 'down'); assert.equal(r.state, 'behind'); assert.equal(r.next.passedAt, null);
  // a file edited in the work tree is changed whatever the remote says, and the reason is the true one
  r = judge({ ...first, files: [f(), f({ path: 'server.mjs', live: 'x' })] });
  assert.equal(r.status, 'down'); assert.equal(r.state, 'changed'); assert.deepEqual(r.changed, ['server.mjs']);
  assert.match(r.detail, /server\.mjs — the files differ from the commit this checkout is on$/);
  // with a mark from an earlier pass the stricter judgment stands: a commit that has not landed is changed
  r = judge({ ...first, files: [f()], state: { passedAt: sha('0') } });
  assert.equal(r.state, 'changed'); assert.match(r.detail, /the checkout is on a commit that has not landed$/);
});

test('registration: the exact command of this checkout and a matcher that covers every tool — not just "the file mentions the hook"', () => {
  // the shipped template, rendered, is what "registered" means
  const tmpl = readFileSync(path.join(ROOT, 'examples', 'claude', 'guardrails-hooks.json.tmpl'), 'utf8').replaceAll('__REPO__', REPO).replaceAll('__NODE_BIN_DIR__', '/opt/node/bin');
  assert.deepEqual(registrationProblems(JSON.parse(tmpl), { repo: REPO }), { ok: true, problems: [] });
  assert.equal(registrationProblems(installed(), { repo: REPO }).ok, true);
  assert.equal(hookEntries(installed()).length, 2);
  // a Node upgrade changes the path in front, not the hook
  const moved = installed(); moved.hooks.PreToolUse[0].hooks[0].command = CMD.replace('/opt/node/bin', '/usr/local/n/v24/bin');
  assert.equal(registrationProblems(moved, { repo: REPO }).ok, true);
  // the Node path, absolute, is part of "exact" (the review of this slice, finding 1): without it the hook's
  // Node step is whatever `node` the session's PATH names first, and a settings file's env block can set PATH
  for (const bare of [`'${REPO}/scripts/gate-hook.sh'`, `GATE_NODE='node' '${REPO}/scripts/gate-hook.sh'`, `GATE_NODE='' '${REPO}/scripts/gate-hook.sh'`]) {
    assert.equal(isHookCommand(bare, REPO), false, bare); assert.equal(isBareHookCommand(bare, REPO), true, bare);
    const s2 = installed(); s2.hooks.PreToolUse[0].hooks[0].command = bare;
    assert.match(registrationProblems(s2, { repo: REPO }).problems.join(), /^PreToolUse runs the gate hook without its Node path \(GATE_NODE='\/…\/node' in front\): a settings file's PATH would then choose the program\. Run the installer again$/);
  }
  assert.equal(isBareHookCommand(CMD, REPO), false); assert.equal(isBareHookCommand('echo gate-hook.sh', REPO), false);
  // not the gate: a copy elsewhere, a trailing command, another checkout
  for (const bad of [CMD.replace(REPO, '/tmp/copy'), `${CMD} || true`, `true; ${CMD}`, `${CMD.slice(0, -1)}.bak'`, 'echo gate-hook.sh']) assert.equal(isHookCommand(bad, REPO), false, bad);
  const no = (s, re, o = {}) => { const r = registrationProblems(s, { repo: REPO, ...o }); assert.equal(r.ok, false); assert.match(r.problems.join(' | '), re); };
  no(null, /missing or unreadable/);
  no({ hooks: {} }, /PreToolUse does not run this checkout's gate hook \| PostToolUse does not run/);
  const elsewhere = installed(); elsewhere.hooks.PreToolUse[0].hooks[0].command = CMD.replace(REPO, '/tmp/copy');
  no(elsewhere, /^PreToolUse does not run this checkout's gate hook$/);
  // the matcher narrowed: the hook is "there", and most tools no longer reach it
  const narrow = installed(); narrow.hooks.PreToolUse[0].matcher = 'Bash';
  no(narrow, /PreToolUse runs the gate hook with a matcher \("Bash"\) that leaves out Read, Edit, Write, MultiEdit, NotebookEdit, MCP tools/);
  const noMcp = installed(); noMcp.hooks.PreToolUse[0].matcher = 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit';
  no(noMcp, /leaves out MCP tools$/);
  // a wider matcher is fine; two entries that cover the tools between them are fine
  for (const wide of ['', '*', '.*']) { const w = installed(); w.hooks.PreToolUse[0].matcher = wide; assert.equal(registrationProblems(w, { repo: REPO }).ok, true, wide); }
  const split = installed(); split.hooks.PreToolUse = [entry('Bash|Read|Edit|Write|MultiEdit|NotebookEdit'), entry('mcp__.*')];
  assert.equal(registrationProblems(split, { repo: REPO }).ok, true);
  // hooks switched off in the same file
  no({ ...installed(), disableAllHooks: true }, /the user settings file sets disableAllHooks/);
  // Codex: no matchers, the same command
  const codex = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'codex', 'guardrails-hooks.json.tmpl'), 'utf8').replaceAll('__REPO__', REPO).replaceAll('__NODE_BIN_DIR__', '/opt/node/bin'));
  assert.equal(registrationProblems(codex, { repo: REPO, codex: true }).ok, true);
  no({ hooks: { PreToolUse: codex.hooks.PreToolUse } }, /PostToolUse does not run/, { codex: true });
  // how Claude Code reads a matcher: a plain word list is exact, anything else is a regular expression
  assert.equal(matcherCovers('Bash|Read', 'Read'), true); assert.equal(matcherCovers('Bash|Read', 'ReadMore'), false);
  assert.equal(matcherCovers('mcp__.*', 'mcp__server__tool'), true); assert.equal(matcherCovers('mcp__memory', 'mcp__memory__write'), false);
  assert.equal(matcherCovers('(', 'Bash'), false, 'a broken pattern covers nothing');
});

test('a settings change: switching hooks off, or dropping the gate hook from the user file, is blocked; everything else passes', () => {
  const v = (o) => configChangeVerdict({ repo: REPO, ...o });
  // the one key that silences a user-level hook, at any level
  for (const source of ['project_settings', 'local_settings', 'user_settings']) {
    const r = v({ source, settings: { ...(source === 'user_settings' ? installed() : {}), disableAllHooks: true } });
    assert.equal(r.block, true, source); assert.match(r.why, /disableAllHooks/);
  }
  assert.equal(disablesHooks({ disableAllHooks: 'true' }), false); assert.equal(disablesHooks(null), false);
  // a project file may add hooks, permissions, anything else: hooks merge across levels, they do not replace
  for (const settings of [{}, { hooks: { PreToolUse: [entry('Bash', 'echo mine')] } }, { disableAllHooks: false }, { permissions: { allow: ['Bash(ls:*)'] } }, null])
    for (const source of ['project_settings', 'local_settings']) assert.deepEqual(v({ source, settings }), { block: false, why: '' });
  // the user file is where the gate is registered: gone, unreadable, without the entry, or with it narrowed
  assert.deepEqual(v({ source: 'user_settings', settings: installed() }), { block: false, why: '' });
  assert.match(v({ source: 'user_settings', settings: null }).why, /gone or cannot be read/);
  assert.equal(v({ source: 'user_settings', settings: { hooks: {} } }).block, true);
  const narrow = installed(); narrow.hooks.PreToolUse[0].matcher = 'Read';
  assert.match(v({ source: 'user_settings', settings: narrow }).why, /leaves out Bash/);
  // not ours to judge: skill files are not settings, and managed policy cannot be blocked by a hook
  for (const source of ['skills', 'policy_settings']) assert.deepEqual(v({ source, settings: { disableAllHooks: true } }), { block: false, why: '' });
});

test('a settings file\'s env block: the variables the gate hook reads may not be set there, at any level; others may', () => {
  assert.deepEqual(HOOK_ENV, ['MESH_BOARD', 'MC_PORT', 'GATE_TIMEOUT_MS', 'GATE_NODE', 'MESH_GATE_IDENTITY', 'CMUX_WORKSPACE_ID', 'CMUX_AGENT_LAUNCH_KIND', 'MC_OVERLAY', 'CLAUDE_PROJECT_DIR', 'HOME']);
  assert.deepEqual(hookEnvSet({ env: { MESH_BOARD: 'http://127.0.0.1:4999', EDITOR: 'vi', HOME: '/x' } }), ['MESH_BOARD', 'HOME']);
  for (const none of [null, {}, { env: null }, { env: 'MESH_BOARD=x' }, { env: ['MESH_BOARD'] }, { env: { PATH: '/opt/bin', NODE_OPTIONS: '--max-old-space-size=8192', EDITOR: 'vi' } }]) assert.deepEqual(hookEnvSet(none), [], JSON.stringify(none));
  assert.equal(settingsProblem({ env: { EDITOR: 'vi' } }), null);
  assert.match(settingsProblem({ disableAllHooks: true, env: { MC_PORT: '1' } }), /^sets disableAllHooks/);
  // the value never reaches a message: it may be anything
  const p = settingsProblem({ env: { MESH_BOARD: 'http://127.0.0.1:4999/s3cret', GATE_TIMEOUT_MS: '600000' } });
  assert.equal(p, 'sets MESH_BOARD, GATE_TIMEOUT_MS in env: the gate hook reads that from its environment, so the file steers the hook');
  const v = (o) => configChangeVerdict({ repo: REPO, ...o });
  for (const source of ['project_settings', 'local_settings', 'user_settings']) {
    const r = v({ source, settings: { ...(source === 'user_settings' ? installed() : {}), env: { MESH_BOARD: 'http://127.0.0.1:4999' } } });
    assert.equal(r.block, true, source); assert.equal(r.why, 'the change sets MESH_BOARD in env: the gate hook reads that from its environment, so the file steers the hook');
    assert.deepEqual(v({ source, settings: { ...(source === 'user_settings' ? installed() : {}), env: { EDITOR: 'vi', PATH: '/opt/bin' } } }), { block: false, why: '' });
  }
  // and the card says so for the user's own file
  assert.match(registrationProblems({ ...installed(), env: { MC_PORT: '4999' } }, { repo: REPO }).problems.join(), /the user settings file sets MC_PORT in env/);
});

test('every event is judged on all the settings files of the session: a change blocked earlier may not come in with the next harmless one', () => {
  const user = { source: 'user_settings', settings: installed(), file: '/home/u/.claude/settings.json' };
  const proj = (settings) => ({ source: 'project_settings', settings, file: '/w/app/.claude/settings.json' });
  const local = (settings) => ({ source: 'local_settings', settings, file: '/w/app/.claude/settings.local.json' });
  const sv = (changed, others) => sessionVerdict({ changed, others, repo: REPO });
  // the changed file itself is the reason
  assert.deepEqual(sv(local({ disableAllHooks: true }), [user, proj({})]), { block: true, why: 'the change sets disableAllHooks, which switches the gate hook off', file: '/w/app/.claude/settings.local.json' });
  // seen live: the local file was blocked a moment ago and is still on disk; now the project file changes, harmlessly
  const r = sv(proj({ permissions: {} }), [user, local({ disableAllHooks: true })]);
  assert.deepEqual(r, { block: true, why: '/w/app/.claude/settings.local.json sets disableAllHooks, which switches the gate hook off; letting this change through would make the session read that file again', file: '/w/app/.claude/settings.local.json' });
  // the same for an env block, and for a user file that lost the gate hook while this session ran
  assert.match(sv(proj({}), [user, local({ env: { MESH_BOARD: 'x' } })]).why, /^\/w\/app\/\.claude\/settings\.local\.json sets MESH_BOARD in env/);
  assert.match(sv(local({}), [{ ...user, settings: { hooks: {} } }]).why, /^PreToolUse does not run this checkout's gate hook; PostToolUse does not run this checkout's gate hook \(\/home\/u\/\.claude\/settings\.json\); letting this change through/);
  assert.match(sv(local({}), [{ ...user, settings: null }]).why, /^the user settings file is gone or cannot be read/);
  // put right: everything passes again. A project or local file that does not exist is no settings at all
  assert.deepEqual(sv(proj({ permissions: {} }), [user, local({})]), { block: false, why: '', file: null });
  assert.deepEqual(sv(proj({}), [user, local(null), proj(null)]), { block: false, why: '', file: null });
  // a skill file is not judged itself, but the settings that would be read with it are; managed policy cannot be blocked
  assert.equal(sv({ source: 'skills', settings: null, file: null }, [user, local({ disableAllHooks: true })]).block, true);
  assert.equal(sv({ source: 'skills', settings: null, file: null }, [user, local({})]).block, false);
  assert.equal(sv({ source: 'policy_settings', settings: { disableAllHooks: true }, file: '/Library/x.json' }, [user, local({ disableAllHooks: true })]).block, false);
});

test('the port: data/local.env must point the hook at this board', () => {
  assert.equal(portProblem('MC_PORT=3210\n', 3210), null);
  assert.equal(portProblem('# local\nOTHER=1\n', 3210), null, 'no port there: the hook uses the default');
  assert.equal(portProblem('', 3210), null); assert.equal(portProblem(null, 3210), null);
  assert.match(portProblem('X=1\nMC_PORT=3999\n', 3210), /MC_PORT=3999, this board listens on 3210/);
});

// ── which files, which ref, and the card ────────────────────────────────────
test('the file list is the policy\'s gateCode list: files of the live checkout, a folder taken from the commit, nothing outside it', () => {
  const lsTree = (dir) => ({ public: ['public/app.js', 'public/decide.js', 'public/index.html'] }[dir] || []);
  assert.deepEqual(gatePaths(['<live>/src/gates.mjs', '<live>/scripts/gate-hook.sh', '<live>/public/**', '~/.claude/settings.json', '/etc/hosts', '<live>/data/*.json'], { lsTree }),
    ['public/app.js', 'public/decide.js', 'public/index.html', 'scripts/gate-hook.sh', 'src/gates.mjs']);
  assert.deepEqual(gatePaths(null), []); assert.deepEqual(gatePaths(['<live>/public/**']), []);
  // the shipped list names the hook, the classifier, the service and the page — and this module's own inputs
  const shipped = gatePaths(DEFAULT_POLICY.lists.gateCode, { lsTree });
  for (const f of ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'src/gates.mjs', 'src/gate-service.mjs', 'server.mjs', 'public/decide.js']) assert.ok(shipped.includes(f), f);
});

test('which ref the remote is asked about: its default branch; for a release install the tag the checkout is on', () => {
  const answers = (o) => (args) => o[args.join(' ')] ?? null;
  const S = integritySettings('on');
  const url = 'https://github.com/acme/board.git';
  assert.deepEqual(remoteTarget({ settings: S, git: answers({ 'config --get remote.origin.url': url, 'symbolic-ref -q --short HEAD': 'main', 'symbolic-ref -q --short refs/remotes/origin/HEAD': 'origin/trunk' }) }), { ref: 'heads/trunk', name: 'trunk', release: false, url });
  // a checkout on a work branch is still judged against the default branch
  assert.equal(remoteTarget({ settings: S, git: answers({ 'symbolic-ref -q --short HEAD': 'task/7', 'symbolic-ref -q --short refs/remotes/origin/HEAD': 'origin/main' }) }).ref, 'heads/main');
  assert.equal(remoteTarget({ settings: S, git: answers({ 'symbolic-ref -q --short HEAD': 'main' }) }).ref, 'heads/main', 'no pointer to the default branch: main');
  assert.equal(remoteTarget({ settings: integritySettings({ mode: 'on', branch: 'stable', remote: 'up' }), git: answers({ 'symbolic-ref -q --short HEAD': 'main', 'config --get remote.up.url': url }) }).ref, 'heads/stable');
  // detached exactly at a tag: a release install
  assert.deepEqual(remoteTarget({ settings: S, git: answers({ 'config --get remote.origin.url': url, 'describe --exact-match --tags HEAD': 'v1.3.0' }) }), { ref: 'tags/v1.3.0', name: 'v1.3.0', release: true, url });
  // detached somewhere else: the default branch again
  assert.equal(remoteTarget({ settings: S, git: answers({}) }).ref, 'heads/main');
});

test('reading the remote: gh first on GitHub, git ls-remote otherwise or when gh fails; an annotated tag gives the commit it names', async () => {
  const A = sha('a'); const B = sha('b');
  const calls = [];
  const run = (replies) => async (cmd, args) => { calls.push([cmd, ...args].join(' ')); return replies[cmd] || { ok: false, out: '', err: 'not installed' }; };
  const branch = { ref: 'heads/main', name: 'main', release: false };
  assert.equal(await readRemoteRef({ target: branch, slug: 'acme/board', run: run({ gh: { ok: true, out: `${A}\n` } }) }), A);
  assert.deepEqual(calls, ['gh api repos/acme/board/commits/main --jq .sha']);
  // gh missing, logged out, or answering something that is not a commit id: ask git
  for (const gh of [{ ok: false, out: '', err: 'gh: not logged in' }, { ok: true, out: 'Not Found' }, undefined]) {
    calls.length = 0;
    assert.equal(await readRemoteRef({ target: branch, slug: 'acme/board', root: '/w', run: run({ ...(gh ? { gh } : {}), git: { ok: true, out: `${B}\trefs/heads/main\n` } }) }), B);
    assert.equal(calls[calls.length - 1], 'git -C /w ls-remote origin refs/heads/main');
  }
  // not on GitHub: gh is never asked
  calls.length = 0;
  assert.equal(await readRemoteRef({ target: branch, slug: null, run: run({ git: { ok: true, out: `${B}\trefs/heads/main\n` } }) }), B);
  assert.deepEqual(calls, ['git ls-remote origin refs/heads/main']);
  // a release tag: the commit, not the tag object
  const tag = { ref: 'tags/v1.3.0', name: 'v1.3.0', release: true };
  assert.equal(await readRemoteRef({ target: tag, run: run({ git: { ok: true, out: `${A}\trefs/tags/v1.3.0\n${B}\trefs/tags/v1.3.0^{}\n` } }) }), B);
  assert.equal(await readRemoteRef({ target: tag, run: run({ git: { ok: true, out: `${A}\trefs/tags/v1.3.0\n` } }) }), A, 'a lightweight tag');
  // nothing readable: an error with the reason, which the check turns into "not read", never into red
  await assert.rejects(readRemoteRef({ target: branch, run: run({ git: { ok: false, out: '', err: 'fatal: could not resolve host\nmore' } }) }), /the remote could not be read \(fatal: could not resolve host\)/);
  await assert.rejects(readRemoteRef({ target: branch, run: run({ git: { ok: true, out: '' } }) }), /the remote has no heads\/main/);
});

test('the card part: a dropped hook or a wrong port is red whatever the files say; otherwise the files decide', () => {
  const ok = { status: 'ok', state: 'current', detail: 'gate files match abc1234 (22 files)', changed: [], behind: [], head: sha('a'), newest: sha('a') };
  assert.deepEqual({ status: integrityCard({ files: ok }).status, detail: integrityCard({ files: ok }).detail }, { status: 'ok', detail: ok.detail });
  const dropped = integrityCard({ files: ok, registration: ['PreToolUse does not run this checkout\'s gate hook'] });
  assert.equal(dropped.status, 'down'); assert.equal(dropped.detail, 'PreToolUse does not run this checkout\'s gate hook'); assert.equal(dropped.state, 'current');
  const both = integrityCard({ files: { ...ok, status: 'down', state: 'changed', detail: 'gate files differ from abc1234: src/gates.mjs', changed: ['src/gates.mjs'] }, registration: ['x'], port: 'data/local.env says MC_PORT=3999' });
  assert.equal(both.status, 'down'); assert.equal(both.detail, 'x · data/local.env says MC_PORT=3999 · gate files differ from abc1234: src/gates.mjs'); assert.deepEqual(both.changed, ['src/gates.mjs']);
  assert.equal(integrityCard({ files: { ...ok, status: 'warn', state: 'behind', detail: 'behind' } }).status, 'warn');
  assert.equal(integrityCard({ files: null }).status, 'unknown');
});

test('the board wires it in: one poll stage, read-only helpers, the card file carries the result, a release is read soon after', () => {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /const INTEGRITY = integritySettings\(DEMO \? null : SETTINGS\.gateIntegrity\);/);
  assert.match(src, /const integrity = INTEGRITY\.mode !== 'on' \? null : createGateIntegrity\(\{/);
  assert.match(src, /files: \(\) => \[\.\.\.gatePaths\(gates\.policy\(\)\?\.lists\?\.gateCode \|\| GATE_DEFAULT_POLICY\.lists\.gateCode, [^\n]*, \.\.\.OWN_FILES\],/);
  // the settings-change hook reports a block to the board, from this machine only
  assert.match(src, /url\.pathname === '\/api\/gates\/config-change' && req\.method === 'POST'\) \{\n[^\n]*\n[^\n]*\n\s*if \(!localOnly\(req\)\) throw/);
  assert.match(src, /JSON\.stringify\(\{ \.\.\.c, \.\.\.\(integ \? \{ integrity: integ \} : \{\}\), at: Date\.now\(\) \}\)/);
  assert.match(src, /if \(integrity && answer\.decision === 'allow'\) for \(const ms of \[20e3, 90e3\]\) setTimeout\(\(\) => integrity\.readRemote\(true\)/);
  // the only git commands the check runs are ones that read
  const used = [...readFileSync(path.join(ROOT, 'src', 'gate-integrity.mjs'), 'utf8').matchAll(/git\(\['([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)].sort(), ['cat-file', 'config', 'describe', 'ls-tree', 'merge-base', 'rev-list', 'rev-parse', 'symbolic-ref']);
  // every repo a registered agent works in is looked at for a settings file that switches hooks off
  assert.match(src, /for \(const repo of repos\) for \(const f of PROJECT_SETTINGS\) \{\n\s*const why = settingsProblem\(await json\(path\.join\(repo, f\)\)\);\n\s*if \(why\) registration\.push\(/);
  // shipped settings: off in the examples until the installer turns it on
  assert.match(readFileSync(path.join(ROOT, 'examples', 'config', 'jobs.mjs'), 'utf8'), /^\s*gateIntegrity: \{ mode: 'off' \},$/m);
});

test('the triggers file: what the hook greps first is what the policy generates — a changed or missing file is rewritten and reported', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gate triggers-'));
  const state = path.join(dir, 'state');
  await writeFileP(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const svc = createGateService({ root: dir, ledger: createLedger(path.join(dir, 'tasks')), policyFile: path.join(dir, 'policy.json'), stateDir: state, identifyWs: async () => null, home: '/home/u', git: () => null });
  await svc.loadPolicy();
  const file = path.join(state, 'triggers');
  const good = readFileSync(file, 'utf8');
  assert.equal(good, `${triggerLines(DEFAULT_POLICY, { boardRoot: dir, home: '/home/u' }).join('\n')}\n`);
  assert.deepEqual(await svc.verifyTriggers(), { ok: true });
  // one line taken out: a whole kind of call would pass the fast path unseen
  const lines = good.trimEnd().split('\n');
  writeFileSync(file, `${lines.slice(1).join('\n')}\n`);
  assert.deepEqual(await svc.verifyTriggers(), { ok: false, rewritten: true, missing: false });
  assert.equal(readFileSync(file, 'utf8'), good, 'put right at once');
  assert.deepEqual(await svc.verifyTriggers(), { ok: true });
  // emptied, or gone
  writeFileSync(file, '');
  assert.equal((await svc.verifyTriggers()).rewritten, true); assert.equal(readFileSync(file, 'utf8'), good);
  rmSync(file);
  assert.deepEqual(await svc.verifyTriggers(), { ok: false, rewritten: true, missing: true }); assert.equal(readFileSync(file, 'utf8'), good);
  assert.match(readFileSync(path.join(ROOT, 'server.mjs'), 'utf8'), /const trig = await gates\.verifyTriggers\(\)\.catch\(\(\) => \(\{ ok: true \}\)\);/);
});

// ── the settings-change hook ────────────────────────────────────────────────
test('the settings-change hook, pure: which file changed, and the answer Claude Code reads', () => {
  assert.equal(settingsFileFor({ source: 'local_settings', file_path: '/w/app/.claude/settings.local.json' }), '/w/app/.claude/settings.local.json');
  assert.equal(settingsFileFor({ source: 'user_settings' }, '/home/u'), '/home/u/.claude/settings.json');
  assert.equal(settingsFileFor({ source: 'project_settings', cwd: '/w/app' }), '/w/app/.claude/settings.json');
  assert.equal(settingsFileFor({ source: 'local_settings', cwd: '/w/app' }), '/w/app/.claude/settings.local.json');
  assert.equal(settingsFileFor({ source: 'skills', cwd: '/w/app' }), null);
  // which folders may be the session's project: what Claude Code names, the hook input's folder, the changed file's own
  assert.deepEqual(sessionFolders({ source: 'local_settings', cwd: '/w/app/sub', file_path: '/w/app/.claude/settings.local.json' }, '/w/app'), ['/w/app', '/w/app/sub']);
  assert.deepEqual(sessionFolders({ source: 'user_settings', cwd: '/w/app', file_path: '/home/u/.claude/settings.json' }, undefined), ['/w/app']);
  assert.deepEqual(sessionFolders({ source: 'project_settings', cwd: '/w/app', file_path: '/w/other/.claude/settings.json' }, '/w/spoofed'), ['/w/spoofed', '/w/app', '/w/other']);
  const files = { '/home/u/.claude/settings.json': JSON.stringify(installed()), '/w/app/.claude/settings.local.json': '{"disableAllHooks":true}', '/w/app/.claude/settings.json': '{"permissions":{}}' };
  const read = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; };
  const jc = (j, o = {}) => judgeChange(j, { root: REPO, read, home: '/home/u', projectDir: undefined, ...o });
  assert.deepEqual(jc({ source: 'local_settings', cwd: '/w/app' }), { block: true, why: 'the change sets disableAllHooks, which switches the gate hook off', file: '/w/app/.claude/settings.local.json', changed: '/w/app/.claude/settings.local.json' });
  // the project file changes, harmlessly, while that local file is still on disk: blocked, and the reason names the local file
  let r = jc({ source: 'project_settings', cwd: '/w/app', file_path: '/w/app/.claude/settings.json' });
  assert.deepEqual([r.block, r.file, r.changed], [true, '/w/app/.claude/settings.local.json', '/w/app/.claude/settings.json']);
  assert.match(r.why, /^\/w\/app\/\.claude\/settings\.local\.json sets disableAllHooks/);
  // the same when the user's own file changes, and when the session's folder is only known from Claude Code's variable
  assert.equal(jc({ source: 'user_settings', cwd: '/w/app', file_path: '/home/u/.claude/settings.json' }).file, '/w/app/.claude/settings.local.json');
  assert.equal(jc({ source: 'user_settings', cwd: '/elsewhere', file_path: '/home/u/.claude/settings.json' }, { projectDir: '/w/app' }).block, true);
  assert.equal(jc({ source: 'user_settings', cwd: '/elsewhere', file_path: '/home/u/.claude/settings.json' }).block, false, 'another folder: not this session\'s files');
  // put right: the same events pass
  files['/w/app/.claude/settings.local.json'] = '{}';
  assert.deepEqual(jc({ source: 'project_settings', cwd: '/w/app' }), { block: false, why: '', file: '/w/app/.claude/settings.json', changed: '/w/app/.claude/settings.json' });
  assert.equal(jc({ source: 'local_settings', cwd: '/w/app' }).block, false);
  assert.equal(jc({ source: 'project_settings', cwd: '/w/other' }).block, false, 'a project file that is gone switches nothing off');
  // the user's own file gone: the gate is no longer registered, whichever file the event names
  assert.equal(jc({ source: 'user_settings' }, { home: '/home/nobody' }).block, true);
  assert.match(jc({ source: 'local_settings', cwd: '/w/app' }, { home: '/home/nobody' }).why, /^the user settings file is gone or cannot be read/);
  assert.deepEqual(JSON.parse(blockOutput('x')), { decision: 'block', reason: 'GATE: this settings change is not applied to the running session — x' });
  // the template registers it, with no matcher (every source); the card can tell whether it is there
  const tmpl = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'claude', 'guardrails-hooks.json.tmpl'), 'utf8').replaceAll('__REPO__', REPO).replaceAll('__NODE_BIN_DIR__', '/opt/node/bin'));
  assert.deepEqual(tmpl.hooks.ConfigChange, [{ hooks: [{ type: 'command', command: `GATE_NODE='/opt/node/bin/node' '${REPO}/${CONFIG_HOOK}'`, timeout: 30 }] }]);
  assert.equal(registrationProblems(tmpl, { repo: REPO, configHook: true }).ok, true);
  assert.match(registrationProblems(installed(), { repo: REPO, configHook: true }).problems.join(), /ConfigChange does not run this checkout's settings-change hook/);
  assert.equal(registrationProblems(installed(), { repo: REPO }).ok, true, 'not asked for, not a problem');
  // taking the gate out again takes this hook out too; and the check covers its own files
  assert.match(readFileSync(path.join(ROOT, 'scripts', 'guardrails-install.sh'), 'utf8'), /--remove 'scripts\/gate-config-hook\.sh'/);
  assert.deepEqual(OWN_FILES, ['src/gate-integrity.mjs', 'scripts/gate-config-hook.sh', 'scripts/gate-config-hook.mjs']);
  // a note is said on the card and never colours it
  const ok = { status: 'ok', state: 'current', detail: 'gate files match abc1234 (25 files)' };
  assert.deepEqual([integrityCard({ files: ok, notes: ['settings-change hook not installed'] }).status, integrityCard({ files: ok, notes: ['settings-change hook not installed'] }).detail], ['ok', 'gate files match abc1234 (25 files) · settings-change hook not installed']);
});

test('the settings-change hook, the real script on the documented input: switching hooks off is blocked, other changes pass, a check that cannot run blocks', () => {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate config-')));
  const home = path.join(dir, 'Home Dir'); mkdirSync(path.join(home, '.claude'), { recursive: true });
  const proj = path.join(dir, 'Some Repo'); mkdirSync(path.join(proj, '.claude'), { recursive: true });
  const local = path.join(proj, '.claude', 'settings.local.json');
  const project = path.join(proj, '.claude', 'settings.json');
  const user = path.join(home, '.claude', 'settings.json');
  const configHook = path.join(ROOT, 'scripts', 'gate-config-hook.sh');
  const cmd = `GATE_NODE='/opt/node/bin/node' '${ROOT}/scripts/gate-hook.sh'`;
  const registered = JSON.stringify({ hooks: { PreToolUse: [{ matcher: CLAUDE_MATCHER, hooks: [{ type: 'command', command: cmd }] }], PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] }] } });
  writeFileSync(user, registered);
  const envH = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9' };          // no board: the hook decides by itself
  delete envH.CLAUDE_PROJECT_DIR;
  // `--home` stands in for the account's folder (an argument: the environment is not believed, see below)
  // `--env-board`: the dead port in the environment is the board these runs mean (else the hook's own checkout's)
  const run = (input, extra = {}, args = ['--env-board', '--home', home]) => spawnSync('sh', [configHook, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), env: { ...envH, ...extra }, encoding: 'utf8' });
  const input = (source, file_path) => ({ session_id: 's', transcript_path: '/t.jsonl', cwd: proj, hook_event_name: 'ConfigChange', source, ...(file_path ? { file_path } : {}) });
  const reason = (r) => { assert.equal(r.status, 0, r.stderr); const j = JSON.parse(r.stdout); assert.deepEqual(Object.keys(j), ['decision', 'reason']); assert.equal(j.decision, 'block'); return j.reason; };
  const passes = (r, what) => { assert.equal(r.status, 0, what); assert.equal(r.stdout, '', what); };

  // the case seen live: a local settings file that sets disableAllHooks
  writeFileSync(local, JSON.stringify({ disableAllHooks: true }));
  assert.match(reason(run(input('local_settings', local))), /^GATE: this settings change is not applied to the running session — the change sets disableAllHooks/);
  assert.match(reason(run(input('local_settings'))), /the change sets disableAllHooks/, 'no file_path: the usual place under the session\'s folder');
  // also seen live: that file is still on disk, and now ANOTHER file changes harmlessly. Let through,
  // it would make the session read the local file again. So it is blocked too, and the reason names the local file
  writeFileSync(project, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
  assert.match(reason(run(input('project_settings', project))), new RegExp(`— ${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sets disableAllHooks, which switches the gate hook off; letting this change through would make the session read that file again$`));
  assert.match(reason(run(input('user_settings', user))), /settings\.local\.json sets disableAllHooks/);
  assert.match(reason(run(input('skills', path.join(proj, '.claude', 'skills', 'x', 'SKILL.md')))), /settings\.local\.json sets disableAllHooks/, 'a skill file is not judged, the settings read with it are');
  // managed policy cannot be blocked by a hook: nothing to decide
  passes(run(input('policy_settings', '/Library/Application Support/ClaudeCode/managed-settings.json')), 'policy');
  // an env block that names a variable the gate hook reads: the same, and the value is not repeated
  writeFileSync(local, JSON.stringify({ env: { MESH_BOARD: 'http://127.0.0.1:4999/s3cret' } }));
  const why = reason(run(input('local_settings', local)));
  assert.match(why, /the change sets MESH_BOARD in env/); assert.doesNotMatch(why, /4999|s3cret/);
  // the local file put right (and one that is half-written): everything passes again, with no output
  for (const text of ['{}', JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, env: { EDITOR: 'vi' } }), '{ "disableAllHo']) {
    writeFileSync(local, text);
    passes(run(input('local_settings', local)), text);
  }
  passes(run(input('project_settings', project)), 'the project file, now that the local one is right');
  passes(run(input('skills')), 'a skill file');
  // the user's own file: with this checkout's gate hook it passes; without the entry, or gone, it is blocked — whichever file the event names
  passes(run(input('user_settings', user)), 'the user file as installed');
  writeFileSync(user, JSON.stringify({ hooks: {} }));
  assert.match(reason(run(input('user_settings', user))), /PreToolUse does not run this checkout's gate hook/);
  assert.match(reason(run(input('local_settings', local))), /PreToolUse does not run this checkout's gate hook[^—]*settings\.json\); letting this change through/);
  rmSync(user);
  assert.match(reason(run(input('user_settings', user))), /gone or cannot be read/);
  writeFileSync(user, registered);

  // ── the session's environment is not believed (a settings file's env block reaches the hook) ──
  writeFileSync(local, JSON.stringify({ disableAllHooks: true }));
  const marker = path.join(dir, 'preload-ran');
  const preload = path.join(dir, 'preload.cjs');
  writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(3);\n`);   // exit 3 would read as "let it apply"
  assert.match(reason(run(input('local_settings', local), { NODE_OPTIONS: `--require=${preload}` })), /sets disableAllHooks/);
  assert.throws(() => readFileSync(marker), /ENOENT/, 'NODE_OPTIONS is cleared before Node starts');
  // a folder put first on PATH with its own cat (answering "managed policy", which passes), sleep and mktemp
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  for (const [name, body] of [['cat', 'echo \'{"source":"policy_settings"}\''], ['sleep', 'exit 0'], ['mktemp', 'exit 1'], ['dirname', 'echo /nonexistent']]) writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  assert.match(reason(run(input('local_settings', local), { PATH: `${bin}:${process.env.PATH}` })), /sets disableAllHooks/, 'the system\'s own tools come first');
  // HOME is not where the user's settings are looked for: the account record is
  const was = process.env.HOME;
  try { process.env.HOME = path.join(dir, 'Not Home'); assert.equal(settingsFileFor({ source: 'user_settings' }), path.join(os.userInfo().homedir, '.claude', 'settings.json')); } finally { process.env.HOME = was; }

  // ── fail closed ──
  // no Node, or input that is not JSON → exit 2 and the reason on stderr, which Claude Code reads as "block"
  let r = run(input('local_settings', local), { GATE_NODE: '/nonexistent/node' });
  assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /failed \(fail closed\)/);
  assert.equal(run('not json').status, 2);
  // seen live: a hook that answers after its time limit lets the change APPLY. So a check that hangs is
  // answered by the script itself, well inside the registered limit (here: a "node" that sleeps, deadline 1 s)
  const slow = path.join(dir, 'slow-node'); writeFileSync(slow, '#!/bin/sh\nsleep 20\n', { mode: 0o755 });
  writeFileSync(local, '{}');
  const t0 = Date.now();
  r = run(input('local_settings', local), { GATE_NODE: slow }, ['--deadline', '1', '--env-board', '--home', home]);
  assert.equal(r.status, 2); assert.equal(r.stdout, ''); assert.match(r.stderr, /did not answer in 1 s \(fail closed\)/);
  assert.ok(Date.now() - t0 < 5000, `answered in ${Date.now() - t0} ms`);
  // the registered limit leaves room for that deadline
  const tmpl = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'claude', 'guardrails-hooks.json.tmpl'), 'utf8'));
  const sh = readFileSync(configHook, 'utf8');
  assert.ok(tmpl.hooks.ConfigChange[0].hooks[0].timeout >= 3 * Number(/^deadline=(\d+)$/m.exec(sh)[1]));
});

// ── real repositories ───────────────────────────────────────────────────────
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const FILES = ['scripts/gate-hook.sh', 'src/gates.mjs', 'public/app.js'];
/** An origin, and a clone of it in a folder with a space: the live checkout. */
function repos() {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate integrity-')));
  const origin = path.join(base, 'origin'); const live = path.join(base, 'Live Checkout');
  for (const f of [...FILES, 'README.md']) { mkdirSync(path.dirname(path.join(origin, f)), { recursive: true }); writeFileSync(path.join(origin, f), `// ${f} v1\n`); }
  execFileSync('git', ['init', '-q', '-b', 'main', origin], { env });
  git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', 'first');
  execFileSync('git', ['clone', '-q', origin, live], { env });
  /** A change lands on the origin's default branch. → its commit */
  const land = (file, text) => { writeFileSync(path.join(origin, file), text); git(origin, 'add', '-A'); git(origin, 'commit', '-q', '-m', `change ${file}`); return git(origin, 'rev-parse', 'HEAD'); };
  const edit = (file, text) => writeFileSync(path.join(live, file), text);
  return { origin, live, land, edit, originHead: () => git(origin, 'rev-parse', 'HEAD'), liveHead: () => git(live, 'rev-parse', 'HEAD') };
}
/** The check over the live clone, with the clock and "what the remote says" in the test's hands. */
function checker(r, { remote = async () => r.originHead(), state = null } = {}) {
  let t = T0; let saved = state; let asked = 0;
  const gi = createGateIntegrity({
    root: r.live, files: () => FILES,
    git: (args) => { try { return execFileSync('git', ['-C', r.live, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } },
    readFile: (p) => readFile(path.join(r.live, p)),
    readState: async () => saved, writeState: async (s) => { saved = structuredClone(s); },
    readRemoteHead: async () => { asked += 1; return remote(); },
    now: () => t, settings: integritySettings({ mode: 'on' }),
  });
  return { gi, tick: (min) => { t += min * 60e3; }, saved: () => saved, asked: () => asked };
}

test('a live checkout: current after a clone; a changed gate file is red at once and named; a local commit does not clear it', async () => {
  const r = repos(); const c = checker(r);
  let v = await c.gi.check();
  assert.equal(v.status, 'ok'); assert.equal(v.state, 'current'); assert.equal(v.files, 3); assert.equal(v.head, r.originHead());
  assert.deepEqual(c.saved().heads.map((h) => h.sha), [r.originHead()]); assert.equal(c.saved().passedAt, r.originHead());
  // a file that is not the gate's may change freely
  r.edit('README.md', 'local notes\n');
  assert.equal((await c.gi.check()).status, 'ok');
  // one gate file edited in place
  r.edit('src/gates.mjs', '// src/gates.mjs v1\n// and one more line\n');
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.equal(v.state, 'changed'); assert.deepEqual(v.changed, ['src/gates.mjs']);
  assert.match(v.detail, /^gate files differ from [0-9a-f]{7}: src\/gates\.mjs — the files differ from what landed$/);
  // committing it locally changes nothing: that commit never landed
  git(r.live, 'add', '-A'); git(r.live, 'commit', '-q', '-m', 'local edit of the classifier');
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.deepEqual(v.changed, ['src/gates.mjs']); assert.match(v.detail, /a commit that has not landed/);
  // …nor does moving the local tracking ref onto it by hand: the board asked the remote itself, and kept the answer
  git(r.live, 'update-ref', 'refs/remotes/origin/main', r.liveHead());
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.equal(v.newest, r.originHead());
  // a gate file removed
  git(r.live, 'reset', '-q', '--hard', r.originHead());
  assert.equal((await c.gi.check()).status, 'ok');
  rmSync(path.join(r.live, 'public', 'app.js'));
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.deepEqual(v.changed, ['public/app.js']);
});

test('a landing not yet fast-forwarded here is "behind": amber, green after the fast-forward, red when it is left too long', async () => {
  const r = repos(); const c = checker(r);
  assert.equal((await c.gi.check()).status, 'ok');
  const n2 = r.land('src/gates.mjs', '// src/gates.mjs v2\n');
  // the remote is asked again only after the read interval: until then the board knows of no newer head
  c.tick(1);
  assert.equal((await c.gi.check()).state, 'current'); assert.equal(c.asked(), 1);
  c.tick(10);
  let v = await c.gi.check();
  assert.equal(c.asked(), 2);
  // the new head is not even in the local repository yet: behind, never an error
  assert.equal(v.status, 'warn'); assert.equal(v.state, 'behind'); assert.equal(v.newest, n2); assert.deepEqual(v.behind, [], 'not fetched: which files it touches is not known yet');
  assert.match(v.detail, /^a newer commit has landed and is not fetched here yet \(0 min\): fetch and fast-forward the live checkout$/);
  // fetched but not merged: now the board can say which file, and count
  git(r.live, 'fetch', '-q', 'origin');
  c.tick(5);
  v = await c.gi.check();
  assert.equal(v.status, 'warn'); assert.deepEqual(v.behind, ['src/gates.mjs']); assert.match(v.detail, /^gate files are behind by 1 commit \(5 min\)/);
  // left too long: a gate change has landed and is not running here
  c.tick(25);
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.equal(v.state, 'behind'); assert.match(v.detail, /has landed and is NOT running here: behind by 1 commit for 30 min/);
  // the fast-forward: green, and the clock is cleared
  git(r.live, 'merge', '-q', '--ff-only', 'origin/main');
  v = await c.gi.check();
  assert.equal(v.status, 'ok'); assert.equal(c.saved().behindSince, null); assert.equal(c.saved().passedAt, n2);
  // a landing that touches no gate file: amber only until it is fetched and the board can compare.
  // Then green, without a fast-forward: every gate file here is the newest landed content.
  r.land('README.md', 'docs only\n');
  await c.gi.readRemote(true);
  v = await c.gi.check();
  assert.equal(v.status, 'warn'); assert.match(v.detail, /not fetched here yet/);
  git(r.live, 'fetch', '-q', 'origin');
  v = await c.gi.check();
  assert.equal(v.status, 'ok'); assert.equal(v.state, 'current'); assert.notEqual(v.head, v.newest);
});

test('behind AND changed is red at once; a checkout moved back to an older landed commit is red; a merge just released is read at once', async () => {
  const r = repos(); const c = checker(r);
  const first = r.originHead();
  await c.gi.check();
  r.land('src/gates.mjs', '// src/gates.mjs v2\n');
  await c.gi.readRemote(true);                                      // as after the board releases a merge of its own repository
  assert.equal((await c.gi.check()).state, 'behind');
  git(r.live, 'fetch', '-q', 'origin');
  r.edit('public/app.js', '// public/app.js v1\nfetch("/elsewhere")\n');
  let v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.equal(v.state, 'changed'); assert.deepEqual(v.changed, ['public/app.js']); assert.deepEqual(v.behind, ['src/gates.mjs']);
  // put it right and fast-forward: green at the new head
  r.edit('public/app.js', '// public/app.js v1\n');
  git(r.live, 'pull', '-q', '--ff-only');
  v = await c.gi.check();
  assert.equal(v.status, 'ok'); assert.equal(c.saved().passedAt, r.originHead());
  // back to the older commit: every file equals a commit that DID land, and it is still red — a downgrade
  git(r.live, 'reset', '-q', '--hard', first);
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.equal(v.state, 'changed'); assert.deepEqual(v.changed, ['src/gates.mjs']); assert.match(v.detail, /the checkout moved back to an older commit/);
  // forward again: green
  git(r.live, 'merge', '-q', '--ff-only', 'origin/main');
  assert.equal((await c.gi.check()).status, 'ok');
});

test('the remote cannot be read: on a first start the check says so and is not red; later it goes on judging against the last answer', async () => {
  const r = repos();
  let up = false;
  const c = checker(r, { remote: async () => { if (!up) throw new Error('could not resolve host'); return r.originHead(); } });
  let v = await c.gi.check();
  assert.equal(v.status, 'unknown'); assert.equal(v.state, 'unread'); assert.match(v.detail, /the remote head has not been read \(could not resolve host\)/);
  up = true; c.tick(11);
  v = await c.gi.check();
  assert.equal(v.status, 'ok'); assert.equal(v.readError, null);
  // the network goes away again: the last answer stands, and a changed file is still seen
  up = false; c.tick(11);
  assert.equal((await c.gi.check()).status, 'ok');
  r.edit('scripts/gate-hook.sh', '#!/bin/sh\nexit 0\n');
  v = await c.gi.check();
  assert.equal(v.status, 'down'); assert.deepEqual(v.changed, ['scripts/gate-hook.sh']); assert.match(v.readError, /could not resolve host/);
  // a restart with the kept state: judged at once, before the remote answers
  const again = checker(r, { remote: async () => { throw new Error('still down'); }, state: c.saved() });
  assert.equal((await again.gi.check()).status, 'down');
  // not a git checkout at all (an install from an archive): nothing to compare, never red
  const plain = mkdtempSync(path.join(os.tmpdir(), 'gate plain-'));
  const none = createGateIntegrity({ root: plain, files: () => FILES, git: () => null, readFile: async () => { throw new Error('none'); }, readState: async () => null, writeState: async () => {}, readRemoteHead: async () => sha('a'), settings: integritySettings('on') });
  v = await none.check();
  assert.equal(v.status, 'unknown'); assert.match(v.detail, /not a git checkout/);
});

test('the settings-change hook tells its own checkout\'s board, not one the environment names; a kept commit is not asked for twice', () => {
  const none = () => { throw new Error('ENOENT'); };
  const at = (o) => boardUrl({ env: {}, args: [], root: '/b', read: none, ...o });
  assert.equal(at({}), 'http://127.0.0.1:3210');
  assert.equal(at({ read: () => 'MC_PORT=3344\n' }), 'http://127.0.0.1:3344');
  assert.equal(at({ env: { MESH_BOARD: 'http://127.0.0.1:4999' } }), null, 'another board is named: no notice at all');
  assert.equal(at({ env: { MC_PORT: '4999' } }), null);
  assert.equal(at({ env: { MESH_BOARD: 'http://localhost:3210' } }), 'http://127.0.0.1:3210');
  assert.equal(at({ env: { MESH_BOARD: 'http://127.0.0.1:4999' }, args: ['--env-board'] }), 'http://127.0.0.1:4999');
  // review finding 3: with twenty kept heads a poll asked git about each one, every time
  const src = readFileSync(path.join(ROOT, 'src', 'gate-integrity.mjs'), 'utf8');
  assert.match(src, /const has = \(sha\) => \{ if \(here\.has\(sha\)\) return true; const yes = git\(\['cat-file', '-e', `\$\{sha\}\^\{commit\}`\]\) !== null; if \(yes\) \{/);
});
