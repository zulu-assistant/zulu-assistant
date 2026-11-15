// A script run through a linked folder still runs (#485).
//
// Node gives a module its REAL path in import.meta.url and the path AS TYPED in process.argv[1]. A script
// that decides "am I the program being run?" by comparing the two without resolving links skips its main
// block whenever the checkout sits under a linked folder (a linked home, /var and /private/var, a linked
// projects folder), and ends at exit 0 having done nothing. scripts/upgrade.mjs and scripts/migrate.mjs did.
//
// Nothing here changes the checkout: migrate gets an empty temp folder as its root and a dry run, and the
// upgrade script is started with the no-launchd switch, which makes it refuse before it reads anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A temp folder with `link` → this checkout and an empty `root`; removed by the caller. */
async function linked() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'zulu-entry-'));
  await symlink(ROOT, path.join(base, 'link'), 'dir');
  await mkdir(path.join(base, 'root'));
  return { base, link: path.join(base, 'link'), root: path.join(base, 'root') };
}
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: os.tmpdir(), encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } });

test('migrate runs when its path goes through a linked folder', async () => {
  const c = await linked();
  try {
    const plain = run([path.join(ROOT, 'scripts', 'migrate.mjs'), '--root', c.root, '--dry-run']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /^migrate: nothing to run/);
    const viaLink = run([path.join(c.link, 'scripts', 'migrate.mjs'), '--root', c.root, '--dry-run']);
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(viaLink.stdout, plain.stdout, 'the same answer through the link (it was empty: the main block was skipped)');
    assert.deepEqual(await readdir(c.root), [], 'a dry run writes nothing');
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('migrate runs when the file itself is reached through a link', async () => {
  const c = await linked();
  try {
    const file = path.join(c.base, 'migrate-link.mjs');
    await symlink(path.join(ROOT, 'scripts', 'migrate.mjs'), file, 'file');
    const r = run([file, '--root', c.root, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^migrate: nothing to run/);
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('upgrade runs when its path goes through a linked folder', async () => {
  const c = await linked();
  try {
    // With the no-launchd switch the main block refuses on its first lines: exit 1 and one line on stderr.
    // Exit 0 and silence = the main block never ran.
    for (const script of [path.join(ROOT, 'scripts', 'upgrade.mjs'), path.join(c.link, 'scripts', 'upgrade.mjs')]) {
      const r = run([script], { ZULU_NO_LAUNCHD: '1' });
      assert.equal(r.status, 1, `${script}: exit ${r.status}, stderr ${JSON.stringify(r.stderr)}`);
      assert.match(r.stderr, /refused: ZULU_NO_LAUNCHD is set/);
    }
  } finally { await rm(c.base, { recursive: true, force: true }); }
});

test('every "am I the program being run" check resolves links in the typed path', async () => {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(path.join(ROOT, dir), { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else if (/\.(mjs|js|cjs)$/.test(e.name)) files.push(path.join(dir, e.name));
    }
  };
  for (const d of ['scripts', 'src', 'bin', 'migrations']) await walk(d);
  files.push('server.mjs');
  const bad = [];
  let checks = 0;
  for (const f of files) {
    const lines = (await readFile(path.join(ROOT, f), 'utf8')).split('\n');
    lines.forEach((line, i) => {
      if (!line.includes('process.argv[1]') || !line.includes('import.meta.url') || /^\s*\/\//.test(line)) return;
      checks++;
      if (!line.includes('realpathSync(process.argv[1])')) bad.push(`${f}:${i + 1}`);
    });
  }
  assert.ok(checks >= 20, `the entry checks were found (${checks})`);
  assert.deepEqual(bad, [], 'compare import.meta.url with pathToFileURL(realpathSync(process.argv[1])).href, as scripts/backup.mjs does');
});
