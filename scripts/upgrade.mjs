#!/usr/bin/env node
// zulu upgrade / zulu rollback (#346): INSTALL §7b, done for you, with an automatic rollback.
//   zulu upgrade --check            what would happen (target, commits, migrations); writes nothing
//   zulu upgrade [--to <tag>]       upgrade this release install to <tag> (default: the newest release)
//   zulu rollback                   put back the code + overlay/ + migrated files of the last upgrade
// The board's UPDATE button runs this as a one-shot LaunchAgent (`--from-request --oneshot <label>`),
// never inside the board process: the restart it causes would kill it.
//
// Steps: preflight (clean tree, lock, disk, target, tag commit = GitHub's) → backup (restore point,
// overlay/ copy, previous sha) → git merge --ff-only <tag> → migrate → tests → bootstrap install →
// restart → health. Any failure after the code moved rolls back: git reset to the previous sha,
// overlay/ and every migrated file restored, install, restart, health again. The ledger and other
// data/ written meanwhile are never rolled back.
import { readFile, writeFile, mkdir, cp, rm, open, copyFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sh } from '../src/worktree.mjs';
import { upgradeConfig, releaseInstall, fetchReleases, fetchTagCommit, pickRelease, readStateSync, writeState, cmpSemver, labelPrefix } from '../src/upgrade.mjs';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_FREE_MB = 500;
const git = (run, cwd, ...args) => run('git', ['-C', cwd, ...args]);
const step = (name, ok, detail = '') => ({ name, ok, detail });
const stamp = (d = new Date()) => d.toISOString().replace(/[:.]/g, '-');

class StepError extends Error { constructor(stepName, reason) { super(reason); this.step = stepName; } }


const runCmd = (cmd, args, { cwd, timeoutMs = 600000, env } = {}) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: env || process.env }, (e, out, err) => resolve({
    ok: !e, out: String(out || '').trim(), err: String(err || e?.message || '').trim(),
  }));
});

/** The real side effects; tests replace any of them. Each returns { ok, detail }. */
export function defaultSteps(root) {
  const port = Number(process.env.MC_PORT) || 3210;
  const getJson = async (p) => { try { const r = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) }); return r.ok ? await r.json() : null; } catch { return null; } };
  return {
    async freeMb() { const r = await runCmd('df', ['-k', root]); const cols = r.out.split('\n').pop()?.trim().split(/\s+/) || []; return Number(cols[3]) / 1024 || 0; },
    async verifyTag({ repo, tag }) { return fetchTagCommit(repo, tag); },
    async releases({ repo }) { return fetchReleases(repo); },
    async restorePoint(dir) {
      const s = path.join(root, 'scripts', 'backup.mjs');
      if (!existsSync(s)) return { ok: true, detail: 'no backup.mjs (skipped)' };
      const r = await runCmd(process.execPath, [s, 'backup', '--out', path.join(dir, 'restore-point.tgz')], { cwd: root });
      return { ok: r.ok, detail: r.ok ? 'restore point written' : r.err.split('\n')[0] };
    },
    async migrate(dir) {
      const s = path.join(root, 'scripts', 'migrate.mjs');
      if (!existsSync(s)) return { ok: true, detail: 'no migrations in this release' };
      const r = await runCmd(process.execPath, [s, '--root', root, '--backup', dir], { cwd: root });
      return { ok: r.ok, detail: (r.ok ? r.out : r.err).split('\n')[0] };
    },
    async tests() {
      if (!existsSync(path.join(root, 'test'))) return { ok: true, detail: 'no tests' };
      const r = await runCmd(process.execPath, ['--test', 'test/*.test.mjs'], { cwd: root, timeoutMs: 900000 });
      const pass = /# pass (\d+)/.exec(r.out)?.[1]; const fail = /# fail (\d+)/.exec(r.out)?.[1];
      if (!r.ok) return { ok: false, detail: `tests failed (${fail || '?'} failing)` };
      if (existsSync(path.join(root, 'scripts', 'publish.mjs')) && existsSync(path.join(root, 'publish', 'manifest.json'))) {
        const p = await runCmd(process.execPath, ['scripts/publish.mjs', '--check'], { cwd: root });
        if (!p.ok) return { ok: false, detail: `publish --check failed: ${p.err.split('\n')[0]}` };
      }
      return { ok: true, detail: `tests ${pass || '?'}/${pass || '?'}` };
    },
    async install() {
      const s = path.join(root, 'scripts', 'bootstrap.sh');
      if (!existsSync(s)) return { ok: true, detail: 'no bootstrap.sh (skipped)' };
      const r = await runCmd('/bin/bash', [s, 'install'], { cwd: root });
      return { ok: r.ok, detail: r.ok ? 'install steps re-run' : r.err.split('\n').slice(-1)[0] };
    },
    async bootId() { return (await getJson('/api/version'))?.bootId || null; },
    async restart() {
      if (process.platform !== 'darwin') return { ok: false, detail: 'restart: launchd only (macOS)' };
      if (process.env.ZULU_NO_LAUNCHD) return { ok: false, detail: 'restart: ZULU_NO_LAUNCHD is set' };
      const r = await runCmd('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${labelPrefix(root)}.master-console`]);
      return { ok: r.ok, detail: r.ok ? 'board restarted' : r.err.split('\n')[0] };
    },
    async health({ commit, prevBoot, timeoutMs = 90000 }) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) {
        const v = await getJson('/api/version');
        if (v && v.bootId && v.bootId !== prevBoot && (!commit || v.commit === commit) && await getJson('/api/status')) return { ok: true, detail: `healthy (${v.version || v.commit?.slice(0, 7)})` };
        await new Promise((r) => setTimeout(r, 2000));
      }
      return { ok: false, detail: `no healthy board on :${port} within ${Math.round(timeoutMs / 1000)}s` };
    },
    async bootout(label) { if (label && !process.env.ZULU_NO_LAUNCHD) await runCmd('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]); },
  };
}

/** Preflight only (also `--check`). → { ok, from, to, toCommit, prev, commits: [subjects], migrations: [ids], why } */
export async function preflight({ root = HERE, cfg, repoUrl = '', to = null, run = sh, steps = defaultSteps(root) }) {
  const c = upgradeConfig(cfg, repoUrl);
  if (c.mode === 'off') return { ok: false, why: 'upgrade is off (SETTINGS.upgrade = null)' };
  const inst = await releaseInstall({ root, repo: c.repo, run });
  if (!inst.release) return { ok: false, why: `not a release install: ${inst.why}` };
  const dirty = (await git(run, root, 'status', '--porcelain', '--untracked-files=no')).out;
  if (dirty) return { ok: false, why: `the working tree has changes; commit or undo them first:\n${dirty}` };
  if (existsSync(path.join(root, 'data', 'upgrade.lock'))) return { ok: false, why: 'another upgrade is running (data/upgrade.lock)' };
  const free = await steps.freeMb();
  if (free < MIN_FREE_MB) return { ok: false, why: `only ${Math.round(free)} MB free (need ${MIN_FREE_MB})` };
  await git(run, root, 'fetch', '--quiet', '--tags', 'origin');
  let target = to;
  if (!target) {
    const rel = pickRelease(await steps.releases({ repo: c.repo }), inst.tag, c.channel);
    if (!rel) return { ok: true, from: inst.tag, to: null, why: `up to date (${inst.tag})` };
    target = rel.tag;
  }
  if (cmpSemver(target, inst.tag) === null || cmpSemver(target, inst.tag) <= 0) return { ok: false, why: `${target} is not newer than ${inst.tag}` };
  const tc = await git(run, root, 'rev-list', '-n', '1', target);
  if (!tc.ok || !tc.out) return { ok: false, why: `tag ${target} is not in the fetched remote` };
  let apiCommit = null;
  try { apiCommit = await steps.verifyTag({ repo: c.repo, tag: target }); } catch (e) { return { ok: false, why: `could not verify ${target} with GitHub: ${e.message}` }; }
  if (apiCommit !== tc.out) return { ok: false, why: `tag ${target} is ${tc.out.slice(0, 7)} here but ${String(apiCommit).slice(0, 7)} on GitHub: refusing` };
  if (!(await git(run, root, 'merge-base', '--is-ancestor', 'HEAD', target)).ok) return { ok: false, why: `${target} is not a fast-forward from ${inst.tag} (history rewritten, or a local commit is in the way)` };
  const log = (await git(run, root, 'log', '--format=%s', `HEAD..${target}`)).out;
  const mdir = path.join(root, 'migrations');
  const have = new Set((JSON.parse(await readFile(path.join(root, 'data', 'schema-version.json'), 'utf8').catch(() => '{}')).applied) || []);
  const incoming = (await git(run, root, 'ls-tree', '--name-only', `${target}:migrations`)).out.split('\n').filter((f) => /^\d{3}-[\w-]+\.mjs$/.test(f));
  return { ok: true, from: inst.tag, to: target, toCommit: tc.out, prev: inst.commit, commits: log ? log.split('\n') : [],
    migrations: incoming.map((f) => f.replace(/\.mjs$/, '')).filter((id) => !have.has(id)), mdir, repo: c.repo };
}

async function setRunning(stateFile, running) {
  const s = readStateSync(stateFile);
  await writeState({ ...s, running }, stateFile).catch(() => {});
}

/** Restore code + overlay/ + migrated files from a backup dir (the automatic path and `zulu rollback`). */
export async function restoreBackup({ root, dir, run = sh }) {
  const prev = JSON.parse(await readFile(path.join(dir, 'prev.json'), 'utf8'));
  const r = await git(run, root, 'reset', '--hard', '--quiet', prev.sha);
  if (!r.ok) throw new Error(`git reset to ${prev.sha.slice(0, 7)} failed: ${r.err.split('\n')[0]}`);
  if (existsSync(path.join(dir, 'overlay'))) {
    await rm(path.join(root, 'overlay'), { recursive: true, force: true });
    await cp(path.join(dir, 'overlay'), path.join(root, 'overlay'), { recursive: true });
  }
  const migrated = JSON.parse(await readFile(path.join(dir, 'migrated.json'), 'utf8').catch(() => '[]'));
  for (const rel of migrated) {
    const saved = path.join(dir, 'files', rel);
    if (existsSync(saved)) { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await copyFile(saved, path.join(root, rel)); }
    else await unlink(path.join(root, rel)).catch(() => {});        // did not exist before the upgrade
  }
  return prev;
}

/**
 * The upgrade. → { ok, from, to, steps: [{name, ok, detail}], rolledBack?, healthy?, step?, reason? }
 * `log(line)` gets a progress line per step (the board ticker in the one-shot job).
 */
export async function runUpgrade({ root = HERE, cfg, repoUrl = '', to = null, run = sh, steps = defaultSteps(root),
  log = () => {}, stateFile = path.join(root, 'data', 'upgrade-state.json'), now = new Date() }) {
  const pre = await preflight({ root, cfg, repoUrl, to, run, steps });
  if (!pre.ok) return { ok: false, step: 'preflight', reason: pre.why, steps: [step('preflight', false, pre.why)] };
  if (!pre.to) return { ok: true, upToDate: true, from: pre.from, steps: [step('preflight', true, pre.why)] };
  await mkdir(path.join(root, 'data'), { recursive: true });
  const lock = await open(path.join(root, 'data', 'upgrade.lock'), 'wx').catch(() => null);
  if (!lock) return { ok: false, step: 'preflight', reason: 'another upgrade is running (data/upgrade.lock)', steps: [] };
  await lock.close();
  const done = [step('preflight', true, `${pre.from} → ${pre.to} (${pre.commits.length} commit(s), ${pre.migrations.length} migration(s))`)];
  const dir = path.join(root, 'data', 'backups', `upgrade-${stamp(now)}`);
  const prevBoot = await steps.bootId().catch(() => null);
  const say = async (name, text) => { log(`upgrade: ${text}`); await setRunning(stateFile, { from: pre.from, to: pre.to, step: name, at: Date.now() }); };
  const must = async (name, text, fn) => {
    await say(name, text);
    const r = await fn();
    done.push(step(name, r.ok, r.detail));
    if (!r.ok) throw new StepError(name, r.detail);
    return r;
  };
  let moved = false;
  try {
    await must('backup', 'backing up…', async () => {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'prev.json'), JSON.stringify({ sha: pre.prev, tag: pre.from, to: pre.to, at: now.toISOString() }, null, 2));
      if (existsSync(path.join(root, 'overlay'))) await cp(path.join(root, 'overlay'), path.join(dir, 'overlay'), { recursive: true });
      const rp = await steps.restorePoint(dir);
      return { ok: rp.ok, detail: `${path.relative(root, dir)} (${rp.detail})` };
    });
    await must('code', `moving to ${pre.to}…`, async () => {
      const r = await git(run, root, 'merge', '--ff-only', '--quiet', pre.to);
      moved = r.ok;
      return { ok: r.ok, detail: r.ok ? `HEAD = ${pre.to}` : r.err.split('\n')[0] };
    });
    await must('migrate', `migrating (${pre.migrations.length} step(s))…`, () => steps.migrate(dir));
    await must('tests', 'running the tests…', () => steps.tests());
    await must('install', 're-running the install steps…', () => steps.install());
    await must('restart', 'restarting…', () => steps.restart());
    await must('health', 'waiting for the board…', () => steps.health({ commit: pre.toCommit, prevBoot }));
    log(`upgrade: ${pre.to} healthy`);
    const result = { ok: true, from: pre.from, to: pre.to, steps: done, migrated: pre.migrations, backup: dir, at: Date.now() };
    await finish(stateFile, result);
    return result;
  } catch (e) {
    const failed = { ok: false, from: pre.from, to: pre.to, step: e.step || 'unknown', reason: e.message, steps: done, backup: dir, at: Date.now() };
    if (!moved) { log(`upgrade to ${pre.to} FAILED at ${failed.step}: ${failed.reason} (nothing changed)`); await finish(stateFile, failed); return failed; }
    log(`upgrade to ${pre.to} FAILED at ${failed.step}: ${failed.reason}; rolling back to ${pre.from}…`);
    try {
      await restoreBackup({ root, dir, run });
      const boot2 = await steps.bootId().catch(() => null);
      const ins = await steps.install(); const rs = await steps.restart();
      const hl = await steps.health({ commit: pre.prev, prevBoot: boot2 });
      Object.assign(failed, { rolledBack: true, healthy: ins.ok && rs.ok && hl.ok, unhealthy: !(ins.ok && rs.ok && hl.ok) });
    } catch (re) { Object.assign(failed, { rolledBack: false, healthy: false, unhealthy: true, rollbackError: re.message }); }
    log(failed.healthy ? `upgrade: rolled back to ${pre.from} (healthy)` : `upgrade: rollback to ${pre.from} is NOT healthy, see docs/UPGRADE.md`);
    await finish(stateFile, failed);
    return failed;
  } finally { await rm(path.join(root, 'data', 'upgrade.lock'), { force: true }); }
}

async function finish(stateFile, result) {
  const s = readStateSync(stateFile);
  const { steps: _s, ...lastRun } = result;
  const next = { ...s, running: null, lastRun: { ...lastRun, steps: result.steps } };
  if (result.ok) { next.current = result.to; next.available = null; next.checkedAt = 0; }   // re-check on the next poll
  await writeState(next, stateFile).catch(() => {});
}

/** The newest backup dir an upgrade left. */
export async function lastBackup(root) {
  const { readdir } = await import('node:fs/promises');
  const d = path.join(root, 'data', 'backups');
  const all = (await readdir(d).catch(() => [])).filter((x) => x.startsWith('upgrade-')).sort();
  return all.length ? path.join(d, all.at(-1)) : null;
}

async function main() {
  const a = process.argv.slice(2);
  const flag = (f) => a.includes(f);
  const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
  // Refused rather than skipped: without a restart there is no health check, and an upgrade must not report a board it never saw.
  if (process.env.ZULU_NO_LAUNCHD && !flag('--check')) { console.error('upgrade: refused: ZULU_NO_LAUNCHD is set, and an upgrade or rollback has to restart the board (--check still works)'); process.exit(1); }
  const { SETTINGS } = await import('../src/config.mjs');
  const cfg = SETTINGS.upgrade; const repoUrl = SETTINGS.repoUrl;
  const steps = defaultSteps(HERE);
  const post = (text) => fetch(`http://127.0.0.1:${Number(process.env.MC_PORT) || 3210}/api/event`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'sys', text }), signal: AbortSignal.timeout(2000),
  }).catch(() => {});
  const log = (line) => { console.log(line); post(line); };
  if (a[0] === 'rollback') {
    const dir = await lastBackup(HERE);
    if (!dir) { console.error('rollback: no upgrade backup in data/backups/'); process.exit(1); }
    const prev = await restoreBackup({ root: HERE, dir });
    await steps.install(); await steps.restart();
    console.log(`rollback: code at ${prev.tag || prev.sha.slice(0, 7)}, overlay/ and migrated files restored from ${path.relative(HERE, dir)}`);
    return;
  }
  if (flag('--check')) {
    const p = await preflight({ root: HERE, cfg, repoUrl, to: val('--to'), steps });
    if (!p.ok) { console.log(`upgrade --check: refused: ${p.why}`); process.exit(1); }
    if (!p.to) return console.log(`upgrade --check: ${p.why}`);
    console.log(`upgrade --check: ${p.from} → ${p.to}, ${p.commits.length} commit(s), migrations: ${p.migrations.join(', ') || 'none'}`);
    for (const s of p.commits.slice(0, 20)) console.log(`  ${s}`);
    return;
  }
  let to = val('--to');
  const oneshot = val('--oneshot');
  if (flag('--from-request')) {
    const reqFile = path.join(HERE, 'data', 'upgrade-request.json');
    const req = JSON.parse(await readFile(reqFile, 'utf8').catch(() => '{}'));
    await rm(reqFile, { force: true });
    to = req.to || null;
    if (!to) { log('upgrade: no request found (data/upgrade-request.json)'); await steps.bootout(oneshot); return; }
  }
  const r = await runUpgrade({ root: HERE, cfg, repoUrl, to, steps, log });
  if (r.upToDate) console.log(`upgrade: up to date (${r.from})`);
  else if (!r.ok && r.step === 'preflight') log(`upgrade: refused: ${r.reason}`);
  await steps.bootout(oneshot);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(`upgrade: ${e.message}`); process.exit(1); });
