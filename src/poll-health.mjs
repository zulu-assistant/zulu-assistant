// Poll self-protection: stage isolation, the persisted digest day, process-level handlers.
//
// The poll is one loop that feeds everything. A stage that throws or stalls must not
// take alerting or the heartbeat with it, so each stage runs in its own try with its
// own timer, and /api/status shows the last duration and last error per stage
// (`poll.stages`). Nothing here decides anything; it measures and contains.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * A stage runner. `run(name, fn)` awaits fn inside its own try: an error is recorded
 * and logged, never rethrown, and the stage's duration is kept either way.
 * `view()` → { stages: { name: { ms, at, runs, failures, error, errorAt } }, slowest }.
 */
export function createStages({ now = () => Date.now(), log = (...a) => console.error(...a) } = {}) {
  const stages = {};
  async function run(name, fn) {
    const s = stages[name] || (stages[name] = { ms: null, at: null, runs: 0, failures: 0, error: null, errorAt: null });
    const t0 = now();
    try { return await fn(); }
    catch (e) {
      s.failures += 1;
      s.error = String(e?.message || e).slice(0, 200);
      s.errorAt = now();
      log(`[poll:${name}]`, e?.message || e);
      return undefined;
    } finally {
      s.ms = now() - t0;
      s.at = now();
      s.runs += 1;
    }
  }
  const view = () => {
    const slowest = Object.entries(stages).sort((a, b) => (b[1].ms || 0) - (a[1].ms || 0))[0];
    return { stages: JSON.parse(JSON.stringify(stages)), slowest: slowest ? { name: slowest[0], ms: slowest[1].ms } : null };
  };
  return { run, view };
}

// ---- the daily digest's day, persisted ---------------------------------------------
// Held in memory it was lost on every restart: a restart after the digest hour marked
// today as sent (a skipped briefing), and there was no record to stop a repeat either.

export async function readDigestState(file) {
  try { const d = JSON.parse(await readFile(file, 'utf8')); return d && typeof d === 'object' ? d : null; } catch { return null; }
}
export async function writeDigestState(file, state) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 1) + '\n');
  await rename(tmp, file);
}

export const DIGEST_MAX_TRIES = 3;
export const DIGEST_RETRY_MS = 10 * 60e3;

/**
 * Should the digest go out now? (pure)
 * state = { day, sent, tries, lastTryAt } from the file, or null when there is none.
 * - before the digest hour: no;
 * - no state file at all (first start with this code): today counts as handled when the
 *   board starts after the hour — the behaviour before the file existed, so the upgrade
 *   itself never sends a second briefing;
 * - today already sent: no (a restart never repeats it);
 * - today tried and failed: again after 10 min, at most 3 tries a day.
 */
export function digestDue({ now, hour, state, firstStart = false }) {
  const day = now.toDateString();
  if (now.getHours() < hour) return { due: false, day };
  if (!state) return firstStart ? { due: false, day, adopt: true } : { due: true, day };
  if (state.day !== day) return { due: true, day };
  if (state.sent) return { due: false, day };
  if ((state.tries || 0) >= DIGEST_MAX_TRIES) return { due: false, day };
  if (now.getTime() - (state.lastTryAt || 0) < DIGEST_RETRY_MS) return { due: false, day };
  return { due: true, day };
}

// ---- process-level handlers ----------------------------------------------------------

/**
 * A stray rejected promise must not take the board down (Node's default since 15 is to
 * exit), and an uncaught exception must leave a timestamped line before the process
 * goes. Rejections: log and stay up. Exceptions: log, then exit non-zero so the
 * supervisor restarts a process whose state can no longer be trusted.
 * Returns the two handlers (tests call them directly).
 */
export function installProcessHandlers({ proc = process, log = (...a) => console.error(...a), onRejection = () => {}, exit = (code) => proc.exit(code) } = {}) {
  const stamp = () => new Date().toISOString();
  const text = (e) => (e && e.stack) || String(e);
  const counts = { rejections: 0, lastRejection: null, lastRejectionAt: null };
  const rejection = (reason) => {
    counts.rejections += 1;
    counts.lastRejection = String(reason?.message || reason).slice(0, 200);
    counts.lastRejectionAt = Date.now();
    log(`${stamp()} [unhandledRejection] ${text(reason)}`);
    try { onRejection(reason); } catch { /* the handler itself must never throw */ }
  };
  const exception = (err, origin) => {
    log(`${stamp()} [uncaughtException] (${origin || 'uncaughtException'}) ${text(err)}`);
    exit(1);
  };
  proc.on('unhandledRejection', rejection);
  proc.on('uncaughtException', exception);
  return { rejection, exception, counts };
}
