// Attention ring (Zulu 1.2, SETTINGS.attention): the WAITING ON YOU strip grouped by task, and
// owner snoozes. An item is one thing waiting on the owner:
//   gate:<task>:<gK>   a pending gate          decision:<task>  an approval request (POLICY.md item)
//   block:<task>       a task blocked on the owner
// A snooze hides an item from the strip and the "(N)" title count until it runs out; then the
// item comes back with a "back" marker. A snooze never decides anything and never delays an agent:
// the gate stays pending, its grant and expiry are the gate service's, and a re-asked gate is a
// new gK (never snoozed). State: data/attention-state.json (board is the only writer).
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

export const SNOOZE_CHOICES = {
  '15m': { label: '15m', ms: 15 * 60e3 },
  '1h': { label: '1h', ms: 60 * 60e3 },
  '4h': { label: '4h', ms: 4 * 60 * 60e3 },
  tomorrow: { label: 'tomorrow 08:00', ms: null },
};
export const BACK_MS = 2 * 60 * 60e3;          // the "back" marker shows for 2h after a snooze runs out

export const snoozeMode = (cfg) => (cfg && cfg.snooze === 'on' ? 'on' : 'off');

/** When a snooze chosen at `now` runs out (ms epoch). "tomorrow" = 08:00 local on the next day,
 *  except in the small hours (before 05:00), when "tomorrow morning" means today's 08:00. */
export function untilFor(choice, now = Date.now()) {
  const c = SNOOZE_CHOICES[choice];
  if (!c) return null;
  if (c.ms) return now + c.ms;
  const d = new Date(now);
  if (d.getHours() >= 5) d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d.getTime();
}

const blockedOnOwner = (t, isOwner) => (t.blocked_on || []).some((x) => typeof x === 'string' && isOwner(x));

/** Every item waiting on the owner, from summary briefs (needsApproval + blocked lists). */
export function attentionItems(tasks, { isOwner = (x) => x === 'owner' } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of tasks || []) {
    if (!t || seen.has(t.id)) continue;
    seen.add(t.id);
    const since = t.updated_at || null;
    for (const g of t.gates || []) {
      if (g.status && g.status !== 'pending') continue;
      out.push({ id: `gate:${t.id}:${g.id}`, kind: 'gate', task: t.id, gate: g.id, label: g.label || g.cls || 'gate', since: g.requested_at || since, ...(g.context?.length ? { context: g.context } : {}) });
    }
    if (t.status === 'needs_approval' && t.approval && !t.approval.decision) {
      out.push({ id: `decision:${t.id}`, kind: 'decision', task: t.id, label: t.approval.policy_item || 'approval', since: t.approval.requested_at || since });
    }
    if (t.status === 'blocked' && blockedOnOwner(t, isOwner)) {
      out.push({ id: `block:${t.id}`, kind: 'block', task: t.id, label: 'blocked on you', since });
    }
  }
  return out;
}

export const emptyState = () => ({ snoozes: {}, back: {} });

/**
 * Expire and prune (pure). A snooze whose time ran out moves to `back` (stamped with when it ran
 * out); a snooze or back marker for an item that is no longer waiting is dropped (decided, gate
 * gone, task closed); back markers older than BACK_MS are dropped.
 * → { state, changed, expired: [item ids that just came back] }
 */
export function settle(state, items, now = Date.now()) {
  const s = { snoozes: { ...(state?.snoozes || {}) }, back: { ...(state?.back || {}) } };
  const live = new Set(items.map((i) => i.id));
  const expired = [];
  let changed = false;
  for (const [id, z] of Object.entries(s.snoozes)) {
    if (!live.has(id)) { delete s.snoozes[id]; changed = true; continue; }
    if (z.until <= now) {
      delete s.snoozes[id];
      s.back[id] = { at: z.until };
      expired.push(id);
      changed = true;
    }
  }
  for (const [id, b] of Object.entries(s.back)) {
    if (!live.has(id) || now - b.at > BACK_MS || s.snoozes[id]) { delete s.back[id]; changed = true; }
  }
  return { state: s, changed, expired };
}

/**
 * The strip's view (pure): tasks in, groups out. One group per task with its waiting items
 * (oldest task first, as today); snoozed items leave the groups and the count and are listed in
 * `snoozed` instead. Mode 'off' ignores the state (nothing is ever snoozed).
 * → { mode, groups: [{ task, title, owner, status, items }], snoozed: [item + until/by/choice], count, snoozedCount }
 */
export function buildAttention(tasks, state, { now = Date.now(), mode = 'on', isOwner } = {}) {
  const items = attentionItems(tasks, { isOwner });
  const { state: s } = settle(mode === 'on' ? state : emptyState(), items, now);
  const byTask = new Map((tasks || []).map((t) => [t.id, t]));
  const groups = new Map();
  const snoozed = [];
  for (const it of items) {
    const z = s.snoozes[it.id];
    if (z) { snoozed.push({ ...it, title: byTask.get(it.task)?.title || '', until: z.until, by: z.by, choice: z.choice }); continue; }
    const item = s.back[it.id] ? { ...it, back: s.back[it.id].at } : it;
    if (!groups.has(it.task)) {
      const t = byTask.get(it.task);
      groups.set(it.task, { task: it.task, title: t.title, owner: t.owner || null, status: t.status, ageH: t.ageH ?? 0, items: [] });
    }
    groups.get(it.task).items.push(item);
  }
  const list = [...groups.values()].sort((a, b) => b.ageH - a.ageH || a.task - b.task);
  snoozed.sort((a, b) => a.until - b.until);
  return { mode, groups: list, snoozed, count: list.reduce((k, g) => k + g.items.length, 0), snoozedCount: snoozed.length };
}

/** Snoozed item ids per task (for the cmux pill: "+n snoozed"). */
export function snoozedByTask(view) {
  const m = new Map();
  for (const it of view?.snoozed || []) {
    if (!m.has(it.task)) m.set(it.task, new Set());
    m.get(it.task).add(it.id);
  }
  return m;
}

/**
 * Who may snooze (pure; the same rule as gate_decide, condition H): the board page's decision
 * token, and no agent or intake identity on the request, token or not. → null | { status, msg }
 */
export function snoozeRefusal({ decider, intake = false, body = {}, headers = {} }) {
  if (intake || body.actor || headers['x-mesh-intake'] || headers['x-mesh-agent'])
    return { status: 403, msg: 'snoozes are set from the owner\'s board only (no agent or intake identity)' };
  if (!decider) return { status: 403, msg: 'decision token rejected: reload the board page and click again' };
  return null;
}

/** Apply a snooze/unsnooze to the state (pure). items = the live attention items. */
export function applySnooze(state, { op, items: ids, choice }, liveItems, { now = Date.now(), by = 'owner' } = {}) {
  const want = [...new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String))];
  if (!want.length) return { error: { status: 400, msg: 'items: one or more item ids (gate:<task>:<gK> | decision:<task> | block:<task>)' } };
  const s = { snoozes: { ...(state?.snoozes || {}) }, back: { ...(state?.back || {}) } };
  if (op === 'unsnooze') {
    for (const id of want) delete s.snoozes[id];
    return { state: s, items: want };
  }
  const until = untilFor(choice, now);
  if (!until) return { error: { status: 400, msg: `for: one of ${Object.keys(SNOOZE_CHOICES).join(' | ')}` } };
  const live = new Set(liveItems.map((i) => i.id));
  const missing = want.filter((id) => !live.has(id));
  if (missing.length) return { error: { status: 404, msg: `not waiting on the owner: ${missing.join(', ')}` } };
  for (const id of want) { s.snoozes[id] = { until, by, at: now, choice }; delete s.back[id]; }
  return { state: s, items: want, until };
}

// ---- store -------------------------------------------------------------------------

export async function readAttentionState(file) {
  try {
    const d = JSON.parse(await readFile(file, 'utf8'));
    return { snoozes: d.snoozes || {}, back: d.back || {} };
  } catch { return emptyState(); }
}

export async function writeAttentionState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, file);
}

/** One-line description of an item for ticker lines. */
export const itemText = (it) => (it.kind === 'gate' ? `#${it.task} ${it.gate}` : `#${it.task} ${it.kind}`);
