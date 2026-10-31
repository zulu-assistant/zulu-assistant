#!/usr/bin/env node
// install.sh --brain: merge a hooks template into ~/.claude/settings.json.
//   node scripts/merge-hooks.mjs <template.json> <settings.json>
// Adds only hook entries whose command is not already present (idempotent),
// backs the settings file up first, and never removes or rewrites anything.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export function mergeHooks(settings, template) {
  const out = structuredClone(settings || {});
  let added = 0;
  for (const [event, groups] of Object.entries(template.hooks || {})) {
    out.hooks ??= {};
    out.hooks[event] ??= [];
    const have = new Set(out.hooks[event].flatMap((g) => (g.hooks || []).map((h) => `${g.matcher || ''}\u0000${h.command}`)));
    for (const g of groups) {
      const fresh = (g.hooks || []).filter((h) => !have.has(`${g.matcher || ''}\u0000${h.command}`));
      if (fresh.length) { out.hooks[event].push({ ...g, hooks: fresh }); added += fresh.length; }
    }
  }
  return { settings: out, added };
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
  const ri = args.indexOf('--remove');
  const needle = ri >= 0 ? args[ri + 1] : null;
  const [tpl, dst] = args.filter((a, i) => !a.startsWith('--') && !(ri >= 0 && i === ri + 1));
  if (needle ? !tpl : !tpl || !dst) { console.error('usage: merge-hooks.mjs <template.json> <settings.json> [--dry-run] | merge-hooks.mjs <settings.json> --remove <command-substring> [--dry-run]'); process.exit(2); }
  const file = needle ? tpl : dst;
  const raw = await readFile(file, 'utf8').catch(() => null);
  const { settings, added, removed } = needle ? removeHooks(raw ? JSON.parse(raw) : {}, needle) : mergeHooks(raw ? JSON.parse(raw) : {}, JSON.parse(await readFile(tpl, 'utf8')));
  const n = needle ? removed : added;
  if (!n) { console.log(`skip   ${needle ? 'no matching hooks in' : 'hooks already in'} ${file}`); return; }
  if (dry) { console.log(`would  ${needle ? 'remove' : 'merge'} ${n} hook(s) ${needle ? 'from' : 'into'} ${file}`); return; }
  if (raw) await copyFile(file, `${file}.bak-${Date.now()}`);
  await writeFile(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`done   ${n} hook(s) ${needle ? 'removed from' : 'merged into'} ${file}${raw ? ' (backup alongside)' : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exit(1); });
