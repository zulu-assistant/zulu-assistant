// Hash-chained receipts (1.3). Every change to a gate's decision fields appends one line to
// receipts.jsonl in the gate state folder:
//   { seq, at, task, gate, event, digest, prev }
// `digest` is a hash of the gate record's decision fields, `prev` the hash of the line before.
// The board keeps the head and an index of the chain IN MEMORY.
//
// What it is for:
//   - an edited receipt shows: `verify` recomputes the chain and compares it with gates[];
//   - a grant is honoured only when the chain holds an approval for that task and gate that the
//     running board itself recorded, not yet followed by a release (`approvalFor`). A grant and a
//     task record written by hand have no such line, and a line added to the file by hand is not in
//     the running board's memory.
// What it is not: proof against someone who rewrites the whole file, or appends a line whose hashes
// line up, and then restarts the board: the index is rebuilt from the file. The daily state backup
// carries the file, and a copy of the head off the machine would narrow that further.
//
// The chain learns of gate changes from the ledger (createLedger().subscribe): after every task
// write it compares each gate's digest with the last one it recorded. So any path that changes a
// gate through the ledger is covered, whichever op it used, and a change made around the ledger
// is exactly what `verify` reports.
//
// A failed append never fails the gate event: the index is updated first, the line is kept in
// memory and written with the next one, and the error is kept for the card (amber).
import { readFile, mkdir } from 'node:fs/promises';
import { writePrivate } from './private-file.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const GENESIS = '0'.repeat(64);
export const MODES = ['off', 'observe', 'on'];
/** SETTINGS.receiptChain → 'off' | 'observe' | 'on' (absent = on). */
export const chainMode = (v) => (MODES.includes(v) ? v : v && MODES.includes(v.mode) ? v.mode : 'on');

const sha = (s) => createHash('sha256').update(s).digest('hex');
// the decision fields: what was asked, who decided what and when, whether it ran. Counters and notes
// (attempts, re-runs, the restart note) change without a decision and are left out.
const FIELDS = ['id', 'cls', 'cmdHash', 'agent', 'requested_at', 'status', 'decision', 'decided_by', 'decided_at', 'via', 'recorded_by', 'expires_at', 'executed_at'];
export function gateDigest(taskId, g) {
  return sha(JSON.stringify([Number(taskId), ...FIELDS.map((k) => g?.[k] ?? null)]));
}
/** The event name for a gate whose digest changed (from its status; `was` = the status recorded before). */
export function eventOf(g, was) {
  // a gate seen for the first time is named by its STATUS: one that is first seen settled (an old run
  // found after an upgrade) is never named an approval
  if (was == null) return g.status === 'pending' ? 'requested' : g.status === 'approved' ? (g.via === 'standing' ? 'auto-approved' : 'approved') : g.status;
  if (g.status === 'approved') return g.via === 'standing' ? 'auto-approved' : 'approved';
  if (g.status === 'executed') return 'released';
  return g.status;                                   // declined, expired, disputed, or a status a later version adds
}
const key = (task, gate) => `${Number(task)}:${gate}`;
/** The line for a gate that reads approved after a write that was not a decision on it. Never an approval. */
export const OUTSIDE = 'changed-outside-decision';

/** Parse and check a chain file's text. → { lines, breaks: [{ seq, why }], head: { seq, hash } } */
export function readChain(text) {
  const lines = []; const breaks = [];
  let prev = GENESIS; let seq = 0;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    let l = null;
    try { l = JSON.parse(raw); } catch { breaks.push({ seq: seq + 1, why: 'a line is not JSON' }); prev = sha(raw); seq += 1; continue; }
    if (l.seq !== seq + 1) breaks.push({ seq: l.seq, why: `sequence jumps from ${seq} to ${l.seq}` });
    if (l.prev !== prev) breaks.push({ seq: l.seq, why: 'does not follow the line before it (edited, removed or inserted)' });
    lines.push(l); prev = sha(raw); seq = Number(l.seq) || seq + 1;
  }
  return { lines, breaks, head: { seq, hash: prev } };
}

export function createReceiptChain({ file, now = () => Date.now(), mode = 'on' } = {}) {
  const on = mode !== 'off';
  let head = { seq: 0, hash: GENESIS };
  let index = new Map();          // "task:gate" → { status, digest, approvedSeq, released, seq }
  let startedAt = null;           // time of the first line: gates older than the chain are not expected in it
  let loaded = null;
  let error = null;               // last failed append
  let unwritten = [];             // lines this board recorded that are not on disk yet (a failed append); retried with the next one
  let loadBreaks = [];
  let unreadable = null;          // the chain file exists and could not be read at start: no adoption, no new sequence
  let disputed = 0;
  let queue = Promise.resolve();
  const serial = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  function note(l) {
    if (l.event === 'started' || l.gate == null) return;            // the chain's own first line: no gate
    const k = key(l.task, l.gate);
    const e = index.get(k) || { approvedSeq: null, released: false };
    e.digest = l.digest; e.status = l.status ?? e.status; e.seq = l.seq;
    if (l.event === OUTSIDE) { e.flagged = true; e.approvedSeq = null; e.released = false; index.set(k, e); return; }
    // an approval counts only when the line's status says approved: the event name alone is not enough
    if ((l.event === 'approved' || l.event === 'auto-approved') && l.status === 'approved') { e.approvedSeq = l.seq; e.released = false; }
    else if (e.approvedSeq != null && l.event !== 'requested') e.released = true;   // released, expired, declined, disputed: the approval is spent
    index.set(k, e);
  }

  async function write(entry) {
    const l = { seq: head.seq + 1, at: new Date(now()).toISOString(), ...entry, prev: head.hash };
    const raw = JSON.stringify(l);
    head = { seq: l.seq, hash: sha(raw) };            // memory first: the running board's own record
    if (!startedAt) startedAt = l.at;
    note(l);
    unwritten.push(raw);
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writePrivate(file, unwritten.join('\n') + '\n', { append: true });   // owner-only, through the one private writer
      unwritten = []; error = null;
    } catch (e) { error = { at: l.at, seq: l.seq, message: e.message }; }
    return l;
  }

  /**
   * Read the file once.
   * - No file (and only that) is a first start. It always writes a `started` line first, so the chain
   *   has a start time before any gate line and every gate settled earlier is "before the chain". It
   *   then adopts the approvals that are still in flight: status approved AND not yet expired. An
   *   approval that ran out unused stays `approved` on the ledger; it is not adopted.
   * - Any other read error is NOT a first start: nothing is adopted, no sequence is begun, nothing is
   *   written, and no approval is vouched for until the board can read its chain again (card red).
   */
  function load(tasks = []) {
    if (!on) return Promise.resolve();
    loaded ??= serial(async () => {
      let text = null;
      try { text = await readFile(file, 'utf8'); }
      catch (e) {
        if (e.code !== 'ENOENT') { unreadable = `${e.code || 'error'}: ${e.message}`; return; }
      }
      if (text == null) {
        await write({ task: null, gate: null, event: 'started', status: null, digest: null });
        for (const t of tasks) for (const g of t.gates || []) {
          if (g.status !== 'approved') continue;
          if (!g.expires_at || Date.parse(g.expires_at) <= now()) continue;          // ran out before the chain began
          await write({ task: t.id, gate: g.id, event: g.via === 'standing' ? 'auto-approved' : 'approved', status: g.status, digest: gateDigest(t.id, g), note: 'adopted at chain start' });
        }
        return;
      }
      const r = readChain(text);
      head = r.head; loadBreaks = r.breaks; startedAt = r.lines[0]?.at || null;
      index = new Map();
      for (const l of r.lines) note(l);
    });
    return loaded;
  }

  /**
   * After a ledger write: one line per gate whose decision fields changed. Never throws.
   * `w` = which write it was ({ op, gate, decider, gateSystem }, from the ledger). An approval line
   * is written ONLY for a write that was a decision on that gate: the owner's decision (gate_decide
   * with the decider mark), a recorded pane answer the ledger accepted (gate_record), or the gate
   * service filing a gate that a program go approves (gate_request with the gate-system mark).
   * A gate that reads `approved` after any other write (a comment, another gate's request) was changed
   * outside a decision: it gets a line of its own kind, never counts as an approval, and is flagged.
   */
  function record(task, w = null) {
    if (!on || !task?.gates?.length) return Promise.resolve([]);
    return serial(async () => {
      const out = [];
      try {
        await loaded;
        if (unreadable) return out;                                 // never begin a second sequence beside a file this cannot read
        const decided = (g) => !!w && w.gate === g.id
          && ((w.op === 'gate_decide' && w.decider) || w.op === 'gate_record' || (w.op === 'gate_request' && w.gateSystem));
        for (const g of task.gates) {
          const d = gateDigest(task.id, g);
          const e = index.get(key(task.id, g.id));
          if (e?.digest === d) continue;
          const approval = g.status === 'approved';
          // A gate the chain has never seen, requested before the chain began, is "before the chain"
          // unless it is still waiting (it gets its `requested` line), or reads approved with a decision
          // time after the start (a decision just taken, or an edit made to look like one: decided() tells).
          if (!e && startedAt && g.requested_at && g.requested_at < startedAt && g.status !== 'pending'
            && !(approval && g.decided_at && g.decided_at >= startedAt)) continue;
          const event = approval && !decided(g) ? OUTSIDE : eventOf(g, e?.status);
          out.push(await write({ task: task.id, gate: g.id, event, status: g.status, digest: d }));
        }
      } catch (e) { error = { at: new Date(now()).toISOString(), message: e.message }; }
      return out;
    });
  }

  /** Is there an approval the running board recorded for this gate, not yet followed by a release? */
  function approvalFor(task, gate) {
    if (unreadable) return false;
    const e = index.get(key(task, gate));
    return !!e && e.approvedSeq != null && !e.released;
  }

  /**
   * Recompute the chain from the file and compare it with gates[].
   * → { ok, lines, head, problems: [{ task?, gate?, seq?, why }] }
   */
  async function verify(tasks = [], { only = null } = {}) {
    if (!on) return { ok: true, off: true, lines: 0, head: null, problems: [] };
    await loaded; await queue;
    if (unreadable) return { ok: false, unreadable, lines: 0, head: null, problems: [{ why: `cannot read the chain file (${unreadable}): no approval is vouched for until it can be read` }] };
    const problems = [];
    const text = await readFile(file, 'utf8').catch(() => null);
    const r = readChain(text ?? '');
    for (const b of r.breaks) problems.push({ seq: b.seq, why: b.why });
    // what the file should end with: this board's head, less the lines a failed append still holds
    const held = unwritten.map((raw) => JSON.parse(raw));
    const want = held.length ? { seq: held[0].seq - 1, hash: held[0].prev } : head;
    if (text == null && want.seq > 0) problems.push({ why: 'the chain file is missing' });
    else if (r.head.seq !== want.seq || r.head.hash !== want.hash) {
      problems.push({ seq: r.head.seq, why: r.head.seq < want.seq ? `the file ends at line ${r.head.seq}; this board recorded ${want.seq} (truncated)` : 'the file does not match what this board recorded (changed outside the board)' });
    }
    const last = new Map();
    for (const l of [...r.lines, ...held]) last.set(key(l.task, l.gate), l);
    const began = r.lines[0]?.at || startedAt;
    for (const t of tasks) {
      if (only != null && Number(t.id) !== Number(only)) continue;
      for (const g of t.gates || []) {
        const l = last.get(key(t.id, g.id));
        if (!l) {
          if (began && g.requested_at && g.requested_at < began) continue;          // older than the chain
          problems.push({ task: t.id, gate: g.id, why: `gate is ${g.status} on the task and has no line in the chain` });
        } else if (l.event === OUTSIDE && l.digest === gateDigest(t.id, g)) {
          problems.push({ task: t.id, gate: g.id, seq: l.seq, why: `the task's record reads ${g.status} without a decision by this board (it was changed outside the board)` });
        } else if (l.digest !== gateDigest(t.id, g)) {
          problems.push({ task: t.id, gate: g.id, seq: l.seq, why: `the task's record (${g.status}) differs from the chain's last line for it (${l.event})` });
        }
      }
    }
    return { ok: problems.length === 0, lines: r.lines.length, unwritten: held.length, head: { seq: r.head.seq, hash: r.head.hash }, problems };
  }

  return {
    mode, file, load, record, approvalFor, verify,
    head: () => ({ ...head }),
    noteDispute() { disputed += 1; },
    /** Gates whose record was changed to approved outside a decision: [{ task, gate }] (the card shows them red). */
    flagged: () => [...index.entries()].filter(([, e]) => e.flagged).map(([k]) => ({ task: Number(k.split(':')[0]), gate: k.split(':')[1] })),
    /** For the card: { mode, lines, error (a failed append), unwritten, breaks (found at load), disputed (since start) }. */
    status: () => ({ mode, lines: head.seq, error, unwritten: unwritten.length, breaks: loadBreaks.length, disputed, unreadable }),
  };
}
