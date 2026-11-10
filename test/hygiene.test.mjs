// node --test "test/*.test.mjs" — Agent-OS Phase 0 hygiene guards (task #36)
import test from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from '../src/config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKENS = new Set(['HOME', 'REPO', 'NODE_BIN_DIR', 'VAULT', 'LABEL_PREFIX']);

test('selfheal markers: primary = Application Support, legacy ~/.cache kept as fallback', () => {
  assert.ok(SETTINGS.selfhealMarkerDir.endsWith('/Library/Application Support/selfheal-runner'));
  assert.ok(SETTINGS.selfhealLegacyMarkerDir.endsWith('/.cache/selfheal-runner'));
});

test('templates: no hard-coded home, only known tokens', async () => {
  const files = [
    ...(await readdir(path.join(ROOT, 'system/launchd'))).filter((f) => f.endsWith('.tmpl')).map((f) => `system/launchd/${f}`),
    'system/cmux/cmux.json.tmpl',
  ];
  assert.ok(files.length >= 3);
  for (const f of files) {
    const s = await readFile(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(s, /\/Users\//, f);
    // (the lowercase "__FROM_data/cmux-socket-password__" secret slot is filled by the installer, not the renderer)
    for (const [, t] of s.matchAll(/__([A-Z_]+)__/g)) assert.ok(TOKENS.has(t), `${f}: unknown token __${t}__`);
  }
});

test('render-tmpl.sh renders every token and env.sh resolves a node', () => {
  const out = execFileSync(path.join(ROOT, 'scripts/render-tmpl.sh'), ['system/launchd/mission-control-triage.plist.tmpl'],
    { cwd: ROOT, encoding: 'utf8', env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', REPO: '/r', VAULT: '/v' } });
  assert.doesNotMatch(out, /__[A-Z_]+__/);
  assert.match(out, /\/v\/.scripts\/selfheal-runner.sh/);
  assert.match(out, /"\/r\/scripts\/triage.sh"/);
  const node = execFileSync('/bin/bash', ['-c', '. scripts/env.sh; echo "$NODE_BIN"'], { cwd: ROOT, encoding: 'utf8', env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' } }).trim();
  assert.match(node, /\/node$/);
});

// bootstrap.sh is zsh (macOS); the public CI runs the suite on Linux too
test('bootstrap install --dry-run on an empty HOME plans the creates and writes nothing', { skip: !existsSync('/bin/zsh') && 'needs /bin/zsh (macOS)' }, async () => {
  const { mkdtemp, readdir: ls } = await import('node:fs/promises');
  const os = await import('node:os');
  const home = await mkdtemp(path.join(os.tmpdir(), 'mc-boot-'));
  let out = '';
  try {
    out = execFileSync(path.join(ROOT, 'scripts/bootstrap.sh'), ['install', '--dry-run', '--sandbox'], {
      cwd: ROOT, encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin', NODE_BIN_DIR: path.dirname(process.execPath), VAULT: path.join(home, 'no-vault') },
    });
  } catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  assert.match(out, /would\s+create ghostty config/);
  assert.match(out, /would\s+create ~\/\.config\/cmux\/cmux\.json/);
  assert.match(out, /would\s+create plist \S+\.master-console/);
  assert.match(out, /--sandbox: no paid triage/);
  assert.match(out, /vault not at/);
  assert.deepEqual(await ls(home), []);                                   // dry run touched nothing
});

// 1.3 backup rule: a backup reads "owner-only" as "credential", so core code creates such a file
// in one place only (src/private-file.mjs, re-exported by src/config.mjs as writePrivate).
test('owner-only files are created by the one private writer, nowhere else in core code', async () => {
  const files = ['server.mjs'];
  const walk = async (rel) => {
    for (const e of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
      if (e.isDirectory()) await walk(`${rel}/${e.name}`);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) files.push(`${rel}/${e.name}`);
    }
  };
  for (const d of ['src', 'scripts', 'bin', 'migrations', 'public']) if (existsSync(path.join(ROOT, d))) await walk(d);
  assert.ok(files.includes('src/private-file.mjs') && files.length > 40);
  const hits = [];
  for (const f of files) {
    if (f === 'src/private-file.mjs') continue;
    const lines = (await readFile(path.join(ROOT, f), 'utf8')).split('\n');
    lines.forEach((l, i) => { if (/\b0o?600\b|\b384\b.*mode|mode.*\b384\b/.test(l.replace(/\/\/.*$/, ''))) hits.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], 'use writePrivate / makePrivate / privateWriteStream from src/config.mjs');
  const cfg = await import('../src/config.mjs');
  assert.equal(typeof cfg.writePrivate, 'function');
});

// ── public docs (1.3 docs pass): one stated macOS version, Node version and release number, the
// models page matching the shipped config, and every doc link resolving in the publish output ──
// Works in both skins: here the public-only docs live under publish/public/ and publish at the
// stripped path; in the public edition they are at the root.
const { classify } = await import('../scripts/publish.mjs');
// The file list comes from git. A copy with no git folder (a downloaded archive) gives nothing, so
// the list then comes from a walk of the folder: the doc tests must run there too, not fail on "0 docs".
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'logs', 'graphify-out', 'overlay']);
async function walkFiles(rel = '') {
  const out = [];
  for (const e of await readdir(path.join(ROOT, rel), { withFileTypes: true })) {
    if (!rel && SKIP_DIRS.has(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await walkFiles(r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
const gitFiles = () => execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
async function publishLayout({ list = gitFiles } = {}) {
  let tracked = [];
  try { tracked = list().filter((f) => existsSync(path.join(ROOT, f))); } catch { tracked = []; }
  if (!tracked.length) tracked = await walkFiles();
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'publish/manifest.json'), 'utf8').catch(() => '{}'));
  const out = new Map();                                 // published path → source path
  if (manifest.publicRoot && existsSync(path.join(ROOT, manifest.publicRoot))) {
    const c = classify(tracked, manifest);
    for (const f of c.public) out.set(f, f);
    for (const m of c.mapped) out.set(m.to, m.from);    // public-only files shadow at their stripped path
  } else for (const f of tracked) out.set(f, f);
  return out;
}
const layout = await publishLayout();
const docs = [...layout.keys()].filter((p) => /\.md$/.test(p) && (/^(README|TESTING|SECURITY|CONTRIBUTING)\.md$/.test(p) || p.startsWith('docs/')));
const docText = async (p) => readFile(path.join(ROOT, layout.get(p)), 'utf8');

test('public docs: macOS and Node are each stated one way', async () => {
  assert.ok(docs.length >= 15, `found ${docs.length} public docs`);
  const mac = new Map(); const node = new Map();
  for (const p of docs) {
    if (p === 'docs/VERSIONS.md') continue;              // the per-release table of tested versions
    const s = await docText(p);
    for (const m of s.matchAll(/macOS(?: \||[ -]) ?(\d{2})(?:[.\dx]*)(?:%2B|\+| or later)?/g)) mac.set(`${p}: ${m[0]}`, m[1]);
    for (const m of s.matchAll(/\bNode(?:\.js)?\s*(?:≥\s*|>=\s*)?(\d{2})\b|node[-@](\d{2})\b|nvm install (\d{2})\b/g)) node.set(`${p}: ${m[0]}`, m[1] || m[2] || m[3]);
  }
  assert.ok(mac.size >= 4 && node.size >= 6, `${mac.size} macOS and ${node.size} Node mentions`);
  assert.deepEqual([...new Set(mac.values())], ['26'], `macOS is stated more than one way: ${JSON.stringify([...mac])}`);
  assert.deepEqual([...new Set(node.values())], ['22'], `Node is stated more than one way: ${JSON.stringify([...node])}`);
  for (const k of mac.keys()) assert.doesNotMatch(k, /%2B|\+| or later/, `"or later" promises versions nobody tested: ${k}`);
  // and the tested-versions table agrees with it
  const v = await docText('docs/VERSIONS.md');
  for (const m of v.matchAll(/^\| macOS \| (\d+)\./gm)) assert.equal(m[1], '26');
  for (const m of v.matchAll(/^\| Node\.js \| (\d+)\./gm)) assert.equal(m[1], '22');
});

test('public docs: one latest release, and no version between it and the declared next one', async () => {
  const cmp = (a, b) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  const versions = await docText('docs/VERSIONS.md');
  const latest = /^## (\d+\.\d+\.\d+) \(/m.exec(versions)?.[1];
  const stated = /\*\*Latest release: (\d+\.\d+\.\d+)\.\*\*/.exec(versions)?.[1];
  const next = /\*\*Next release: (\d+\.\d+\.\d+)\*\*/.exec(versions)?.[1] || latest;
  assert.ok(latest, 'VERSIONS.md starts its table with the latest release');
  assert.equal(stated, latest, 'VERSIONS.md states the latest release above its first table');
  const changelog = await readFile(path.join(ROOT, layout.get('CHANGELOG.md')), 'utf8');
  assert.equal(/^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog)?.[1], latest, 'the changelog\'s newest released section is the latest release');
  assert.equal(/Latest release: \*\*(\d+\.\d+\.\d+)\*\*/.exec(await docText('README.md'))?.[1], latest, 'README names the latest release');
  assert.ok(cmp(next, latest) >= 0);
  // "since 1.1", "in 1.2", "from 1.4": a doc may name a release that exists, or the declared next one
  const bad = [];
  for (const p of docs) {
    if (p === 'docs/VERSIONS.md') continue;
    const s = await docText(p);
    for (const m of s.matchAll(/\b(?:[Ss]ince|[Ff]rom|[Ii]n|[Uu]ntil|[Bb]efore|[Aa]fter|[Ww]ith) v?(1\.\d{1,2}(?:\.\d{1,2})?)(?![\d.]*x)\b(?!\.\d{3})/g)) {
      const n = m[1].split('.').length === 2 ? `${m[1]}.0` : m[1];
      if (cmp(n, latest) > 0 && cmp(n, next) !== 0) bad.push(`${p}: "${m[0]}"`);
    }
  }
  assert.deepEqual(bad, [], `docs name a release that is neither out (≤ ${latest}) nor the declared next one (${next})`);
});

test('public docs: the models page names the models the shipped config pins', async () => {
  const m = JSON.parse(await readFile(path.join(ROOT, 'examples/config/models.json'), 'utf8'));
  const page = await docText('docs/MODELS.md');
  for (const k of ['master', 'worker', 'workerFallback']) assert.ok(page.includes(`\`${m[k]}\``), `docs/MODELS.md does not name ${k} = ${m[k]}`);
});

// GitHub's heading anchors: lower case, markup and punctuation dropped, spaces to hyphens
const slug = (h) => h.trim().toLowerCase().replace(/`|\*|\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
test('public docs: every relative link and anchor resolves in the publish output', async () => {
  const all = [...layout.keys()].filter((p) => /\.md$/.test(p) && !p.startsWith('test/') && !p.startsWith('examples/') && !p.startsWith('publish/'));
  const dirs = new Set(); for (const p of layout.keys()) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); }
  const anchors = new Map();
  const anchorsOf = async (p) => {
    if (!anchors.has(p)) anchors.set(p, new Set((await docText(p)).replace(/```[\s\S]*?```/g, '').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, '')))));
    return anchors.get(p);
  };
  const broken = []; let checked = 0;
  for (const p of all) {
    const s = (await docText(p)).replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
    for (const m of s.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|<)/.test(href)) continue;
      checked++;
      const [file, hash] = href.split('#');
      const target = file ? path.posix.normalize(path.posix.join(path.posix.dirname(p), decodeURIComponent(file))).replace(/\/$/, '') : p;
      if (target.startsWith('..')) { broken.push(`${p}: ${href} (leaves the repository)`); continue; }
      if (!layout.has(target) && !dirs.has(target)) { broken.push(`${p}: ${href} (no ${target} in the publish output)`); continue; }
      if (hash && target.endsWith('.md') && layout.has(target) && !(await anchorsOf(target)).has(hash.toLowerCase())) broken.push(`${p}: ${href} (no heading for #${hash} in ${target})`);
    }
  }
  assert.ok(checked > 50, `checked ${checked} links`);
  assert.deepEqual(broken, []);
});

test('public docs: with no git (a downloaded archive) the file list comes from a walk, and the docs are still found', async () => {
  const noGit = await publishLayout({ list: () => { throw new Error('not a git repository'); } });
  const found = [...noGit.keys()].filter((p) => /\.md$/.test(p) && (/^(README|TESTING|SECURITY|CONTRIBUTING)\.md$/.test(p) || p.startsWith('docs/')));
  assert.ok(found.length >= 15, `found ${found.length} public docs without git`);
  for (const p of ['README.md', 'docs/INSTALL.md', 'docs/VERSIONS.md', 'docs/MODELS.md', 'CHANGELOG.md']) assert.ok(noGit.has(p), p);
  assert.deepEqual(found.sort(), [...docs].sort(), 'the same docs as with git');
  assert.equal((await publishLayout({ list: () => [] })).has('README.md'), true, 'an empty list falls back too');
});
