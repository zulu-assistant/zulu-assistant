#!/usr/bin/env node
// Data/overlay migrations (#346). Run by scripts/upgrade.mjs after the code moves; safe to run by hand.
//   node scripts/migrate.mjs [--root <dir>] [--backup <dir>] [--dry-run]
// Migrations live in migrations/NNN-<name>.mjs and export { id, description, up(ctx) }; each must be
// idempotent. Applied ids are kept in data/schema-version.json { version, applied }.
// Rules:
//   - every write first copies the original into the backup dir (recorded in <backup>/migrated.json),
//     so a rollback restores exactly what changed;
//   - overlay/ is the owner's: a migration may only ADD a missing key with a default (ctx.addDefault),
//     never change or delete a value the owner set. ctx.writeJson refuses any overlay/ path.
import { readFile, writeFile, mkdir, readdir, copyFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readJsonFile(file, dflt = null) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return dflt; } }
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${file}.tmp`, file);
}
const isOverlay = (rel) => rel === 'overlay' || rel.startsWith('overlay/');

/** Migrations in id order from <dir>. */
export async function loadMigrations(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d{3}-[\w-]+\.mjs$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    const m = await import(pathToFileURL(path.join(dir, f)).href);
    if (!m.id || typeof m.up !== 'function') throw new Error(`${f}: a migration exports { id, description, up(ctx) }`);
    out.push({ file: f, id: m.id, description: m.description || '', up: m.up });
  }
  return out;
}

/** The ctx a migration gets. `log` collects one line per write. */
export function makeCtx({ root, backup, dryRun = false, log }) {
  const migrated = [];
  const keep = async (rel) => {
    if (!backup || migrated.includes(rel)) return;
    const src = path.join(root, rel);
    if (existsSync(src)) {
      const dst = path.join(backup, 'files', rel);
      await mkdir(path.dirname(dst), { recursive: true });
      await copyFile(src, dst);
    }
    migrated.push(rel);
    await atomicJson(path.join(backup, 'migrated.json'), migrated);
  };
  const ctx = {
    root,
    async readJson(rel, dflt = null) { return readJsonFile(path.join(root, rel), dflt); },
    /** Replace a JSON file outside overlay/ (a data/ schema change). */
    async writeJson(rel, value) {
      if (isOverlay(rel)) throw new Error(`refused: ${rel} is the owner's overlay; a migration may only addDefault there`);
      log.push(`wrote ${rel}`);
      if (dryRun) return;
      await keep(rel); await atomicJson(path.join(root, rel), value);
    },
    /** Create a text file outside overlay/ only when it is absent. → true when created. */
    async addFile(rel, text) {
      if (isOverlay(rel)) throw new Error(`refused: ${rel} is the owner's overlay; a migration may only addDefault there`);
      if (existsSync(path.join(root, rel))) return false;
      log.push(`created ${rel}`);
      if (dryRun) return true;
      await keep(rel);
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
      return true;
    },
    /** True when root/<rel> exists (a migration decides from this, it never lists a folder). */
    exists(rel) { return existsSync(path.join(root, rel)); },
    /** Add `key` (dotted path) with `value` to a JSON file only when it is absent. → true when added. */
    async addDefault(rel, key, value) {
      const file = path.join(root, rel);
      const doc = await readJsonFile(file, {});
      const parts = String(key).split('.');
      let o = doc;
      for (const p of parts.slice(0, -1)) {
        if (o[p] === undefined) o[p] = {};
        if (typeof o[p] !== 'object' || o[p] === null) return false;   // the owner made it something else: leave it
        o = o[p];
      }
      const last = parts.at(-1);
      if (Object.prototype.hasOwnProperty.call(o, last)) return false;
      o[last] = value;
      log.push(`added ${rel} ${key} = ${JSON.stringify(value)}`);
      if (dryRun) return true;
      await keep(rel); await atomicJson(file, doc);
      return true;
    },
    migrated,
  };
  return ctx;
}

/** Run every not-yet-applied migration. → { ran: [ids], log: [lines], version }. */
export async function migrate({ root = HERE, backup = null, dryRun = false, dir = path.join(root, 'migrations') } = {}) {
  const schemaRel = 'data/schema-version.json';
  const schema = await readJsonFile(path.join(root, schemaRel), { version: 0, applied: [] });
  const applied = new Set(schema.applied || []);
  const log = [];
  const ran = [];
  const ctx = makeCtx({ root, backup, dryRun, log });
  for (const m of await loadMigrations(dir)) {
    if (applied.has(m.id)) continue;
    await m.up(ctx);
    applied.add(m.id); ran.push(m.id);
  }
  const version = Math.max(Number(schema.version) || 0, ...[...applied].map((id) => Number(String(id).slice(0, 3)) || 0));
  if (ran.length && !dryRun) {
    if (backup && existsSync(path.join(root, schemaRel)) && !ctx.migrated.includes(schemaRel)) {
      await mkdir(path.join(backup, 'files', 'data'), { recursive: true });
      await copyFile(path.join(root, schemaRel), path.join(backup, 'files', schemaRel));
      ctx.migrated.push(schemaRel);
      await atomicJson(path.join(backup, 'migrated.json'), ctx.migrated);
    } else if (backup && !ctx.migrated.includes(schemaRel)) {
      ctx.migrated.push(schemaRel);                     // absent before: a rollback removes it
      await atomicJson(path.join(backup, 'migrated.json'), ctx.migrated);
    }
    await atomicJson(path.join(root, schemaRel), { version, applied: [...applied] });
  }
  return { ran, log, version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const r = await migrate({ root: opt('--root') || HERE, backup: opt('--backup'), dryRun: a.includes('--dry-run') })
    .catch((e) => { console.error(`migrate: ${e.message}`); process.exit(1); });
  console.log(r.ran.length ? `migrate: ran ${r.ran.join(', ')} → schema ${r.version}` : `migrate: nothing to run (schema ${r.version})`);
  for (const l of r.log) console.log(`  ${l}`);
}
