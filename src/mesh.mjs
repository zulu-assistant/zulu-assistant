// Agent Mesh — fleet directory, reachability and delivery.
//
// Directory = config/agents.json (durable: who owns what, how to reach them)
// joined with the live Claude session registry (~/.claude/sessions/<pid>.json:
// name, status busy/idle, sessionId) and cmux's workspace ↔ session map
// (~/.cmuxterm/claude-hook-sessions.json).
//
// Delivery from a shell (scripts, Codex, the board) is `cmux send` into the
// target's workspace — SendMessage is only callable by Claude sessions. We
// NEVER type into a pane that is showing a dialog (permission prompt, trust
// folder, resume picker, Codex approval) or holding someone's half-typed
// draft: those messages go to the outbox (data/mesh-outbox.json) and are
// retried every board poll until the pane is ready (24h expiry).
import { readFile, writeFile, readdir, rename, mkdir, rmdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { acrossWindows } from './cmux-windows.mjs';
export { acrossWindows, parseWindows } from './cmux-windows.mjs';
import { fileURLToPath } from 'node:url';
import { SETTINGS, writable } from './config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const AGENTS_FILE = writable('config/agents.json');   // overlay/ (seeded from examples/)
export const OUTBOX_FILE = path.join(ROOT, 'data', 'mesh-outbox.json');
const PW_FILE = path.join(ROOT, 'data', 'cmux-socket-password');
const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');
const SESSION_MAP = path.join(os.homedir(), '.cmuxterm', 'claude-hook-sessions.json');

export const OUTBOX_TTL_MS = 24 * 3600e3;
const MAX_MESSAGE = 600;   // a wake is one line that links to the task, never pasted context

// ---- small io helpers --------------------------------------------------------

export async function writeJsonAtomic(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + '\n');
  await rename(tmp, file);
}

export async function loadAgents(file = AGENTS_FILE) {
  const d = JSON.parse(await readFile(file, 'utf8'));
  return d;
}

// Serialize read-modify-write of agents.json across processes with a mkdir lock
// (spawn/close scripts and the board can race).
export async function mutateAgents(fn, file = AGENTS_FILE) {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { await mkdir(lock); break; } catch {
      if (i > 50) throw new Error(`agents.json locked (${lock}) — remove it if no spawn is running`);
      await delay(100);
    }
  }
  try {
    const d = await loadAgents(file);
    const out = (await fn(d)) ?? d;
    await writeJsonAtomic(file, out);
    return out;
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Live Claude sessions from Claude Code's own per-process registry. */
export async function readRegistry(dir = REGISTRY_DIR) {
  const out = [];
  let files = [];
  try { files = await readdir(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      if (d.pid && pidAlive(d.pid)) out.push(d);
    } catch { /* partially written — next read */ }
  }
  return out;
}

export async function readSessionMap(file = SESSION_MAP) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}

// ---- directory (pure) --------------------------------------------------------

export const normTitle = (s) => String(s || '').replace(/^[✳⠂*⌘⚙\s]+/u, '').trim().toLowerCase();

/** The address for a workspace title: "⚙ RESIDENT: Web SEO" → "resident-web-seo". */
export function slugTitle(title) {
  return normTitle(title).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '') || 'workspace';
}

/**
 * Join the static directory with live state. Pure — tests feed fixtures.
 * registry: [{sessionId,name,nameSource,status,pid,cwd}], sessionMap: cmux hook
 * file, workspaces: [{id, ref, title}].
 */
export function buildDirectory({ agents = [], registry = [], sessionMap = {}, workspaces = [] }) {
  const bySession = new Map(registry.map((r) => [r.sessionId, r]));
  const byName = new Map();
  for (const r of registry) byName.set(r.name, [...(byName.get(r.name) || []), r]);
  const activeByWs = sessionMap.activeSessionsByWorkspace || {};
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const lifecycleOf = (sid) => sessionMap.sessions?.[sid]?.agentLifecycle || null;

  const rows = agents.map((a) => {
    const ws = a.workspaceId ? wsById.get(a.workspaceId) : null;
    // identity = the workspace: the address follows its CURRENT title
    const name = ws ? slugTitle(ws.title) : a.name;
    let live = null;
    if (a.vendor === 'claude') {
      const sid = a.workspaceId ? activeByWs[a.workspaceId]?.sessionId : null;
      live = (sid && bySession.get(sid)) || null;
      if (!live) {
        const named = byName.get(name) || [];
        if (named.length === 1) live = named[0];
      }
    }
    const lifecycle = live ? lifecycleOf(live.sessionId) : null;
    return {
      ...a,
      name,
      title: ws?.title || a.title,
      ref: ws?.ref || null,
      workspaceOpen: a.workspaceId ? Boolean(ws) || workspaces.length === 0 : null,
      live: live ? {
        sessionId: live.sessionId,
        ref: live.sessionId.slice(0, 6),
        liveName: live.name,
        nameSource: live.nameSource,
        nameOk: live.name === name,
        status: lifecycle === 'needsInput' ? 'needs_input' : (live.status || 'unknown'),
        pid: live.pid,
      } : null,
    };
  });
  const count = new Map();
  for (const r of rows) if (r.status !== 'closed') count.set(r.name, (count.get(r.name) || 0) + 1);
  for (const r of rows) r.nameCollision = r.status !== 'closed' && count.get(r.name) > 1;
  return rows;
}

/**
 * Diff the directory against the live workspace list. Pure: returns the new
 * doc plus what changed. Never runs on an empty/failed listing (a socket
 * hiccup must not mark the whole fleet closed).
 */
export function reconcile(doc, { workspaces = [], sessionMap = {}, registry = [], ignoreIds = new Set(), now = Date.now() }) {
  const out = structuredClone(doc);
  const changes = { added: [], closed: [], renamed: [], reopened: [], purged: [] };
  if (!workspaces.length) return { doc: out, changes, skipped: 'no workspace listing' };
  const iso = new Date(now).toISOString();
  const byWs = new Map(out.agents.filter((a) => a.workspaceId).map((a) => [a.workspaceId, a]));
  const live = new Set(workspaces.map((w) => w.id));
  const activeByWs = sessionMap.activeSessionsByWorkspace || {};
  const regBySession = new Map(registry.map((r) => [r.sessionId, r]));

  // cmux-generated group anchors (empty placeholder workspaces a `workspace-group
  // create` can make) are not agents: never register them, and drop any that
  // were registered before this guard existed — unless someone has since given
  // the entry real ownership, which makes it a deliberate agent.
  const placeholder = (a) => a.kind === 'unassigned' && a.needsOwnership && !(a.owns || []).length;
  out.agents = out.agents.filter((a) => {
    if (a.workspaceId && ignoreIds.has(a.workspaceId) && placeholder(a)) { changes.purged.push(a); return false; }
    return true;
  });
  for (const a of changes.purged) byWs.delete(a.workspaceId);

  for (const w of workspaces) {
    const name = slugTitle(w.title);
    const a = byWs.get(w.id);
    if (!a && ignoreIds.has(w.id)) continue;
    if (!a) {
      const sid = activeByWs[w.id]?.sessionId;
      const sess = sid ? sessionMap.sessions?.[sid] : null;
      const cwd = (sess?.cwd || regBySession.get(sid)?.cwd || '').replace(/^\/Users\/[^/]+/, '~') || null;
      const entry = {
        name, title: w.title, workspaceId: w.id,
        vendor: sid ? 'claude' : 'unknown', kind: 'unassigned',
        repo: cwd, cwd, owns: [], escalate_to: 'mission-control', status: 'active',
        needsOwnership: true, added_at: iso,
      };
      out.agents.push(entry);
      changes.added.push(entry);
      continue;
    }
    if (a.status === 'closed') { a.status = 'active'; delete a.closed_at; changes.reopened.push(a); }
    if (a.title !== w.title || a.name !== name) {
      changes.renamed.push({ workspaceId: w.id, from: a.name, to: name, title: w.title });
      a.previousNames = [...new Set([...(a.previousNames || []), a.name])].slice(-5);
      a.title = w.title;
      a.name = name;
    }
  }
  for (const a of out.agents) {
    if (a.workspaceId && !live.has(a.workspaceId) && a.status !== 'closed') {
      a.status = 'closed';
      a.closed_at = iso;
      changes.closed.push(a);
    }
  }
  return { doc: out, changes };
}

/** Shortest name prefix the fuzzy tier accepts ("me" once matched a closed agent). */
export const MIN_PREFIX = 3;

/**
 * Resolve "<name>", "<name> [ref]", a workspace title, UUID or workspace:N.
 * Returns { agent } or { error, candidates }.
 * `exact: true` (identities: --as / actor / requester) skips the prefix tier — a
 * self-declared name must name an agent, never merely start one.
 */
export function resolveTarget(query, entries, { exact = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return { error: 'empty target' };
  const refM = q.match(/^(.*?)\s*\[([0-9a-f]{4,})\]$/i);
  if (refM) {
    const [, n, ref] = refM;
    const hit = entries.filter((e) => (!n || e.name === n.toLowerCase())
      && (e.live?.sessionId?.startsWith(ref.toLowerCase()) || e.workspaceId?.toLowerCase().startsWith(ref.toLowerCase())));
    return hit.length === 1 ? { agent: hit[0] } : { error: hit.length ? 'ambiguous ref' : `no agent matches ${q}`, candidates: hit.map(label) };
  }
  const lc = q.toLowerCase();
  const open = entries.filter((e) => e.status !== 'closed');
  const tiers = [
    (e) => e.name === lc || (e.aliases || []).includes(lc),
    (e) => e.workspaceId && e.workspaceId.toLowerCase() === lc,
    (e) => e.ref && e.ref === lc,
    (e) => normTitle(e.title) === normTitle(q),
    (e) => e.live?.liveName === q,
    (e) => (e.previousNames || []).includes(lc),
  ];
  // fuzzy prefix: open agents only, and never on a fragment too short to mean anything
  const prefix = (e) => e.name.startsWith(lc) || normTitle(e.title).startsWith(normTitle(q));
  if (!exact && lc.length >= MIN_PREFIX) tiers.push(prefix);
  for (const t of tiers) {
    let hit = open.filter(t);
    if (!hit.length && t !== prefix) {   // a closed agent still resolves (history), but only exactly + unambiguously
      const all = entries.filter(t);
      if (all.length === 1) hit = all;
    }
    if (hit.length === 1) return { agent: hit[0] };
    if (hit.length > 1) return { error: `"${q}" is ambiguous — use a name or "name [ref]"`, candidates: hit.map(label) };
  }
  const near = exact || lc.length < MIN_PREFIX ? open.filter(prefix) : [];
  return { error: `no agent "${q}" in config/agents.json`, candidates: near.slice(0, 8).map(label) };
}

const label = (e) => `${e.name} [${e.live?.ref || e.workspaceId?.slice(0, 8) || '-'}] (${e.title})`;

// ---- screen classification (pure) ---------------------------------------------

// Checked against the bottom of the viewport only — the conversation above can
// legitimately contain these words.
const DIALOG = [
  /Do you want to (proceed|make this edit|create|overwrite|allow|run)/i,
  /Enter to confirm/i, /Press enter to confirm/i, /Enter to select/i, /Esc to cancel/i,
  /Tab to amend/i, /trust this folder/i, /Resume from summary/i,
  /^\s*[›❯»>]\s*1\.\s+\S/m,                // numbered choice with the cursor on it
  /\(y\)\s*$/m, /\[y\/n\]/i,
];
const BUSY = [/esc to interrupt/i, /\bWorking \(\d/i, /^\s*[✻✶✳✢·*]\s+\S+…\s*\(/m];
const READY_FOOTER = [/\? for shortcuts/i, /shift\+tab to cycle/i, /manual mode on/i, /accept edits on/i, /auto mode on/i, /bypass permissions on/i, /plan mode on/i];
const PLACEHOLDER = /^(Ask Codex to do anything|Try ".*"|Implement \{feature\}|Find and fix a bug.*|Summarize recent commits|Write tests for .*|Explain this codebase|Improve documentation.*|Run \/review.*)$/i;
const SHELL = /(?:^|\s)[%$#]\s*$/;

/** 'dialog' | 'busy' | 'draft' | 'ready' | 'shell' | 'unknown' — plus the draft text. */
export function classifyScreen(screen) {
  const lines = String(screen || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const tail = lines.slice(-14).join('\n');
  if (DIALOG.some((re) => re.test(tail))) return { state: 'dialog' };

  // the input line: last "❯ " (Claude) or "› " / "» " (Codex) line
  let input = null;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    const m = lines[i].match(/^\s*[❯›»]\s?(.*)$/);
    if (m) { input = m[1].trim(); break; }
  }
  const busy = BUSY.some((re) => re.test(tail));
  if (input !== null && input && !PLACEHOLDER.test(input)) return { state: 'draft', draft: input, busy };
  if (busy) return { state: 'busy' };
  if (input !== null && READY_FOOTER.some((re) => re.test(tail))) return { state: 'ready' };
  if (lines.length && SHELL.test(lines[lines.length - 1])) return { state: 'shell' };
  return { state: 'unknown' };
}

/**
 * Decide what to do with a message for a pane in `state`. Pure.
 * wake=true lets a message land in a BUSY Claude/Codex session (both queue
 * typed input for their next turn); dialogs and drafts always queue.
 */
export function deliveryDecision(state, { wake = false } = {}) {
  if (state === 'ready') return { deliver: true };
  if (state === 'busy') return wake ? { deliver: true } : { queue: 'target busy (will deliver when idle; --wake to queue it inside the session now)' };
  if (state === 'dialog') return { queue: 'target is showing a dialog/permission prompt — not typing into it' };
  if (state === 'draft') return { queue: 'target has a half-typed draft in its input box' };
  if (state === 'shell') return { queue: 'target pane is a bare shell (agent not running)' };
  return { queue: 'target screen not recognised' };
}

export function formatWake({ from, text, taskId }) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  const link = taskId ? ` (task #${taskId}: curl -s localhost:3210/api/tasks/${taskId})` : '';
  return `[mesh] from ${from}: ${one}${link}`.slice(0, MAX_MESSAGE + 120);
}

export function validateMessage(text) {
  const s = String(text || '').trim();
  if (!s) return 'message is empty';
  if (s.length > MAX_MESSAGE) return `message too long (${s.length} > ${MAX_MESSAGE}) — put details in the task/handoff and link it`;
  return null;
}

// ---- cmux plumbing -------------------------------------------------------------

let pwCache = null;
async function password() {
  if (pwCache) return pwCache;
  pwCache = (await readFile(PW_FILE, 'utf8')).trim();
  setTimeout(() => { pwCache = null; }, 60_000).unref?.();
  return pwCache;
}

export async function cmux(args, { timeout = 10000 } = {}) {
  const pw = await password().catch(() => '');
  return new Promise((resolve) => {
    execFile(process.env.CMUX_BIN || SETTINGS.cmuxBin, args,
      { timeout, killSignal: 'SIGKILL', maxBuffer: 4 << 20, env: { ...process.env, CMUX_QUIET: '1', CMUX_SOCKET_PASSWORD: pw } },
      (e, so, se) => resolve({ err: e ? (String(se || '').trim() || e.message) : null, out: String(so || '') }));
  });
}

// Listings span every window (src/cmux-windows.mjs, task #152).
// Workspaces of the cmux demo (`install.sh --demo --cmux`) live in their own
// window and must never join the mesh: titled "ZULU DEMO…" and recorded in
// data/demo-cmux-state.json.
export const DEMO_TITLE_PREFIX = 'ZULU DEMO';
export const isDemoWorkspace = (w, demoIds = new Set()) =>
  demoIds.has(String(w.id || '').toUpperCase()) || normTitle(w.title || w.name || '').startsWith(DEMO_TITLE_PREFIX.toLowerCase());
export async function demoWorkspaceIds(file = path.join(ROOT, 'data', 'demo-cmux-state.json')) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    return new Set([...(s.workspaceIds || []), ...(s.panes || []).map((p) => p.wsId)].filter(Boolean).map((x) => String(x).toUpperCase()));
  } catch { return new Set(); }
}

export async function listWorkspaces(run = cmux) {
  const r = await acrossWindows(run, ['workspace', 'list', '--id-format', 'both']);
  if (r.err) return [];
  const rows = [];
  for (const line of r.out.split('\n')) {
    const m = line.match(/(workspace:\d+)\s+([0-9A-F-]{36})\s+(.*?)(\s+\[selected\])?\s*$/);
    if (m) rows.push({ ref: m[1], id: m[2], title: m[3].replace(/^[✳⠂*]\s*/, '').trim() });
  }
  return rows;
}

/**
 * The UUID of a workspace cmux just created, from `cmux --id-format both
 * new-workspace` output ("OK workspace:31 (UUID) …"). Null when absent. Pure.
 */
export function parseCreatedWorkspace(out) {
  const m = String(out || '').match(/workspace:\d+\s*\(([0-9A-Fa-f-]{36})\)/);
  return m ? m[1].toUpperCase() : null;
}

/** ref → UUID from a listing, else a UNIQUE exact title match. Pure. */
export function findWorkspace(list, ref, title) {
  const byRef = ref && list.find((w) => w.ref === ref);
  if (byRef) return byRef.id;
  if (title) {
    const byTitle = list.filter((w) => normTitle(w.title) === normTitle(title));
    if (byTitle.length === 1) return byTitle[0].id;
  }
  return null;
}

/**
 * Resolve a just-created workspace (a lookup right after
 * new-workspace twice missed the new ref and the worker was never registered or
 * briefed). Order: the UUID printed by new-workspace itself; else the listing
 * by ref, retried with backoff; else a unique title match.
 */
export async function resolveNewWorkspace({ out = '', ref = null, title = null, list = listWorkspaces, tries = 6, sleep = delay, waitMs = 500 } = {}) {
  const direct = parseCreatedWorkspace(out);
  if (direct) return { id: direct, via: 'new-workspace output' };
  for (let i = 0; i < tries; i++) {
    const ws = await list();
    const byRef = ref && ws.find((w) => w.ref === ref);
    if (byRef) return { id: byRef.id, via: `listing (try ${i + 1})` };
    if (i === tries - 1) {
      const id = findWorkspace(ws, null, title);
      if (id) return { id, via: 'unique title match' };
    }
    if (i < tries - 1) await sleep(waitMs);
  }
  return { id: null };
}

/**
 * Workspace UUIDs that are cmux-GENERATED group anchors (pure over the two
 * listings): `workspace-group list --json` gives refs, `listWorkspaces` maps
 * ref → UUID.
 */
export function generatedAnchorIds(groupsJson, workspaces) {
  const idByRef = new Map(workspaces.map((w) => [w.ref, w.id]));
  const out = new Set();
  for (const g of groupsJson?.groups || []) {
    if (g.anchor_workspace_is_generated || g.anchor_workspace_provenance === 'generated') {
      const id = idByRef.get(g.anchor_workspace_ref);
      if (id) out.add(id);
    }
  }
  return out;
}

export async function listGroups(run = cmux) {
  const r = await run(['workspace-group', 'list', '--json']);
  if (r.err) return null;
  try { return JSON.parse(r.out); } catch { return null; }
}

export async function liveDirectory({ run = cmux } = {}) {
  const [d, registry, sessionMap, workspaces] = await Promise.all([
    loadAgents(), readRegistry(), readSessionMap(), listWorkspaces(run)]);
  return buildDirectory({ agents: d.agents, registry, sessionMap, workspaces });
}

/**
 * Claude Code's prompt SUGGESTION (dim next-step text after a turn) reads as a
 * draft in plain screen text. Typing one character tells them apart:
 * a suggestion is replaced whole (input becomes just the character), a real
 * draft gets it appended. Backspace then restores either one. Pure verdict:
 * 'ghost' | 'draft' | 'unknown'.
 */
export const PROBE_CHAR = 'x';
export function ghostVerdict(draft, afterProbe) {
  if (afterProbe === null || afterProbe === undefined) return 'unknown';
  if (afterProbe === PROBE_CHAR) return 'ghost';
  if (afterProbe.startsWith(draft.slice(0, 20))) return 'draft';
  return 'unknown';
}

/** Probe an idle Claude pane whose input shows `draft`. Leaves the input as it was. */
export async function probeGhost(ws, draft, { run = cmux, sleep = delay } = {}) {
  const typed = await run(['send', '--workspace', ws, '--', PROBE_CHAR]);
  if (typed.err) return 'unknown';
  await sleep(500);
  const s = await run(['read-screen', '--workspace', ws]);
  await run(['send-key', '--workspace', ws, 'backspace']);   // always undo the probe
  const c = s.err ? null : classifyScreen(s.out);
  const now = c?.state === 'draft' ? c.draft : null;
  return ghostVerdict(draft, now);
}

/**
 * When may a pane's "draft" be probed? Only once the same text has sat unchanged
 * for PROBE_STABLE_MS (someone typing changes it — a probe must never interleave
 * with live keystrokes), and never again once that text proved to be a real draft.
 * `seen` maps workspaceId -> { text, since, verdict }. Pure apart from updating `seen`.
 */
export const PROBE_STABLE_MS = 45e3;
export function mayProbe(seen, ws, text, now) {
  const prev = seen.get(ws);
  if (!prev || prev.text !== text) { seen.set(ws, { text, since: now, verdict: null }); return false; }
  if (prev.verdict === 'draft') return false;
  return now - prev.since >= PROBE_STABLE_MS;
}
const draftSeen = new Map();

/**
 * Try to type one line into the agent's pane. Returns {delivered} or {queued}.
 * `run` is injectable for tests.
 */
export async function deliverNow(agent, line, { wake = false, run = cmux, sleep = delay, seen = draftSeen, now = Date.now() } = {}) {
  if (!agent.workspaceId) return { queued: `${agent.name} has no workspace (kind ${agent.kind})` };
  const ws = agent.workspaceId;
  const screen = await run(['read-screen', '--workspace', ws]);
  if (screen.err) return { queued: `read-screen failed: ${screen.err.slice(0, 100)}` };
  const cls = classifyScreen(screen.out);
  let { state } = cls;
  // an idle Claude pane's "draft" may be a prompt suggestion: typing replaces it, so it is ready
  if (state === 'draft' && !cls.busy && agent.vendor === 'claude' && mayProbe(seen, ws, cls.draft, now)) {
    const verdict = await probeGhost(ws, cls.draft, { run, sleep });
    if (verdict === 'unknown') seen.delete(ws);   // screen moved under us: wait for it to settle again
    else seen.get(ws).verdict = verdict;
    if (verdict === 'ghost') state = 'ready';
  }
  const d = deliveryDecision(state, { wake });
  if (!d.deliver) {
    const shown = state === 'draft' ? `: "${cls.draft.slice(0, 60)}"` : '';
    return { queued: d.queue + shown, state };
  }

  const sent = await run(['send', '--workspace', ws, '--', line]);
  if (sent.err) return { queued: `send failed: ${sent.err.slice(0, 100)}` };
  await sleep(300);
  const key = await run(['send-key', '--workspace', ws, 'enter']);
  if (key.err) return { queued: `enter failed: ${key.err.slice(0, 100)}` };
  // if the line is still sitting in the input box (TUI swallowed the first
  // Enter), press Enter once more
  await sleep(1500);
  const after = await run(['read-screen', '--workspace', ws]);
  const c = classifyScreen(after.out);
  if (c.state === 'draft' && line.startsWith(c.draft.slice(0, 20))) {
    await run(['send-key', '--workspace', ws, 'enter']);
  }
  return { delivered: true, state };
}

// ---- outbox --------------------------------------------------------------------

export async function readOutbox(file = OUTBOX_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
}

/** One pass over queued messages. Returns {delivered:[], expired:[], still:[]}. */
export const DONE_NOTICE_TTL_MS = 2 * 3600e3;
const TERMINAL_TASK = new Set(['done', 'cancelled']);

/**
 * Should a queued wake be dropped instead of retried? (pure)
 * - approval wakes are never dropped by task state (the owner must hear them);
 * - the task vanished → drop;
 * - the task reached done/cancelled SINCE the wake was queued (an "assigned"
 *   or "cc: blocked" wake about work that has ended) → drop;
 * - a completion/cancel notice (queued when the task was already terminal) is
 *   kept, but only for DONE_NOTICE_TTL_MS — a requester who has been busy that
 *   long has seen the ledger. (Without this, a stale "assigned" wake could arrive
 *   after its task was cancelled, and queued wakes retried for hours.)
 */
export function staleReason(m, currentStatus, now = Date.now()) {
  if (!m.taskId || m.kind === 'approval') return null;
  if (currentStatus == null) return `task #${m.taskId} no longer exists`;
  if (TERMINAL_TASK.has(currentStatus) && m.taskStatus !== currentStatus) return `task #${m.taskId} is ${currentStatus} since this was queued`;
  if (TERMINAL_TASK.has(currentStatus) && now - m.queuedAt > DONE_NOTICE_TTL_MS) return `task #${m.taskId} ${currentStatus} notice older than 2h`;
  return null;
}

/** One pass over queued messages. Returns {delivered, expired, dropped, still}. */
export async function drainOutbox({ file = OUTBOX_FILE, now = Date.now(), resolve, deliver = deliverNow, taskStatus = async () => undefined } = {}) {
  const box = await readOutbox(file);
  if (!box.length) return { delivered: [], expired: [], dropped: [], still: [] };
  const delivered = []; const expired = []; const dropped = []; const still = [];
  for (const m of box) {
    if (now - m.queuedAt > OUTBOX_TTL_MS) { expired.push(m); continue; }
    if (m.taskId) {
      const cur = await taskStatus(m.taskId);
      const why = cur === undefined ? null : staleReason(m, cur, now);   // undefined = ledger not consulted
      if (why) { dropped.push({ ...m, dropReason: why }); continue; }
    }
    const agent = await resolve(m.to);
    if (!agent) { still.push({ ...m, lastReason: 'target not in directory' }); continue; }
    const r = await deliver(agent, m.line, { wake: m.wake });
    if (r.delivered) delivered.push(m);
    else still.push({ ...m, attempts: (m.attempts || 0) + 1, lastReason: r.queued });
  }
  await writeJsonAtomic(file, still);
  return { delivered, expired, dropped, still };
}

export async function enqueue(msg, file = OUTBOX_FILE) {
  let box = await readOutbox(file);
  // one pending wake per (target, text) — no storms; and a newer wake about
  // the same task SUPERSEDES the older one (only the latest state is useful)
  if (box.some((m) => m.to === msg.to && m.line === msg.line)) return box.length;
  // (a queued done notice or approval is never superseded — a later comment
  // must not swallow "Task #N done")
  if (msg.taskId) box = box.filter((m) => !(m.to === msg.to && m.taskId === msg.taskId && !['approval', 'done'].includes(m.kind)));
  box.push(msg);
  await writeJsonAtomic(file, box);
  return box.length;
}

// ---- launch kick (fixes the "prompt lands in the input box but never submits" race) ----

const READY_TIMEOUT_MS = 120_000;

/**
 * Wait for a freshly launched claude TUI to be ready, then submit a one-line
 * pointer to the brief and verify it started working. Never answers dialogs
 * (trust-folder etc.) — reports them instead.
 */
export async function kickSession({ workspace, line, name, run = cmux, sleep = delay, now = () => Date.now(), registry = readRegistry, timeoutMs = READY_TIMEOUT_MS }) {
  const t0 = now();
  let state = 'unknown';
  while (now() - t0 < timeoutMs) {
    const s = await run(['read-screen', '--workspace', workspace]);
    state = s.err ? 'unknown' : classifyScreen(s.out).state;
    if (state === 'ready') break;
    if (state === 'dialog' && now() - t0 > 15_000) {
      return { ok: false, reason: 'dialog on screen at launch (trust-folder / permission prompt) — needs a human', state };
    }
    await sleep(2000);
  }
  if (state !== 'ready') return { ok: false, reason: `session never became ready (last state: ${state})`, state };

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (attempt === 1) {
      await run(['send', '--workspace', workspace, '--', line]);
      await sleep(500);
    }
    await run(['send-key', '--workspace', workspace, 'enter']);
    await sleep(4000);
    const regs = name ? await registry() : [];
    const mine = regs.find((r) => r.name === name);
    const s = await run(['read-screen', '--workspace', workspace]);
    const c = classifyScreen(s.out);
    if (mine?.status === 'busy' || c.state === 'busy' || (c.state === 'draft' && c.busy)) return { ok: true, attempt };
    if (c.state === 'dialog') return { ok: true, attempt, note: 'working (already at a permission prompt)' };
    if (c.state === 'ready' && attempt > 1) {
      // input empty and not busy: it ran and finished very fast, or it was eaten
      return { ok: true, attempt, note: 'input cleared (turn may have finished already)' };
    }
  }
  return { ok: false, reason: 'prompt typed but never submitted after 3 Enters' };
}

// ---- restore-name check -------------------------------------------------------

/**
 * The name a session comes back with after `cmux restore` / --resume. cmux
 * replays the CAPTURED launch arguments, so a `--name` given at launch wins
 * over a later /rename (verified: launch as alpha → /rename beta → restore →
 * alpha). Otherwise the transcript's last agent-name record wins;
 * with neither, Claude derives a fresh random one (cwd + hex).
 */
export function expectedRestoreName(launchArgs = [], transcriptName = null) {
  const i = launchArgs.findIndex((a) => a === '--name' || a === '-n');
  if (i >= 0 && launchArgs[i + 1]) return launchArgs[i + 1];
  const eq = launchArgs.find((a) => a.startsWith('--name='));
  if (eq) return eq.slice(7);
  return transcriptName || null;
}

/** The durable name a session will come back with after --resume / cmux restore. */
export async function persistedNameFor(transcriptPath) {
  try {
    const text = await readFile(transcriptPath, 'utf8');
    let name = null;
    for (const m of text.matchAll(/"type":"agent-name","agentName":"([^"]+)"/g)) name = m[1];
    return name;
  } catch { return null; }
}

// ---- session name ↔ workspace title --------------------------------------------

/** Claude agents whose live session name drifted from their title-derived name. */
export function nameDrift(entries) {
  return entries.filter((e) => e.vendor === 'claude' && e.status !== 'closed' && e.live && !e.live.nameOk && !e.nameCollision);
}

/**
 * Type `/rename <name>` into an idle Claude pane (never into a dialog, a busy
 * turn or someone's draft). /rename is a local slash command: no model turn.
 */
export async function ensureSessionName(agent, { run = cmux, sleep = delay, registry = readRegistry } = {}) {
  if (agent.vendor !== 'claude' || !agent.workspaceId) return { skipped: 'not a claude workspace' };
  if (agent.live?.nameOk) return { ok: true, unchanged: true };
  const s = await run(['read-screen', '--workspace', agent.workspaceId]);
  const { state } = classifyScreen(s.out);
  if (state !== 'ready') return { skipped: `pane not ready (${state})` };
  await run(['send', '--workspace', agent.workspaceId, '--', `/rename ${agent.name}`]);
  await sleep(400);
  await run(['send-key', '--workspace', agent.workspaceId, 'enter']);
  await sleep(1500);
  const regs = await registry();
  const mine = regs.find((r) => r.sessionId === agent.live?.sessionId);
  return mine?.name === agent.name ? { ok: true, from: agent.live?.liveName, to: agent.name } : { ok: false, reason: 'rename not confirmed in session registry' };
}
