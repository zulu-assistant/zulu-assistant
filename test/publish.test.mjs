// node --test "test/*.test.mjs" — publish manifest + scrub gate (Agent-OS Phase 3)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { globRe, classify } from '../scripts/publish.mjs';
import { scanText, scanDir } from '../scripts/scrub-gate.mjs';

test('globRe: exact, dir/**, one-segment *', () => {
  assert.ok(globRe('server.mjs').test('server.mjs'));
  assert.ok(!globRe('server.mjs').test('src/server.mjs'));
  assert.ok(globRe('src/**').test('src/a/b.mjs'));
  assert.ok(!globRe('src/**').test('src'));
  assert.ok(globRe('system/launchd/*.plist.tmpl').test('system/launchd/board.plist.tmpl'));
  assert.ok(!globRe('scripts/messages-*.sh').test('scripts/x/messages-a.sh'));
});

test('classify: every file lands in exactly one bucket; strays and doubles are reported', () => {
  const c = classify(['a.js', 'src/x.mjs', 'overlay/y', 'stray.txt', 'dup.md'],
    { public: ['a.js', 'src/**', 'dup.md'], private: ['overlay/**', 'dup.md'] });
  assert.deepEqual(c.public, ['a.js', 'src/x.mjs']);
  assert.deepEqual(c.private, ['overlay/y']);
  assert.deepEqual(c.unclassified, ['stray.txt']);
  assert.deepEqual(c.both, ['dup.md']);
});

const RULES = [
  { id: 'name', re: /\bacme\b/gi },
  { id: 'uuid', re: /\b(?!00000000-)[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\b/g },
];

test('scanText: line/col of every hit; example-safe UUIDs pass', () => {
  const real = ['ABCDEF12', '3456', '4789', 'A123', '456789ABCDEF'].join('-');   // built at runtime: no UUID literal in the file
  const hits = scanText(`ok\nhello ACME and acme\nid 00000000-0000-4000-8000-000000000001\nid ${real}`, RULES);
  assert.deepEqual(hits.map((h) => `${h.rule}@${h.line}:${h.col}`), ['name@2:7', 'name@2:16', 'uuid@4:4']);
});

test('scanDir: flags paths too, skips symlinks and the denylist file itself', async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), 'mc-gate-'));
  await mkdir(path.join(d, 'publish'));
  await writeFile(path.join(d, 'clean.md'), 'nothing here');
  await writeFile(path.join(d, 'acme-notes.md'), 'nothing here');
  await writeFile(path.join(d, 'publish/denylist.json'), '{"rules":[{"pattern":"acme"}]}');
  await writeFile(path.join(d, 'secret.txt'), 'acme');
  await symlink(path.join(d, 'secret.txt'), path.join(d, 'link.txt'));
  const hits = await scanDir(d, RULES);
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line}`).sort(), ['acme-notes.md:0', 'secret.txt:1']);
});
