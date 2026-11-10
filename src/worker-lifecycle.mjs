// Worker lifecycle rules that used to be prose (pure; the CLI and the spawn/close scripts do the I/O).
//
//   adopt      a worker spawned on a task Mission Control owns gets the task at spawn,
//              so its `task.sh claim` works (a claim on someone else's task is refused)
//   sweep      the tasks whose worktrees a closing worker leaves: the ones it owns PLUS
//              the task it was spawned on, whoever owns that now
//   blockers   what must stop a workspace close: the worker's live tasks and open PRs
//   capacity   live workers against a limit — a warning at spawn, never a refusal

const LIVE = new Set(['open', 'claimed', 'in_progress', 'blocked', 'needs_approval']);
const slugOf = (s) => String(s || '').toLowerCase();

/** Is `name` Mission Control? The reserved name, or a directory entry of kind mission-control. */
export function isMissionControl(name, agents = []) {
  const n = slugOf(name);
  if (!n) return false;
  if (n === 'mission-control') return true;
  return agents.some((a) => slugOf(a.name) === n && a.kind === 'mission-control');
}

/**
 * Should the spawn hand `task` to `worker`? Only when Mission Control owns it (or nobody
 * does) and it is live. A task some other agent owns is never taken.
 * → { assign: true } | { assign: false, why }
 */
export function adoptDecision(task, worker, agents = []) {
  if (!task) return { assign: false, why: 'no such task' };
  if (!LIVE.has(task.status)) return { assign: false, why: `task #${task.id} is ${task.status}` };
  if (slugOf(task.owner) === slugOf(worker)) return { assign: false, why: 'already the owner', silent: true };   // the ordinary spawn: nothing to say
  if (task.owner && !isMissionControl(task.owner, agents)) return { assign: false, why: `task #${task.id} is owned by ${task.owner}, not Mission Control` };
  return { assign: true };
}

/** The tasks a closing worker's sweep covers: owned by it, plus its spawn task (deduped, by id). */
export function sweepTasks(tasks, worker, spawnTask = null) {
  const w = slugOf(worker);
  const want = Number(spawnTask) || null;
  const seen = new Set();
  return (tasks || []).filter((t) => {
    if (seen.has(t.id)) return false;
    const mine = slugOf(t.owner) === w || (want && Number(t.id) === want);
    if (mine) seen.add(t.id);
    return mine;
  });
}

export const PR_READ_DAYS = 3;
export const PR_READ_CAP = 4;

/**
 * Which of the sweep set's PRs are worth reading before a close: those on live tasks, on the spawn
 * task, and on tasks closed in the last PR_READ_DAYS days. A long-lived agent has dozens of old
 * closed tasks with PR links; those landed long ago and are not read.
 * → { read: [tasks], skipped: n }
 */
export function prsToRead(tasks, { spawnTask = null, now = Date.now(), days = PR_READ_DAYS } = {}) {
  const withPr = (tasks || []).filter((t) => t.links?.pr);
  const want = Number(spawnTask) || null;
  const recent = (t) => { const at = Date.parse(t.closed_at || t.updated_at || ''); return Number.isFinite(at) && now - at <= days * 86400e3; };
  const read = withPr.filter((t) => LIVE.has(t.status) || (want && Number(t.id) === want) || recent(t));
  return { read, skipped: withPr.length - read.length };
}

/** Run `fn` over `items` with at most `cap` in flight; results in input order. */
export async function mapCapped(items, cap, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(cap, items.length)) }, worker));
  return out;
}

/**
 * What stands in the way of closing a worker's workspace.
 *   tasks  the sweep set (any status)
 *   prs    [{ task, url, state }] — the PRs read for those tasks ('OPEN' blocks; null state = unread)
 * → { ok, lines: [text…], liveTasks: [ids], openPrs: [urls], unread: [urls] }
 */
export function closeBlockers(tasks, prs = []) {
  const live = (tasks || []).filter((t) => LIVE.has(t.status));
  const open = prs.filter((p) => p.state === 'OPEN');
  const unread = prs.filter((p) => p.state == null);
  const lines = [
    ...live.map((t) => `live task #${t.id} [${t.status}] ${t.title}`),
    ...open.map((p) => `open PR ${p.url}${p.task ? ` (task #${p.task})` : ''}`),
  ];
  return { ok: !lines.length, lines, liveTasks: live.map((t) => t.id), openPrs: open.map((p) => p.url), unread: unread.map((p) => p.url) };
}

export const DEFAULT_MAX_WORKERS = 3;

/**
 * Live workers against the limit (SETTINGS.workers.max, default 3). Counts directory
 * entries of kind worker that are not closed and have a workspace.
 * → { count, max, over, line } — `line` is the warning to print when one more would exceed it.
 */
export function workerCapacity(agents = [], cfg = {}) {
  const max = Number.isInteger(cfg?.max) && cfg.max > 0 ? cfg.max : DEFAULT_MAX_WORKERS;
  const live = agents.filter((a) => a.kind === 'worker' && a.status !== 'closed' && a.workspaceId);
  const over = live.length >= max;
  return {
    count: live.length, max, over,
    line: over ? `worker limit: ${live.length} live worker(s) (${live.map((a) => a.name).join(', ')}) — this spawn makes ${live.length + 1}, the limit is ${max}. Spawning anyway (warning only).` : null,
  };
}
