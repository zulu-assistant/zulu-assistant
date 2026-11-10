// Backup-age card (SETTINGS.backupWatch): is there a recent backup of the ledger?
//
// The scheduled state backup (scripts/backup.mjs backup --state, LaunchAgent template
// system/launchd/state-backup.plist.tmpl) writes one small archive a day into
// data/backups/. This card reads that folder's listing — names and mtimes only —
// and goes amber (warn; never red, never on the alert ladder) when the newest
// archive is older than `maxAgeHours` (default 36: one missed daily run plus slack)
// or when there is none. Any .tgz counts: a manual `zulu backup` is a backup too.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKUP_DIR = fileURLToPath(new URL('../data/backups', import.meta.url));

/** Newest *.tgz in `dir` → { name, mtimeMs, count } or null (no folder / no archive). */
export function newestArchiveSync(dir = BACKUP_DIR) {
  let names = [];
  try { names = readdirSync(dir).filter((f) => f.endsWith('.tgz')); } catch { return null; }
  let best = null;
  for (const name of names) {
    try {
      const { mtimeMs } = statSync(path.join(dir, name));
      if (!best || mtimeMs > best.mtimeMs) best = { name, mtimeMs };
    } catch { /* removed between listing and stat */ }
  }
  return best ? { ...best, count: names.length } : null;
}

const age = (ms) => (ms < 3600e3 ? `${Math.max(0, Math.round(ms / 60e3))} min` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.round(ms / 86400e3)} d`);

/** The card (pure). cfg null/absent = no card. */
export function backupCard(newest, cfg, now = Date.now()) {
  if (!cfg) return null;
  const maxH = Number(cfg.maxAgeHours) > 0 ? Number(cfg.maxAgeHours) : 36;
  const base = { label: 'backup:state', name: 'Ledger backup', domain: 'infra', schedule: `daily · amber after ${maxH} h`, logAvailable: false };
  if (!newest) return { ...base, status: 'warn', detail: 'no backup archive yet — run `zulu backup --state`, then install the daily job (scripts/state-backup-install.sh)' };
  const old = now - newest.mtimeMs;
  if (old > maxH * 3600e3) return { ...base, status: 'warn', detail: `newest backup is ${age(old)} old (${newest.name}) — the daily job is not running; check logs/state-backup.log (restore: docs/INSTALL.md, Rollback)` };
  return { ...base, status: 'ok', detail: `newest ${age(old)} ago · ${newest.count} archive(s) · ${newest.name}` };
}
