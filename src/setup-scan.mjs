// What `zulu setup` offers to watch: a read-only scan of this Mac for the
// person's own LaunchAgents, Docker containers, crontab lines and git repos.
// Pure parsers are exported for tests; the scanners only read.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { run } from './setup.mjs';

const HOME = process.env.HOME || '';

/** "1,3-5" | "all" | "none" | "" → zero-based indexes into a list of n. */
export function parseSelection(input, n) {
  const s = String(input || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'n') return [];
  if (s === 'all' || s === 'a' || s === '*') return [...Array(n).keys()];
  const out = new Set();
  for (const part of s.split(/[\s,]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) throw new Error(`can't read "${part}" — use numbers like 1,3-5, or all / none`);
    const a = Number(m[1]), b = Number(m[2] || m[1]);
    for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) if (i >= 1 && i <= n) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

/** com.acme.billing-sync → "Billing sync"; versions dropped; a short last part keeps its parent for context */
export function nameFromLabel(label) {
  const parts = String(label).replace(/[-_.]?v?\d+(\.\d+)*$/i, '').split('.').filter((p) => p && !/^\d+$/.test(p));
  let words = parts.pop() || String(label);
  if (words.length < 6 && parts.length > 1) words = `${parts.pop()} ${words}`;
  words = words.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Labels never offered: Apple's own, package managers' service shims, and this product's own agents. */
export function skipLabel(label, prefix) {
  return /^com\.apple\./.test(label) || (prefix && label.startsWith(`${prefix}.`)) || /^homebrew\.mxcl\./.test(label);
}

/** crontab -l text → [{ id, schedule, command, match }] (comments, env lines and @reboot skipped) */
export function cronEntries(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^[A-Z_][A-Z0-9_]*=/.test(line) || line.startsWith('@')) continue;
    const f = line.split(/\s+/);
    if (f.length < 6) continue;
    const schedule = f.slice(0, 5).join(' ');
    const command = f.slice(5).join(' ');
    const script = (command.match(/[\w.\-/~]+\.(?:sh|py|mjs|js|rb|pl)\b/) || [command.split(/\s+/)[0]])[0];
    const base = path.basename(script).replace(/\.[^.]+$/, '') || 'cron';
    out.push({ id: base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `cron-${out.length + 1}`, schedule, command, match: path.basename(script) });
  }
  const seen = new Map();                    // unique ids
  for (const e of out) { const n = (seen.get(e.id) || 0) + 1; seen.set(e.id, n); if (n > 1) e.id = `${e.id}-${n}`; }
  return out;
}

export async function scanLaunchAgents(prefix, dir = path.join(HOME, 'Library', 'LaunchAgents')) {
  const out = [];
  for (const f of (await readdir(dir).catch(() => [])).filter((x) => x.endsWith('.plist')).sort()) {
    const r = await run('plutil', ['-extract', 'Label', 'raw', path.join(dir, f)], { timeout: 5000 });
    const label = r.out.trim() || f.replace(/\.plist$/, '');
    if (skipLabel(label, prefix)) continue;
    out.push({ label, name: nameFromLabel(label), file: f });
  }
  return out;
}

export async function scanDocker() {
  const r = await run('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}'], { timeout: 8000 });
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => { const [name, status] = l.split('\t'); return { name, status }; });
}

export async function scanCron() {
  const r = await run('crontab', ['-l'], { timeout: 5000 });
  return r.ok ? cronEntries(r.out) : [];
}

/** Git repos up to two levels under $HOME (skips Library, dot-dirs, node_modules). */
export async function scanRepos(home = HOME) {
  const out = [];
  const skip = (n) => n.startsWith('.') || n === 'Library' || n === 'node_modules' || n === 'Applications';
  for (const a of await readdir(home, { withFileTypes: true }).catch(() => [])) {
    if (!a.isDirectory() || skip(a.name)) continue;
    const p = path.join(home, a.name);
    const kids = await readdir(p, { withFileTypes: true }).catch(() => []);
    if (kids.some((k) => k.name === '.git')) { out.push(p); continue; }
    for (const b of kids) {
      if (b.isDirectory() && !skip(b.name) && (await readdir(path.join(p, b.name)).catch(() => [])).includes('.git')) out.push(path.join(p, b.name));
    }
  }
  return out.sort();
}
