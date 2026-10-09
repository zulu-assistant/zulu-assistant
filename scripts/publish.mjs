#!/usr/bin/env node
// Publish the public core of this repo into a LOCAL target directory.
//
//   node scripts/publish.mjs --check                 every tracked file classified exactly once (CI)
//   node scripts/publish.mjs <target-dir> [--dry-run] copy the `public` set, prune stale files, run the scrub gate
//
// Public-only files (README, LICENSE, docs/, the public CI, install packaging)
// live under the manifest's `publicRoot` (publish/public/) and are published at
// their path relative to it, so the public README can differ from this repo's
// README without either leaking into the other. A mapped path may shadow a
// PRIVATE file (README.md, .gitignore, ci.yml) but never a public one.
//
// Never creates a repository and never pushes: <target-dir> is a plain directory
// or an existing clone that a human reviews, commits and pushes. Files are copied
// verbatim (core is identical in both repos by construction; owner-specific
// config lives in overlay/, which is private). Symlinks are never published.
// The target's own .git/ and anything under it are left alone.
import { readFile, mkdir, copyFile, lstat, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scanDir } from './scrub-gate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 'a/**' | 'a/*.x' | exact → RegExp over a repo-relative path */
export function globRe(pat) {
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  if (pat.endsWith('/**')) return new RegExp(`^${esc(pat.slice(0, -3))}/.+$`);
  return new RegExp(`^${pat.split('*').map(esc).join('[^/]*')}$`);
}

export function classify(files, manifest) {
  const pub = manifest.public.map(globRe); const priv = manifest.private.map(globRe);
  const root = manifest.publicRoot ? `${manifest.publicRoot.replace(/\/+$/, '')}/` : null;
  const out = { public: [], private: [], unclassified: [], both: [], mapped: [], shadowed: [] };
  for (const f of files) {
    if (root && f.startsWith(root)) { out.mapped.push({ from: f, to: f.slice(root.length) }); continue; }
    const a = pub.some((r) => r.test(f)); const b = priv.some((r) => r.test(f));
    (a && b ? out.both : a ? out.public : b ? out.private : out.unclassified).push(f);
  }
  const pubSet = new Set(out.public);
  out.shadowed = out.mapped.filter((m) => pubSet.has(m.to)).map((m) => m.from);
  return out;
}

/** [src, dst] pairs of everything the public tree contains. */
export const publicPairs = (c) => [...c.public.map((f) => [f, f]), ...c.mapped.map((m) => [m.from, m.to])];

const tracked = () => execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

async function main() {
  const args = process.argv.slice(2);
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'publish/manifest.json'), 'utf8'));
  const c = classify(tracked(), manifest);
  const symlinks = [];
  const pairs = publicPairs(c);
  for (const [f] of pairs) if ((await lstat(path.join(ROOT, f)).catch(() => null))?.isSymbolicLink()) symlinks.push(f);
  const problems = [
    ...c.unclassified.map((f) => `unclassified (add to publish/manifest.json public or private): ${f}`),
    ...c.both.map((f) => `in BOTH public and private: ${f}`),
    ...symlinks.map((f) => `public file is a symlink (never published): ${f}`),
    ...c.shadowed.map((f) => `public-only file would overwrite a public core file: ${f}`),
  ];
  if (args.includes('--check')) {
    for (const p of problems) console.log(p);
    console.log(`${c.public.length} public · ${c.mapped.length} public-only · ${c.private.length} private · ${problems.length} problem(s)`);
    process.exit(problems.length ? 1 : 0);
  }
  const target = args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('usage: publish.mjs --check | publish.mjs <target-dir> [--dry-run]'); process.exit(2); }
  if (problems.length) { for (const p of problems) console.error(p); process.exit(1); }
  const dst = path.resolve(target);
  if (dst === path.resolve(ROOT) || dst.startsWith(path.resolve(ROOT) + path.sep)) { console.error('target must be outside this repo'); process.exit(2); }
  const dry = args.includes('--dry-run');
  // prune files the public set no longer has (never touches .git/)
  const existing = [];
  const walk = async (d) => {
    for (const e of await readdir(path.join(dst, d), { withFileTypes: true }).catch(() => [])) {
      if (e.name === '.git') continue;
      const rel = path.join(d, e.name);
      if (e.isDirectory()) await walk(rel); else existing.push(rel);
    }
  };
  await walk('');
  const want = new Set(pairs.map(([, d]) => d));
  const stale = existing.filter((f) => !want.has(f));
  let copied = 0;
  for (const [f, to] of pairs) {
    if (dry) continue;
    await mkdir(path.dirname(path.join(dst, to)), { recursive: true });
    await copyFile(path.join(ROOT, f), path.join(dst, to)); copied++;
  }
  if (!dry) for (const f of stale) await rm(path.join(dst, f));
  console.log(`${dry ? 'would copy' : 'copied'} ${pairs.length} file(s)${stale.length ? `, ${dry ? 'would remove' : 'removed'} ${stale.length} stale` : ''} → ${dst}`);
  if (dry) return;
  const hits = await scanDir(dst);
  for (const h of hits) console.log(`  ${h.file}:${h.line}  [${h.rule}]  ${h.match}`);
  console.log(hits.length ? `SCRUB GATE: ${hits.length} hit(s) — do NOT push` : 'scrub gate: clean (0 hits)');
  try { console.log(execFileSync('git', ['-C', dst, 'status', '--short'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) || '(no changes vs target HEAD)'); } catch { /* not a git clone */ }
  process.exit(hits.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(2); });
