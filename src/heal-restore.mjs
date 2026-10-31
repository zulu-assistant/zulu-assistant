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
// reported, never restored.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SETTINGS } from './config.mjs';
import { acrossWindows } from './cmux-windows.mjs';
import { realpathSync } from 'node:fs';

const PW_FILE = fileURLToPath(new URL('../data/cmux-socket-password', import.meta.url));

const PASS_INTERVAL_MS = 60_000;      // a pass can't re-enter faster than this
const WORKSPACE_COOLDOWN_MS = 10 * 60_000; // never retry the same workspace inside 10 min
const MAX_REPAIRS_PER_PASS = 12;      // hard stop so a pass can't run away
const SCROLLBACK_LINES = 300;
const SETTLE_MS = 6000;               // let claude paint after the restore
const PICKER_SETTLE_MS = 3000;        // ...and after answering the resume picker
const FRESH_WINDOW_MS = 2 * 3600_000; // fresh-shell restores only this soon after a cmux launch
const FRESH_MIN_AGE_MS = 90_000;      // ...and never sooner: don't race cmux's own auto-resume
const CMUX_DIR = path.join(os.homedir(), '.cmuxterm');

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

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}
const readMaps = async () => ({
  claude: await readJson(path.join(CMUX_DIR, 'claude-hook-sessions.json')),
  codex: await readJson(path.join(CMUX_DIR, 'codex-hook-sessions.json')),
});

// When did the running cmux app start? (ms, or 0 if not found)
const cmuxAppStart = () => new Promise((resolve) => {
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
let lastPass = 0;
let running = false;

export function resetHealRestoreState() {
  lastAttempt.clear();
  skipped.clear();
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
  } = opts;

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

      let hit = detectFailedRestore(viewport.out, scroll.out);
      if (hit) hit = { ...hit, kind: 'claude', why: 'after auth_required' };
      else if (ws.id && isPristineShell(viewport.out, scroll.out)) {
        // second shape: cmux relaunched and never attempted the resume
        fresh ??= { maps: await sessionMaps(), start: await appStart() };
        const age = now() - fresh.start;
        if (!fresh.start || age > FRESH_WINDOW_MS || age < FRESH_MIN_AGE_MS) continue;
        const pick = pickRestorable(ws.id, fresh.maps.claude, fresh.maps.codex);
        if (!pick) continue;
        if (pick.skip) {
          if (!skipped.has(ws.ref)) { skipped.add(ws.ref); console.log(`[heal-restore] ${ws.name || ws.ref}: fresh shell, not restored (${pick.skip})`); }
          continue;
        }
        if (isAlive(pick.pid)) continue;          // that session is running somewhere — leave it
        hit = { sessionId: pick.sessionId, kind: pick.kind, why: 'fresh shell after a cmux relaunch with no auto-resume' };
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
