// Ops Board — zero-dependency local dashboard for the background-automation
// fleet and the agent workforce. Read-only against every system it watches.
// MC_DEMO=1 swaps every collector for synthetic data (src/demo.mjs).
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdir, stat as fsStat } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, DOCKER_CONTAINERS, PROCESSES, CRON, ENDPOINTS, CONTEXT, SETTINGS, DOMAINS, OWNER, isOwner, isPrincipal, resolve as resolveConfig, loadSecrets, SECRETS_FILE, REGISTRY_FILE, PRINCIPALS, writePrivate, PROFILE, CMUX_PRESENT } from './src/config.mjs';
import { publishLines, chatFileProblem, loadChannels, isChatTask } from './src/intake.mjs';
import { snapshot, logPathsFor } from './src/status.mjs';
import { noteGuardrailsSeen } from './src/setup.mjs';
import { tailFile, getAgentFeed } from './src/collect.mjs';
import { processAlerts, sendDigest, notify as realNotify, cmuxPassword } from './src/alerts.mjs';
import { maybeRemediate } from './src/remediate.mjs';
import { maybeHealCmuxBridge } from './src/heal-cmux.mjs';
import { maybeHealFailedRestores, cmuxAppStart } from './src/heal-restore.mjs';
import { reloadDockOnce } from './src/dock-reload.mjs';
import { syncDemoCmux } from './src/demo-cmux.mjs';
import { recordEvent, getEvents } from './src/events.mjs';
import { maybeCiCostWatch } from './src/ci-cost-watch.mjs';
import { maybeOperatingReading, computeReading } from './src/operating-reading.mjs';
import { readAsksMode, findAsks, askText, noteSent, settleState, readAsksState } from './src/read-asks.mjs';
import { decideMode, decideRows, pushView, openRefusal, openWorkspace } from './src/decide-page.mjs';
import { maybeRepoStats } from './src/repo-stats.mjs';
import { maybeReleaseDrift } from './src/release-drift.mjs';
import { maybeBrain, verifyClose } from './src/brain.mjs';
import { packetMode, packetLine, readPr } from './src/completion-packet.mjs';
import { leftover as leftoverWorktree } from './src/worktree.mjs';
import { maybeChannelDiscovery } from './src/channel-discovery.mjs';
import { maybeViewWatch } from './src/view-watch.mjs';
import { maybeParserWatch } from './src/parser-watch.mjs';
import { evidenceMode, evidenceRows, CLOSED_DAYS } from './src/evidence.mjs';
import { setupPageMode, createSetupReader, demoSetupReader } from './src/setup-page.mjs';
import { runStep as runSetupStep, demoStep as demoSetupStep, scanWatch, restartPlan, SetupRefused, stepsFor, DEMO_SCAN } from './src/setup-write.mjs';
import { alertsOffered } from './src/setup-alerts.mjs';
import { buttonsOffered, browserProven, createButtons, demoButton, buttonList, lastRun as lastButtonRun, ButtonRefused } from './src/setup-buttons.mjs';
import { conversationMode, createConversations, demoConversation, validSessionId, WHY as CONVERSATION_WHY } from './src/conversation.mjs';
import { allowedSource, localOnly } from './src/guard.mjs';
import { isWrite, writeRefusal, senderTrust } from './src/request-guard.mjs';
import { createCallerEvidence, callerSettings, doorVerdict, isLocalSource, nameVerdict, jobSenders, jobSenderVerdict } from './src/caller.mjs';
import { createLedger, MeshError, summarize, wakeMessage, outsideTask, sourceLabel, holdOpen } from './src/tasks.mjs';
import { triageReading } from './src/triage-reading.mjs';
import { planAsk } from './src/triage-ask.mjs';
import { loadOptional } from './src/optional-module.mjs';
import { createGateService } from './src/gate-service.mjs';
import { createGateIntegrity, integritySettings, gatePaths, gateDirs, remoteTarget, remoteTargetReads, READ_BUDGET_MS, readRemoteRef, registrationProblems, portProblem, integrityCard, settingsProblem, settingsNote, PROJECT_SETTINGS, startSettingsScan, needsCwd, failOpenEntries, OWN_FILES, isHookCommand, hookEntries, CONFIG_HOOK, readChild, createBudget, RanOut } from './src/gate-integrity.mjs';
import { DEFAULT_POLICY as GATE_DEFAULT_POLICY, repoSlug as gateRepoSlug } from './src/gates.mjs';
import { decisionSurface } from './src/gate-ledger.mjs';
import {
  liveDirectory, resolveTarget, deliverNow, enqueue, drainOutbox, dropFromOutbox, readOutbox, formatWake, validateMessage, unreadableNotices,
  reconcile, mutateAgents, listWorkspaces, readSessionMap, readRegistry, nameDrift, ensureSessionName,
  slugTitle, kickSession, classifyScreen, listGroups, generatedAnchorIds, writeJsonAtomic, OUTBOX_FILE,
  acrossWindows, isDemoWorkspace, demoWorkspaceIds, cmux,
} from './src/mesh.mjs';
import { applyChrome, applyPills, inputPrompts } from './src/chrome.mjs';
import { hookFor, pidCheck, needsScreen, agentState, createScreenReader, parseProcStarts, observeLines, stateView, taxonomyMode } from './src/agent-state.mjs';
import { collectContext } from './src/context.mjs';
import { runAutopilot, thresholds as autopilotThresholds } from './src/context-autopilot.mjs';
import { focusOf } from './src/gate-ledger.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEMO, DEMO_POLL_SECONDS, DEMO_DOMAINS, demoSnapshot, demoContext, demoDirectory, demoHistory, demoBeats,
  demoFeed, demoLog, seedDemoLedger, demoTasksDir, DEMO_GATE,
} from './src/demo.mjs';
import { readStar, successMoment, toastFor, recordToast, gateMoment } from './src/star.mjs';
import { snoozeMode, attentionItems, buildAttention, settle as settleAttention, snoozedByTask, snoozeRefusal, applySnooze, readAttentionState, writeAttentionState, itemText, SNOOZE_CHOICES } from './src/attention.mjs';
import { maybeUpgradeCheck, readStateSync as readUpgradeState, requestAllowed, upgradePlist, versionInfo, labelPrefix, REQUEST_FILE as UPGRADE_REQUEST } from './src/upgrade.mjs';
import { relayPass } from './src/relay.mjs';
import { maybeGithubIntake } from './src/github-intake.mjs';
import { createStages, readDigestState, writeDigestState, digestDue, installProcessHandlers } from './src/poll-health.mjs';
import { maybeMeasure, currentUsage, usageLines } from './src/data-usage.mjs';

// push approvals (#415): ring the owner's phone for what waits on them; ids + labels only, the
// decision still happens on the board. The desk ping (notify) fires regardless.
const relayNow = async () => {
  if (DEMO || !SETTINGS.relay || SETTINGS.relay.mode === 'off') return;
  // re-rings skip what the owner snoozed on the attention ring (#412); first rings never wait
  const snoozed = snoozeMode(SETTINGS.attention) === 'on' ? new Set(attentionView().snoozed.map((i) => i.id)) : new Set();
  await relayPass({ cfg: SETTINGS.relay, secrets: loadSecrets(), tasks: await ledger.list({ status: 'live' }), snoozed,
    record: (k, t) => recordEvent(k, t).catch(() => {}) });
};

// demo mode never notifies anyone (no cmux, no osascript, no email)
const notify = DEMO ? async () => true : realNotify;

// dead-man's switch: push a heartbeat off-Mac; a GitHub Action alerts if it stops.
// HEARTBEAT_URL (PostgREST row) + HEARTBEAT_KEY from data/secrets.env; absent = off.
async function heartbeat() {
  try {
    const { HEARTBEAT_URL: url, HEARTBEAT_KEY: hbKey, HEARTBEAT_HOST: host } = loadSecrets();
    if (!url || !hbKey) return;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    await fetch(url, {
      method: 'PATCH', signal: ctl.signal,
      headers: { apikey: hbKey, authorization: `Bearer ${hbKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ beat_at: new Date().toISOString(), host: host || os.hostname().split('.')[0] }),
    }).finally(() => clearTimeout(t));
  } catch { /* transient network loss is fine; the dead-man fires only on sustained silence */ }
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Ask back office (#755) is a private lane (#797, the manifest's `withheld` list): present here, absent in the public
// edition. Absent = its route answers 404; a file that is there and fails to load stops the board as any import would.
const BACKOFFICE = await loadOptional(path.join(ROOT, 'src', 'backoffice.mjs'));
const PUBLIC = path.join(ROOT, 'public');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');

// ---- Agent Mesh: task ledger + directory + delivery ----
// demo mode gets its own throwaway ledger, re-seeded on every start (data/demo-tasks, or the folder
// MC_DEMO_TASKS names: two demo boards must not share one, src/demo.mjs demoTasksDir)
const ledger = DEMO
  ? await seedDemoLedger(demoTasksDir(ROOT).dir, createLedger, { own: demoTasksDir(ROOT).own, root: ROOT })
  : createLedger(path.join(ROOT, 'data', 'tasks'));
// Guardrails (docs/GUARDRAILS.md): the gate hook asks POST /api/gates/check; the policy is
// overlay/policy.json → examples/policy.json; state in data/guardrails/ (demo: its own dir)
const GATE_CARD_FILE = path.join(ROOT, 'data', DEMO ? 'demo-guardrails-card.json' : 'guardrails-card.json');
// Workspaces the board itself started for a card dispatch, until the reconciler registers them.
// With names enforced (callerEvidence mode 'on') the gate knows such a session as headless:dispatch
// from THIS record — not from a role variable in the session's environment, which any session can set.
const dispatchWorkspaces = new Map();    // workspace id (lower case) → started at (ms)
const DISPATCH_ROLE_MS = 24 * 3600e3;
const gates = createGateService({
  root: ROOT, ledger, ownerId: OWNER.id, policyFile: () => resolveConfig('policy.json'), receiptChain: SETTINGS.receiptChain,
  stateDir: path.join(ROOT, 'data', DEMO ? 'demo-guardrails' : 'guardrails'),
  headlessWs: (ws) => {
    const at = dispatchWorkspaces.get(String(ws || '').toLowerCase());
    return at && Date.now() - at < DISPATCH_ROLE_MS ? 'dispatch' : null;
  },
  identifyWs: async (ws) => {
    const d = dirCache.length ? dirCache : await refreshDir();
    const a = d.find((x) => String(x.workspaceId || '').toLowerCase() === String(ws).toLowerCase() && x.status !== 'closed');
    return a?.name || null;
  },
  recordEvent: (k, t) => recordEvent(k, t),
  afterTaskChange: (t, r, actor) => afterTaskChange(t, r, actor),
  mcName: async () => resolveTarget('mission-control', dirCache.length ? dirCache : await refreshDir()).agent?.name || 'mission-control',
});
// Gate integrity (src/gate-integrity.mjs, SETTINGS.gateIntegrity): every poll the gate's own files in
// THIS checkout are compared with what has landed on the default branch, and the hook's registration
// and port are checked. The result is part of the guardrails card. It only reads: files, `git` read
// commands, and the remote's head (gh, else git ls-remote). A demo board has no gate of its own.
const LIVE = path.resolve(ROOT);
const INTEGRITY = integritySettings(DEMO ? null : SETTINGS.gateIntegrity);
const INTEGRITY_FILE = path.join(ROOT, 'data', 'gate-integrity-state.json');
// #636: off the event loop: asynchronous, 3 s each, inside the check's one budget. An answer (exit 0) is stdout, a
// "no" (any other exit) is null as before, and a read that ran out THROWS, so the card never takes it for a "no".
const liveGit = async (args, budget = null) => {
  const r = await readChild('git', ['-C', LIVE, ...args], { limitMs: 3000, budget, label: 'integrity' });
  if (r.ranOut) throw new RanOut(`git ${args[0]}`);
  return r.code === 0 ? r.out.trim() : null;
};
const readOnly = (cmd, args) => new Promise((resolve) => { execFile(cmd, args, { encoding: 'utf8', timeout: 10000 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || ''), err: String(errOut || err?.message || '') })); });
const integrity = INTEGRITY.mode !== 'on' ? null : createGateIntegrity({
  root: LIVE, settings: INTEGRITY, git: liveGit,
  // the policy's own list of gate files; a policy written before 1.3 has none, so the shipped list stands in
  // (#636: the folders' ls-tree is read first, asynchronously, and handed to the pure gatePaths)
  files: async (git = liveGit) => {
    const list = gates.policy()?.lists?.gateCode || GATE_DEFAULT_POLICY.lists.gateCode;
    const trees = new Map();
    for (const dir of gateDirs(list)) trees.set(dir, String((await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', dir])) || ''));
    return [...gatePaths(list, { lsTree: (dir) => (trees.get(dir) || '').split('\n').filter(Boolean) }), ...OWN_FILES];
  },
  readFile: (p) => readFile(path.join(LIVE, p)),
  readState: async () => JSON.parse(await readFile(INTEGRITY_FILE, 'utf8')),
  writeState: (st) => writeJsonAtomic(INTEGRITY_FILE, st),
  readRemoteHead: async () => {
    // remoteTarget stays pure: its four reads are made first (one budget), then handed to it as answers
    const budget = createBudget(READ_BUDGET_MS);
    const answers = new Map();
    for (const args of remoteTargetReads(INTEGRITY)) answers.set(args.join(' '), await liveGit(args, budget));
    const target = remoteTarget({ git: (args) => answers.get(args.join(' ')) ?? null, settings: INTEGRITY });
    return readRemoteRef({ target, slug: /github\.com/i.test(target.url) ? gateRepoSlug(target.url) : null, run: readOnly, remote: INTEGRITY.remote, root: LIVE });
  },
});
const sessionCwd = new Map();             // pid → folder | null: a session started with a RELATIVE settings path (lsof, asked once per process)
const CWD_LOOKUPS = 4;                    // new lookups per poll; the rest wait for the next one (a note says so until then)
async function startSettings(home) {
  // (its own call: the listing is about half a megabyte on a busy machine, more than readOnly's default buffer allows before long)
  const ps = await new Promise((resolve) => { execFile('ps', ['-axww', '-o', 'pid=,args='], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 }, (err, out) => resolve({ ok: !err, out: String(out || '') })); });
  if (!ps.ok) return { problems: [], notes: ['running sessions\' command lines could not be read (ps)'], files: [], sessions: 0 };
  const procs = ps.out.split('\n').map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((x) => ({ pid: Number(x[1]), args: x[2] }));
  const seen = new Map();                 // one read per file per poll, however many sessions share it
  const readJson = (f) => { if (!seen.has(f)) { let j = null; try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { j = null; } seen.set(f, j); } return seen.get(f); };
  // A relative path is read from the session's own folder, which only lsof knows (about 0.4 s a call
  // here). Never on this loop, which also answers gate checks: asynchronous, a few new processes a
  // poll, side by side, 2 s at most. A process not looked up yet reads as "cannot read" for this poll.
  const need = needsCwd(procs);
  for (const pid of [...sessionCwd.keys()]) if (!need.includes(pid)) sessionCwd.delete(pid);
  await Promise.all(need.filter((pid) => !sessionCwd.has(pid)).slice(0, CWD_LOOKUPS).map((pid) => new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8', timeout: 2000 }, (err, out) => { sessionCwd.set(pid, /^n(\/.*)$/m.exec(String(out || ''))?.[1] || null); resolve(); });
  })));
  const cwdOf = (pid) => sessionCwd.get(pid) ?? null;
  const dirs = INTEGRITY.startSettingsDirs.map((d) => path.resolve(d.replace(/^~(?=\/|$)/, home))).map((dir) => {
    let files = [];
    try { files = readdirSync(dir).filter((n) => n.endsWith('.json')).slice(0, 50); } catch { files = []; }
    return { dir, files };
  });
  return startSettingsScan({ procs, readJson, cwdOf, dirs, home });
}
let integrityWas = null;                  // the last state put on the ticker (a line per change, not per poll)
async function gateIntegrityCard() {
  const files = await integrity.check();
  const json = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
  const home = os.homedir();
  const userSettings = await json(path.join(home, '.claude', 'settings.json'));
  const registration = [...registrationProblems(userSettings, { repo: LIVE }).problems];
  // the settings-change hook ships with 1.3: until the installer has been run again it is not there.
  // Said on the card, not coloured: installing a hook is the owner's step.
  const notes = hookEntries(userSettings).some((e) => e.event === 'ConfigChange' && isHookCommand(e.command, LIVE, CONFIG_HOOK)) ? [] : ['settings-change hook not installed (scripts/guardrails-install.sh)'];
  // an entry of ours that does not fail closed (registered before the field existed): said, not coloured; the installer refreshes it
  const open = failOpenEntries(userSettings, { repo: LIVE });
  if (open.length) notes.push(`${open.join(' and ')} ${open.length === 1 ? 'is' : 'are'} registered without onFailure: "block", so a hook that cannot start would let calls run (scripts/guardrails-install.sh)`);
  // Codex: only where its hook was installed at all (the card already says "codex MISSING" where it never was)
  const codex = await json(path.join(home, '.codex', 'hooks.json'));
  if (codex && JSON.stringify(codex).includes('gate-hook.sh')) registration.push(...registrationProblems(codex, { repo: LIVE, codex: true }).problems.map((x) => `Codex: ${x}`));
  // A project settings file that switches hooks off silences the user-level gate hook for every
  // session in that repo, mid-session; one whose env block names a variable the hook reads steers
  // it (both seen live). So: the repos the registered agents work in.
  const repos = [...new Set(dirCache.filter((a) => a.status !== 'closed' && typeof a.repo === 'string' && a.repo).map((a) => path.resolve(a.repo.replace(/^~(?=\/|$)/, home))))];
  // git's own variables in an env block reach the shell every call runs in: the strict names are a problem
  // above, the softer ones (a key, a proxy, another settings file) a note (#572)
  const userNote = settingsNote(userSettings);
  if (userNote) notes.push(`the user settings file ${userNote}`);
  for (const repo of repos) for (const f of PROJECT_SETTINGS) {
    const j = await json(path.join(repo, f));
    const why = settingsProblem(j);
    if (why) registration.push(`${path.join(repo, f).replace(home, '~')} ${why} (for every session in that repo)`);
    const note = settingsNote(j);
    if (note) notes.push(`${path.join(repo, f).replace(home, '~')} ${note}`);
  }
  // The settings a session is STARTED with (`claude --settings <file or JSON>`, how cmux starts every
  // session): one more source above all of those, and no settings-change event fires for it. Read from
  // the running sessions' own command lines, plus the folders that hold such files for the next start.
  const started = await startSettings(home);
  registration.push(...started.problems);
  notes.push(...started.notes);
  const port = portProblem(await readFile(path.join(ROOT, 'data', 'local.env'), 'utf8').catch(() => ''), SETTINGS.port);
  // the fast path's own file: rewritten at once when it is not what the policy generates, and said for this poll
  const trig = await gates.verifyTriggers().catch(() => ({ ok: true }));
  if (!trig.ok) {
    console.log(`${new Date().toISOString()} [integrity] the triggers file was ${trig.missing ? 'missing' : 'changed outside the board'}: rewritten from the policy`);
    registration.push(`the hook's triggers file was ${trig.missing ? 'missing' : 'changed outside the board'} (rewritten)`);
  }
  // …and the hook's MCP allow file the same way (every line in it is a tool the board is never asked about)
  const allow = await gates.verifyMcpAllow().catch(() => ({ ok: true }));
  if (!allow.ok) {
    console.log(`${new Date().toISOString()} [integrity] the MCP allow file was ${allow.missing ? 'missing' : 'changed outside the board'}: rewritten from the board's list`);
    registration.push(`the hook's MCP allow file was ${allow.missing ? 'missing' : `changed outside the board (${allow.foreign} foreign line(s))`} (rewritten)`);
  }
  const card = integrityCard({ files, registration, port, notes });
  const key = `${card.status}|${card.state}|${card.changed.join(',')}|${card.problems.join(',')}`;
  if (key !== integrityWas) {
    if (integrityWas !== null || card.status === 'down') recordEvent(card.status === 'down' ? 'bad' : 'sys', `guardrails: ${card.detail}`).catch(() => {});
    if (card.status === 'down') console.log(`${new Date().toISOString()} [integrity] ${card.detail}`);
    integrityWas = key;
  }
  return card;
}
let workCache = summarize([]);
let dirCache = [];
let contextCache = new Map();      // workspaceId → context gauge (src/context.mjs)
const refreshWork = async () => {
  workCache = await ledger.summary();
  await refreshAttention().catch((e) => console.error('[attention]', e.message));
  await refreshDecide().catch((e) => console.error('[decide]', e.message));
};
// Attention ring (SETTINGS.attention, src/attention.mjs): owner snoozes on WAITING ON YOU items.
// 'off' = the state is never read or written and the strip is today's. Expiry runs on every
// ledger refresh: an item whose snooze ran out returns to the strip with a "back" marker.
const ATTENTION_FILE = path.join(ROOT, 'data', DEMO ? 'demo-attention-state.json' : 'attention-state.json');
let attentionState = null;               // loaded on first use while the switch is on
const waitingTasks = () => [...(workCache.needsApproval || []), ...(workCache.blocked || [])];
async function refreshAttention() {
  if (snoozeMode(SETTINGS.attention) !== 'on') return;
  attentionState ||= await readAttentionState(ATTENTION_FILE);
  const r = settleAttention(attentionState, attentionItems(waitingTasks(), { isOwner }), Date.now());
  if (!r.changed) return;
  attentionState = r.state;
  await writeAttentionState(ATTENTION_FILE, attentionState);
  for (const id of r.expired) recordEvent('sys', `attention: snooze ran out, ${id} is back on the strip`).catch(() => {});
}
const attentionView = () => buildAttention(waitingTasks(), attentionState, { mode: snoozeMode(SETTINGS.attention), isOwner });
// Daily decision page (#788, SETTINGS.decidePage, src/decide-page.mjs): the strip's items ordered by
// the cost of waiting, read-only. Rebuilt on every ledger refresh (full tasks for priority and the
// blocking question; the directory for each owner's workspace title). The page push carries the
// one-line questions only (pushView); GET /api/decide carries the full text.
let decideCache = null;
// The header's p90 is the weekly reading's wait on the owner. computeReading walks the whole ledger
// (a few milliseconds over a ledger of several hundred tasks, on the event loop), so it is kept
// for P90_KEEP_MS rather than run on every ledger change.
const P90_KEEP_MS = 10 * 60e3;
let p90Kept = { at: 0, h: null };
async function waitP90H() {
  if (Date.now() - p90Kept.at < P90_KEEP_MS) return p90Kept.h;
  const p90ms = computeReading(await ledger.list(), { owner: OWNER.id }).cur?.ownerWaits?.p90;
  p90Kept = { at: Date.now(), h: Number.isFinite(p90ms) ? p90ms / 3600e3 : null };
  return p90Kept.h;
}
async function refreshDecide() {
  if (decideMode(SETTINGS.decidePage) !== 'on') { decideCache = null; return; }
  const view = attentionView();
  const ids = [...new Set((view.groups || []).map((g) => g.task))];
  const full = new Map();
  for (const id of ids) { const t = await ledger.get(id); if (t) full.set(id, t); }
  decideCache = decideRows(view, full, { directory: dirCache, outside: outsideTask, waitP90H: await waitP90H() });
}
// Guardrails-only profile (SETTINGS.profile 'guardrails', src/profile.mjs): the ledger, the gate and
// the waiting rows. No cmux call is ever made: no directory, no mesh delivery, no heal.
const GUARDRAILS_ONLY = !DEMO && PROFILE === 'guardrails';
// setup page (src/setup-page.mjs): read-only; a demo board reads nothing of this machine's setup
const setupOn = setupPageMode(SETTINGS.setupPage) !== 'off';
// mode 'write' (src/setup-write.mjs): three steps can be answered on the page. The owner's own browser on
// this Mac only: the routes below ask for the loopback address, the decision door and the decision token.
const setupWrite = setupPageMode(SETTINGS.setupPage) === 'write';
const setupReader = DEMO ? demoSetupReader() : createSetupReader({ secrets: () => loadSecrets(), profile: PROFILE });
// conversation view (src/conversation.mjs): the last turns of one session from its transcript tail, read-only
const conversationOn = conversationMode(SETTINGS.conversationView) === 'on';
const conversations = createConversations({ cmuxMap: SETTINGS.cmuxSessionsFile });
const refreshDir = async () => {
  dirCache = DEMO ? demoDirectory() : GUARDRAILS_ONLY ? [] : await liveDirectory().catch(() => dirCache);
  return dirCache;
};
const meshConfig = async () => JSON.parse(await readFile(resolveConfig('config/mesh.json'), 'utf8').catch(() => '{}'));

/**
 * Who is acting? Resolve a self-declared name to its directory entry.
 * `req` (a message, a new task, a comment only): a name no agent has may also be a mapped launchd
 * job's (SETTINGS.callerEvidence.jobs), accepted only when the evidence shows that job behind the
 * call (#643 b). Every other caller giving that name gets the unknown-name answer, as before.
 */
const jobNameProblemsSaid = new Set();
async function identify(who, { req = null } = {}) {
  const n = String(who || '').trim().toLowerCase();
  if (!n) throw new MeshError(400, 'actor/requester is required (your agent name: --as or $MESH_AGENT)');
  if (isOwner(n) || n === 'board') return { name: isOwner(n) ? OWNER.id : n, ws: null, mc: false };
  if (['me', 'self'].includes(n)) throw new MeshError(400, `"${n}" is not an agent name — give your own name (--as <name>), or omit --as inside a cmux pane`);
  const dir = dirCache.length ? dirCache : await refreshDir();
  const r = resolveTarget(n, dir, { exact: true });
  if (!r.agent && req && Object.keys(CALLER.jobs).length) {
    const { senders, problems } = jobSenders(CALLER.jobs, { agentNames: dir.map((a) => a.name), isOwner });
    for (const p of problems) {
      if (jobNameProblemsSaid.has(p.label)) continue;
      jobNameProblemsSaid.add(p.label);
      console.log(`${new Date().toISOString()} [caller] callerEvidence.jobs: ${p.label} → "${p.name}" is refused as a sender (${p.why})`);
    }
    if (senders.has(n)) {
      const v = jobSenderVerdict(n, await evidenceOf(req), senders);
      if (v.ok) return { name: n, ws: null, mc: false, job: true };
      console.log(`${new Date().toISOString()} [caller] job name "${n}" refused as a sender: ${v.why}`);
    }
  }
  if (!r.agent) throw new MeshError(400, `unknown agent "${n}" — see GET /api/agents`, { candidates: r.candidates });
  if (r.agent.status === 'closed') throw new MeshError(400, `agent "${r.agent.name}" is closed — an identity must be a live agent`);
  return { name: r.agent.name, ws: r.agent.workspaceId || null, mc: r.agent.kind === 'mission-control' };
}

// Caller evidence (src/caller.mjs, SETTINGS.callerEvidence): WHO is calling, worked out from the
// process that holds the connection — not from the name the caller declares.
//   mode 'observe'   the evidence is recorded next to the declared name; nothing is refused
//   tripwire         the decision door: an owner decision an agent session is behind is refused
//                    ('agent'); under 'browser' a local decision must also come from a browser
//   mode 'on'        names enforced: a declared name the calling process does not back earns none
//                    of that name's standing and its words are marked; the gate hook's identity
//                    comes from the evidence
// A demo board runs none of it unless MC_DEMO_CALLER is set: the test suites are run by agents, and a
// demo board that looked at its callers would refuse the tests' own decision requests. '1' = the
// configured switches; 'mode,tripwire' (say 'on,browser') = those two, for the tests of each setting.
const demoCaller = (v) => (!v ? null : v === '1' ? SETTINGS.callerEvidence : { ...(SETTINGS.callerEvidence || {}), mode: String(v).split(',')[0], tripwire: String(v).split(',')[1] });
const CALLER = callerSettings(DEMO ? demoCaller(process.env.MC_DEMO_CALLER) : SETTINGS.callerEvidence);
// the alerts form of the setup page (src/setup-alerts.mjs) writes the secrets file: offered only with its own key
// AND a decision door that refuses a sender that is not a browser
const setupAlerts = alertsOffered(SETTINGS.setupPage, CALLER.tripwire);
// buttons on the setup page (src/setup-buttons.mjs): their own key, the same door rule, and one runner per board
const setupButtonsOn = setupWrite && buttonsOffered(SETTINGS.setupPage, CALLER.tripwire);
const setupButtons = createButtons();
const callerEvidence = createCallerEvidence({
  readSessions: async () => ({ claude: await readSessionMap().catch(() => ({})), codex: await readJsonQuiet(path.join(os.homedir(), '.cmuxterm', 'codex-hook-sessions.json')).catch(() => ({})) }),
  jobs: CALLER.jobs, browsers: CALLER.browsers,
});
const callerStats = { refusedAgent: 0, refusedNotBrowser: 0, refusedGone: 0, wouldRefuse: 0, typedKept: 0, wouldKeepTyped: 0, passedNoEvidence: 0, lastNoEvidence: null, mismatches: 0, lastMismatch: null, unverified: 0, lastUnverified: null };
let nameMissAt = 0;
const nameOfWs = async (ws) => {
  const find = (d) => d.find((x) => String(x.workspaceId || '').toLowerCase() === String(ws).toLowerCase() && x.status !== 'closed')?.name || null;
  const hit = find(dirCache.length ? dirCache : await refreshDir());
  // a workspace registered since the last poll (a worker just spawned): read the directory again
  // before calling its session unregistered — at most once every 5 s, whoever asks
  if (hit || Date.now() - nameMissAt < 5000) return hit;
  nameMissAt = Date.now();
  return find(await refreshDir());
};
/** The evidence for this request, looked up once (kept on the request). null = switched off. */
function evidenceOf(req) {
  if (CALLER.mode === 'off' && !CALLER.tripwire) return Promise.resolve(null);
  // the peer as the source guard saw it when the request arrived: a socket its sender has reset
  // reports no address at all. `closed` lets the lookup ask the board's own socket whether the
  // sender has left (src/caller.mjs: kind 'gone').
  const peer = req.peer || { address: req.socket.remoteAddress, port: req.socket.remotePort, localPort: req.socket.localPort };
  req.callerEvidence ||= callerEvidence.of({ remoteAddress: peer.address, remotePort: peer.port, localPort: peer.localPort,
    closed: () => ({ destroyed: req.socket.destroyed, ended: req.socket.readableEnded }) })
    .then(async (e) => (e.kind === 'agent' ? { ...e, name: await nameOfWs(e.workspaceId) } : e))
    .catch((e) => ({ kind: 'unknown', agentAncestor: false, browser: false, why: String(e.message) }));
  return req.callerEvidence;
}
/** A short, printable "who" for an evidence record (a name, a role, or what kind of caller). */
const callerWho = (e) => (!e ? 'off' : e.kind === 'agent' ? (e.name || `an unregistered session (workspace ${String(e.workspaceId).slice(0, 8)})`) : e.kind === 'job' ? e.name : e.kind === 'gone' ? 'a sender that has left' : e.agentAncestor ? 'an agent process (no session named)' : e.kind);
const doorNoticeAt = new Map();          // who → last time Mission Control was told (at most one notice per 5 min each)

/**
 * The decision door (src/caller.mjs doorVerdict): may this request make an owner decision?
 * Rule 1: an agent session behind it → refused, named, and Mission Control is told.
 * Rule 2: a local decision not from a browser → refused under tripwire 'browser'; under 'agent'
 * it is only logged ("would refuse"), which is the reading before that switch is turned up.
 * A sender that has LEFT (it did not wait for its answer: kind 'gone') is judged like rule 2.
 * The one thing rule 2 keeps instead of refusing: an approval of one gate typed in a terminal
 * (`typedApproval`). It becomes a row the owner confirms on the board; nothing is decided.
 * Another device and a failed lookup pass — and every decision that passes with no evidence of
 * its sender (a failed lookup, or a sender that has left under 'agent') leaves a log line and a
 * ticker line of its own, and is counted: a pass without evidence must be visible one by one.
 * → { ev, typed } (ev null when the door is off).
 */
async function decisionDoor(req, what, { typedApproval = false } = {}) {
  if (!CALLER.tripwire) return { ev: null, typed: false };
  const ev = await evidenceOf(req);
  const v = doorVerdict(ev, CALLER.tripwire, { typedApproval });
  // what the board saw, in every door line: the program, the kind of caller, and why it was called that
  const from = `${path.basename(ev?.exe || '?')} pid ${ev?.pid ?? '?'} [${ev?.kind ?? 'none'}: ${String(ev?.why || '').slice(0, 140)}]`;
  const iso = new Date().toISOString();
  if (v.would === 'typed') { callerStats.wouldKeepTyped += 1; console.log(`${iso} [door] would keep as a row to confirm (a typed approval, not a browser): ${what} from ${from}`); }
  else if (v.would) { callerStats.wouldRefuse += 1; console.log(`${iso} [door] would refuse (${v.would === 'gone' ? 'its sender has left' : 'not a browser'}): ${what} from ${from}`); }
  if (v.typed) {
    // not refused and not decided: the handler hands it to the ledger as a row to confirm (and counts it once it is kept)
    console.log(`${iso} [door] a typed approval, not a browser — goes to the board as a row to confirm: ${what} from ${from}`);
    return { ev, typed: true };
  }
  if (!v.refuse) {
    if (ev && (ev.kind === 'unknown' || ev.kind === 'gone')) {
      callerStats.passedNoEvidence += 1;
      callerStats.lastNoEvidence = { at: iso, what, kind: ev.kind, why: String(ev.why || '').slice(0, 160) };
      console.log(`${iso} [door] passed WITHOUT evidence of its sender (${ev.kind}): ${what} — ${ev.why}`);
      recordEvent('bad', `decision door: ${what} passed without evidence of its sender (${ev.kind === 'gone' ? 'the sender left before the board could look' : 'the lookup failed'})`).catch(() => {});
    }
    return { ev, typed: false };
  }
  const who = callerWho(ev);
  if (v.refuse === 'agent') {
    callerStats.refusedAgent += 1;
    console.log(`${iso} [door] refused: ${who} is behind ${what} (${from})`);
    recordEvent('bad', `decision door: ${what} REFUSED — ${who} is behind the request (decisions are ${OWNER.name}'s, on the board page)`).catch(() => {});
    if (Date.now() - (doorNoticeAt.get(who) || 0) > 5 * 60e3) {
      doorNoticeAt.set(who, Date.now());
      meshDeliver('mission-control', `decision door: a request for ${what} came from ${who} and was refused. Decisions are ${OWNER.name}'s, made on the board page.`, { from: 'board', kind: 'cc' }).catch(() => {});
    }
  } else if (v.refuse === 'gone') {
    callerStats.refusedGone += 1;
    console.log(`${iso} [door] refused (its sender has left): ${what} from ${from}`);
    recordEvent('bad', `decision door: ${what} REFUSED — its sender left before the board could see who it was`).catch(() => {});
  } else {
    callerStats.refusedNotBrowser += 1;
    console.log(`${iso} [door] refused (not a browser): ${what} from ${from}`);
    recordEvent('bad', `decision door: ${what} REFUSED — it did not come from a browser (${path.basename(ev?.exe || '?')})`).catch(() => {});
  }
  throw new MeshError(403, v.msg);
}

/**
 * Observe: note a declared name that the calling process does not back. It changes no answer.
 * It is AWAITED, before the answer goes out: a command-line caller exits the moment it has its
 * answer, and a lookup that starts after that finds nobody (measured: 6 of 6). So a ledger or mesh
 * write waits for the lookup, about 160 ms, and never longer than the lookup's own budget.
 * A name used from a plain terminal or a scheduled script is logged; one agent using ANOTHER
 * agent's name also reaches the ticker.
 */
async function noteCaller(req, declared, what) {
  if (CALLER.mode !== 'observe') return;                   // 'on' checks the name before it answers (nameCheck)
  try {
    const ev = await evidenceOf(req);
    if (!ev || ev.kind === 'remote' || ev.kind === 'unknown') return;
    const d = String(declared || '').toLowerCase();
    if (isOwner(d)) return;                                // the owner's name has its own rule: the decision token
    const proven = (ev.kind === 'agent' && ev.name === d) || (ev.kind === 'board' && d === 'board') || (ev.kind === 'job' && ev.name === d);
    if (proven) return;
    callerStats.mismatches += 1;
    callerStats.lastMismatch = { at: new Date().toISOString(), what, declared: d, caller: callerWho(ev) };
    console.log(`${new Date().toISOString()} [caller mismatch] ${what}: declared "${d}", the calling process is ${callerWho(ev)} (${ev.why})`);
    if (ev.kind === 'agent') recordEvent('sys', `[caller mismatch] ${what}: declared "${d}", but the call came from ${callerWho(ev)}`).catch(() => {});
  } catch { /* a reading only: it never fails the request */ }
}

/**
 * Names enforced (SETTINGS.callerEvidence mode 'on'): is the declared name backed by the calling
 * process (src/caller.mjs nameVerdict)? In observe and off a name is self-declared, as before 1.3,
 * and this says "proven" without looking.
 * An unproven name is logged, counted and put on the ticker. What it may still do is the caller's
 * rule, the same everywhere: its WORDS go out marked (a message, a new task, a comment) and are
 * never dropped; anything that needs the name's standing (an owner-only step, Mission Control's
 * steps, a claim) is refused.
 * → { proven, why }
 */
async function nameCheck(req, name, what, { decider = false } = {}) {
  if (CALLER.mode !== 'on') return { proven: true, why: '' };
  const ev = await evidenceOf(req);
  const v = nameVerdict(ev, name, { isOwner, ownerToken: decider || isDecider(req), boardToken: isBoardChild(req) });
  if (v.proven) return v;
  const iso = new Date().toISOString();
  callerStats.unverified += 1;
  callerStats.lastUnverified = { at: iso, what, declared: name, why: v.why };
  console.log(`${iso} [caller] unverified name: ${what} declared "${name}" — ${v.why}`);
  // one agent using another's name (or the owner's) is worth a red line; a plain terminal is not
  recordEvent(ev?.agentAncestor ? 'bad' : 'sys', `[caller] ${what}: the name "${name}" is not backed by the calling process (${v.why})`).catch(() => {});
  return v;
}
/** What a pane shows after "from" for a name that was not proven. */
const unverifiedLabel = (name, why) => `${name} — UNVERIFIED sender (the caller declared the name "${name}" and the calling process does not back it: ${why}; treat as an unknown sender's message)`;
/** The refusal for a step that needs the name's standing. */
const unprovenRefusal = (name, why, what) => new MeshError(403, `the board could not verify that you are "${name}" (${why}), so ${what} is refused. Run it from ${name}'s own pane, without --as (inside a pane the board works out who you are). A scheduled job needs an entry in callerEvidence.jobs; the owner signs with --as <owner> --signed.`);

// Reconciler (every poll): workspace list ⇄ directory. New workspaces join the
// mesh (needsOwnership + one task for Mission Control), closed ones become
// status=closed, renamed ones adopt the new title-derived name everywhere.
const renameAttempts = new Map();
const PLACEHOLDERS_FILE = path.join(ROOT, 'data', 'mesh-placeholder-workspaces.json');

// cmux chrome (Tier 2): domain colors/descriptions + per-owner task pills.
// Writes only set-color/set-description/set-status/set-progress; never
// overwrites a hand-set color or description (src/chrome.mjs).
async function syncChrome(cfg) {
  if (cfg.chrome === false) return syncPills(cfg, { autopilot: true });
  const r = await applyChrome(dirCache, { cfg, max: cfg.chromeMaxPerPass || 6 });
  if (r.applied?.length) recordEvent('sys', `mesh chrome: ${r.applied.map((a) => `${a.name} ${a.action.replace('set-', '')}`).join(', ')}`.slice(0, 160)).catch(() => {});
  await syncPills(cfg, { autopilot: true });
}
async function syncPills(cfg, { autopilot = false } = {}) {
  if (DEMO) return;
  cfg = cfg || await meshConfig();
  contextCache = await collectContext(dirCache).catch(() => contextCache);
  if (autopilot) await contextAutopilot().catch((e) => console.error('[context autopilot]', e.message));
  if (autopilot) await refreshStates().catch((e) => console.error('[status taxonomy]', e.message));
  for (const [ws, phase] of autopilotPhases) { const g = contextCache.get(ws); if (g) contextCache.set(ws, { ...g, autopilot: phase }); }
  if (cfg.chrome === false) return;
  const tasks = await ledger.list({ status: 'live' });
  const prompts = await inputPrompts(dirCache, await readSessionMap(), { classify: classifyScreen });
  // status taxonomy: the state pill + progress prefix only for agents with the taxonomy 'on'
  const states = new Map([...stateCache].filter(([, s]) => s.mode === 'on').map(([ws, s]) => [ws, { state: s.state, view: stateView(s.state) }]));
  const snoozed = snoozeMode(SETTINGS.attention) === 'on' ? snoozedByTask(attentionView()) : new Map();
  // mesh.json titleInLabel (default true): the task title rides in the progress label for custom sidebars (#416)
  // an N-task label names one headline task, the agent's guardrails focus first (#416 live reading)
  const focusMap = await gates.store.focus().catch(() => ({}));
  const focusFor = (name) => focusOf(focusMap, name)?.task ?? null;
  const changed = await applyPills(dirCache, tasks, { prompts, ctx: contextCache, states, titleInLabel: cfg.titleInLabel !== false, snoozed, focusFor });
  if (changed.length) console.log('[mesh pills]', changed.map((c) => `${c.name}=${c.pill}`).join(', '));
}
// Status taxonomy (#402, src/agent-state.mjs, SETTINGS.statusTaxonomy): per agent state + source +
// confidence, from the hook files (pid-verified) and BOUNDED screen reads (cap per poll, 2-min cache,
// only where the hook can't answer). Display + API only — delivery/autopilot/heal keep their own.
// observe: /api/agents carries it, ticker lines on source changes / unknown, and a read-count line
// every 10 min; on: + tiles, Dock, the state pill and the sidebar's progress prefix.
let stateCache = new Map();                 // workspaceId → { state, mode }
const stateLog = new Map();                 // agent → last observe line
const stateReads = { since: Date.now(), polls: 0, reads: 0, max: 0, unknown: 0 };
let screenReader = null;
const readJsonQuiet = async (f) => JSON.parse(await readFile(f, 'utf8').catch(() => '{}'));
async function refreshStates() {
  const cfg = SETTINGS.statusTaxonomy;
  if (!cfg || !['observe', 'on'].includes(cfg.mode)) { stateCache = new Map(); return; }
  const now = Date.now();
  const fresh = cfg.runningFreshMinutes || 20;
  screenReader ||= createScreenReader({ read: (ws) => cmux(['read-screen', '--workspace', ws]), classify: classifyScreen, cap: cfg.maxReadsPerPoll || 8, ttlMs: (cfg.readCacheSeconds || 120) * 1000 });
  const claude = await readSessionMap().catch(() => ({}));
  const codex = await readJsonQuiet(path.join(os.homedir(), '.cmuxterm', 'codex-hook-sessions.json'));
  const procs = parseProcStarts((await sh('ps', ['-A', '-o', 'pid=,lstart='])).out);
  const rows = dirCache.filter((a) => a.workspaceId && a.status !== 'closed' && a.kind !== 'headless' && taxonomyMode(cfg, a.name) !== 'off')
    .map((a) => { const hook = hookFor(a.workspaceId, { claude, codex }); return { a, hook, pid: pidCheck(hook, procs) }; });
  const wants = rows.filter((r) => needsScreen(r.a, r.hook, r.pid, { now, runningFreshMinutes: fresh })).map((r) => r.a.workspaceId);
  const { results, reads } = await screenReader.refresh(wants, now);
  const next = new Map();
  const named = [];
  for (const r of rows) {
    const state = agentState({ hook: r.hook, pid: r.pid, screen: results.get(r.a.workspaceId) || null, now, runningFreshMinutes: fresh });
    next.set(r.a.workspaceId, { state, mode: taxonomyMode(cfg, r.a.name) });
    named.push({ name: r.a.name, state });
  }
  stateCache = next;
  Object.assign(stateReads, { polls: stateReads.polls + 1, reads: stateReads.reads + reads, max: Math.max(stateReads.max, reads), unknown: named.filter((x) => x.state.state === 'unknown').length });
  if (cfg.mode === 'observe') {
    for (const line of observeLines(named, stateLog, { now })) recordEvent('sys', line).catch(() => {});
    if (now - stateReads.since >= 600000) {
      recordEvent('sys', `status (observe): ${stateReads.reads} screen reads over ${stateReads.polls} polls (max ${stateReads.max}/poll, cap ${cfg.maxReadsPerPoll || 8}) · ${rows.length} agents · ${stateReads.unknown} unknown`).catch(() => {});
      Object.assign(stateReads, { since: now, polls: 0, reads: 0, max: 0 });
    }
  }
}

// Context autopilot (#351, src/context-autopilot.mjs): warn at CONTEXT.warnPct, /compact at the
// next READY pane at compactPct once the state is saved (forcePct: even without), then resume.
const CONTEXT_STATE_FILE = path.join(ROOT, 'data', 'context-state.json');
let autopilotPhases = new Map();       // workspaceId → 'saving state' | 'compacting' | 'compact failed' (pill text)
async function contextAutopilot() {
  const cfg = SETTINGS.contextAutopilot;
  if (!cfg || !['observe', 'on'].includes(cfg.mode)) { autopilotPhases = new Map(); return; }
  const liveOf = (a) => ledger.list({ status: 'live' }).then((ts) => ts.filter((t) => t.owner === a.name));
  const r = await runAutopilot(dirCache, {
    ctx: contextCache, cfg, t: autopilotThresholds(CONTEXT, cfg), stateFile: CONTEXT_STATE_FILE,
    focusFor: async (a) => {
      const f = focusOf(await gates.store.focus().catch(() => ({})), a.name)?.task;
      const mine = await liveOf(a);
      if (f && mine.some((t) => t.id === f)) return f;
      const working = mine.filter((t) => t.status === 'in_progress');
      return working.length === 1 ? working[0].id : null;
    },
    commentAt: async (a, since) => {
      let best = 0;
      for (const t of await liveOf(a)) for (const c of t.comments || []) {
        const at = Date.parse(c.at);
        if (c.who === a.name && at > since && at > best) best = at;
      }
      return best;
    },
    compact: (a) => deliverNow(a, '/compact').catch((e) => ({ queued: e.message })),
    tell: (a, text, taskId) => meshDeliver(a.name, text, { from: 'board', taskId, kind: 'context', wake: true }),
    tellMC: (text, taskId) => meshDeliver('mission-control', text, { from: 'board', taskId, kind: 'context' }),
    comment: (taskId, text) => ledger.update(taskId, { op: 'comment', actor: 'board', text }).catch(() => {}),
    event: (k, text) => recordEvent(k, text).catch(() => {}),
  });
  autopilotPhases = r.phases;
  if (r.changed.length) console.log('[context autopilot]', r.changed.map((c) => `${c.name}=${c.action}@${c.pct}%`).join(', '));
}
async function reconcileMesh() {
  const [workspaces, sessionMap, registry, groups] = await Promise.all([
    listWorkspaces(), readSessionMap(), readRegistry(), listGroups()]);
  if (!workspaces.length) return;          // socket down — never mark the fleet closed
  if (!groups) return;                     // can't tell placeholders from agents — skip this pass
  // remember every workspace ever seen as a cmux-generated anchor: after an
  // ungroup/set-anchor it is no longer an anchor but is still a placeholder
  const seen = new Set(JSON.parse(await readFile(PLACEHOLDERS_FILE, 'utf8').catch(() => '[]')));
  const demoIds = await demoWorkspaceIds();
  const ignoreIds = new Set([...seen, ...generatedAnchorIds(groups, workspaces),
    ...workspaces.filter((w) => isDemoWorkspace(w, demoIds)).map((w) => w.id)]);   // the cmux demo never joins the mesh
  const liveIds = new Set(workspaces.map((w) => w.id));
  const keep = [...ignoreIds].filter((id) => liveIds.has(id));       // forget closed ones
  if (keep.length !== seen.size || keep.some((id) => !seen.has(id))) await writeJsonAtomic(PLACEHOLDERS_FILE, keep);
  let changes = null;
  await mutateAgents((doc) => {
    const r = reconcile(doc, { workspaces, sessionMap, registry, ignoreIds });
    changes = r.changes;
    return r.doc;
  });
  await refreshDir();
  for (const a of changes.added) {
    recordEvent('sys', `mesh: new workspace joined — ${a.name} (${a.vendor}); needs ownership`).catch(() => {});
    const task = await ledger.create({
      title: `Fill in ownership for new workspace "${a.title}" (${a.name})`,
      requester: 'board', owner: resolveTarget('mission-control', dirCache).agent?.name || null,
      owner_ws: resolveTarget('mission-control', dirCache).agent?.workspaceId || null,
      body: `Auto-registered in config/agents.json (workspaceId ${a.workspaceId}, vendor ${a.vendor}, cwd ${a.cwd || '?'}). Set owns/repo/kind and clear needsOwnership.`,
    }).catch(() => null);
    if (task?.owner) await afterTaskChange(task, { wake: [task.owner] }, 'board');
  }
  for (const a of changes.purged) recordEvent('sys', `mesh: dropped placeholder ${a.name} (cmux-generated group anchor, not an agent)`).catch(() => {});
  for (const a of changes.closed) recordEvent('sys', `mesh: workspace closed — ${a.name} (kept in directory as closed)`).catch(() => {});
  for (const r of changes.renamed) recordEvent('sys', `mesh: renamed ${r.from} → ${r.to} ("${r.title}")`).catch(() => {});
  const nameByWs = new Map(dirCache.filter((a) => a.workspaceId).map((a) => [a.workspaceId, a.name]));
  const synced = await ledger.syncNames(nameByWs);
  if (synced.length) await refreshWork();

  const cfg = await meshConfig();
  await syncChrome(cfg).catch((e) => console.error('[mesh chrome]', e.message));
  if (!cfg.autoRename) return;
  let n = 0;
  for (const a of nameDrift(dirCache)) {
    if (n >= (cfg.renameMaxPerPass || 3)) break;
    if (Date.now() - (renameAttempts.get(a.workspaceId) || 0) < (cfg.renameCooldownMin || 10) * 60e3) continue;
    renameAttempts.set(a.workspaceId, Date.now());
    n += 1;
    const r = await ensureSessionName(a).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) recordEvent('sys', `mesh: session /rename ${r.from} → ${r.to}`).catch(() => {});
  }
}

// Approvals are the owner's: the board page carries a per-install token (read
// from data/, injected into index.html). Agents are told never to use it; this
// is a speed bump + audit trail, not a boundary against same-user processes.
const DECISION_TOKEN_FILE = path.join(ROOT, 'data', 'mesh-decision-token');
// demo mode: an ephemeral token, never read from or written to data/
let decisionToken = DEMO ? randomBytes(24).toString('hex') : (await readFile(DECISION_TOKEN_FILE, 'utf8').catch(() => '')).trim();
if (!decisionToken) {
  decisionToken = randomBytes(24).toString('hex');
  await writePrivate(DECISION_TOKEN_FILE, decisionToken);
}
// One id per board process: injected into the page and sent with every snapshot,
// so a tab left open across a restart can tell it is stale.
const BOOT_ID = randomBytes(6).toString('hex');
const VERSION = versionInfo({ root: ROOT });                 // GET /api/version (a promise; awaited per request)
const isDecider = (req) => {
  const got = Buffer.from(String(req.headers['x-mesh-decision'] || ''));
  const want = Buffer.from(decisionToken);
  return got.length === want.length && timingSafeEqual(got, want);
};

// Chat intake (task #223): the intake process (scripts/chat-intake.mjs) proves
// itself with its own token (data/intake-token, 0600, never in a page or a
// prompt). It may only file a listed person's request or reply — never decide.
const INTAKE_TOKEN_FILE = path.join(ROOT, 'data', 'intake-token');
const INTAKE_OUTBOX_FILE = path.join(ROOT, 'data', 'intake-outbox.json');
let intakeToken = DEMO ? randomBytes(24).toString('hex') : (await readFile(INTAKE_TOKEN_FILE, 'utf8').catch(() => '')).trim();
if (!intakeToken) {
  intakeToken = randomBytes(24).toString('hex');
  await writePrivate(INTAKE_TOKEN_FILE, intakeToken);
}
// The board's own child processes (scripts it runs, e.g. the CI cost reading) prove themselves with
// a per-boot token they inherit through the environment; only then is the sender name "board" taken
// as the board's. Never written to disk, never in a page.
const boardToken = randomBytes(24).toString('hex');
process.env.MESH_BOARD_TOKEN = boardToken;
const isBoardChild = (req) => {
  const got = Buffer.from(String(req.headers['x-mesh-board'] || ''));
  const want = Buffer.from(boardToken);
  return got.length === want.length && timingSafeEqual(got, want);
};
// how far a sender name is believed when its words reach a pane (src/request-guard.mjs senderTrust)
const trustOf = (name, req, { decider = false, intake = false } = {}) =>
  senderTrust(name, { isOwner, decider: decider || isDecider(req), intake, inProcess: isBoardChild(req) });
const isIntake = (req) => {
  const got = Buffer.from(String(req.headers['x-mesh-intake'] || ''));
  const want = Buffer.from(intakeToken);
  return got.length === want.length && timingSafeEqual(got, want);
};
const readIntakeOutbox = async () => { try { return JSON.parse(await readFile(INTAKE_OUTBOX_FILE, 'utf8')); } catch { return []; } };
let intakeChain = Promise.resolve();
/** Queue publisher lines for a chat-originated task's thread (pulled by the intake). */
function queueIntake(prev, task) {
  if (!isChatTask(task) || DEMO) return;
  const lines = publishLines(prev, task, { ownerName: OWNER.name, isPerson: (x) => isPrincipal(x), isOwnerId: isOwner });
  if (!lines.length) return;
  intakeChain = intakeChain.then(async () => {
    const week = Date.now() - 7 * 24 * 3600e3;
    const box = (await readIntakeOutbox()).filter((m) => m.queuedAt > week);
    for (const l of lines) {
      box.push({ id: randomBytes(6).toString('hex'), taskId: task.id, channel: task.source.channel, thread_ts: task.source.ts,
        channel_name: task.source.channel_name || null, text: l.text, status: l.status, queuedAt: Date.now() });
    }
    await writeJsonAtomic(INTAKE_OUTBOX_FILE, box);
  }).catch((e) => console.error('[intake outbox]', e.message));
}

/** Wake/notify one agent: type it now if its pane is ready, else queue. */
// Asks nobody sees (#787 part 3, src/read-asks.mjs, SETTINGS.readAsks): an owner agent's comment that
// asks for a read or a go, with no message to Mission Control after it, wakes Mission Control once
// after 10 min. State in data/read-asks-state.json (the board is the only writer, one chain).
// A demo board keeps it in memory only: demo boards started together share data/, and a file there
// would carry one board's records into another.
const READ_ASKS_FILE = DEMO ? null : path.join(ROOT, 'data', 'read-asks-state.json');
let readAsks = null;                       // { told, sent, seeded } once loaded
let readAsksChain = Promise.resolve();
const readAsksStep = (fn) => { const p = readAsksChain.then(fn, fn); readAsksChain = p.catch(() => {}); return p; };
async function loadReadAsks() { readAsks ||= READ_ASKS_FILE ? await readAsksState(READ_ASKS_FILE) : { told: {}, sent: {}, seeded: true }; return readAsks; }
const saveReadAsks = (st) => (READ_ASKS_FILE ? writeJsonAtomic(READ_ASKS_FILE, { told: st.told, sent: st.sent }) : Promise.resolve());
function noteAskSent(taskId, from) {
  if (readAsksMode(SETTINGS.readAsks) !== 'on') return Promise.resolve();
  return readAsksStep(async () => {
    const st = await loadReadAsks();
    readAsks = { ...noteSent(st, { task: Number(taskId), from, at: new Date().toISOString() }), seeded: st.seeded };
    await saveReadAsks(readAsks);
  });
}
function readAsksPass() {
  return readAsksStep(async () => {
    const st = await loadReadAsks();
    const tasks = await ledger.list();
    const mcNames = new Set(['mission-control', ...dirCache.filter((a) => a.kind === 'mission-control').map((a) => a.name)]);
    const notAgent = (n) => mcNames.has(n) || n === 'board' || isOwner(n) || isPrincipal(n);
    const { wake } = findAsks(tasks, st, { notAgent });
    const liveIds = new Set(tasks.filter((t) => !['done', 'cancelled'].includes(t.status)).map((t) => t.id));
    const at = new Date().toISOString();
    if (!st.seeded) {
      // first pass with no state file: the asks already on the ledger are old news; mark them, wake nobody
      readAsks = { ...settleState(st, { told: wake.map((w) => w.key), liveIds, at }), seeded: true };
      await saveReadAsks(readAsks);
      // (the board has no record of messages sent before this pass, so it cannot tell whether they were answered;
      // the ids are named so Mission Control can look)
      if (wake.length) recordEvent('sys', `read asks: first pass, ${wake.length} ask(s) already on the ledger marked, nobody woken: ${wake.map((w) => `#${w.task}`).join(' ')}`).catch(() => {});
      return;
    }
    for (const w of wake) {
      recordEvent('bad', `read asks: ${askText(w)}`).catch(() => {});
      await meshDeliver('mission-control', askText(w), { from: 'board', taskId: w.task, kind: 'read-ask' }).catch((e) => console.error('[read-asks] wake:', e.message));
    }
    const next = { ...settleState(st, { told: wake.map((w) => w.key), liveIds, at }), seeded: true };
    const changed = wake.length || Object.keys(next.told).length !== Object.keys(st.told).length || Object.keys(next.sent).length !== Object.keys(st.sent).length;
    readAsks = next;
    if (changed) await saveReadAsks(readAsks);
  });
}

async function meshDeliver(to, text, { from = 'board', fromLabel = null, taskId = null, wake = false, kind = 'message', ref = null } = {}) {
  const dir = await refreshDir();
  const r = resolveTarget(to, dir);
  if (!r.agent) return { ok: false, msg: r.error, candidates: r.candidates };
  const agent = r.agent;
  if (agent.name === from) return { ok: true, msg: 'not delivering to self', skipped: true };
  // #787 part 3: an agent that messages Mission Control about a task has asked in a way that wakes it.
  // Recorded before delivery is tried (delivered or queued, the ask was sent), and on a demo board too.
  if (taskId && from !== 'board' && agent.kind === 'mission-control') await noteAskSent(taskId, from).catch((e) => console.error('[read-asks]', e.message));
  if (DEMO) {
    recordEvent('sys', `demo: would type into ${agent.name}: ${String(text).slice(0, 80)}`).catch(() => {});
    return { ok: true, demo: true, to: agent.name };
  }
  const line = formatWake({ from: fromLabel || from, text, taskId });   // fromLabel: a reserved name that was not proven, marked
  const res = await deliverNow(agent, line, { wake }).catch((e) => ({ queued: e.message }));
  if (res.delivered) {
    recordEvent('sys', `mesh: ${from} → ${agent.name}${taskId ? ` (#${taskId})` : ''}: ${String(text).slice(0, 80)}`).catch(() => {});
    return { ok: true, delivered: true, to: agent.name };
  }
  const taskStatus = taskId ? (await ledger.get(taskId))?.status || null : null;   // status when queued (staleness check)
  await enqueue({ to: agent.name, line, wake, from, taskId, kind, ...(ref ? { ref } : {}), taskStatus, queuedAt: Date.now(), attempts: 0, lastReason: res.queued });
  recordEvent('sys', `mesh: queued for ${agent.name} (${res.queued})`).catch(() => {});
  return { ok: true, queued: true, reason: res.queued, to: agent.name };
}

async function afterTaskChange(task, { events = [], wake = [], notifyMC = [], wakeKind = 'assigned', note = null, noteBoard = false, wakeRef = null }, actor, { fromLabel = null } = {}) {
  for (const e of events) recordEvent(e.includes('BLOCKED') || e.includes('DECLINED') || e.includes('REJECTED') ? 'bad' : 'sys', e).catch(() => {});
  const deliveries = [];
  // never wake the actor itself — also when it acted under an alias
  // (e.g. the "mission-control" role alias → its real directory name)
  const me = resolveTarget(actor, dirCache).agent?.name || actor;
  for (const who of wake) {
    if ((resolveTarget(who, dirCache).agent?.name || who) === me) continue;
    const kind = wakeKind || 'assigned';
    // a gate decision is delivered INSIDE a busy session (cmux queues it for the next turn): the
    // approval has a clock on it, and waiting for an idle pane let one expire unused (#343 g8)
    // a hold ("not approved yet") keeps its kind and says what it is about: never replaced in the
    // outbox by a later message, dropped by the drain once that gate or request is decided
    deliveries.push(await meshDeliver(who, wakeMessage(task, kind, { note, noteBoard }), {
      from: actor, fromLabel, taskId: task.id, kind: kind === 'comment' ? 'message' : kind, wake: kind === 'gate', ref: kind === 'hold' ? wakeRef : null }));
  }
  // Mission Control is cc'd only on approvals, blocks and cross-domain conflicts
  for (const why of notifyMC) {
    const mc = resolveTarget('mission-control', dirCache).agent;
    if (mc && (task.owner === mc.name || actor === mc.name)) continue;
    const what = why === 'approval' ? `needs ${OWNER.name}'s approval` : why === 'gate' ? `has a gate waiting on ${OWNER.name} (FYI — gates are the owner's to decide)`
      // #627: an approved Codex call was released and its result never came back (a "no" at the pane, or the call ended without one)
      : why === 'not_seen' ? `has an approved call that was released and not seen to run (${(task.gates || []).filter((x) => x.not_seen_at && !x.ran_at).map((x) => x.id).pop() || 'a gate'})` : 'is blocked';
    // an intake task's title is outside text: the cc carries the id and the source only
    deliveries.push(await meshDeliver('mission-control', `cc: task #${task.id} ${what} (${task.owner})${outsideTask(task) ? ` — ${sourceLabel(task)}` : `: ${task.title}`}`, { from: actor, fromLabel, taskId: task.id, kind: why === 'approval' ? 'approval' : 'cc' }));
  }
  if (notifyMC.includes('gate')) {
    const g = (task.gates || []).filter((x) => x.status === 'pending').pop();
    notify('Ops Board · gate waiting', `task #${task.id}`, `${g?.agent || task.owner}: ${g?.label || 'gated action'} — approve on the WORK panel`).catch(() => {});
  }
  if (notifyMC.includes('approval')) {
    notify('Ops Board · approval needed', `task #${task.id}`, `${task.owner}: ${task.title} — ${task.approval?.policy_item}`).catch(() => {});
  }
  if (notifyMC.length) relayNow().catch((e) => console.error('[relay]', e.message));
  await refreshWork();
  syncPills().catch((e) => console.error('[mesh pills]', e.message));
  return deliveries;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 64 * 1024) { reject(new MeshError(413, 'body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new MeshError(400, 'invalid JSON')); } });
});
// a stray rejection is logged with a timestamp and the board stays up; an uncaught
// exception is logged, then the process exits for the supervisor to restart it
const procHealth = installProcessHandlers();

const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

let current = { at: 0, jobs: [], counts: { ok: 0, attention: 0, total: 0 } };
let history = { fleet: [], perJob: {} };            // fleet: [{at, okPct}], perJob: {label: [status,...]}
const sseClients = new Set();

if (DEMO) history = demoHistory();
else try { history = JSON.parse(await readFile(HISTORY_FILE, 'utf8')); } catch { /* fresh start */ }

function recordHistory(snap) {
  history.fleet.push({ at: snap.at, okPct: snap.counts.total ? snap.counts.ok / snap.counts.total : 1 });
  history.fleet = history.fleet.slice(-SETTINGS.fleetHistorySamples);
  for (const j of snap.jobs) {
    const arr = history.perJob[j.label] || [];
    arr.push(j.status);
    history.perJob[j.label] = arr.slice(-SETTINGS.historySamples);
  }
}

// The digest's day lives in a state file: a restart after the digest hour neither
// skips nor repeats the briefing (src/poll-health.mjs digestDue). Demo never reads or writes it.
const DIGEST_FILE = path.join(ROOT, 'data', 'digest-state.json');
let digestState = DEMO ? null : await readDigestState(DIGEST_FILE);
let digestFirstStart = !digestState;
let digestSending = false;
const saveDigest = () => writeDigestState(DIGEST_FILE, digestState).catch((e) => console.error('[digest] state', e.message));

// each poll stage in its own try with its own timer (GET /api/status → poll.stages)
const stages = createStages();

// self-heal/remediation messages land in the ticker as well as the cmux Feed
const notifyLog = (title, subtitle, body) => {
  recordEvent('sys', `${subtitle ? subtitle + ': ' : ''}${body}`).catch(() => {});
  return notify(title, subtitle, body);
};

const prevStatus = new Map();
let eventsCache = [];
let starDoc = await readStar();

// the first success moment queues the one-time star toast (src/star.mjs)
const celebrate = (reason) => successMoment(reason)
  .then(async (queued) => { if (queued) starDoc = await readStar(); })
  .catch((e) => console.error('[star]', e.message));

// demo: one tick of the scripted story — status changes come from the snapshot,
// the beats add the self-heal, the needs-input moment and a closed task
let demoLastTick = Date.now();
async function demoTick(snap) {
  contextCache = demoContext(snap.at);
  const beats = demoBeats(demoLastTick, snap.at);
  demoLastTick = snap.at;                  // advance first: a failing beat must never replay every tick
  for (const beat of beats) {
    try {
      await recordEvent(beat.kind, beat.text);
      if (beat.success) await celebrate(beat.success);
      if (beat.closeTask) {
        const t = await ledger.create({ title: `Triage pass ${new Date(snap.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, requester: 'board', owner: 'mission-control' });
        await ledger.update(t.id, { op: 'close', actor: 'mission-control', checklist: 'all', links: { handoff: 'data/handoffs/triage.report.md' }, text: 'clean pass' });
        await recordEvent('good', `task #${t.id} DONE by mission-control: ${t.title}`);
      }
      if (beat.gate) await demoGate(beat.gate);
    } catch (e) { console.error('[demo beat]', e.message); }
  }
}

// Demo guardrails beat: the same ledger gate records a real gate makes (nothing runs)
let demoGateRef = null;
async function demoGate(step) {
  if (step === 'file') {
    const t = await ledger.create({ title: 'Ship the pricing page', requester: 'mission-control', owner: DEMO_GATE.agent });
    await ledger.update(t.id, { op: 'start', actor: DEMO_GATE.agent });
    const u = await ledger.update(t.id, { op: 'gate_request', actor: 'board', gate: { cls: 'deploy', label: 'Deploy or (re)load production services', why: 'vercel deploy --prod',
      command: DEMO_GATE.command, bin: 'vercel', cwd: DEMO_GATE.cwd, tool: 'Bash', engine: 'claude', agent: DEMO_GATE.agent, cmdHash: 'demo', ttlMinutes: 30 } }, { gateSystem: true });
    demoGateRef = { task: t.id, gate: u.task.gates.at(-1).id };
    await refreshWork();
  } else if (step === 'approve' && demoGateRef) {
    const t = await ledger.get(demoGateRef.task);
    const g = t?.gates?.find((x) => x.id === demoGateRef.gate);
    if (g?.status === 'pending') await ledger.update(t.id, { op: 'gate_decide', actor: OWNER.id, gate: g.id, decision: 'approve' }, { decider: true, from: 'phone/tailnet' });
    const now = await ledger.get(demoGateRef.task);
    if (now.gates.find((x) => x.id === demoGateRef.gate)?.status === 'approved') {
      await ledger.update(now.id, { op: 'gate_event', actor: 'board', gate: demoGateRef.gate, event: 'executed' }, { gateSystem: true });
      await recordEvent('sys', `demo: would run \`${DEMO_GATE.command}\` once (single-use grant) — receipt on #${now.id}`);
    }
    demoGateRef = null;
    await refreshWork();
  }
}

/** The 08:00 briefing: due once a day, a failed send retried (src/poll-health.mjs digestDue). */
function maybeDigest(snap, now) {
  const dg = digestDue({ now, hour: SETTINGS.escalation.digestHour, state: digestState, firstStart: digestFirstStart });
  digestFirstStart = false;
  if (dg.adopt) { digestState = { day: dg.day, sent: true, adopted: true }; saveDigest(); }
  else if (dg.due && !digestSending) {
    digestSending = true;
    digestState = { day: dg.day, sent: false, tries: (digestState?.day === dg.day ? digestState.tries || 0 : 0) + 1, lastTryAt: now.getTime() };
    stages.run('digest', async () => {
      await saveDigest();                 // the try is on disk before the mail goes: a crash mid-send cannot loop
      const ok = await sendDigest(snap, Object.fromEntries(snap.jobs.map((j) => [j.label, history.perJob[j.label] || []])), workCache, usageLines(currentUsage()));
      console.log('[digest]', ok ? 'sent' : `failed (try ${digestState.tries})`);
      if (ok) { digestState = { ...digestState, sent: true, sentAt: Date.now() }; await saveDigest(); }
    }).finally(() => { digestSending = false; });
  }
}

const FIRST_CARD_WAIT_MS = 3000;
/** Compute the gate card (with the integrity reading where that check is on) and write the file the snapshot reads. */
// A light install on which the gate is seen once (a registered hook, or a gate) is marked in its state file: from
// then on its card is the usual one, and a hook lost later reads MISSING (src/status.mjs gateCard). Tried until the
// state file has been read once without error; a demo board has no state file of its own to mark.
let guardrailsNoted = false;
async function markGuardrailsSeen(c) {
  if (DEMO || guardrailsNoted || !(c.hook || c.gates)) return;
  guardrailsNoted = await noteGuardrailsSeen().then(() => true).catch(() => false);
}
async function writeGateCard() {
  // an approval that ran out since the last poll is marked expired first (#498); a failure here never costs the card
  await gates.expireRunOut().catch((e) => console.error('[guardrails] expiry', e.message));
  const c = await gates.card(await ledger.list({ status: 'live' }));
  await markGuardrailsSeen(c);
  // the integrity check never fails the card: if it cannot run, the card says so
  const integ = integrity ? await gateIntegrityCard().catch((e) => ({ status: 'unknown', state: 'unread', detail: `gate files not checked: ${String(e.message).slice(0, 80)}`, changed: [], behind: [], problems: [] })) : null;
  await writeFile(GATE_CARD_FILE, JSON.stringify({ ...c, ...(integ ? { integrity: integ } : {}), at: Date.now() }));
}

async function poll() {
  try {
    // The snapshot reads the gate card from its file. Guardrails-only: it is the page's one card, so it
    // is computed before every snapshot. Full profile: at the END of each poll, so that it never
    // holds up the fleet's cards; the page is then one poll behind (and a new process's first card is
    // computed before it starts listening, at the bottom of this file).
    if (GUARDRAILS_ONLY) await stages.run('guardrails-card', writeGateCard);
    // 'board-cards' = the Guardrails-only profile's snapshot: the board's own cards, no collector
    const snap = GUARDRAILS_ONLY
      ? await stages.run('board-cards', async () => snapshot())
      : await stages.run('snapshot', async () => (DEMO ? demoSnapshot() : snapshot()));
    if (!snap) return;                      // logged by the stage; the next poll tries again
    current = snap;
    await stages.run('history', async () => {
      recordHistory(snap);
      if (!DEMO) await writeFile(HISTORY_FILE, JSON.stringify(history)).catch(() => {});
      for (const j of snap.jobs) {
        const prev = prevStatus.get(j.label);
        if (prev && prev !== j.status) {
          recordEvent(j.status === 'ok' ? 'good' : 'bad',
            `${j.name} ${prev.toUpperCase()} → ${j.status.toUpperCase()}`).catch(() => {});
        }
        prevStatus.set(j.label, j.status);
      }
    });
    // alerts + the dead-man heartbeat go FIRST, straight after the snapshot: a stall or
    // a throw in the mesh work below must never cost a cycle of alerting
    if (!DEMO) {
      await stages.run('alerts', () => processAlerts(snap));
      await stages.run('heartbeat', () => heartbeat());
    }
    if (DEMO) {
      await stages.run('demo', async () => {
        await demoTick(snap);
        // `--demo --cmux`: drive the ZULU DEMO panes' chrome (no-op without one)
        await syncDemoCmux({ ledger }).catch((e) => console.error('[demo cmux]', e.message));
        await refreshDir();
        await refreshWork();
        eventsCache = await getEvents(30);
      });
      const payload = JSON.stringify(payloadFor());
      for (const res of sseClients) res.write(`data: ${payload}\n\n`);
      return;
    }
    if (GUARDRAILS_ONLY) {
      // the gate card, the ledger, alerts (above), the digest, a newer release, the relay. Nothing else.
      await stages.run('work', () => refreshWork());
      await stages.run('events', async () => { eventsCache = await getEvents(30); });
      const at = new Date();
      maybeDigest(snap, at);
      maybeUpgradeCheck({ cfg: SETTINGS.upgrade, repoUrl: SETTINGS.repoUrl, now: at.getTime(), record: (k, t) => recordEvent(k, t).catch(() => {}) })
        .catch((e) => console.error('[upgrade]', e.message));
      relayNow().catch((e) => console.error('[relay]', e.message));
      const payload = JSON.stringify(payloadFor());
      for (const res of sseClients) res.write(`data: ${payload}\n\n`);
      return;
    }
    await stages.run('mesh-reconcile', () => reconcileMesh());
    stages.run('outbox', () => drainOutbox({
      resolve: async (name) => resolveTarget(name, dirCache).agent || null,
      taskStatus: async (id) => (await ledger.get(id))?.status || null,
      holdOpen: async (m) => (m.taskId && m.ref ? holdOpen(await ledger.get(m.taskId), m.ref) : undefined),
    })
      .then(async ({ delivered, expired, dropped, unreadable = [] }) => {
        // #787 part 2: a pane the board has not been able to read for 5 min: told once per episode,
        // a ticker line always, and Mission Control told unless it is Mission Control's own pane
        // (that notice would queue behind the very screen it is about)
        const mcName = unreadable.length ? resolveTarget('mission-control', dirCache).agent?.name || 'mission-control' : null;
        for (const n of unreadableNotices(unreadable, { mcName, nameOf: (x) => resolveTarget(x, dirCache).agent?.name || null })) {
          await recordEvent('bad', `mesh: ${n.text}`);
          if (n.tellMc) await meshDeliver('mission-control', n.text, { from: 'board', kind: 'unreadable' }).catch((e) => console.error('[mesh] unreadable notice:', e.message));
        }
        for (const m of dropped) await recordEvent('sys', `mesh: dropped stale wake for ${m.to} — ${m.dropReason}`);
        for (const m of delivered) await recordEvent('sys', `mesh: delivered queued message to ${m.to}${m.taskId ? ` (#${m.taskId})` : ''}`);
        for (const m of expired) {
          await recordEvent('bad', `mesh: gave up delivering to ${m.to} after 24h (${m.lastReason || 'never ready'})`);
          if (m.taskId) await ledger.update(m.taskId, { op: 'comment', actor: 'mission-control', text: `undelivered after 24h to ${m.to}: ${m.lastReason || ''}` }).catch(() => {});
        }
      }));
    await stages.run('work', () => refreshWork());
    if (readAsksMode(SETTINGS.readAsks) === 'on' && !DEMO) await stages.run('read-asks', () => readAsksPass());
    await stages.run('events', async () => { eventsCache = await getEvents(30); });
    const diskJob = snap.jobs.find((j) => j.label === 'disk:/');
    if (diskJob) maybeRemediate(diskJob.status, notifyLog).catch((e) => console.error('[remediate]', e.message));
    // password heal first; the restore retry gates itself on a healthy socket,
    // so chaining keeps both halves of a post-reboot recovery in one tick
    // with no cmux on this Mac there is nothing to heal: no stage, no cmux call
    if (CMUX_PRESENT) stages.run('heal', () => maybeHealCmuxBridge(snap.jobs.find((j) => j.label === 'cmux:bridge'), notifyLog)
      .catch((e) => console.error('[heal-cmux]', e.message))
      .then(() => maybeHealFailedRestores({
        log: (text) => recordEvent('sys', text),   // one ticker line per repaired workspace
        notify,                                    // one Feed summary per pass
        // #620: closed entries are never resumed from cmux's record. #678: a resident left bare gets ONE low task to Mission
        // Control per episode (source key = workspace + the cmux launch; the ledger dedupes keys across closed tasks)
        directory: () => dirCache,
        fileBareResident: async (f) => {
          const owns = (await ledger.list({ owner: f.name, status: 'live' })).map((t) => `#${t.id}`);
          const last = f.lastSession;
          const t = await ledger.create({
            title: `Resident ${f.name} is a bare shell since the cmux relaunch (${f.hours} h)`,
            requester: 'board', owner: resolveTarget('mission-control', dirCache).agent?.name || null, priority: 'low',
            source: { via: 'heal-restore', key: f.key },
            body: `Resident ${f.name} (workspace ${f.workspaceId}) has been a bare login shell for ${f.hours} h since the cmux launch of ${f.launchedAt}. `
              + 'Past the 2-hour window the board does not restore a resident on its own. '
              + `Last session written: ${last ? `${last.kind} ${last.sessionId} at ${last.at || 'an unknown time'} (${last.source})` : 'none recorded'}. `
              + `Restore line, typed in its pane: ${f.restore || `none (${f.restoreSkip})`}. `
              + `Live tasks it owns: ${owns.length ? owns.join(', ') : 'none'}. `
              + 'Restore it or close its directory entry; closing or cancelling this task keeps this episode quiet until the next cmux relaunch.',
          });
          if (!t.existing) {
            await afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board');
            await recordEvent('sys', `restore-retry: resident ${f.name} left bare → task #${t.id} (${t.owner || 'no owner'})`).catch(() => {});
          }
          return t;
        },
        // a resumed session re-adopts its title-derived mesh name
        onRepaired: async (ws) => {
          await celebrate(`a dead session restore in "${ws.title || ws.id}" and brought it back`);
          await refreshDir();
          const a = dirCache.find((x) => x.workspaceId === ws.id);
          if (a && (await meshConfig()).autoRename) await ensureSessionName(a).catch(() => {});
        },
      }))
      .catch((e) => console.error('[heal-restore]', e.message)));
    const now = new Date();
    // retention, report only: the size of data/ and its largest folders (digest line + /api/status)
    maybeMeasure({ dir: path.join(ROOT, 'data'), now: now.getTime() }).catch(() => {});
    maybeDigest(snap, now);
    maybeCiCostWatch({ root: ROOT, cfg: SETTINGS.ciCostWatch, now, record: (k, t) => recordEvent(k, t).catch(() => {}) })
      .catch((e) => console.error('[ci-cost]', e.message));
    if (!DEMO) maybeOperatingReading({ cfg: SETTINGS.operatingReading, ledger, owner: OWNER.id, now, record: (k, t) => recordEvent(k, t).catch(() => {}),
      afterCreate: (t) => afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board') })
      .catch((e) => console.error('[operating-reading]', e.message));
    maybeRepoStats({ cfg: SETTINGS.repoStats, now, record: (k, t) => recordEvent(k, t).catch(() => {}) })
      .catch((e) => console.error('[repo-stats]', e.message));
    if (!DEMO) maybeReleaseDrift({ cfg: SETTINGS.releaseDrift, ledger, now: now.getTime(), record: (k, t) => recordEvent(k, t).catch(() => {}),
      afterCreate: (t) => afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board') })
      .catch((e) => console.error('[release-drift]', e.message));
    // one-click upgrade (#346): is a newer public release out? (observe: a ticker line only; on: the update card)
    if (!DEMO) maybeUpgradeCheck({ cfg: SETTINGS.upgrade, repoUrl: SETTINGS.repoUrl, now: now.getTime(), record: (k, t) => recordEvent(k, t).catch(() => {}) })
      .catch((e) => console.error('[upgrade]', e.message));
    // push approvals (#415): re-rings at 30/90 min and the 07:00 catch-up after quiet hours
    relayNow().catch((e) => console.error('[relay]', e.message));
    if (!DEMO) maybeViewWatch({ entries: SETTINGS.viewWatch, secrets: loadSecrets(), now: now.getTime(), record: (k, t) => recordEvent(k, t).catch(() => {}) }).catch(() => {});
    if (!DEMO) maybeBrain({ cfg: SETTINGS.brain, ledger, agents: dirCache, now: now.getTime(), record: (k, t) => recordEvent(k, t).catch(() => {}),
      afterCreate: (t) => afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board') })
      .catch((e) => console.error('[brain]', e.message));
    // a supplier whose documents stop parsing (#456): one high task per failing streak
    if (!DEMO) maybeParserWatch({ cfg: SETTINGS.parserWatch, ledger, secrets: loadSecrets(), now: now.getTime(), record: (k, t) => recordEvent(k, t).catch(() => {}),
      afterCreate: (t) => afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board') })
      .catch((e) => console.error('[parser-watch]', e.message));
    // community issues + discussions on the public repo (#434): one task per thread to MC, text quoted as data, never a reply
    if (!DEMO) maybeGithubIntake({ cfg: SETTINGS.githubIntake, ledger, owner: resolveTarget('mission-control', dirCache).agent?.name || null, now: now.getTime(),
      record: (k, t) => recordEvent(k, t).catch(() => {}), afterCreate: (t) => afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board') })
      .catch((e) => console.error('[github-intake]', e.message));
    if (!DEMO) maybeChannelDiscovery({ stateDir: path.join(ROOT, 'data', 'chat-intake'), ledger,
      owner: resolveTarget('mission-control', dirCache).agent?.name || null, record: (k, t) => recordEvent(k, t).catch(() => {}),
      afterCreate: (t) => afterTaskChange(t, { wake: t.owner && !isOwner(t.owner) ? [t.owner] : [] }, 'board') })
      .catch((e) => console.error('[channel discovery]', e.message));
    stages.run('guardrails-card', writeGateCard);
    const payload = JSON.stringify(payloadFor());
    for (const res of sseClients) res.write(`data: ${payload}\n\n`);
  } catch (err) {
    console.error(`${new Date().toISOString()} [poll]`, err.message);
  } finally {
    setTimeout(poll, (DEMO ? DEMO_POLL_SECONDS : SETTINGS.pollSeconds) * 1000);
  }
}

function payloadFor() {
  return {
    ...current,
    bootId: BOOT_ID,
    profile: DEMO ? 'full' : PROFILE,
    watching: DEMO ? 1 : JOBS.length + DOCKER_CONTAINERS.length + PROCESSES.length + CRON.length + ENDPOINTS.length,   // 0 = the page says "nothing watched yet"
       // 'guardrails' = the page shows the waiting rows and the ledger only
    brand: SETTINGS.brand || 'Zulu Assistant',
    repoUrl: SETTINGS.repoUrl || '',
    domains: DEMO ? DEMO_DOMAINS : DOMAINS,
    starToast: toastFor(starDoc, SETTINGS.repoUrl),
    fleetHistory: history.fleet.slice(-240),
    strips: Object.fromEntries(current.jobs.map((j) => [j.label, history.perJob[j.label] || []])),
    events: eventsCache,
    work: workCache,
    // board self-readings: per-stage duration + last error, stray rejections, data/ sizes (report only)
    poll: { ...stages.view(), rejections: procHealth.counts.rejections, lastRejection: procHealth.counts.lastRejection, lastRejectionAt: procHealth.counts.lastRejectionAt },
    dataUsage: currentUsage(),
    // caller evidence (src/caller.mjs): the switches, lookups and failures, and what the decision door did
    caller: { mode: CALLER.mode, tripwire: CALLER.tripwire, ...callerEvidence.stats, ...callerStats, ...gates.callerReadings() },
    ...(snoozeMode(SETTINGS.attention) === 'on' ? { attention: attentionView() } : {}),
    ...(decideCache ? { decide: pushView(decideCache) } : {}),
    sessions: (current.sessions || []).map((s) => ({ ...s, ctx: contextCache.get(s.workspaceId) || s.ctx || null })),   // s.ctx: a session with no cmux workspace carries its own gauge
    directory: Object.fromEntries(dirCache.filter((a) => a.workspaceId).map((a) => [a.workspaceId, {
      name: a.name, kind: a.kind, vendor: a.vendor, owns: a.owns || [], status: a.status,
      title: a.title || null, workspaceOpen: a.workspaceOpen ?? null,   // #788: the strip names each owner's workspace
      liveName: a.live?.liveName || null, nameOk: a.live ? a.live.nameOk : null,
      ctx: contextCache.get(a.workspaceId) || null,
      // the tiles show the taxonomy only when it is 'on' for this agent (observe = API + ticker only)
      ...(stateCache.get(a.workspaceId)?.mode === 'on' ? { state: stateView(stateCache.get(a.workspaceId).state), stateRaw: stateCache.get(a.workspaceId).state } : {}),
    }])),
  };
}

// ---- guarded actions (POST /api/action) — labels validated against the registry ----
function sh(cmd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, killSignal: 'SIGKILL', env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ err, out: String(stdout) + String(stderr) }));
  });
}

async function runAction(action, label) {
  if (DEMO) return { ok: true, msg: `demo: would ${action} ${label} (nothing was run)` };
  const job = JOBS.find((j) => j.label === label);
  const container = DOCKER_CONTAINERS.find((c) => `docker:${c.name}` === label);

  if (action === 'kickstart') {
    if (!job) return { ok: false, msg: 'unknown launchd label' };
    const { err } = await sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
    return { ok: !err, msg: err ? 'kickstart failed' : `kickstarted ${label}` };
  }

  if (action === 'docker-restart') {
    if (!container) return { ok: false, msg: 'unknown container' };
    const r = await sh('/usr/local/bin/docker', ['restart', container.name]);
    if (r.err) { const r2 = await sh('docker', ['restart', container.name]); if (r2.err) return { ok: false, msg: 'docker restart failed' }; }
    return { ok: true, msg: `restarted ${container.name}` };
  }

  if (action === 'proc-start') {
    const proc = PROCESSES.find((p) => `proc:${p.id}` === label);
    if (!proc?.startCmd) return { ok: false, msg: 'unknown process or no startCmd' };
    const cwd = proc.repo.replace('~', process.env.HOME);
    const { err } = await new Promise((resolve) => {
      execFile('/bin/bash', ['-c', proc.startCmd], { cwd, timeout: 15000 },
        (e, stdout, stderr) => resolve({ err: e, out: String(stdout) + String(stderr) }));
    });
    return { ok: !err, msg: err ? 'start failed' : `started ${proc.name}` };
  }

  if (action === 'ask-master') {
    // type a one-line brief into the Mission Control workspace
    const j = current.jobs.find((x) => x.label === label);
    if (!j) return { ok: false, msg: 'unknown label' };
    const pw = await cmuxPassword();
    const env = { CMUX_SOCKET_PASSWORD: pw, CMUX_QUIET: '1' };
    const { out } = await acrossWindows((a) => sh(SETTINGS.cmuxBin, a, env), ['workspace', 'list']);
    const line = out.split('\n').find((l) => l.includes('MISSION CONTROL'));
    const ref = line && (line.match(/workspace:\d+/) || [])[0];
    if (!ref) return { ok: false, msg: 'Mission Control workspace not found — launch it first' };
    const brief = `Board brief: "${j.name}" is ${String(j.status).toUpperCase()} — ${j.detail || 'no detail'} (label ${label}, schedule ${j.schedule || 'n/a'}). Please handle.`;
    await sh(SETTINGS.cmuxBin, ['send', '--workspace', ref, brief], env);
    const r = await sh(SETTINGS.cmuxBin, ['send-key', '--workspace', ref, 'enter'], env);
    return { ok: !r.err, msg: r.err ? 'send to Mission Control failed' : `Brief sent to Mission Control (${ref})` };
  }

  if (action === 'dispatch') {
    // spawn a Claude session in a fresh cmux workspace, targeted at the job's repo
    const proc = PROCESSES.find((p) => `proc:${p.id}` === label);
    // cron entries get DISPATCH (diagnosis) but never a run-now action — there
    // is no safe generic "fire this crontab line", and the board is read-only
    // against the crontab
    const cron = CRON.find((c) => `cron:${c.id}` === label);
    const known = job || container || proc || cron || ['disk:/', 'mem:'].includes(label) || label.startsWith('endpoint:');
    if (!known) return { ok: false, msg: 'unknown label' };
    const j = current.jobs.find((x) => x.label === label) || {};
    const repo = (job?.repo || proc?.repo || cron?.repo || '~').replace('~', process.env.HOME);
    const name = j.name || label;
    const prompt = `My Ops Board (localhost:3210) shows "${name}" in status ${String(j.status || 'unknown').toUpperCase()}: ` +
      `${j.detail || 'no detail'}. Label: ${label}. Schedule: ${j.schedule || 'n/a'}. ` +
      `Diagnose the root cause and fix it if safe; explain what you changed. ` +
      `The Ops Board registry lives in ${REGISTRY_FILE} if the check itself seems wrong.`;
    const promptFile = path.join(ROOT, 'data', `dispatch-${Date.now()}.txt`);
    await writeFile(promptFile, prompt);
    const pw = await cmuxPassword();
    const wsName = `fix: ${name}`;
    const meshName = slugTitle(wsName);
    const { err, out } = await sh(SETTINGS.cmuxBin, [
      'new-workspace', '--name', wsName, '--cwd', repo,
      // MESH_GATE_IDENTITY: until the reconciler registers the new workspace, the gate knows this session as headless:dispatch
      '--command', `MESH_GATE_IDENTITY=dispatch claude --name ${JSON.stringify(meshName)} --permission-mode acceptEdits`,
    ], { CMUX_SOCKET_PASSWORD: pw });
    if (err) return { ok: false, msg: `dispatch failed: ${out.slice(0, 120)}` };
    // submit the brief once the TUI is ready (a CLI-argument prompt can sit
    // unsubmitted on 2.1.280); runs in the background, result → ticker
    const ref = (out.match(/workspace:\d+/) || [])[0];
    (async () => {
      const ws = (await listWorkspaces()).find((w) => w.ref === ref);
      if (!ws) return recordEvent('bad', `dispatch ${meshName}: new workspace not found for kick`);
      // names enforced: this workspace is headless:dispatch until the reconciler registers it
      for (const [k, at] of dispatchWorkspaces) if (Date.now() - at > DISPATCH_ROLE_MS) dispatchWorkspaces.delete(k);
      dispatchWorkspaces.set(String(ws.id).toLowerCase(), Date.now());
      const k = await kickSession({ workspace: ws.id, name: meshName,
        line: `Read the brief at "${promptFile}" and execute it (Ops Board dispatch).` });
      await recordEvent(k.ok ? 'sys' : 'bad', `dispatch ${meshName}: ${k.ok ? 'brief submitted' : `KICK FAILED — ${k.reason}`}`);
    })().catch((e) => console.error('[dispatch kick]', e.message));
    return { ok: true, msg: `Claude dispatched in cmux workspace "${wsName}" (${meshName})` };
  }

  return { ok: false, msg: 'unknown action' };
}

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  if (!allowedSource(req)) { res.writeHead(403); return res.end('forbidden'); }
  // the peer as the source guard just saw it (kept for the caller lookup: a socket its sender
  // resets later reports no address, and that must never read as "another device")
  req.peer = { address: req.socket.remoteAddress, port: req.socket.remotePort, localPort: req.socket.localPort };
  const url = new URL(req.url, 'http://localhost');
  try {
    // every write: addressed to this board, not from another site's page, body declared as JSON
    if (isWrite(req.method)) {
      const no = writeRefusal(req, { extra: SETTINGS.allowedHosts || [], machine: os.hostname() });
      if (no) {
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        console.log(`${new Date().toISOString()} [guard] ${req.method} ${url.pathname} from ${ip} refused (${no.code}) host=${String(req.headers.host || '').slice(0, 60)} origin=${String(req.headers.origin || '-').slice(0, 80)}`);
        return sendJson(res, no.status, { ok: false, msg: no.msg });
      }
    }
    if (url.pathname === '/api/version') {
      // what this board runs: the upgrade's health check waits for a new bootId at the target commit
      return sendJson(res, 200, { ...(await VERSION), bootId: BOOT_ID, demo: DEMO });
    }
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payloadFor()));
    }
    if (url.pathname === '/api/feed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(DEMO ? demoFeed() : await getAgentFeed()));
    }
    if (url.pathname === '/api/log' && DEMO) return sendJson(res, 200, demoLog(url.searchParams.get('job') || ''));
    if (url.pathname === '/api/log') {
      const paths = await logPathsFor(url.searchParams.get('job') || '');
      const out = paths ? await tailFile(paths.out, 80) : '';
      const errT = paths ? await tailFile(paths.err, 20) : '';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ out, err: errT }));
    }
    // ---- Agent Mesh API ----
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      // state: the status taxonomy (src/agent-state.mjs) when SETTINGS.statusTaxonomy is observe/on, else absent
      const dir = (await refreshDir()).map((a) => ({ ...a, ctx: contextCache.get(a.workspaceId) || null,
        ...(stateCache.has(a.workspaceId) ? { state: stateCache.get(a.workspaceId).state } : {}) }));
      // Mission Control hook (report only): who is in the red band and idle —
      // candidates for "checkpoint your state file, then /compact"
      const contextRed = dir.filter((a) => a.ctx?.band === 'red').map((a) => ({
        name: a.name, pct: a.ctx.pct, source: a.ctx.source, idle: a.live ? a.live.status !== 'busy' : null }));
      return sendJson(res, 200, { agents: dir, outbox: await readOutbox(), contextRed });
    }
    if (url.pathname === '/api/mesh/send' && req.method === 'POST') {
      // shell/Codex → any agent. Localhost only (it types into panes).
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'localhost only' });
      const b = await readBody(req);
      const err = validateMessage(b.text);
      if (err) return sendJson(res, 400, { ok: false, msg: err });
      const me = await identify(b.from, { req });
      await noteCaller(req, me.name, 'a mesh message');
      const from = me.name;
      // the owner's name needs the decision token, "board" the board's own process: otherwise the
      // message still goes out, marked as from an unverified sender (never dropped).
      // Names enforced (callerEvidence 'on'): the same for ANY name the calling process does not back.
      const named = await nameCheck(req, from, 'a mesh message');
      const trust = CALLER.mode === 'on'
        ? (named.proven ? { verified: true, reserved: false, label: from } : { verified: false, reserved: false, label: unverifiedLabel(from, named.why) })
        : trustOf(from, req);
      const dir = await refreshDir();
      const target = resolveTarget(b.to, dir);
      if (!target.agent) return sendJson(res, 404, { ok: false, msg: target.error, candidates: target.candidates });
      let taskId = b.task ? Number(String(b.task).replace(/^#/, '')) : null;
      if (target.agent.vendor === 'claude' && !taskId) {
        return sendJson(res, 400, { ok: false, msg: 'messages to Claude agents must reference a task (--task N); create one first: scripts/task.sh create ...' });
      }
      if (taskId) {
        // an unproven reserved name is not written into the ledger as that name's comment either
        const r = await ledger.update(taskId, trust.verified
          ? { op: 'comment', actor: from, text: `→ ${target.agent.name}: ${b.text}` }
          : { op: 'comment', actor: 'board', text: `→ ${target.agent.name} from an UNVERIFIED sender calling itself "${from}": ${b.text}` });
        await refreshWork();
        taskId = r.task.id;
      }
      if (!trust.verified) recordEvent('sys', `mesh: message to ${target.agent.name} claims the sender "${from}" without proof — delivered marked unverified`).catch(() => {});
      const d = await meshDeliver(target.agent.name, b.text, { from, fromLabel: trust.verified ? null : trust.label, taskId, wake: Boolean(b.wake) });
      return sendJson(res, 200, { ...d, ...(trust.verified ? {} : { unverifiedSender: true }) });
    }
    if (url.pathname === '/api/mesh/outbox/drop' && req.method === 'POST') {
      // cancel queued (undelivered) messages for one target — localhost only
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'localhost only' });
      const b = await readBody(req);
      // Who is dropping, and may they? A queued message can be a gate decision or a "not approved
      // yet" notice, which the queue itself never replaces. With names enforced the caller must be
      // who it says, and be the addressee, Mission Control or the owner (everything queued for that
      // target), or the sender (its own messages only). In every mode the line says who and what.
      let who = 'a caller that gave no name';
      let mine = null;                                   // a sender's name: only its own messages go
      if (CALLER.mode === 'on' && !b.actor) throw new MeshError(403, 'dropping queued messages needs your name: run it from your own pane (mesh-cli.mjs outbox drop <agent>)');
      if (b.actor) {
        const me = await identify(b.actor);
        const what = `an outbox drop for ${String(b.to).slice(0, 60)}`;
        await noteCaller(req, me.name, what);
        const named = await nameCheck(req, me.name, what);
        if (!named.proven) throw unprovenRefusal(me.name, named.why, `dropping the messages queued for ${String(b.to).slice(0, 60)}`);
        who = CALLER.mode === 'on' ? me.name : `${me.name} (name not checked)`;
        if (CALLER.mode === 'on' && !(me.mc || isOwner(me.name) || me.name === b.to)) mine = me.name;
      }
      const gone = await dropFromOutbox((m) => m.to === b.to && (mine === null || m.from === mine));
      const kinds = Object.entries(gone.reduce((o, m) => { const k = m.kind || 'message'; o[k] = (o[k] || 0) + 1; return o; }, {})).map(([k, n]) => `${k} ×${n}`).join(', ');
      console.log(`${new Date().toISOString()} [mesh] outbox drop for ${b.to} by ${who}: ${gone.length} message(s)${kinds ? ` (${kinds})` : ''}${mine ? ' — its own only' : ''}`);
      recordEvent('sys', `mesh: ${who} dropped ${gone.length} queued message(s) for ${b.to}${kinds ? ` (${kinds})` : ''}`).catch(() => {});
      return sendJson(res, 200, { ok: true, dropped: gone.length, ...(mine ? { ownOnly: true } : {}) });
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      return sendJson(res, 200, { tasks: await ledger.list(q) });
    }
    if (url.pathname === '/api/attention' && req.method === 'GET') {
      return sendJson(res, 200, { ...attentionView(), choices: Object.fromEntries(Object.entries(SNOOZE_CHOICES).map(([k, v]) => [k, v.label])) });
    }
    if ((url.pathname === '/api/attention/snooze' || url.pathname === '/api/attention/unsnooze') && req.method === 'POST') {
      const b = await readBody(req);
      const op = url.pathname.endsWith('/unsnooze') ? 'unsnooze' : 'snooze';
      // the decision token + no agent/intake identity (condition H, as gate_decide)
      await decisionDoor(req, `attention ${op}`);
      const no = snoozeRefusal({ decider: isDecider(req), intake: isIntake(req), body: b, headers: req.headers });
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      console.log(`[attention] ${op} ${[].concat(b.items || []).join(',')} from ${ip} ${no ? 'REFUSED' : 'ok'}`);
      if (no) return sendJson(res, no.status, { ok: false, msg: no.msg });
      if (snoozeMode(SETTINGS.attention) !== 'on') return sendJson(res, 409, { ok: false, msg: 'snooze is off (SETTINGS.attention.snooze)' });
      attentionState ||= await readAttentionState(ATTENTION_FILE);
      const live = attentionItems(waitingTasks(), { isOwner });
      const r = applySnooze(attentionState, { op, items: b.items, choice: b.for }, live, { now: Date.now(), by: OWNER.id });
      if (r.error) return sendJson(res, r.error.status, { ok: false, msg: r.error.msg });
      attentionState = r.state;
      await writeAttentionState(ATTENTION_FILE, attentionState);
      const what = r.items.map((id) => itemText(live.find((i) => i.id === id) || { task: id, kind: '' }).trim()).join(', ');
      recordEvent('sys', op === 'snooze'
        ? `attention: ${what} snoozed ${SNOOZE_CHOICES[b.for].label} (until ${new Date(r.until).toISOString().slice(11, 16)}Z) — nothing decided, the agent is not held`
        : `attention: ${what} unsnoozed`).catch(() => {});
      for (const c of sseClients) c.write(`data: ${JSON.stringify(payloadFor())}\n\n`);
      return sendJson(res, 200, { ok: true, items: r.items, until: r.until || null, attention: attentionView() });
    }
    // daily decision page (#788, src/decide-page.mjs): read-only; the buttons on it are the strip's
    if (url.pathname === '/api/decide' && req.method === 'GET') {
      if (decideMode(SETTINGS.decidePage) !== 'on') return sendJson(res, 404, { ok: false, msg: 'decision page is off (SETTINGS.decidePage)' });
      await refreshDecide();
      return sendJson(res, 200, decideCache);
    }
    // OPEN WORKSPACE (#788): brings an agent's workspace to the front on this Mac. The owner's click
    // only (decision token + no agent or intake identity, through the decision door, as a snooze);
    // the workspace id comes from the board's own directory, never from the request.
    if (url.pathname === '/api/workspace/open' && req.method === 'POST') {
      const b = await readBody(req);
      await decisionDoor(req, 'open workspace');
      const no = openRefusal({ decider: isDecider(req), intake: isIntake(req), body: b, headers: req.headers });
      const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const agent = String(b.agent || '').slice(0, 120);
      console.log(`[decide] open workspace ${agent} from ${ip} ${no ? 'REFUSED' : 'ok'}`);
      if (no) return sendJson(res, no.status, { ok: false, msg: no.msg });
      if (decideMode(SETTINGS.decidePage) !== 'on') return sendJson(res, 409, { ok: false, msg: 'decision page is off (SETTINGS.decidePage)' });
      if (DEMO || GUARDRAILS_ONLY || !CMUX_PRESENT) return sendJson(res, 409, { ok: false, msg: DEMO ? 'demo: would open the workspace' : 'cmux is not available on this board' });
      const r = await openWorkspace(agent, { directory: dirCache.length ? dirCache : await refreshDir(), run: (a) => cmux(a) });
      if (!r.ok) return sendJson(res, r.status || 502, { ok: false, msg: r.msg });
      recordEvent('sys', `workspace opened: ${agent} (by the owner)`).catch(() => {});
      return sendJson(res, 200, { ok: true, agent, workspaceId: r.workspaceId });
    }
    // asks nobody sees (#787 part 3): the board's record, read-only (task ids, agent names, times; no comment text)
    if (url.pathname === '/api/read-asks' && req.method === 'GET') {
      if (readAsksMode(SETTINGS.readAsks) !== 'on') return sendJson(res, 404, { ok: false, msg: 'read asks are off (SETTINGS.readAsks)' });
      const st = await readAsksStep(() => loadReadAsks());
      return sendJson(res, 200, { mode: 'on', told: st.told, sent: st.sent });
    }
    if (url.pathname === '/api/tasks/summary' && req.method === 'GET') {
      return sendJson(res, 200, await ledger.summary());
    }
    // the scheduled triage pass's one reading (#586): small enough to read whole in one allowed call
    if (url.pathname === '/api/triage' && req.method === 'GET') {
      return sendJson(res, 200, triageReading(payloadFor(), await ledger.list()));
    }
    // the triage pass asks Mission Control for a worker instead of starting one (#588, SETTINGS.triage.dispatch 'ask'):
    // this machine only; the board checks the label against its own reading and files the task under its own name
    if (url.pathname === '/api/triage/ask' && req.method === 'POST') {
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'localhost only' });
      const b = await readBody(req);
      const tasks = await ledger.list();
      const mc = resolveTarget('mission-control', dirCache).agent;
      const plan = planAsk({ label: b.label, file: b.file }, { cards: triageReading(payloadFor(), tasks).cards, tasks, root: ROOT, owner: mc?.name, settings: SETTINGS });
      if (plan.refused) {
        recordEvent('sys', `triage: ask refused (${String(plan.refused).slice(0, 120)})`).catch(() => {});
        return sendJson(res, 409, { ok: false, refused: plan.refused });
      }
      const task = await ledger.create({ ...plan.input, owner_ws: mc?.workspaceId || null });
      if (task?.owner) await afterTaskChange(task, { wake: [task.owner] }, 'board');
      recordEvent('sys', `triage: asked Mission Control for a worker (#${task.id}, ${b.label})`).catch(() => {});
      return sendJson(res, 200, { ok: true, id: task.id });
    }
    // Ask back office (#755): the poller's escalations and the owner's per-question line. This machine only; every
    // word of the task and the line is fixed by src/backoffice.mjs (no model text reaches the ledger, C5).
    if (url.pathname === '/api/backoffice/escalate' && req.method === 'POST') {
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'localhost only' });
      if (!BACKOFFICE) return sendJson(res, 404, { ok: false, refused: 'no back office lane on this install' });
      const { planEscalation, noticeLine } = BACKOFFICE;
      if (!SETTINGS.backoffice?.mode || SETTINGS.backoffice.mode === 'off') return sendJson(res, 409, { ok: false, refused: 'the back office is off' });
      const b = await readBody(req);
      if (b.kind === 'notice') {
        const line = noticeLine(b);
        if (!line) return sendJson(res, 400, { ok: false, refused: 'no question id' });
        recordEvent('sys', `back office: ${line}`).catch(() => {});
        await notify('Back office', OWNER.name || 'owner', line).catch(() => {});
        return sendJson(res, 200, { ok: true });
      }
      const mc = resolveTarget('mission-control', dirCache).agent;
      const plan = planEscalation(b, { mc: mc?.name || null, ownerId: OWNER.id });
      if (plan.refused) return sendJson(res, 400, { ok: false, refused: plan.refused });
      const task = await ledger.create({ ...plan.input, owner_ws: mc?.workspaceId || null });
      // the owner's hold is put on whenever it is missing, so a retried escalation repairs a hold that failed to write
      const live = await ledger.get(task.id);
      if (live && !['done', 'cancelled'].includes(live.status) && !(live.blocked_on || []).includes(OWNER.id)) {
        // block replaces blocked_on: keep every wait already on the task and add the owner's
        try { await ledger.update(task.id, { ...plan.block, blocked_on: [...new Set([...(live.blocked_on || []), ...plan.block.blocked_on])] }); } catch (e) { return sendJson(res, 500, { ok: false, msg: `the owner's hold was not written: ${String(e.message).slice(0, 120)}` }); }
      }
      // a repeat on the day's mismatch task is one fixed line, never a new task or notice (the lane caps how many)
      if (task.existing && plan.comment) await ledger.update(task.id, { op: 'comment', actor: 'board', text: plan.comment }).catch(() => {});
      if (!task.existing) {
        if (task.owner) await afterTaskChange(await ledger.get(task.id), { wake: [task.owner] }, 'board');
        recordEvent('sys', `back office: ${b.kind} on question #${Number(b.question)} → task #${task.id}`).catch(() => {});
        if (b.kind === 'stopped') await notify('Back office', 'lane stopped', `cap hit twice today (task #${task.id})`).catch(() => {});
        if (b.kind === 'mismatch') await notify('Back office', 'question refused', `its chat is not the asker's (task #${task.id})`).catch(() => {});
        if (b.kind === 'startup') await notify('Back office', 'start-up check refused the pass', `questions are refused until it is fixed (task #${task.id})`).catch(() => {});
      }
      return sendJson(res, 200, { ok: true, id: task.id, existing: Boolean(task.existing) });
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const intake = isIntake(req);
      let named = { proven: true, why: '' };   // names enforced: is the requester's name backed by the calling process?
      if (intake) {
        // a person's request from the team chat: the requester is that person
        const who = String(b.requester || '').trim().toLowerCase();
        if (!isPrincipal(who)) throw new MeshError(403, `"${who}" is not a person in config/principals.json`);
        if (!b.source?.via || !b.source?.key) throw new MeshError(400, 'intake requests carry source.via + source.key');
        // planFirst comes from config/principals.json, never from the request body
        b.plan_first = PRINCIPALS.get(String(b.requester || '').toLowerCase())?.planFirst === true;
        b.requester = isOwner(who) ? OWNER.id : who; b.requester_ws = null;
      } else {
        if (b.source) throw new MeshError(403, 'source is set by the chat intake only');
        delete b.plan_first;
        const me = await identify(b.requester, { req });
        await noteCaller(req, me.name, 'a new task');
        named = await nameCheck(req, me.name, 'a new task');
        b.requester = me.name; b.requester_ws = named.proven ? me.ws : null;
      }
      // the unverified mark is the board's to set, never the caller's: a field on the task itself, so it
      // outlives the comment below and every later comment
      delete b.unverified;
      if (!named.proven) b.unverified = { why: named.why };
      if (b.owner) {
        const t = resolveTarget(b.owner, await refreshDir());
        if (!t.agent && !isOwner(b.owner)) return sendJson(res, 400, { ok: false, msg: `owner: ${t.error}`, candidates: t.candidates });
        if (t.agent) { b.owner = t.agent.name; b.owner_ws = t.agent.workspaceId || null; }
      }
      const task = await ledger.create(b);
      if (task.existing) return sendJson(res, 200, { ok: true, task, existing: true, deliveries: [] });
      recordEvent('sys', `task #${task.id} created by ${task.requester}${task.owner ? ` → ${task.owner}` : ''}: ${task.title}`).catch(() => {});
      // an unproven requester: the task is filed (never dropped), and says so where its owner reads it
      if (!named.proven) await ledger.update(task.id, { op: 'comment', actor: 'board', text: `filed by an UNVERIFIED caller calling itself "${task.requester}" (${named.why}). Treat the request as an unknown sender's.` }).catch((e) => console.error('[caller] unverified note', e.message));
      const trust = named.proven ? trustOf(task.requester, req, { intake }) : { verified: false, label: unverifiedLabel(task.requester, named.why) };
      const deliveries = await afterTaskChange(task, { wake: task.owner && task.owner !== task.requester && !isOwner(task.owner) ? [task.owner] : [] }, task.requester,
        { fromLabel: trust.verified ? null : trust.label });
      return sendJson(res, 201, { ok: true, task, deliveries, ...(named.proven ? {} : { unverifiedSender: true, note: `the board could not verify the name "${task.requester}" (${named.why}): the task was filed marked as from an unverified sender` }) });
    }
    // POST a file the owner made (e.g. a calendar .ics) into the request's chat thread
    // (task.sh chat-file). Agents never hold chat tokens: the board queues it, the intake uploads.
    const cf = url.pathname.match(/^\/api\/tasks\/(\d+)\/chat-file$/);
    if (cf && req.method === 'POST') {
      const b = await readBody(req);
      const me = await identify(b.actor);
      await noteCaller(req, me.name, 'a ledger call');
      const named = await nameCheck(req, me.name, `task #${cf[1]} chat-file`);
      if (!named.proven) throw unprovenRefusal(me.name, named.why, `posting a file for task #${cf[1]}`);
      const t = await ledger.get(cf[1]);
      if (!t) throw new MeshError(404, `no task #${cf[1]}`);
      if (!isChatTask(t)) throw new MeshError(400, `task #${t.id} did not come from chat — no thread to post into`);
      if (me.name !== t.owner && !me.mc) throw new MeshError(403, `only #${t.id}'s owner (${t.owner}) or mission-control posts files to its thread`);
      const rel = String(b.path || '').replace(/^\.\//, '');
      const st = await fsStat(path.join(ROOT, rel)).catch(() => null);
      const bad = chatFileProblem(rel, { size: st?.size, isFile: st?.isFile(), attachmentsDir: loadChannels(resolveConfig('config/channels.json')).attachmentsDir });
      if (bad) throw new MeshError(400, `chat-file: ${bad}`);
      const r = await ledger.update(t.id, { op: 'comment', actor: me.name, text: `posting ${path.basename(rel)} to the chat thread${b.text ? ` — ${b.text}` : ''} (${rel})` }, { mc: me.mc, actorWs: me.ws });
      intakeChain = intakeChain.then(async () => {
        const box = await readIntakeOutbox();
        box.push({ id: randomBytes(6).toString('hex'), taskId: t.id, channel: t.source.channel, thread_ts: t.source.ts,
          channel_name: t.source.channel_name || null, file: rel, title: String(b.title || '').slice(0, 120) || null,
          text: String(b.text || '').slice(0, 600), status: false, queuedAt: Date.now() });
        await writeJsonAtomic(INTAKE_OUTBOX_FILE, box);
      }).catch((e) => console.error('[intake outbox]', e.message));
      await intakeChain;
      recordEvent('sys', `task #${t.id}: ${me.name} queued ${path.basename(rel)} for its chat thread`).catch(() => {});
      return sendJson(res, 202, { ok: true, queued: rel });
    }
    // ---- guardrails ----
    if (url.pathname === '/api/gates/check' && req.method === 'POST') {
      if (!localOnly(req)) throw new MeshError(403, 'the gate hook calls from this machine only');
      const answer = await gates.check(await readBody(req), { evidence: CALLER.mode === 'off' ? null : () => evidenceOf(req), names: CALLER.mode === 'on' });
      // a gated call was just released (a merge of this repository, perhaps): ask the remote for its
      // head soon after, instead of at the next ten-minute read
      if (integrity && answer.decision === 'allow') for (const ms of [20e3, 90e3]) setTimeout(() => integrity.readRemote(true).catch(() => {}), ms).unref();
      return sendJson(res, 200, answer);
    }
    if (url.pathname === '/api/gates/config-change' && req.method === 'POST') {
      // the settings-change hook (scripts/gate-config-hook.mjs) blocked a change for a running session:
      // it decided by itself; this is only how the owner gets to see it
      if (!localOnly(req)) throw new MeshError(403, 'the settings-change hook calls from this machine only');
      const b = await readBody(req);
      // `changed` is the file the event named; the reason may be another file still on disk, and `why` names it
      const tidy = (x, n) => String(x || '').replaceAll(os.homedir(), '~').replace(/\s+/g, ' ').slice(0, n);
      const file = tidy(b.changed || b.file || '?', 300);
      const why = tidy(b.why, 500);
      console.log(`${new Date().toISOString()} [integrity] a settings change was blocked for a running session: ${file} — ${why}`);
      recordEvent('bad', `guardrails: a settings change was BLOCKED for a running session — ${file}: ${why}`).catch(() => {});
      return sendJson(res, 200, { ok: true });
    }
    if (url.pathname === '/api/gates/focus' && req.method === 'POST') {
      if (!localOnly(req)) throw new MeshError(403, 'localhost only');
      const b = await readBody(req);
      const me = await identify(b.actor);
      await noteCaller(req, me.name, 'a ledger call');
      const named = await nameCheck(req, me.name, 'a gate focus');
      if (!named.proven) throw unprovenRefusal(me.name, named.why, 'setting a gate focus');
      const t = await ledger.get(b.task);
      if (!t) throw new MeshError(404, `no task #${b.task}`);
      if (t.owner !== me.name && !me.mc) throw new MeshError(403, `task #${t.id} is owned by ${t.owner}`);
      await gates.setFocus(me.name, t.id);
      return sendJson(res, 200, { ok: true, agent: me.name, focus: t.id });
    }
    if (url.pathname === '/api/gates' && req.method === 'GET') {
      const want = url.searchParams.get('status') || 'pending';
      const out = [];
      for (const t of await ledger.list({ status: 'live' })) for (const g of t.gates || []) if (want === 'all' || g.status === want) out.push({ task: t.id, title: t.title, ...g, cmdHash: undefined });
      return sendJson(res, 200, { gates: out, card: JSON.parse(await readFile(GATE_CARD_FILE, 'utf8').catch(() => 'null')) });
    }
    // evidence panel (src/evidence.mjs, SETTINGS.evidencePanel): packets + gate receipts per task, read-only
    if (url.pathname === '/api/evidence' && req.method === 'GET') {
      if (evidenceMode(SETTINGS.evidencePanel) !== 'on') return sendJson(res, 404, { ok: false, msg: 'evidence panel is off (SETTINGS.evidencePanel)' });
      const q = url.searchParams;
      const out = evidenceRows(await ledger.list(), { limit: q.get('limit'), task: q.get('task'), q: q.get('q') || '' });
      return sendJson(res, 200, { ok: true, days: CLOSED_DAYS, ...out });
    }
    // setup page (src/setup-page.mjs, SETTINGS.setupPage): the guided setup's checklist with live checks. Read-only:
    // answered from the last reading (the checks start child processes and never run inside a request).
    if (url.pathname === '/api/setup' && req.method === 'GET') {
      if (!setupOn) return sendJson(res, 404, { ok: false, msg: 'the setup page is off (SETTINGS.setupPage)' });
      return sendJson(res, 200, { ok: true, ...(await setupReader.peek()), write: setupWrite ? { steps: stepsFor({ alerts: setupAlerts }), ...(setupButtonsOn ? { buttons: buttonList() } : {}) } : null });
    }
    // Buttons on the setup page (src/setup-buttons.mjs): four fixed command lines. The body is the button's id
    // and nothing else is read from it. The door is stricter than the forms': the board must have SEEN a browser
    // behind the request; a lookup that failed or a sender that has left is refused here, never passed.
    if (url.pathname === '/api/setup/button' && (req.method === 'POST' || req.method === 'GET')) {
      if (!setupButtonsOn) return sendJson(res, 404, { ok: false, msg: 'buttons on the setup page are off (SETTINGS.setupPage)' });
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'open the setup page on this Mac, at localhost' });
      if (req.method === 'GET') {            // the last Guardrails run's output, read after the board is back
        if (!isDecider(req)) return sendJson(res, 403, { ok: false, msg: 'decision token rejected: reload the setup page' });
        return sendJson(res, 200, { ok: true, running: setupButtons.running(), last: DEMO ? null : await lastButtonRun() });
      }
      const b = await readBody(req);
      const id = String(b.id || '').slice(0, 40);
      const what = `setup button ${id.replace(/[^a-z-]/g, '')}`;
      const door = await decisionDoor(req, what);
      if (isIntake(req) || b.actor || req.headers['x-mesh-intake'] || req.headers['x-mesh-agent'])
        throw new MeshError(403, 'setup buttons are the owner\'s, on the board page only (no agent or intake identity)');
      if (!isDecider(req)) {
        recordEvent('sys', `${what} REJECTED (decision token)`).catch(() => {});
        throw new MeshError(403, 'decision token rejected: reload the setup page and click again');
      }
      if (!browserProven(door.ev)) {
        console.log(`${new Date().toISOString()} [door] refused (no evidence of a browser): ${what} [${door.ev?.kind ?? 'none'}: ${String(door.ev?.why || '').slice(0, 140)}]`);
        recordEvent('bad', `decision door: ${what} REFUSED — the board could not see a browser behind the request`).catch(() => {});
        return sendJson(res, 403, { ok: false, msg: 'refused: the board could not see that this click came from a browser on this Mac. Reload the setup page and click again.' });
      }
      try {
        if (DEMO) return sendJson(res, 200, demoButton(id));
        const up = readUpgradeState();
        const r = await setupButtons.run(id, { busy: up?.running ? 'an upgrade is running' : null });
        recordEvent(r.ok ? 'sys' : 'bad', `setup: "${what}" ${r.started ? 'started (the board restarts)' : r.ok ? 'ran' : r.timedOut ? 'ran out of time' : `ended with exit ${r.code}`}`).catch(() => {});
        console.log(`${new Date().toISOString()} [setup] ${what}: ${r.started ? `started, log ${r.log}` : `exit ${r.code}${r.timedOut ? ' (time limit)' : ''}`}`);
        return sendJson(res, 200, r);
      } catch (e) {
        if (e instanceof ButtonRefused) return sendJson(res, e.status, { ok: false, msg: e.message });
        console.error(`${new Date().toISOString()} [setup] ${what} failed: ${e.message}`);
        return sendJson(res, 500, { ok: false, msg: 'the button could not be run; the board log says why' });
      }
    }
    // setup writes (src/setup-write.mjs, SETTINGS.setupPage mode 'write'). The scan the watch step ticks from:
    // read-only, this Mac only, behind the decision token.
    if (url.pathname === '/api/setup/scan' && req.method === 'GET') {
      if (!setupWrite) return sendJson(res, 404, { ok: false, msg: 'setup from the page is off (SETTINGS.setupPage)' });
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'open the setup page on this Mac, at localhost' });
      if (!isDecider(req)) return sendJson(res, 403, { ok: false, msg: 'decision token rejected: reload the setup page' });
      return sendJson(res, 200, { ok: true, scan: DEMO ? DEMO_SCAN : await scanWatch() });
    }
    // One step answered on the page. The owner's, like a card action: this Mac, the decision door, no agent or
    // intake identity, the decision token. What may be written is src/setup-write.mjs's to decide.
    if (url.pathname === '/api/setup/step' && req.method === 'POST') {
      if (!setupWrite) return sendJson(res, 404, { ok: false, msg: 'setup from the page is off (SETTINGS.setupPage)' });
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'open the setup page on this Mac, at localhost' });
      const b = await readBody(req);
      const step = String(b.step || '').slice(0, 20);
      await decisionDoor(req, `setup step ${step}`);
      if (isIntake(req) || b.actor || req.headers['x-mesh-intake'] || req.headers['x-mesh-agent'])
        throw new MeshError(403, 'setup steps are saved from the owner\'s board only (no agent or intake identity)');
      if (!isDecider(req)) {
        recordEvent('sys', `setup step ${step.replace(/[^a-z]/g, '')} REJECTED (decision token)`).catch(() => {});
        throw new MeshError(403, 'decision token rejected: reload the setup page and save again');
      }
      try {
        if (DEMO) {
          const r = demoSetupStep(step, b.answers, { alerts: setupAlerts });
          recordEvent('sys', r.saved).catch(() => {});
          return sendJson(res, 200, r);
        }
        const up = readUpgradeState();
        const r = await runSetupStep(step, b.answers, { busy: up?.running ? 'an upgrade is running' : null, alerts: setupAlerts, alertsFile: SECRETS_FILE });
        const restart = restartPlan(step, { demo: DEMO, label: `${labelPrefix(ROOT)}.master-console` });
        recordEvent('sys', `setup: the ${step} step was saved from the setup page${restart === 'self' ? '; the board restarts to show it' : ''}`).catch(() => {});
        console.log(`${new Date().toISOString()} [setup] ${step} step saved from the page (restart: ${restart})`);
        // restart A: the board ends itself once the answer is out; its own LaunchAgent starts it again
        if (restart === 'self') res.once('finish', () => setTimeout(() => process.exit(0), 400));
        return sendJson(res, 200, { ...r, restart });
      } catch (e) {
        if (e instanceof SetupRefused) return sendJson(res, e.status, { ok: false, msg: e.message });
        // never a file's text or a path in the answer: the log has the reason
        console.error(`${new Date().toISOString()} [setup] ${step} step failed: ${e.message}`);
        return sendJson(res, 500, { ok: false, msg: 'the step could not be saved; the board log says why' });
      }
    }
    // conversation view (src/conversation.mjs, SETTINGS.conversationView): what was said to one agent session and what
    // it answered, from the transcript's tail. Read-only. The session id is the only input; a path is never taken.
    if (url.pathname === '/api/conversation' && req.method === 'GET') {
      if (!conversationOn) return sendJson(res, 404, { ok: false, msg: 'the conversation view is off (SETTINGS.conversationView)' });
      const id = url.searchParams.get('session') || '';
      if (!validSessionId(id)) return sendJson(res, 400, { ok: false, msg: CONVERSATION_WHY['bad-id'] });
      const r = DEMO ? demoConversation(id) : await conversations.read(id);
      return r.ok ? sendJson(res, 200, r) : sendJson(res, r.why === 'bad-id' ? 400 : 404, { ok: false, msg: CONVERSATION_WHY[r.why] || 'not found' });
    }
    const am = url.pathname.match(/^\/api\/tasks\/(\d+)\/audit$/);
    if (am && req.method === 'GET') {
      const rows = await gates.audit(am[1]);
      // ?verify=1: the receipt chain recomputed and compared with this task's gates (read-only)
      if (rows && url.searchParams.has('verify')) return sendJson(res, 200, { task: Number(am[1]), rows, verify: await gates.verifyChain(am[1]) });
      return rows ? sendJson(res, 200, { task: Number(am[1]), rows }) : sendJson(res, 404, { ok: false, msg: `no task #${am[1]}` });
    }
    const tm = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (tm && req.method === 'GET') {
      const t = await ledger.get(tm[1]);
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { ok: false, msg: `no task #${tm[1]}` });
    }
    if (tm && req.method === 'PATCH') {
      const b = await readBody(req);
      const intake = isIntake(req);
      // board decisions carry the decision token; a revoke_go without it goes the normal (owner/MC) path
      // proposal_reject ("not what I said", a recorded pane answer thrown out) is the owner's too
      // request_confirm with the token is the owner saying an unverified request is real; without it, Mission Control's path
      const deciding = b.op === 'decide' || b.op === 'gate_decide' || b.op === 'proposal_reject' || ((b.op === 'revoke_go' || b.op === 'request_confirm') && !!req.headers['x-mesh-decision']);
      // condition H: a gate decision never carries an agent or intake identity, token or not
      if ((b.op === 'gate_decide' || b.op === 'proposal_reject' || (b.op === 'request_confirm' && deciding)) && (intake || b.actor || req.headers['x-mesh-intake'] || req.headers['x-mesh-agent']))
        throw new MeshError(403, 'gates are decided from the owner\'s board only (no agent or intake identity)');
      // the decision door first: a request an agent session is behind is refused and named, token or not.
      // `typed`: an approval of one gate that came from a terminal on this machine, not the board page
      // (tripwire 'browser'). It is kept as a row the owner confirms; the ledger decides nothing.
      let typed = false;
      if (deciding) typed = (await decisionDoor(req, `task #${tm[1]} ${b.op === 'proposal_reject' ? 'pane-answer rejection' : b.op === 'revoke_go' ? 'revoke go' : b.op === 'request_confirm' ? 'request confirmation' : `${b.decision || 'decision'}${b.gate ? ` of gate ${String(b.gate).slice(0, 8)}` : ''}`}`,
        { typedApproval: b.op === 'gate_decide' && b.decision === 'approve' })).typed;
      const decider = !intake && deciding && isDecider(req);
      const decisionWord = b.op === 'proposal_reject' ? 'pane-answer-rejected' : b.op === 'request_confirm' ? 'request-confirmed' : b.decision;
      if (deciding) {
        // every panel decision attempt leaves a trace (two clicks left none)
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        console.log(`[decide] #${tm[1]} ${decisionWord} from ${ip} token=${decider ? 'ok' : 'REJECTED'}`);
        if (!decider) {
          recordEvent('sys', `approval for #${tm[1]} REJECTED (decision token) from ${ip}`).catch(() => {});
          throw new MeshError(403, 'decision token rejected: reload the board page and click again');
        }
      }
      let me;
      let unverified = null;                   // names enforced: { name, why } when the declared name was not proven
      if (decider) me = { name: OWNER.id, ws: null, mc: false };
      else if (intake) {
        const who = String(b.actor || '').trim().toLowerCase();
        if (!isPrincipal(who)) throw new MeshError(403, `"${who}" is not a person in config/principals.json`);
        me = { name: isOwner(who) ? OWNER.id : who, ws: null, mc: false };
      } else {
        me = await identify(b.actor, b.op === 'comment' ? { req } : {});
        const what = `task #${tm[1]} ${String(b.op).slice(0, 24)}`;
        await noteCaller(req, me.name, what);
        const named = await nameCheck(req, me.name, what);
        if (!named.proven) {
          // a comment is words: it is recorded, marked, under the board's name. Every other step
          // needs the name's standing (an owner's, the requester's, Mission Control's) and is refused.
          if (b.op !== 'comment') throw unprovenRefusal(me.name, named.why, `"${String(b.op).slice(0, 24)}" on task #${tm[1]}`);
          unverified = { name: me.name, why: named.why };
          b.text = `comment from an UNVERIFIED caller calling itself "${me.name}" (${named.why}): ${String(b.text ?? '')}`;
          me = { name: 'board', ws: null, mc: false };
        }
      }
      b.actor = me.name;
      if (b.op === 'assign' && b.owner) {
        const t = resolveTarget(b.owner, await refreshDir());
        if (!t.agent) throw new MeshError(400, `owner: ${t.error}`, { candidates: t.candidates });
        b.owner = t.agent.name; b.owner_ws = t.agent.workspaceId || null;
      }
      if (b.op === 'set_requester' && b.requester) {
        const who = await identify(b.requester);   // exact, live agent (or the owner)
        b.requester = who.name; b.requester_ws = who.ws;
      }
      const prev = await ledger.get(tm[1]);
      // SETTINGS.brain: the close gate verifies vault_synced / graphify_updated (src/brain.mjs)
      let verified;
      if (b.op === 'close' && SETTINGS.brain && prev && !DEMO) {
        const probe = { ...prev, links: { ...prev.links, ...(b.links && typeof b.links === 'object' ? b.links : {}) } };
        verified = await verifyClose(probe, { cfg: SETTINGS.brain, agents: dirCache.length ? dirCache : await refreshDir() });
      }
      const from = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      // where the owner decided: the owner CLI (task.sh gate) says so; else phone over the tailnet or this Mac's page
      const sameMachine = isLocalSource(from);   // a call this machine makes to its own tailnet address is not the phone
      const via = req.headers['x-mesh-via'] === 'cli' ? 'cli' : from.startsWith('100.') && !sameMachine ? 'phone/tailnet' : 'local';
      // + the surface (dock / strip from the page, phone from the socket): a receipt field for the release acceptance gate
      const surface = decider ? decisionSurface({ via: req.headers['x-mesh-via'], remote: from, client: req.headers['x-mesh-surface'], local: sameMachine }) : null;
      // SETTINGS.completionPacket: the evidence block at close (src/completion-packet.mjs); the PR read fails soft
      // the linked PR is read ONCE at close (gh, fails soft): the close is refused while it has not
      // landed (src/tasks.mjs prLanded; waiver --pr-not-landed), and the packet records its head
      let packet; let prRead;
      const prUrl = b.op === 'close' && prev && !DEMO ? ((b.links && typeof b.links === 'object' && typeof b.links.pr === 'string' ? b.links.pr : null) || prev.links?.pr || null) : null;
      if (prUrl) prRead = await readPr(prUrl).catch(() => null) || { url: prUrl, unavailable: 'gh could not read it' };
      const pmode = b.op === 'close' && prev && !DEMO ? packetMode(SETTINGS.completionPacket, prev.owner) : 'off';
      if (pmode !== 'off') packet = { mode: pmode, pr: prRead || null };
      // worktree-per-task: a close with the task's worktree still on disk gets a warning comment (never refused)
      const worktreeLeft = b.op === 'close' && prev?.links?.worktree && !DEMO ? await leftoverWorktree(prev.links.worktree).catch(() => null) : null;
      const r = await ledger.update(tm[1], b, { decider, intake, typed, mc: me.mc, actorWs: me.ws, verified, from: via, surface, packet, worktreeLeft, ...(prRead ? { pr: prRead } : {}) });
      if (pmode === 'observe' && r.packet) recordEvent('sys', packetLine(r.task.id, r.packet)).catch(() => {});
      queueIntake(prev, r.task);
      // an approved gate gets its single-use grant BEFORE the agent is woken. afterDecision mints only
      // for a gate that is `approved`: a pane answer recorded under SETTINGS.paneAnswers 'confirm'
      // leaves the gate pending, so nothing is minted until the owner confirms it on the board.
      if ((b.op === 'gate_decide' || b.op === 'gate_record') && b.decision !== 'decline') await gates.afterDecision(r.task, b.gate);
      // claim/start focus the agent's gates on this task — unless it set a focus itself on a live task
      if ((b.op === 'claim' || b.op === 'start') && !intake) await gates.autoFocus(me.name, r.task.id).catch(() => {});
      if (decider) {
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        recordEvent('sys', typed
          ? `approval #${tm[1]}: an approval typed in a terminal was kept as a row for ${OWNER.name} to confirm — nothing decided (from ${ip})`
          : `approval #${tm[1]} ${decisionWord} decided from ${ip} (${String(req.headers['user-agent'] || '').slice(0, 40)})`).catch(() => {});
      }
      // who the wake is from: a typed approval is the board's notice (nobody's decision); an unproven
      // name is marked; else the owner's and "board" names as before (src/request-guard.mjs)
      if (typed) callerStats.typedKept += 1;
      const speaker = typed ? 'board' : b.actor;
      const trust = typed ? { verified: true } : unverified ? { verified: false, label: unverifiedLabel(unverified.name, unverified.why) } : trustOf(b.actor, req, { decider, intake });
      const deliveries = await afterTaskChange(r.task, r, speaker, { fromLabel: trust.verified ? null : trust.label });
      if (b.op === 'close' && r.task.status === 'done') celebrate(`task #${r.task.id} through to done`);
      // the first gate the owner approves is a success moment too (the toast is still shown once, src/star.mjs)
      const gateWin = b.op === 'gate_decide' && decider && !typed ? gateMoment(prev, r.task, b.gate) : null;
      if (gateWin) celebrate(gateWin);
      if (typed) return sendJson(res, 202, { ok: true, task: r.task, deliveries, proposed: true, msg: `kept as a row for ${OWNER.name} to confirm on the board page (one click). Nothing was approved and nothing runs until then.` });
      return sendJson(res, 200, { ok: true, task: r.task, deliveries, ...(unverified ? { unverifiedSender: true, note: `the board could not verify the name "${unverified.name}" (${unverified.why}): the comment was recorded marked as from an unverified caller` } : {}) });
    }

    if (url.pathname === '/api/intake/outbox' && req.method === 'GET') {
      if (!isIntake(req)) throw new MeshError(403, 'intake token required');
      await intakeChain;
      return sendJson(res, 200, { items: await readIntakeOutbox() });
    }
    if (url.pathname === '/api/intake/outbox/ack' && req.method === 'POST') {
      if (!isIntake(req)) throw new MeshError(403, 'intake token required');
      const b = await readBody(req);
      const ids = new Set(Array.isArray(b.ids) ? b.ids.map(String) : []);
      let left = 0;
      intakeChain = intakeChain.then(async () => {
        const keep = (await readIntakeOutbox()).filter((m) => !ids.has(m.id));
        left = keep.length;
        await writeJsonAtomic(INTAKE_OUTBOX_FILE, keep);
      }).catch((e) => { left = -1; console.error('[intake ack]', e.message); });
      await intakeChain;
      return sendJson(res, left < 0 ? 500 : 200, { ok: left >= 0, left });
    }
    if (req.method === 'POST' && url.pathname === '/api/star') {
      // the board's one-time star toast reports shown / star / never (src/star.mjs)
      const b = await readBody(req);
      const ok = await recordToast(b.event);
      starDoc = await readStar();
      return sendJson(res, ok ? 200 : 400, { ok });
    }
    if (req.method === 'POST' && url.pathname === '/api/event') {
      // Mission Control / scripts log actions into the ticker. Localhost only —
      // stricter than the tailnet-wide source guard.
      if (!localOnly(req)) { res.writeHead(403); return res.end('forbidden'); }
      const body = await new Promise((resolve) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b));
      });
      const { kind, text } = JSON.parse(body || '{}');
      if (!text) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
      await recordEvent(['good', 'bad', 'sys'].includes(kind) ? kind : 'sys', text);
      eventsCache = await getEvents(30);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/api/upgrade') {
      // the UPDATE button (#346): the owner's board only, the same rules as a gate decision
      const b = await readBody(req);
      await decisionDoor(req, 'an upgrade');
      if (isIntake(req) || b.actor || req.headers['x-mesh-intake'] || req.headers['x-mesh-agent'])
        throw new MeshError(403, 'upgrades are started from the owner\'s board only (no agent or intake identity)');
      if (!isDecider(req)) {
        recordEvent('sys', 'upgrade request REJECTED (decision token)').catch(() => {});
        throw new MeshError(403, 'decision token rejected: reload the board page and click again');
      }
      const to = String(b.to || '');
      if (DEMO) {
        for (const s of ['back up overlay/ + a restore point', 'move the code to ' + to, 'migrate', 'run the tests', 're-run the install steps', 'restart', 'check health'])
          recordEvent('sys', `demo: would ${s}`).catch(() => {});
        return sendJson(res, 200, { ok: true, msg: `demo: would upgrade to ${to}` });
      }
      const allowed = requestAllowed(readUpgradeState(), SETTINGS.upgrade, SETTINGS.repoUrl, to);
      if (!allowed.ok) return sendJson(res, 409, { ok: false, msg: allowed.why });
      // never in-process: a one-shot LaunchAgent runs scripts/upgrade.mjs, so it survives the board restart it causes
      const label = `${labelPrefix(ROOT)}.zulu-upgrade`;
      const dir = path.join(ROOT, 'data', 'upgrade');
      await mkdir(dir, { recursive: true });
      await writeFile(UPGRADE_REQUEST, JSON.stringify({ to, at: Date.now(), by: OWNER.id }, null, 2));
      const plist = path.join(dir, `${label}.plist`);
      await writeFile(plist, upgradePlist({ label, node: process.execPath, script: path.join(ROOT, 'scripts', 'upgrade.mjs'), root: ROOT, log: path.join(ROOT, 'logs', 'upgrade.log') }));
      const uid = process.getuid();
      await sh('launchctl', ['bootout', `gui/${uid}/${label}`]);                  // a leftover from an earlier run
      const r = await sh('launchctl', ['bootstrap', `gui/${uid}`, plist]);
      const err = r.err ? r.out.trim() || r.err.message : '';
      recordEvent(err ? 'bad' : 'sys', err ? `upgrade to ${to} could not start: ${err}` : `upgrade to ${to} started (one-shot ${label})`).catch(() => {});
      return sendJson(res, err ? 500 : 200, { ok: !err, msg: err || `upgrading to ${to}: progress in the ticker` });
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      // card actions (kickstart, restart, start, dispatch a session, ask the master) are the owner's:
      // the decision token and no agent or intake identity, as for a gate decision (agents are gated
      // on the same kickstarts — this door must not be wider than theirs)
      const b = await readBody(req);
      const { action, label } = b;
      await decisionDoor(req, `card action ${String(action).slice(0, 20)} ${String(label).slice(0, 60)}`);
      if (isIntake(req) || b.actor || req.headers['x-mesh-intake'] || req.headers['x-mesh-agent'])
        throw new MeshError(403, 'card actions are started from the owner\'s board only (no agent or intake identity)');
      if (!isDecider(req)) {
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        console.log(`[action] ${String(action).slice(0, 20)} ${String(label).slice(0, 80)} from ${ip} token=REJECTED`);
        recordEvent('sys', `card action ${String(action).slice(0, 20)} ${String(label).slice(0, 60)} REJECTED (decision token) from ${ip}`).catch(() => {});
        throw new MeshError(403, 'decision token rejected: reload the board page and click again');
      }
      const result = await runAction(action, label);
      recordEvent(result.ok ? 'sys' : 'bad', `${action} ${label}: ${result.msg}`).catch(() => {});
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(payloadFor())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // static
    const evidenceOn = evidenceMode(SETTINGS.evidencePanel) === 'on';
    const file = url.pathname === '/' ? (evidenceOn && url.searchParams.has('evidence') ? 'evidence.html' : setupOn && url.searchParams.has('setup') ? 'setup.html' : conversationOn && url.searchParams.has('conversation') ? 'conversation.html' : 'index.html') : url.pathname.slice(1);
    const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    if (!evidenceOn && safe === 'evidence.html') { res.writeHead(404); return res.end('not found'); }
    if (!setupOn && (safe === 'setup.html' || safe === 'setup.js')) { res.writeHead(404); return res.end('not found'); }
    if (!setupWrite && safe === 'setup-write.js') { res.writeHead(404); return res.end('not found'); }
    if (!conversationOn && (safe === 'conversation.html' || safe === 'conversation.js')) { res.writeHead(404); return res.end('not found'); }
    const full = path.join(PUBLIC, safe);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    let body = await readFile(full).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('not found'); }
    if (safe === 'evidence.html' || safe === 'setup.html' || safe === 'conversation.html') body = String(body).replaceAll('%%BRAND%%', esc(SETTINGS.brand || 'Zulu Assistant'));
    // the setup page carries the decision token and the forms' script only in mode 'write'
    if (safe === 'setup.html') body = String(body).replace('%%SETUP_WRITE%%', setupWrite ? `<meta name="mesh-decision" content="${decisionToken}">\n<meta name="board-boot" content="${BOOT_ID}">\n<script src="/setup-write.js" defer></script>` : '');
    if (safe === 'index.html') {
      body = String(body).replace('%%MESH_DECISION%%', decisionToken).replace('%%BOOT_ID%%', BOOT_ID)
        .replaceAll('%%BRAND%%', esc(SETTINGS.brand || 'Zulu Assistant'))
        .replace('%%EVIDENCE%%', evidenceOn ? 'on' : 'off')       // row context: a dry run's time links to the task's receipts
        .replace('%%SETUP_PAGE%%', setupOn ? 'on' : 'off')       // the setup card links to /?setup=1
        .replace('%%CONVERSATION%%', conversationOn ? 'on' : 'off');   // agent tiles link to /?conversation=<session>
    }
    // no-cache: a reload always revalidates, so a fixed app.js can't hide behind a stale copy
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return res.end(body);
  } catch (err) {
    if (err instanceof MeshError || (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500)) return sendJson(res, err.status, { ok: false, msg: err.message, ...(err.extra || {}) });
    res.writeHead(500); res.end(err.message);
  }
});

await gates.loadPolicy().catch((e) => console.error('[guardrails]', e.message));   // writes data/guardrails/triggers for the hook
// receipts a crash left half-written (#369): before listen, so nothing can mint first
await gates.reconcile().catch((e) => console.error('[guardrails] reconcile', e.message));
// approvals that ran out unused while nobody looked (#498): marked expired before anything can be presented
await gates.expireRunOut().catch((e) => console.error('[guardrails] expiry', e.message));
// A new process's first snapshot reads the gate card from its file, and the file on disk is the
// PREVIOUS process's: after a pull and restart the page still said "behind" for one poll. So the card
// is computed once before this process answers anything, waited for at most 3 s (the remote read can
// take longer with no network; it then finishes behind the first poll). Done BEFORE listening, not
// inside the first poll: a status read between "listening" and "first snapshot" has no cards at all.
// This first card is computed before the mesh directory is read, so it does not look at agents' repos yet.
if (!GUARDRAILS_ONLY) await Promise.race([stages.run('guardrails-card', writeGateCard), new Promise((r) => setTimeout(r, FIRST_CARD_WAIT_MS))]);
server.listen(SETTINGS.port, '0.0.0.0', () => {
  console.log(`[ops-board] http://localhost:${SETTINGS.port} (+ tailnet, source-guarded)${DEMO ? ' — DEMO MODE (synthetic data)' : ''}`);
  recordEvent('sys', DEMO ? 'Ops Board started in demo mode — synthetic fleet, nothing real is touched' : 'Ops Board started').catch(() => {});
  poll();
  // #705: after a cold start the Dock's board page may have loaded before this port was open. Reload
  // the board's own Dock pages once (exact addresses only); never adds, switches or retries a reload.
  if (!DEMO && !GUARDRAILS_ONLY && CMUX_PRESENT) {
    reloadDockOnce({
      port: SETTINGS.port,
      run: async (args) => sh(SETTINGS.cmuxBin, args, { CMUX_SOCKET_PASSWORD: await cmuxPassword(), CMUX_QUIET: '1' }),
      appStart: cmuxAppStart,
      log: (text) => recordEvent('sys', text),
    }).catch((e) => console.error('[dock-reload]', e.message));
  }
});
