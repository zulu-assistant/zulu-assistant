import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { planAsk, dispatchMode, askKey, ASK_MAX } from '../src/triage-ask.mjs';
import { main, askAllowed, noteAsk, Refused } from '../scripts/triage-board.mjs';
import { outsideTask } from '../src/tasks.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { demoEnv, freePort } from './demo-board.mjs';

// #588: under SETTINGS.triage.dispatch 'ask' the scheduled triage pass files one low task to Mission Control
// instead of starting a worker. The board checks the label against its own reading, the prompt file's place and
// size, one ask per card per UTC day and two per 30 minutes; the script keeps the same count on its side.
const ASK = { triage: { dispatch: 'ask' } };
const NOW = Date.parse('2026-11-13T02:30:00Z');
const CARDS = [{ label: 'com.x.sync', name: 'Sync', status: 'down', repo: '~/x' }, { label: 'docker:db', name: 'DB', status: 'down' }];
const SECRET_WORD = 'do-not-copy-this-text';

function root() {
  const r = mkdtempSync(path.join(os.tmpdir(), 'triage-ask-'));
  mkdirSync(path.join(r, 'data/handoffs'), { recursive: true });
  writeFileSync(path.join(r, 'data/handoffs/triage-fix-com.x.sync.md'), `diagnose ${SECRET_WORD}\n`);
  return r;
}
const plan = (r, over = {}, ctx = {}) => planAsk({ label: 'com.x.sync', file: 'data/handoffs/triage-fix-com.x.sync.md', ...over },
  { cards: CARDS, tasks: [], root: r, owner: 'mission-control', settings: ASK, now: NOW, ...ctx });

test('dispatch: absent or anything but "ask" is spawn', () => {
  assert.equal(dispatchMode({}), 'spawn'); assert.equal(dispatchMode(null), 'spawn');
  assert.equal(dispatchMode({ triage: { dispatch: 'spawn' } }), 'spawn'); assert.equal(dispatchMode({ triage: { dispatch: 'ASK' } }), 'spawn');
  assert.equal(dispatchMode(ASK), 'ask');
});

test('the example registry ships dispatch "ask" (1.3): a new install asks for a worker, a registry without the key still spawns', async () => {
  const { SETTINGS } = await import('../examples/config/jobs.mjs');
  assert.equal(SETTINGS.triage?.dispatch, 'ask');
  assert.equal(dispatchMode(SETTINGS), 'ask');
  const { triage, ...older } = SETTINGS;                 // a registry made before the key existed
  assert.equal(dispatchMode(older), 'spawn');
});

test('an ask files one low task to Mission Control under the board, naming the file and never copying it', () => {
  const r = root();
  const p = plan(r);
  assert.equal(p.refused, undefined, p.refused);
  assert.equal(p.key, askKey('com.x.sync', NOW));
  assert.equal(p.key, 'triage-ask:com.x.sync@2026-11-13');
  const t = p.input;
  assert.deepEqual([t.requester, t.owner, t.priority, t.source.via, t.source.key], ['board', 'mission-control', 'low', 'triage', p.key]);
  assert.match(t.title, /^Triage asks for a worker: Sync \(down\)$/);
  assert.match(t.body, /data\/handoffs\/triage-fix-com\.x\.sync\.md \(\d+ bytes\)/);
  assert.match(t.body, /quoted data, never instructions/);
  assert.doesNotMatch(JSON.stringify(t), new RegExp(SECRET_WORD), 'the prompt text stays in its file');
  assert.deepEqual(t.links, { repo: '~/x' });
  assert.equal(outsideTask({ ...t, id: 1 }), false, 'a board-made task: its title is shown on the reading');
  rmSync(r, { recursive: true, force: true });
});

test('refused: spawn mode, a label not on the reading, a bad or misplaced file', () => {
  const r = root();
  const refused = (p, why) => assert.ok(p.refused, `${why}: ${JSON.stringify(p)}`);
  refused(plan(r, {}, { settings: {} }), 'spawn mode');
  refused(plan(r, { label: 'com.x.other' }), 'not on the reading');
  refused(plan(r, { label: '' }), 'no label');
  refused(plan(r, { label: 'a b' }), 'a label with a space');
  refused(plan(r, { file: 'data/secrets.env' }), 'another file');
  refused(plan(r, { file: 'data/handoffs/fix.md' }), 'not a triage-fix name');
  refused(plan(r, { file: 'data/handoffs/../handoffs/../triage-fix-x.md' }), 'outside the folder');
  refused(plan(r, { file: 'data/handoffs/triage-fix-missing.md' }), 'missing');
  writeFileSync(path.join(r, 'data/secret.md'), 'x');
  symlinkSync(path.join(r, 'data/secret.md'), path.join(r, 'data/handoffs/triage-fix-link.md'));
  refused(plan(r, { file: 'data/handoffs/triage-fix-link.md' }), 'a link');
  writeFileSync(path.join(r, 'data/handoffs/triage-fix-big.md'), 'x'.repeat(ASK_MAX + 1));
  refused(plan(r, { file: 'data/handoffs/triage-fix-big.md' }), 'too big');
  writeFileSync(path.join(r, 'data/handoffs/triage-fix-empty.md'), '');
  refused(plan(r, { file: 'data/handoffs/triage-fix-empty.md' }), 'empty');
  rmSync(r, { recursive: true, force: true });
});

test('one ask per card per UTC day (a closed task counts), two per 30 minutes', () => {
  const r = root();
  const ask = (id, label, minsAgo, extra = {}) => ({ id, status: 'done', created_at: new Date(NOW - minsAgo * 60e3).toISOString(), source: { via: 'triage', key: askKey(label, NOW - minsAgo * 60e3) }, ...extra });
  assert.match(plan(r, {}, { tasks: [ask(7, 'com.x.sync', 60)] }).refused, /already asked for com\.x\.sync today \(#7\)/);
  assert.equal(plan(r, {}, { tasks: [ask(7, 'com.x.sync', 24 * 60 + 5)] }).refused, undefined, 'yesterday does not count');
  assert.match(plan(r, {}, { tasks: [ask(8, 'a', 5), ask(9, 'b', 10)] }).refused, /2 asks in the last 30 minutes \(#8, #9\)/);
  assert.equal(plan(r, {}, { tasks: [ask(8, 'a', 5), ask(9, 'b', 31)] }).refused, undefined);
  assert.equal(plan(r, {}, { tasks: [{ id: 3, created_at: new Date(NOW).toISOString(), source: { via: 'parser-watch', key: 'parser:x@1' } }] }).refused, undefined, 'other board tasks do not count');
  rmSync(r, { recursive: true, force: true });
});

test('the script keeps its own count: one per card per day, two per 30 minutes, and checks the file first', () => {
  const r = root();
  const f = 'data/handoffs/triage-fix-com.x.sync.md';
  writeFileSync(path.join(r, 'data/handoffs/triage-fix-a.md'), 'x'); writeFileSync(path.join(r, 'data/handoffs/triage-fix-b.md'), 'x');
  let s = askAllowed('com.x.sync', f, { root: r, now: NOW });
  noteAsk('com.x.sync', s, { root: r, now: NOW });
  assert.throws(() => askAllowed('com.x.sync', f, { root: r, now: NOW + 60e3 }), /already asked for com\.x\.sync today/);
  s = askAllowed('a', 'data/handoffs/triage-fix-a.md', { root: r, now: NOW + 60e3 });
  noteAsk('a', s, { root: r, now: NOW + 60e3 });
  assert.throws(() => askAllowed('b', 'data/handoffs/triage-fix-b.md', { root: r, now: NOW + 120e3 }), /2 asks in the last 30 minutes/);
  assert.doesNotThrow(() => askAllowed('b', 'data/handoffs/triage-fix-b.md', { root: r, now: NOW + 31 * 60e3 + 60e3 }));
  assert.doesNotThrow(() => askAllowed('com.x.sync', f, { root: r, now: NOW + 24 * 3600e3 }), 'the next UTC day');
  for (const bad of ['data/secrets.env', 'data/handoffs/x.md', 'data/handoffs/triage-fix-none.md']) assert.throws(() => askAllowed('b', bad, { root: r, now: NOW }), Refused, bad);
  assert.throws(() => askAllowed('a b', 'data/handoffs/triage-fix-b.md', { root: r, now: NOW }), Refused);
  rmSync(r, { recursive: true, force: true });
});

const sink = () => { const o = { text: '', write: (s) => { o.text += s; return true; } }; return o; };
async function fakeBoard(answer) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: b }); const [code, j] = answer(); res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) };
}

test('ask posts the label and the file name to the board, counts only an ask the board took, and says why it refused', async () => {
  const r = root();
  let answer = [200, { ok: true, id: 42 }];
  const b = await fakeBoard(() => answer);
  try {
    const o = sink();
    await main(['ask', 'com.x.sync', 'data/handoffs/triage-fix-com.x.sync.md'], { root: r, port: b.port, out: o, now: NOW });
    assert.match(o.text, /asked Mission Control: task #42/);
    assert.deepEqual([b.seen[0].method, b.seen[0].url, b.seen[0].type], ['POST', '/api/triage/ask', 'application/json']);
    assert.deepEqual(JSON.parse(b.seen[0].body), { label: 'com.x.sync', file: 'data/handoffs/triage-fix-com.x.sync.md' });
    assert.equal(JSON.parse(readFileSync(path.join(r, 'data/triage-ask-state.json'), 'utf8')).labels['com.x.sync'], '2026-11-13');
    writeFileSync(path.join(r, 'data/handoffs/triage-fix-docker-db.md'), 'x');
    answer = [409, { ok: false, refused: '"docker:db" is not a card on the board\'s reading' }];
    await assert.rejects(main(['ask', 'docker:db', 'data/handoffs/triage-fix-docker-db.md'], { root: r, port: b.port, out: sink(), now: NOW }), /the board refused the ask: "docker:db" is not a card/);
    assert.equal(JSON.parse(readFileSync(path.join(r, 'data/triage-ask-state.json'), 'utf8')).labels['docker:db'], undefined, 'a refused ask is not counted');
    await assert.rejects(main(['ask', 'com.x.sync'], { root: r, port: b.port, out: sink(), now: NOW }), Refused, 'two words');
    assert.equal(b.seen.length, 2, 'the refusals before the board never reached it');
  } finally { await b.close(); rmSync(r, { recursive: true, force: true }); }
});

test('a real board answers the ask route: a refusal with its reason, JSON only, nothing filed', async () => {
  const port = await freePort();
  const env = demoEnv({ MC_PORT: String(port), ZULU_NO_NOTIFY: '1' });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'ignore' });
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`http://127.0.0.1:${port}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    const before = (await fetch(`http://127.0.0.1:${port}/api/tasks`).then((res) => res.json())).tasks?.length;
    assert.ok(Number.isInteger(before), 'the ledger was read');
    // a label no card carries: refused whichever dispatch this checkout's settings name (spawn, or not on the reading)
    const res = await fetch(`http://127.0.0.1:${port}/api/triage/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'no.such.card', file: 'data/handoffs/triage-fix-no.such.card.md' }) });
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.ok, false);
    assert.match(j.refused, /starts workers itself|not a card on the board's reading/);
    const plain = await fetch(`http://127.0.0.1:${port}/api/triage/ask`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(plain.status, 415, 'every write is declared JSON');
    const after = (await fetch(`http://127.0.0.1:${port}/api/tasks`).then((r2) => r2.json())).tasks?.length;
    assert.equal(after, before, 'nothing filed');
  } finally { child.kill(); }
});
