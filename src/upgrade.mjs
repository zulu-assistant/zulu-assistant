// One-click upgrade (#346, Zulu 1.1): is a newer release out, and may this checkout take it?
//
// Only a RELEASE INSTALL upgrades from the board: a checkout whose `origin` is the public repo
// (SETTINGS.upgrade.repo) and whose HEAD is exactly a release tag (the public main is one commit
// per release). Anything else (the owner's private checkout on its own main, a fork, a checkout
// with local commits) gets an information-only card and no button.
//
// The check reads GitHub's releases API over plain HTTPS, unauthenticated (cloners may have no
// gh login; 60 requests/hour is plenty at one check every 6 hours). The upgrade itself never runs
// in the board process: scripts/upgrade.mjs does, from a one-shot LaunchAgent (see server.mjs).
// Pure parts are exported for test/upgrade.test.mjs; every git/network call is injectable.
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from './worktree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = path.join(ROOT, 'data', 'upgrade-state.json');
export const REQUEST_FILE = path.join(ROOT, 'data', 'upgrade-request.json');
const STALE_MS = 24 * 3600e3;
const git = (run, cwd, ...args) => run('git', ['-C', cwd, ...args]);

/** "v1.2.3-beta.4" → { major, minor, patch, pre: ['beta', 4] } | null. */
export function parseSemver(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(tag || '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.').map((x) => (/^\d+$/.test(x) ? +x : x)) : [] };
}

/** Semver order: a < b → negative. A prerelease sorts before its release. Unparseable → null. */
export function cmpSemver(a, b) {
  const x = parseSemver(a); const y = parseSemver(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return (y.pre.length ? 1 : 0) - (x.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]; const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p - q;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** GitHub releases → the newest one newer than `current`, or null. stable skips prereleases and drafts. */
export function pickRelease(releases, current, channel = 'stable') {
  const ok = (releases || []).filter((r) => r && !r.draft && parseSemver(r.tag_name) && (channel === 'pre' || !r.prerelease));
  ok.sort((a, b) => cmpSemver(b.tag_name, a.tag_name));
  const best = ok[0];
  if (!best) return null;
  if (current && parseSemver(current) && cmpSemver(best.tag_name, current) <= 0) return null;
  return { tag: best.tag_name, name: best.name || best.tag_name, notesUrl: best.html_url || null, publishedAt: best.published_at || null, prerelease: Boolean(best.prerelease) };
}

/**
 * SETTINGS.upgrade → { mode, repo, channel, everyHours } (mode off|observe|on).
 * `undefined` (a 1.0 overlay that predates the key) = on against SETTINGS.repoUrl, so an
 * upgraded install keeps checking; `null` = off.
 */
export function upgradeConfig(cfg, repoUrl = '') {
  if (cfg === null) return { mode: 'off' };
  const c = cfg || {};
  const fromUrl = (/github\.com[/:]([^/]+\/[^/.]+)/.exec(String(repoUrl || '')) || [])[1] || '';
  const repo = c.repo || fromUrl;
  const mode = ['off', 'observe', 'on'].includes(c.mode) ? c.mode : 'on';
  if (!repo) return { mode: 'off' };
  return { mode, repo, channel: c.channel === 'pre' ? 'pre' : 'stable', everyHours: Number(c.everyHours) > 0 ? Number(c.everyHours) : 6 };
}

/** "git@github.com:a/b.git" / "https://github.com/a/b(.git)" → "a/b" (lowercase) | ''. */
export function repoOfRemote(url) {
  const m = /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? m[1].toLowerCase() : '';
}

/** Is this checkout a release install of `repo`? → { release, tag, commit, why }. */
export async function releaseInstall({ root = ROOT, repo, run = sh }) {
  const commit = (await git(run, root, 'rev-parse', 'HEAD')).out || null;
  const origin = (await git(run, root, 'config', '--get', 'remote.origin.url')).out;   // as configured (get-url applies insteadOf)
  if (!repo || repoOfRemote(origin) !== String(repo).toLowerCase())
    return { release: false, tag: null, commit, why: `origin is not ${repo || 'the public repo'} (${repoOfRemote(origin) || 'no origin'})` };
  const t = await git(run, root, 'describe', '--tags', '--exact-match', 'HEAD');
  if (!t.ok || !parseSemver(t.out)) return { release: false, tag: null, commit, why: 'HEAD is not a release tag (local commits, or a branch checkout)' };
  return { release: true, tag: t.out, commit, why: null };
}

/** GitHub's releases list, unauthenticated. → array (throws on HTTP or network failure). */
export async function fetchReleases(repo, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      signal: ctl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'zulu-upgrade-check' },
    });
    if (!r.ok) throw new Error(`GitHub releases: HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/** The commit a tag points at on GitHub (the preflight compares it with the fetched tag). */
export async function fetchTagCommit(repo, tag, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`, {
      signal: ctl.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'zulu-upgrade-check' },
    });
    if (!r.ok) throw new Error(`GitHub commit for ${tag}: HTTP ${r.status}`);
    return (await r.json()).sha || null;
  } finally { clearTimeout(timer); }
}

/** LaunchAgent label prefix from config/zulu.env (overlay/, else examples/), as backup.mjs reads it. */
export function labelPrefix(root = ROOT) {
  if (process.env.MC_LABEL_PREFIX) return process.env.MC_LABEL_PREFIX;
  for (const f of ['overlay/config/zulu.env', 'examples/config/zulu.env']) {
    try {
      const env = readFileSync(path.join(root, f), 'utf8');
      const m = /MC_LABEL_PREFIX="?\$\{MC_LABEL_PREFIX:-([^}"]+)\}/.exec(env) || /MC_LABEL_PREFIX="?([^"\n]+)/.exec(env);
      if (m) return m[1];
    } catch { /* next */ }
  }
  return 'com.zulu-assistant';
}

/** What this checkout runs (GET /api/version; read once at boot: the code only changes with a restart). */
export async function versionInfo({ root = ROOT, run = sh } = {}) {
  const d = await git(run, root, 'describe', '--tags', '--always', '--dirty');
  const c = await git(run, root, 'rev-parse', 'HEAD');
  let schema = 0;
  try { schema = Number(JSON.parse(readFileSync(path.join(root, 'data', 'schema-version.json'), 'utf8')).version) || 0; } catch { /* before schemas */ }
  return { version: d.ok ? d.out : null, commit: c.ok ? c.out : null, schema };
}

export function readStateSync(file = STATE_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }
export async function writeState(state, file = STATE_FILE) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}

/**
 * One check (rate-limited by everyHours unless `force`). Writes the state file and, in observe,
 * a ticker line the first time a release is seen. → the new state (or null when skipped/off).
 */
export async function maybeUpgradeCheck({ cfg, repoUrl = '', root = ROOT, now = Date.now(), file = STATE_FILE, force = false,
  run = sh, fetchImpl = globalThis.fetch, record = () => {} }) {
  const c = upgradeConfig(cfg, repoUrl);
  if (c.mode === 'off') return null;
  const prev = readStateSync(file);
  if (!force && prev.checkedAt && now - prev.checkedAt < c.everyHours * 3600e3) return null;
  const inst = await releaseInstall({ root, repo: c.repo, run });
  const next = { ...prev, mode: c.mode, repo: c.repo, release: inst.release, why: inst.why, current: inst.tag, commit: inst.commit, checkedAt: now };
  try {
    const rels = await fetchReleases(c.repo, { fetchImpl });
    const newest = pickRelease(rels, null, c.channel);
    next.newest = newest?.tag || null;
    next.available = inst.release ? pickRelease(rels, inst.tag, c.channel) : null;
    next.lastError = null;
    if (inst.release) await git(run, root, 'fetch', '--quiet', '--tags', 'origin');
  } catch (e) { next.lastError = String(e.message || e).slice(0, 160); }
  if (next.newest && next.newest !== prev.newest) {
    record('sys', c.mode === 'observe'
      ? `upgrade (observe): newest ${c.repo} release is ${next.newest}; ${inst.release ? `this install is ${inst.tag}` : `no button here: ${inst.why}`}`
      : inst.release && next.available ? `upgrade: ${next.available.tag} is available (this install is ${inst.tag})` : `upgrade: newest release ${next.newest}`);
  }
  await writeState(next, file);
  return next;
}

/** The board card (pure). observe and off show none; only a release install gets the button. */
export function upgradeCard(state, cfg, repoUrl = '', now = Date.now()) {
  const c = upgradeConfig(cfg, repoUrl);
  if (c.mode !== 'on') return null;
  const base = { label: 'update', name: 'Zulu update', domain: 'cloud', schedule: `checked every ${c.everyHours}h`, logAvailable: false };
  const run = state?.lastRun;
  if (run?.unhealthy) return { ...base, status: 'down', detail: `upgrade to ${run.to} FAILED at ${run.step}: ${run.reason}, and the rollback is NOT healthy. See docs/UPGRADE.md (manual recovery)` };
  if (state?.running) return { ...base, status: 'warn', detail: `upgrading ${state.running.from} → ${state.running.to}: ${state.running.step || 'starting'}…` };
  if (!state?.checkedAt) return { ...base, status: 'due', detail: 'no check yet' };
  const stale = now - state.checkedAt > STALE_MS;
  const tail = (run && !run.ok ? ` · last upgrade to ${run.to} failed at ${run.step}: ${run.reason}${run.rolledBack ? ` (rolled back to ${run.from}, healthy)` : ''}` : '')
    + (state.lastError ? ` · check failed: ${state.lastError}` : '') + (stale ? ` · last check ${Math.round((now - state.checkedAt) / 36e5)}h ago` : '');
  if (!state.release) return { ...base, status: stale ? 'stale' : 'ok', detail: `newest release ${state.newest || '?'} · no UPDATE button: ${state.why}${tail}` };
  if (state.available) {
    return { ...base, status: 'warn', detail: `${state.available.tag} available (this install is ${state.current})${tail}`,
      upgrade: { to: state.available.tag, from: state.current, notesUrl: state.available.notesUrl } };
  }
  return { ...base, status: stale ? 'stale' : 'ok', detail: `up to date (${state.current} · ${String(state.commit || '').slice(0, 7)})${tail}` };
}

/** Is an UPDATE request acceptable now? (pure) → { ok, why }. */
export function requestAllowed(state, cfg, repoUrl, to) {
  const c = upgradeConfig(cfg, repoUrl);
  if (c.mode !== 'on') return { ok: false, why: `upgrade mode is ${c.mode} (SETTINGS.upgrade)` };
  if (!state?.release) return { ok: false, why: `not a release install: ${state?.why || 'no check yet'}` };
  if (state.running) return { ok: false, why: `an upgrade is already running (${state.running.from} → ${state.running.to})` };
  if (!state.available) return { ok: false, why: 'no newer release available' };
  if (String(to) !== state.available.tag) return { ok: false, why: `asked for ${to}, the available release is ${state.available.tag}` };
  return { ok: true, why: null };
}

/** The one-shot LaunchAgent that runs the upgrade outside the board (rendered, not templated on disk). */
export function upgradePlist({ label, node, script, root, log }) {
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${x(label)}</string>
  <key>ProgramArguments</key>
  <array><string>${x(node)}</string><string>${x(script)}</string><string>--from-request</string><string>--oneshot</string><string>${x(label)}</string></array>
  <key>WorkingDirectory</key><string>${x(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict>
</plist>
`;
}
