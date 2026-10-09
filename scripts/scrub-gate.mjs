#!/usr/bin/env node
// Scrub gate — the last line of defence before anything leaves the private repo.
//
//   node scripts/scrub-gate.mjs [dir]              scan git-tracked files (or every file when dir isn't a repo)
//   node scripts/scrub-gate.mjs [dir] --json       machine-readable hits
//   node scripts/scrub-gate.mjs [dir] --summary    counts per rule and per file only
//
// Exit 0 = clean, 1 = hits, 2 = usage/IO error. Two layers:
//   1. Denylist regexes (below) for owner identity, business names, infra refs,
//      phone/email, private paths and workspace UUIDs. A regex gate catches
//      PATTERNS, not meaning ("the owner's shop") — a human read is still needed.
//   2. gitleaks (secret scanner) when installed; CI installs it. Locally a
//      missing gitleaks is a warning, and `--require-gitleaks` makes it fatal.
// No waiver mechanism on purpose: the public tree must be clean by construction
// (overlay/ + examples/), not by exceptions.
import { readFile, readdir, lstat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve as resolveConfig } from '../src/config.mjs';

// The denylist is DATA, resolved overlay/publish/denylist.json → examples/publish/denylist.json
// (it names the owner's identity, so it must never ship in the public core itself).
// Each rule: { id, pattern, flags }. Keep patterns generic-safe: examples use
// the all-zero UUID, 555-01xx phone numbers and 100.101.102.103.
export async function loadRules(file = resolveConfig('publish/denylist.json')) {
  const doc = JSON.parse(await readFile(file, 'utf8'));
  return doc.rules.map((r) => ({ id: r.id, re: new RegExp(r.pattern, r.flags ?? 'g') }));
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|mp4|mov)$/i;

export async function listFiles(dir) {
  try {
    // tracked + untracked-but-not-ignored: a fresh publish into an existing
    // clone adds files git doesn't track yet, and those are the ones to catch
    const out = execFileSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean);
  } catch {
    const files = [];
    const walk = async (d) => {
      for (const e of await readdir(path.join(dir, d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.name === '.git' || e.name === 'node_modules') continue;
        if (e.isDirectory()) await walk(rel); else if (e.isFile()) files.push(rel);
      }
    };
    await walk('');
    return files;
  }
}

/** Scan text → [{rule, line, col, match}] */
export function scanText(text, RULES) {
  const hits = [];
  const lines = String(text).split('\n');
  lines.forEach((l, i) => {
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (const m of l.matchAll(r.re)) hits.push({ rule: r.id, line: i + 1, col: m.index + 1, match: m[0] });
    }
  });
  return hits;
}

export async function scanDir(dir, rules) {
  const RULES = rules || await loadRules();
  const out = [];
  for (const f of await listFiles(dir)) {
    if (BINARY.test(f)) continue;
    if (/(^|\/)publish\/denylist\.json$/.test(f)) continue;       // the rules file necessarily matches its own rules
    const p = path.join(dir, f);
    let st; try { st = await lstat(p); } catch { continue; }
    if (!st.isFile() || st.size > 2_000_000) continue;              // symlinks (compat links into overlay/) are never published
    const text = await readFile(p, 'utf8');
    const hits = scanText(text, RULES);
    // secrets-by-name are caught by gitleaks; also flag the file names themselves
    for (const r of RULES) { r.re.lastIndex = 0; if (r.re.test(f)) hits.push({ rule: r.id, line: 0, col: 0, match: `(path) ${f}` }); }
    for (const h of hits) out.push({ file: f, ...h });
  }
  return out;
}

function gitleaks(dir, required) {
  const has = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (has.error) {
    const msg = 'gitleaks not installed — secret scan skipped (brew install gitleaks; CI installs it)';
    if (required) { console.error(`FAIL ${msg}`); return false; }
    console.error(`warn ${msg}`); return true;
  }
  const r = spawnSync('gitleaks', ['detect', '--no-git', '--source', dir, '--redact', '--no-banner', '--verbose', '--exit-code', '1'], { encoding: 'utf8' });
  if (r.status === 0) { console.error('gitleaks: no secrets'); return true; }
  console.error(`gitleaks: FINDINGS\n${(r.stdout || '') + (r.stderr || '')}`);
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const dir = path.resolve(args.find((a) => !a.startsWith('--')) || '.');
  const hits = await scanDir(dir);
  const leaksOk = gitleaks(dir, args.includes('--require-gitleaks'));
  if (args.includes('--json')) console.log(JSON.stringify(hits, null, 1));
  else if (args.includes('--summary')) {
    const byRule = {}; const byFile = {};
    for (const h of hits) { byRule[h.rule] = (byRule[h.rule] || 0) + 1; byFile[h.file] = (byFile[h.file] || 0) + 1; }
    console.log(`${hits.length} hit(s) in ${Object.keys(byFile).length} file(s)`);
    for (const [r, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) console.log(`  ${r.padEnd(15)} ${n}`);
    for (const [f, n] of Object.entries(byFile).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${f}`);
  } else {
    for (const h of hits) console.log(`${h.file}:${h.line}:${h.col}  [${h.rule}]  ${h.match}`);
    console.log(`${hits.length} hit(s)`);
  }
  process.exit(hits.length || !leaksOk ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(2); });
