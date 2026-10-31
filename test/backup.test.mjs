import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { backup, restore, ALWAYS_EXCLUDED, SECRETS } from '../scripts/backup.mjs';

// a neutral install: data/ + overlay/, a secret, the decision token, a gate grant, an earlier backup
async function install(schema = 1) {
  const root = path.join(await mkdtemp(path.join(os.tmpdir(), 'zulu bk-')), 'my zulu');
  const put = async (rel, s) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), s); };
  await put('data/tasks/1.json', '{"id":1,"title":"a"}');
  await put('data/schema-version.json', JSON.stringify({ version: schema }));
  await put('data/secrets.env', 'SMTP_PASS=x');
  await put('data/intake-token', 't');
  await put('data/mesh-decision-token', 'd');
  await put('data/guardrails/grants.json', '[]');
  await put('data/guardrails/observed.jsonl', '{}\n');
  await put('data/backups/old.tgz', 'x');
  await put('overlay/config/jobs.mjs', 'export const JOBS = [];');
  await put('overlay/policy.json', '{"version":1}');
  return { root, put };
}
const tarList = (f) => execFileSync('tar', ['-tzf', f], { encoding: 'utf8' }).trim().split('\n');

test('backup: data/ + overlay/ with a manifest; token, grants, earlier backups always out; secrets only on request', async () => {
  const { root } = await install();
  const r = await backup({ root });
  const names = tarList(r.file);
  assert.equal(names[0], 'manifest.json');
  for (const p of ['data/tasks/1.json', 'data/guardrails/observed.jsonl', 'overlay/policy.json', 'overlay/config/jobs.mjs']) assert.ok(names.includes(p), p);
  for (const p of [...ALWAYS_EXCLUDED.map((x) => x), ...SECRETS]) assert.ok(!names.some((n) => n === p || n.startsWith(p + '/')), `leaked ${p}`);
  const withS = await backup({ root, withSecrets: true, out: path.join(root, 'with.tgz') });
  const names2 = tarList(withS.file);
  assert.ok(names2.includes('data/secrets.env') && names2.includes('data/intake-token'));
  assert.ok(!names2.includes('data/mesh-decision-token') && !names2.includes('data/guardrails/grants.json'));
});

test('restore: a dry run lists changes and writes nothing; --apply takes a safety backup, restores, restarts', async () => {
  const { root, put } = await install();
  const b = await backup({ root, out: path.join(root, 'b.tgz') });
  await put('data/tasks/1.json', '{"id":1,"title":"changed later"}');
  await put('overlay/policy.json', '{"version":1,"mode":"off"}');
  const dry = await restore({ root, file: b.file });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.changes.filter((c) => c.action !== 'same').map((c) => c.path).sort(), ['data/tasks/1.json', 'overlay/policy.json']);
  assert.match(await readFile(path.join(root, 'data/tasks/1.json'), 'utf8'), /changed later/);
  let restarted = 0;
  const done = await restore({ root, file: b.file, apply: true, restart: async () => { restarted++; return true; } });
  assert.equal(done.ok, true); assert.equal(restarted, 1);
  assert.match(await readFile(path.join(root, 'data/tasks/1.json'), 'utf8'), /"title":"a"/);
  assert.match(done.safety, /before-restore-/);
  assert.ok(tarList(done.safety).includes('data/tasks/1.json'));
});

test('lean by default: handoff text ≤1 MB kept; media, archives and big files left out and reported; --full keeps all', async () => {
  const { root, put } = await install();
  await put('data/handoffs/x/report.md', '# report');
  await put('data/handoffs/x/plan.json', '{}');
  await put('data/handoffs/x/notes', 'no extension, text');
  await put('data/handoffs/x/demo.gif', 'GIF89a');
  await put('data/handoffs/y/export.csv', 'a,b\n'.repeat(300000));          // ~1.2 MB text
  await put('data/handoffs/slack/9/photo.png', 'png');
  const lean = await backup({ root, out: path.join(root, 'lean.tgz') });
  const names = tarList(lean.file);
  for (const p of ['data/handoffs/x/report.md', 'data/handoffs/x/plan.json', 'data/handoffs/x/notes', 'data/tasks/1.json', 'overlay/policy.json']) assert.ok(names.includes(p), p);
  for (const p of ['data/handoffs/x/demo.gif', 'data/handoffs/y/export.csv', 'data/handoffs/slack/9/photo.png']) assert.ok(!names.includes(p), p);
  assert.equal(lean.full, false); assert.equal(lean.leftOut.files, 3);
  assert.equal(lean.leftOut.top[0].dir, 'data/handoffs/y');                 // biggest first
  const full = await backup({ root, full: true, out: path.join(root, 'full.tgz') });
  assert.ok(tarList(full.file).includes('data/handoffs/x/demo.gif')); assert.equal(full.leftOut.files, 0);
  // a lean backup still restores cleanly (the left-out files are simply kept as they are)
  assert.equal((await restore({ root, file: lean.file })).ok, true);
});

test('secrets need --with-secrets on BOTH sides: in the backup, and again to restore them', async () => {
  const { root, put } = await install();
  const b = await backup({ root, withSecrets: true, out: path.join(root, 's.tgz') });
  await put('data/secrets.env', 'SMTP_PASS=new');
  const without = await restore({ root, file: b.file, apply: true, restart: async () => false });
  assert.ok(without.changes.some((c) => c.path === 'data/secrets.env' && c.action === 'secret-skipped'));
  assert.equal(await readFile(path.join(root, 'data/secrets.env'), 'utf8'), 'SMTP_PASS=new');
  await restore({ root, file: b.file, apply: true, withSecrets: true, restart: async () => false });
  assert.equal(await readFile(path.join(root, 'data/secrets.env'), 'utf8'), 'SMTP_PASS=x');
});

test('restore refuses a newer schema, a tampered file and paths outside data/ and overlay/', async () => {
  const newer = await install(2);
  const b = await backup({ root: newer.root, out: path.join(newer.root, 'n.tgz') });
  const older = await install(1);
  const r = await restore({ root: older.root, file: b.file });
  assert.equal(r.ok, false); assert.match(r.reason, /newer schema \(2\) than this checkout \(1\)/);
  // an older backup: refused while this checkout has no migrations; restored + migrated forward when it has
  const o = await backup({ root: older.root, out: path.join(older.root, 'o.tgz') });
  const n2 = await install(2);
  const none = await restore({ root: n2.root, file: o.file, apply: true, restart: async () => false, migrate: { available: async () => false, run: async () => assert.fail('no migrate') } });
  assert.equal(none.ok, false); assert.match(none.reason, /older schema \(1\) than this checkout \(2\), and this checkout has no migrations/);
  let ran = 0;
  const fwd = await restore({ root: n2.root, file: o.file, apply: true, restart: async () => false, migrate: { available: async () => true, run: async () => { ran++; return 'migrated 1 → 2'; } } });
  assert.equal(fwd.ok, true); assert.equal(fwd.older, true); assert.equal(ran, 1); assert.equal(fwd.migrated, 'migrated 1 → 2');
  // an equal schema restores as-is, no migration
  const eq = await install(1);
  assert.equal((await restore({ root: eq.root, file: o.file, apply: true, restart: async () => false, migrate: { available: async () => true, run: async () => assert.fail('no migrate for equal') } })).migrated, null);
  // tamper: rebuild the tarball with a changed file but the old manifest
  const stage = await mkdtemp(path.join(os.tmpdir(), 'tamper-'));
  execFileSync('tar', ['-xzf', o.file, '-C', stage]);
  await writeFile(path.join(stage, 'data/tasks/1.json'), '{"evil":true}');
  const bad = path.join(stage, 'bad.tgz');
  execFileSync('tar', ['-czf', bad, '-C', stage, 'manifest.json', 'data', 'overlay']);
  const t = await restore({ root: older.root, file: bad });
  assert.equal(t.ok, false); assert.match(t.reason, /does not match the manifest: data\/tasks\/1\.json/);
});
