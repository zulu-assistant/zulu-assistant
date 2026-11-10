// Retention, report only: how big is data/ and what are its largest subdirectories?
//
// One line in the daily digest and a small object in /api/status (`dataUsage`).
// It measures; it never deletes, moves or archives anything. Sizes come from `du`
// in a child process (time-bounded, off the event loop), refreshed every
// `everyHours` (default 6).
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const fmt = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : b >= 1048576 ? `${Math.round(b / 1048576)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export const formatBytes = fmt;

const duDefault = (dir, timeoutMs) => new Promise((resolve) => {
  execFile('du', ['-sk', dir], { timeout: timeoutMs, killSignal: 'SIGKILL' }, (err, stdout) => {
    const kb = Number(String(stdout || '').trim().split(/\s+/)[0]);
    resolve(Number.isFinite(kb) && kb >= 0 && (!err || kb > 0) ? kb * 1024 : null);   // du exits 1 on an unreadable entry but still prints a total
  });
});

/** Measure `dir`: → { at, dir, totalBytes, top: [{ name, bytes }], unread: [names] } (top = largest subdirectories). */
export async function measure(dir, { top = 5, du = duDefault, timeoutMs = 20000, now = Date.now() } = {}) {
  let entries = [];
  try { entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()); } catch { return null; }
  const sizes = []; const unread = [];
  for (const e of entries) {
    const bytes = await du(path.join(dir, e.name), timeoutMs);
    if (bytes == null) unread.push(e.name); else sizes.push({ name: e.name, bytes });
  }
  const totalBytes = await du(dir, timeoutMs);
  sizes.sort((a, b) => b.bytes - a.bytes);
  return { at: now, dir: path.basename(dir), totalBytes, top: sizes.slice(0, top), unread };
}

/** The digest line(s) (pure). */
export function usageLines(u) {
  if (!u || u.totalBytes == null) return [];
  const parts = u.top.filter((t) => t.bytes > 0).map((t) => `${t.name} ${fmt(t.bytes)}`);
  return ['', `DATA: ${u.dir}/ is ${fmt(u.totalBytes)}${parts.length ? ` — largest: ${parts.join(', ')}` : ''} (report only; nothing is removed)`];
}

let cache = null; let running = false;
export const currentUsage = () => cache;
/** Refresh at most every `everyHours`; never throws; one measurement at a time. */
export async function maybeMeasure({ dir, everyHours = 6, now = Date.now(), ...opts } = {}) {
  if (running || (cache && now - cache.at < everyHours * 3600e3)) return cache;
  running = true;
  try { const u = await measure(dir, { ...opts, now }); if (u) cache = u; } catch { /* keep the last reading */ } finally { running = false; }
  return cache;
}
