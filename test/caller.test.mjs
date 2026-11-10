// Caller evidence (src/caller.mjs, Zulu 1.3): who is calling the board, from the process that holds
// the connection — and the decision door built on it. Pure rules first (fixed lsof / ps text), then
// the real lookup against real processes on a throwaway server, then the running demo board.
// One thing these tests cannot fix in advance: whether THEY are run by an agent. So the real-process
// tests work out, with the same functions, whether an agent session is above this test process,
// and assert that the board sees exactly that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import {
  plainAddr, localAddresses, isLocalSource, parseLsof, connectionOwner, connectionSeen, parseProcTable, chainOf, workspaceInEnv,
  sessionPids, looksLikeAgent, isBrowserProcess, DEFAULT_BROWSERS, resolveChain, doorVerdict, createCallerEvidence, callerSettings,
} from '../src/caller.mjs';
import { createLedger } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { decisionSurface } from '../src/gate-ledger.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { localVerdict, sessionWorkspace } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ip = (...parts) => parts.join('.');               // other tailnet-range addresses, built here so no address literal sits in the file
const OTHER_DEVICE = ip(100, 101, 102, 104);            // another device on the tailnet (this machine is …103 in the fixtures)
const IFACES = {
  lo0: [{ address: '127.0.0.1', family: 'IPv4' }, { address: '::1', family: 'IPv6' }, { address: 'fe80::1%lo0', family: 'IPv6' }],
  en0: [{ address: '192.168.1.20', family: 'IPv4' }],
  utun4: [{ address: '100.101.102.103', family: 'IPv4' }, { address: 'fd7a:115c:a1e0::1', family: 'IPv6' }],
};

test('local means any of THIS machine\'s addresses: loopback, the mapped form, its tailnet and LAN address; only another device is remote', () => {
  const addrs = localAddresses(IFACES);
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '[::1]', '100.101.102.103', '::ffff:100.101.102.103', '192.168.1.20', 'FD7A:115C:A1E0::1', 'fe80::1%en3'])
    assert.equal(isLocalSource(a, addrs), true, a);
  // another tailnet device, another LAN device, nothing at all
  for (const a of [OTHER_DEVICE, ip(100, 64, 0, 9), '192.168.1.21', '10.0.0.5', '', null, undefined]) assert.equal(isLocalSource(a, addrs), false, String(a));
  assert.equal(plainAddr('::ffff:10.0.0.1'), '10.0.0.1'); assert.equal(plainAddr('[FE80::1%en0]'), 'fe80::1');
  assert.ok(localAddresses({}).has('127.0.0.1'));
});

const LSOF = ['p4242', 'cnode', 'f21', 'n127.0.0.1:54321->127.0.0.1:3210', 'p900', 'cnode', 'f30', 'n127.0.0.1:3210->127.0.0.1:54321',
  'p5151', 'ccurl', 'f5', 'n127.0.0.1:54321->127.0.0.1:8080', 'p6161', 'cfirefox', 'f77', 'n[::1]:60000->[::1]:3210', ''].join('\n');

test('lsof: the process on the client end of exactly this connection; the board itself and a look-alike port are skipped', () => {
  const conns = parseLsof(LSOF);
  assert.equal(conns.length, 4);
  assert.deepEqual(conns[0], { pid: 4242, command: 'node', local: { addr: '127.0.0.1', port: 54321 }, remote: { addr: '127.0.0.1', port: 3210 } });
  assert.deepEqual(conns[3].local, { addr: '::1', port: 60000 });
  const find = (q) => connectionOwner(conns, { dstPort: 3210, self: 900, ...q })?.pid ?? null;
  assert.equal(find({ srcAddr: '127.0.0.1', srcPort: 54321 }), 4242);
  assert.equal(find({ srcAddr: '::ffff:127.0.0.1', srcPort: 54321 }), 4242, 'the mapped form of the same address');
  assert.equal(find({ srcAddr: '::1', srcPort: 60000 }), 6161);
  // the same port number on another connection (pid 5151 talks to :8080) is not our caller
  assert.equal(connectionOwner(conns, { srcAddr: '127.0.0.1', srcPort: 54321, dstPort: 8080, self: 900 }).pid, 5151);
  assert.equal(find({ srcAddr: '100.101.102.103', srcPort: 54321 }), null, 'right port, wrong address');
  assert.equal(find({ srcAddr: '127.0.0.1', srcPort: 11111 }), null);
  // the board's own end of the connection is never the caller
  assert.equal(connectionOwner(conns, { srcAddr: '127.0.0.1', srcPort: 3210, dstPort: 54321, self: 900 }), null);
  assert.deepEqual(parseLsof(''), []); assert.deepEqual(parseLsof('garbage\nnnot-a-connection\n'), []);
});

// a pane: cmux → login → the login shell → the claude session → a tool shell → the caller
const PS = [
  '    1     0 Mon Jan  5 08:00:00 2026 /sbin/launchd',
  '  842     1 Mon Jan  5 08:00:10 2026 /Applications/cmux.app/Contents/MacOS/cmux',
  ' 4000   842 Mon Jan  5 09:00:00 2026 /usr/bin/login',
  ' 4001  4000 Mon Jan  5 09:00:01 2026 -/bin/zsh',
  ' 4100  4001 Mon Jan  5 09:00:05 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/claude',
  ' 4200  4100 Mon Jan  5 10:00:00 2026 /bin/zsh',
  ' 4242  4200 Mon Jan  5 10:00:01 2026 /usr/bin/curl',
  ' 4300  4200 Mon Jan  5 10:00:02 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/claude',     // a child session the agent started
  ' 4310  4300 Mon Jan  5 10:00:03 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/node',
  ' 5000     1 Mon Jan  5 10:00:04 2026 /usr/bin/curl',                                      // a background job whose shell is gone
  ' 6000     1 Mon Jan  5 08:01:00 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/node',       // the board
  ' 6010  6000 Mon Jan  5 10:00:05 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/node',       // a script the board runs
  ' 7000     1 Mon Jan  5 08:30:00 2026 /bin/sh',                                            // a launchd job
  ' 7010  7000 Mon Jan  5 08:30:01 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/claude',
  ' 8000     1 Mon Jan  5 09:30:00 2026 /Users/u/.nvm/versions/node/v22.0.0/bin/claude',     // an agent process NOT under cmux
  ' 9000     1 Mon Jan  5 09:40:00 2026 /System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
  '',
].join('\n');
const TABLE = parseProcTable(PS);
const start = (pid) => TABLE.get(pid).start;
const WS_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WS_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const SESSIONS = sessionPids({ claude: { activeSessionsByWorkspace: { [WS_A]: { sessionId: 's-a' } }, sessions: { 's-a': { sessionId: 's-a', pid: 4100, pidStartSeconds: start(4100), workspaceId: WS_A.toUpperCase() }, 's-old': { sessionId: 's-old', pid: 3999, workspaceId: WS_A } } }, codex: { sessions: { c1: { sessionId: 'c1', pid: 8800, pidStartSeconds: 5, workspaceId: WS_B } } } });

test('the process table and a chain: nearest first, up to (not including) launchd; a loop cannot hang it', () => {
  assert.equal(TABLE.size, 16);
  assert.equal(TABLE.get(4100).ppid, 4001); assert.equal(TABLE.get(4100).start, Math.round(Date.parse('Mon Jan  5 09:00:05 2026') / 1000));
  assert.deepEqual(chainOf(4242, TABLE).map((l) => l.pid), [4242, 4200, 4100, 4001, 4000, 842]);
  assert.deepEqual(chainOf(5000, TABLE).map((l) => l.pid), [5000]);
  assert.deepEqual(chainOf(99999, TABLE), []);
  const loop = new Map([[10, { ppid: 11, start: 1, comm: 'a' }], [11, { ppid: 10, start: 1, comm: 'b' }]]);
  assert.deepEqual(chainOf(10, loop).map((l) => l.pid), [10, 11]);
  assert.equal(workspaceInEnv(`/bin/node x.js HOME=/Users/u CMUX_WORKSPACE_ID=${WS_A.toUpperCase()} PATH=/bin`), WS_A);
  assert.equal(workspaceInEnv('/bin/zsh'), null); assert.equal(workspaceInEnv('x NOT_CMUX_WORKSPACE_ID=1'), null);
});

test('cmux\'s session maps: the ACTIVE Claude session of each workspace, and Codex sessions; lower-cased workspace ids', () => {
  assert.deepEqual([...SESSIONS.keys()].sort(), [4100, 8800]);
  assert.deepEqual(SESSIONS.get(4100), { workspaceId: WS_A, start: start(4100), vendor: 'claude', sessionId: 's-a' });
  assert.equal(SESSIONS.get(8800).vendor, 'codex');
  assert.deepEqual([...sessionPids({}).keys()], []);
});

test('who it is: the TOPMOST session in the chain names the caller; a child that carries another workspace id is ignored', () => {
  const env = new Map([[4100, WS_A], [4300, WS_B]]);            // the child session was started with WS_B in its environment
  const r = (pid, over = {}) => resolveChain(chainOf(pid, TABLE), { sessions: SESSIONS, envOf: (p) => env.get(p), boardPid: 6000, ...over });
  // a tool call of the session, and a call from inside the child session: both are session A
  for (const pid of [4242, 4310]) {
    const x = r(pid);
    assert.equal(x.kind, 'agent', String(pid)); assert.equal(x.workspaceId, WS_A); assert.equal(x.sessionPid, 4100); assert.equal(x.basis, 'session-map');
    assert.equal(x.agentAncestor, true); assert.equal(x.underCmux, true);
  }
  // the session map and the process's own start environment disagree: nobody is named, and it says why
  const clash = r(4242, { envOf: () => WS_B });
  assert.equal(clash.kind, 'local'); assert.equal(clash.agentAncestor, true); assert.match(clash.why, /session map says workspace .* the process environment says/);
  // the map alone names nobody: the session's own start environment must say the same workspace
  const unread = r(4242, { envOf: () => undefined });
  assert.equal(unread.kind, 'local'); assert.equal(unread.agentAncestor, true); assert.match(unread.why, /could not be read/);
  const bare = r(4242, { envOf: () => null });
  assert.equal(bare.kind, 'local'); assert.match(bare.why, /carries no workspace id/);
  // a map entry for a process that is not under the cmux app (a forged entry for a detached program): nobody
  const forged = resolveChain(chainOf(8000, TABLE), { sessions: new Map([[8000, { workspaceId: WS_B, start: start(8000), vendor: 'claude' }]]), envOf: () => WS_B, boardPid: 6000 });
  assert.equal(forged.kind, 'local'); assert.match(forged.why, /does not run under the cmux app/);
  // a recycled pid (another start time) is not that session
  const stale = new Map([[4100, { ...SESSIONS.get(4100), start: start(4100) - 600 }]]);
  const noMap = r(4242, { sessions: stale });
  assert.equal(noMap.kind, 'agent'); assert.equal(noMap.basis, 'env', 'falls back to the topmost agent process under cmux, by its start environment');
  assert.equal(noMap.workspaceId, WS_A);
});

test('who it is: no session-map entry → the topmost agent process under cmux, labelled as the weaker basis; not under cmux → nobody', () => {
  const none = new Map();
  const under = resolveChain(chainOf(4310, TABLE), { sessions: none, envOf: (p) => ({ 4100: WS_A, 4300: WS_B }[p]), boardPid: 6000 });
  assert.equal(under.kind, 'agent'); assert.equal(under.basis, 'env'); assert.equal(under.workspaceId, WS_A, 'the topmost agent process decides, not the child');
  // the topmost one has no readable workspace: a lower one is NOT used (it could carry a planted variable)
  const hidden = resolveChain(chainOf(4310, TABLE), { sessions: none, envOf: (p) => ({ 4300: WS_B }[p]), boardPid: 6000 });
  assert.equal(hidden.kind, 'local'); assert.equal(hidden.agentAncestor, true);
  // an agent process that is not under the cmux app, with a workspace id in its environment: not believed
  const loose = resolveChain(chainOf(8000, TABLE), { sessions: none, envOf: () => WS_B, boardPid: 6000 });
  assert.equal(loose.kind, 'local'); assert.equal(loose.agentAncestor, true); assert.equal(loose.underCmux, false);
});

test('who it is: a background job is nobody; the board\'s own child and a mapped launchd job are named', () => {
  const r = (pid, over = {}) => resolveChain(chainOf(pid, TABLE), { sessions: SESSIONS, envOf: () => undefined, boardPid: 6000, ...over });
  const job = r(5000);
  assert.equal(job.kind, 'local'); assert.equal(job.agentAncestor, false); assert.match(job.why, /no agent session/);
  assert.equal(r(6010).kind, 'board');
  const triage = r(7010, { jobs: new Map([[7000, 'headless:triage']]) });
  assert.equal(triage.kind, 'job'); assert.equal(triage.name, 'headless:triage');
  // the same process with no job mapped: an agent process, nobody named
  const unmapped = r(7010);
  assert.equal(unmapped.kind, 'local'); assert.equal(unmapped.agentAncestor, true);
  assert.equal(looksLikeAgent('/x/bin/claude'), true); assert.equal(looksLikeAgent('/Applications/X.app/Contents/MacOS/codex'), true);
  assert.equal(looksLikeAgent('/x/bin/claude-helper'), false); assert.equal(looksLikeAgent('/usr/bin/curl'), false);
  // the desktop apps are not sessions, and a program merely named "cmux" is not the cmux app
  assert.equal(looksLikeAgent('/Applications/Claude.app/Contents/MacOS/Claude'), false);
  const fakeCmux = PS.replace('/Applications/cmux.app/Contents/MacOS/cmux', '/tmp/x/cmux');
  const under = resolveChain(chainOf(4242, parseProcTable(fakeCmux)), { sessions: SESSIONS, envOf: () => WS_A, boardPid: 6000 });
  assert.equal(under.underCmux, false); assert.equal(under.kind, 'local', 'a session map entry under a look-alike "cmux" names nobody');
});

test('browsers: the system WebKit network process and listed app bundles; never a plain program or a look-alike folder', () => {
  const yes = ['/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
    '/System/Volumes/Preboot/Cryptexes/App/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.Networking.xpc/Contents/MacOS/com.apple.WebKit.Networking',
    '/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper',
    '/Applications/Firefox.app/Contents/MacOS/firefox', `${os.homedir()}/Applications/Arc.app/Contents/MacOS/Arc`];
  for (const p of yes) assert.equal(isBrowserProcess(p), true, p);
  const no = ['/usr/bin/curl', '/Users/u/.nvm/versions/node/v22.0.0/bin/node', 'com.apple.WebKit.Networking', '/tmp/System/Library/Frameworks/WebKit.framework/x',
    '/Applications/Google Chrome.app.evil/Contents/MacOS/x', '/Applications/Not A Browser.app/Contents/MacOS/x', '/tmp/Applications/Firefox.app/Contents/MacOS/firefox', '', null];
  for (const p of no) assert.equal(isBrowserProcess(p), false, String(p));
  assert.equal(isBrowserProcess('/Applications/Ladybird.app/Contents/MacOS/Ladybird', ['Ladybird']), true);
  assert.equal(isBrowserProcess('/Applications/Firefox.app/Contents/MacOS/firefox', ['Ladybird']), false, 'the owner\'s list replaces the built-in one');
  assert.ok(DEFAULT_BROWSERS.includes('Safari') && DEFAULT_BROWSERS.includes('cmux'));
});

test('the decision door: an agent behind the request is refused; "not a browser" is reported under "agent" and refused under "browser"; another device and a failed lookup pass', () => {
  const agent = { kind: 'agent', agentAncestor: true, browser: false };
  const loose = { kind: 'local', agentAncestor: true, browser: false };      // an agent process nobody could name
  const job = { kind: 'local', agentAncestor: false, browser: false };       // curl, a background job, a terminal
  const page = { kind: 'local', agentAncestor: false, browser: true };       // the board page in a browser
  const driven = { kind: 'local', agentAncestor: true, browser: true };      // a browser that is a child of an agent session
  const phone = { kind: 'remote', agentAncestor: false, browser: false };
  const failed = { kind: 'unknown', agentAncestor: false, browser: false };
  for (const mode of ['agent', 'browser']) {
    for (const ev of [agent, loose, driven]) { const v = doorVerdict(ev, mode); assert.equal(v.refuse, 'agent', mode); assert.match(v.msg, /an agent session is behind this request/); }
    for (const ev of [page, phone, failed]) assert.deepEqual(doorVerdict(ev, mode), { refuse: null, would: null, typed: false, msg: '' }, `${mode} ${ev.kind}`);
  }
  assert.deepEqual({ ...doorVerdict(job, 'agent'), msg: '' }, { refuse: null, would: 'not-browser', typed: false, msg: '' });
  const closed = doorVerdict(job, 'browser');
  assert.equal(closed.refuse, 'not-browser'); assert.equal(closed.typed, false); assert.match(closed.msg, /Decide on the board page/);
  for (const ev of [agent, job, page]) for (const off of [false, null, undefined, '']) assert.equal(doorVerdict(ev, off).refuse, null);
  assert.equal(doorVerdict(null, 'browser').refuse, null);
});

test('the decision door, a typed approval: kept as a row under "browser" (never decided), only reported under "agent"; an agent behind it is still refused', () => {
  const T = { typedApproval: true };
  const job = { kind: 'local', agentAncestor: false, browser: false };       // the owner's own terminal, or a detached process: the board cannot tell
  const agent = { kind: 'agent', agentAncestor: true, browser: false };
  const loose = { kind: 'local', agentAncestor: true, browser: false };
  const page = { kind: 'local', agentAncestor: false, browser: true };
  // under 'browser': not refused, not let through — kept (the server turns it into a row to confirm)
  assert.deepEqual(doorVerdict(job, 'browser', T), { refuse: null, would: null, typed: true, msg: '' });
  // under 'agent' it is decided directly, as before, and the reading says what 'browser' would do with it
  const reading = doorVerdict(job, 'agent', T);
  assert.equal(reading.refuse, null); assert.equal(reading.typed, false); assert.equal(reading.would, 'typed');
  // rule 1 comes first in both modes: an approval an agent session is behind is never kept
  for (const mode of ['agent', 'browser']) for (const ev of [agent, loose]) {
    const v = doorVerdict(ev, mode, T);
    assert.equal(v.refuse, 'agent', mode); assert.equal(v.typed, false);
  }
  // the board page, another device, a failed lookup, the door off: a real decision, nothing kept
  for (const ev of [page, { kind: 'remote', agentAncestor: false, browser: false }, { kind: 'unknown', agentAncestor: false, browser: false }])
    assert.deepEqual(doorVerdict(ev, 'browser', T), { refuse: null, would: null, typed: false, msg: '' });
  assert.equal(doorVerdict(job, false, T).typed, false);
  // anything that is not an approval of one gate is refused under 'browser', as before
  assert.equal(doorVerdict(job, 'browser', { typedApproval: false }).refuse, 'not-browser');
});

test('the decision door: a sender that has left is not a failed lookup — reported under "agent", refused under "browser"', () => {
  const gone = { kind: 'gone', agentAncestor: false, browser: false, why: 'no process holds the client end' };
  const failed = { kind: 'unknown', agentAncestor: false, browser: false };
  // it did not wait for its answer: the board page and a command line both do, so this is never the owner's click
  const reading = doorVerdict(gone, 'agent');
  assert.equal(reading.refuse, null); assert.equal(reading.would, 'gone');
  const closed = doorVerdict(gone, 'browser');
  assert.equal(closed.refuse, 'gone'); assert.equal(closed.would, null); assert.match(closed.msg, /left before the board could see who it was\. Decide on the board page\./);
  // a lookup that could not run still refuses nothing: the owner is never locked out by a slow lsof
  for (const mode of ['agent', 'browser']) assert.deepEqual(doorVerdict(failed, mode), { refuse: null, would: null, typed: false, msg: '' });
  // a typed approval from a sender that has left is never kept as a row: a command line waits for its answer
  const typedGone = doorVerdict(gone, 'browser', { typedApproval: true });
  assert.equal(typedGone.refuse, 'gone'); assert.equal(typedGone.typed, false);
  assert.equal(doorVerdict(gone, 'agent', { typedApproval: true }).would, 'gone'); assert.equal(doorVerdict(gone, 'agent', { typedApproval: true }).typed, false);
  assert.equal(doorVerdict(gone, false).refuse, null); assert.equal(doorVerdict(gone, false).would, null);
});

test('settings: absent = off; only the listed words switch anything on', () => {
  assert.deepEqual(callerSettings(undefined), { mode: 'off', tripwire: false, browsers: DEFAULT_BROWSERS, jobs: {} });
  assert.deepEqual(callerSettings(null).mode, 'off');
  const s = callerSettings({ mode: 'observe', tripwire: 'agent', jobs: { 'x.triage': 'headless:triage' }, browsers: ['Firefox'] });
  assert.deepEqual(s, { mode: 'observe', tripwire: 'agent', browsers: ['Firefox'], jobs: { 'x.triage': 'headless:triage' } });
  assert.equal(callerSettings({ tripwire: true }).tripwire, 'agent'); assert.equal(callerSettings({ tripwire: 'browser' }).tripwire, 'browser');
  for (const bad of ['on ', 'yes', 1, 'Browser']) assert.equal(callerSettings({ tripwire: bad }).tripwire, false, String(bad));
  assert.equal(callerSettings({ mode: 'enforce' }).mode, 'off'); assert.equal(callerSettings({ mode: 'on' }).mode, 'on');
});

// ── the lookup with injected runners (no real lsof / ps) ──
function fakeRun({ lsof = LSOF, ps = [PS], env = {}, launchctl = '' } = {}) {
  const calls = [];
  let psN = 0;
  const run = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'lsof') return lsof === null ? { out: '', err: new Error('timed out') } : { out: lsof, err: null };
    if (cmd === 'ps' && args[0] === '-axo') { const out = ps[Math.min(psN, ps.length - 1)]; psN += 1; return { out, err: null }; }
    if (cmd === 'ps' && args[0] === '-E') return { out: `x ${env[args[args.length - 1]] ? `CMUX_WORKSPACE_ID=${env[args[args.length - 1]]}` : ''}`, err: null };
    if (cmd === 'launchctl') return { out: launchctl, err: null };
    return { out: '', err: new Error(`unexpected ${cmd}`) };
  };
  return { run, calls };
}
const REQ = { remoteAddress: '127.0.0.1', remotePort: 54321, localPort: 3210 };
const maps = async () => ({ claude: { activeSessionsByWorkspace: { [WS_A]: { sessionId: 's-a' } }, sessions: { 's-a': { sessionId: 's-a', pid: 4100, pidStartSeconds: start(4100), workspaceId: WS_A } } } });

test('the lookup: an agent\'s call is named; another device is never looked up; a failed lookup says so and is counted', async () => {
  const f = fakeRun({ env: { 4100: WS_A } });
  const ev = createCallerEvidence({ readSessions: maps, run: f.run, boardPid: 900, interfaces: () => IFACES });
  const a = await ev.of(REQ);
  assert.equal(a.kind, 'agent'); assert.equal(a.workspaceId, WS_A); assert.equal(a.pid, 4242); assert.equal(a.exe, '/usr/bin/curl'); assert.equal(a.browser, false); assert.equal(a.agentAncestor, true);
  assert.equal(f.calls[0], 'lsof -nP -iTCP:54321 -Fpcn', 'every TCP state: a client that closed its sending half is still the caller');
  // a call this machine made to its own tailnet address: local, looked up the same way
  const lsofTail = LSOF.replace('n127.0.0.1:54321->127.0.0.1:3210', 'n100.101.102.103:54321->100.101.102.103:3210');
  const t = createCallerEvidence({ readSessions: maps, run: fakeRun({ lsof: lsofTail, env: { 4100: WS_A } }).run, boardPid: 900, interfaces: () => IFACES });
  assert.equal((await t.of({ ...REQ, remoteAddress: '100.101.102.103' })).kind, 'agent');
  // another device on the tailnet: remote, and nothing is run
  const g = fakeRun();
  const remote = await createCallerEvidence({ run: g.run, interfaces: () => IFACES }).of({ ...REQ, remoteAddress: OTHER_DEVICE });
  assert.equal(remote.kind, 'remote'); assert.deepEqual(g.calls, []);
  // lsof fails → unknown, with the reason, and counted
  const bad = createCallerEvidence({ run: fakeRun({ lsof: null }).run, interfaces: () => IFACES });
  const u = await bad.of(REQ);
  assert.equal(u.kind, 'unknown'); assert.match(u.why, /lookup failed: lsof: timed out/); assert.equal(u.agentAncestor, false);
  assert.equal(bad.stats.failed, 1); assert.equal(bad.stats.lookups, 1); assert.match(bad.stats.lastError.msg, /lsof/);
});

// ── a sender that does not wait for its answer ──
const BOARD_END = 'p900\ncnode\nn127.0.0.1:3210->127.0.0.1:54321\n';       // the board's own end of the connection, and nothing else
test('the lookup: a sender that has left is "gone" on positive evidence — never "unknown", and never "another device"', async () => {
  const mk = (o = {}) => createCallerEvidence({ boardPid: 900, interfaces: () => IFACES, ...o });
  assert.equal(connectionSeen(parseLsof(BOARD_END), { srcAddr: '127.0.0.1', srcPort: 54321, dstPort: 3210 }), true);
  assert.equal(connectionSeen(parseLsof(BOARD_END), { srcAddr: '127.0.0.1', srcPort: 11111, dstPort: 3210 }), false);
  assert.equal(connectionSeen(parseLsof(LSOF), { srcAddr: '::ffff:127.0.0.1', srcPort: 54321, dstPort: 3210 }), true);
  // the listing shows the board's end and no client end: it wrote the request and exited
  const left = mk({ run: fakeRun({ lsof: BOARD_END }).run });
  const g = await left.of(REQ);
  assert.equal(g.kind, 'gone'); assert.match(g.why, /no process holds the client end of this connection: its sender did not wait/); assert.equal(g.agentAncestor, false); assert.equal(g.browser, false);
  assert.equal(left.stats.gone, 1); assert.equal(left.stats.failed, 0, 'not a failed lookup');
  // the listing shows NEITHER end while the board's socket is still open: the listing told us nothing → a failed lookup
  const blind = mk({ run: fakeRun({ lsof: '' }).run });
  const b = await blind.of({ ...REQ, closed: () => ({ destroyed: false, ended: false }) });
  assert.equal(b.kind, 'unknown'); assert.match(b.why, /lsof did not list this connection/); assert.equal(blind.stats.failed, 1); assert.equal(blind.stats.gone, 0);
  // …but when the board's own socket saw the sender close its half, an empty listing agrees with that
  const half = await mk({ run: fakeRun({ lsof: '' }).run }).of({ ...REQ, closed: () => ({ destroyed: false, ended: true }) });
  assert.equal(half.kind, 'gone');
  // the sender reset the connection before the board looked: gone, and nothing is run
  const reset = fakeRun({ lsof: LSOF });
  const r = await mk({ run: reset.run }).of({ ...REQ, closed: () => ({ destroyed: true, ended: false }) });
  assert.equal(r.kind, 'gone'); assert.match(r.why, /closed the connection before the board could look/); assert.deepEqual(reset.calls, []);
  // …or reset it while lsof ran
  let n = 0;
  const during = await mk({ run: fakeRun({ lsof: '' }).run }).of({ ...REQ, closed: () => ({ destroyed: (n += 1) > 1, ended: false }) });
  assert.equal(during.kind, 'gone');
  // a destroyed socket reports no address at all: that is a sender that has left, never "another device"
  const none = fakeRun();
  for (const addr of [undefined, null, '']) {
    const e = await mk({ run: none.run }).of({ ...REQ, remoteAddress: addr });
    assert.equal(e.kind, 'gone', String(addr)); assert.notEqual(e.kind, 'remote');
  }
  assert.deepEqual(none.calls, []);
  // a listing that was cut short (a timeout, a missing lsof) proves nothing, whatever it printed so far
  for (const err of [Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' })]) {
    const cut = mk({ run: async (cmd) => (cmd === 'lsof' ? { out: BOARD_END, err } : { out: PS, err: null }) });
    const e = await cut.of(REQ);
    assert.equal(e.kind, 'unknown', err.message); assert.equal(cut.stats.gone, 0);
  }
  // lsof exits 1 with rows when it prints a warning: the rows count
  const warned = await mk({ readSessions: maps, run: async (cmd, args) => (cmd === 'lsof' ? { out: LSOF, err: Object.assign(new Error('Command failed'), { code: 1 }) } : fakeRun({ env: { 4100: WS_A } }).run(cmd, args)) }).of(REQ);
  assert.equal(warned.kind, 'agent');
});

test('the lookup: one budget for the whole of it — a step that hangs gives "unknown", in time for a waiting hook', async () => {
  const hang = createCallerEvidence({ run: () => new Promise(() => {}), boardPid: 900, interfaces: () => IFACES, budgetMs: 40 });
  const t0 = Date.now();
  const e = await hang.of(REQ);
  assert.equal(e.kind, 'unknown'); assert.match(e.why, /lookup failed: took longer than 40 ms/);
  assert.ok(Date.now() - t0 < 1000); assert.equal(hang.stats.failed, 1);
});

test('the lookup: a caller younger than the cached process snapshot gets a fresh one (never "unknown" for being new)', async () => {
  // the first snapshot was taken before pid 4242 existed; the second has it
  const before = PS.split('\n').filter((l) => !/^\s*4242\s/.test(l)).join('\n');
  const f = fakeRun({ ps: [before, PS], env: { 4100: WS_A } });
  const ev = createCallerEvidence({ readSessions: maps, run: f.run, boardPid: 900, interfaces: () => IFACES });
  const a = await ev.of(REQ);
  assert.equal(a.kind, 'agent'); assert.equal(a.pid, 4242);
  assert.equal(f.calls.filter((c) => c.startsWith('ps -axo')).length, 2, 'one cached read, one fresh');
  assert.equal(ev.stats.failed, 0);
  // a process that held the connection and is in no fresh snapshot exited in between: gone (it was
  // "unknown" before, which the door lets through: exiting between the two steps was a way past it)
  const gone = fakeRun({ ps: [before, before] });
  const left = createCallerEvidence({ run: gone.run, boardPid: 900, interfaces: () => IFACES });
  const u = await left.of(REQ);
  assert.equal(u.kind, 'gone'); assert.match(u.why, /pid 4242\) exited before the board could look at it/);
  assert.equal(gone.calls.filter((c) => c.startsWith('ps -axo')).length, 2, 'after exactly one fresh snapshot');
  assert.equal(left.stats.failed, 0); assert.equal(left.stats.gone, 1);
});

test('the lookup: a launchd job the owner mapped is named; the browser flag comes from the calling program\'s path', async () => {
  const lsofJob = 'p7010\ncclaude\nn127.0.0.1:54321->127.0.0.1:3210\n';
  const j = createCallerEvidence({ readSessions: async () => ({}), jobs: { 'x.triage': 'headless:triage' }, run: fakeRun({ lsof: lsofJob, launchctl: '\tstate = running\n\tpid = 7000\n' }).run, boardPid: 900, interfaces: () => IFACES });
  const a = await j.of(REQ);
  assert.equal(a.kind, 'job'); assert.equal(a.name, 'headless:triage');
  const lsofWeb = 'p9000\nccom.apple.WebKit.Networking\nn127.0.0.1:54321->127.0.0.1:3210\n';
  const w = await createCallerEvidence({ readSessions: async () => ({}), run: fakeRun({ lsof: lsofWeb }).run, boardPid: 900, interfaces: () => IFACES }).of(REQ);
  assert.equal(w.kind, 'local'); assert.equal(w.browser, true); assert.equal(w.agentAncestor, false);
  assert.equal(doorVerdict(w, 'browser').refuse, null, 'the board page in a web view passes both rules');
});

// ── against real processes: a throwaway server (never the board) and the real lsof / ps ──
const HAS_LSOF = spawnSync('sh', ['-c', 'command -v lsof'], { encoding: 'utf8' }).status === 0;
const realTable = () => parseProcTable(spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], { encoding: 'utf8', maxBuffer: 32e6 }).stdout);
/** Is an agent session above THIS test process? (true when an agent runs the suite, false in CI) */
const selfUnderAgent = () => chainOf(process.pid, realTable()).some((l) => looksLikeAgent(l.comm));
const client = (url, opts = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['-e', `fetch(${JSON.stringify(url)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(e=>process.stdout.write('ERR '+e.message))`], { stdio: ['ignore', 'pipe', 'ignore'], ...opts });
  let out = ''; p.stdout.on('data', (d) => { out += d; });
  p.on('close', () => resolve({ pid: p.pid, out }));
});

test('real processes: the board finds the calling process and sees the same ancestry this test has; a background job is nobody', { skip: !HAS_LSOF && 'lsof is not installed', timeout: 60000 }, async () => {
  const ev = createCallerEvidence({ readSessions: async () => ({}), boardPid: -1 });      // -1: this test process plays the server, not "the board"
  const server = http.createServer(async (req, res) => {
    const e = await ev.of({ remoteAddress: req.socket.remoteAddress, remotePort: req.socket.remotePort, localPort: req.socket.localPort });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(e));
  });
  await new Promise((r) => server.listen(0, '0.0.0.0', r));
  const port = server.address().port;
  try {
    const expected = selfUnderAgent();
    const a = await client(`http://127.0.0.1:${port}/`);
    const got = JSON.parse(a.out);
    assert.equal(got.pid, a.pid, 'lsof named the process that made the request');
    assert.equal(path.basename(got.exe), path.basename(process.execPath));
    assert.equal(got.agentAncestor, expected, `this suite ${expected ? 'is' : 'is not'} run by an agent, and the lookup must see that`);
    assert.notEqual(got.kind, 'unknown'); assert.equal(got.browser, false);
    // a child that claims another workspace in ITS environment changes nothing about who is above it
    const fake = JSON.parse((await client(`http://127.0.0.1:${port}/`, { env: { ...process.env, CMUX_WORKSPACE_ID: '00000000-0000-4000-8000-00000000dead' } })).out);
    assert.equal(fake.agentAncestor, expected); assert.notEqual(fake.workspaceId, '00000000-0000-4000-8000-00000000dead');
    // this machine calling its own non-loopback address is still local, and still found
    const own = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (own) {
      const b = await client(`http://${own.address}:${port}/`);
      const viaOwn = JSON.parse(b.out);
      assert.notEqual(viaOwn.kind, 'remote', 'a call to this machine\'s own address is not another device');
      assert.equal(viaOwn.pid, b.pid); assert.equal(viaOwn.agentAncestor, expected);
    }
    // an ordinary background job: its shell exits, it belongs to the init process, and no session is behind it
    const out = path.join(await mkdtemp(path.join(os.tmpdir(), 'caller bg-')), 'answer.json');
    const sh = spawn('/bin/sh', ['-c', `curl -s "http://127.0.0.1:${port}/" -o "${out}" &`], { stdio: 'ignore' });
    await new Promise((r) => sh.on('close', r));
    let raw = '';
    for (let i = 0; i < 40 && !raw; i += 1) { await new Promise((r) => setTimeout(r, 100)); raw = await readFile(out, 'utf8').catch(() => ''); }
    const bg = JSON.parse(raw);
    assert.equal(bg.agentAncestor, false, 'a background job has no session in its chain'); assert.equal(bg.kind, 'local');
    assert.equal(doorVerdict(bg, 'agent').would, 'not-browser'); assert.equal(doorVerdict(bg, 'browser').refuse, 'not-browser');
    assert.equal(ev.stats.failed, 0);
  } finally { server.close(); }
});

// ── real processes: a sender that does not wait for its answer ──
// A raw client: it writes one complete request and then does `after` (a line of JavaScript; `s` is
// the socket). The throwaway server looks the caller up exactly as the board does — the peer taken
// when the request arrives, the lookup after the body, the server's own socket state on hand.
const rawClient = (port, tag, after, { halfOpen = false } = {}) => new Promise((resolve) => {
  const req = `POST /x HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nx-tag: ${tag}\\r\\nContent-Type: application/json\\r\\nContent-Length: 2\\r\\n\\r\\n{}`;
  const code = `const s=require('net').connect({port:${port},host:'127.0.0.1',allowHalfOpen:${halfOpen}},()=>{${after.replace('REQ', `"${req}"`)}});s.on('data',()=>{});s.on('error',()=>{});setTimeout(()=>process.exit(0),2500)`;
  const p = spawn(process.execPath, ['-e', code], { stdio: 'ignore' });
  p.on('close', () => resolve(p.pid));
});

test('real processes: a sender that writes its request and leaves is "gone", whichever way it leaves — never a failed lookup the door lets through', { skip: !HAS_LSOF && 'lsof is not installed', timeout: 90000 }, async () => {
  const ev = createCallerEvidence({ readSessions: async () => ({}), boardPid: -1 });
  const seen = new Map();
  const server = http.createServer(async (req, res) => {
    const peer = { address: req.socket.remoteAddress, port: req.socket.remotePort, localPort: req.socket.localPort };
    let body = ''; for await (const c of req) body += c;                     // the board reads the body first, too
    const e = await ev.of({ remoteAddress: peer.address, remotePort: peer.port, localPort: peer.localPort, closed: () => ({ destroyed: req.socket.destroyed, ended: req.socket.readableEnded }) });
    seen.set(req.headers['x-tag'], e);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const until = async (tag) => { for (let i = 0; i < 60 && !seen.has(tag); i += 1) await new Promise((r) => setTimeout(r, 100)); return seen.get(tag); };
  try {
    const expected = selfUnderAgent();
    // the ways of not waiting: exit at once; reset the connection (and stay alive); reset it a moment
    // later; exit while the board is still looking (between its two steps)
    const leavers = {
      'exit at once': 's.write(REQ,()=>process.exit(0))',
      'reset at once': 's.write(REQ,()=>s.resetAndDestroy())',
      'reset after 20 ms': 's.write(REQ,()=>setTimeout(()=>s.resetAndDestroy(),20))',
      'exit after 60 ms': 's.write(REQ,()=>setTimeout(()=>process.exit(0),60))',
    };
    for (const [tag, after] of Object.entries(leavers)) {
      await rawClient(port, tag, after);
      const e = await until(tag);
      assert.ok(e, `${tag}: the request was still handled (which is why the door must judge it)`);
      // whoever runs this suite, and however the timing fell: it is never "unknown", and never let through as one
      assert.notEqual(e.kind, 'unknown', `${tag}: ${e.why}`); assert.notEqual(e.kind, 'remote', tag);
      if (e.kind === 'gone') {
        assert.equal(doorVerdict(e, 'agent').would, 'gone', tag); assert.equal(doorVerdict(e, 'agent').refuse, null, tag);
        assert.equal(doorVerdict(e, 'browser').refuse, 'gone', tag);
      } else {
        // the board looked while the process was still there (only the slow leavers can be caught so): judged as the process it is
        assert.ok(/after/.test(tag), `${tag} resolved to ${e.kind}`);
        assert.equal(e.agentAncestor, expected, tag);
        assert.ok(doorVerdict(e, 'browser').refuse, `${tag}: refused under 'browser' either way`);
      }
    }
    for (const tag of ['exit at once', 'reset at once']) assert.equal(seen.get(tag).kind, 'gone', tag);
    // a client that closes only its sending half and stays: found and judged as its process when it
    // still holds its end, else gone (the server closes the connection once the sender closes its half)
    const pid = await rawClient(port, 'half-close', 's.end(REQ)', { halfOpen: true });
    const h = await until('half-close');
    assert.ok(h); assert.notEqual(h.kind, 'unknown', h.why);
    if (h.kind === 'gone') assert.equal(doorVerdict(h, 'browser').refuse, 'gone');
    else { assert.equal(h.pid, pid); assert.equal(h.agentAncestor, expected); assert.ok(doorVerdict(h, 'browser').refuse); }
    // and the control: a client that waits for its answer is found, as before
    const c = await client(`http://127.0.0.1:${port}/`);
    assert.equal(seen.get(undefined).pid, c.pid); assert.equal(seen.get(undefined).agentAncestor, expected);
    assert.equal(ev.stats.failed, 0, 'none of these was a failed lookup');
    assert.ok(ev.stats.gone >= 2);
  } finally { server.close(); }
});

// ── the gate service: observe mode records who really asked, next to the declared identity ──
test('gate check, observe: a held call records the caller the board worked out; a plain pass never looks it up', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caller gates-'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const ledger = createLedger(path.join(dir, 'tasks'));
  const events = [];
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder', W2: 'helper' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', git: () => null, isPrivateRepo: async () => null, prInfo: async () => null,
    recordEvent: async (k, t) => { events.push(t); } });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const input = (command) => ({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const lines = async () => (await readFile(path.join(dir, 'guardrails', 'checks.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  let asked = 0;
  const same = async () => { asked += 1; return { kind: 'agent', name: 'builder', workspaceId: 'W1', basis: 'session-map' }; };
  // not gated: passed, and the lookup was never made
  assert.equal((await svc.check(input('git status'), { evidence: same })).decision, 'pass');
  assert.equal(asked, 0);
  // a 1.3 check in observe (a renamed program): the call passes as before, and its reading names the caller
  assert.deepEqual(await svc.check(input('./mygh pr merge 7'), { evidence: same }), { decision: 'pass' });
  assert.equal(asked, 1);
  let last = (await lines()).pop();
  assert.equal(last.wouldHold, 'renamedBins'); assert.equal(last.decision, 'pass'); assert.equal(last.caller, 'builder');
  // held: the caller is recorded, and it matches the declared identity
  assert.equal((await svc.check(input('gh pr merge 7'), { evidence: same })).decision, 'deny');
  assert.equal(asked, 2);
  last = (await lines()).pop();
  assert.equal(last.agent, 'builder'); assert.equal(last.caller, 'builder'); assert.equal(last.callerBasis, 'session-map'); assert.equal(last.callerMismatch, undefined);
  // the hook declared one agent, the process belongs to another: recorded and on the ticker; the ANSWER is unchanged
  const other = async () => ({ kind: 'agent', name: 'helper', workspaceId: 'W2', basis: 'session-map' });
  assert.equal((await svc.check(input('gh pr merge 7'), { evidence: other })).decision, 'deny');
  last = (await lines()).pop();
  assert.equal(last.agent, 'builder'); assert.equal(last.caller, 'helper'); assert.equal(last.callerMismatch, true);
  assert.ok(events.some((e) => /\[caller mismatch\] gate check: the hook declared builder, but the call came from helper's session/.test(e)));
  // no session behind it, a failed lookup, evidence switched off: recorded as what it is, never a mismatch
  for (const [ev, caller] of [[{ kind: 'local', agentAncestor: false }, 'local'], [{ kind: 'unknown' }, 'unknown'], [{ kind: 'job', name: 'headless:triage' }, 'headless:triage']]) {
    await svc.check(input('gh pr merge 7'), { evidence: async () => ev });
    last = (await lines()).pop();
    assert.equal(last.caller, caller); assert.equal(last.callerMismatch, undefined);
  }
  await svc.check(input('gh pr merge 7'));
  assert.equal((await lines()).pop().caller, undefined);
  await svc.check(input('gh pr merge 7'), { evidence: async () => { throw new Error('lsof exploded'); } });
  assert.equal((await lines()).pop().decision, 'deny', 'a lookup that throws never changes the answer');
});

test('gate check: the caller note has one time limit — a lookup that hangs costs the log line its caller, never the hook its answer', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'caller note-'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const ledger = createLedger(path.join(dir, 'tasks'));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', git: () => null, isPrivateRepo: async () => null, prInfo: async () => null });
  const task = await ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const input = (command, extra = {}) => ({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const last = async () => JSON.parse((await readFile(path.join(dir, 'guardrails', 'checks.jsonl'), 'utf8')).trim().split('\n').pop());
  // the hold is filed first; the lookup never answers; the check still does, well inside the hook's wait
  const t0 = Date.now();
  const r = await svc.check(input('gh pr merge 7'), { evidence: () => new Promise(() => {}), noteBudgetMs: 40 });
  assert.equal(r.decision, 'deny'); assert.ok(r.gate, 'the hold was filed'); assert.ok(Date.now() - t0 < 1500);
  const line = await last();
  assert.match(line.callerNotRead, /the lookup took longer than 40 ms/); assert.equal(line.caller, undefined);
  assert.equal(svc.callerReadings().notRead, 1);
  // a reading for Mission Control: the hook declared a registered agent and the board saw no agent behind the call
  assert.equal(svc.callerReadings().noAgentSeen, 0);
  for (const ev of [{ kind: 'local', agentAncestor: false, why: 'no agent session in the process chain' }, { kind: 'unknown', why: 'lookup failed: lsof: timed out' }, { kind: 'gone', why: 'no process holds the client end' }])
    await svc.check(input('gh pr merge 7'), { evidence: async () => ev });
  let seen = svc.callerReadings();
  assert.equal(seen.noAgentSeen, 3); assert.equal(seen.lastNoAgentSeen.declared, 'builder'); assert.equal(seen.lastNoAgentSeen.kind, 'gone'); assert.match(seen.lastNoAgentSeen.why, /no process holds/);
  // not counted: an agent was seen (the right one or another), or the hook declared nobody registered
  await svc.check(input('gh pr merge 7'), { evidence: async () => ({ kind: 'agent', name: 'builder', workspaceId: 'W1', basis: 'session-map' }) });
  await svc.check(input('gh pr merge 7'), { evidence: async () => ({ kind: 'agent', name: 'helper', workspaceId: 'W2', basis: 'session-map' }) });
  await svc.check(input('gh pr merge 9', { workspaceId: 'W-none' }), { evidence: async () => ({ kind: 'local', agentAncestor: false, why: 'x' }) });
  seen = svc.callerReadings();
  assert.equal(seen.noAgentSeen, 3);
});

test('the receipt label: this machine\'s own tailnet address is not "the phone"', () => {
  assert.deepEqual(decisionSurface({ remote: OTHER_DEVICE, client: 'strip' }), { surface: 'phone', surfaces: ['phone', 'strip'] });
  assert.deepEqual(decisionSurface({ remote: '100.101.102.103', client: 'strip', local: true }), { surface: 'strip', surfaces: ['strip'] });
  assert.deepEqual(decisionSurface({ remote: '::ffff:100.101.102.103', local: true }), { surface: 'board', surfaces: ['board'] });
  assert.deepEqual(decisionSurface({ via: 'cli', remote: OTHER_DEVICE }), { surface: 'cli', surfaces: ['cli'] });
});

// ── the hook with the board down: the session it really runs under, not the id its environment carries ──
test('board down: the hook reads its session from the agent process above it; a child with an observed agent\'s id is still enforced', () => {
  const run = (cmd, args) => {
    if (args[0] === '-axo') return PS;
    return `claude --name x CMUX_WORKSPACE_ID=${{ 4100: 'W-P', 4300: 'W-O' }[args[args.length - 1]] || ''} HOME=/Users/u`;
  };
  // the hook of the outer session, and the hook of the child session: both resolve to the OUTER session's workspace
  assert.deepEqual(sessionWorkspace({ pid: 4242, run }), { found: true, ws: 'w-p' });
  assert.deepEqual(sessionWorkspace({ pid: 4310, run }), { found: true, ws: 'w-p' });
  // no agent process above (a plain shell): not found, so the caller falls back to the declared id
  assert.deepEqual(sessionWorkspace({ pid: 5000, run }), { found: false, ws: null });
  assert.deepEqual(sessionWorkspace({ pid: 4242, run: () => { throw new Error('ps failed'); } }), { found: false, ws: null });
  const root = mkdtempSync(path.join(os.tmpdir(), 'caller hook-'));
  writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ ...DEFAULT_POLICY, enforceFor: ['pilot'] }));
  mkdirSync(path.join(root, 'config'), { recursive: true });
  writeFileSync(path.join(root, 'config', 'agents.json'), JSON.stringify({ agents: [{ name: 'pilot', workspaceId: 'W-P' }, { name: 'other', workspaceId: 'W-O' }] }));
  const v = (declared, opts = {}) => localVerdict({ tool: 'Bash', command: 'gh pr merge 1', cwd: '/w', workspaceId: declared }, { root, ...opts }).verdict;
  // as before 1.3: the declared id alone — claiming the observed agent's workspace is enough to pass
  assert.equal(v('W-O'), 'clear');
  // now: the session is the enforced pilot, whatever id the hook's environment carries
  assert.equal(v('W-O', { sessionWs: 'w-p' }), 'gate');
  assert.equal(v('W-P', { sessionWs: 'w-o' }), 'clear', 'and an observed agent stays observed');
  assert.equal(v('W-O', { sessionWs: null }), 'gate', 'a session whose workspace cannot be read is unknown, so enforced');
});

// ── the running demo board with the door switched on (MC_DEMO_CALLER=1) ──
test('a running board: an owner decision made from this test process is refused exactly when an agent runs the suite; other writes are untouched', { skip: !HAS_LSOF && 'lsof is not installed', timeout: 60000 }, async () => {
  const port = 39600 + Math.floor(Math.random() * 90);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, MC_DEMO: '1', MC_DEMO_POLL: '1', MC_DEMO_CALLER: 'observe,agent', MC_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const J = { 'content-type': 'application/json' };
  try {
    let status = null;
    for (let i = 0; i < 100 && !status; i += 1) { await new Promise((r) => setTimeout(r, 150)); status = await fetch(`${base}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null); }
    assert.ok(status?.demo, 'demo board answered');
    assert.equal(status.caller.mode, 'observe'); assert.equal(status.caller.tripwire, 'agent');
    const token = /<meta name="mesh-decision" content="([0-9a-f]+)"/.exec(await (await fetch(`${base}/`)).text())[1];
    const label = status.jobs.find((j) => !/^(disk|mem|cmux|repo|release|guardrails|brain|relay|update|backup|ops|github)[:]?|^[\w-]+:/.test(j.label))?.label || status.jobs[0].label;
    const agentRunsThis = selfUnderAgent();
    // a card action with the owner's token, sent by this process (not a browser)
    const act = await fetch(`${base}/api/action`, { method: 'POST', headers: { ...J, 'x-mesh-decision': token }, body: JSON.stringify({ action: 'kickstart', label }) });
    const body = await act.json();
    if (agentRunsThis) {
      assert.equal(act.status, 403, JSON.stringify(body)); assert.match(body.msg, /an agent session is behind this request/);
    } else {
      assert.equal(act.status, 200, JSON.stringify(body)); assert.match(body.msg, /demo: would kickstart/);
    }
    // the same for a ledger decision: the door answers before the token is even looked at
    const { agents } = await (await fetch(`${base}/api/agents`)).json();
    const worker = agents.find((a) => a.kind !== 'mission-control' && a.status !== 'closed');
    const mc = agents.find((a) => a.kind === 'mission-control');
    const created = await fetch(`${base}/api/tasks`, { method: 'POST', headers: J, body: JSON.stringify({ title: 'door check', requester: mc.name, owner: worker.name }) });
    assert.equal(created.status, 201, 'a plain ledger write is not a decision: untouched');
    const id = (await created.json()).task.id;
    for (const op of ['claim', 'start']) assert.equal((await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ op, actor: worker.name }) })).status, 200);
    assert.equal((await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ op: 'request_approval', actor: worker.name, policy_item: 'outward writes' }) })).status, 200);
    const wrongToken = await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: { ...J, 'x-mesh-decision': 'f'.repeat(48) }, body: JSON.stringify({ op: 'decide', decision: 'approve' }) });
    assert.equal(wrongToken.status, 403);
    assert.match((await wrongToken.json()).msg, agentRunsThis ? /an agent session is behind this request/ : /decision token rejected/);
    const decide = await fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: { ...J, 'x-mesh-decision': token }, body: JSON.stringify({ op: 'decide', decision: 'approve' }) });
    assert.equal(decide.status, agentRunsThis ? 403 : 200);
    // the board's own count says what it did
    const after = (await (await fetch(`${base}/api/status`)).json()).caller;
    if (agentRunsThis) { assert.equal(after.refusedAgent, 3); assert.equal(after.wouldRefuse, 0); }
    else { assert.equal(after.refusedAgent, 0); assert.equal(after.wouldRefuse, 3, 'not a browser: reported, not refused, under tripwire "agent"'); }
    assert.equal(after.failed, 0); assert.ok(after.lookups >= 3);
  } finally { child.kill(); }
});

// A client that writes one complete request to the board and exits without waiting for the answer.
const leave = (port, pathname, token, body) => new Promise((resolve) => {
  const payload = JSON.stringify(body);
  const req = `PATCH ${pathname} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nx-mesh-decision: ${token}\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
  const p = spawn(process.execPath, ['-e', `const s=require('net').connect(${port},'127.0.0.1',()=>s.write(${JSON.stringify(req)},()=>process.exit(0)))`], { stdio: 'ignore' });
  p.on('close', resolve);
});
async function demoBoard(switches, portBase) {
  const port = portBase + Math.floor(Math.random() * 40);
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, MC_DEMO: '1', MC_DEMO_POLL: '1', MC_DEMO_CALLER: switches, MC_PORT: String(port) }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  const J = { 'content-type': 'application/json' };
  let status = null;
  for (let i = 0; i < 100 && !status; i += 1) { await new Promise((r) => setTimeout(r, 150)); status = await fetch(`${base}/api/status`).then((r) => (r.ok ? r.json() : null)).catch(() => null); }
  assert.ok(status?.demo, 'demo board answered');
  const token = /<meta name="mesh-decision" content="([0-9a-f]+)"/.exec(await (await fetch(`${base}/`)).text())[1];
  const { agents } = await (await fetch(`${base}/api/agents`)).json();
  const worker = agents.find((a) => a.kind !== 'mission-control' && a.status !== 'closed');
  const mc = agents.find((a) => a.kind === 'mission-control');
  const patch = (id, body) => fetch(`${base}/api/tasks/${id}`, { method: 'PATCH', headers: J, body: JSON.stringify(body) });
  /** A task of the worker's that waits on the owner for an approval. → its id */
  const asking = async () => {
    const id = (await (await fetch(`${base}/api/tasks`, { method: 'POST', headers: J, body: JSON.stringify({ title: 'door check', requester: mc.name, owner: worker.name }) })).json()).task.id;
    for (const body of [{ op: 'claim', actor: worker.name }, { op: 'start', actor: worker.name }, { op: 'request_approval', actor: worker.name, policy_item: 'outward writes' }]) assert.equal((await patch(id, body)).status, 200, body.op);
    return id;
  };
  const task = async (id) => (await fetch(`${base}/api/tasks/${id}`)).json();
  const caller = async () => (await (await fetch(`${base}/api/status`)).json()).caller;
  return { child, port, base, status, token, worker, mc, patch, asking, task, caller };
}

test('a running board: a decision from a sender that left is refused under "browser"; under "agent" it passes — and is logged, counted and reported as such', { skip: !HAS_LSOF && 'lsof is not installed', timeout: 90000 }, async () => {
  // door at 'browser': the request is handled, and refused — the approval stays undecided
  const strict = await demoBoard('observe,browser', 39650);
  try {
    assert.equal(strict.status.caller.tripwire, 'browser');
    const id = await strict.asking();
    await leave(strict.port, `/api/tasks/${id}`, strict.token, { op: 'decide', decision: 'approve' });
    let c = null;
    for (let i = 0; i < 50 && !(c?.refusedGone); i += 1) { await new Promise((r) => setTimeout(r, 100)); c = await strict.caller(); }
    assert.equal(c.refusedGone, 1, 'the board saw the request and refused it'); assert.equal(c.passedNoEvidence, 0); assert.equal(c.failed, 0);
    const t = await strict.task(id);
    assert.equal(t.status, 'needs_approval'); assert.equal(t.approval.decision, null, 'nothing was decided');
  } finally { strict.child.kill(); }
  // door at 'agent' (the shipped setting): nothing can be seen of the sender, so it passes, as a
  // detached command does — but never silently: a would-refuse reading, a line of its own, a count
  const loose = await demoBoard('observe,agent', 39655);
  try {
    assert.equal(loose.status.caller.tripwire, 'agent');
    const id = await loose.asking();
    await leave(loose.port, `/api/tasks/${id}`, loose.token, { op: 'decide', decision: 'approve' });
    let c = null;
    for (let i = 0; i < 50 && !(c?.passedNoEvidence); i += 1) { await new Promise((r) => setTimeout(r, 100)); c = await loose.caller(); }
    assert.equal(c.passedNoEvidence, 1); assert.equal(c.lastNoEvidence.kind, 'gone'); assert.match(c.lastNoEvidence.what, new RegExp(`^task #${id} approve`)); assert.match(c.lastNoEvidence.why, /did not wait for the answer|closed the connection|exited before/);
    assert.equal(c.refusedGone, 0); assert.ok(c.wouldRefuse >= 1, 'counted with what "browser" would refuse'); assert.equal(c.failed, 0); assert.ok(c.gone >= 1);
    let t = null;
    for (let i = 0; i < 30 && t?.approval?.decision !== 'approve'; i += 1) { await new Promise((r) => setTimeout(r, 100)); t = await loose.task(id); }
    assert.equal(t.approval.decision, 'approve', 'the stated limit of "agent": a sender nobody can look at is not refused');
  } finally { loose.child.kill(); }
});

test('a running board, observe: a short-lived command-line caller is looked up BEFORE it gets its answer, so it is still there to be seen', { skip: !HAS_LSOF && 'lsof is not installed', timeout: 60000 }, async () => {
  const b = await demoBoard('observe,agent', 39560);
  try {
    assert.equal(b.status.caller.mode, 'observe');
    const id = await b.asking();
    const before = await b.caller();
    // the shape of the ledger command line: one request, and the process exits the moment it has the answer
    const code = `fetch('${b.base}/api/tasks/${id}',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({op:'comment',actor:'${b.worker.name}',text:'from a short-lived process'})}).then(r=>r.json()).then(j=>process.stdout.write(String(j.ok)))`;
    for (let i = 0; i < 3; i += 1) {
      const out = await new Promise((resolve) => { const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] }); let o = ''; p.stdout.on('data', (d) => { o += d; }); p.on('close', () => resolve(o)); });
      assert.equal(out, 'true');
    }
    const after = await b.caller();
    // each of the three was seen while it waited: counted as a name the process does not back (this
    // test process is not that agent), never as a sender that had left, never as a failed lookup
    assert.equal(after.mismatches - before.mismatches, 3);
    assert.equal(after.gone, before.gone, 'none of them had left when the board looked');
    assert.equal(after.failed, 0);
    assert.equal(after.lastMismatch.declared, b.worker.name); assert.match(after.lastMismatch.what, new RegExp(`^task #${id} comment`));
    assert.notEqual(after.lastMismatch.caller, 'a sender that has left');
  } finally { b.child.kill(); }
});

test('the server wires it in: the door stands before the token check, names are noted where they are declared, a demo board stays out of it', () => {
  const src = readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  // the four owner-only doors
  assert.match(src, /if \(deciding\) typed = \(await decisionDoor\(req,[^\n]*\n\s*\{ typedApproval: b\.op === 'gate_decide' && b\.decision === 'approve' \}\)\)\.typed;\n\s*const decider = !intake && deciding && isDecider\(req\);/);
  assert.match(src, /await decisionDoor\(req, `attention \$\{op\}`\);\n\s*const no = snoozeRefusal/);
  assert.match(src, /await decisionDoor\(req, 'an upgrade'\);/);
  assert.match(src, /await decisionDoor\(req, `card action /);
  // a declared name is noted (observe) at each place one is resolved, without holding the request
  // …and BEFORE the answer goes out: a command-line caller exits the moment it has its answer
  assert.equal((src.match(/await noteCaller\(req, me\.name, /g) || []).length, 5);
  assert.equal((src.match(/(?<!function )noteCaller\(req, /g) || []).length, 5, 'no call that is not awaited');
  assert.match(src, /async function noteCaller\(req, declared, what\) \{\n\s*if \(CALLER\.mode !== 'observe'\) return;[^\n]*\n\s*try \{\n\s*const ev = await evidenceOf\(req\);/);
  // the peer is captured when the request arrives, and the lookup can ask the board's own socket whether the sender left
  assert.match(src, /if \(!allowedSource\(req\)\) \{ res\.writeHead\(403\); return res\.end\('forbidden'\); \}\n[^\n]*\n[^\n]*\n\s*req\.peer = \{ address: req\.socket\.remoteAddress, port: req\.socket\.remotePort, localPort: req\.socket\.localPort \};/);
  assert.match(src, /closed: \(\) => \(\{ destroyed: req\.socket\.destroyed, ended: req\.socket\.readableEnded \}\)/);
  // a decision that passes the door with no evidence of its sender is logged, put on the ticker and counted, one by one
  assert.match(src, /\[door\] passed WITHOUT evidence of its sender \(\$\{ev\.kind\}\)/);
  assert.match(src, /callerStats\.passedNoEvidence \+= 1;/);
  // every door line says what kind of caller the board saw, and why
  assert.match(src, /const from = `\$\{path\.basename\(ev\?\.exe \|\| '\?'\)\} pid \$\{ev\?\.pid \?\? '\?'\} \[\$\{ev\?\.kind \?\? 'none'\}: /);
  // …and checked (mode 'on') at the same five places, before the request is answered
  assert.equal((src.match(/await nameCheck\(req, /g) || []).length, 5);
  assert.match(src, /async function nameCheck\(req, name, what[^\n]*\n\s*if \(CALLER\.mode !== 'on'\) return \{ proven: true, why: '' \};/);
  assert.match(src, /gates\.check\(await readBody\(req\), \{ evidence: CALLER\.mode === 'off' \? null : \(\) => evidenceOf\(req\), names: CALLER\.mode === 'on' \}\)/);
  // the suites are run by agents: a demo board looks at its callers only when a test asks it to
  assert.match(src, /callerSettings\(DEMO \? demoCaller\(process\.env\.MC_DEMO_CALLER\) : SETTINGS\.callerEvidence\)/);
  assert.match(src, /const demoCaller = \(v\) => \(!v \? null : /);
  assert.match(src, /local: sameMachine \}\)/);
});
