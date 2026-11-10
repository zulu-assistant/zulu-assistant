// Weekly operating reading: how the agent workforce ran, read from the ledger alone.
//
// SETTINGS.operatingReading = { mode: 'off'|'observe'|'on', task?, owner, weekday: 1 (Mon), hour: 8 }.
// Once per week, at the first poll after the slot (catch-up after downtime, like
// src/ci-cost-watch.mjs), the board computes the reading for the 7 days before the slot and
// the 7 before those:
//   - tasks closed (by owner, by requester; chat-filed requests marked "via slack"), cancelled
//   - reopens of done tasks and the reopen rate (from each task's history[], recorded since 1.2)
//   - blocked-on-the-owner waits: median hours from block to unblock, and how many wait now
//   - gates by outcome (approved / auto-approved under a program go / declined / expired unused /
//     dry run first / pending), the declined-or-expired share as the false-positive proxy, and
//     approval-to-action time (requested → decided → released, median + p90)
//   - closes with a completion packet (evidence) vs without
//   - worktrees created / removed / cleanup refused / left on disk at close (their comments)
// observe = one ticker line + the card; on = the reading is also posted as a `board` comment on ONE
// ledger task (cfg.task, else created once: requester board, owner cfg.owner). The card
// `ops:reading` is info only: always ok, never on the alert ladder.
// Reads only the tasks it is handed (data/tasks/*.json); writes its state file and, when on, the ledger.
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lastWeeklySlot } from './ci-cost-watch.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = path.join(ROOT, 'data/operating-reading-state.json');
const RETRY_MS = 3600e3;
const DAY = 864e5;
const MAX_TEXT = 2000;           // a ledger comment's limit
const TOP = 6;

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const inWin = (t, w) => Number.isFinite(t) && t >= w.from && t < w.to;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

/** Nearest-rank percentile of a list of numbers (pure); null when empty. */
export function percentile(xs, p) {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

/** A duration in ms as 45s / 12m / 3.4h / 2.1d (pure). */
export function fmtDur(x) {
  if (x == null) return '—';
  if (x < 60e3) return `${Math.round(x / 1e3)}s`;
  if (x < 3600e3) return `${Math.round(x / 60e3)}m`;
  if (x < 48 * 3600e3) return `${(x / 3600e3).toFixed(1)}h`;
  return `${(x / DAY).toFixed(1)}d`;
}

const stats = (xs) => ({ n: xs.length, median: percentile(xs, 50), p90: percentile(xs, 90) });
const countBy = (xs) => xs.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());

/** Waits on `owner` that ended inside the window, from a task's history (pure): [ms]. */
export function ownerWaits(task, owner, w) {
  const out = [];
  let since = null;
  for (const h of task.history || []) {
    const on = (h.blocked_on || []).includes(owner);
    const at = ms(h.at);
    if (on && since == null) since = at;
    else if (!on && since != null) { if (inWin(at, w)) out.push(at - since); since = null; }
  }
  return out;
}

/** Gate outcome bucket (pure). */
export function gateOutcome(g) {
  if (g.via === 'standing') return 'auto';
  if (g.status === 'executed' || g.status === 'approved') return 'approved';
  if (g.status === 'declined') return 'declined';
  if (g.status === 'expired') return 'expired';
  if (g.status === 'dry_required') return 'dry';
  return 'pending';
}

/** All metrics for one window [from, to) (pure). `owner` = the owner's id. */
export function windowMetrics(tasks, w, { owner = 'owner' } = {}) {
  const closed = tasks.filter((t) => t.status === 'done' && inWin(ms(t.closed_at), w));
  const cancelled = tasks.filter((t) => t.status === 'cancelled' && inWin(ms(t.closed_at), w));
  const reopens = [];
  const waits = [];
  for (const t of tasks) {
    for (const h of t.history || []) if (h.op === 'reopen' && h.from === 'done' && inWin(ms(h.at), w)) reopens.push(t.id);
    waits.push(...ownerWaits(t, owner, w));
  }
  const gates = tasks.flatMap((t) => (t.gates || []).filter((g) => inWin(ms(g.requested_at), w)));
  const outcomes = countBy(gates.map(gateOutcome));
  const human = gates.filter((g) => g.via === 'board' || g.via === 'pane');
  const decide = human.filter((g) => g.decided_at).map((g) => ms(g.decided_at) - ms(g.requested_at));
  const released = gates.filter((g) => g.executed_at);
  const act = released.filter((g) => g.decided_at).map((g) => ms(g.executed_at) - ms(g.decided_at));
  const total = released.map((g) => ms(g.executed_at) - ms(g.requested_at));
  const fp = (outcomes.get('declined') || 0) + (outcomes.get('expired') || 0);
  const judged = fp + (outcomes.get('approved') || 0);
  const wt = { created: 0, removed: 0, refused: 0, left: 0 };
  for (const t of tasks) {
    for (const c of t.comments || []) {
      if (!inWin(ms(c.at), w)) continue;
      const s = String(c.text || '');
      if (/^worktree created: /.test(s)) wt.created++;
      else if (/^worktree removed: /.test(s)) wt.removed++;
      else if (/^worktree cleanup refused: /.test(s)) wt.refused++;
      else if (/^⚠ worktree left: /.test(s)) wt.left++;
    }
  }
  const requester = (t) => (t.source?.via === 'slack' ? `${t.requester} via slack` : t.requester);
  return {
    from: w.from, to: w.to,
    closed: closed.length, cancelled: cancelled.length,
    byOwner: [...countBy(closed.map((t) => t.owner || '(unowned)'))].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    byRequester: [...countBy(closed.map(requester))].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    reopened: reopens.length, reopenedTasks: [...new Set(reopens)],
    withHistory: closed.filter((t) => t.history?.length).length,
    ownerWaits: stats(waits),
    waitingNow: w.current ? tasks.filter((t) => !['done', 'cancelled'].includes(t.status) && (t.blocked_on || []).includes(owner)).length : null,
    gates: {
      requested: gates.length,
      approved: outcomes.get('approved') || 0, auto: outcomes.get('auto') || 0, declined: outcomes.get('declined') || 0,
      expired: outcomes.get('expired') || 0, dry: outcomes.get('dry') || 0, pending: outcomes.get('pending') || 0,
      falsePositive: fp, judged,
      decide: stats(decide), act: stats(act), total: stats(total),
    },
    packets: { with: closed.filter((t) => t.evidence).length, without: closed.filter((t) => !t.evidence).length },
    worktrees: wt,
  };
}

/** The reading for the week ending at `end` and the week before it (pure). */
export function computeReading(tasks, { end = Date.now(), days = 7, owner = 'owner' } = {}) {
  const len = days * DAY;
  return {
    end, days,
    cur: windowMetrics(tasks, { from: end - len, to: end, current: true }, { owner }),
    prev: windowMetrics(tasks, { from: end - 2 * len, to: end - len }, { owner }),
  };
}

const top = (pairs) => (pairs.length
  ? pairs.slice(0, TOP).map(([k, n]) => `${k} ${n}`).join(', ') + (pairs.length > TOP ? ` (+${pairs.length - TOP} more)` : '')
  : 'none');
const day = (x) => new Date(x).toISOString().slice(0, 10);

/** One line for the ticker and the card (pure). */
export function readingLine(r) {
  const c = r.cur; const g = c.gates;
  return `operating reading ${day(c.from)} → ${day(c.to)}: closed ${c.closed} (prev ${r.prev.closed})`
    + ` · reopened ${c.reopened} (${pct(c.reopened, c.closed)})`
    + ` · owner waits median ${fmtDur(c.ownerWaits.median)}${c.waitingNow ? `, ${c.waitingNow} waiting now` : ''}`
    + ` · gates ${g.requested}, false-positive proxy ${pct(g.falsePositive, g.judged)}`
    + ` · approval→action median ${fmtDur(g.total.median)}`;
}

/** The full reading as ledger-comment text, ≤ 2000 chars (pure). */
export function readingText(r) {
  const c = r.cur; const p = r.prev; const g = c.gates; const pg = p.gates;
  const tm = (s) => `median ${fmtDur(s.median)}, p90 ${fmtDur(s.p90)} (n ${s.n})`;
  const lines = [
    `OPERATING READING ${day(c.from)} → ${day(c.to)} (prev = the ${r.days} days before)`,
    `Closed ${c.closed} (prev ${p.closed}) · cancelled ${c.cancelled} (prev ${p.cancelled})`,
    `  by owner: ${top(c.byOwner)}`,
    `  by requester: ${top(c.byRequester)}`,
    `Reopened ${c.reopened} of ${c.closed} closes = ${pct(c.reopened, c.closed)} (prev ${p.reopened} = ${pct(p.reopened, p.closed)})`
      + (c.reopenedTasks.length ? ` — #${c.reopenedTasks.join(', #')}` : ''),
    `Blocked on the owner: ${plural(c.ownerWaits.n, 'wait')} ended, median ${fmtDur(c.ownerWaits.median)}, p90 ${fmtDur(c.ownerWaits.p90)}`
      + ` (prev median ${fmtDur(p.ownerWaits.median)}, n ${p.ownerWaits.n})${c.waitingNow != null ? ` · ${c.waitingNow} waiting now` : ''}`,
    `Gates: ${g.requested} requested (prev ${pg.requested}) — approved ${g.approved}, auto (program go) ${g.auto}, declined ${g.declined},`
      + ` expired unused ${g.expired}, dry run first ${g.dry}, pending ${g.pending}`,
    `  false-positive proxy (declined + expired unused of judged): ${g.falsePositive}/${g.judged} = ${pct(g.falsePositive, g.judged)}`
      + ` (prev ${pg.falsePositive}/${pg.judged} = ${pct(pg.falsePositive, pg.judged)})`,
    `  requested → decided: ${tm(g.decide)}`,
    `  decided → released: ${tm(g.act)}`,
    `  requested → released: ${tm(g.total)} (prev median ${fmtDur(pg.total.median)})`,
    `Completion packets: ${c.packets.with} of ${c.closed} closes (prev ${p.packets.with} of ${p.closed})`,
    `Worktrees: created ${c.worktrees.created}, removed ${c.worktrees.removed}, cleanup refused ${c.worktrees.refused}, left at close ${c.worktrees.left}`
      + ` (prev created ${p.worktrees.created}, removed ${p.worktrees.removed})`,
    `Status history (since 1.2) on ${c.withHistory} of ${c.closed} closed tasks: reopens and owner waits count only those.`,
  ];
  const text = lines.join('\n');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Every task in a ledger directory, read-only (never through createLedger, which may backfill). */
export async function readTasksDir(dir) {
  const out = [];
  for (const f of await readdir(dir).catch(() => [])) {
    if (!/^\d+\.json$/.test(f)) continue;
    try { out.push(JSON.parse(await readFile(path.join(dir, f), 'utf8'))); } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => a.id - b.id);
}

export const modeOf = (cfg) => (['observe', 'on'].includes(cfg?.mode) ? cfg.mode : 'off');

/** Should a run start now? (pure) */
export function due({ now, cfg, state }) {
  if (modeOf(cfg) === 'off') return false;
  const slot = lastWeeklySlot(now, cfg.weekday ?? 1, cfg.hour ?? 8);
  if ((state.lastRun || 0) >= slot) return false;
  return now.getTime() - (state.lastAttempt || 0) >= RETRY_MS;
}

export function readStateSync(file = STATE_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }

/** The board card (pure): info only, always ok. null when off. */
export function readingCard(state, cfg) {
  const mode = modeOf(cfg);
  if (mode === 'off') return null;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const base = { label: 'ops:reading', name: 'Operating reading (weekly)', domain: 'infra', logAvailable: false, status: 'ok',
    schedule: `weekly ${days[cfg.weekday ?? 1]} ${String(cfg.hour ?? 8).padStart(2, '0')}:00${mode === 'observe' ? ' · observe (ticker only)' : ''}` };
  if (!state?.line) return { ...base, detail: state?.lastError ? `no reading yet — ${state.lastError}` : 'no reading yet' };
  const where = mode === 'on' && state.task ? ` · posted on #${state.task}` : '';
  return { ...base, detail: `${state.line}${where}${state.lastError ? ` · last attempt failed: ${state.lastError}` : ''}` };
}

const TASK_TITLE = 'Weekly operating reading (closes, reopens, owner waits, gates)';

let busy = false;
/** Poll hook. `ledger` = createLedger(); `afterCreate(task)` wakes the reading task's owner. */
export async function maybeOperatingReading({ cfg, ledger, owner = 'owner', now = new Date(), file = STATE_FILE,
  record = async () => {}, afterCreate = async () => {} } = {}) {
  if (busy || modeOf(cfg) === 'off') return;
  const state = readStateSync(file);
  if (!due({ now, cfg, state })) return;
  busy = true;
  try {
    const next = { ...state, lastAttempt: now.getTime() };
    try {
      const end = lastWeeklySlot(now, cfg.weekday ?? 1, cfg.hour ?? 8);
      const r = computeReading(await ledger.list(), { end, owner });
      const line = readingLine(r);
      if (modeOf(cfg) === 'on') {
        let id = cfg.task || state.task || null;
        if (!id || !(await ledger.get(id))) {
          const t = await ledger.create({ title: TASK_TITLE, requester: 'board', owner: cfg.owner || 'mission-control', priority: 'low',
            source: { via: 'operating-reading', key: 'operating-reading' },
            body: 'One comment per week from the board: the operating reading (src/operating-reading.mjs). Info only — nothing here needs an answer.' }, now.getTime());
          id = t.id;
          if (!t.existing) await afterCreate(t);
        }
        await ledger.update(id, { op: 'comment', actor: 'board', text: readingText(r) }, { now: now.getTime() });
        next.task = id;
      }
      Object.assign(next, { lastRun: now.getTime(), line, end });
      delete next.lastError;
      await record('sys', `${line}${modeOf(cfg) === 'on' ? ` → #${next.task}` : ' (observe)'}`.slice(0, 300));
    } catch (e) {
      next.lastError = String(e.message).slice(0, 120);
      await record('sys', `operating reading failed — ${next.lastError} (retry in 1h)`);
    }
    await writeFile(`${file}.tmp`, JSON.stringify(next, null, 1));
    await rename(`${file}.tmp`, file);
  } finally { busy = false; }
}
