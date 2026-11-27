// Self-heal for cmux session restores that died on socket auth.
//
// cmux 0.64.x loses its socket password on every cold app launch (see
// heal-cmux.mjs). At launch cmux also re-runs each workspace's auto-resume
// command — `cmux restore claude <session-id>` — in the workspace shell, and
// that happens BEFORE the password heal lands, so every restore fails with
//   Error: auth_required: Authentication required.
// and the workspace is left sitting at a bare shell. Nothing retried them, so a
// whole session fleet could stay dead until someone re-sent the restores by hand.
//
// This module runs AFTER the password is healthy and re-sends those restores.
// It is deliberately paranoid: it only touches a workspace whose scrollback
// shows the exact failure signature (restore command → auth error → nothing
// but shell prompts since) and whose visible screen is a bare shell, never one
// with a live claude UI on it.
//
// Second shape: cmux 0.65.0's update relaunch ran NO
// auto-resume at all — every workspace came back as a fresh login shell with no
// restore attempt to match, so the first detector skipped every one. The
// fresh-shell detector restores a workspace only when ALL hold: the scrollback
// is pristine (login banner + untouched prompts, nothing ever typed), cmux
// itself launched within FRESH_WINDOW_MS, the workspace's newest session in the
// hook maps (Claude or Codex) is restorable, and that session's process is not
// running. Codex sessions launched with --profile (custom launchers) are
// reported, never restored. A workspace the hook maps have no entry for is
// resumed from cmux's own session record (same checks, its session not running
// in any process, never for a closed directory entry); a fresh shell passed over
// always gets one log line; and a registered resident still at a bare shell after
// the window is reported once a day, never restored on its own (#620).
//
// Mission Control (#704) is never resumed with `cmux restore`: cmux replays the launch arguments it captured,
// which for Mission Control are only the program (its launcher passes the contract, the allowed tools, the model
// and the name). Its pristine pane gets `scripts/mc-resume.sh <id>` instead, once per cmux launch; anything else
// is one ticker line and one owner notice.
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS } from './config.mjs';
import { acrossWindows } from './cmux-windows.mjs';
import { realpathSync } from 'node:fs';

const PW_FILE = fileURLToPath(new URL('../data/cmux-socket-password', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/+$/, '');
const MC_SESSION_FILE = path.join(REPO_ROOT, 'data', 'mission-control-session-id');

const PASS_INTERVAL_MS = 60_000;      // a pass can't re-enter faster than this
const WORKSPACE_COOLDOWN_MS = 10 * 60_000; // never retry the same workspace inside 10 min
const MAX_REPAIRS_PER_PASS = 12;      // hard stop so a pass can't run away
const SCROLLBACK_LINES = 300;
const SETTLE_MS = 6000;               // let claude paint after the restore
const PICKER_SETTLE_MS = 3000;        // ...and after answering the resume picker
const FRESH_WINDOW_MS = 2 * 3600_000; // fresh-shell restores only this soon after a cmux launch
const FRESH_MIN_AGE_MS = 90_000;      // ...and never sooner: don't race cmux's own auto-resume
const CMUX_DIR = path.join(os.homedir(), '.cmuxterm');
// cmux's own persisted session (the app's state, not the hook maps): read only, for the fallback of #620
const CMUX_SESSION_FILE = path.join(os.homedir(), 'Library', 'Application Support', 'cmux', 'session-com.cmuxterm.app.json');
export const RESIDENT_NOTICE_MS = 24 * 3600_000;  // #620: a resident left a bare shell is reported at most once a day

// ---- screen readers (pure — exported for tests) ----------------------------

// A live claude UI is unmistakable: the boxed prompt plus the mode footer —
// or, when it's waiting on a choice (tool approval, plan pick, /resume list),
// that dialog's own footer instead. Both shapes seen live.
const CLAUDE_MARKERS = [
  /shift\+tab to cycle/i,
  /\?\s+for shortcuts/i,
  /esc to interrupt/i,
  /⏵⏵/,
  /Welcome to Claude Code/i,
  /╭─+╮/,
  /Enter to select/i,
  /Esc to cancel/i,
  /Do you want to proceed\?/i,
  /Tab to amend/i,
];

const AUTH_FAIL = /auth_required|Authentication required|Invalid password|no socket password is configured/i;
const RESTORE_CMD = /cmux\s+restore\s+claude\s+([0-9A-Fa-f-]{36})/;
// default zsh/bash prompts all end in one of these, with nothing typed after it
const SHELL_PROMPT = /(?:^|\s)[%$#>❯➜]\s*$/;

export function isLiveClaude(screen) {
  return CLAUDE_MARKERS.some((re) => re.test(screen || ''));
}

// Codex's TUI: its composer placeholder, agent footer and working line. (It
// also shows "? for shortcuts", which CLAUDE_MARKERS already matches.)
const CODEX_MARKERS = [
  /Ask Codex to do anything/i,
  /←\s*for agents/i,
  /\bWorking \(\d/i,
  /OpenAI Codex/i,
];

/** A live agent UI of either kind — used to confirm Claude AND Codex restores. */
export function isLiveAgent(screen) {
  return isLiveClaude(screen) || CODEX_MARKERS.some((re) => re.test(screen || ''));
}

// The Claude resume picker ("Resume from summary (recommended)" / "Resume full
// session"). Only ever answered when it is actually on screen.
export function isResumePicker(screen) {
  const s = screen || '';
  return /resume\s+from\s+summary/i.test(s) && /resume\s+full\s+session/i.test(s);
}

function isPromptOnly(line) {
  const l = line.replace(/\s+$/, '');
  return l === '' || (l.length < 200 && SHELL_PROMPT.test(l));
}

export function endsAtShellPrompt(viewport) {
  const lines = String(viewport || '').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (!lines.length) return false;
  return isPromptOnly(lines[lines.length - 1]);
}

// Returns { sessionId } when this workspace is a failed auto-resume, else null.
export function detectFailedRestore(viewport, scrollback) {
  if (isLiveClaude(viewport)) return null;         // never touch a live session
  if (!endsAtShellPrompt(viewport)) return null;   // something else is running

  const lines = String(scrollback || '').split('\n');
  let cmdIdx = -1;
  let sessionId = '';
  for (let i = lines.length - 1; i >= 0; i--) {    // most recent attempt wins
    const m = lines[i].match(RESTORE_CMD);
    if (m) { cmdIdx = i; sessionId = m[1]; break; }
  }
  if (cmdIdx < 0) return null;

  const errIdx = lines.findIndex((l, i) => i > cmdIdx && AUTH_FAIL.test(l));
  if (errIdx < 0) return null;

  // nothing but blank lines / untouched prompts since the failure — if anyone
  // (or anything) has used this shell afterwards, leave it alone
  for (let i = errIdx + 1; i < lines.length; i++) {
    if (!isPromptOnly(lines[i])) return null;
  }
  return { sessionId };
}

// A login banner line ("Last login: Tue Oct  6 04:35:35 on ttys012").
const LOGIN_BANNER = /^Last login: /;
// a shell prompt, bare or followed by a command ("me@host dir % ls")
const PROMPT_LINE = /(?:^|\s)[%$#>❯➜](?:\s|$)/;

// True when the shell was never used. The scrollback must START with the login
// banner (so a 300-line window that begins mid-output of an old command can
// never pass); whatever login prints before the first prompt is ignored (e.g.
// "You have mail." — nobody can type it); from
// the first prompt on, only blank lines and untouched prompts are allowed.
export function isPristineShell(viewport, scrollback) {
  if (isLiveAgent(viewport) || !endsAtShellPrompt(viewport)) return false;
  const lines = String(scrollback || '').split('\n');
  const first = lines.findIndex((l) => l.trim());
  if (first < 0 || !LOGIN_BANNER.test(lines[first].trim())) return false;
  // the first line that IS a prompt — with or without something typed after it
  const firstPrompt = lines.findIndex((l, i) => i > first && PROMPT_LINE.test(l));
  if (firstPrompt < 0) return false;
  for (let i = firstPrompt; i < lines.length; i++) if (!isPromptOnly(lines[i])) return false;
  return true;
}

/**
 * The session a workspace should come back as: the newest entry for it across
 * the Claude map (activeSessionsByWorkspace) and the Codex map (sessions[*] by
 * workspaceId). Returns { kind, sessionId, pid } or { skip } or null. Pure.
 */
export function pickRestorable(workspaceId, claudeMap = {}, codexMap = {}) {
  const id = String(workspaceId || '').toUpperCase();
  if (!id) return null;
  const cands = [];
  const ca = claudeMap.activeSessionsByWorkspace?.[id] || claudeMap.activeSessionsByWorkspace?.[workspaceId];
  const cs = ca && claudeMap.sessions?.[ca.sessionId];
  if (cs) cands.push({ kind: 'claude', s: cs, at: Number(ca.updatedAt || cs.updatedAt || 0) });
  for (const x of Object.values(codexMap.sessions || {})) {
    if (String(x.workspaceId || '').toUpperCase() === id) cands.push({ kind: 'codex', s: x, at: Number(x.updatedAt || 0) });
  }
  if (!cands.length) return null;
  const best = cands.sort((a, b) => b.at - a.at)[0];
  const args = best.s.launchCommand?.arguments || [];
  if (best.kind === 'claude' && best.s.isRestorable === false) return { skip: 'claude session not restorable' };
  if (!best.s.launchCommand) return { skip: `${best.kind} session has no launch command` };
  if (best.kind === 'codex' && args.includes('--profile'))
    return { skip: `codex session uses --profile ${args[args.indexOf('--profile') + 1] || ''} (custom launcher)`.trim() };
  if (!/^[0-9A-Fa-f-]{36}$/.test(best.s.sessionId || '')) return { skip: 'malformed session id' };
  return { kind: best.kind, sessionId: best.s.sessionId, pid: best.s.pid || null };
}

/**
 * #620: cmux's own record of each workspace's agent, from its session file (`windows[].tabManager.workspaces[]`,
 * by `workspaceId`; `panels[].terminal.resumeBinding`). A session can drop out of the hook maps (seen 11-07 to
 * 11-14: two residents silent there for weeks) while cmux still records how to resume it. Pure.
 * → { WORKSPACE_ID: [{ kind, sessionId, args, at }] }
 */
export function parseCmuxRecords(json) {
  const out = {};
  for (const w of json?.windows || []) {
    for (const ws of w?.tabManager?.workspaces || []) {
      const id = String(ws?.workspaceId || '').toUpperCase();
      if (!id) continue;
      for (const p of ws.panels || []) {
        const b = p?.terminal?.resumeBinding;
        if (!b || typeof b !== 'object') continue;
        (out[id] ||= []).push({ kind: b.kind, sessionId: b.checkpointId, args: b.launchCommand?.arguments || null, at: Number(b.updatedAt || 0) });
      }
    }
  }
  return out;
}

/** #620: the session to resume from cmux's record, with the same checks the hook maps get. Pure. → { kind, sessionId, source } | { skip } | null */
export function pickFromRecord(workspaceId, records = {}) {
  const list = records[String(workspaceId || '').toUpperCase()] || [];
  if (!list.length) return null;
  const best = [...list].sort((a, b) => b.at - a.at)[0];
  if (!['claude', 'codex'].includes(best.kind)) return { skip: `cmux record of kind ${best.kind || 'none'}` };
  if (!Array.isArray(best.args)) return { skip: `${best.kind} session in cmux's record has no launch command` };
  if (best.kind === 'codex' && best.args.includes('--profile'))
    return { skip: `codex session uses --profile ${best.args[best.args.indexOf('--profile') + 1] || ''} (custom launcher)`.trim() };
  if (!/^[0-9A-Fa-f-]{36}$/.test(best.sessionId || '')) return { skip: 'malformed session id in cmux\'s record' };
  return { kind: best.kind, sessionId: best.sessionId, pid: null, source: 'cmux record' };
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}
const readMaps = async () => ({
  claude: await readJson(path.join(CMUX_DIR, 'claude-hook-sessions.json')),
  codex: await readJson(path.join(CMUX_DIR, 'codex-hook-sessions.json')),
  records: parseCmuxRecords(await readJson(CMUX_SESSION_FILE)),
});

// #620: the session ids running processes carry (`claude --resume <id>`, `codex resume <id>`): a session from cmux's
// record that runs somewhere else is not resumed a second time. One `ps` per pass, only when a fallback is reached.
// null = could not be read (then nothing is restored from the record).
const runningSessionIds = () => new Promise((resolve) => {
  execFile('ps', ['-axww', '-o', 'args='], { timeout: 5000, maxBuffer: 8 << 20 }, (e, so) => {
    if (e) return resolve(null);
    resolve(new Set((String(so).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) || []).map((x) => x.toLowerCase())));
  });
});

// When did the running cmux app start? (ms, or 0 if not found). Also read by src/dock-reload.mjs (#705).
export const cmuxAppStart = () => new Promise((resolve) => {
  execFile('ps', ['-axo', 'lstart=,command='], { timeout: 5000, maxBuffer: 8 << 20 }, (e, so) => {
    if (e) return resolve(0);
    const line = String(so).split('\n').find((l) => /\/cmux\.app\/Contents\/MacOS\/cmux\s*$/.test(l));
    resolve(line ? Date.parse(line.slice(0, 24)) || 0 : 0);
  });
});

const pidAlive = (pid) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

export function parseWorkspaces(out) {
  const rows = [];
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/(workspace:\d+)\s+(?:([0-9A-Fa-f-]{36})\s+)?(.*?)(\s+\[selected\])?\s*$/);
    if (m) rows.push({ ref: m[1], id: m[2] || null, name: m[3].replace(/^[✳⠂*]\s*/, '').trim() });
  }
  return rows;
}

// ---- cmux plumbing ---------------------------------------------------------

const cmuxExec = (args, pw) => new Promise((resolve) => {
  execFile(SETTINGS.cmuxBin, args,
    { timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4 << 20,
      env: { ...process.env, CMUX_QUIET: '1', CMUX_SOCKET_PASSWORD: pw } },
    (e, so, se) => resolve({ err: e ? (String(se || '').trim() || e.message) : null, out: String(so || '') }));
});

// default logger: one ticker line per repaired workspace (the board's own API)
async function postEvent(text) {
  try {
    await fetch(`http://127.0.0.1:${SETTINGS.port}/api/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'sys', text }),
    });
  } catch { /* ticker logging is best-effort */ }
}

// ---- the pass --------------------------------------------------------------

const lastAttempt = new Map(); // workspace ref -> ts
const skipped = new Set();      // workspace refs already reported as "fresh but not restorable"
const residentNoticed = new Map(); // #620: workspace ref -> when a resident left bare was last reported
const bareFiled = new Map();       // #678: source key -> task id, once this process has filed (or found) its task
const mcTried = new Set();         // #704: <workspace>@<cmux launch>: Mission Control gets one try per launch
let lastPass = 0;
let running = false;

/**
 * #678: the ledger key of one bare-resident episode: the workspace and the cmux launch it dates from. The ledger
 * dedupes keys across closed tasks, so a board restart files nothing new, and a task closed or cancelled for the
 * episode keeps it quiet until the next relaunch.
 */
export const bareResidentKey = (workspaceId, start) => `bare-resident:${String(workspaceId || '').toUpperCase()}@${new Date(start).toISOString()}`;

/** #682: a session time from the hook maps or cmux's record (Unix seconds with a fraction) as an ISO date; 0 / none → null. */
export const sessionTimeIso = (at) => (Number(at) > 0 ? new Date(Number(at) * 1000).toISOString() : null);

/**
 * #678: the newest session written for a workspace, from the hook maps or cmux's own record (facts for the task,
 * whether or not it could be restored). Pure. → { kind, sessionId, at, source } | null
 * `at` is as the files keep it: Unix SECONDS with a fraction, in both hook maps and cmux's record (#682).
 */
export function lastSessionOf(workspaceId, maps = {}) {
  const id = String(workspaceId || '').toUpperCase();
  if (!id) return null;
  const cands = [];
  const ca = maps.claude?.activeSessionsByWorkspace?.[id] || maps.claude?.activeSessionsByWorkspace?.[workspaceId];
  const cs = ca && maps.claude?.sessions?.[ca.sessionId];
  if (cs) cands.push({ kind: 'claude', sessionId: cs.sessionId || ca.sessionId, at: Number(ca.updatedAt || cs.updatedAt || 0), source: 'hook map' });
  for (const x of Object.values(maps.codex?.sessions || {})) {
    if (String(x.workspaceId || '').toUpperCase() === id) cands.push({ kind: 'codex', sessionId: x.sessionId, at: Number(x.updatedAt || 0), source: 'hook map' });
  }
  for (const r of (maps.records || {})[id] || []) cands.push({ kind: r.kind, sessionId: r.sessionId, at: Number(r.at || 0), source: 'cmux record' });
  return cands.length ? cands.sort((a, b) => b.at - a.at)[0] : null;
}

// ---- #704: Mission Control comes back through its own launcher ----------------------------------------

/** A session id that may go into a typed line: a strict UUID, nothing else. */
export const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Claude Code's project folder name for a working folder: every character that is not a letter or digit is '-'. */
export const projectSlug = (dir) => String(dir).replace(/\/+$/, '').replace(/[^A-Za-z0-9]/g, '-');
/** One word for the shell, whatever the path holds. */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// a folder-trust question: never answered by the board, and never read as a live agent
const TRUST_DIALOG = /trust (?:the files|this folder)|Do you trust/i;
export const MC_LAUNCHER = 'scripts/mc-resume.sh';
const MC_FILE_NAME = 'data/mission-control-session-id';

/**
 * #704: the session Mission Control comes back as. Pure.
 * fileId = the text of data/mission-control-session-id (Mission Control writes it); mapped = the newest hook-map session
 * for its workspace (lastSessionOf without cmux's record); times = { id: transcript mtime in ms | null } for each id,
 * read from the board checkout's own project folder. The hook map's session wins only when it is another strict UUID
 * of kind claude whose transcript is in that folder and newer than the file's.
 * → { sessionId, from, other } | { skip }
 */
export function pickMissionControl(fileId, mapped, times = {}) {
  const own = String(fileId || '').trim();
  const ownAt = STRICT_UUID.test(own) ? times[own] ?? null : null;
  const alt = mapped?.source === 'hook map' && mapped.kind === 'claude' && STRICT_UUID.test(mapped.sessionId || '')
    && mapped.sessionId.toLowerCase() !== own.toLowerCase() ? mapped.sessionId : null;
  const altAt = alt ? times[alt] ?? null : null;
  if (alt && altAt != null && (ownAt == null || altAt > ownAt)) return { sessionId: alt, from: 'the hook map', other: own || null };
  if (!own) return { skip: `no id in ${MC_FILE_NAME}` };
  if (!STRICT_UUID.test(own)) return { skip: `the id in ${MC_FILE_NAME} is not a UUID` };
  if (ownAt == null) return { skip: `no transcript for ${own.slice(0, 8)} in the project folder` };
  return { sessionId: own, from: MC_FILE_NAME, other: alt };
}

/** #704: the line typed into Mission Control's pane. Throws on anything but a strict UUID. */
export function mcResumeLine(repoRoot, sessionId) {
  if (!STRICT_UUID.test(String(sessionId || ''))) throw new Error('not a session id');
  return `cd ${shellQuote(repoRoot)} && ${MC_LAUNCHER} ${sessionId}`;
}

const readMcSessionId = async () => { try { return (await readFile(MC_SESSION_FILE, 'utf8')).trim(); } catch { return ''; } };
const mcTranscriptAt = async (id) => {
  try { return (await stat(path.join(os.homedir(), '.claude', 'projects', projectSlug(REPO_ROOT), `${id}.jsonl`))).mtimeMs; } catch { return null; }
};

export function resetHealRestoreState() {
  lastAttempt.clear();
  skipped.clear();
  residentNoticed.clear();
  bareFiled.clear();
  mcTried.clear();
  lastPass = 0;
  running = false;
}

/**
 * One retry pass. Safe to call every poll — it self-throttles.
 * opts.cmux/log/sleep are injectable for tests.
 */
export async function maybeHealFailedRestores(opts = {}) {
  const {
    cmux = cmuxExec,
    log = postEvent,
    notify = null,
    onRepaired = null,     // (ws) => …  e.g. the mesh re-adopting the title-derived name
    dryRun = false,        // detect + report only; never types into a pane
    sleep = delay,
    now = () => Date.now(),
    pwFile = PW_FILE,
    sessionMaps = readMaps,     // fresh-shell detector inputs (injectable for tests)
    appStart = cmuxAppStart,
    isAlive = pidAlive,
    runningIds = runningSessionIds,   // #620: session ids running processes carry (null = unread)
    directory = async () => [],       // #620: the mesh directory ({ workspaceId, name, kind, status })
    fileBareResident = null,          // #678: (facts) => task: ONE keyed ledger task per bare-resident episode
    mcSessionId = readMcSessionId,    // #704: the id Mission Control recorded ('' = none)
    transcriptAt = mcTranscriptAt,    // #704: (id) => mtime ms of <id>.jsonl in the board checkout's project folder | null
    repoRoot = REPO_ROOT,             // #704: where scripts/mc-resume.sh is run from
  } = opts;

  // #620 (c): a registered resident whose pane is still a bare shell after the window: never restored on its own
  // (it may have been left so on purpose). #678: one task per episode (keyed by the workspace and the cmux launch,
  // so a board restart files nothing new; the in-memory notice it replaces was sent again at every restart), and
  // one ticker line a day that names the task.
  const residentLeftBare = async (ws, entry, age, start, maps) => {
    if (entry?.kind !== 'resident' || entry.status !== 'active') return;
    const name = entry.name || ws.name || ws.ref;
    const key = bareResidentKey(ws.id, start);
    if (fileBareResident && !bareFiled.has(key)) {
      const last = lastSessionOf(ws.id, maps);
      const pick = pickRestorable(ws.id, maps.claude, maps.codex) || pickFromRecord(ws.id, maps.records || {});
      const restore = pick && !pick.skip ? `CMUX_SOCKET_PASSWORD=$(cat ${JSON.stringify(pwFile)}) ${SETTINGS.cmuxBin} restore ${pick.kind} ${pick.sessionId}` : null;
      try {
        const t = await fileBareResident({ key, name, workspaceId: ws.id, hours: Math.floor(age / 3600_000), launchedAt: new Date(start).toISOString(),
          lastSession: last && { ...last, at: sessionTimeIso(last.at) }, restore, restoreSkip: pick?.skip || (pick ? null : 'no session record') });
        bareFiled.set(key, t?.id ?? null);
      } catch (e) { console.log('[heal-restore] bare-resident task:', e.message); }   // tried again next pass
    }
    if (residentNoticed.has(ws.ref) && now() - residentNoticed.get(ws.ref) < RESIDENT_NOTICE_MS) return;
    residentNoticed.set(ws.ref, now());
    const task = bareFiled.get(key);
    const line = `restore-retry: resident ${name} is still a bare shell ${Math.floor(age / 3600_000)} h after the cmux relaunch: not restored on its own; restore it, or close its directory entry${task ? ` (#${task})` : ''}`;
    console.log('[heal-restore]', line);
    await log(line);
  };

  if (running) return { skipped: 'in-flight', repaired: [] };
  if (!dryRun && now() - lastPass < PASS_INTERVAL_MS) return { skipped: 'throttled', repaired: [] };
  running = true;
  lastPass = now();

  const repaired = [];
  const attempted = [];
  let fresh = null;              // { maps, start } — read once, only if a pristine shell shows up
  try {
    let pw = '';
    try { pw = (await readFile(pwFile, 'utf8')).trim(); } catch { /* no password on disk */ }
    if (!pw) return { skipped: 'no-password', repaired };

    // Gate: only run once the socket actually answers. While the password is
    // still broken this is heal-cmux.mjs's problem, not ours.
    const list = await acrossWindows((a) => cmux(a, pw), ['workspace', 'list', '--id-format', 'both']);
    if (list.err) return { skipped: 'socket-unhealthy', repaired };

    let dir = null;                // the mesh directory, read once per pass when a pane needs it
    const dirList = async () => (dir ??= await Promise.resolve().then(directory).catch(() => []) || []);
    const freshInputs = async () => (fresh ??= { maps: await sessionMaps(), start: await appStart(), dir: await dirList() });

    // #704: Mission Control's pane. Pristine only, once per cmux launch, through its own launcher; every other
    // outcome inside the window is one ticker line and one owner notice. Never a `cmux restore`, never a dialog answer.
    const missionControl = async (ws, viewport, scroll) => {
      const f = await freshInputs();
      const age = now() - f.start;
      if (!f.start || age < FRESH_MIN_AGE_MS || age > FRESH_WINDOW_MS) return;
      const key = `${String(ws.id).toUpperCase()}@${f.start}`;
      if (mcTried.has(key)) return;
      const label = ws.name || ws.ref;
      const giveUp = async (why) => {
        const line = `restore-retry: Mission Control "${label}" (${ws.ref}) not resumed: ${why}; run ${MC_LAUNCHER} in its pane`;
        console.log('[heal-restore]', line);
        if (dryRun) return;
        await log(line);
        if (notify) await Promise.resolve(notify('Ops Board · self-heal', 'Mission Control', line)).catch(() => {});
      };
      if (!dryRun) mcTried.add(key);   // one try per cmux launch, whatever happens below
      if (!isPristineShell(viewport, scroll)) return giveUp('its pane is not a fresh shell');
      const fileId = String(await Promise.resolve().then(mcSessionId).catch(() => '') || '').trim();
      const mapped = lastSessionOf(ws.id, { claude: f.maps.claude, codex: f.maps.codex });
      const times = {};
      for (const id of new Set([fileId, mapped?.sessionId].filter((x) => STRICT_UUID.test(x || '')))) {
        times[id] = await Promise.resolve().then(() => transcriptAt(id)).catch(() => null);
      }
      const pick = pickMissionControl(fileId, mapped, times);
      if (pick.skip) return giveUp(pick.skip);
      const ids = new Set([pick.sessionId, pick.other].filter(Boolean));
      console.log(`[heal-restore] Mission Control: ${pick.sessionId} from ${pick.from}${pick.other ? ` (also seen: ${pick.other})` : ''}`);
      const runningNow = await runningIds();
      if (!runningNow) return giveUp('the running sessions could not be read');
      if (runningNow.has(pick.sessionId.toLowerCase())) return giveUp(`its session ${pick.sessionId.slice(0, 8)} is running elsewhere`);
      if (isAlive(f.maps.claude?.sessions?.[pick.sessionId]?.pid)) return giveUp(`its session ${pick.sessionId.slice(0, 8)} is running`);
      const why = `fresh shell after a cmux relaunch, through ${MC_LAUNCHER} (session from ${pick.from}${ids.size > 1 ? `; ${[...ids].map((x) => x.slice(0, 8)).join(' / ')}` : ''})`;
      if (dryRun) { attempted.push({ ref: ws.ref, name: ws.name, sessionId: pick.sessionId, kind: 'mission-control', why }); return; }
      lastAttempt.set(ws.ref, now());
      attempted.push(ws.ref);

      const sent = await cmux(['send', '--workspace', ws.ref, '--', mcResumeLine(repoRoot, pick.sessionId)], pw);
      if (sent.err) return giveUp(`the send failed (${sent.err})`);
      const key2 = await cmux(['send-key', '--workspace', ws.ref, 'enter'], pw);
      if (key2.err) return giveUp(`the enter failed (${key2.err})`);
      await sleep(SETTLE_MS);
      let after = await cmux(['read-screen', '--workspace', ws.ref], pw);
      if (!after.err && TRUST_DIALOG.test(after.out)) return giveUp('a trust dialog is on screen (left for the owner)');
      if (!after.err && isResumePicker(after.out)) {
        await cmux(['send-key', '--workspace', ws.ref, 'enter'], pw);
        await sleep(PICKER_SETTLE_MS);
        after = await cmux(['read-screen', '--workspace', ws.ref], pw);
      }
      if (after.err || TRUST_DIALOG.test(after.out) || !isLiveAgent(after.out)) return giveUp('the resume was sent, the agent UI is not confirmed');
      const line = `restore-retry: re-resumed Mission Control "${label}" (${ws.ref}, ${pick.sessionId.slice(0, 8)}) ${why}`;
      console.log('[heal-restore]', line);
      await log(line);
      repaired.push({ ref: ws.ref, name: ws.name, sessionId: pick.sessionId, kind: 'mission-control' });
      if (onRepaired) await Promise.resolve(onRepaired(ws)).catch((e) => console.log('[heal-restore] onRepaired:', e.message));
    };

    for (const ws of parseWorkspaces(list.out)) {
      if (repaired.length >= MAX_REPAIRS_PER_PASS) {
        console.log('[heal-restore] per-pass cap reached; remaining workspaces wait for the next pass');
        break;
      }
      if (now() - (lastAttempt.get(ws.ref) || 0) < WORKSPACE_COOLDOWN_MS) continue;
      if (/^zulu demo\b/i.test(ws.name || '')) continue;   // the cmux demo's own panes are never restored

      const viewport = await cmux(['read-screen', '--workspace', ws.ref], pw);
      if (viewport.err) { console.log(`[heal-restore] read-screen ${ws.ref} failed: ${viewport.err}`); continue; }
      if (isLiveAgent(viewport.out)) continue;   // cheap exit before the scrollback read

      const scroll = await cmux(
        ['read-screen', '--workspace', ws.ref, '--scrollback', '--lines', String(SCROLLBACK_LINES)], pw);
      if (scroll.err) { console.log(`[heal-restore] scrollback ${ws.ref} failed: ${scroll.err}`); continue; }

      // #704: Mission Control has its own path, and never the two below
      const dirEntry = ws.id ? (await dirList()).find((a) => String(a.workspaceId || '').toUpperCase() === String(ws.id).toUpperCase()) : null;
      if (dirEntry?.kind === 'mission-control') {
        if (dirEntry.status !== 'closed') await missionControl(ws, viewport.out, scroll.out);
        continue;
      }

      let hit = detectFailedRestore(viewport.out, scroll.out);
      if (hit) hit = { ...hit, kind: 'claude', why: 'after auth_required' };
      else if (ws.id && isPristineShell(viewport.out, scroll.out)) {
        // second shape: cmux relaunched and never attempted the resume
        await freshInputs();
        const age = now() - fresh.start;
        const entry = (fresh.dir || []).find((a) => String(a.workspaceId || '').toUpperCase() === String(ws.id).toUpperCase()) || null;
        // #620 (c): past the window nothing is restored; a registered resident still at a bare shell is reported, once a day
        if (fresh.start && age > FRESH_WINDOW_MS) { if (!dryRun) await residentLeftBare(ws, entry, age, fresh.start, fresh.maps); continue; }
        if (!fresh.start || age < FRESH_MIN_AGE_MS) continue;
        // #620 (b): a fresh shell is never passed over without a line (once per workspace)
        const passOver = (why) => { if (!skipped.has(ws.ref)) { skipped.add(ws.ref); console.log(`[heal-restore] ${ws.name || ws.ref}: fresh shell, not restored (${why})`); } };
        let pick = pickRestorable(ws.id, fresh.maps.claude, fresh.maps.codex);
        // #620 (a): no entry in the hook maps: cmux's own record, with the same checks, never for a closed directory entry
        if (!pick) {
          pick = pickFromRecord(ws.id, fresh.maps.records || {});
          if (pick && !pick.skip && entry?.status === 'closed') pick = { skip: 'its directory entry is closed' };
        }
        if (!pick) { passOver('no session record'); continue; }
        if (pick.skip) { passOver(pick.skip); continue; }
        if (pick.source) {
          fresh.running ??= await runningIds();
          if (!fresh.running) { passOver('the running sessions could not be read'); continue; }
          if (fresh.running.has(pick.sessionId.toLowerCase())) { passOver(`its session ${pick.sessionId.slice(0, 8)} is running elsewhere`); continue; }
        }
        if (isAlive(pick.pid)) { passOver(`its session ${pick.sessionId.slice(0, 8)} is running`); continue; }   // running somewhere — leave it
        hit = { sessionId: pick.sessionId, kind: pick.kind, why: `fresh shell after a cmux relaunch with no auto-resume${pick.source ? ' (session from cmux\'s own record)' : ''}` };
      }
      if (!hit) continue;

      if (dryRun) { attempted.push({ ref: ws.ref, name: ws.name, sessionId: hit.sessionId, kind: hit.kind, why: hit.why }); continue; }
      lastAttempt.set(ws.ref, now());            // burn the cooldown before acting
      attempted.push(ws.ref);

      const cmd = `CMUX_SOCKET_PASSWORD=$(cat ${JSON.stringify(pwFile)}) `
        + `${SETTINGS.cmuxBin} restore ${hit.kind} ${hit.sessionId}`;
      const sent = await cmux(['send', '--workspace', ws.ref, '--', cmd], pw);
      if (sent.err) { console.log(`[heal-restore] send ${ws.ref} failed: ${sent.err}`); continue; }
      const key = await cmux(['send-key', '--workspace', ws.ref, 'enter'], pw);
      if (key.err) { console.log(`[heal-restore] enter ${ws.ref} failed: ${key.err}`); continue; }

      await sleep(SETTLE_MS);
      let after = await cmux(['read-screen', '--workspace', ws.ref], pw);
      // claude may offer "Resume from summary (recommended) / Resume full
      // session" — accept the recommended default, but only if it's on screen
      if (!after.err && isResumePicker(after.out)) {
        await cmux(['send-key', '--workspace', ws.ref, 'enter'], pw);
        await sleep(PICKER_SETTLE_MS);
        after = await cmux(['read-screen', '--workspace', ws.ref], pw);
      }

      const ok = !after.err && isLiveAgent(after.out);
      const label = ws.name || ws.ref;
      const line = ok
        ? `restore-retry: re-resumed "${label}" (${ws.ref}, ${hit.kind} ${hit.sessionId.slice(0, 8)}) ${hit.why}`
        : `restore-retry: re-sent ${hit.kind} restore in "${label}" (${ws.ref}) — agent UI not confirmed yet`;
      console.log('[heal-restore]', line);
      await log(line);
      if (ok) {
        repaired.push({ ref: ws.ref, name: ws.name, sessionId: hit.sessionId, kind: hit.kind });
        if (onRepaired) await Promise.resolve(onRepaired(ws)).catch((e) => console.log('[heal-restore] onRepaired:', e.message));
      }
    }

    if (notify && repaired.length) {
      await notify('Ops Board · self-heal', 'cmux restores',
        `${repaired.length} session${repaired.length > 1 ? 's' : ''} re-resumed after a cmux relaunch: `
        + repaired.map((r) => r.name || r.ref).join(', '));
    }
    return { repaired, attempted };
  } finally {
    running = false;
  }
}

// manual pass: `node src/heal-restore.mjs` (handy without bouncing the board)
// `--dry-run` only reports: which workspaces would be re-resumed, and — for the
// Agent Mesh — the name each live/restorable Claude session will come back
// with (the transcript's last agent-name record; set by --name or /rename,
// it survives --resume and `cmux restore`).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const dryRun = process.argv.includes('--dry-run');
  const r = await maybeHealFailedRestores({ dryRun, log: dryRun ? async () => {} : postEvent });
  if (dryRun) {
    const { liveDirectory, persistedNameFor, readSessionMap, expectedRestoreName } = await import('./mesh.mjs');
    const [dir, map] = await Promise.all([liveDirectory(), readSessionMap()]);
    r.names = dir.filter((a) => a.vendor === 'claude' && a.status !== 'closed' && a.workspaceId).map((a) => {
      const sid = map.activeSessionsByWorkspace?.[a.workspaceId]?.sessionId;
      const sess = map.sessions?.[sid];
      return { workspace: a.title, meshName: a.name, sessionId: sid?.slice(0, 8) || null,
        transcript: sess?.transcriptPath, args: sess?.launchCommand?.arguments || [] };
    });
    for (const n of r.names) {
      n.restoresAs = expectedRestoreName(n.args, n.transcript ? await persistedNameFor(n.transcript) : null);
      n.survivesRestore = n.restoresAs === n.meshName;   // false ⇒ the reconciler re-renames it (mesh.autoRename)
      delete n.transcript; delete n.args;
    }
  }
  console.log(JSON.stringify(r, null, 2));
}
