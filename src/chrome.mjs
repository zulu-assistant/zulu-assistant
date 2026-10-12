// cmux "chrome" driven by the Agent Mesh directory + ledger (Tier 2):
// workspace colors + descriptions per domain, status pills + checklist
// progress per task owner, and optional domain groups.
//
// cmux writes here are LIMITED to: workspace-action set-color / set-description,
// set-status / clear-status, set-progress / clear-progress, and (explicit CLI
// only) workspace-group create/set-color/set-icon. Never rename, close, or
// send text to a pane.
//
// Hand-set values win: we remember what WE applied (data/mesh-chrome-state.json)
// and only change a color/description that is empty or still equal to our
// last-applied value. A value the owner set by hand is left alone and reported.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmux, writeJsonAtomic } from './mesh.mjs';
import { acrossWindows } from './cmux-windows.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CHROME_STATE_FILE = path.join(ROOT, 'data', 'mesh-chrome-state.json');

// Domains: what kind of work an agent owns (directory `domain`). The board-
// consistent phosphor palette below is the default; config/mesh.json `domains`
// ([{ id, label, color, icon }], in sidebar order) replaces it, and the older
// `domainColors` map still overrides colors. Codex panes share one hue.
export const DEFAULT_DOMAINS = [
  { id: 'ops',      label: 'OPS',      color: '#28FE14', icon: 'terminal.fill' },          // Mission Control, board, mesh
  { id: 'app',      label: 'APP',      color: '#E500E5', icon: 'square.stack.3d.up.fill' },
  { id: 'web',      label: 'WEB',      color: '#4A7CFF', icon: 'globe' },
  { id: 'data',     label: 'DATA',     color: '#E5E500', icon: 'cylinder.split.1x2.fill' },
  { id: 'platform', label: 'PLATFORM', color: '#00E5E5', icon: 'cpu.fill' },
  { id: 'infra',    label: 'INFRA',    color: '#999999', icon: 'server.rack' },
];
export const CODEX_COLOR = '#9D7BFF';

/** { colors, labels, icons, order } for a mesh config (pure). */
export function domainTable(cfg = {}) {
  const list = Array.isArray(cfg.domains) && cfg.domains.length ? cfg.domains : DEFAULT_DOMAINS;
  const colors = { ...Object.fromEntries(list.map((d) => [d.id, d.color])), codex: CODEX_COLOR, ...(cfg.domainColors || {}) };
  return {
    colors,
    labels: Object.fromEntries(list.map((d) => [d.id, d.label || d.id.toUpperCase()])),
    icons: Object.fromEntries(list.filter((d) => d.icon).map((d) => [d.id, d.icon])),
    order: list.map((d) => d.id),
  };
}
export const DEFAULT_DOMAIN_COLORS = domainTable().colors;

const DESC_MAX = 64;

// cut at a word boundary so sidebar rows never end mid-word
export function clip(text, max = DESC_MAX) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s·,(+-]+$/, '')}…`;
}

/** Desired workspace color + description for one directory entry (pure). */
export function desiredChrome(agent, cfg = {}) {
  const { colors, labels } = domainTable(cfg);
  const domain = agent.domain || null;
  const color = agent.vendor === 'codex' ? colors.codex : (domain ? colors[domain] : null) || null;
  let description = null;
  if (agent.kind !== 'mission-control') {          // MC's row is left as-is (color only)
    const head = domain ? labels[domain] || domain.toUpperCase() : null;
    const what = agent.needsOwnership ? 'needs ownership' : (agent.owns || [])[0] || '';
    description = clip([head, agent.vendor === 'codex' ? 'codex' : null, what].filter(Boolean).join(' · ')) || null;
  }
  return { color: color ? color.toUpperCase() : null, description };
}

const norm = (c) => (c ? String(c).toUpperCase() : null);

/**
 * Plan color/description writes (pure). `live` = workspace list --json rows
 * ({id, custom_color, description}); `state` = what we last applied.
 * Returns { actions, manual } — manual lists hand-set values left alone.
 */
export function chromePlan(entries, live, state = {}, cfg = {}) {
  const byId = new Map(live.map((w) => [w.id, w]));
  const actions = []; const manual = [];
  for (const a of entries) {
    if (!a.workspaceId || a.status === 'closed') continue;
    const w = byId.get(a.workspaceId);
    if (!w) continue;
    const want = desiredChrome(a, cfg);
    const mine = state[a.workspaceId] || {};
    const curColor = norm(w.custom_color);
    if (want.color && curColor !== want.color) {
      if (curColor && curColor !== norm(mine.color)) manual.push({ name: a.name, field: 'color', value: w.custom_color });
      else actions.push({ workspaceId: a.workspaceId, name: a.name, action: 'set-color', value: want.color });
    }
    const curDesc = w.description || null;
    if (want.description && curDesc !== want.description) {
      if (curDesc && curDesc !== mine.description) manual.push({ name: a.name, field: 'description', value: curDesc });
      else actions.push({ workspaceId: a.workspaceId, name: a.name, action: 'set-description', value: want.description });
    }
  }
  return { actions, manual };
}

// ---- status pills + progress (per task owner) -----------------------------------

export const PILL_STATES = {
  needs_approval: { label: 'APPROVAL', icon: 'flag.fill',               color: '#E5E500', rank: 5 },
  blocked:        { label: 'BLOCKED',  icon: 'xmark.octagon.fill',      color: '#FF8C3C', rank: 4 },
  in_progress:    { label: 'WORKING',  icon: 'bolt.fill',               color: '#00E5E5', rank: 3 },
  claimed:        { label: 'CLAIMED',  icon: 'circle.lefthalf.filled',  color: '#00A600', rank: 2 },
  open:           { label: 'OPEN',     icon: 'circle',                  color: '#157A15', rank: 1 },
};

/**
 * The `task` pill + progress for one owner, from their live tasks (pure).
 * One task → "#4 WORKING" + progress "#4 WORKING · d/4" (checklist fraction).
 * Several → "3 tasks" (resident view) colored by the most urgent state.
 * None → clear both.
 */
export function ownerPill(tasks) {
  const live = tasks.filter((t) => PILL_STATES[t.status]);
  if (!live.length) return { pill: null, progress: null };
  const worst = live.reduce((a, b) => (PILL_STATES[b.status].rank > PILL_STATES[a.status].rank ? b : a));
  const st = PILL_STATES[worst.status];
  // The progress bar doubles as the task-state carrier: custom sidebars (Tier 1)
  // can read a workspace's `progress` but NOT its status pills, so the label
  // repeats the pill text. value = checklist fraction (0 for several tasks).
  if (live.length === 1) {
    const t = live[0];
    const done = Object.values(t.checklist || {}).filter((v) => v === true).length;
    const total = Object.keys(t.checklist || {}).length || 4;
    const value = `#${t.id} ${st.label}`;
    return {
      pill: { key: 'task', value, icon: st.icon, color: st.color },
      progress: { value: Math.round((done / total) * 100) / 100, label: `${value} · ${done}/${total}` },
    };
  }
  const extra = worst.status === 'needs_approval' || worst.status === 'blocked' ? ` · #${worst.id} ${st.label}` : '';
  const value = `${live.length} tasks${extra}`;
  return { pill: { key: 'task', value, icon: st.icon, color: st.color }, progress: { value: 0, label: value } };
}

export const pillSignature = (p) => JSON.stringify(p || null);

/**
 * Fold a genuine input prompt into the workspace progress (pure). Custom
 * sidebars can read `progress` but cmux's own agent `needs_input` status
 * over-reports (idle residents showed ▲ INPUT), so the board
 * publishes the prompts IT can verify — Claude hook lifecycle needsInput
 * (permission/question notifications) and Codex approval dialogs on screen —
 * as a "▲ INPUT · …" progress label. The task pill is unchanged.
 */
export function withInput(want, prompt) {
  if (!prompt) return want;
  const task = want.progress?.label || '';
  return {
    pill: want.pill,
    progress: { value: want.progress?.value || 0, label: `▲ INPUT · ${task || prompt}` },
  };
}

// Context gauge: the progress BAR becomes "context used"; the label
// keeps input + task text: "▲ INPUT · ctx 61% · #14 OPEN · 0/4". A `ctx` pill
// carries the % for the built-in sidebar, colored by band.
export const CTX_COLORS = { ok: '#00A600', amber: '#E5E500', red: '#FF4444' };
const INPUT_PREFIX = '▲ INPUT · ';

export function withContext(want, g) {
  if (!g) return { ...want, ctxPill: null };
  const label = want.progress?.label || '';
  const input = label.startsWith(INPUT_PREFIX);
  const rest = input ? label.slice(INPUT_PREFIX.length) : label;
  // post-/compact estimate (no turn yet): "ctx 2% · compacted · est · #14 OPEN"
  const parts = [...(input ? ['▲ INPUT'] : []), `ctx ${g.pct}%`, ...(g.estimated ? ['compacted · est'] : []), ...(rest ? [rest] : [])];
  return {
    pill: want.pill,
    progress: { value: Math.round(g.pct) / 100, label: parts.join(' · ') },
    ctxPill: { key: 'ctx', value: `${g.pct}%${g.estimated ? ' est' : ''}`, icon: 'gauge.medium', color: CTX_COLORS[g.band] || CTX_COLORS.ok },
  };
}

/** Workspaces with a verified input prompt → short reason. (claude: hook file; codex: screen) */
export async function inputPrompts(entries, sessionMap, { run = cmux, classify } = {}) {
  const out = new Map();
  const active = sessionMap.activeSessionsByWorkspace || {};
  for (const a of entries) {
    if (!a.workspaceId || a.status === 'closed') continue;
    if (a.vendor === 'claude') {
      const s = sessionMap.sessions?.[active[a.workspaceId]?.sessionId];
      if (s?.agentLifecycle === 'needsInput') out.set(a.workspaceId, String(s.lastSubtitle || 'prompt').toLowerCase());
    } else if (a.vendor === 'codex' && classify) {
      const r = await run(['read-screen', '--workspace', a.workspaceId]);
      if (!r.err && classify(r.out).state === 'dialog') out.set(a.workspaceId, 'approval');
    }
  }
  return out;
}

// ---- domain groups (explicit CLI only) -------------------------------------------

/**
 * Proposed sidebar groups by domain (pure). Codex panes join their domain's
 * group. Single-member domains stay ungrouped. Mission Control is never
 * grouped. The anchor (group header) is the first resident of the domain.
 */
export function groupPlan(entries, cfg = {}) {
  const { labels, order } = domainTable(cfg);
  const groups = new Map();
  for (const a of entries) {
    if (!a.workspaceId || a.status === 'closed' || !a.domain) continue;
    // Mission Control is never grouped: a group header IS its anchor's row and
    // shows the group name, which hid MC as "OPS"
    if (a.kind === 'mission-control') continue;
    if (!groups.has(a.domain)) groups.set(a.domain, []);
    groups.get(a.domain).push(a);
  }
  const rank = (a) => (a.kind === 'mission-control' ? 0 : a.kind === 'resident' && a.vendor === 'claude' ? 1 : a.kind === 'resident' ? 2 : 3);
  const out = [];
  for (const [domain, members] of groups) {
    if (members.length < 2) continue;
    members.sort((x, y) => rank(x) - rank(y) || x.name.localeCompare(y.name));
    out.push({ domain, name: labels[domain] || domain.toUpperCase(), anchor: members[0], members });
  }
  const rankOf = (d) => { const i = order.indexOf(d); return i < 0 ? order.length : i; };
  return out.sort((x, y) => rankOf(x.domain) - rankOf(y.domain));
}

/**
 * cmux commands that bring the live groups in line with groupPlan (pure).
 *
 * cmux 0.64.25 facts: `workspace-group create` ALWAYS
 * generates an empty placeholder anchor workspace, even with --from; the
 * placeholder can only be disposed by cmux while it is the sole member of its
 * group. So we REPAIR existing groups in place (set-anchor to the real
 * anchor, remove the placeholder from the group) and only create a group
 * when none exists — which costs one placeholder, reported for closing.
 *
 * groupsJson = `workspace-group list --json`; workspaces = [{id, ref}].
 * Returns { steps: [{group, args}], creates: [{group, args}], placeholders: [wsId] }.
 * A step's args may contain the token '<ref>' — the new group's ref after a create.
 */
export function groupRepairPlan(plan, groupsJson, workspaces, { colors = DEFAULT_DOMAIN_COLORS, icons = domainTable().icons } = {}) {
  const idByRef = new Map(workspaces.map((w) => [w.ref, w.id]));
  const live = groupsJson?.groups || [];
  const steps = []; const creates = []; const placeholders = [];
  const inGroup = new Map();                       // wsId -> group ref
  for (const g of live) for (const r of g.member_workspace_refs || []) inGroup.set(idByRef.get(r), g.ref);

  for (const want of plan) {
    const g = live.find((x) => x.name === want.name);
    const color = colors[want.domain] ? colors[want.domain].toUpperCase() : null;
    const icon = icons[want.domain] || null;
    const ref = g ? g.ref : '<ref>';
    const fix = [];
    let generated = null;
    if (!g) {
      creates.push({ group: want.name, args: ['workspace-group', 'create', '--name', want.name,
        '--idempotency-key', `mesh-domain-${want.domain}`, '--from', want.members.map((m) => m.workspaceId).join(',')] });
    } else {
      const members = new Set((g.member_workspace_refs || []).map((r) => idByRef.get(r)));
      for (const m of want.members) {
        if (!members.has(m.workspaceId)) fix.push(['workspace-group', 'add', '--group', ref, '--workspace', m.workspaceId]);
      }
      if (g.anchor_workspace_is_generated || g.anchor_workspace_provenance === 'generated') generated = idByRef.get(g.anchor_workspace_ref);
    }
    const anchorId = g ? idByRef.get(g.anchor_workspace_ref) : null;
    if (!g || anchorId !== want.anchor.workspaceId) {
      fix.push(['workspace-group', 'set-anchor', '--group', ref, '--workspace', want.anchor.workspaceId]);
    }
    if (!g) fix.push(['workspace-group', 'remove', '--workspace', '<generated>']);
    else if (generated) { fix.push(['workspace-group', 'remove', '--workspace', generated]); placeholders.push(generated); }
    if (color && (!g || String(g.custom_color || '').toUpperCase() !== color)) fix.push(['workspace-group', 'set-color', ref, '--hex', color]);
    if (icon && (!g || g.icon_symbol !== icon)) fix.push(['workspace-group', 'set-icon', ref, '--symbol', icon]);
    for (const args of fix) steps.push({ group: want.name, args });
  }
  return { steps, creates, placeholders };
}

/**
 * Is this workspace a disposable cmux placeholder? Only when cmux (or our
 * memory of it) says it was GENERATED, it is in no group, no Claude session
 * ever ran in it, and nothing was ever submitted in it (pure).
 */
export function isDisposablePlaceholder(ws, { knownPlaceholders = new Set(), groupedIds = new Set(), sessionWorkspaces = new Set() } = {}) {
  return knownPlaceholders.has(ws.id) && !groupedIds.has(ws.id) && !sessionWorkspaces.has(ws.id)
    && !ws.latest_submitted_message && !ws.latest_conversation_message;
}

// ---- appliers (cmux I/O) -------------------------------------------------------

export async function readChromeState(file = CHROME_STATE_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return { workspaces: {}, pills: {} }; }
}

export async function liveWorkspaceRows(run = cmux) {
  const r = await acrossWindows(run, ['workspace', 'list', '--json']);
  if (r.err) return [];
  try { return JSON.parse(r.out).workspaces || []; } catch { return []; }
}

/** Apply up to `max` color/description actions; records what we applied. */
export async function applyChrome(entries, { cfg = {}, apply = true, max = 6, run = cmux, file = CHROME_STATE_FILE } = {}) {
  const live = await liveWorkspaceRows(run);
  if (!live.length) return { skipped: 'no workspace listing', actions: [], manual: [] };
  const state = await readChromeState(file);
  const { actions, manual } = chromePlan(entries, live, state.workspaces, cfg);
  if (!apply) return { actions, manual, applied: [] };
  const applied = [];
  for (const act of actions.slice(0, max)) {
    const args = ['workspace-action', '--workspace', act.workspaceId, '--action', act.action,
      act.action === 'set-color' ? '--color' : '--description', act.value];
    const r = await run(args);
    if (r.err) continue;
    const s = state.workspaces[act.workspaceId] || {};
    s[act.action === 'set-color' ? 'color' : 'description'] = act.value;
    state.workspaces[act.workspaceId] = s;
    applied.push(act);
  }
  if (applied.length) await writeJsonAtomic(file, state);
  return { actions, manual, applied };
}

/** Set/clear the task pill + progress on each owner's workspace, only on change. */
export async function applyPills(entries, tasks, { run = cmux, file = CHROME_STATE_FILE, force = false, prompts = new Map(), ctx = new Map() } = {}) {
  const state = await readChromeState(file);
  state.pills ||= {};
  const changed = [];
  for (const a of entries) {
    if (!a.workspaceId || a.status === 'closed' || a.kind === 'headless') continue;
    const mine = tasks.filter((t) => (t.owner_ws ? t.owner_ws === a.workspaceId : t.owner === a.name));
    const want = withContext(withInput(ownerPill(mine), prompts.get(a.workspaceId)), ctx.get(a.workspaceId));
    const sig = pillSignature(want);
    const prevSig = state.pills[a.workspaceId];
    if (!force && prevSig === sig) continue;
    let prev = {};
    try { prev = prevSig ? JSON.parse(prevSig) || {} : {}; } catch { prev = {}; }
    const ws = ['--workspace', a.workspaceId];
    const same = (x, y) => JSON.stringify(x || null) === JSON.stringify(y || null);
    // each part is written only when it changed, and cleared only if we set it
    if (force || !same(want.pill, prev.pill)) {
      if (want.pill) await run(['set-status', want.pill.key, want.pill.value, '--icon', want.pill.icon, '--color', want.pill.color, '--priority', '60', ...ws]);
      else if (prev.pill) await run(['clear-status', 'task', ...ws]);
    }
    if (force || !same(want.ctxPill, prev.ctxPill)) {
      if (want.ctxPill) await run(['set-status', 'ctx', want.ctxPill.value, '--icon', want.ctxPill.icon, '--color', want.ctxPill.color, '--priority', '50', ...ws]);
      else if (prev.ctxPill) await run(['clear-status', 'ctx', ...ws]);
    }
    if (force || !same(want.progress, prev.progress)) {
      if (want.progress) await run(['set-progress', String(want.progress.value), '--label', want.progress.label, ...ws]);
      else if (prev.progress) await run(['clear-progress', ...ws]);
    }
    changed.push({ name: a.name, pill: want.pill?.value || '-', progress: want.progress?.label || '(cleared)' });
    if (want.pill || want.progress || want.ctxPill) state.pills[a.workspaceId] = sig;
    else delete state.pills[a.workspaceId];
  }
  if (changed.length) await writeJsonAtomic(file, state);
  return changed;
}
