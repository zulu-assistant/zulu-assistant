#!/usr/bin/env node
// install.sh --brain: merge a hooks template into ~/.claude/settings.json.
//   node scripts/merge-hooks.mjs <template.json> <settings.json>
// Adds only hook entries whose command is not already present (idempotent),
// backs the settings file up first, and never removes or rewrites anything.
// `--refresh` (the guardrails installer): entries that are already there get the
// template's other fields where they differ (an older install lacks `onFailure`).
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * Add the template's hook entries that are not there yet (same matcher and command = there).
 * `refresh`: an entry that IS there gets the template's other fields (timeout, onFailure, …) where
 * they differ. An install made before a field existed does not get it by running the installer
 * again otherwise. Only keys the template entry has are set; nothing is removed.
 * → { settings, added, refreshed: ['<event>: <field>', …] }
 */
export function mergeHooks(settings, template, { refresh = false } = {}) {
  const out = structuredClone(settings || {});
  let added = 0; const refreshed = [];
  for (const [event, groups] of Object.entries(template.hooks || {})) {
    out.hooks ??= {};
    out.hooks[event] ??= [];
    for (const g of groups) {
      const fresh = [];
      for (const h of g.hooks || []) {
        const mine = out.hooks[event].filter((x) => (x.matcher || '') === (g.matcher || '')).flatMap((x) => (x.hooks || []).filter((y) => y.command === h.command));
        if (!mine.length) { fresh.push(h); continue; }
        if (!refresh) continue;
        for (const y of mine) for (const [k, v] of Object.entries(h)) if (k !== 'command' && JSON.stringify(y[k]) !== JSON.stringify(v)) { y[k] = v; refreshed.push(`${event}: ${k}`); }
      }
      if (fresh.length) { out.hooks[event].push({ ...g, hooks: fresh }); added += fresh.length; }
    }
  }
  return { settings: out, added, refreshed };
}

/** Remove every hook entry whose command contains `needle` (and groups left empty). */
export function removeHooks(settings, needle) {
  const out = structuredClone(settings || {});
  let removed = 0;
  for (const [event, groups] of Object.entries(out.hooks || {})) {
    out.hooks[event] = groups.map((g) => {
      const keep = (g.hooks || []).filter((h) => !String(h.command || '').includes(needle));
      removed += (g.hooks || []).length - keep.length;
      return { ...g, hooks: keep };
    }).filter((g) => g.hooks.length);
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  return { settings: out, removed };
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const refresh = args.includes('--refresh');
  const ri = args.indexOf('--remove');
  const needle = ri >= 0 ? args[ri + 1] : null;
  const [tpl, dst] = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  if (needle ? !tpl : !tpl || !dst) { console.error('usage: merge-hooks.mjs <template.json> <settings.json> [--refresh] [--dry-run] | merge-hooks.mjs <settings.json> --remove <command-substring> [--dry-run]'); process.exit(2); }
  const file = needle ? tpl : dst;
  const raw = await readFile(file, 'utf8').catch(() => null);
  const { settings, added = 0, removed = 0, refreshed = [] } = needle ? removeHooks(raw ? JSON.parse(raw) : {}, needle) : mergeHooks(raw ? JSON.parse(raw) : {}, JSON.parse(await readFile(tpl, 'utf8')), { refresh });
  const n = needle ? removed : added;
  if (!n && !refreshed.length) { console.log(`skip   ${needle ? 'no matching hooks in' : 'hooks already in'} ${file}`); return; }
  const fields = refreshed.length ? `${refreshed.length} field(s) of the entries already there (${[...new Set(refreshed)].join(', ')})` : '';
  if (dry) {
    if (n) console.log(`would  ${needle ? 'remove' : 'merge'} ${n} hook(s) ${needle ? 'from' : 'into'} ${file}`);
    if (fields) console.log(`would  refresh ${fields} in ${file}`);
    return;
  }
  if (raw) await copyFile(file, `${file}.bak-${Date.now()}`);
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  if (n) console.log(`done   ${n} hook(s) ${needle ? 'removed from' : 'merged into'} ${file}${raw ? ' (backup alongside)' : ''}`);
  if (fields) console.log(`done   refreshed ${fields} in ${file}${raw ? ' (backup alongside)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exit(1); });
