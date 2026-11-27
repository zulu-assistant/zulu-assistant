import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
// node --test "test/*.test.mjs" — Gemini's project-file setting (#812, scripts/gemini-context.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, lstat, symlink, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextPlan } from '../scripts/gemini-context.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'gemini-context.mjs');
const WANT = ['GEMINI.md', 'AGENTS.md'];

test('contextPlan adds the key only when it is absent, and keeps every other key', () => {
  assert.deepEqual(contextPlan(null, WANT), { verdict: 'add', next: { context: { fileName: WANT } } });
  const cur = { security: { auth: { selectedType: 'x' } }, context: { other: 1 } };
  const p = contextPlan(cur, WANT);
  assert.equal(p.verdict, 'add');
  assert.deepEqual(p.next, { security: { auth: { selectedType: 'x' } }, context: { other: 1, fileName: WANT } });
  assert.deepEqual(cur.context, { other: 1 }, 'the input is not changed');
  assert.equal(contextPlan({ context: { fileName: WANT } }, WANT).verdict, 'same');
  assert.deepEqual(contextPlan({ context: { fileName: 'GEMINI.md' } }, WANT), { verdict: 'differs', have: 'GEMINI.md' });
  assert.equal(contextPlan({ context: { fileName: ['AGENTS.md', 'GEMINI.md'] } }, WANT).verdict, 'differs');
  // a context that is not an object is left alone
  for (const ctx of ['custom', null, ['GEMINI.md'], 3]) assert.equal(contextPlan({ context: ctx }, WANT).verdict, 'differs', String(ctx));
  assert.equal(contextPlan({}, []).verdict, 'bad-wanted');
  assert.equal(contextPlan({}, [1]).verdict, 'bad-wanted');
});

async function home() {
  const h = await mkdtemp(path.join(os.tmpdir(), 'gemini-home-'));
  const wanted = path.join(h, 'wanted.json');
  await writeFile(wanted, JSON.stringify({ context: { fileName: WANT } }));
  return { h, wanted, settings: path.join(h, '.gemini', 'settings.json') };
}
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('the script writes nothing without --apply, adds the key with it, then reads up to date', async () => {
  const { h, wanted, settings } = await home();
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ security: { auth: { selectedType: 'x' } } }));
  await chmod(settings, 0o640);                            // whatever the caller's umask
  const before = await readFile(settings, 'utf8');
  let r = run([wanted, '--home', h]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^would add/);
  assert.equal(await readFile(settings, 'utf8'), before);
  r = run([wanted, '--apply', '--home', h]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^done added/);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { security: { auth: { selectedType: 'x' } }, context: { fileName: WANT } });
  assert.equal((await stat(settings)).mode & 0o777, 0o640, 'the mode is kept');
  r = run([wanted, '--apply', '--home', h]);
  assert.match(r.stdout, /^skip .*up to date/);
});

test('a different key is left alone; a settings file that is not JSON is never written', async () => {
  const { h, wanted, settings } = await home();
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, JSON.stringify({ context: { fileName: ['GEMINI.md'] } }));
  let r = run([wanted, '--apply', '--home', h]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^kept /);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { context: { fileName: ['GEMINI.md'] } });
  await writeFile(settings, '{ not json');
  r = run([wanted, '--apply', '--home', h]);
  assert.equal(r.status, 2);
  assert.equal(await readFile(settings, 'utf8'), '{ not json');
});

test('a link to a missing file is refused; a link is written through; the mode survives a umask', async () => {
  const { h, wanted, settings } = await home();
  await mkdir(path.dirname(settings), { recursive: true });
  await symlink(path.join(h, 'dotfiles', 'gemini.json'), settings);
  let r = run([wanted, '--apply', '--home', h]);
  assert.equal(r.status, 2);
  assert.ok((await lstat(settings)).isSymbolicLink(), 'the link stays a link');
  await mkdir(path.join(h, 'dotfiles'));
  await writeFile(path.join(h, 'dotfiles', 'gemini.json'), '{}', { mode: 0o640 });
  await chmod(path.join(h, 'dotfiles', 'gemini.json'), 0o640);
  r = spawnSync('/bin/sh', ['-c', `umask 077; exec "${process.execPath}" "${SCRIPT}" "${wanted}" --apply --home "${h}"`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok((await lstat(settings)).isSymbolicLink(), 'written through the link');
  assert.deepEqual(JSON.parse(await readFile(path.join(h, 'dotfiles', 'gemini.json'), 'utf8')), { context: { fileName: WANT } });
  assert.equal((await stat(path.join(h, 'dotfiles', 'gemini.json'))).mode & 0o777, 0o640, 'mode kept under umask 077');
});

test('the generic block in examples/ is the one the vault keeps', async () => {
  const ex = JSON.parse(await readFile(path.join(path.dirname(SCRIPT), '..', 'examples', 'gemini', 'settings.context.json'), 'utf8'));
  assert.deepEqual(ex, { context: { fileName: WANT } });
});

test('no settings file: --apply creates one with the key only, with the umask\'s mode', async () => {
  const { h, wanted, settings } = await home();
  const r = spawnSync('/bin/sh', ['-c', `umask 077; exec "${process.execPath}" "${SCRIPT}" "${wanted}" --apply --home "${h}"`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { context: { fileName: WANT } });
  assert.equal((await stat(settings)).mode & 0o777, 0o600, 'a new file is not opened wider than the umask');
});

test('the file is never written over when it changed after it was read', async () => {
  // the check itself: a plan made from one text, the file holding another at write time
  const { h, wanted, settings } = await home();
  await mkdir(path.dirname(settings), { recursive: true });
  await writeFile(settings, '{}');
  // a stand-in for a concurrent save: a preload that changes the file right before the script re-reads it
  const pre = path.join(h, 'pre.mjs');
  await writeFile(pre, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module'; let done = false;
const w = fs.writeFileSync; fs.writeFileSync = (p, d, o) => { const x = w(p, d, o); if (!done && String(p).includes('.tmp-')) { done = true; w(${JSON.stringify(settings)}, '{"saved":1}'); } return x; };
syncBuiltinESMExports();\n`);
  const r = spawnSync(process.execPath, ['--import', pre, SCRIPT, wanted, '--apply', '--home', h], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /changed while it was read/);
  assert.equal(await readFile(settings, 'utf8'), '{"saved":1}');
});
