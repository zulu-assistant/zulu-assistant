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
