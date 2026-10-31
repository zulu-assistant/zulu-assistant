#!/usr/bin/env node
// zulu backup / zulu restore — your state (data/) and config (overlay/) in one tarball.
//   zulu backup [--out <file.tgz>] [--with-secrets] [--full]
//     lean by default: handoffs keep their text files up to 1 MB; --full keeps media and big exports too
//   zulu restore <file.tgz>            what would change (nothing is written)
//   zulu restore <file.tgz> --apply    safety backup of the current state first, then restore + board restart
// Always left out: the board's decision token, gate grants (both are recreated), earlier backups, and
// secrets (data/secrets.env, data/intake-token) unless --with-secrets. A restore checks every file's
// hash against the manifest and refuses a backup from a NEWER schema than this checkout.
import { readFile, writeFile, mkdir, mkdtemp, readdir, copyFile, rm, chmod, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ALWAYS_EXCLUDED = ['data/mesh-decision-token', 'data/guardrails/grants.json', 'data/backups', 'data/demo-tasks', 'data/demo-guardrails'];
export const SECRETS = ['data/secrets.env', 'data/intake-token'];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function walk(root, rel, out) {
  let entries = [];
  try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = path.posix.join(rel, e.name);
    if (e.isDirectory()) await walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}
const excluded = (rel, withSecrets) => ALWAYS_EXCLUDED.some((x) => rel === x || rel.startsWith(x + '/')) || (!withSecrets && SECRETS.includes(rel));

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

/** Write a backup tarball; returns { file, files, bytes, full, withSecrets, leftOut: { files, bytes, top } }. */
export async function backup({ root = ROOT, out = null, withSecrets = false, full = false, now = new Date() } = {}) {
  const files = []; const skipped = [];
  for (const rel of [...(await walk(root, 'data', [])), ...(await walk(root, 'overlay', []))].sort()) {
    if (excluded(rel, withSecrets)) continue;
    const size = (await stat(path.join(root, rel))).size;            // decide before reading a big file
    if (!full && !leanKeeps(rel, size)) { skipped.push({ path: rel, size }); continue; }
    const buf = await readFile(path.join(root, rel));
    files.push({ path: rel, sha256: sha(buf), size: buf.length });
  }
  // what lean left out, by folder (two levels under data/handoffs/), biggest first
  const byDir = new Map();
  for (const s of skipped) {
    const d = s.path.split('/').slice(0, 3).join('/');
    const e = byDir.get(d) || { dir: d, files: 0, bytes: 0 }; e.files++; e.bytes += s.size; byDir.set(d, e);
  }
  const leftOut = { files: skipped.length, bytes: skipped.reduce((n, s) => n + s.size, 0), top: [...byDir.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 5) };
  const manifest = { kind: 'zulu-backup', format: 1, created_at: now.toISOString(), schema: await schemaOf(root), ...gitInfo(root), withSecrets, full, leftOut, files };
  const stage = await mkdtemp(path.join(os.tmpdir(), 'zulu-backup-'));
  try {
    await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 1));
    const target = out || path.join(root, 'data', 'backups', `zulu-backup-${now.toISOString().replace(/[:.]/g, '-')}.tgz`);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // stage the exact files next to the manifest and tar one folder: the same on macOS (bsdtar) and Linux
    for (const f of files) {
      await mkdir(path.dirname(path.join(stage, f.path)), { recursive: true });
      await copyFile(path.join(root, f.path), path.join(stage, f.path));
    }
    const tops = ['manifest.json', ...['data', 'overlay'].filter((d) => files.some((f) => f.path.startsWith(d + '/')))];
    execFileSync('tar', ['-czf', target, '-C', stage, ...tops], { stdio: ['ignore', 'ignore', 'pipe'] });
    await chmod(target, 0o600);                            // it holds your ledger and config
    return { file: target, files: files.length, bytes: files.reduce((n, f) => n + f.size, 0), size: (await stat(target)).size, full, withSecrets, leftOut };
  } finally { await rm(stage, { recursive: true, force: true }); }
}

/**
 * Check a backup and say what restoring it would change. With apply: take a safety backup of the
 * current state, copy the backup's files over (files not in the backup are kept), migrate forward if
 * the backup is from an older schema, restart the board.
 * Schemas: newer than this checkout → refused; older → restored then migrated (refused while this
 * checkout has no migrations, scripts/migrate.mjs); equal → as-is.
 * Secrets in the backup are restored only with withSecrets (the same flag as on backup).
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
      if (SECRETS.includes(f.path) && !withSecrets) { changes.push({ path: f.path, action: 'secret-skipped' }); continue; }
      const cur = await readFile(path.join(root, f.path)).catch(() => null);
      changes.push({ path: f.path, action: !cur ? 'add' : sha(cur) === f.sha256 ? 'same' : 'change' });
    }
    if (!apply) return { ok: true, manifest, changes, older };
    // the safety copy covers everything this restore can overwrite: full if the backup is full
    const safety = await backup({ root, withSecrets, full: manifest.full === true, now, out: path.join(root, 'data', 'backups', `before-restore-${now.toISOString().replace(/[:.]/g, '-')}.tgz`) });
    for (const c of changes) {
      if (c.action === 'same' || c.action === 'secret-skipped') continue;
      await mkdir(path.dirname(path.join(root, c.path)), { recursive: true });
      await copyFile(path.join(stage, c.path), path.join(root, c.path));
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
    if (!prefix || process.platform !== 'darwin') return false;
    execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${prefix}.master-console`], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (f) => rest.includes(f);
  const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : null; };
  if (cmd === 'backup') {
    const r = await backup({ out: val('--out'), withSecrets: flag('--with-secrets'), full: flag('--full') });
    const mb = (b) => `${(b / 1048576).toFixed(b < 10485760 ? 1 : 0)} MB`;
    console.log(`done   ${r.full ? 'full' : 'lean'} backup: ${r.files} files (${mb(r.bytes)}) → ${mb(r.size)} tarball → ${r.file}`);
    console.log(`       secrets ${r.withSecrets ? 'INCLUDED (keep this file private)' : 'left out (add --with-secrets to include them)'}`);
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
  console.error('usage: zulu backup [--out file] [--with-secrets] | zulu restore <file> [--apply]'); process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exit(1); });
