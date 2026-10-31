// Context autopilot (task #351): the board saves an agent's state and compacts it
// before Claude Code's own auto-compact (~95%) cuts in mid-thought.
//
//   ≥ warnPct (70)     WARN once per episode: "finish the step, update <continuity file>"
//   ≥ compactPct (80)  COMPACT at the next READY pane, once the state is fresh
//                      (continuity file or an owner comment newer than the warn)
//   ≥ forcePct (90)    COMPACT at the next READY pane even with stale state + tell Mission Control
//   compaction seen    RESUME: "re-read <continuity file> and continue with #N"
//
// READY = the mesh delivery rule (deliverNow): never a busy pane, a dialog or a
// draft, so never mid-turn. One attempt per cooldown; an attempt that shows no
// compaction within confirmMinutes is a failure; after maxFailures the episode
// stops and Mission Control is told. State: data/context-state.json (workspaceId →
// record). Pure decision in nextAction(); runAutopilot() does the I/O through deps.
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from './mesh.mjs';

export const DEFAULTS = { warnPct: 70, compactPct: 80, forcePct: 90, cooldownMinutes: 10, confirmMinutes: 10, maxFailures: 3 };

export function thresholds(context = {}, settings = {}) {
  return {
    ...DEFAULTS,
    warnPct: context.warnPct ?? context.amberPct ?? DEFAULTS.warnPct,
    compactPct: context.compactPct ?? context.redPct ?? DEFAULTS.compactPct,
    forcePct: context.forcePct ?? DEFAULTS.forcePct,
    ...pick(settings, ['cooldownMinutes', 'confirmMinutes', 'maxFailures']),
  };
}
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] != null).map((k) => [k, o[k]]));

/** Is this agent in the autopilot's scope? (mode off → nobody) */
export function inScope(agent, cfg = {}) {
  if (!cfg || !['observe', 'on'].includes(cfg.mode)) return false;
  if (!agent?.workspaceId || agent.status === 'closed') return false;
  if (!['claude', 'codex'].includes(agent.vendor)) return false;
  if (agent.profile) return false;                                   // Codex --profile (local model): its own launcher
  if (Array.isArray(cfg.exclude) && cfg.exclude.includes(agent.name)) return false;
  if (Array.isArray(cfg.only) && cfg.only.length) return cfg.only.includes(agent.name);
  return true;
}

/**
 * One step of the state machine. Pure.
 *   prev   the stored record (or null): { phase, warnedAt, attemptAt, failures, forcedAlerted }
 *   g      the context gauge ({ pct, estimated }) or null
 *   fresh  ms of the newest state save (continuity mtime / owner comment), or 0
 * → { next: record|null, action: null|'warn'|'compact'|'resume'|'fail'|'giveup'|'reset', forced? }
 * 'compact' is only a wish: the caller tries it and calls attempted() only if it was typed.
 */
export function nextAction(prev, g, { fresh = 0, now = Date.now(), t = DEFAULTS } = {}) {
  if (!g || typeof g.pct !== 'number') return { next: prev, action: null };
  const pct = g.pct;
  const p = prev || { phase: 'ok' };
  const min = 60e3;

  if (p.phase === 'compacting') {
    if (g.estimated || pct < t.warnPct) return { next: { phase: 'ok', attemptAt: p.attemptAt }, action: 'resume', pct };
    if (now - p.attemptAt < t.confirmMinutes * min) return { next: p, action: null };
    const failures = (p.failures || 0) + 1;
    if (failures >= t.maxFailures) return { next: { ...p, phase: 'stopped', failures }, action: 'giveup', pct };
    return { next: { ...p, phase: 'warned', failures }, action: 'fail', pct };
  }
  // an estimate is the post-compaction size: below warn it ends the episode like a real reading
  if (pct < t.warnPct) return p.phase === 'warned' || p.phase === 'stopped' ? { next: { phase: 'ok', attemptAt: p.attemptAt }, action: 'reset', pct } : { next: p.phase === 'ok' ? prev : p, action: null };
  if (g.estimated) return { next: prev, action: null };
  if (p.phase === 'stopped') return { next: p, action: null };
  if (p.phase !== 'warned') return { next: { phase: 'warned', warnedAt: now, failures: 0, attemptAt: p.attemptAt || 0 }, action: 'warn', pct };

  const cooled = !p.attemptAt || now - p.attemptAt >= t.cooldownMinutes * min;
  if (!cooled) return { next: p, action: null };
  const isFresh = fresh > p.warnedAt;
  if (pct >= t.forcePct) return { next: p, action: 'compact', pct, forced: !isFresh };
  if (pct >= t.compactPct && isFresh) return { next: p, action: 'compact', pct, forced: false };
  return { next: p, action: null };
}

/** The record after /compact was actually typed into the pane. */
export const attempted = (rec, now = Date.now()) => ({ ...rec, phase: 'compacting', attemptAt: now });

/** The agent's continuity file (absolute) or null: settings map → agent field → resident default. */
export function continuityFile(agent, cfg = {}, { home = os.homedir() } = {}) {
  const repo = agent.repo ? agent.repo.replace(/^~(?=$|\/)/, home) : null;
  const rel = cfg.continuity?.[agent.name] || agent.continuity
    || (['resident', 'mission-control'].includes(agent.kind) ? '.claude/RESIDENT-STATE.md' : null);
  if (!rel) return null;
  const p = rel.replace(/^~(?=$|\/)/, home);
  if (path.isAbsolute(p)) return p;
  return repo ? path.join(repo, p) : null;
}

const shown = (file, home = os.homedir()) => (file ? file.replace(home, '~') : null);

export function messages({ agent, pct, file, focus, t = DEFAULTS, forced = false, staleMin = null }) {
  const where = file ? `update ${shown(file)} (a RESUME HERE block: where each task stands, the next step)` : `post your state as a comment on your task${focus ? ` (task.sh comment ${focus} "…")` : ''}`;
  return {
    warn: `context ${pct}% — finish the current step, then ${where} — the save itself is the signal (no reply needed). No need to stop: the board types /compact at your next idle moment once you are at ${t.compactPct}% (forced at ${t.forcePct}%).`,
    resume: `compacted by the board at ${pct}% — re-read ${file ? shown(file) : 'your task comments'}${file ? ' (RESUME HERE)' : ''} and continue${focus ? ` with #${focus}` : ''}.`,
    forcedMC: `context autopilot: forced /compact of ${agent.name} at ${pct}%${staleMin != null ? ` (state ${staleMin} min old, no save since the warn)` : ' (no state file)'}.`,
    giveup: `context autopilot: gave up on ${agent.name} at ${pct}% — ${t.maxFailures} /compact attempts showed no compaction. Please look at its pane.`,
  };
}

export async function readState(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } }

/**
 * One pass over the directory. deps:
 *   ctx            Map(workspaceId → gauge)
 *   cfg            SETTINGS.contextAutopilot
 *   t              thresholds()
 *   stateFile      path of data/context-state.json
 *   focusFor(a)    → task id | null
 *   commentAt(a, sinceMs) → ms of the owner's newest comment on a live task, or 0
 *   compact(a)     → { delivered } | { queued }   (deliverNow(a, '/compact'))
 *   tell(a, text, taskId)   mesh message to the agent (wake inside a busy session)
 *   tellMC(text, taskId)
 *   comment(taskId, text)   board comment on the focus task (no wake)
 *   event(kind, text)       ticker line
 * Returns { changed: [{ name, action }], phases: Map(workspaceId → phase) } for the pills.
 */
export async function runAutopilot(entries, deps) {
  const { ctx, cfg, t, stateFile, now = Date.now(), mtime = fileMtime } = deps;
  const observe = cfg?.mode === 'observe';
  const state = await readState(stateFile);
  const changed = [];
  const phases = new Map();
  let dirty = false;
  for (const a of entries) {
    if (!inScope(a, cfg)) continue;
    const ws = a.workspaceId;
    const g = ctx.get(ws);
    const prev = state[ws] || null;
    const file = continuityFile(a, cfg);
    const fm = file ? await mtime(file) : 0;
    const warnedAt = prev?.warnedAt || 0;
    const fresh = Math.max(fm, warnedAt ? await deps.commentAt(a, warnedAt) : 0);
    const r = nextAction(prev, g, { fresh, now, t });
    let next = r.next;
    if (r.action) {
      const focus = await deps.focusFor(a);
      const m = messages({ agent: a, pct: r.pct, file, focus, t, forced: r.forced, staleMin: fm ? Math.round((now - fm) / 60e3) : null });
      if (observe) {
        if (r.action !== 'reset') deps.event('sys', `context autopilot (observe): would ${r.action}${r.forced ? ' (forced)' : ''} ${a.name} at ${r.pct}%`);
        if (r.action === 'compact') next = attempted(next, now);   // walk the machine as if it ran
      } else if (r.action === 'warn') {
        await deps.tell(a, m.warn, focus);
        deps.event('sys', `context autopilot: ${a.name} at ${r.pct}% — asked to save state`);
        if (focus) await deps.comment(focus, `context ${r.pct}%: board asked ${a.name} to save state before compaction`);
      } else if (r.action === 'compact') {
        const res = await deps.compact(a);
        if (res?.delivered) {
          next = attempted(next, now);
          deps.event('sys', `context autopilot: /compact → ${a.name} at ${r.pct}%${r.forced ? ' (FORCED, state not saved)' : ''}`);
          if (focus) await deps.comment(focus, `compacted at ${r.pct}% by the board${r.forced ? ' (forced at the hard limit)' : ''}`);
          if (r.forced && !prev?.forcedAlerted) { await deps.tellMC(m.forcedMC, focus); next = { ...next, forcedAlerted: true }; }
        } else { r.action = null; }                                 // not READY: try again next poll, no attempt recorded
      } else if (r.action === 'resume') {
        await deps.tell(a, m.resume, focus);
        deps.event('ok', `context autopilot: ${a.name} compacted (now ${r.pct}%${g.estimated ? ' est' : ''}) — resume sent`);
      } else if (r.action === 'fail') {
        deps.event('bad', `context autopilot: /compact to ${a.name} showed no compaction after ${t.confirmMinutes} min (try ${next.failures}/${t.maxFailures})`);
      } else if (r.action === 'giveup') {
        deps.event('bad', `context autopilot: gave up on ${a.name} at ${r.pct}%`);
        await deps.tellMC(m.giveup, focus);
      }
      if (r.action) changed.push({ name: a.name, action: r.action, forced: !!r.forced, pct: r.pct });
    }
    if (JSON.stringify(next ?? null) !== JSON.stringify(prev)) {
      if (next && next.phase === 'ok' && !next.attemptAt) delete state[ws]; else if (next) state[ws] = { ...next, name: a.name };
      dirty = true;
    }
    const ph = (next || {}).phase;
    if (ph === 'warned') phases.set(ws, 'saving state');
    else if (ph === 'compacting') phases.set(ws, 'compacting');
    else if (ph === 'stopped') phases.set(ws, 'compact failed');
  }
  if (dirty) await writeJsonAtomic(stateFile, state);
  return { changed, phases };
}

async function fileMtime(file) { try { return (await stat(file)).mtimeMs; } catch { return 0; } }
