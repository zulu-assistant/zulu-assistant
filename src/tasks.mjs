// Agent Mesh task ledger — the source of truth for cross-agent work.
//
// One JSON file per task in data/tasks/<id>.json, written atomically
// (tmp + rename). The board server is the only writer (every CLI goes through
// the HTTP API), and writes are serialized through one promise chain, so no
// file lock is needed. The pure functions (newTask / applyPatch / summarize)
// carry all the rules and are what the tests exercise.
import { readFile, writeFile, readdir, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { OWNER, isOwner, SETTINGS } from './config.mjs';

export const STATUSES = ['open', 'claimed', 'in_progress', 'blocked', 'needs_approval', 'done', 'cancelled'];
export const LIVE_STATUSES = ['open', 'claimed', 'in_progress', 'blocked', 'needs_approval'];
// What "done" means before a task may close: SETTINGS.ledger.checklist in the
// registry (examples: docs + report; add vault_synced / graphify_updated when you
// run the brain). `--checklist all` / checklist: 'all' ticks every configured item.
export const DEFAULT_CHECKLIST = ['docs_updated', 'report_written'];
export function checklistFrom(settings) {
  const items = settings?.ledger?.checklist;
  if (!Array.isArray(items) || !items.length) return [...DEFAULT_CHECKLIST];
  for (const k of items) if (!/^[a-z][a-z0-9_]{0,39}$/.test(k)) throw new Error(`SETTINGS.ledger.checklist: bad item "${k}"`);
  return [...new Set(items)];
}
export const CHECKLIST = checklistFrom(SETTINGS);
const tickAll = (c) => (c === 'all' ? Object.fromEntries(CHECKLIST.map((k) => [k, true])) : c || {});
export const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
export const LINK_KEYS = ['vault', 'graphify_query', 'handoff', 'pr', 'repo'];

const MAX_TITLE = 200;
const MAX_TEXT = 2000;          // messages stay short and link out (AGENT-MESH rule 4)
const MAX_COMMENTS = 200;
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Never store secrets in the ledger: refuse text that looks like a credential.
const SECRET_PATTERNS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/, /\bshp(?:at|ss|ca|pa)_[A-Fa-f0-9]{16,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,   // JWTs (Supabase service keys)
  /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{8,}/i,
];

export class MeshError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

const bad = (msg, extra) => { throw new MeshError(400, msg, extra); };

export function containsSecret(text) {
  return SECRET_PATTERNS.some((re) => re.test(String(text || '')));
}

function cleanText(v, field, max = MAX_TEXT) {
  const s = String(v ?? '').trim();
  if (s.length > max) bad(`${field} too long (${s.length} > ${max} chars) — link to a handoff file instead`);
  if (containsSecret(s)) bad(`${field} looks like it contains a secret — never store credentials in the ledger`);
  return s;
}

function cleanName(v, field) {
  const s = String(v ?? '').trim();
  if (!NAME_RE.test(s)) bad(`${field} must be an agent name from config/agents.json (or "${OWNER.id}")`);
  return isOwner(s.toLowerCase()) ? OWNER.id : s.toLowerCase();
}

function cleanLinks(links = {}) {
  if (typeof links !== 'object' || Array.isArray(links)) bad('links must be an object');
  const out = {};
  for (const [k, v] of Object.entries(links)) {
    if (!LINK_KEYS.includes(k)) bad(`unknown link "${k}" (allowed: ${LINK_KEYS.join(', ')})`);
    if (v != null && v !== '') out[k] = cleanText(v, `links.${k}`, 500);
  }
  return out;
}

function cleanBlockedOn(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split(',');
  return arr.map((x) => String(x).trim().replace(/^#/, '')).filter(Boolean).map((x) => {
    if (isOwner(x) || /^\d+$/.test(x)) return isOwner(x) ? OWNER.id : Number(x);
    return bad(`blocked_on entries must be task ids or "${OWNER.id}" (got "${x}")`);
  });
}

export function missingChecklist(task) {
  return CHECKLIST.filter((k) => task.checklist?.[k] !== true);
}

/** Build a new task record (validated). */
export function newTask(input, { id, now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') bad('body must be a JSON object');
  const title = cleanText(input.title, 'title', MAX_TITLE);
  if (!title) bad('title is required');
  const requester = cleanName(input.requester, 'requester');
  const owner = input.owner ? cleanName(input.owner, 'owner') : null;
  const priority = input.priority ?? 'normal';
  if (!PRIORITIES.includes(priority)) bad(`priority must be one of ${PRIORITIES.join('|')}`);
  const iso = new Date(now).toISOString();
  const task = {
    id, title, requester, owner,
    // identity is the workspace: names are display, re-synced after a rename
    requester_ws: input.requester_ws || null,
    owner_ws: owner ? (input.owner_ws || null) : null,
    status: 'open',
    blocked_on: [],
    priority,
    links: cleanLinks(input.links),
    checklist: Object.fromEntries(CHECKLIST.map((k) => [k, false])),
    comments: [],
    approval: null,
    created_at: iso, updated_at: iso, closed_at: null,
  };
  const body = input.body ? cleanText(input.body, 'body') : '';
  if (body) task.comments.push({ who: requester, at: iso, text: body });
  return task;
}

const TERMINAL = new Set(['done', 'cancelled']);

/** An approval that was requested and never decided (on the board or recorded from the pane). */
export const undecidedApproval = (t) => Boolean(t.approval?.requested_at && !t.approval.decision);

/**
 * Settle an undecided approval on a task that is no longer waiting for one, so the
 * ledger never carries a "pending" approval forever. The decision itself is NOT
 * known (the owner usually answers in the agent's pane): it is stamped
 * `unrecorded`, with the op that moved the task on — `record_decision` may still
 * replace it with the real answer. A cancel withdraws the request.
 */
export function settleApproval(t, { op, actor, iso }) {
  if (!undecidedApproval(t) || t.status === 'needs_approval') return false;
  t.approval = {
    ...t.approval,
    decision: t.status === 'cancelled' ? 'withdrawn' : 'unrecorded',
    decided_by: null, decided_at: iso, via: 'inferred', recorded_by: actor, inferred_from: op,
  };
  return true;
}

/**
 * Apply one operation to a task. Returns { task, events, wake } where events
 * are ticker lines and wake lists agent names that should be woken.
 * `ctx.decider` is true only when the caller proved it is the owner's board UI.
 */
export function applyPatch(prev, patch, ctx = {}) {
  if (!patch || typeof patch !== 'object') bad('patch must be a JSON object');
  const now = ctx.now ?? Date.now();
  const iso = new Date(now).toISOString();
  const actor = cleanName(patch.actor ?? ctx.actor, 'actor');
  const t = structuredClone(prev);
  const events = [];
  const wake = new Set();
  const notifyMC = [];
  let wakeKind = null;           // what the wake SAYS — decided by the op, never by the task's status
  let note = null;
  const op = patch.op;
  const isMC = actor === 'mission-control' || ctx.mc === true;
  const comment = (text, who = actor) => {
    const s = cleanText(text, 'text');
    if (!s) return;
    t.comments.push({ who, at: iso, text: s });
    if (t.comments.length > MAX_COMMENTS) t.comments = t.comments.slice(-MAX_COMMENTS);
  };
  const ownerOnly = () => {
    if (t.owner && t.owner !== actor && !isMC)
      throw new MeshError(403, `task #${t.id} is owned by ${t.owner} — only the owner (or mission-control) can do "${op}"`);
  };

  if (TERMINAL.has(t.status) && !['comment', 'reopen', 'record_decision', 'set_requester'].includes(op))
    throw new MeshError(409, `task #${t.id} is ${t.status}`);

  switch (op) {
    case 'claim':
      if (t.owner && t.owner !== actor) throw new MeshError(409, `task #${t.id} is already owned by ${t.owner} — ask them or mission-control to reassign`);
      t.owner = actor;
      t.owner_ws = ctx.actorWs || t.owner_ws || null;
      t.status = 'claimed';
      comment(patch.text);
      events.push(`task #${t.id} claimed by ${actor}: ${t.title}`);
      break;
    case 'start':
      ownerOnly();
      t.status = 'in_progress';
      comment(patch.text);
      break;
    case 'assign': {
      const owner = cleanName(patch.owner, 'owner');
      if (t.owner && t.owner !== owner && actor !== t.requester && !isMC && actor !== t.owner)
        throw new MeshError(403, 'only the requester, current owner or mission-control can reassign');
      const changed = owner !== t.owner;
      t.owner = owner;
      t.owner_ws = patch.owner_ws || null;
      t.status = 'open';
      comment(patch.text);
      events.push(`task #${t.id} assigned to ${owner} by ${actor}: ${t.title}`);
      if (changed) { wake.add(owner); wakeKind = 'assigned'; }   // "assigned" only on an owner change
      break;
    }
    case 'comment':
      if (!String(patch.text ?? '').trim()) bad('comment needs text');
      comment(patch.text);
      if (patch.wake) {
        for (const n of [t.owner, t.requester]) if (n && n !== actor && !isOwner(n)) wake.add(n);
        wakeKind = 'comment';
        note = String(patch.text).split('\n')[0].trim();
      }
      break;
    case 'block': {
      ownerOnly();
      const on = cleanBlockedOn(patch.blocked_on);
      if (!on.length) bad(`block needs blocked_on (task ids and/or "${OWNER.id}")`);
      t.blocked_on = on;
      t.status = 'blocked';
      comment(patch.text);
      events.push(`task #${t.id} BLOCKED on ${on.map((x) => (typeof x === 'number' ? '#' + x : x)).join(', ')}: ${t.title}`);
      notifyMC.push('blocked');
      break;
    }
    case 'unblock':
      ownerOnly();
      t.blocked_on = [];
      t.status = 'in_progress';
      comment(patch.text);
      events.push(`task #${t.id} unblocked`);
      break;
    case 'request_approval': {
      ownerOnly();
      const item = cleanText(patch.policy_item, 'policy_item', 300);
      if (!item) bad('request_approval needs policy_item (the POLICY.md ESCALATE line this falls under)');
      t.approval = { policy_item: item, requested_at: iso, requested_by: actor, decided_by: null, decision: null, decided_at: null };
      t.status = 'needs_approval';
      if (!t.blocked_on.includes(OWNER.id)) t.blocked_on.push(OWNER.id);
      comment(patch.text);
      events.push(`task #${t.id} NEEDS APPROVAL (${item}): ${t.title}`);
      notifyMC.push('approval');
      break;
    }
    case 'decide': {
      if (!ctx.decider) throw new MeshError(403, `approvals are decided by ${OWNER.name} from the board (WORK panel) only`);
      if (t.status !== 'needs_approval' || !t.approval) throw new MeshError(409, `task #${t.id} is not awaiting approval`);
      const decision = patch.decision;
      if (!['approve', 'decline'].includes(decision)) bad('decision must be approve|decline');
      t.approval = { ...t.approval, decided_by: OWNER.id, decision, decided_at: iso };
      t.blocked_on = t.blocked_on.filter((x) => x !== OWNER.id);
      t.status = decision === 'approve' ? 'in_progress' : 'blocked';
      if (decision === 'decline' && !t.blocked_on.length) t.blocked_on = [OWNER.id];
      comment(patch.text || `${decision === 'approve' ? 'APPROVED' : 'DECLINED'} by ${OWNER.name} (${t.approval.policy_item})`, OWNER.id);
      events.push(`task #${t.id} ${decision === 'approve' ? 'APPROVED' : 'DECLINED'} by ${OWNER.name}: ${t.title}`);
      if (t.owner) wake.add(t.owner);
      wakeKind = 'decision';
      break;
    }
    case 'record_decision': {
      // The owner answered in the agent's pane (e.g. outward writes approved in the pane):
      // the task owner or Mission Control records it so the ledger matches reality.
      ownerOnly();
      if (!t.approval?.requested_at) throw new MeshError(409, `task #${t.id} has no approval request to record`);
      if (['approve', 'decline'].includes(t.approval.decision))
        throw new MeshError(409, `task #${t.id} approval is already decided (${t.approval.decision})`);
      const decision = patch.decision ?? 'approve';
      if (!['approve', 'decline'].includes(decision)) bad('decision must be approve|decline');
      if (!String(patch.text ?? '').trim()) bad(`record_decision needs text: what ${OWNER.name} said, and where`);
      t.approval = {
        policy_item: t.approval.policy_item, requested_at: t.approval.requested_at, requested_by: t.approval.requested_by,
        decided_by: OWNER.id, decision, decided_at: iso, via: 'pane', recorded_by: actor,
      };
      if (t.status === 'needs_approval') {
        t.blocked_on = t.blocked_on.filter((x) => x !== OWNER.id);
        t.status = decision === 'approve' ? 'in_progress' : 'blocked';
        if (decision === 'decline' && !t.blocked_on.length) t.blocked_on = [OWNER.id];
      }
      comment(`${decision === 'approve' ? 'APPROVED' : 'DECLINED'} by ${OWNER.name} in pane (recorded by ${actor}): ${patch.text}`);
      events.push(`task #${t.id} ${decision === 'approve' ? 'APPROVED' : 'DECLINED'} by ${OWNER.name} in pane (recorded by ${actor}): ${t.title}`);
      break;
    }
    case 'set_requester': {
      // repair a misattributed task — Mission Control only
      if (!isMC) throw new MeshError(403, 'only mission-control can change a task\'s requester');
      const requester = cleanName(patch.requester, 'requester');
      if (!String(patch.text ?? '').trim()) bad('set_requester needs text (why)');
      const was = t.requester;
      t.requester = requester;
      t.requester_ws = patch.requester_ws || null;
      comment(`requester ${was} → ${requester}: ${patch.text}`);
      events.push(`task #${t.id} requester ${was} → ${requester} (by ${actor})`);
      break;
    }
    case 'checklist':
      ownerOnly();
      for (const [k, v] of Object.entries(tickAll(patch.checklist))) {
        if (!CHECKLIST.includes(k)) bad(`unknown checklist item "${k}" (items: ${CHECKLIST.join(', ')})`);
        t.checklist[k] = v === true;
      }
      break;
    case 'link':
      t.links = { ...t.links, ...cleanLinks(patch.links) };
      break;
    case 'close': {
      ownerOnly();
      for (const [k, v] of Object.entries(tickAll(patch.checklist))) {
        if (!CHECKLIST.includes(k)) bad(`unknown checklist item "${k}" (items: ${CHECKLIST.join(', ')})`);
        t.checklist[k] = v === true;
      }
      if (patch.links) t.links = { ...t.links, ...cleanLinks(patch.links) };
      const missing = missingChecklist(t);
      if (missing.length) {
        throw new MeshError(409, `cannot close task #${t.id}: checklist incomplete — ${missing.join(', ')}`, { missing });
      }
      if (!t.links.handoff && !t.links.pr && !t.links.vault) {
        throw new MeshError(409, `cannot close task #${t.id}: link the report (links.handoff), PR or vault note`, { missing: ['links.handoff|pr|vault'] });
      }
      t.status = 'done';
      t.blocked_on = [];
      t.closed_at = iso;
      comment(patch.text);
      events.push(`task #${t.id} DONE by ${actor}: ${t.title}`);
      // the ONE done notice: fired by the transition, never by later comments
      if (t.requester && t.requester !== actor && !isOwner(t.requester)) wake.add(t.requester);
      wakeKind = 'done';
      break;
    }
    case 'cancel':
      if (!isMC && ![t.requester, t.owner, OWNER.id].includes(actor))
        throw new MeshError(403, 'only the requester, owner or mission-control can cancel');
      t.status = 'cancelled';
      t.closed_at = iso;
      comment(patch.text);
      events.push(`task #${t.id} cancelled by ${actor}: ${t.title}`);
      break;
    case 'reopen':
      if (!isMC && ![t.requester, t.owner, OWNER.id].includes(actor))
        throw new MeshError(403, 'only the requester, owner or mission-control can reopen');
      t.status = t.owner ? 'claimed' : 'open';
      t.closed_at = null;
      comment(patch.text);
      events.push(`task #${t.id} reopened by ${actor}`);
      break;
    default:
      bad(`unknown op "${op}" (claim|start|assign|comment|block|unblock|request_approval|record_decision|set_requester|checklist|link|close|cancel|reopen)`);
  }
  if (settleApproval(t, { op, actor, iso })) comment(`approval request settled as ${t.approval.decision} (task moved on by "${op}" without a recorded decision — record the real one with task.sh approved-in-pane)`);
  t.updated_at = iso;
  wake.delete(actor);
  return { task: t, events, wake: [...wake], notifyMC, wakeKind: wake.size ? wakeKind : null, note };
}

/** The one-line wake text for a task change, by kind (pure). */
export function wakeMessage(task, kind, { note = null } = {}) {
  switch (kind) {
    case 'done': return `Task #${task.id} done: ${task.title}`;
    case 'decision': return `Task #${task.id} ${task.approval?.decision === 'approve' ? 'APPROVED' : 'DECLINED'} by ${OWNER.name}: ${task.title}`;
    case 'comment': return `comment on #${task.id} (${String(task.title).slice(0, 40)}): ${String(note || '').slice(0, 160)}`;
    default: return `Task #${task.id} assigned: ${task.title}`;
  }
}

export function matches(task, { owner, status, requester } = {}) {
  if (owner && task.owner !== String(owner).toLowerCase()) return false;
  if (requester && task.requester !== String(requester).toLowerCase()) return false;
  if (status) {
    const want = String(status).split(',').map((s) => s.trim()).filter(Boolean);
    const expanded = want.flatMap((s) => (s === 'live' ? LIVE_STATUSES : [s]));
    if (!expanded.includes(task.status)) return false;
  }
  return true;
}

/** Compact view for the board payload, triage and the digest. */
export function summarize(tasks, now = Date.now()) {
  const brief = (t) => {
    const last = t.comments[t.comments.length - 1];
    return {
      id: t.id, title: t.title, owner: t.owner, requester: t.requester, status: t.status,
      priority: t.priority, blocked_on: t.blocked_on, approval: t.approval,
      ageH: Math.round((now - Date.parse(t.created_at)) / 36e5 * 10) / 10,
      updated_at: t.updated_at,
      last: last ? `${last.who}: ${last.text.split('\n')[0].slice(0, 140)}` : '',
    };
  };
  const dayAgo = now - 24 * 3600e3;
  const live = tasks.filter((t) => LIVE_STATUSES.includes(t.status)).sort((a, b) => a.id - b.id);
  return {
    counts: {
      open: live.filter((t) => ['open', 'claimed', 'in_progress'].includes(t.status)).length,
      blocked: live.filter((t) => t.status === 'blocked').length,
      needsApproval: live.filter((t) => t.status === 'needs_approval').length,
      closed24h: tasks.filter((t) => t.status === 'done' && Date.parse(t.closed_at) > dayAgo).length,
    },
    needsApproval: live.filter((t) => t.status === 'needs_approval').map(brief),
    blocked: live.filter((t) => t.status === 'blocked').map(brief),
    open: live.filter((t) => ['open', 'claimed', 'in_progress'].includes(t.status)).map(brief),
    closed24h: tasks.filter((t) => t.status === 'done' && Date.parse(t.closed_at) > dayAgo).map(brief),
    owner: OWNER.name,   // labels the approval column ("AWAITING <OWNER>")
  };
}

// ---- store ------------------------------------------------------------------

export function createLedger(dir) {
  let cache = null;          // Map id -> task
  let chain = Promise.resolve();
  const serialize = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };

  async function load() {
    if (cache) return cache;
    await mkdir(dir, { recursive: true });
    cache = new Map();
    for (const f of await readdir(dir)) {
      if (!/^\d+\.json$/.test(f)) continue;
      try {
        const t = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
        // older tasks moved on before settleApproval existed: settle them once, on disk
        if (settleApproval(t, { op: 'backfill', actor: 'ledger', iso: t.updated_at })) await persist(t);
        cache.set(t.id, t);
      } catch (e) { console.error('[tasks] unreadable', f, e.message); }
    }
    return cache;
  }

  async function persist(t) {
    const file = path.join(dir, `${t.id}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(t, null, 2));
    await rename(tmp, file);           // atomic on the same filesystem
  }

  return {
    async list(filter = {}) {
      const all = [...(await load()).values()].filter((t) => matches(t, filter));
      return all.sort((a, b) => a.id - b.id);
    },
    async get(id) { return (await load()).get(Number(id)) || null; },
    create(input, now = Date.now()) {
      return serialize(async () => {
        const m = await load();
        const id = Math.max(0, ...m.keys()) + 1;
        const t = newTask(input, { id, now });
        await persist(t);
        m.set(id, t);
        return t;
      });
    },
    update(id, patch, ctx = {}) {
      return serialize(async () => {
        const m = await load();
        const prev = m.get(Number(id));
        if (!prev) throw new MeshError(404, `no task #${id}`);
        const r = applyPatch(prev, patch, ctx);
        await persist(r.task);
        m.set(r.task.id, r.task);
        return r;
      });
    },
    async summary(now) { return summarize([...(await load()).values()], now); },
    /** After a workspace rename: rewrite owner/requester to the current name. */
    syncNames(nameByWs) {
      return serialize(async () => {
        const changed = [];
        for (const t of (await load()).values()) {
          let dirty = false;
          for (const [nameKey, wsKey] of [['owner', 'owner_ws'], ['requester', 'requester_ws']]) {
            const cur = t[wsKey] && nameByWs.get(t[wsKey]);
            if (cur && cur !== t[nameKey]) { t[nameKey] = cur; dirty = true; }
          }
          if (dirty) { await persist(t); changed.push(t.id); }
        }
        return changed;
      });
    },
  };
}
