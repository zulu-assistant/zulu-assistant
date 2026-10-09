// Weekly GitHub Actions cost reading, run by the board itself.
//
// SETTINGS.ciCostWatch = { task: <ledger id>, weekday: 1 (Mon), hour: 8, repos? } turns
// it on (absent = off). `repos` (e.g. ['this-repo', 'staging:ci.yml']) is passed to
// the reader as --repos so every repo expected to spend macOS minutes is counted and
// only genuinely unexplained minutes trip the "CI elsewhere" trigger. Once per week, at the first poll after the slot, the board
// runs `scripts/ci-cost.mjs --comment <task>`: the reading lands on the ledger
// task as a `board` comment, and a review trigger also wakes the task's owner +
// requester. The last run is persisted (data/ci-cost-state.json), so restarts
// never double-post and a Mac that was off on Monday morning catches up at its
// next poll (self-healing, like the selfheal runner). Failures retry at most hourly.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RETRY_MS = 3600e3;

/** Epoch ms of the most recent `weekday` `hour`:00 (local time) at or before `now`. */
export function lastWeeklySlot(now, weekday = 1, hour = 8) {
  const d = new Date(now);
  d.setHours(hour, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() - weekday + 7) % 7));
  if (d.getTime() > now.getTime()) d.setDate(d.getDate() - 7);
  return d.getTime();
}

/** Should a run start now? (pure) */
export function due({ now, cfg, state }) {
  if (!cfg?.task) return false;
  const slot = lastWeeklySlot(now, cfg.weekday ?? 1, cfg.hour ?? 8);
  if ((state.lastRun || 0) >= slot) return false;
  return now.getTime() - (state.lastAttempt || 0) >= RETRY_MS;
}

/** argv for the reader (pure). */
export function ciCostArgs(root, cfg) {
  return [path.join(root, 'scripts', 'ci-cost.mjs'), '--comment', String(cfg.task),
    ...(cfg.repos?.length ? ['--repos', cfg.repos.join(',')] : [])];
}

let busy = false;
export async function maybeCiCostWatch({ root, cfg, now = new Date(), record = async () => {}, run = execFile } = {}) {
  if (busy || !cfg?.task) return;
  const file = path.join(root, 'data', 'ci-cost-state.json');
  let state = {};
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch { /* first run */ }
  if (!due({ now, cfg, state })) return;
  busy = true;
  state.lastAttempt = now.getTime();
  await writeFile(file, JSON.stringify(state, null, 1)).catch(() => {});
  run(process.execPath, ciCostArgs(root, cfg),
    { cwd: root, timeout: 120000, env: process.env }, async (err, stdout, stderr) => {
      busy = false;
      const line = String(stdout || '').trim().split('\n').pop() || '';
      if (err && err.code !== 3) {                                     // 3 = review trigger (still a good reading)
        await record('sys', `ci cost: reading failed — ${String(stderr || err.message).trim().slice(0, 120)} (retry in 1h)`);
        return;
      }
      state.lastRun = now.getTime(); state.line = line;
      await writeFile(file, JSON.stringify(state, null, 1)).catch(() => {});
      await record('sys', line.slice(0, 160));
    });
}
