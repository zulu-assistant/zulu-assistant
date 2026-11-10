// Caller evidence (Zulu 1.3): WHO is calling the board, worked out from the process that holds
// the connection — never from a name, a flag or an environment variable the caller sends.
//
//   1. which process   the client's source port → `lsof` → the pid that owns that connection
//   2. its ancestry    one `ps` snapshot → the chain of parents up to launchd
//   3. the session     the TOPMOST process in that chain that is an agent session: listed in cmux's
//                      own session map (pid + start time), cross-checked against that process's
//                      start environment. Topmost matters: a child started with another workspace
//                      id in ITS environment sits lower in the chain and is ignored.
//   4. the name        workspace id → the mesh directory (the caller of this module does that)
//
// What it proves and what it does not (docs/SECURITY-MODEL.md): an agent cannot change its own
// running session's start environment, make a child count as another session, or gain a name by
// detaching. A process with no session in its chain (a detached job, a plain terminal, a browser)
// resolves to nobody: `local`. That proves nothing about being the owner.
//
// Measured on macOS 26: `ps -E` shows the start environment of node and codex processes and hides
// it for system programs (zsh, sh, login, curl), so the session process is the anchor — not the
// pane's login shell. A background job (`cmd &` after its shell exits) has NO session in its chain.
//
// A sender that does not wait for its answer (it wrote the request and exited, or reset the
// connection) leaves nothing to look at. That is its own kind, `gone`. It needs positive evidence:
// the listing shows the board's own end of the connection and no client end, or the board's own
// socket saw the sender close. It is not `unknown`, which means the lookup could not run (lsof
// missing, a timeout, a listing that does not even show the board's own end, an unreadable process
// table). The difference matters at the decision door: `unknown` must never lock the owner out,
// while `gone` is something a browser or a command line that waits for its answer never is.
//
// Everything here is pure except createCallerEvidence, which takes its runners as arguments.
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

// ── addresses ───────────────────────────────────────────────────────────────
/** '::ffff:127.0.0.1' → '127.0.0.1'; '[::1]' → '::1'; 'fe80::1%en0' → 'fe80::1'. */
export function plainAddr(a) {
  return String(a || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').replace(/%.*$/, '');
}

/** Every address of this machine's interfaces (read fresh: a tailnet address can change). */
export function localAddresses(ifaces = os.networkInterfaces()) {
  const out = new Set(['127.0.0.1', '::1']);
  for (const list of Object.values(ifaces || {})) for (const i of list || []) if (i?.address) out.add(plainAddr(i.address));
  return out;
}

/**
 * Did this request come from THIS machine? A call the machine makes to its own tailnet or LAN
 * address arrives with that address as its source, not loopback — so "not loopback" must never
 * be read as "another device". Only an address no local interface has is remote.
 */
export function isLocalSource(addr, addrs = localAddresses()) {
  const a = plainAddr(addr);
  return Boolean(a) && addrs.has(a);
}

// ── lsof ────────────────────────────────────────────────────────────────────
const splitHostPort = (s) => { const m = /^(.*):(\d+)$/.exec(String(s || '')); return m ? { addr: plainAddr(m[1]), port: Number(m[2]) } : null; };

/**
 * Parse `lsof -nP -iTCP:<port> -Fpcn` (every TCP state: a client that has closed its sending half
 * is no longer ESTABLISHED, and it is still the caller). A listening socket has no "->" and is skipped.
 * → [{ pid, command, local: { addr, port }, remote: { addr, port } }] — one per connection end.
 */
export function parseLsof(text) {
  const out = [];
  let pid = null; let command = '';
  for (const line of String(text || '').split('\n')) {
    const tag = line[0]; const v = line.slice(1);
    if (tag === 'p') { pid = Number(v); command = ''; }
    else if (tag === 'c') command = v;
    else if (tag === 'n' && pid) {
      const [l, r] = v.split('->');
      const local = splitHostPort(l); const remote = splitHostPort(r);
      if (local && remote) out.push({ pid, command, local, remote });
    }
  }
  return out;
}

/**
 * The process on the CLIENT end of exactly this connection: its local end is the request's source
 * address and port, its remote end is the board's port. Matching the whole pair keeps an unrelated
 * local connection that happens to use the same port number out of it. The board itself is skipped.
 */
export function connectionOwner(conns, { srcAddr, srcPort, dstPort, self = process.pid }) {
  const want = plainAddr(srcAddr);
  return conns.find((c) => c.pid !== self && c.local.port === Number(srcPort) && c.remote.port === Number(dstPort) && c.local.addr === want) || null;
}

/**
 * Did the listing cover THIS connection at all? The server end of it (whoever holds it: the board)
 * must be in there. With it present and no client end, the sender has gone; without it the listing
 * told us nothing, and the lookup failed.
 */
export function connectionSeen(conns, { srcAddr, srcPort, dstPort }) {
  const want = plainAddr(srcAddr);
  return conns.some((c) => c.local.port === Number(dstPort) && c.remote.port === Number(srcPort) && c.remote.addr === want);
}

// ── the process table ───────────────────────────────────────────────────────
/** Parse `ps -axo pid=,ppid=,lstart=,comm=` → Map pid → { ppid, start (epoch seconds, local), comm (full path) }. */
export function parseProcTable(text) {
  const m = new Map();
  for (const line of String(text || '').split('\n')) {
    const x = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/.exec(line);
    if (!x) continue;
    const t = Date.parse(x[3]);
    m.set(Number(x[1]), { ppid: Number(x[2]), start: Number.isNaN(t) ? null : Math.round(t / 1000), comm: x[4].trim() });
  }
  return m;
}

/** pid → its chain, nearest first (the process itself, its parent, …), stopping before launchd. */
export function chainOf(pid, table, max = 40) {
  const chain = []; const seen = new Set();
  let p = Number(pid);
  while (p > 1 && table.has(p) && !seen.has(p) && chain.length < max) {
    seen.add(p);
    chain.push({ pid: p, ...table.get(p) });
    p = table.get(p).ppid;
  }
  return chain;
}

/** `ps -E -o command= -p <pid>` → the workspace id in that process's START environment, or null. */
export function workspaceInEnv(psEnvText) {
  const m = /(?:^|\s)CMUX_WORKSPACE_ID=([^\s]+)/.exec(String(psEnvText || ''));
  return m ? m[1].toLowerCase() : null;
}

// ── cmux's session maps ─────────────────────────────────────────────────────
/**
 * The sessions cmux knows, from its two hook files → Map pid → { workspaceId, start, vendor, sessionId }.
 * For Claude only the ACTIVE session of each workspace counts (an older entry may linger).
 */
export function sessionPids({ claude = {}, codex = {} } = {}) {
  const m = new Map();
  const active = new Set(Object.values(claude.activeSessionsByWorkspace || {}).map((x) => x?.sessionId).filter(Boolean));
  for (const s of Object.values(claude.sessions || {})) {
    if (!s?.pid || !s.workspaceId || (active.size && !active.has(s.sessionId))) continue;
    m.set(Number(s.pid), { workspaceId: String(s.workspaceId).toLowerCase(), start: s.pidStartSeconds || null, vendor: 'claude', sessionId: s.sessionId || null });
  }
  for (const s of Object.values(codex.sessions || {})) {
    if (!s?.pid || !s.workspaceId) continue;
    m.set(Number(s.pid), { workspaceId: String(s.workspaceId).toLowerCase(), start: s.pidStartSeconds || null, vendor: 'codex', sessionId: s.sessionId || null });
  }
  return m;
}

const base = (comm) => path.basename(String(comm || ''));
/** Does this process look like an agent session by its program name? (a hint, never a name)
 *  The command-line programs, exactly: the desktop apps named "Claude" / "Codex" are not sessions. */
export const looksLikeAgent = (comm) => /^(claude|codex)$/.test(base(comm));
/** Is this the cmux app's own process? Only the app in an Applications folder: a program that is
 *  merely NAMED cmux, somewhere else, is not it. */
export const isCmuxApp = (comm) => {
  const p = String(comm || '');
  return /\/cmux\.app\/Contents\/MacOS\/cmux$/.test(p) && (p.startsWith('/Applications/') || p.startsWith(`${os.homedir()}/Applications/`));
};

// ── browsers (the decision door's second rule) ──────────────────────────────
// A decision made on this machine is accepted only from a browser or web-view network process.
// The WebKit one lives on the sealed system volume; the others are app bundles the owner lists.
export const DEFAULT_BROWSERS = ['Safari', 'Google Chrome', 'Google Chrome Beta', 'Chromium', 'Firefox', 'Microsoft Edge', 'Brave Browser', 'Arc', 'Orion', 'Vivaldi', 'Opera', 'DuckDuckGo', 'cmux'];
const WEBKIT = '/System/Library/Frameworks/WebKit.framework/';

/** Is this executable a browser's (or a web view's) network process? `apps` = bundle names without ".app". */
export function isBrowserProcess(exe, apps = DEFAULT_BROWSERS) {
  const p = String(exe || '');
  if (!p.startsWith('/')) return false;
  if (p.startsWith(WEBKIT)) return true;
  if (/^\/(System\/Volumes\/Preboot\/)?Cryptexes\/(App|OS)\/System\/Library\/Frameworks\/WebKit\.framework\//.test(p)) return true;   // Safari updates ship WebKit in a cryptex
  return apps.some((name) => p.startsWith(`/Applications/${name}.app/`) || p.startsWith(`${os.homedir()}/Applications/${name}.app/`));
}

// ── the resolution (pure) ───────────────────────────────────────────────────
/**
 * From a chain to who it is.
 *   chain     nearest first (chainOf)
 *   sessions  Map pid → { workspaceId, start, vendor } (sessionPids)
 *   envOf     (pid) → workspace id from that pid's start environment | null | undefined (not read)
 *   jobs      Map pid → name: launchd jobs the owner mapped to a name (SETTINGS.callerEvidence.jobs)
 *   boardPid  this board
 * → { kind: 'agent', workspaceId, sessionPid, vendor, basis } — basis 'session-map' | 'env'
 *   { kind: 'board' } | { kind: 'job', name } | { kind: 'local' }
 *   plus agentAncestor (an agent session is somewhere behind the call), underCmux, and why.
 */
export function resolveChain(chain, { sessions = new Map(), envOf = () => undefined, jobs = new Map(), boardPid = process.pid } = {}) {
  const underCmux = chain.some((l) => isCmuxApp(l.comm));
  // a mapped session counts only while it is the SAME process (start time within 2 s)
  const mapped = (l) => { const s = sessions.get(l.pid); return s && (!s.start || l.start == null || Math.abs(l.start - s.start) <= 2) ? s : null; };
  const agentAncestor = chain.some((l) => mapped(l) || looksLikeAgent(l.comm));
  const topDown = [...chain].reverse();
  if (chain.some((l) => l.pid === boardPid)) return { kind: 'board', agentAncestor, underCmux, why: 'a child of the board process' };
  for (const l of topDown) if (jobs.has(l.pid)) return { kind: 'job', name: jobs.get(l.pid), agentAncestor, underCmux, why: 'a mapped launchd job' };

  // The topmost mapped session wins — when two things the agent does not write agree with the map:
  // the chain reaches the cmux app, and the session process's own START environment names the same
  // workspace. (The map is a file the same user can write; alone it names nobody.)
  for (const l of topDown) {
    const s = mapped(l);
    if (!s) continue;
    const env = envOf(l.pid);
    // `mapped`: cmux's map lists this process as a session, yet it could not be named — never a
    // reason to treat the caller as a session outside cmux (hookIdentity keeps it enforced)
    if (!underCmux) return { kind: 'local', agentAncestor: true, underCmux, mapped: true, why: 'the session map lists this process, but it does not run under the cmux app' };
    if (env !== s.workspaceId) return { kind: 'local', agentAncestor: true, underCmux, mapped: true, why: env ? `session map says workspace ${s.workspaceId}, the process environment says ${env}` : `session map says workspace ${s.workspaceId}, but the process's start environment ${env === null ? 'carries no workspace id' : 'could not be read'}` };
    return { kind: 'agent', workspaceId: s.workspaceId, sessionPid: l.pid, vendor: s.vendor, basis: 'session-map', agentAncestor: true, underCmux, why: 'the topmost session in the chain (cmux session map, confirmed by its start environment)' };
  }
  // no map entry (cmux lists no hook session for some panes): the topmost agent-looking process
  // under the cmux app, by its start environment. Weaker than the map and labelled so.
  if (underCmux) {
    for (const l of topDown) {
      if (!looksLikeAgent(l.comm)) continue;
      const env = envOf(l.pid);
      if (env) return { kind: 'agent', workspaceId: env, sessionPid: l.pid, vendor: /codex/i.test(base(l.comm)) ? 'codex' : 'claude', basis: 'env', agentAncestor: true, underCmux, why: 'the topmost agent process under cmux (its start environment; no session-map entry)' };
      break;   // the topmost one decides; a lower one could carry a planted variable
    }
  }
  return { kind: 'local', agentAncestor, underCmux, why: agentAncestor ? 'an agent process is behind the call, but no session could be named' : 'no agent session in the process chain' };
}

// ── the door (pure): may this request make an owner decision? ───────────────
/**
 * mode: false | 'agent' | 'browser' (SETTINGS.callerEvidence.tripwire).
 *   rule 1 ('agent' and 'browser'): an agent session behind the request → refused, and named.
 *   rule 2 ('browser'): a local request must come from a browser process. Under 'agent' it only
 *                       reports what it WOULD refuse.
 * A request from another device, and a failed lookup, are never refused here: the owner must not
 * be locked out of their own board because a lookup timed out.
 * A sender that has GONE (it did not wait for its answer) is judged like a local non-browser: the
 * board page and a command line both still hold their end of the connection, so a real decision
 * is never in this state. Reported under 'agent', refused under 'browser'.
 *
 * `typedApproval` (the request is an approval of one gate, as `task.sh gate N gK approve` sends
 * it): under rule 2 it is not refused but KEPT, as a row the owner confirms on the board with one
 * click (`typed: true`). It decides nothing and mints nothing. Rule 1 still refuses it outright:
 * an approval an agent session is behind is never kept. Nor is one whose sender has gone: a
 * command line waits for its answer, so a typed approval that did not is not the owner's.
 * → { refuse: null | 'agent' | 'not-browser' | 'gone', would: null | 'not-browser' | 'gone' | 'typed', typed, msg }
 */
export function doorVerdict(ev, mode, { typedApproval = false } = {}) {
  const pass = { refuse: null, would: null, typed: false, msg: '' };
  if (!mode || !ev || ev.kind === 'remote' || ev.kind === 'unknown') return pass;
  if (ev.kind === 'gone') {
    const msg = 'refused: the sender of this request left before the board could see who it was. Decide on the board page.';
    return mode === 'browser' ? { ...pass, refuse: 'gone', msg } : { ...pass, would: 'gone', msg };
  }
  if (ev.agentAncestor) return { ...pass, refuse: 'agent', msg: 'refused: an agent session is behind this request. Decisions are made by the owner on the board page.' };
  if (ev.browser) return pass;
  const msg = 'refused: decisions made on this machine come from the board page in a browser. Decide on the board page.';
  if (mode !== 'browser') return { ...pass, would: typedApproval ? 'typed' : 'not-browser', msg };
  return typedApproval ? { ...pass, typed: true } : { ...pass, refuse: 'not-browser', msg };
}

// ── names (mode 'on'): is a DECLARED name backed by the calling process? ────
/**
 * A name is proven when the process that holds the connection backs it:
 *   an agent's name   the topmost session in the chain is that agent's (kind 'agent', same name)
 *   a mapped job      SETTINGS.callerEvidence.jobs gives this launchd job that name (kind 'job')
 *   board             a child of the board process (kind 'board'), or the board's per-boot token
 *   the owner's name  the decision token — and no agent session behind the request. (The token is
 *                     in the board page, so on its own it only says "someone on this machine".)
 * Everything else is unproven: another device, a plain terminal, a detached job, a failed lookup,
 * a session that is a DIFFERENT agent. An unproven name earns none of that name's privileges and
 * its words are marked; they are never dropped.
 * → { proven, why } — `why` is one printable clause for the log, the ledger note and the refusal.
 */
export function nameVerdict(ev, declared, { isOwner = () => false, ownerToken = false, boardToken = false } = {}) {
  const n = String(declared || '').toLowerCase();
  if (isOwner(n)) {
    if (!ownerToken) return { proven: false, why: 'the owner\'s name needs the decision token (the board page, or --signed from the owner\'s own shell)' };
    if (ev?.agentAncestor) return { proven: false, why: 'the decision token came from a process an agent session is behind' };
    if (ev?.kind === 'gone') return { proven: false, why: 'the decision token came from a sender that left before the board could see who it was' };
    return { proven: true, why: 'the decision token' };
  }
  if (n === 'board') return boardToken || ev?.kind === 'board' ? { proven: true, why: 'the board\'s own process' } : { proven: false, why: 'the name "board" belongs to the board\'s own process' };
  if (!ev) return { proven: false, why: 'the calling process was not looked up' };
  if ((ev.kind === 'agent' || ev.kind === 'job') && ev.name && ev.name === n) return { proven: true, why: ev.kind === 'agent' ? 'the calling process is this agent\'s session' : 'a mapped launchd job' };
  if (ev.kind === 'agent') return { proven: false, why: ev.name ? `the calling process is ${ev.name}'s session` : 'the calling process is an unregistered session' };
  if (ev.kind === 'job') return { proven: false, why: `the calling process is the job ${ev.name}` };
  if (ev.kind === 'board') return { proven: false, why: 'the calling process is the board\'s own child' };
  if (ev.kind === 'remote') return { proven: false, why: 'the request came from another device' };
  if (ev.kind === 'gone') return { proven: false, why: 'the sender left before the board could see who it was' };
  if (ev.kind === 'unknown') return { proven: false, why: 'the calling process could not be looked up' };
  return { proven: false, why: ev.agentAncestor ? 'an agent process is behind the call, but no session could be named' : 'no agent session is behind the call (a plain terminal, a script or a detached job)' };
}

/**
 * Mode 'on', the gate hook: WHICH session is behind this hook call? From the evidence, never from
 * the workspace id or the role the hook's own environment carries.
 *   an agent session   its registered name; a workspace the board itself started and has not yet
 *                      registered (a card dispatch) → `headlessWs(workspaceId)`; else unregistered
 *   a mapped job       its name, when `okJob(name)` (a headless role the policy knows)
 *   a session outside  unregistered:<folder> — an agent process that does not run under the cmux
 *   cmux, or no agent  app (a plain terminal session), exactly as before 1.3
 *   a failed lookup,   the declared identity, and `force`: enforced whatever that name is, so a
 *   a sender that left lookup that fails can never be a way out of enforcement (fail closed)
 *   a cmux session     the same: an agent process under the cmux app, or one cmux's map lists,
 *   nobody could name  whose session could not be named (its start environment and the map
 *                      disagree, it carries no workspace id, or its chain no longer reaches the
 *                      app). Calling that "unregistered" would turn an enforced agent into an
 *                      observed one by breaking the lookup.
 * → { agent, force, basis }
 */
export function hookIdentity(ev, { declared, folder, headlessWs = () => null, okJob = () => false } = {}) {
  const unregistered = `unregistered:${folder}`;
  if (!ev || ev.kind === 'unknown' || ev.kind === 'remote' || ev.kind === 'gone') return { agent: declared || unregistered, force: true, basis: ev?.kind === 'gone' ? 'declared (the sender had left)' : 'declared (the lookup failed)' };
  if (ev.kind === 'agent') return { agent: ev.name || headlessWs(ev.workspaceId) || unregistered, force: false, basis: ev.basis || 'session' };
  if (ev.kind === 'job') return { agent: okJob(ev.name) ? ev.name : unregistered, force: false, basis: 'job' };
  if (ev.agentAncestor && (ev.underCmux || ev.mapped)) return { agent: declared || unregistered, force: true, basis: 'declared (a cmux session that could not be named)' };
  return { agent: unregistered, force: false, basis: ev.kind };
}

// ── the impure shell ────────────────────────────────────────────────────────
const sh = (cmd, args, timeout) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 32e6 }, (err, stdout) => resolve({ out: String(stdout || ''), err: err || null }));
});

/**
 * createCallerEvidence({ readSessions, launchdPid?, browsers?, jobs?, run?, now?, boardPid?, timeoutMs? })
 *   readSessions  async () → { claude, codex } (the two cmux hook files, already parsed)
 *   jobs          { '<launchd label>': '<name>' } (SETTINGS.callerEvidence.jobs)
 * → { of({ remoteAddress, remotePort, localPort, closed? }) → evidence, stats }
 *   closed        () → { destroyed, ended }: the state of the board's OWN socket for this request,
 *                 read when it matters (destroyed = the sender reset or closed the connection;
 *                 ended = the sender closed its sending half or exited)
 * evidence: { kind: 'agent'|'board'|'job'|'local'|'remote'|'gone'|'unknown', workspaceId?, name?, pid?, exe?,
 *             agentAncestor, browser, basis?, why, ms }
 *   gone      the lookup ran and no process holds the client end: the sender did not wait
 *   unknown   the lookup could not run, or took longer than `budgetMs` in all (each step has its
 *             own `timeoutMs`; the budget is what a waiting hook or page can count on)
 */
export function createCallerEvidence({ readSessions = async () => ({}), jobs = {}, browsers = DEFAULT_BROWSERS, run = sh, now = () => Date.now(), boardPid = process.pid, timeoutMs = 2000, budgetMs = 3000, interfaces = () => os.networkInterfaces() } = {}) {
  let table = null; let tableAt = 0;
  const envCache = new Map();      // `${pid}@${start}` → workspace id | null
  const jobCache = new Map();      // label → { pid, at }
  const stats = { lookups: 0, failed: 0, gone: 0, lastError: null };
  // did the program end by itself, or was it cut short / never started? (a cut-short listing proves nothing)
  const cutShort = (err) => Boolean(err && (err.killed || err.signal || err.code === 'ENOENT' || err.code === 'ETIMEDOUT'));

  async function procTable(fresh = false) {
    if (!fresh && table && now() - tableAt < 1000) return table;
    const r = await run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='], timeoutMs);
    if (r.err && !r.out) throw new Error(`ps: ${r.err.message}`);
    table = parseProcTable(r.out); tableAt = now();
    return table;
  }
  async function envFor(link) {
    const key = `${link.pid}@${link.start}`;
    if (envCache.has(key)) return envCache.get(key);
    const r = await run('ps', ['-E', '-o', 'command=', '-p', String(link.pid)], timeoutMs);
    const ws = workspaceInEnv(r.out);
    if (envCache.size > 500) envCache.clear();
    envCache.set(key, ws);
    return ws;
  }
  async function jobPids() {
    const m = new Map();
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    for (const [label, name] of Object.entries(jobs || {})) {
      let hit = jobCache.get(label);
      if (!hit || now() - hit.at > 30000) {
        const r = uid == null ? { out: '' } : await run('launchctl', ['print', `gui/${uid}/${label}`], timeoutMs);
        const pid = Number(/^\s*pid = (\d+)/m.exec(r.out)?.[1]) || null;
        hit = { pid, at: now() }; jobCache.set(label, hit);
      }
      if (hit.pid) m.set(hit.pid, String(name));
    }
    return m;
  }

  async function lookup({ remoteAddress, remotePort, localPort }, t0, state) {
    const gone = (why) => { stats.gone += 1; return { kind: 'gone', agentAncestor: false, browser: false, why, ms: now() - t0 }; };
    // the board's own socket is already closed: the sender reset the connection, there is no client end to find
    if (state().destroyed) return gone('the sender closed the connection before the board could look at it');
    // every TCP state, not only ESTABLISHED: a client that closed its sending half is still the caller
    const r = await run('lsof', ['-nP', `-iTCP:${Number(remotePort)}`, '-Fpcn'], timeoutMs);
    if (cutShort(r.err)) throw new Error(`lsof: ${r.err.message}`);
    const conns = parseLsof(r.out);
    const q = { srcAddr: remoteAddress, srcPort: remotePort, dstPort: localPort };
    const owner = connectionOwner(conns, { ...q, self: boardPid });
    if (!owner) {
      // Nobody holds the client end. That counts as "the sender has left" on positive evidence only:
      // the listing shows the board's own end of this connection, or the board's own socket saw the
      // sender close. A listing that shows neither end of a connection the board still holds open
      // told us nothing: that is a failed lookup.
      const st = state();
      if (connectionSeen(conns, q) || st.destroyed || st.ended) return gone('no process holds the client end of this connection: its sender did not wait for the answer');
      throw new Error(r.err ? `lsof: ${r.err.message}` : 'lsof did not list this connection');
    }
    // the snapshot is cached for a second, and a caller may be younger than it: a process the
    // cache has never seen gets a fresh snapshot. (Without this, a request sent right after any
    // other one would resolve to "unknown", which the decision door does not refuse.)
    let t = await procTable();
    if (!t.has(owner.pid)) t = await procTable(true);
    const chain = chainOf(owner.pid, t);
    // it held the connection a moment ago and is in no fresh process table: it exited in between
    if (!chain.length) return gone(`the process that held the connection (pid ${owner.pid}) exited before the board could look at it`);
    const sessions = sessionPids(await readSessions().catch(() => ({})));
    // read the start environment only where the resolution will ask for it
    const envs = new Map();
    for (const l of chain) if (sessions.has(l.pid) || looksLikeAgent(l.comm)) envs.set(l.pid, await envFor(l));
    const res = resolveChain(chain, { sessions, envOf: (pid) => envs.get(pid), jobs: await jobPids(), boardPid });
    const exe = chain[0].comm;
    return { ...res, pid: owner.pid, exe, browser: isBrowserProcess(exe, browsers), ms: now() - t0 };
  }

  async function of(conn) {
    const t0 = now();
    const state = () => { try { return (typeof conn.closed === 'function' && conn.closed()) || {}; } catch { return {}; } };
    // no source address at all: the socket was closed under us. Never read that as "another device".
    if (!conn.remoteAddress) { stats.gone += 1; return { kind: 'gone', agentAncestor: false, browser: false, why: 'the connection was closed before the board could look at its sender', ms: 0 }; }
    if (!isLocalSource(conn.remoteAddress, localAddresses(interfaces()))) return { kind: 'remote', agentAncestor: false, browser: false, why: 'the request came from another device', ms: 0 };
    stats.lookups += 1;
    let timer;
    try {
      // one budget for the whole lookup, whatever the steps add up to: a hook waits a few seconds
      // for its answer, and the owner's click must not hang on a slow process listing
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`took longer than ${budgetMs} ms`)), budgetMs); });
      return await Promise.race([lookup(conn, t0, state), late]);
    } catch (e) {
      stats.failed += 1; stats.lastError = { at: new Date(now()).toISOString(), msg: String(e.message).slice(0, 160) };
      return { kind: 'unknown', agentAncestor: false, browser: false, why: `lookup failed: ${String(e.message).slice(0, 120)}`, ms: now() - t0 };
    } finally { clearTimeout(timer); }
  }
  return { of, stats };
}

/** SETTINGS.callerEvidence → { mode: 'off'|'observe'|'on', tripwire: false|'agent'|'browser', browsers, jobs }. Absent = off. */
export function callerSettings(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const mode = ['observe', 'on'].includes(c.mode) ? c.mode : 'off';
  const tw = c.tripwire === true ? 'agent' : ['agent', 'browser'].includes(c.tripwire) ? c.tripwire : false;
  return { mode, tripwire: tw, browsers: Array.isArray(c.browsers) && c.browsers.length ? c.browsers.map(String) : DEFAULT_BROWSERS, jobs: c.jobs && typeof c.jobs === 'object' ? c.jobs : {} };
}
