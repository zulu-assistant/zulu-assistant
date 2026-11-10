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

// ── the three-part credential rule (1.3) ─────────────────────────────────────────────────────────
import { chmod, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { leftOutLines, ensureMarkers, MARKER, KEEP_DIRS } from '../scripts/backup.mjs';
import { writePrivate, isOwnerOnly } from '../src/private-file.mjs';
import { migrate } from '../scripts/migrate.mjs';

// a marker folder, an owner-only file at depth three, a token-shaped file with open modes, and
// owner-only state in a keep-list folder
async function credentialTree() {
  const t = await install();
  const { root, put } = t;
  const put600 = async (rel, s) => { await put(rel, s); await chmod(path.join(root, rel), 0o600); };
  await put('data/vendor-server/.nobackup', '');
  await put('data/vendor-server/user.db', 'db');                       // open modes: only the marker protects it
  await put600('data/vendor-server/sub/phone-token.txt', 'tk');
  await put600('data/handoffs/a/b/key.txt', 'k');                      // depth three
  await put('data/notes/service.txt', `endpoint=x\n${['api', 'key'].join('_')} = ${'ab12'.repeat(4)}\n`);   // open modes, token-shaped (built here so a secret scanner does not flag the fixture)
  await put('data/notes/plain.txt', 'nothing to see');
  await put600('data/chat-intake/threads.json', '{"t":1}');            // keep list: state
  await put600('data/tasks/2.json', '{"id":2}');
  await put600('data/future-api-key', 'k');
  await put600('overlay/private-note.json', '{}');
  return t;
}
const has = (names, p) => names.includes(p);

test('credential rule: listings for lean, full, state and with-secrets', async () => {
  const { root } = await credentialTree();
  const always = ['data/tasks/1.json', 'data/tasks/2.json', 'data/chat-intake/threads.json', 'data/guardrails/observed.jsonl', 'overlay/policy.json', 'data/notes/plain.txt'];
  const creds = ['data/handoffs/a/b/key.txt', 'data/notes/service.txt', 'data/future-api-key', 'overlay/private-note.json', 'data/secrets.env', 'data/intake-token'];
  const marked = ['data/vendor-server/user.db', 'data/vendor-server/sub/phone-token.txt', 'data/vendor-server/.nobackup'];
  for (const [kind, opts] of [['lean', {}], ['full', { full: true }], ['state', { state: true }]]) {
    const r = await backup({ root, ...opts, out: path.join(root, `${kind}.tgz`) });
    const names = tarList(r.file);
    for (const p of always) if (kind !== 'state' || !p.startsWith('data/notes/')) assert.ok(has(names, p), `${kind} keeps ${p}`);
    for (const p of [...creds, ...marked]) assert.ok(!has(names, p), `${kind} leaked ${p}`);
    assert.deepEqual(r.markers, ['data/vendor-server'], kind);
    if (kind !== 'state') {
      const why = Object.fromEntries(r.credentials.map((c) => [c.path, c.why]));
      assert.equal(why['data/handoffs/a/b/key.txt'], 'mode');
      assert.equal(why['data/notes/service.txt'], 'content');
      assert.equal(why['data/secrets.env'], 'named');
      assert.equal(why['overlay/private-note.json'], 'mode');
      assert.ok(!r.credentials.some((c) => c.path.startsWith('data/vendor-server')), 'a marker folder is not even listed file by file');
    }
    const m = JSON.parse(execFileSync('tar', ['-xzOf', r.file, 'manifest.json'], { encoding: 'utf8' }));
    assert.equal(m.files.find((f) => f.path === 'data/chat-intake/threads.json').mode, 0o600, 'the manifest has a mode column');
    assert.deepEqual(m.skipped.markers, ['data/vendor-server']);
  }
  // with secrets: parts 2 and 3 and the named files come in, flagged; the marker folder NEVER does
  for (const full of [false, true]) {
    const w = await backup({ root, withSecrets: true, full, out: path.join(root, `with-${full}.tgz`) });
    const names = tarList(w.file);
    for (const p of creds) assert.ok(has(names, p), `with-secrets has ${p}`);
    for (const p of marked) assert.ok(!has(names, p), `with-secrets leaked ${p}`);
    assert.equal(w.credentials.length, 0);
    const m = JSON.parse(execFileSync('tar', ['-xzOf', w.file, 'manifest.json'], { encoding: 'utf8' }));
    const flag = Object.fromEntries(m.files.filter((f) => f.secret).map((f) => [f.path, f.secret]));
    assert.deepEqual(flag, { 'data/handoffs/a/b/key.txt': 'mode', 'data/notes/service.txt': 'content', 'data/future-api-key': 'mode', 'overlay/private-note.json': 'mode', 'data/secrets.env': 'named', 'data/intake-token': 'named' });
  }
  // the state job ignores a with-secrets request
  const s = await backup({ root, state: true, withSecrets: true, out: path.join(root, 's2.tgz') });
  assert.ok(!has(tarList(s.file), 'data/future-api-key')); assert.equal(s.withSecrets, false);
});

test('credential rule: what was left out is said, with the reason, grouped by folder', async () => {
  const { root } = await credentialTree();
  const r = await backup({ root, out: path.join(root, 'l.tgz') });
  const text = leftOutLines(r).join('\n');
  assert.match(text, /left out as credentials: 6 files/);
  assert.match(text, /data\/handoffs\/a\/ \(1\): only its owner can read it/);
  assert.match(text, /data\/notes\/service\.txt: its text looks like a credential/);
  assert.match(text, /data\/secrets\.env: a secrets file/);
  assert.match(text, /never backed up: data\/vendor-server\/ \(it holds \.nobackup; --with-secrets does not include it\)/);
  assert.deepEqual(leftOutLines({ credentials: [], markers: [] }), []);
  const many = leftOutLines({ credentials: Array.from({ length: 12 }, (_, i) => ({ path: `data/handoffs/d${i}/x`, why: 'mode' })) }, 3);
  assert.equal(many.at(-1), '  and 9 more folders');
});

test('the relay and TLS folders get the marker from the backup itself; other folders are left alone', async () => {
  const { root, put } = await install();
  await put('data/relay/user.db', 'db'); await put('data/relay/cache.db', 'c');
  await put('data/other/user.db', 'db');
  const r = await backup({ root, full: true, withSecrets: true, out: path.join(root, 'r.tgz') });
  assert.ok(existsSync(path.join(root, 'data/relay', MARKER)));
  assert.ok(!existsSync(path.join(root, 'data/other', MARKER)) && !existsSync(path.join(root, 'data/tls')));
  const names = tarList(r.file);
  assert.ok(!names.some((n) => n.startsWith('data/relay')) && has(names, 'data/other/user.db'));
  assert.deepEqual(await ensureMarkers(root), [], 'idempotent');
});

test('restore: a path under a marker folder is refused, here or in the archive', async () => {
  const src = await install();
  await src.put('data/vendor-server/user.db', 'db');                   // no marker on the machine that made the backup
  const b = await backup({ root: src.root, full: true, out: path.join(src.root, 'b.tgz') });
  assert.ok(has(tarList(b.file), 'data/vendor-server/user.db'));
  const dst = await install();
  await dst.put('data/vendor-server/.nobackup', '');
  await dst.put('data/vendor-server/user.db', 'mine');
  for (const apply of [false, true]) {
    const r = await restore({ root: dst.root, file: b.file, apply, restart: async () => false });
    assert.equal(r.ok, false); assert.match(r.reason, /never backed up or restored \(data\/vendor-server holds \.nobackup\): data\/vendor-server\/user\.db/);
  }
  assert.equal(await readFile(path.join(dst.root, 'data/vendor-server/user.db'), 'utf8'), 'mine');
  assert.equal(await readFile(path.join(dst.root, 'data/tasks/1.json'), 'utf8'), '{"id":1,"title":"a"}', 'nothing else was written either');
  // an archive that itself carries a marker file (hand-made): refused too
  const stage = await mkdtemp(path.join(os.tmpdir(), 'marker-'));
  execFileSync('tar', ['-xzf', b.file, '-C', stage]);
  await writeFile(path.join(stage, 'data/vendor-server/.nobackup'), '');
  const man = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
  man.files.push({ path: 'data/vendor-server/.nobackup', sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 0, mode: 0o644 });
  await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(man));
  const bad = path.join(stage, 'bad.tgz');
  execFileSync('tar', ['-czf', bad, '-C', stage, 'manifest.json', 'data', 'overlay']);
  const clean = await install();
  assert.equal((await restore({ root: clean.root, file: bad })).ok, false);
});

test('restore: modes survive a round trip; credentials by mode or content come back only with --with-secrets', async () => {
  const { root, put } = await credentialTree();
  await put('data/run.sh', '#!/bin/sh\n'); await chmod(path.join(root, 'data/run.sh'), 0o750);
  await put('data/shared.json', '{}'); await chmod(path.join(root, 'data/shared.json'), 0o640);
  const b = await backup({ root, withSecrets: true, full: true, out: path.join(root, 'm.tgz') });
  const modeOf = async (r, rel) => (await stat(path.join(r, rel))).mode & 0o777;
  // onto a fresh install: files are created by the restore
  const fresh = await install();
  await fresh.put('data/shared.json', '{}');                           // same content, looser mode: still corrected
  const without = await restore({ root: fresh.root, file: b.file, apply: true, restart: async () => false });
  assert.equal(without.ok, true);
  const skipped = without.changes.filter((c) => c.action === 'secret-skipped').map((c) => c.path).sort();
  assert.deepEqual(skipped, ['data/future-api-key', 'data/handoffs/a/b/key.txt', 'data/intake-token', 'data/notes/service.txt', 'data/secrets.env', 'overlay/private-note.json']);
  assert.ok(!existsSync(path.join(fresh.root, 'data/future-api-key')) && !existsSync(path.join(fresh.root, 'data/notes/service.txt')));
  assert.equal(await modeOf(fresh.root, 'data/run.sh'), 0o750);
  assert.equal(await modeOf(fresh.root, 'data/shared.json'), 0o640);
  assert.equal(await modeOf(fresh.root, 'data/chat-intake/threads.json'), 0o600, 'owner-only state stays owner-only');
  assert.equal(await modeOf(fresh.root, 'data/tasks/2.json'), 0o600);
  const withS = await restore({ root: fresh.root, file: b.file, apply: true, withSecrets: true, restart: async () => false });
  assert.equal(withS.ok, true);
  assert.equal(await modeOf(fresh.root, 'data/future-api-key'), 0o600, 'a restored credential is owner-only again');
  assert.equal(await modeOf(fresh.root, 'data/handoffs/a/b/key.txt'), 0o600);
  assert.ok(existsSync(path.join(fresh.root, 'data/notes/service.txt')));
});

test('restore: an archive from before the mode column still treats an owner-only file as a credential', async () => {
  const { root } = await credentialTree();
  const b = await backup({ root, withSecrets: true, out: path.join(root, 'old.tgz') });
  const stage = await mkdtemp(path.join(os.tmpdir(), 'oldfmt-'));
  execFileSync('tar', ['-xzpf', b.file, '-C', stage]);
  const man = JSON.parse(await readFile(path.join(stage, 'manifest.json'), 'utf8'));
  man.files = man.files.map(({ path: p, sha256, size }) => ({ path: p, sha256, size })); delete man.skipped;
  await writeFile(path.join(stage, 'manifest.json'), JSON.stringify(man));
  const old = path.join(stage, 'old.tgz');
  execFileSync('tar', ['-czf', old, '-C', stage, 'manifest.json', 'data', 'overlay']);
  const fresh = await install();
  const r = await restore({ root: fresh.root, file: old, apply: true, restart: async () => false });
  assert.equal(r.ok, true);
  const skipped = r.changes.filter((c) => c.action === 'secret-skipped').map((c) => c.path);
  assert.ok(skipped.includes('data/future-api-key') && skipped.includes('data/secrets.env'));
  assert.ok(!skipped.includes('data/chat-intake/threads.json'));
  assert.equal((await stat(path.join(fresh.root, 'data/chat-intake/threads.json'))).mode & 0o777, 0o600);
});

test('writePrivate: the one writer of owner-only files creates, tightens and appends', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'priv-'));
  const f = path.join(dir, 'a');
  await writeFile(f, 'loose'); await chmod(f, 0o644);
  await writePrivate(f, 'tight');
  assert.equal((await stat(f)).mode & 0o777, 0o600); assert.equal(await readFile(f, 'utf8'), 'tight');
  await writePrivate(f, '+more', { append: true });
  assert.equal(await readFile(f, 'utf8'), 'tight+more');
  await writePrivate(path.join(dir, 'log'), 'l1\n', { append: true });
  assert.equal((await stat(path.join(dir, 'log'))).mode & 0o777, 0o600);
  assert.ok(isOwnerOnly(0o100600) && isOwnerOnly(0o400) && isOwnerOnly(0o700) && !isOwnerOnly(0o640) && !isOwnerOnly(0o644));
  assert.ok(KEEP_DIRS.every((d) => d.startsWith('data/') && d.endsWith('/')));
});

test('migration 002: the marker goes into a relay or TLS folder that exists, and nowhere else', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'mig2 -'));
  const root = path.join(base, 'root'); await mkdir(path.join(root, 'data/relay'), { recursive: true });
  await writeFile(path.join(root, 'data/relay/user.db'), 'db');
  const dir = path.join(process.cwd(), 'migrations');
  const dry = await migrate({ root, dir, dryRun: true });
  assert.ok(dry.log.includes('created data/relay/.nobackup')); assert.ok(!existsSync(path.join(root, 'data/relay/.nobackup')));
  const r = await migrate({ root, dir, backup: path.join(base, 'bk') });
  assert.deepEqual(r.ran, ['001-schema-stamp', '002-nobackup-markers']); assert.equal(r.version, 2);
  assert.ok(existsSync(path.join(root, 'data/relay/.nobackup')) && !existsSync(path.join(root, 'data/tls')));
  assert.ok(JSON.parse(await readFile(path.join(base, 'bk/migrated.json'), 'utf8')).includes('data/relay/.nobackup'), 'a rollback knows the file is new');
  assert.deepEqual((await migrate({ root, dir })).ran, []);
  // no such folder: nothing is created
  const bare = path.join(base, 'bare'); await mkdir(path.join(bare, 'data'), { recursive: true });
  await migrate({ root: bare, dir });
  assert.ok(!existsSync(path.join(bare, 'data/relay')));
  await rm(base, { recursive: true, force: true });
});
