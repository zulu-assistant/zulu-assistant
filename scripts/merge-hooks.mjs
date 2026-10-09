#!/usr/bin/env node
// install.sh --brain: merge a hooks template into ~/.claude/settings.json.
//   node scripts/merge-hooks.mjs <template.json> <settings.json>
// Adds only hook entries whose command is not already present (idempotent),
// backs the settings file up first, and never removes or rewrites anything.
import { readFile, writeFile, copyFile } from 'node:fs/promises';

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

async function main() {
  const [tpl, dst] = process.argv.slice(2);
  if (!tpl || !dst) { console.error('usage: merge-hooks.mjs <template.json> <settings.json>'); process.exit(2); }
  const template = JSON.parse(await readFile(tpl, 'utf8'));
  const raw = await readFile(dst, 'utf8').catch(() => null);
  const { settings, added } = mergeHooks(raw ? JSON.parse(raw) : {}, template);
  if (!added) { console.log(`skip   hooks already in ${dst}`); return; }
  if (raw) await copyFile(dst, `${dst}.bak-${Date.now()}`);
  await writeFile(dst, JSON.stringify(settings, null, 2) + '\n');
  console.log(`done   ${added} hook(s) merged into ${dst}${raw ? ' (backup alongside)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
