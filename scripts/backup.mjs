#!/usr/bin/env node
// zulu backup / zulu restore — your state (data/) and config (overlay/) in one tarball.
//   zulu backup [--out <file.tgz>] [--with-secrets] [--full]
//     lean by default: handoffs keep their text files up to 1 MB; --full keeps media and big exports too
//   zulu backup --state [--keep N]     the small daily one: the ledger + the board's state files + overlay/
//     (no handoffs, no logs, no file over 5 MB), named zulu-state-<time>.tgz; then keeps the newest N
//     (default 14) zulu-state-* archives and removes older ones. It never touches any other archive.
//   zulu restore <file.tgz>            what would change (nothing is written)
//   zulu restore <file.tgz> --apply    safety backup of the current state first, then restore + board restart
// Always left out: the board's decision token, gate grants (both are recreated) and earlier backups.
// Credentials are left out by a three-part rule, none of which is a list to extend:
//   1. a folder that holds a file named .nobackup is skipped whole, in EVERY kind of backup, with or
//      without --with-secrets (the phone relay's folder: a server's own databases and token files);
//   2. a file that gives nothing to group or other (mode 600) is a credential, unless it sits in one
//      of the state folders on the keep list (KEEP_DIRS), whose files are written owner-only but are state;
//   3. a file under 64 KB whose text looks like a credential (src/secret-text.mjs).
// --with-secrets includes 2 and 3 (and the named secrets files), never 1. The backup says what it
// left out and why. A restore checks every file's hash against the manifest, refuses a backup from
// a NEWER schema than this checkout, refuses to write into a .nobackup folder, puts each file's
// mode back, and brings credentials back only with --with-secrets.
import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile, rm, chmod, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isOwnerOnly, makePrivate } from '../src/private-file.mjs';
import { containsSecret } from '../src/secret-text.mjs';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ALWAYS_EXCLUDED = ['data/mesh-decision-token', 'data/guardrails/grants.json', 'data/backups', 'data/demo-tasks', 'data/demo-guardrails'];
export const SECRETS = ['data/secrets.env', 'data/intake-token', 'data/cmux-socket-password'];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

export const MARKER = '.nobackup';
// State folders whose files the board writes owner-only: kept despite part 2 of the rule. Forgetting
// to extend this list leaves state OUT of a backup; it can never put a credential in.
export const KEEP_DIRS = ['data/tasks/', 'data/guardrails/', 'data/chat-intake/', 'data/github-intake/'];
export const CONTENT_MAX_BYTES = 64 * 1024;

// Folders that hold another program's files (a relay server's databases and token files, TLS keys):
// their modes are not the board's to control, so they carry the marker. The backup adds a missing
// marker before it walks (an install that set the folder up before the marker existed), and
// migration 002 does the same at upgrade. Any other folder gets the same treatment from its owner
// with one `touch <folder>/.nobackup`.
export const MARKED_DIRS = ['data/relay', 'data/tls'];
export const MARKER_TEXT = 'This folder is never included in a zulu backup, and a restore never writes into it.\n';
/** Put the marker into each MARKED_DIRS folder that exists without one. → the folders marked now. */
export async function ensureMarkers(root) {
  const added = [];
  for (const d of MARKED_DIRS) {
    const dir = path.join(root, d);
    if (!existsSync(dir) || existsSync(path.join(dir, MARKER))) continue;
    try { await writeFile(path.join(dir, MARKER), MARKER_TEXT); added.push(d); } catch { /* read-only folder: the mode rule still applies */ }
  }
  return added;
}

/** Files under root/rel. A folder holding a MARKER file is not entered: its path goes to `markers`. */
async function walk(root, rel, out, markers) {
  let entries = [];
  try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.name === MARKER)) { markers.push(rel); return out; }
  for (const e of entries) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) await walk(root, r, out, markers);
    else if (e.isFile()) out.push(r);
  }
  return out;
}
const excluded = (rel) => ALWAYS_EXCLUDED.some((x) => rel === x || rel.startsWith(x + '/'));
const kept = (rel) => KEEP_DIRS.some((d) => rel.startsWith(d));
/** Why a file counts as a credential by its name or mode (parts "named" and 2 of the rule), or null. */
export const credentialByMode = (rel, mode) => (SECRETS.includes(rel) ? 'named' : isOwnerOnly(mode) && !kept(rel) ? 'mode' : null);
/** Part 3: a small file whose text looks like a credential. */
export const credentialByContent = (buf) => buf.length < CONTENT_MAX_BYTES && !buf.includes(0) && containsSecret(buf.toString('utf8'));
/** True when root/<rel> sits in (or under) a folder that holds a MARKER file. */
export function underMarker(root, rel) {
  const parts = rel.split('/').slice(0, -1);
  for (let i = parts.length; i > 0; i--) if (existsSync(path.join(root, ...parts.slice(0, i), MARKER))) return parts.slice(0, i).join('/');
  return null;
}

/** The schema this checkout's data is at (data/schema-version.json; absent = 0, before schemas). */
export async function schemaOf(root) {
  try { return Number(JSON.parse(await readFile(path.join(root, 'data', 'schema-version.json'), 'utf8')).version) || 0; } catch { return 0; }
}
function gitInfo(root) {
  const g = (args) => { try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };
  return { version: g(['describe', '--tags', '--always']), commit: g(['rev-parse', '--short', 'HEAD']) };
}

// Lean (the default): handoffs keep only their text, each file at most 1 MB — reports, plans, notes.
// Media, archives and big exports there are left out (and listed); --full keeps everything.
export const LEAN_TEXT = /\.(md|markdown|txt|json|jsonl|csv|tsv|mjs|cjs|js|ts|py|sh|rb|yml|yaml|toml|html|css|ics|xml|log|sql|diff|patch|tmpl)$/i;
export const LEAN_MAX_BYTES = 1024 * 1024;
const leanKeeps = (rel, size) => !rel.startsWith('data/handoffs/') || (size <= LEAN_MAX_BYTES && (LEAN_TEXT.test(rel) || !path.posix.basename(rel).includes('.')));

// State (the scheduled daily backup): what a lost disk would cost most — the ledger and the board's
// own state — and nothing bulky. data/tasks/**, the files directly in data/, the small state folders
// below, overlay/**. Never handoffs, logs, the relay's databases or a file over STATE_MAX_BYTES.
// Credentials are left out by the three-part rule above (this job keeps 14 copies and has no
// with-secrets form). The named state folders are kept whole: the chat intake writes its cursor and
// thread map owner-only, and those are state, not credentials.
export const STATE_DIRS = KEEP_DIRS;
export const STATE_MAX_BYTES = 5 * 1024 * 1024;
export const STATE_PREFIX = 'zulu-state-';
export const STATE_KEEP = 14;
const stateKeeps = (rel, size) => size <= STATE_MAX_BYTES && !/\.(log|tmp)$/i.test(rel)
  && (rel.startsWith('overlay/') || STATE_DIRS.some((d) => rel.startsWith(d)) || /^data\/[^/]+$/.test(rel));

/**
 * Keep the newest `keep` archives THIS job made (zulu-state-*.tgz, by the time in the name) and
 * remove the rest. Anything else in the folder — manual backups, before-restore copies, other
 * files — is never listed, read or removed. → { kept: [names], removed: [names] }
 */
export async function pruneState({ dir, keep = STATE_KEEP } = {}) {
  const n = Math.max(1, Number(keep) || STATE_KEEP);                  // never prune to nothing
  let names = [];
  try { names = await readdir(dir); } catch { return { kept: [], removed: [] }; }
  const mine = names.filter((f) => /^zulu-state-\d{4}-\d{2}-\d{2}T[\d-]+Z\.tgz$/.test(f)).sort().reverse();
  const removed = [];
  for (const f of mine.slice(n)) { try { await unlink(path.join(dir, f)); removed.push(f); } catch { /* gone already */ } }
  return { kept: mine.slice(0, n), removed };
}

/**
 * Write a backup tarball; returns { file, files, bytes, full, withSecrets, leftOut: { files, bytes, top },
 * markers: [folders skipped whole], credentials: [{ path, why: 'named'|'mode'|'content' }] } where
 * `credentials` are the files left out (without withSecrets) as credentials.
 */
export async function backup({ root = ROOT, out = null, withSecrets = false, full = false, state = false, now = new Date() } = {}) {
  const files = []; const skipped = []; const markers = []; const credentials = [];
  if (state) withSecrets = false;                                    // the daily job has no with-secrets form
  await ensureMarkers(root);
  for (const rel of [...(await walk(root, 'data', [], markers)), ...(await walk(root, 'overlay', [], markers))].sort()) {
    if (excluded(rel)) continue;
    const { size, mode } = await stat(path.join(root, rel));         // decide before reading a big file
    if (state) { if (!stateKeeps(rel, size)) continue; }             // what state leaves out is by design, not listed
    else if (!full && !leanKeeps(rel, size)) { skipped.push({ path: rel, size }); continue; }
    let why = credentialByMode(rel, mode);
    if (why && !withSecrets) { credentials.push({ path: rel, why }); continue; }   // not read at all
    const buf = await readFile(path.join(root, rel));
    if (!why && credentialByContent(buf)) why = 'content';
    if (why && !withSecrets) { credentials.push({ path: rel, why }); continue; }
    files.push({ path: rel, sha256: sha(buf), size: buf.length, mode: mode & 0o777, ...(why ? { secret: why } : {}) });
  }
  // what lean left out, by folder (two levels under data/handoffs/), biggest first
  const byDir = new Map();
  for (const s of skipped) {
    const d = s.path.split('/').slice(0, 3).join('/');
    const e = byDir.get(d) || { dir: d, files: 0, bytes: 0 }; e.files++; e.bytes += s.size; byDir.set(d, e);
  }
  const leftOut = { files: skipped.length, bytes: skipped.reduce((n, s) => n + s.size, 0), top: [...byDir.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
  const manifest = { kind: 'zulu-backup', format: 1, created_at: now.toISOString(), schema: await schemaOf(root), ...gitInfo(root), withSecrets, full, ...(state ? { state: true } : {}), leftOut, skipped: { markers, credentials: credentials.length }, files };
  const stage = await mkdtemp(path.join(os.tmpdir(), 'zulu-backup-'));
  try {
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const target = out || path.join(root, 'data', 'backups', `${state ? STATE_PREFIX : 'zulu-backup-'}${now.toISOString().replace(/[:.]/g, '-')}.tgz`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // stage the exact files next to the manifest and tar one folder: the same on macOS (bsdtar) and Linux
    for (const f of files) {
      await mkdir(path.dirname(path.join(stage, f.path)), { recursive: true });
      await copyFile(path.join(root, f.path), path.join(stage, f.path));
    }
    const tops = ['manifest.json', ...['data', 'overlay'].filter((d) => files.some((f) => f.path.startsWith(d + '/')))];
    execFileSync('tar', ['-czf', target, '-C', stage, ...tops], { stdio: ['ignore', 'ignore', 'pipe'] });
    await makePrivate(target);                             // it holds your ledger and config
    return { file: target, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), size: (await stat(target)).size, full, state, withSecrets, leftOut, markers, credentials };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/**
 * Check a backup and say what restoring it would change. With apply: take a safety backup of the
 * current state, copy the backup's files over (files not in the backup are kept), migrate forward if
 * the backup is from an older schema, restart the board.
 * Schemas: newer than this checkout → refused; older → restored then migrated (refused while this
 * checkout has no migrations, scripts/migrate.mjs); equal → as-is.
 * Credentials in the backup (the named secrets files, and files the backup marked by mode or content;
 * for an archive from before the mode column, the staged file's own mode) are restored only with
 * withSecrets (the same flag as on backup). A path under a .nobackup folder, here or in the archive,
 * refuses the whole restore. Each restored file gets the mode the manifest recorded.
 * → { ok, reason?, manifest, changes: [{path, action: 'add'|'change'|'same'|'secret-skipped'}], safety?, migrated? }
 */
export async function restore({ root = ROOT, file, apply = false, withSecrets = false, restart = defaultRestart, migrate = defaultMigrate, now = new Date() } = {}) {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'zulu-restore-'));
  try {
    execFileSync('tar', ['-xzf', file, '-C', stage], { stdio: ['ignore', 'ignore', 'pipe'] });
    const manifest = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
    if (manifest.kind !== 'zulu-backup') return { ok: false, reason: 'not a zulu backup (no manifest)' };
    const here = await schemaOf(root);
    const from = Number(manifest.schema) || 0;
    if (from > here) return { ok: false, manifest, reason: `the backup is from a newer schema (${from}) than this checkout (${here}) — upgrade first (zulu upgrade), then restore` };
    const older = from < here;
    if (older && !(await migrate.available(root))) return { ok: false, manifest, reason: `the backup is from an older schema (${from}) than this checkout (${here}), and this checkout has no migrations to bring it forward` };
    const changes = [];
    for (const f of manifest.files) {
      if (!/^(data|overlay)\//.test(f.path) || f.path.includes('..')) return { ok: false, manifest, reason: `unexpected path in backup: ${f.path}` };
      const buf = await readFile(path.join(stage, f.path)).catch(() => null);
      if (!buf || sha(buf) !== f.sha256) return { ok: false, manifest, reason: `file does not match the manifest: ${f.path}` };
      const marked = path.posix.basename(f.path) === MARKER ? path.posix.dirname(f.path) : underMarker(root, f.path) || underMarker(stage, f.path);
      if (marked) return { ok: false, manifest, reason: `the backup has a file for a folder that is never backed up or restored (${marked} holds ${MARKER}): ${f.path}` };
      const mode = Number.isInteger(f.mode) ? f.mode & 0o777 : (await stat(path.join(stage, f.path))).mode & 0o777;
      if ((f.secret || credentialByMode(f.path, mode)) && !withSecrets) { changes.push({ path: f.path, action: 'secret-skipped' }); continue; }
      const cur = await readFile(path.join(root, f.path)).catch(() => null);
      changes.push({ path: f.path, action: !cur ? 'add' : sha(cur) === f.sha256 ? 'same' : 'change', mode });
    }
    if (!apply) return { ok: true, manifest, changes, older };
    // the safety copy covers everything this restore can overwrite: full if the backup is full
    const safety = await backup({ root, withSecrets, full: manifest.full === true, now, out: path.join(root, 'data', 'backups', `before-restore-${now.toISOString().replace(/[:.]/g, '-')}.tgz`) });
    for (const c of changes) {
      if (c.action === 'secret-skipped') continue;
      if (c.action !== 'same') {
        await mkdir(path.dirname(path.join(root, c.path)), { recursive: true });
        await copyFile(path.join(stage, c.path), path.join(root, c.path));
      }
      await chmod(path.join(root, c.path), c.mode);          // the mode the backup recorded, also on an unchanged file
    }
    const migrated = older ? await migrate.run(root) : null;
    const restarted = await restart(root);
    return { ok: true, manifest, changes, older, migrated, safety: safety.file, restarted };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

// Migrations ship with the one-click upgrade (scripts/migrate.mjs runs every pending one, in order).
const defaultMigrate = {
  async available(root) { try { await readFile(path.join(root, 'scripts', 'migrate.mjs')); return true; } catch { return false; } },
  async run(root) { return execFileSync(process.execPath, [path.join(root, 'scripts', 'migrate.mjs')], { cwd: root, encoding: 'utf8' }).trim(); },
};

async function defaultRestart(root) {
  // the board caches the ledger in memory: restart it so it reads the restored files
  try {
    const env = await readFile(path.join(root, 'overlay', 'config', 'zulu.env'), 'utf8').catch(() => readFile(path.join(root, 'examples', 'config', 'zulu.env'), 'utf8'));
    const prefix = /MC_LABEL_PREFIX="?\$\{MC_LABEL_PREFIX:-([^}"]+)\}/.exec(env)?.[1] || /MC_LABEL_PREFIX="?([^"\n]+)/.exec(env)?.[1];
    if (!prefix || process.platform !== 'darwin' || process.env.ZULU_NO_LAUNCHD) return false;
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${prefix}.master-console`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

const WHY = { named: 'a secrets file', mode: 'only its owner can read it', content: 'its text looks like a credential' };
/** What the backup left out as credentials and why, grouped by folder; and the folders never backed up (pure). */
export function leftOutLines({ credentials = [], markers = [] } = {}, max = 8) {
  const lines = [];
  if (credentials.length) {
    const groups = new Map();
    for (const c of credentials) {
      const parts = c.path.split('/');
      const dir = parts.length > 3 ? parts.slice(0, 3).join('/') + '/' : c.path;
      const k = `${dir}\u0000${c.why}`;
      const g = groups.get(k) || { dir, why: c.why, n: 0 }; g.n++; groups.set(k, g);
    }
    const all = [...groups.values()].sort((a, b) => b.n - a.n);
    lines.push(`left out as credentials: ${credentials.length} file${credentials.length === 1 ? '' : 's'}`);
    for (const g of all.slice(0, max)) lines.push(`  ${g.dir}${g.n > 1 || g.dir.endsWith('/') ? ` (${g.n})` : ''}: ${WHY[g.why] || g.why}`);
    if (all.length > max) lines.push(`  and ${all.length - max} more folders`);
  }
  for (const m of markers) lines.push(`never backed up: ${m}/ (it holds ${MARKER}; --with-secrets does not include it)`);
  return lines;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (f) => rest.includes(f);
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === 'backup' && flag('--state')) {
    // the scheduled one (system/launchd/state-backup.plist.tmpl): quiet, one line, prune after a good write
    const r = await backup({ state: true });
    const p = await pruneState({ dir: path.dirname(r.file), keep: val('--keep') || STATE_KEEP });
    console.log(`${new Date().toISOString()} state backup: ${r.files} files → ${(r.size / 1048576).toFixed(1)} MB → ${r.file} · kept ${p.kept.length}, removed ${p.removed.length}`
      + (r.credentials.length ? ` · left out as credentials: ${r.credentials.map((c) => c.path).slice(0, 5).join(', ')}${r.credentials.length > 5 ? ` and ${r.credentials.length - 5} more` : ''}` : ''));
    return;
  }
  if (cmd === 'backup') {
    const r = await backup({ out: val('--out'), withSecrets: flag('--with-secrets'), full: flag('--full') });
    const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
    console.log(`done   ${r.full ? 'full' : 'lean'} backup: ${r.files} files (${mb(r.bytes)}) → ${mb(r.size)} tarball → ${r.file}`);
    console.log(`       secrets ${r.withSecrets ? 'INCLUDED (keep this file private)' : 'left out (add --with-secrets to include them)'}`);
    for (const l of leftOutLines(r)) console.log(`       ${l}`);
    if (r.leftOut.files) {
      console.log(`       left out: ${r.leftOut.files} handoff files (${mb(r.leftOut.bytes)}) — media, archives, files over 1 MB; add --full to keep them`);
      for (const d of r.leftOut.top) console.log(`         ${mb(d.bytes).padStart(8)}  ${d.files} files  ${d.dir}`);
    }
    return;
  }
  if (cmd === 'restore') {
    const file = rest.find((a) => !a.startsWith('--'));
    if (!file) { console.error('usage: zulu restore <backup.tgz> [--apply] [--with-secrets]'); process.exit(2); }
    const r = await restore({ file: path.resolve(file), apply: flag('--apply'), withSecrets: flag('--with-secrets') });
    if (!r.ok) { console.error(`refused: ${r.reason}`); process.exit(1); }
    const n = (a) => r.changes.filter((c) => c.action === a).length;
    console.log(`backup ${r.manifest.created_at} · ${r.manifest.version || '?'} · schema ${r.manifest.schema} · ${r.manifest.files.length} files: ${n('add')} new, ${n('change')} changed, ${n('same')} unchanged${n('secret-skipped') ? `, ${n('secret-skipped')} secret(s) kept as they are (add --with-secrets to restore them)` : ''}`);
    for (const c of r.changes.filter((x) => x.action !== 'same')) console.log(`  ${c.action.padEnd(6)} ${c.path}`);
    if (r.older) console.log('  the backup is from an older schema: it will be migrated forward after restoring');
    if (!flag('--apply')) { console.log('(nothing written — add --apply to restore; a safety backup is taken first)'); return; }
    console.log(`done   restored${r.migrated != null ? ' + migrated' : ''} · safety backup: ${r.safety} · board ${r.restarted ? 'restarted' : 'NOT restarted — restart it yourself'}`);
    return;
  }
  console.error('usage: zulu backup [--out file] [--with-secrets] [--full] | zulu backup --state [--keep N] | zulu restore <file> [--apply]'); process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exit(1); });
