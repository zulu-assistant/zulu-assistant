// Daily decision page (#788, SETTINGS.decidePage): one list of everything that waits on the owner,
// ordered by what the wait costs. Read-only: every button on it is the strip's own button (the same
// PATCH, the decision token, the decision door). The list comes from the attention view
// (src/attention.mjs buildAttention), so snoozed items stay out of it as they do on the strip.
//
// cost = weight(kind) × priority × hours waiting
//   weight: gate 3 (an agent is held mid-step), approval / plan review 2, block 1
//   priority: urgent 4, high 2, normal 1, low 0.5
// Ties: older first, then the lower task number.

export const decideMode = (cfg) => (cfg && cfg.mode === 'on' ? 'on' : 'off');

export const WEIGHT = { gate: 3, decision: 2, block: 1 };
export const PRIORITY = { urgent: 4, high: 2, normal: 1, low: 0.5 };
export const TITLE_MAX = 80;
export const QUESTION_MAX = 200;
export const QUESTION_FULL_MAX = 4000;

const HOUR = 3600e3;

/** What waiting on this item costs (pure). An unknown priority counts as normal. */
export function costOf(kind, priority, hours) {
  const w = WEIGHT[kind] ?? 1;
  const p = PRIORITY[priority] ?? 1;
  return w * p * Math.max(0, Number(hours) || 0);
}

/** Hours since an ISO time (pure); null when unreadable. */
export function hoursSince(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / HOUR) : null;
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The question a block asks (pure): what the block step itself wrote. The block op records a
 *  history entry { op: 'block', at, by } and writes its text as a comment by the same caller at the
 *  same time (the owner agent OR Mission Control, so never "the owner's newest comment"). A block
 *  step that wrote no text (a re-block) gives way to the
 *  newest earlier block step that did. A task with no history (filed before 1.2) falls back to its
 *  newest comment; history with no block text left (none written, or capped away) = no question.
 *  → { line, full } | null */
export function blockQuestion(task) {
  const cs = Array.isArray(task?.comments) ? task.comments : [];
  const hist = Array.isArray(task?.history) ? task.history : [];
  const steps = hist.filter((h) => h && h.op === 'block').reverse();
  let c = null;
  for (const b of steps) { c = cs.find((x) => x && x.text && x.at === b.at && x.who === b.by); if (c) break; }
  if (!c && !hist.length) c = [...cs].reverse().find((x) => x && x.text);
  if (!c) return null;
  const full = String(c.text).slice(0, QUESTION_FULL_MAX);
  return { line: cut(oneLine(full), QUESTION_MAX), full };
}

/** The workspace an agent works in, from the board's own mesh directory (pure).
 *  → { title, open: true } | { title: null, open: false } (closed, headless, unregistered, unknown) */
export function workspaceOf(agent, directory = []) {
  const a = (directory || []).find((d) => d && d.name === agent);
  if (!a || !a.workspaceId || a.status === 'closed' || a.workspaceOpen === false) return { title: null, open: false };
  return { title: a.title || a.name, open: true };
}

/** p90 of a list of numbers (pure; same rule as the operating reading). */
export function p90(xs) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(0.9 * s.length) - 1))];
}

/**
 * The page's rows (pure).
 *   view       = buildAttention(…) output (groups exclude snoozed items; `snoozedCount`)
 *   tasks      = full ledger tasks by id (Map or array), for priority, owner, comments, source
 *   directory  = the board's mesh directory (agents with name, title, workspaceId, status)
 *   outside    = (task) => true when the task has an outside source (chat, GitHub, channel discovery)
 *   waitP90H   = the operating reading's p90 wait on the owner, in hours (null = none yet)
 * → { mode: 'on', rows, count, oldestH, waitP90H, snoozedCount }
 */
export function decideRows(view, tasks, { now = Date.now(), directory = [], outside = () => false, waitP90H = null } = {}) {
  const byId = tasks instanceof Map ? tasks : new Map((tasks || []).map((t) => [t.id, t]));
  const rows = [];
  for (const g of view?.groups || []) {
    const t = byId.get(g.task) || {};
    const out = outside(t);
    const owner = t.owner || g.owner || null;
    for (const it of g.items || []) {
      const hours = hoursSince(it.since, now) ?? (Number(g.ageH) || 0);
      const row = {
        id: it.id, kind: it.kind, task: g.task, gate: it.gate || null,
        priority: t.priority || 'normal',
        hours: Math.round(hours * 10) / 10,
        cost: Math.round(costOf(it.kind, t.priority, hours) * 10) / 10,
        // an outside task shows its number and the intake only, as the wakes do
        title: out ? `#${g.task} · ${t.source?.via || (t.requester === 'github' ? 'github' : 'outside')} intake` : cut(oneLine(t.title ?? g.title ?? ''), TITLE_MAX),
        outside: out,
        owner,
        workspace: workspaceOf(owner, directory),
        ...(it.back ? { back: it.back } : {}),
      };
      if (it.kind === 'block' && !out) {
        const q = blockQuestion(t);
        if (q) { row.question = q.line; row.questionFull = q.full; }
      }
      rows.push(row);
    }
  }
  rows.sort((a, b) => b.cost - a.cost || b.hours - a.hours || a.task - b.task);
  const ages = rows.map((r) => r.hours);
  return {
    mode: 'on', rows, count: rows.length,
    oldestH: ages.length ? Math.max(...ages) : null,
    waitP90H: Number.isFinite(waitP90H) ? Math.round(waitP90H * 10) / 10 : null,
    snoozedCount: view?.snoozedCount || 0,
  };
}

/** The view as it rides on every page push (pure): the one-line question only. The full text of a
 *  question (up to QUESTION_FULL_MAX) is served by GET /api/decide when the owner unfolds a row. */
export function pushView(view) {
  if (!view) return view;
  return { ...view, rows: (view.rows || []).map(({ questionFull, ...r }) => ({ ...r, ...(questionFull && questionFull !== r.question ? { more: true } : {}) })) };
}

// ---- OPEN WORKSPACE (the owner's click only) -------------------------------------------

/**
 * Who may open a workspace (pure; condition H, as a snooze): the decision token and no agent or
 * intake identity on the request. → null | { status, msg }
 */
export function openRefusal({ decider, intake = false, body = {}, headers = {} }) {
  if (intake || body.actor || headers['x-mesh-intake'] || headers['x-mesh-agent'])
    return { status: 403, msg: 'a workspace is opened from the owner\'s board only (no agent or intake identity)' };
  if (!decider) return { status: 403, msg: 'decision token rejected: reload the board page and click again' };
  return null;
}

/** The workspace id for an agent name, from the board's own directory only (pure). */
export function workspaceIdFor(agent, directory = []) {
  const a = (directory || []).find((d) => d && d.name === String(agent || ''));
  if (!a || !a.workspaceId || a.status === 'closed') return null;
  return String(a.workspaceId);
}

const WIN_RE = /^\s*\*?\s*\d+:\s+([0-9A-Fa-f-]{36})\b/;
const listedIds = (out) => String(out || '').split('\n')
  .map((l) => l.match(/\b([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})\b/))
  .filter(Boolean).map((m) => m[1].toUpperCase());

/**
 * Bring an agent's workspace to the front: find the window that holds it, select it there, focus
 * that window. `run(args)` → { err, out } is the board's cmux runner. Changes only what is in front.
 * → { ok: true, workspaceId, windowId } | { ok: false, msg }
 */
export async function openWorkspace(agent, { directory = [], run }) {
  const id = workspaceIdFor(agent, directory);
  if (!id) return { ok: false, status: 404, msg: `no live workspace for ${String(agent || '').slice(0, 80) || 'that agent'}` };
  const w = await run(['list-windows']);
  if (w.err) return { ok: false, status: 502, msg: `cmux list-windows: ${w.err}` };
  const wins = String(w.out || '').split('\n').map((l) => l.match(WIN_RE)?.[1]).filter(Boolean);
  let win = null;
  for (const wid of wins) {
    const r = await run(['workspace', 'list', '--id-format', 'both', '--window', wid]);
    if (r.err) return { ok: false, status: 502, msg: `cmux workspace list: ${r.err}` };
    if (listedIds(r.out).includes(id.toUpperCase())) { win = wid; break; }
  }
  if (!win) return { ok: false, status: 404, msg: 'the workspace is not in any cmux window' };
  // the id is a UUID, unique across windows; `select` takes the handle alone (cmux 0.65.x help)
  const s = await run(['workspace', 'select', id]);
  if (s.err) return { ok: false, status: 502, msg: `cmux workspace select: ${s.err}` };
  const f = await run(['focus-window', '--window', win]);
  if (f.err) return { ok: false, status: 502, msg: `cmux focus-window: ${f.err}` };
  return { ok: true, workspaceId: id, windowId: win };
}
