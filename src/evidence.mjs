// Evidence panel (Zulu 1.2): a read-only view of what each task's close rests on —
// the completion packet (t.evidence, src/completion-packet.mjs) and the gate
// receipts (t.gates[]). Pure: the server hands in the ledger's tasks; nothing here
// reads files or writes anything. Every text field shown passes the ledger's
// secret-text refusal, so a command with a secret-looking token is never rendered.
import { containsSecret, LIVE_STATUSES } from './tasks.mjs';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const CLOSED_DAYS = 14;
export const WITHHELD = '[withheld: looks like a secret]';

const LIVE = new Set(LIVE_STATUSES);
const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** A text field as the panel may show it: cut, and withheld whole when it looks like a credential. */
export function safeText(s, n = 300) {
  if (s == null || s === '') return s ?? null;
  return containsSecret(s) ? WITHHELD : cut(s, n);
}

/** SETTINGS.evidencePanel → 'off' | 'on'. */
export const evidenceMode = (cfg) => (cfg?.mode === 'on' ? 'on' : 'off');

/** The packet with every rendered string passed through safeText. */
function cleanPacket(p) {
  if (!p) return null;
  return {
    at: p.at || null,
    requested: safeText(p.requested, 600),
    pr: p.pr ? (p.pr.unavailable ? { url: safeText(p.pr.url, 200), unavailable: safeText(p.pr.unavailable, 80) }
      : { url: safeText(p.pr.url, 200), number: p.pr.number ?? null, state: p.pr.state || null, head: p.pr.head || null, merge: p.pr.merge || null }) : null,
    tests: (p.tests || []).map((s) => ({
      command: safeText(s.command, 300), exit: s.exit, rev: s.rev || null, branch: safeText(s.branch, 120),
      dirty: s.dirty === true, at: s.at || null, ms: s.ms ?? null, stale: s.stale || null,
    })),
    unrun: (p.unrun || []).map((u) => safeText(u, 160)),
    gates: (p.gates || []).map((g) => ({ id: g.id, cls: g.cls || null, status: g.status })),
    summary: p.summary ? { text: safeText(p.summary.text, 400), generated: p.summary.generated !== false } : null,
    stale: p.stale || null,
    trimmed: p.trimmed === true,
  };
}

/** One gate receipt: who decided what, when, and whether it ran. Command text is never part of it. */
export function receipt(g) {
  const auto = g.via === 'standing';
  return {
    id: g.id, cls: g.cls || null, label: safeText(g.label, 160), status: g.status || null,
    requested_at: g.requested_at || null, decided_at: g.decided_at || null, executed_at: g.executed_at || null,
    decision: g.decision || null, decided_by: auto ? null : g.decided_by || null,
    via: g.via || null, auto: auto ? { go: g.go || null } : null,
    reason: safeText(g.reason, 200),
  };
}

/** True for a task the panel lists: live, or closed within the window. */
function inWindow(t, now, days) {
  if (LIVE.has(t.status)) return true;
  const closed = Date.parse(t.closed_at || t.updated_at || '');
  return Number.isFinite(closed) && now - closed <= days * 86400e3;
}

const stamp = (t) => Date.parse(t.closed_at || t.updated_at || t.created_at || '') || 0;

/** The row for one task. missing = a done task closed without a packet. */
export function evidenceRow(t) {
  const live = LIVE.has(t.status);
  return {
    id: t.id, title: safeText(t.title, 160), status: t.status, owner: t.owner || null, live,
    updated_at: t.updated_at || null, closed_at: t.closed_at || null,
    pr: safeText(t.links?.pr, 200),
    packet: cleanPacket(t.evidence),
    gates: (t.gates || []).map(receipt),
    missing: t.status === 'done' && !t.evidence,
  };
}

const haystack = (r) => [r.id, `#${r.id}`, r.title, r.owner, r.status, r.packet?.requested, r.packet?.summary?.text,
  ...r.gates.flatMap((g) => [g.id, g.cls, g.label, g.decided_by])].filter(Boolean).join(' ').toLowerCase();

/**
 * The panel's rows (pure): live tasks first, then tasks closed in the last `days`, newest first
 * in each group. task = one id (ignores the window); q = a case-insensitive substring filter.
 */
export function evidenceRows(tasks, { limit = DEFAULT_LIMIT, task = null, q = '', now = Date.now(), days = CLOSED_DAYS } = {}) {
  const n = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(limit, 10) || DEFAULT_LIMIT));
  const id = task == null || task === '' ? null : Number(String(task).replace(/^#/, ''));
  const picked = id != null ? tasks.filter((t) => t.id === id) : tasks.filter((t) => inWindow(t, now, days));
  const rows = picked
    .sort((a, b) => (LIVE.has(b.status) - LIVE.has(a.status)) || (stamp(b) - stamp(a)) || (b.id - a.id))
    .map(evidenceRow);
  const needle = String(q || '').trim().toLowerCase();
  const kept = needle ? rows.filter((r) => haystack(r).includes(needle)) : rows;
  return { rows: kept.slice(0, n), total: kept.length, limit: n };
}
