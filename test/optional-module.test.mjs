// A private lane the board loads only when its file is present (#797), and the manifest's `withheld` list.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadOptional } from '../src/optional-module.mjs';
import { classify } from '../scripts/publish.mjs';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('absent: no file = null, nothing imported', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optional-'));
  assert.equal(await loadOptional(path.join(dir, 'missing.mjs')), null);
  assert.equal(await loadOptional(pathToFileURL(path.join(dir, 'missing.mjs'))), null);
});

test('present: the module is imported, by path or by file URL', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optional-'));
  const file = path.join(dir, 'lane.mjs');
  await writeFile(file, 'export const answer = 42;\n');
  assert.equal((await loadOptional(file)).answer, 42);
  assert.equal((await loadOptional(pathToFileURL(file))).answer, 42);
});

test('present but broken: the fault is thrown, never read as absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'optional-'));
  const missingImport = path.join(dir, 'lane-a.mjs');
  await writeFile(missingImport, "import './not-here.mjs';\nexport const x = 1;\n");
  await assert.rejects(loadOptional(missingImport));
  const syntax = path.join(dir, 'lane-b.mjs');
  await writeFile(syntax, 'export const = ;\n');
  await assert.rejects(loadOptional(syntax));
});

test('the board does not import the back office lane statically', async () => {
  const src = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.doesNotMatch(src, /^import[^\n]*backoffice/m);
  assert.match(src, /loadOptional\(path\.join\(ROOT, 'src', 'backoffice\.mjs'\)\)/);
});

test('withheld: exact paths under a public pattern stay private; nothing else moves', () => {
  const manifest = { public: ['src/**', 'test/**'], private: ['overlay/**'], withheld: ['src/lane.mjs', 'test/lane.test.mjs'] };
  const c = classify(['src/a.mjs', 'src/lane.mjs', 'src/lane.mjs.bak', 'test/lane.test.mjs', 'overlay/x'], manifest);
  assert.deepEqual(c.public.sort(), ['src/a.mjs', 'src/lane.mjs.bak']);
  assert.deepEqual(c.private.sort(), ['overlay/x', 'src/lane.mjs', 'test/lane.test.mjs']);
  assert.deepEqual(c.both, []);
  // a manifest with no such list classifies as before
  assert.deepEqual(classify(['src/lane.mjs'], { public: ['src/**'], private: [] }).public, ['src/lane.mjs']);
});

test('the manifest withholds the back office lane and the loop library, and none of it is public', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'publish', 'manifest.json'), 'utf8'));
  for (const f of ['src/backoffice.mjs', 'src/backoffice-lane.mjs', 'src/loop-lanes.mjs', 'test/backoffice.test.mjs', 'test/loop-lanes.test.mjs', 'examples/config/BACKOFFICE.md', 'examples/config/backoffice.json', 'system/launchd/backoffice.plist.tmpl'])
    assert.ok(manifest.withheld.includes(f), f);
  const c = classify(['src/backoffice.mjs', 'src/loop-lanes.mjs', 'scripts/backoffice-poller.mjs', 'scripts/backoffice-read-server.mjs', 'examples/config/backoffice.json'], manifest);
  assert.deepEqual(c.public, []);
});

// Through the real route, on a demo board with the lane switched off in its overlay. In
// the source repository the lane is present: the route is reached and refuses because the lane is off (409). In the
// public edition the file is absent: 404, and the board started without it.
test('the route: 404 without the lane, 409 (off) with it', { timeout: 30_000 }, async () => {
  const present = existsSync(path.join(ROOT, 'src', 'backoffice.mjs'));
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'optional-overlay-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  // the lane's switch is off whatever registry the board resolves (in the source repository that is the owner's)
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { backoffice: { mode: 'off' } } }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1' }), stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    const r = await fetch(`${base}/api/backoffice/escalate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'notice', id: 'q1' }) });
    const body = await r.json();
    if (present) { assert.equal(r.status, 409); assert.equal(body.refused, 'the back office is off'); }
    else { assert.equal(r.status, 404); assert.equal(body.refused, 'no back office lane on this install'); }
  } finally { child.kill(); }
});
