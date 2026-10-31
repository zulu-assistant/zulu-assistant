// Guardrails: the gate records on a ledger task (pure) — gates[], decisions, the
// close check — plus the small stores the gate service keeps under data/guardrails/
// (grants, dry runs, watched scripts, focus, observe log). docs/GUARDRAILS.md.
import { readFile, writeFile, rename, mkdir, appendFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

export class GateError extends Error {
  constructor(status, message) { super(message); this.status = status; this.extra = {}; }
}
export const MAX_CMD = 1500;          // what the panel row shows
const MAX_FULL = 20000;               // what gates[] keeps (the full approved text; longer inputs are cut and say so)
const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more chars — full text: task.sh audit <id> --json]` : s);
const STATUSES = ['pending', 'approved', 'declined', 'expired', 'executed', 'dry_required', 'needs_focus'];

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
    agent: String(g.agent || '').slice(0, 80), session: g.session ? String(g.session).slice(0, 80) : null,
    cmdHash: String(g.cmdHash || ''), hashVersion: g.hashVersion ? String(g.hashVersion).slice(0, 20) : null, requested_at: iso, ttlMinutes: Number(g.ttlMinutes) || 120,
    dryRun: g.dryRun ? { required: !!g.dryRun.required, seen_at: g.dryRun.seen_at || null, dryHash: g.dryRun.dryHash || null, command: g.dryRun.command ? String(g.dryRun.command).slice(0, MAX_CMD) : null } : { required: false, seen_at: null, dryHash: null },
    // the same call was approved before and expired unused (shown on the row; never re-armed)
    previously: g.previously ? { gate: String(g.previously.gate || ''), task: Number(g.previously.task) || null, at: g.previously.at || null } : null,
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
  .map((g) => ({ id: g.id, cls: g.cls, label: g.label, why: g.why, command: cap(g.command, MAX_CMD), commandRedacted: g.commandRedacted, bin: g.bin, cwd: g.cwd, agent: g.agent, tool: g.tool, requested_at: g.requested_at, dryRun: g.dryRun, previously: g.previously || null }));

/**
 * Where the owner decided: a receipt field only, never an authority (#350 acceptance gate).
 * cli: the owner CLI (x-mesh-via) · phone: the request came over the tailnet (from the socket
 * address, which the page can't fake) · dock / strip: what the page says it is (`?dock=1`, the
 * pinned WAITING ON YOU strip) · board: the WORK panel on this Mac. → { surface, surfaces }:
 * `surfaces` keeps every one that applies (a phone tap in the strip = ['phone','strip']),
 * `surface` the most specific (cli > dock > phone > strip > board).
 */
export function decisionSurface({ via = null, remote = '', client = '' } = {}) {
  if (via === 'cli') return { surface: 'cli', surfaces: ['cli'] };
  const said = new Set(String(client || '').toLowerCase().split(',').map((s) => s.trim()));
  const all = [];
  if (said.has('dock')) all.push('dock');
  if (/^100\./.test(String(remote || '').replace(/^::ffff:/, ''))) all.push('phone');
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

/** executed / expired / rerun_declined / attempt — written by the gate service. */
export function gateEvent(t, { gate, event }, iso) {
  const g = findGate(t, gate);
  if (event === 'executed') { if (g.status !== 'approved') throw new GateError(409, `gate ${g.id} is ${g.status}`); g.status = 'executed'; g.executed_at = iso; }
  else if (event === 'expired') { if (g.status !== 'approved') throw new GateError(409, `gate ${g.id} is ${g.status}`); g.status = 'expired'; }
  else if (event === 'rerun_declined') { g.rerunsAfterDecline += 1; g.attempts += 1; }
  else if (event === 'attempt') g.attempts += 1;
  else throw new GateError(400, `unknown gate event ${event}`);
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
    if (g.decided_at) rows.push({ at: g.decided_at, gate: g.id, event: g.via === 'standing' ? 'auto-approved' : g.decision === 'approve' ? 'approved' : 'declined', cls: g.cls, command: g.command, cwd: g.cwd, actor: g.decided_by, via: g.via === 'standing' ? `program go ${g.go}` : g.via + (g.surfaces?.length && g.surfaces.join('+') !== g.via ? ` · ${g.surfaces.join('+')}` : '') + (g.recorded_by ? ` (recorded by ${g.recorded_by})` : ''), surface: g.surface || null, reason: g.reason });
    if (g.executed_at) rows.push({ at: g.executed_at, gate: g.id, event: 'executed', cls: g.cls, command: g.command, cwd: g.cwd, actor: g.agent, via: 'single-use grant' });
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
  await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600).catch(() => {});
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
        await appendFile(f('observed.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 });
      });
    },
    /** One line per /api/gates/check the board answered (pass/allow/deny), so no check is ever blind. */
    logCheck(entry) {
      return serial(async () => {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const file = f('checks.jsonl');
        await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
        // keep it small: past ~2 MB, keep the newest half
        const text = await readFile(file, 'utf8').catch(() => '');
        if (text.length > 2e6) {
          const lines = text.trim().split('\n');
          await writeFile(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n', { mode: 0o600 });
        }
      });
    },
    async writeTriggers(lines) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const tmp = `${f('triggers')}.${process.pid}.tmp`;
      await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o644 });   // patterns only — no secrets; the hook reads it
      await rename(tmp, f('triggers'));
    },
  };
}
