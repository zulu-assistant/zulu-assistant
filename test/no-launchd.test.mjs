// ZULU_NO_LAUNCHD=1 means no launchctl writes, on every path (#519).
//
// Nothing here touches the real HOME or the real launchd: the installer runs in a COPY of this checkout
// under a temp HOME, with a stand-in launchctl that records every call. scripts/env.sh puts /usr/bin ahead
// of the caller's PATH, so the stand-in goes in NODE_BIN_DIR, the only directory env.sh puts first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm, lstat, chmod, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAC = process.platform === 'darwin';
const STANDINS = ['cmux', 'brew', 'claude', 'graphify', 'osascript', 'open', 'crontab'];
const WRITES = 'bootstrap|bootout|kickstart|load|unload|enable|disable|kill|remove|reboot';

async function sandbox() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'zulu-no-launchd-'));
  const root = path.join(base, 'checkout'); const home = path.join(base, 'home'); const bin = path.join(base, 'bin');
  await mkdir(root, { recursive: true }); await mkdir(home, { recursive: true }); await mkdir(bin, { recursive: true });
  const skip = /^(overlay|publish|test|data|logs|graphify-out|\.github|\.claude)\//;
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0')
    .filter((f) => f && !skip.test(f) && existsSync(path.join(ROOT, f)));
  for (const f of files) {
    const st = await lstat(path.join(ROOT, f));
    if (!st.isFile()) continue;
    await mkdir(path.dirname(path.join(root, f)), { recursive: true });
    await copyFile(path.join(ROOT, f), path.join(root, f));
    await chmod(path.join(root, f), st.mode & 0o777);
  }
  const calls = path.join(base, 'launchctl-calls.log');
  await writeFile(path.join(bin, 'launchctl'), `#!/bin/bash\necho "$*" >> '${calls}'\n[ "$1" = print ] && exit 1\nexit 0\n`, { mode: 0o755 });
  for (const c of STANDINS) await writeFile(path.join(bin, c), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  await symlink(process.execPath, path.join(bin, 'node'));
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, NODE_BIN_DIR: bin, ZULU_NO_LAUNCHD: '1', ZULU_NO_OPEN: '1', ZULU_NO_NOTIFY: '1', TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', MC_PORT: '1' };
  const run = (cmd, args = []) => spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  const recorded = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { base, root, home, env, run, recorded };
}
const writesIn = (lines) => lines.filter((l) => !/^(print|list)\b/.test(l));

test('bootstrap.sh install with the switch: plists written, both kinds of agent skipped, no launchctl write', { skip: !MAC && 'LaunchAgents are macOS only' }, async () => {
  const c = await sandbox();
  try {
    assert.equal(c.run('/bin/bash', ['install.sh', 'init']).status, 0);
    const vault = path.join(c.home, 'Vault', '.scripts');                  // the vault branch has its own load
    await mkdir(vault, { recursive: true });
    const prefix = /MC_LABEL_PREFIX:-([^}"]+)/.exec(await readFile(path.join(c.root, 'examples/config/zulu.env'), 'utf8'))[1];
    for (const a of ['obsidian-backup', 'obsidian-staleness']) await writeFile(path.join(vault, `${prefix}.${a}.plist`), '<plist/>');
    const r = c.run('/bin/bash', ['scripts/bootstrap.sh', 'install']);
    const out = r.stdout + r.stderr;
    assert.match(out, /skip\s+launchctl bootstrap \S+\.master-console \(ZULU_NO_LAUNCHD\)/, out);
    assert.match(out, /skip\s+launchctl bootstrap \S+\.obsidian-backup \(ZULU_NO_LAUNCHD\)/, out);
    const calls = await c.recorded();
    assert.ok(calls.some((l) => l.startsWith('print')), 'the stand-in was reached: without this the test proves nothing');
    assert.deepEqual(writesIn(calls), []);
    assert.ok((await readdir(path.join(c.home, 'Library', 'LaunchAgents'))).some((f) => f.endsWith('.master-console.plist')));
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('without the switch the same run does load (the stand-in sees it), so the test above can fail', { skip: !MAC && 'LaunchAgents are macOS only' }, async () => {
  const c = await sandbox();
  try {
    delete c.env.ZULU_NO_LAUNCHD;
    assert.equal(c.run('/bin/bash', ['install.sh', 'init']).status, 0);
    c.run('/bin/bash', ['scripts/bootstrap.sh', 'install']);
    assert.ok(writesIn(await c.recorded()).some((l) => l.startsWith('bootstrap') && l.includes('.master-console.plist')));
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('the job installers honor the switch: --apply places the plist and loads nothing, --remove unloads nothing', { skip: !MAC && 'LaunchAgents are macOS only' }, async () => {
  const c = await sandbox();
  try {
    assert.equal(c.run('/bin/bash', ['install.sh', 'init']).status, 0);
    await mkdir(path.join(c.home, 'Library', 'LaunchAgents'), { recursive: true });
    const a = c.run('/bin/bash', ['scripts/chat-intake-install.sh', '--apply']);
    assert.equal(a.status, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /not loaded \(ZULU_NO_LAUNCHD\)/);
    assert.ok((await readdir(path.join(c.home, 'Library', 'LaunchAgents'))).some((f) => f.endsWith('.chat-intake.plist')));
    assert.equal(c.run('/bin/bash', ['scripts/chat-intake-install.sh', '--remove']).status, 0);
    assert.equal(c.run('/bin/bash', ['scripts/state-backup-install.sh', '--remove']).status, 0);
    assert.deepEqual(writesIn(await c.recorded()), []);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('upgrade and rollback are refused with the switch, before anything changes', async () => {
  const c = await sandbox();
  try {
    for (const args of [['scripts/upgrade.mjs'], ['scripts/upgrade.mjs', 'rollback']]) {
      const r = c.run(process.execPath, args);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /refused: ZULU_NO_LAUNCHD is set/);
    }
    assert.deepEqual(writesIn(await c.recorded()), []);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

// Every launchctl write under scripts/ and in install.sh sits behind the switch. Quoted text is messages, not calls.
const NOT_CODE = new Set(['scripts/triage.sh', 'scripts/gate-triggers.default']);   // an allow-list string and a pattern list
const GUARD_WINDOW = 4;
function unguardedWrites(text) {
  const lines = text.split('\n'); const out = [];
  lines.forEach((line, i) => {
    if (/^\s*(#|\/\/)/.test(line)) return;
    const code = line.replace(/"[^"]*"/g, '""');
    const isWrite = new RegExp(`(^|[\\s;&|(])launchctl\\s+(${WRITES})\\b`).test(code) || new RegExp(`'launchctl',\\s*\\['(${WRITES})'`).test(line);
    if (isWrite && !lines.slice(Math.max(0, i - GUARD_WINDOW), i + 1).some((l) => l.includes('ZULU_NO_LAUNCHD'))) out.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return out;
}

test('static: every launchctl write in scripts/ and install.sh sits behind ZULU_NO_LAUNCHD', async () => {
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', 'scripts', 'install.sh'], { encoding: 'utf8' })
    .split('\0').filter((f) => f && !NOT_CODE.has(f) && existsSync(path.join(ROOT, f)));
  const bad = {};
  let seen = 0;
  for (const f of files) {
    const text = await readFile(path.join(ROOT, f), 'utf8');
    if (text.includes('launchctl')) seen++;
    const u = unguardedWrites(text);
    if (u.length) bad[f] = u;
  }
  assert.ok(seen >= 6, 'the scan found the installers');
  assert.deepEqual(bad, {});
});

test('static: the scan itself catches a bare write, in shell and in Node', () => {
  assert.equal(unguardedWrites('launchctl bootstrap "gui/1" "$DEST"').length, 1);
  assert.equal(unguardedWrites("await run('launchctl', ['kickstart', '-k', x]);").length, 1);
  assert.equal(unguardedWrites('step would "launchctl bootstrap $a"').length, 0);
  assert.equal(unguardedWrites('launchctl print "gui/1/x"').length, 0);
});
