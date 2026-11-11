// Guardrails: the gate records on a ledger task (pure) — gates[], decisions, the
// close check — plus the small stores the gate service keeps under data/guardrails/
// (grants, dry runs, watched scripts, focus, observe log). docs/GUARDRAILS.md.
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { writePrivate, makePrivate } from './private-file.mjs';
import { randomBytes } from 'node:crypto';
import { cleanContext, MAX_WORDS } from './row-context.mjs';
import path from 'node:path';

export class GateError extends Error {
  constructor(status, message) { super(message); this.status = status; this.extra = {}; }
}
const MAX_CMD = 1500;                 // a dry run's recorded command
const MAX_FULL = 20000;               // what gates[] keeps and the panel row shows (the full approved text; longer inputs are cut and say so)
const STATUSES = ['pending', 'approved', 'declined', 'expired', 'executed', 'dry_required', 'needs_focus', 'disputed'];

// ── on the task (pure) ──────────────────────────────────────────────────────
/** Append a gate record. `g.command` must already be redacted (gate-service does it). */
export function addGate(t, g, iso) {
  if (!g || typeof g !== 'object') throw new GateError(400, 'gate_request needs a gate');
  t.gates ??= [];
  const status = g.status || 'pending';
  if (!STATUSES.includes(status)) throw new GateError(400, `bad gate status ${status}`);
  const gate = {
    id: `g${t.gates.length + 1}`,
    cls: String(g.cls || 'opaque'), label: String(g.label || '').slice(0, 160), why: String(g.why || '').slice(0, 300),
    command: String(g.command || '').length > MAX_FULL ? `${String(g.command).slice(0, MAX_FULL)}\n… [cut at ${MAX_FULL} chars]` : String(g.command || ''), commandRedacted: !!g.commandRedacted,
    bin: g.bin ? String(g.bin).slice(0, 60) : null,
    cwd: String(g.cwd || '').slice(0, 400), tool: String(g.tool || 'Bash').slice(0, 120), engine: g.engine === 'codex' ? 'codex' : 'claude',
    // #548: `cwd` is the session's folder; the call's own folder was not told to the hook (a Codex shell call)
    ...(g.folderUnread === true ? { folderUnread: true, ...(g.repoNamed === true ? { repoNamed: true } : {}) } : {}),
    // #551: a folder change in the call may not have applied; every folder it may run in (shown on the row)
    ...(Array.isArray(g.folderUnsure) ? { folderUnsure: g.folderUnsure.slice(0, 4).map((d) => String(d).slice(0, 400)) } : {}),
    agent: String(g.agent || '').slice(0, 80), session: g.session ? String(g.session).slice(0, 80) : null,
    cmdHash: String(g.cmdHash || ''), hashVersion: g.hashVersion ? String(g.hashVersion).slice(0, 20) : null, requested_at: iso, ttlMinutes: Number(g.ttlMinutes) || 120,
    dryRun: g.dryRun ? { required: !!g.dryRun.required, seen_at: g.dryRun.seen_at || null, dryHash: g.dryRun.dryHash || null, command: g.dryRun.command ? String(g.dryRun.command).slice(0, MAX_CMD) : null } : { required: false, seen_at: null, dryHash: null },
    // the same call was approved before and expired unused (shown on the row; never re-armed)
    previously: g.previously ? { gate: String(g.previously.gate || ''), task: Number(g.previously.task) || null, at: g.previously.at || null } : null,
    // row context (src/row-context.mjs): chip ids from a fixed table, and the agent's own description of the call
    context: cleanContext(g.context), agentReason: g.agentReason ? String(g.agentReason).slice(0, MAX_WORDS) : null,
    status, decision: null, decided_by: null, decided_at: null, via: null, reason: null, recorded_by: null,
    expires_at: null, executed_at: null, attempts: 1, rerunsAfterDecline: 0,
  };
  // standing approval: the task's program go approves this class (the gate service checked eligibility)
  if (g.auto?.go && t.program_go?.id === g.auto.go && !t.program_go.revoked_at && !t.program_go.ended_at) {
    Object.assign(gate, { status: 'approved', decision: 'approve', decided_by: g.auto.owner || 'owner', decided_at: iso, via: 'standing', go: g.auto.go,
      reason: `auto-approved under program go ${g.auto.go}`, expires_at: new Date(Date.parse(iso) + 5 * 60e3).toISOString() });
  } else if (g.auto) throw new GateError(409, `task #${t.id} has no active program go ${g.auto.go}`);
  t.gates.push(gate);
  return gate;
}

export function findGate(t, id) {
  const g = (t.gates || []).find((x) => x.id === id);
  if (!g) throw new GateError(404, `task #${t.id} has no gate ${id}`);
  return g;
}
export const pendingGates = (t) => (t.gates || []).filter((g) => g.status === 'pending')
  .map((g) => ({ id: g.id, cls: g.cls, label: g.label, why: g.why, command: g.command, commandRedacted: g.commandRedacted, bin: g.bin, cwd: g.cwd, ...(g.folderUnread ? { folderUnread: true, ...(g.repoNamed ? { repoNamed: true } : {}) } : {}), ...(g.folderUnsure ? { folderUnsure: g.folderUnsure } : {}), agent: g.agent, tool: g.tool, requested_at: g.requested_at, dryRun: g.dryRun, previously: g.previously || null,
    context: g.context || [], agentReason: g.agentReason || null, ref: g.ref || null,
    ...(openProposal(g) ? { proposal: openProposal(g) } : {}) }));

// ── pane answers (SETTINGS.paneAnswers 'confirm') ───────────────────────────
// An approval the owner gave in an agent's pane is typed into the ledger by an agent, under a name
// the agent declares. So it is a PROPOSAL: it sits on the gate (or the approval request) and counts
// only when the owner confirms it on the board. Nothing is minted and no program go starts before.
const PROPOSAL_TEXT = 600;

/** The recorded pane answer still waiting for the owner, or null. `x` = a gate or an approval request. */
export function openProposal(x) {
  return x?.proposal && !x.proposal.confirmed_at && !x.proposal.overruled_at ? x.proposal : null;
}

/**
 * Build a proposal record. `text` must already be checked for secrets by the caller.
 * kind 'typed' = an approval typed in a terminal on this machine (it carried the decision token,
 * but did not come from the board page): the board cannot tell WHO typed it, so `by` is the word
 * "terminal" and never a name. No kind = a pane answer an agent recorded.
 */
export const newProposal = ({ text, by, iso, byMc = false, kind = null }) => ({ decision: 'approve', text: String(text || '').trim().slice(0, PROPOSAL_TEXT), by: String(by || '').slice(0, 80), at: iso, ...(byMc ? { by_mc: true } : {}), ...(kind === 'typed' ? { kind: 'typed' } : {}) });

/** "the pane answer recorded by <name>" / "the approval typed in a terminal": a proposal, in words. */
export const proposalWhat = (p) => (p?.kind === 'typed' ? 'the approval typed in a terminal' : `the pane answer recorded by ${p?.by}`);

/** Record a pane approval, or a typed one, on a pending gate. The gate stays pending. */
export function proposeGate(t, { gate, text }, { iso, by, byMc = false, kind = null }) {
  const g = findGate(t, gate);
  if (g.status !== 'pending') throw new GateError(409, `gate ${g.id} on #${t.id} is ${g.status}, not pending`);
  // a typed approval never replaces an answer that already waits: the owner confirms that one, or rejects it
  if (kind === 'typed' && openProposal(g)) throw new GateError(409, `gate ${g.id} on #${t.id} already has an answer waiting: confirm it on the board page`);
  g.proposal = newProposal({ text, by, iso, byMc, kind });
  return g;
}

/**
 * "Not what I said": the owner rejects a recorded pane answer. The gate (or request) stays as it
 * was; the rejected record is kept (the last 5) so the receipt shows it happened.
 * → the rejected proposal, or null when none was waiting.
 */
export function rejectProposal(x, { iso, by }) {
  const p = openProposal(x);
  if (!p) return null;
  const { prev, ...record } = p;   // `prev` (where the task was before the record) is for the caller, not the receipt
  x.disowned = [...(x.disowned || []), { ...record, rejected_at: iso, rejected_by: by }].slice(-5);
  delete x.proposal;
  return p;
}

/**
 * Where the owner decided: a receipt field only, never an authority (#350 acceptance gate).
 * cli: the owner CLI (x-mesh-via) · phone: the request came over the tailnet (from the socket
 * address, which the page can't fake) · dock / strip: what the page says it is (`?dock=1`, the
 * pinned WAITING ON YOU strip) · board: the WORK panel on this Mac. → { surface, surfaces }:
 * `surfaces` keeps every one that applies (a phone tap in the strip = ['phone','strip']),
 * `surface` the most specific (cli > dock > phone > strip > board).
 * `local` (the server sets it: the source address is one of THIS machine's own): a call the
 * machine makes to its own tailnet address has a tailnet source too, and is not the phone.
 */
export function decisionSurface({ via = null, remote = '', client = '', local = false } = {}) {
  if (via === 'cli') return { surface: 'cli', surfaces: ['cli'] };
  const said = new Set(String(client || '').toLowerCase().split(',').map((s) => s.trim()));
  const all = [];
  if (said.has('dock')) all.push('dock');
  if (!local && /^100\./.test(String(remote || '').replace(/^::ffff:/, ''))) all.push('phone');
  if (said.has('strip')) all.push('strip');
  if (!all.length) all.push('board');
  return { surface: all[0], surfaces: all };
}

/** An owner decision (board or recorded from the pane). */
export function decideGate(t, { gate, decision, reason }, { iso, via, by, recordedBy = null, now = Date.parse(iso), surface = null, surfaces = null }) {
  const g = findGate(t, gate);
  if (g.status !== 'pending') throw new GateError(409, `gate ${g.id} on #${t.id} is ${g.status}, not pending`);
  if (!['approve', 'decline'].includes(decision)) throw new GateError(400, 'decision must be approve|decline');
  g.decision = decision; g.decided_by = by; g.decided_at = iso; g.via = via; g.recorded_by = recordedBy;
  g.surface = surface || (via === 'pane' ? 'pane' : 'board'); g.surfaces = surfaces || [g.surface];
  g.reason = reason ? String(reason).slice(0, 300) : null;
  if (decision === 'approve') { g.status = 'approved'; g.expires_at = new Date(now + g.ttlMinutes * 60e3).toISOString(); }
  else g.status = 'declined';
  // a recorded pane answer was waiting: this decision settles it. Only the owner's own board
  // decision can CONFIRM it; a decline (from the board or recorded) overrules it; a direct pane
  // approval ('direct' mode) just takes its place, since it carries its own recorded_by.
  const p = openProposal(g);
  if (p && decision === 'decline') g.proposal = { ...p, overruled_at: iso };
  else if (p && via === 'board') g.proposal = { ...p, confirmed_at: iso };
  else if (p) delete g.proposal;
  return g;
}

/** When no gate is pending any more, the task leaves needs_approval (unless another approval waits). */
export function settleAfterGates(t, ownerId) {
  if ((t.gates || []).some((g) => g.status === 'pending')) return;
  const otherApproval = t.approval && t.approval.requested_at && !t.approval.decision;
  if (otherApproval) return;
  t.blocked_on = (t.blocked_on || []).filter((x) => x !== ownerId);
  if (t.status === 'needs_approval') {
    const prev = [...(t.gates || [])].reverse().find((g) => g.prev_status)?.prev_status;
    t.status = prev && !['needs_approval', 'done', 'cancelled'].includes(prev) ? prev : 'in_progress';
  }
}

/**
 * executed / expired / rerun_declined / attempt — written by the gate service.
 * `executed` is the stored 1.0 name; it means "released to run once": the board let the call
 * through and the agent reports the outcome. `at` + `note` come from the startup reconcile (#369).
 */
export function gateEvent(t, { gate, event, at, note }, iso) {
  const g = findGate(t, gate);
  if (at != null && (typeof at !== 'string' || Number.isNaN(Date.parse(at)))) throw new GateError(400, 'gate event "at" must be an ISO time');
  if (event === 'executed') { if (g.status !== 'approved') throw new GateError(409, `gate ${g.id} is ${g.status}`); g.status = 'executed'; g.executed_at = at || iso; }
  else if (event === 'expired') { if (g.status !== 'approved') throw new GateError(409, `gate ${g.id} is ${g.status}`); g.status = 'expired'; }
  else if (event === 'rerun_declined') { g.rerunsAfterDecline += 1; g.attempts += 1; }
  // a grant was presented for this gate and the receipt chain holds no approval for it: nothing ran
  else if (event === 'disputed') { if (g.status !== 'approved') throw new GateError(409, `gate ${g.id} is ${g.status}`); g.status = 'disputed'; g.disputed_at = at || iso; }
  else if (event === 'attempt') g.attempts += 1;
  else throw new GateError(400, `unknown gate event ${event}`);
  if (note != null) g.note = String(note).slice(0, 200);
  return g;
}

/** Close check: nothing pending, nothing re-run after a decline. */
export function gatesResolved(t) {
  const gates = t.gates || [];
  const pending = gates.filter((g) => g.status === 'pending');
  if (pending.length) return { ok: false, why: `gate ${pending.map((g) => g.id).join(', ')} still waiting on the owner` };
  const reruns = gates.filter((g) => g.rerunsAfterDecline > 0);
  if (reruns.length) return { ok: false, why: `gate ${reruns.map((g) => g.id).join(', ')} was re-attempted after the owner declined it (waive with a reason: --no-gates "<why>")` };
  return { ok: true, why: gates.length ? `${gates.length} gate(s), all resolved` : 'no gates' };
}

/** Rows for task.sh audit: every gate event in time order. */
export function auditRows(t) {
  const rows = [];
  for (const g of t.gates || []) {
    rows.push({ at: g.requested_at, gate: g.id, event: g.status === 'dry_required' || g.status === 'needs_focus' ? g.status : 'requested', cls: g.cls, command: g.command, cwd: g.cwd, actor: g.agent, via: g.engine });
    // a pane answer an agent recorded, or an approval typed in a terminal: shown for what it is — a record, not a decision
    const typed = (p) => p.kind === 'typed';
    const paneRow = (p, via) => ({ at: p.at, gate: g.id, event: typed(p) ? 'typed approval recorded' : 'pane answer recorded', cls: g.cls, command: g.command, cwd: g.cwd, actor: typed(p) ? 'a terminal on this machine' : p.by, via, reason: p.text });
    if (g.proposal) rows.push(paneRow(g.proposal, g.proposal.confirmed_at ? 'confirmed by the owner on the board' : g.proposal.overruled_at ? 'a later decision said otherwise' : 'not a decision — waiting for the owner to confirm on the board'));
    for (const d of g.disowned || []) {
      rows.push(paneRow(d, 'rejected by the owner'));
      rows.push({ at: d.rejected_at, gate: g.id, event: typed(d) ? 'typed approval rejected' : 'pane answer rejected', cls: g.cls, command: g.command, cwd: g.cwd, actor: d.rejected_by || 'owner', via: typed(d) ? 'board · not typed by the owner' : 'board · not what was said' });
    }
    if (g.decided_at) rows.push({ at: g.decided_at, gate: g.id, event: g.via === 'standing' ? 'auto-approved' : g.decision === 'approve' ? 'approved' : 'declined', cls: g.cls, command: g.command, cwd: g.cwd, actor: g.decided_by, via: g.via === 'standing' ? `program go ${g.go}` : g.via + (g.surfaces?.length && g.surfaces.join('+') !== g.via ? ` · ${g.surfaces.join('+')}` : '') + (g.recorded_by ? ` (recorded by ${g.recorded_by})` : '') + (g.proposal?.confirmed_at ? ` · confirming ${proposalWhat(g.proposal)}` : ''), surface: g.surface || null, reason: g.reason });
    if (g.executed_at) rows.push({ at: g.executed_at, gate: g.id, event: 'released (run once)', cls: g.cls, command: g.command, cwd: g.cwd, actor: g.agent, via: g.note ? `single-use grant · ${g.note}` : 'single-use grant' });
    if (g.status === 'disputed') rows.push({ at: g.disputed_at, gate: g.id, event: 'DISPUTED: a grant with no approval in the receipt chain (not run)', cls: g.cls, command: g.command, cwd: g.cwd, actor: 'gate', via: '' });
    if (g.status === 'expired') rows.push({ at: g.expires_at, gate: g.id, event: 'expired', cls: g.cls, command: g.command, cwd: g.cwd, actor: 'gate', via: '' });
    if (g.rerunsAfterDecline) rows.push({ at: g.decided_at, gate: g.id, event: `re-attempted ×${g.rerunsAfterDecline} after decline`, cls: g.cls, command: g.command, cwd: g.cwd, actor: g.agent, via: '' });
  }
  return rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** A focus entry → { task, explicit }. Older entries were a bare task id (treated as not explicit). */
export const focusOf = (m, agent) => {
  const v = m?.[agent];
  if (v == null) return null;
  return typeof v === 'object' ? { task: Number(v.task), explicit: !!v.explicit } : { task: Number(v), explicit: false };
};

// ── stores under data/guardrails/ (mode 600, atomic) ────────────────────────
async function readJson(file, fallback) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } }
async function writeAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writePrivate(tmp, JSON.stringify(value, null, 1));
  await rename(tmp, file);
  await makePrivate(file).catch(() => {});
}

/**
 * The guardrails state: one serialized writer (the board). Grants never leave this
 * module — callers learn only whether a redemption succeeded.
 */
export function createGateStore(dir) {
  const f = (n) => path.join(dir, n);
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  return {
    dir,
    /** Mint the single-use grant for an approved gate. */
    mint({ task, gate, agent, cmdHash, expiresAt }) {
      return serial(async () => {
        const grants = (await readJson(f('grants.json'), [])).filter((g) => !g.used_at && Date.parse(g.expires_at) > Date.now() - 24 * 3600e3);
        grants.push({ id: randomBytes(16).toString('hex'), task, gate, agent, cmdHash, expires_at: expiresAt, used_at: null });
        await writeAtomic(f('grants.json'), grants);
        return { ok: true };
      });
    },
    /** Consume the grant for exactly this command by this agent, once. → { task, gate } | { expired } | null */
    redeem({ cmdHash, agent, now = Date.now() }) {
      return serial(async () => {
        const grants = await readJson(f('grants.json'), []);
        const g = grants.find((x) => !x.used_at && x.cmdHash === cmdHash && x.agent === agent);
        if (!g) return null;
        if (Date.parse(g.expires_at) <= now) { g.used_at = 'expired'; await writeAtomic(f('grants.json'), grants); return { expired: true, task: g.task, gate: g.gate }; }
        g.used_at = new Date(now).toISOString();
        await writeAtomic(f('grants.json'), grants);
        return { task: g.task, gate: g.gate };
      });
    },
    /** Spent grants for the startup reconcile: only where and when, never the grant itself. */
    async spentGrants() {
      return (await readJson(f('grants.json'), [])).filter((g) => g.used_at).map((g) => ({ task: g.task, gate: g.gate, used_at: g.used_at }));
    },
    async dryRecords() { return readJson(f('dry.json'), []); },
    recordDry({ agent, cwd, dryHash, script, task, phase, now = Date.now() }) {
      return serial(async () => {
        const recs = await readJson(f('dry.json'), []);
        const iso = new Date(now).toISOString();
        if (phase === 'completed') {
          const r = [...recs].reverse().find((x) => x.agent === agent && x.dryHash === dryHash && !x.completed_at);
          if (r) r.completed_at = iso; else return false;
        } else recs.push({ agent, cwd, dryHash, script, task: task ?? null, started_at: iso, completed_at: null });
        await writeAtomic(f('dry.json'), recs.slice(-500));
        return true;
      });
    },
    async watched() { return readJson(f('watch.json'), []); },
    watch(scriptAbs) {
      return serial(async () => {
        const w = await readJson(f('watch.json'), []);
        if (w.includes(scriptAbs)) return false;
        w.push(scriptAbs); await writeAtomic(f('watch.json'), w.slice(-400));
        return true;
      });
    },
    async focus() { return readJson(f('focus.json'), {}); },
    /** explicit = set by `task.sh focus`; claim/start set a non-explicit focus (gate-service autoFocus). */
    setFocus(agent, taskId, { explicit = true } = {}) {
      return serial(async () => { const m = await readJson(f('focus.json'), {}); m[agent] = { task: Number(taskId), explicit }; await writeAtomic(f('focus.json'), m); });
    },
    observe(entry) {
      return serial(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writePrivate(f('observed.jsonl'), JSON.stringify(entry) + '\n', { append: true });
      });
    },
    /** One line per /api/gates/check the board answered (pass/allow/deny), so no check is ever blind. */
    logCheck(entry) {
      return serial(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = f('checks.jsonl');
        await writePrivate(file, JSON.stringify(entry) + '\n', { append: true });
        // keep it small: past ~4 MB, keep the newest half (the size is read first, the file only when it is over)
        if (((await stat(file).catch(() => null))?.size || 0) > 4e6) {
          const text = await readFile(file, 'utf8').catch(() => '');
          const lines = text.trim().split('\n');
          await writePrivate(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
        }
      });
    },
    // serialized + a unique tmp name: two first checks after a policy change used to race on one
    // tmp path, and the loser's rename threw (a spurious deny; #369's concurrency test found it)
    /** The generated triggers file as it is on disk, or null when it is missing (the integrity check compares it). */
    readTriggers() { return readFile(f('triggers'), 'utf8').catch(() => null); },
    writeTriggers(lines) {
      return serial(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = `${f('triggers')}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
        await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o644 });   // patterns only — no secrets; the hook reads it
        await rename(tmp, f('triggers'));
      });
    },
  };
}
