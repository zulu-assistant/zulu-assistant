// node --test "test/*.test.mjs"
// Board reliability: feed tail read, outbox serialisation, poll stage isolation,
// the persisted digest day, process handlers, backup pruning + card, data-size report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, readdir, utimes, rm, chmod } from 'node:fs/promises';
import { openSync, writeSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTail, tailFile, getAgentFeed, tailStats, TAIL_BYTES } from '../src/collect.mjs';
import { enqueue, drainOutbox, dropFromOutbox, readOutbox } from '../src/mesh.mjs';
import { createStages, digestDue, readDigestState, writeDigestState, installProcessHandlers, DIGEST_MAX_TRIES } from '../src/poll-health.mjs';
import { backup, restore, pruneState, STATE_MAX_BYTES } from '../scripts/backup.mjs';
import { backupCard, newestArchiveSync } from '../src/backup-watch.mjs';
import { measure, usageLines, formatBytes } from '../src/data-usage.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = (p = 'zulu rel-') => mkdtemp(path.join(os.tmpdir(), p));   // a space in the path, like a real checkout

// ---- R1: the feed reads a tail, not the file --------------------------------------

test('feed: a 64 MB workstream is answered from its last 256 KB, partial first line dropped, cached by size + mtime', async (t) => {
  const dir = await tmp();
  t.after(() => rm(dir, { recursive: true, force: true }));      // pass or fail: never leave 64 MB behind
  const file = path.join(dir, 'workstream.jsonl');
  // 64 MB of filler lines written in chunks, then known last lines (one with a multi-byte character)
  const filler = `${JSON.stringify({ title: 'filler', body: 'x'.repeat(900) })}\n`;
  const chunk = Buffer.from(filler.repeat(1024));
  const fd = openSync(file, 'w');
  for (let written = 0; written < 64 * 1024 * 1024; written += chunk.length) writeSync(fd, chunk);
  for (let i = 1; i <= 50; i++) writeSync(fd, `${JSON.stringify({ createdAt: i, title: `event ${i}`, body: i === 50 ? 'done ✔' : 'b' })}\n`);
  closeSync(fd);

  const before = process.memoryUsage().arrayBuffers;
  const r0 = tailStats.reads; const h0 = tailStats.hits;
  const items = await getAgentFeed(40, file);
  const grew = process.memoryUsage().arrayBuffers - before;
  assert.equal(items.length, 40);
  assert.equal(items[0].title, 'event 50', 'newest first');
  assert.equal(items[0].body, 'done ✔');
  assert.equal(items[39].title, 'event 11');
  assert.ok(grew < 8 * 1024 * 1024, `read buffers grew ${grew} bytes — the whole file was read`);
  assert.equal(tailStats.reads - r0, 1);

  // the tail itself: bounded, and it starts on a whole line
  const text = await readTail(file);
  assert.ok(Buffer.byteLength(text) <= TAIL_BYTES);
  assert.doesNotThrow(() => JSON.parse(text.split('\n')[0]), 'first line is whole');
  assert.equal(tailStats.reads - r0, 1, 'unchanged file → served from the cache');
  assert.ok(tailStats.hits - h0 >= 1);

  // a new line changes size + mtime → one fresh read, and it shows
  await appendFile(file, `${JSON.stringify({ createdAt: 51, title: 'event 51' })}\n`);
  assert.equal((await getAgentFeed(1, file))[0].title, 'event 51');
  assert.equal(tailStats.reads - r0, 2);
});

test('feed + log tails: small, empty and missing files', async () => {
  const dir = await tmp();
  const small = path.join(dir, 'small.log');
  await writeFile(small, 'a\nb\nc\n');
  assert.equal(await readTail(small), 'a\nb\nc\n', 'a file under the limit is returned whole, first line kept');
  assert.equal(await tailFile(small, 2), 'c\n');
  const empty = path.join(dir, 'empty.jsonl');
  await writeFile(empty, '');
  assert.deepEqual(await getAgentFeed(40, empty), []);
  assert.deepEqual(await getAgentFeed(40, path.join(dir, 'nope.jsonl')), []);
  assert.equal(await tailFile(path.join(dir, 'nope.log')), '');
  assert.equal(await tailFile(null), '');
});

// ---- R5: outbox read-modify-writes are serialised -----------------------------------

test('outbox: a message queued DURING a drain is never lost (and a drop during a drain holds)', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'outbox.json');
  await enqueue({ to: 'a', line: 'first', queuedAt: 1000 }, file);
  await enqueue({ to: 'a', line: 'stuck', queuedAt: 1001 }, file);
  await enqueue({ to: 'c', line: 'unwanted', queuedAt: 1002 }, file);
  let midDrain;
  const deliver = async (agent, line) => {
    if (line === 'first') {
      // while the drain is typing into a pane: a gate wake arrives and the owner drops c's queue
      midDrain = Promise.all([
        enqueue({ to: 'b', line: 'GATE g1 APPROVED', kind: 'gate', taskId: 7, queuedAt: 1500 }, file),
        dropFromOutbox((m) => m.to === 'c', file),
      ]);
      await midDrain;
      return { delivered: true };
    }
    return { queued: 'dialog on screen' };
  };
  const r = await drainOutbox({ file, now: 2000, resolve: async (n) => ({ name: n }), deliver });
  assert.deepEqual(r.delivered.map((m) => m.line), ['first']);
  const box = await readOutbox(file);
  assert.deepEqual(box.map((m) => m.line).sort(), ['GATE g1 APPROVED', 'stuck'], 'the wake queued mid-drain survived; the dropped one stayed dropped');
  assert.equal(box.find((m) => m.line === 'stuck').attempts, 1);
  assert.equal(box.find((m) => m.line === 'stuck').lastReason, 'dialog on screen');
});

test('outbox: 40 concurrent enqueues all land; a second drain while one runs returns busy', async () => {
  const dir = await tmp();
  const file = path.join(dir, 'outbox.json');
  await Promise.all(Array.from({ length: 40 }, (_, i) => enqueue({ to: `agent-${i % 4}`, line: `m${i}`, queuedAt: 1000 + i }, file)));
  assert.equal((await readOutbox(file)).length, 40);
  let second;
  const deliver = async () => { second ||= drainOutbox({ file, now: 2000, resolve: async (n) => ({ name: n }), deliver: async () => ({ delivered: true }) }); return { queued: 'busy' }; };
  const first = await drainOutbox({ file, now: 2000, resolve: async (n) => ({ name: n }), deliver });
  assert.equal((await second).busy, true);
  assert.equal(first.still.length, 40);
  assert.equal((await readOutbox(file)).length, 40);
});

// ---- R3: poll stages -----------------------------------------------------------------

test('poll stages: a throwing stage is contained, timed and reported; later stages still run', async () => {
  let t = 0; const logged = [];
  const stages = createStages({ now: () => t, log: (...a) => logged.push(a.join(' ')) });
  const order = [];
  await stages.run('snapshot', async () => { t += 120; order.push('snapshot'); return 1; });
  assert.equal(await stages.run('mesh-reconcile', async () => { t += 40; throw new Error('cmux socket hung up'); }), undefined);
  await stages.run('alerts', async () => { t += 5; order.push('alerts'); });
  assert.deepEqual(order, ['snapshot', 'alerts']);
  const v = stages.view();
  assert.equal(v.stages.snapshot.ms, 120);
  assert.equal(v.stages['mesh-reconcile'].error, 'cmux socket hung up');
  assert.equal(v.stages['mesh-reconcile'].failures, 1);
  assert.equal(v.stages['mesh-reconcile'].ms, 40);
  assert.equal(v.stages.alerts.error, null);
  assert.deepEqual(v.slowest, { name: 'snapshot', ms: 120 });
  assert.match(logged[0], /\[poll:mesh-reconcile\] cmux socket hung up/);
  // a later clean run keeps the last error on record but counts the run
  await stages.run('mesh-reconcile', async () => { t += 10; });
  assert.equal(stages.view().stages['mesh-reconcile'].runs, 2);
  assert.equal(stages.view().stages['mesh-reconcile'].error, 'cmux socket hung up');
});

test('poll order: alerts and the heartbeat run straight after the snapshot, before any mesh work', async () => {
  const src = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  const body = src.slice(src.indexOf('async function poll()'));
  const at = (s) => { const i = body.indexOf(s); assert.ok(i > 0, `poll has ${s}`); return i; };
  assert.ok(at("stages.run('snapshot'") < at("stages.run('alerts'"));
  assert.ok(at("stages.run('alerts'") < at("stages.run('heartbeat'"));
  for (const later of ["stages.run('mesh-reconcile'", "stages.run('outbox'", "stages.run('work'"]) assert.ok(at("stages.run('heartbeat'") < at(later), `${later} comes after the heartbeat`);
  assert.doesNotMatch(body.slice(0, body.indexOf('function payloadFor')), /await processAlerts\(snap\);\s*\n\s*await heartbeat\(\);/, 'no bare awaited chain left');
});

// ---- R4: digest day + process handlers -------------------------------------------------

test('digest: a restart after the digest hour neither skips nor repeats the briefing', async () => {
  const at = (h, m = 0, d = 9) => new Date(2026, 10, d, h, m);
  const day = at(9).toDateString();
  // before the hour: never
  assert.equal(digestDue({ now: at(7, 59), hour: 8, state: null }).due, false);
  // sent today, then the board restarts at 09:00: no repeat
  assert.equal(digestDue({ now: at(9), hour: 8, state: { day, sent: true }, firstStart: false }).due, false);
  // down from 07:50 to 09:00 — yesterday's day on file: the briefing is still owed
  assert.equal(digestDue({ now: at(9), hour: 8, state: { day: at(9, 0, 8).toDateString(), sent: true } }).due, true);
  // the first start with this code (no file) after the hour adopts today, as the old in-memory rule did
  assert.deepEqual(digestDue({ now: at(9), hour: 8, state: null, firstStart: true }), { due: false, day, adopt: true });
  assert.equal(digestDue({ now: at(8), hour: 8, state: null, firstStart: false }).due, true);
  // a failed send: again after 10 min, three tries a day at most
  assert.equal(digestDue({ now: at(8, 5), hour: 8, state: { day, sent: false, tries: 1, lastTryAt: at(8).getTime() } }).due, false);
  assert.equal(digestDue({ now: at(8, 11), hour: 8, state: { day, sent: false, tries: 1, lastTryAt: at(8).getTime() } }).due, true);
  assert.equal(digestDue({ now: at(12), hour: 8, state: { day, sent: false, tries: DIGEST_MAX_TRIES, lastTryAt: at(8).getTime() } }).due, false);

  const file = path.join(await tmp(), 'state', 'digest-state.json');
  assert.equal(await readDigestState(file), null);
  await writeDigestState(file, { day, sent: true });
  assert.deepEqual(await readDigestState(file), { day, sent: true });
  await writeFile(file, '{ not json');
  assert.equal(await readDigestState(file), null, 'a corrupt file reads as none');
});

test('the digest send is caught and its day is persisted (server wiring)', async () => {
  const src = await readFile(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /stages\.run\('digest'/, 'the send runs inside a stage (its rejection is caught)');
  assert.doesNotMatch(src, /let lastDigestDay/);
  assert.match(src, /installProcessHandlers\(\)/);
});

test('process handlers: a rejection is logged with a timestamp and the process stays up; an exception logs then exits', () => {
  const proc = new EventEmitter(); const logged = []; const exits = [];
  const h = installProcessHandlers({ proc, log: (l) => logged.push(l), exit: (c) => exits.push(c) });
  proc.emit('unhandledRejection', new Error('relay fetch failed'));
  proc.emit('unhandledRejection', 'plain string');
  assert.equal(exits.length, 0, 'still up after rejections');
  assert.match(logged[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[unhandledRejection\] Error: relay fetch failed/);
  assert.equal(h.counts.rejections, 2);
  assert.equal(h.counts.lastRejection, 'plain string');
  proc.emit('uncaughtException', new Error('boom'), 'uncaughtException');
  assert.match(logged[2], /^\d{4}-.*Z \[uncaughtException\] \(uncaughtException\) Error: boom/);
  assert.deepEqual(exits, [1]);
});

test('a real process with the handlers survives a stray rejection', () => {
  const code = `import { installProcessHandlers } from ${JSON.stringify(path.join(ROOT, 'src/poll-health.mjs'))};
    installProcessHandlers();
    Promise.reject(new Error('stray'));
    setTimeout(() => { console.log('still up'); }, 100);`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /still up/);
});

// ---- R2: state backup, pruning, card ---------------------------------------------------

async function install() {
  const root = path.join(await tmp('zulu st-'), 'my zulu');
  const put = async (rel, s) => { await mkdir(path.dirname(path.join(root, rel)), { recursive: true }); await writeFile(path.join(root, rel), s); };
  await put('data/tasks/1.json', '{"id":1,"title":"a"}');
  await put('data/tasks/2.json', '{"id":2,"title":"b"}');
  await put('data/mesh-outbox.json', '[]');
  await put('data/alert-state.json', '{}');
  await put('data/guardrails/observed.jsonl', '{}\n');
  await put('data/guardrails/grants.json', '[]');
  await put('data/chat-intake/cursor.json', '{}');
  await put('data/handoffs/report.md', '# big program report');
  await put('data/handoffs/slack/3/photo.png', 'png');
  await put('data/relay/cache.db', 'sqlite');
  await put('data/server.log', 'log line');
  await put('data/huge-export.json', Buffer.alloc(STATE_MAX_BYTES + 1, 0x20));
  await put('data/secrets.env', 'SMTP_PASS=x');
  await put('data/mesh-decision-token', 'd');
  // credentials: the board's copy of the socket password (named), and one nobody has named yet (owner-only)
  await put('data/cmux-socket-password', 'pw'); await chmod(path.join(root, 'data/cmux-socket-password'), 0o600);
  await put('data/future-api-key', 'k'); await chmod(path.join(root, 'data/future-api-key'), 0o600);
  // owner-only STATE in a named folder is kept (the chat intake writes its files this way)
  await put('data/chat-intake/threads.json', '{"t":1}'); await chmod(path.join(root, 'data/chat-intake/threads.json'), 0o600);
  await put('overlay/config/jobs.mjs', 'export const JOBS = [];');
  return { root, put };
}
const tarList = (f) => execFileSync('tar', ['-tzf', f], { encoding: 'utf8' }).trim().split('\n');

test('state backup: ledger + state files + overlay; no handoffs, logs, relay data, big files, secrets or token', async () => {
  const { root } = await install();
  const r = await backup({ root, state: true, now: new Date('2026-11-09T03:15:00.000Z') });
  assert.equal(path.basename(r.file), 'zulu-state-2026-11-09T03-15-00-000Z.tgz');
  const names = tarList(r.file);
  for (const p of ['manifest.json', 'data/tasks/1.json', 'data/tasks/2.json', 'data/mesh-outbox.json', 'data/alert-state.json', 'data/guardrails/observed.jsonl', 'data/chat-intake/cursor.json', 'data/chat-intake/threads.json', 'overlay/config/jobs.mjs']) assert.ok(names.includes(p), `has ${p}`);
  for (const p of ['data/handoffs', 'data/relay', 'data/server.log', 'data/huge-export.json', 'data/secrets.env', 'data/mesh-decision-token', 'data/guardrails/grants.json', 'data/backups', 'data/cmux-socket-password', 'data/future-api-key']) assert.ok(!names.some((n) => n === p || n.startsWith(`${p}/`)), `left out ${p}`);
  // the lean and full backups leave the socket password out too, unless secrets are asked for
  const lean = tarList((await backup({ root, out: path.join(root, 'lean.tgz') })).file);
  assert.ok(!lean.includes('data/cmux-socket-password'));
  assert.ok(tarList((await backup({ root, withSecrets: true, out: path.join(root, 'with.tgz') })).file).includes('data/cmux-socket-password'));
  // it restores like any backup: a dry run names the lost ledger file
  await writeFile(path.join(root, 'data/tasks/2.json'), '{"id":2,"title":"overwritten"}');
  const dry = await restore({ root, file: r.file });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.changes.filter((c) => c.action !== 'same').map((c) => `${c.action} ${c.path}`), ['change data/tasks/2.json']);
  let restarted = 0;
  const done = await restore({ root, file: r.file, apply: true, restart: async () => { restarted++; return true; } });
  assert.equal(done.ok, true);
  assert.equal(JSON.parse(await readFile(path.join(root, 'data/tasks/2.json'), 'utf8')).title, 'b');
  assert.equal(restarted, 1);
});

test('pruning keeps the newest N state archives and never touches an archive this job did not create', async () => {
  const dir = await tmp('zulu bk-');
  const mine = Array.from({ length: 6 }, (_, i) => `zulu-state-2026-11-0${i + 1}T03-15-00-000Z.tgz`);
  const others = ['zulu-backup-2026-10-31T19-00-00-000Z.tgz', 'before-restore-2026-11-01T10-00-00-000Z.tgz', 'zulu-state-notes.txt', 'zulu-state-mine.tgz', 'my-own-zulu-state-2026-11-01T03-15-00-000Z.tgz'];
  for (const f of [...mine, ...others]) await writeFile(path.join(dir, f), 'x');
  const r = await pruneState({ dir, keep: 3 });
  assert.deepEqual(r.removed.sort(), mine.slice(0, 3));
  assert.deepEqual(r.kept.sort(), mine.slice(3));
  assert.deepEqual((await readdir(dir)).sort(), [...mine.slice(3), ...others].sort());
  assert.deepEqual((await pruneState({ dir, keep: 0 })).removed, [], 'a zero or bad keep never prunes to nothing');
  assert.deepEqual(await pruneState({ dir: path.join(dir, 'missing') }), { kept: [], removed: [] });
});

test('the scheduled command writes one archive, prunes, and prints one line', async () => {
  const { root } = await install();
  // a checkout-shaped copy of the script so its ROOT is the fixture
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await writeFile(path.join(root, 'scripts/backup.mjs'), await readFile(path.join(ROOT, 'scripts/backup.mjs')));
  await mkdir(path.join(root, 'src'), { recursive: true });                // and the two import-free modules it loads
  for (const f of ['src/private-file.mjs', 'src/secret-text.mjs']) await writeFile(path.join(root, f), await readFile(path.join(ROOT, f)));
  await mkdir(path.join(root, 'data/backups'), { recursive: true });
  for (const d of ['01', '02', '03']) await writeFile(path.join(root, `data/backups/zulu-state-2026-10-${d}T03-15-00-000Z.tgz`), 'old');
  await writeFile(path.join(root, 'data/backups/zulu-backup-2026-10-31T19-00-00-000Z.tgz'), 'manual');
  const out = execFileSync(process.execPath, [path.join(root, 'scripts/backup.mjs'), 'backup', '--state', '--keep', '2'], { encoding: 'utf8' });
  assert.match(out, /state backup: \d+ files → .* kept 2, removed 2/);
  const left = (await readdir(path.join(root, 'data/backups'))).sort();
  assert.equal(left.length, 3);
  assert.ok(left.includes('zulu-backup-2026-10-31T19-00-00-000Z.tgz'));
  assert.ok(left.includes('zulu-state-2026-10-03T03-15-00-000Z.tgz'));
});

test('backup card: ok when fresh, amber past 36 h or with no archive, never red; off without the setting', async () => {
  const dir = await tmp('zulu card-');
  const now = Date.parse('2026-11-09T12:00:00Z');
  assert.equal(backupCard(newestArchiveSync(dir), null, now), null);
  assert.equal(newestArchiveSync(path.join(dir, 'missing')), null);
  let c = backupCard(newestArchiveSync(dir), { maxAgeHours: 36 }, now);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /no backup archive yet/);
  const old = path.join(dir, 'zulu-backup-old.tgz'); const fresh = path.join(dir, 'zulu-state-new.tgz');
  await writeFile(old, 'x'); await utimes(old, new Date(now - 9 * 86400e3), new Date(now - 9 * 86400e3));
  await writeFile(path.join(dir, 'notes.txt'), 'x');
  c = backupCard(newestArchiveSync(dir), { maxAgeHours: 36 }, now);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /newest backup is 9 d old \(zulu-backup-old\.tgz\)/);
  await writeFile(fresh, 'x'); await utimes(fresh, new Date(now - 35 * 3600e3), new Date(now - 35 * 3600e3));
  c = backupCard(newestArchiveSync(dir), { maxAgeHours: 36 }, now);
  assert.equal(c.status, 'ok');
  assert.equal(c.label, 'backup:state');
  assert.match(c.detail, /newest 35 h ago · 2 archive\(s\)/);
  await utimes(fresh, new Date(now - 37 * 3600e3), new Date(now - 37 * 3600e3));
  assert.equal(backupCard(newestArchiveSync(dir), { maxAgeHours: 36 }, now).status, 'warn');
});

test('the LaunchAgent template renders to a valid selfheal job; the installer is dry-run first', async () => {
  const tmpl = await readFile(path.join(ROOT, 'system/launchd/state-backup.plist.tmpl'), 'utf8');
  assert.match(tmpl, /__LABEL_PREFIX__\.state-backup/);
  assert.match(tmpl, /selfheal-runner\.sh<\/string>\s*<string>state-backup<\/string>\s*<string>daily:03:15<\/string>\s*<string>"__REPO__\/scripts\/state-backup\.sh"<\/string>/);
  assert.match(tmpl, /<key>RunAtLoad<\/key>\s*<true\/>/);
  const sh = await readFile(path.join(ROOT, 'scripts/state-backup-install.sh'), 'utf8');
  assert.ok(sh.indexOf('if [ "$mode" != "--apply" ]') < sh.indexOf('launchctl bootstrap'), 'nothing is loaded without --apply');
  assert.match(await readFile(path.join(ROOT, 'scripts/state-backup.sh'), 'utf8'), /backup\.mjs backup --state/);
});

// ---- R9: data sizes, report only -------------------------------------------------------

test('data usage: largest subdirectories, biggest first; a digest line; nothing is removed', async () => {
  const dir = path.join(await tmp('zulu du-'), 'data');
  const put = async (rel, bytes) => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), Buffer.alloc(bytes, 1)); };
  await put('handoffs/a/big.bin', 3 * 1048576);
  await put('backups/b.tgz', 1048576);
  await put('tasks/1.json', 200);
  await put('top-level.json', 10);
  const before = (await readdir(dir, { recursive: true })).sort();
  const u = await measure(dir, { top: 2, now: 5 });
  assert.deepEqual(u.top.map((t) => t.name), ['handoffs', 'backups']);
  assert.ok(u.top[0].bytes >= 3 * 1048576 && u.totalBytes >= 4 * 1048576);
  assert.equal(u.at, 5);
  assert.deepEqual((await readdir(dir, { recursive: true })).sort(), before, 'measuring changed nothing');
  const [blank, line] = usageLines(u);
  assert.equal(blank, '');
  assert.match(line, /^DATA: data\/ is \d+ MB — largest: handoffs 3 MB, backups \d+ MB \(report only; nothing is removed\)$/);
  assert.deepEqual(usageLines(null), []);
  assert.equal(formatBytes(1.7 * 1073741824), '1.7 GB');
  // an unreadable folder is named, not guessed
  const u2 = await measure(dir, { du: async (p) => (p.endsWith('backups') ? null : 1024) });
  assert.deepEqual(u2.unread, ['backups']);
  assert.equal(await measure(path.join(dir, 'missing')), null);
});
