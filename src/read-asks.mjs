// Asks nobody sees (#787 part 3): an agent asks Mission Control (or the owner) for a read or a go in
// a task COMMENT and sends no message, so nobody is woken and the read waits for hours (753, 748).
// Each poll the board reads the newest comment of every live task. It is an ask when the task's
// owner agent wrote it and it matches ASK_PATTERNS. It counts as seen when, after the comment, that
// agent sent Mission Control a mesh message on the task (delivered or queued; the board records it,
// `noteSent`), or anyone else commented (the ask is then no longer the newest comment), or the task
// changed status. Not seen after ASK_WAIT_MS = ONE wake to Mission Control, once per comment. The
// words of the comment are never copied: the wake names the task, the agent and the age only.
// State: data/read-asks-state.json { told: { "<task>@<comment time>": iso }, sent: { "<task>|<agent>": iso } }.
import { readFile } from 'node:fs/promises';

export const ASK_WAIT_MS = 10 * 60e3;
export const readAsksMode = (cfg) => (cfg && cfg.mode === 'on' ? 'on' : 'off');

// Fixed patterns, from the comments that waited (753, 748): "PLAN for MC", "HEAD for MC to read",
// "HEAD for your read, NOT pushed", plus the plan's list. A pattern names the reader or the go.
export const ASK_PATTERNS = [
  /\bfor (?:your|MC'?s?|Mission Control'?s?) (?:read|review|go)\b/i,
  /\bfor (?:MC|Mission Control)\b(?: to (?:read|review|look))?/i,
  /\bwaiting (?:for|on) (?:your|MC'?s?|Mission Control'?s?) (?:read|review|go|word)\b/i,
  /\bawaiting (?:MC|Mission Control|your (?:read|review|go|word))\b/i,
  /\bneeds? (?:your|MC'?s?|Mission Control'?s?|a) go\b/i,
  /\bhead\b[^\n]{0,160}\bnot pushed\b/i,
];

/** Is this text a request for a read or a go? (pure) */
export const asksForRead = (text) => ASK_PATTERNS.some((rx) => rx.test(String(text || '')));

const LIVE = new Set(['open', 'claimed', 'in_progress', 'blocked', 'needs_approval']);
const ms = (iso) => Date.parse(iso);

/**
 * The asks to wake Mission Control about now (pure).
 *   tasks    = full ledger tasks
 *   state    = { told, sent }
 *   notAgent = (name) => true for Mission Control's names, the owner, people, 'board'
 * → { wake: [{ key, task, agent, ageMin }], seenOrWaiting: n }
 */
export function findAsks(tasks, state, { now = Date.now(), notAgent = () => false, waitMs = ASK_WAIT_MS } = {}) {
  const told = state?.told || {};
  const sent = state?.sent || {};
  const wake = [];
  for (const t of tasks || []) {
    if (!t || !LIVE.has(t.status) || !t.owner || notAgent(t.owner)) continue;
    const cs = Array.isArray(t.comments) ? t.comments : [];
    const c = cs[cs.length - 1];
    if (!c || c.who !== t.owner || !asksForRead(c.text)) continue;
    const at = ms(c.at);
    if (!Number.isFinite(at)) continue;
    const key = `${t.id}@${c.at}`;
    if (told[key]) continue;
    // seen: the agent messaged Mission Control on this task after the comment
    const s = ms(sent[`${t.id}|${t.owner}`]);
    if (Number.isFinite(s) && s >= at) continue;
    // seen: the task changed status after the comment (someone acted on it)
    if ((t.history || []).some((h) => ms(h.at) > at && h.from !== h.status)) continue;
    if (now - at < waitMs) continue;
    wake.push({ key, task: t.id, agent: t.owner, ageMin: Math.floor((now - at) / 60e3) });
  }
  return { wake };
}

/** The wake's words (pure; the board's own; no comment text, so an outside task stays id-only). */
export const askText = (w) => `#${w.task}: ${w.agent} asked for a read in a comment ${w.ageMin} min ago and sent no message`;

/** Record a message an agent sent Mission Control on a task (pure; returns the new state). */
export function noteSent(state, { task, from, at }) {
  if (!task || !from) return state;
  return { ...state, sent: { ...(state?.sent || {}), [`${task}|${from}`]: at } };
}

/** Mark asks told, and drop entries of tasks that are no longer live (pure). */
export function settleState(state, { told = [], liveIds = new Set(), at }) {
  const keep = (k) => liveIds.has(Number(String(k).split(/[@|]/)[0]));
  const next = { told: {}, sent: {} };
  for (const [k, v] of Object.entries(state?.told || {})) if (keep(k)) next.told[k] = v;
  for (const [k, v] of Object.entries(state?.sent || {})) if (keep(k)) next.sent[k] = v;
  for (const k of told) next.told[k] = at;
  return next;
}

export async function readAsksState(file) {
  try {
    const d = JSON.parse(await readFile(file, 'utf8'));
    return { told: d.told || {}, sent: d.sent || {}, seeded: true };
  } catch { return { told: {}, sent: {}, seeded: false }; }
}
