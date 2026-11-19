// node --test "test/*.test.mjs" — the suite leaves nothing in the system temp folder (test/temp-root.mjs, #665)
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TEMP_ROOT } from './temp-root.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = pathToFileURL(path.join(HERE, 'temp-root.mjs')).href;

test('every test file imports the temp root before anything else', () => {
  const missing = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).filter((f) => {
    const first = readFileSync(path.join(HERE, f), 'utf8').split('\n').find((l) => /^import[\s{'"*]/.test(l));
    return !/^import '\.\/temp-root\.mjs';/.test(first || '');
  });
  assert.deepEqual(missing, [], `these test files must start with import './temp-root.mjs': ${missing.join(', ')}`);
});

test('os.tmpdir() and the environment point at this process\'s own temp root', () => {
  assert.equal(os.tmpdir(), TEMP_ROOT);
  assert.equal(process.env.TMPDIR, TEMP_ROOT);
  assert.match(path.basename(TEMP_ROOT), /^zulu-test-[A-Za-z0-9]{6}$/);
});

// A child that imports the helper, makes a folder the way the suite does, starts a grandchild that writes
// one too, then ends as told. Its parent temp folder is ours, so we can count what it leaves.
function child(end) {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'temp-root-child-'));
  const code = `
    import ${JSON.stringify(HELPER)};
    import { mkdtempSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import os from 'node:os'; import path from 'node:path';
    const d = mkdtempSync(path.join(os.tmpdir(), 'zulu bk-'));
    writeFileSync(path.join(d, 'f'), 'x');
    execFileSync(process.execPath, ['-e', "require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'grand-'))"]);
    console.log(d);
    ${end}`;
  return { parent, code };
}

test('the root is removed when the process exits, the throw and signal cases included', async () => {
  for (const end of ['', 'process.exit(1);', 'throw new Error("boom");', 'setInterval(() => {}, 1000);']) {
    const { parent, code } = child(end);
    const env = { ...process.env, TMPDIR: parent };
    delete env.KEEP_TEST_TMP;
    let made;
    if (end.startsWith('setInterval')) {
      const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env });
      made = await new Promise((r) => p.stdout.once('data', (b) => r(String(b).trim())));
      assert.ok(existsSync(made), 'the folder exists while the process runs');
      p.kill('SIGTERM');
      const sig = await new Promise((r) => p.once('exit', (c, s) => r(s)));
      assert.equal(sig, 'SIGTERM', 'the process still ends by the signal');
    } else {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env, encoding: 'utf8' });
      made = r.stdout.trim();
    }
    assert.ok(made.startsWith(parent + path.sep + 'zulu-test-'), `made under the child's own root: ${made}`);
    assert.deepEqual(readdirSync(parent), [], `nothing left after ${end || 'a plain end'}`);
  }
});

test('KEEP_TEST_TMP=1 keeps the root and says where', () => {
  const { parent, code } = child('');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TMPDIR: parent, KEEP_TEST_TMP: '1' }, encoding: 'utf8' });
  const kept = readdirSync(parent);
  assert.equal(kept.length, 1);
  assert.match(r.stderr, new RegExp(`test temp kept: .*${kept[0]}`));
});
