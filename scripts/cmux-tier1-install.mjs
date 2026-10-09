#!/usr/bin/env node
// Install the cmux Tier 1 files from this repo into ~/.config/cmux/.
//
//   node scripts/cmux-tier1-install.mjs            dry run: what would be written/backed up
//   node scripts/cmux-tier1-install.mjs --apply    back up any existing target (.bak-<ts>),
//                                                  copy, `cmux sidebar validate phosphor`
//   node scripts/cmux-tier1-install.mjs --revert   restore backups / remove files we installed
//
// Sources (canonical, versioned): system/cmux/dock.json, system/cmux/sidebars/phosphor.js.
// Rendered on the way: __REPO__ → this checkout ($HOME-relative), __BRAND__ →
// the registry's SETTINGS.brand (upper-case), so the same files serve any install.
// This does NOT switch the active sidebar or open the Dock — that stays the owner's
// click. The install record lives in
// data/cmux-tier1-install.json so --revert knows exactly what it did.
import { readFile, writeFile, copyFile, mkdir, rm, access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(os.homedir(), '.config', 'cmux');
const RECORD = path.join(ROOT, 'data', 'cmux-tier1-install.json');
export const FILES = [
  { src: 'system/cmux/dock.json', dest: path.join(CFG, 'dock.json') },
  { src: 'system/cmux/sidebars/phosphor.js', dest: path.join(CFG, 'sidebars', 'phosphor.js') },
];

const exists = (p) => access(p).then(() => true, () => false);
export function render(text, { root = ROOT, home = os.homedir(), brand = 'Zulu Assistant' } = {}) {
  const repo = root.replace(/\/+$/, '');
  const rel = repo === home || repo.startsWith(home + '/') ? `$HOME${repo.slice(home.length)}` : repo;
  return text.replaceAll('__REPO__', rel).replaceAll('__BRAND__', String(brand).toUpperCase());
}
const brand = async () => (await import('../src/config.mjs')).SETTINGS.brand || 'Zulu Assistant';
const cmux = (...args) => execFileSync('cmux', args, {
  encoding: 'utf8',
  env: { ...process.env, CMUX_QUIET: '1',
    CMUX_SOCKET_PASSWORD: String(execFileSync('cat', [path.join(ROOT, 'data', 'cmux-socket-password')])).trim() },
});

async function main() {
  const flag = process.argv[2];
  if (flag === '--revert') {
    const rec = JSON.parse(await readFile(RECORD, 'utf8').catch(() => '[]'));
    if (!rec.length) return console.log('nothing recorded to revert');
    for (const r of rec) {
      if (r.backup) { await copyFile(r.backup, r.dest); console.log(`restored ${r.dest} from ${r.backup}`); }
      else { await rm(r.dest, { force: true }); console.log(`removed ${r.dest}`); }
    }
    await rm(RECORD, { force: true });
    try { cmux('sidebar', 'reload'); } catch { /* sidebar list refresh is best-effort */ }
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rec = [];
  for (const f of FILES) {
    const src = path.join(ROOT, f.src);
    const had = await exists(f.dest);
    const want = render(await readFile(src, 'utf8'), { brand: await brand() });
    const same = had && (await readFile(f.dest, 'utf8')) === want;
    if (same) { console.log(`up to date: ${f.dest}`); continue; }
    if (flag !== '--apply') { console.log(`would ${had ? 'back up + replace' : 'create'} ${f.dest}`); continue; }
    await mkdir(path.dirname(f.dest), { recursive: true });
    let backup = null;
    if (had) { backup = `${f.dest}.bak-${ts}`; await copyFile(f.dest, backup); }
    await writeFile(f.dest, want);
    rec.push({ dest: f.dest, backup });
    console.log(`${had ? `replaced (backup ${backup})` : 'created'} ${f.dest}`);
  }
  if (flag !== '--apply') return;
  if (rec.length) {
    const prev = JSON.parse(await readFile(RECORD, 'utf8').catch(() => '[]'));
    await writeFile(RECORD, JSON.stringify([...prev, ...rec], null, 2));
  }
  console.log(cmux('sidebar', 'validate', 'phosphor').trim());
  console.log('revert: node scripts/cmux-tier1-install.mjs --revert');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stdout || e.message); process.exit(1); });
}
