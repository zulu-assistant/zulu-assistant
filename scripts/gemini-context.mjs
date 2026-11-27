#!/usr/bin/env node
// Gemini CLI's project-file setting (#812): `context.fileName` in ~/.gemini/settings.json names the files Gemini
// loads from each folder, so a Gemini session reads the repo's shared AGENTS.md as well as its own GEMINI.md.
//
//   node scripts/gemini-context.mjs <wanted.json> [--apply] [--home <dir>]
//
// <wanted.json> holds `{ "context": { "fileName": [...] } }` (the vault's .scripts/gemini-global/settings.context.json).
// The key is ADDED only when the settings file has no `context.fileName`; one that is there is never rewritten (same
// = "up to date", different = "left alone"). Every other key of the file is kept as it is. Without --apply nothing is
// written. Prints one line: `would|done|skip|kept <text>`; exit 0, or 2 when the wanted file or the settings file
// cannot be read as JSON (nothing written).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, realpathSync, statSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

/** Pure: what to do with `current` settings (object or null when there is no file) given the wanted list. */
export function contextPlan(current, wanted) {
  if (!Array.isArray(wanted) || !wanted.length || !wanted.every((v) => typeof v === 'string' && v)) return { verdict: 'bad-wanted' };
  const ctx = current?.context;
  // a `context` that is there but not an object is someone's value: left alone, never replaced
  if (ctx !== undefined && (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx))) return { verdict: 'differs', have: ctx };
  const have = ctx?.fileName;
  if (have !== undefined) return sameList(have, wanted) ? { verdict: 'same' } : { verdict: 'differs', have };
  const next = { ...(current || {}) };
  next.context = { ...(ctx || {}), fileName: [...wanted] };
  return { verdict: 'add', next };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const hi = args.indexOf('--home');
  const home = hi >= 0 ? args[hi + 1] : os.homedir();
  const wantedFile = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--home');
  if (!wantedFile) { console.error('usage: gemini-context.mjs <wanted.json> [--apply] [--home <dir>]'); process.exit(2); }
  let wanted;
  try { wanted = JSON.parse(readFileSync(wantedFile, 'utf8'))?.context?.fileName; } catch { console.log(`skip cannot read ${wantedFile}`); process.exit(2); }
  const file = path.join(home, '.gemini', 'settings.json');
  let current = null;
  let raw = null;                                         // the text the plan was made from
  if (existsSync(file)) {
    try { raw = readFileSync(file, 'utf8'); current = JSON.parse(raw); } catch { console.log(`skip ${file} is not JSON — left alone`); process.exit(2); }
    if (!current || typeof current !== 'object' || Array.isArray(current)) { console.log(`skip ${file} is not a settings object — left alone`); process.exit(2); }
  }
  const p = contextPlan(current, wanted);
  if (p.verdict === 'bad-wanted') { console.log(`skip ${wantedFile} has no context.fileName list`); process.exit(2); }
  if (p.verdict === 'same') return console.log('skip gemini context.fileName up to date');
  if (p.verdict === 'differs') return console.log(`kept gemini context.fileName is ${JSON.stringify(p.have)} — left alone: ${file}`);
  if (!apply) return console.log(`would add gemini context.fileName ${JSON.stringify(wanted)} → ${file}`);
  mkdirSync(path.dirname(file), { recursive: true });
  // a link is written through to its target; a link to a missing file is refused (never replaced by a file)
  let isLink = false;
  try { isLink = lstatSync(file).isSymbolicLink(); } catch { /* no file */ }
  if (isLink && !existsSync(file)) { console.log(`skip ${file} is a link to a missing file — left alone`); process.exit(2); }
  const target = existsSync(file) ? realpathSync(file) : file;
  const existed = existsSync(target);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(p.next, null, 2)}\n`, existed ? { mode: statSync(target).mode & 0o777 } : {});
  if (existed) chmodSync(tmp, statSync(target).mode & 0o777);   // keep the file's mode (the umask may narrow it)
  // a file changed (or made) since it was read (Gemini saving a login, say) is never written over
  let now = null;
  try { now = readFileSync(target, 'utf8'); } catch { /* still absent */ }
  if (now !== raw) { unlinkSync(tmp); console.log(`skip ${file} changed while it was read — left alone, run again`); process.exit(2); }
  renameSync(tmp, target);
  console.log(`done added gemini context.fileName ${JSON.stringify(wanted)} → ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
