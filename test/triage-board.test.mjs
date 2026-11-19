import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { triageAllowed, policyList, FIXED_HEAD, SPAWN } from '../scripts/triage-allow.mjs';
import { SEVERITY } from '../src/triage-reading.mjs';
import { eventBody, boardPort, stamp, readState, markState, main, Refused, EVENT_MAX } from '../scripts/triage-board.mjs';

// #588: the scheduled triage pass reaches the board only through scripts/triage-board.sh, and its allow list
// holds exact restarts built from the registry: no free curl, cat or date, no paid or outbound job.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
// The procedures a test may hold to today's wording. The example always. The overlay twin only in the source
// repository, where it is a tracked file kept in step with the example (the folder of public-only files exists only
// there). In an install, `overlay/config/TRIAGE.md` is the owner's own file: an upgrade never changes it, so one seeded
// by an older release keeps its old steps, and a test that read it failed the upgrade's test step and rolled every
// upgrade from 1.2.3 back (found in the 1.3.0 upgrade rehearsal).
const SOURCE_REPO = existsSync(path.join(ROOT, 'publish/public'));
const PROCEDURES = ['examples/config/TRIAGE.md', ...(SOURCE_REPO ? ['overlay/config/TRIAGE.md'] : [])];
const UID = 501;
const JOBS = [{ label: 'com.x.sync' }, { label: 'com.x.mailer' }, { label: 'com.x.ads' }, { label: 'com.x.sync' }, { label: 'bad label' }, { label: 'x;y' }, {}];
const CONTAINERS = [{ name: 'db' }, { name: 'cache' }, { name: '$(x)' }];
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'triage-board-'));

test('the allow list: the fixed calls, one exact kickstart per job not paid or outbound, one restart per container', () => {
  const list = triageAllowed({ jobs: JOBS, containers: CONTAINERS, paidOrOutbound: ['com.x.mailer', 'com.x.ads'], uid: UID });
  assert.deepEqual(list, [
    ...FIXED_HEAD,
    'Bash(launchctl kickstart gui/501/com.x.sync)',
    'Bash(docker restart cache)', 'Bash(docker restart db)',
    SPAWN,
  ]);
  for (const e of list) {
    assert.doesNotMatch(e, /^Bash\((curl|cat|date|cmux read-screen|cmux list-workspaces|launchctl kickstart:|docker restart:)/, e);
    assert.doesNotMatch(e, /com\.x\.(mailer|ads)/, 'no paid or outbound label');
    assert.doesNotMatch(e, /^(Read|Write|Edit)$|^(Read|Write)\(/, 'no file tool by name, no read rule');
  }
  assert.ok(list.includes('Bash(scripts/triage-board.sh:*)'));
  assert.ok(list.includes("Bash(cmux notify --title 'Triage':*)"));
  assert.ok(list.includes('Edit(/data/handoffs/triage-*)'), 'the one file rule (probed: covers Write, anchored at the working folder)');
  // dispatch 'ask': the spawn leaves the list, nothing else changes
  const ask = triageAllowed({ jobs: JOBS, containers: CONTAINERS, paidOrOutbound: ['com.x.mailer', 'com.x.ads'], uid: UID, dispatch: 'ask' });
  assert.deepEqual(ask, list.filter((e) => e !== SPAWN));
});

test('no kickstart on the list ends a running job, and both procedures leave a due card alone', () => {
  // a pass once ran `kickstart -k` on a long job late in its run: -k ends a running instance first
  const list = triageAllowed({ jobs: [{ label: 'com.x.a' }, { label: 'com.x.b' }], containers: [], paidOrOutbound: [], uid: UID });
  const kicks = list.filter((e) => e.includes('kickstart'));
  assert.equal(kicks.length, 2);
  for (const e of kicks) assert.match(e, /^Bash\(launchctl kickstart gui\/501\/com\.x\.[ab]\)$/, e);
  for (const rel of PROCEDURES) {
    const file = path.join(ROOT, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    assert.match(text, /reads `due` is inside its grace period and may be running right now: never restart it, never ask or dispatch for it/, rel);
    assert.match(text, /a container restart only for a container card that reads `down`/, rel);
    // every status the reading can give is named in exactly one group (MC's dry runs: an amber queue card was asked about)
    const group = (re) => { const m = text.match(re); assert.ok(m, `${rel}: ${re}`); return [...m[1].matchAll(/`([a-z]+)`/g)].map((x) => x[1]); };
    const report = group(/A card that reads ((?:`[a-z]+`,? (?:or )?)+)is not a fault: report it with its detail .*?never restart, ask or dispatch for it\./);
    const act = group(/A fix or an ask is only for a card that reads ((?:`[a-z]+`,? ?(?:or )?)+)\./);
    assert.deepEqual(report, ['due', 'warn', 'amber', 'unknown', 'info'], rel);
    assert.deepEqual([...act, ...report].sort(), [...SEVERITY].sort(), `${rel}: both groups = the reading's statuses`);
    assert.doesNotMatch(text, /kickstart -k/, rel);
  }
});

test('a policy that cannot be read gives no kickstart; a policy with no list gives every job', () => {
  const none = triageAllowed({ jobs: JOBS, containers: [], paidOrOutbound: null, uid: UID });
  assert.equal(none.filter((e) => e.includes('kickstart')).length, 0);
  const d = tmp();
  writeFileSync(path.join(d, 'p.json'), '{ not json');
  assert.equal(policyList(path.join(d, 'p.json')), null);
  assert.equal(policyList(path.join(d, 'missing.json')), null);
  writeFileSync(path.join(d, 'p.json'), '{"lists":{}}');
  assert.deepEqual(policyList(path.join(d, 'p.json')), []);
  writeFileSync(path.join(d, 'p.json'), '{"lists":{"paidOrOutbound":["a"]}}');
  assert.deepEqual(policyList(path.join(d, 'p.json')), ['a']);
  assert.throws(() => triageAllowed({ jobs: [], containers: [], paidOrOutbound: [] }), /user id/);
  rmSync(d, { recursive: true, force: true });
});

test('triage.sh starts the pass with the generated list and prints the same list, also inside the procedure; the dispatch block follows the setting', { skip: !existsSync('/bin/zsh') && 'no zsh' }, () => {
  const uid = process.getuid();
  for (const dispatch of ['spawn', 'ask']) {
    const d = tmp();
    mkdirSync(path.join(d, 'config'));
    const examples = JSON.stringify(path.join(ROOT, 'examples/config/jobs.mjs'));
    writeFileSync(path.join(d, 'config/jobs.mjs'), `export * from ${examples};\nimport { SETTINGS as S } from ${examples};\n`
      + `export const JOBS = [{ label: 'com.t.safe', name: 'Safe' }, { label: 'com.t.paid', name: 'Paid' }];\n`
      + `export const DOCKER_CONTAINERS = [{ name: 'c1' }];\n`
      + `export const SETTINGS = { ...S, triage: { dispatch: '${dispatch}' } };\n`);   // each mode named: the example ships 'ask' since 1.3
    writeFileSync(path.join(d, 'policy.json'), JSON.stringify({ lists: { paidOrOutbound: ['com.t.paid'] } }));
    copyFileSync(path.join(ROOT, 'examples/config/TRIAGE.md'), path.join(d, 'config/TRIAGE.md'));
    const env = { ...process.env, MC_OVERLAY: d };
    const a = spawnSync('/bin/zsh', [path.join(ROOT, 'scripts/triage.sh'), '--print-allowed'], { encoding: 'utf8', env });
    assert.equal(a.status, 0, a.stderr);
    const started = a.stdout.trim().split('\n');
    assert.deepEqual(started, [...FIXED_HEAD, `Bash(launchctl kickstart gui/${uid}/com.t.safe)`, 'Bash(docker restart c1)', ...(dispatch === 'ask' ? [] : [SPAWN])], dispatch);
    const p = spawnSync('/bin/zsh', [path.join(ROOT, 'scripts/triage.sh'), '--print-prompt'], { encoding: 'utf8', env });
    assert.equal(p.status, 0, p.stderr);
    assert.doesNotMatch(p.stdout, /<ALLOWED_CALLS>|<\/?IF_(ASK|SPAWN)>/);
    const printed = [...p.stdout.matchAll(/^ {3}- `((?:launchctl kickstart|docker restart) [^`]+)`$/gm)].map((m) => `Bash(${m[1]})`);
    assert.deepEqual(printed, started.filter((e) => /^Bash\((launchctl kickstart|docker restart) /.test(e)), 'printed = started');
    assert.doesNotMatch(p.stdout, /com\.t\.paid/);
    if (dispatch === 'ask') {
      assert.match(p.stdout, /`scripts\/triage-board\.sh ask <label> data\/handoffs\/triage-fix-<label>\.md`/);
      assert.doesNotMatch(p.stdout, /agent-spawn/, 'the procedure never names the spawn when it is off the list');
    } else {
      assert.match(p.stdout, /`scripts\/agent-spawn\.sh "fix: <name>"/);
      assert.doesNotMatch(p.stdout, /triage-board\.sh ask/);
    }
    rmSync(d, { recursive: true, force: true });
  }
  // the pass is started with exactly that list, one argument per entry
  const sh = readFileSync(path.join(ROOT, 'scripts/triage.sh'), 'utf8');
  assert.match(sh, /^ALLOWED=\("\$\{\(@f\)\$\(allowed \|\| true\)\}"\)$/m);
  assert.match(sh, /--allowedTools "\$\{ALLOWED\[@\]\}" <<< /);   // an empty list stops the pass: test/triage-start.test.mjs
  assert.doesNotMatch(sh, /Bash\((curl|cat|date)[:)]/);
});

test('both procedures reach the board through the script, show no curl, and keep the restart placeholder', () => {
  for (const f of PROCEDURES) {
    if (!existsSync(path.join(ROOT, f))) continue;
    const t = readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(t, /`scripts\/triage-board\.sh read`/, f);
    assert.match(t, /`scripts\/triage-board\.sh event data\/handoffs\/triage-<STAMP>\.event\.json`/, f);
    assert.match(t, /^<ALLOWED_CALLS>$/m, f);
    // one block per dispatch, each opened and closed on a line of its own
    for (const m of ['IF_ASK', 'IF_SPAWN']) assert.equal((t.match(new RegExp(`^<${m}>$`, 'gm')) || []).length, 1, `${f} <${m}>`), assert.equal((t.match(new RegExp(`^</${m}>$`, 'gm')) || []).length, 1, `${f} </${m}>`);
    assert.doesNotMatch(t, /Read tool|Edit tool|four tools/, `${f}: the pass has Bash and Write only`);
    assert.doesNotMatch(t, /`(curl|cat|date) [^`]*`|read-screen|list-workspaces|localhost:3210/, f);   // no such call is shown
  }
});

test('the board address comes from the checkout, never from the environment', () => {
  const d = tmp();
  assert.equal(boardPort(d), 3210);
  mkdirSync(path.join(d, 'data'));
  writeFileSync(path.join(d, 'data/local.env'), '# x\nMC_PORT=3299\n');
  const saved = process.env.MC_PORT; process.env.MC_PORT = '9';
  try { assert.equal(boardPort(d), 3299); } finally { if (saved === undefined) delete process.env.MC_PORT; else process.env.MC_PORT = saved; }
  assert.match(stamp(new Date('2026-11-12T22:30:41Z')), /^2026-11-12-2230$/);
  rmSync(d, { recursive: true, force: true });
});

function handoffs() {
  const root = tmp();
  mkdirSync(path.join(root, 'data/handoffs'), { recursive: true });
  return root;
}

test('an event file is sent only from its place and shape; the body is rebuilt, not passed on', () => {
  const root = handoffs();
  const h = (n) => path.join(root, 'data/handoffs', n);
  const good = 'triage-2026-11-12-2230.event.json';
  writeFileSync(h(good), '{"kind":"sys","text":"triage: 0 red, 4 amber"}');
  assert.equal(eventBody(`data/handoffs/${good}`, { root, cwd: root }), '{"kind":"sys","text":"triage: 0 red, 4 amber"}');
  assert.equal(eventBody(h(good), { root, cwd: '/' }), '{"kind":"sys","text":"triage: 0 red, 4 amber"}');
  const refused = (arg, why) => assert.throws(() => eventBody(arg, { root, cwd: root }), Refused, why);
  refused('data/handoffs/x.event.json', 'name');
  refused('data/secrets.env', 'outside');
  refused(`data/handoffs/../handoffs/../${good}`, 'dot-dot out');
  refused(`data/handoffs/triage-2026-11-12-2231.event.json`, 'missing');
  writeFileSync(path.join(root, 'data/secret.json'), '{"kind":"sys","text":"s"}');
  symlinkSync(path.join(root, 'data/secret.json'), h('triage-2026-11-12-0000.event.json'));
  refused('data/handoffs/triage-2026-11-12-0000.event.json', 'a link');
  const bad = (body, why) => { writeFileSync(h('triage-2026-11-12-0001.event.json'), body); refused('data/handoffs/triage-2026-11-12-0001.event.json', why); };
  bad(JSON.stringify({ kind: 'sys', text: 'x'.repeat(EVENT_MAX) }), 'over 1 KB');
  bad('not json', 'not JSON');
  bad('[1]', 'not an object');
  bad('{"kind":"bad","text":"x"}', 'kind');
  bad('{"kind":"sys","text":"x","url":"http://e"}', 'extra key');
  bad('{"kind":"sys","text":"  "}', 'empty');
  bad('{"kind":"sys","text":"a\\nb"}', 'line break');
  bad('{"kind":"sys","text":"a\\u001b[2Jb"}', 'escape');
  bad('{"kind":"sys","text":"a\\u2028b"}', 'line separator');
  rmSync(root, { recursive: true, force: true });
});

test('the script refuses every other call before it reaches any address', () => {
  const run = (...a) => spawnSync('/bin/sh', [path.join(ROOT, 'scripts/triage-board.sh'), ...a], { encoding: 'utf8', env: { ...process.env, MC_PORT: '1' } });
  for (const args of [[], ['get'], ['read', 'http://example.com/'], ['read', '--url', 'x'], ['curl', 'https://example.com'], ['event'],
    ['event', 'a', 'b'], ['event', 'data/secrets.env'], ['mark'], ['state', 'x'], ['stamp', '-u'], ['--help']]) {
    const r = run(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /triage-board: /);
  }
  const s = run('stamp');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /^\d{4}-\d{2}-\d{2}-\d{4}\n$/);
});

async function fakeBoard(cards) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, type: req.headers['content-type'], body: b });
      if (req.method === 'GET' && req.url === '/api/triage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ cards })); }
      if (req.method === 'POST' && req.url === '/api/event') { res.writeHead(200); return res.end('{"ok":true}'); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, seen, close: () => new Promise((r) => srv.close(r)) };
}
const sink = () => { const o = { text: '', write: (s) => { o.text += s; return true; } }; return o; };

test('read, event and mark talk to the board the script was given, and mark takes only a label on the reading', async () => {
  const b = await fakeBoard([{ label: 'com.x.sync', status: 'down' }, { label: 'brain:autopilot', status: 'warn' }]);
  const root = handoffs();
  try {
    let o = sink(); await main(['read'], { root, port: b.port, out: o });
    assert.match(o.text, /com\.x\.sync/);
    writeFileSync(path.join(root, 'data/handoffs/triage-2026-11-12-2230.event.json'), '{"kind":"sys","text":"triage: ok"}');
    const cwd = process.cwd(); process.chdir(root);
    try { o = sink(); await main(['event', 'data/handoffs/triage-2026-11-12-2230.event.json'], { root, port: b.port, out: o }); } finally { process.chdir(cwd); }
    const ev = b.seen.find((x) => x.method === 'POST');
    assert.deepEqual([ev.url, ev.type, ev.body], ['/api/event', 'application/json', '{"kind":"sys","text":"triage: ok"}']);
    assert.deepEqual(readState(root), {});
    o = sink(); await main(['mark', 'com.x.sync'], { root, port: b.port, out: o });
    await main(['mark', 'brain:autopilot'], { root, port: b.port, out: sink() });
    assert.deepEqual(Object.keys(readState(root)).sort(), ['brain:autopilot', 'com.x.sync']);
    await assert.rejects(main(['mark', 'data/secrets.env'], { root, port: b.port, out: sink() }), Refused);
    await assert.rejects(main(['mark', 'com.x.other'], { root, port: b.port, out: sink() }), Refused);
    assert.ok(b.seen.every((x) => ['/api/triage', '/api/event'].includes(x.url)), 'no other path');
  } finally { await b.close(); rmSync(root, { recursive: true, force: true }); }
});

test('state reads the cooldowns and refuses a file that is not an object of them', () => {
  const root = handoffs();
  assert.deepEqual(readState(root), {});
  markState('a', ['a'], { root, now: 1_000_000 });
  assert.deepEqual(readState(root), { a: 1000 });
  assert.throws(() => markState('b', ['a'], { root }), Refused);
  writeFileSync(path.join(root, 'data/triage-state.json'), '[]');
  assert.throws(() => readState(root), Refused);
  rmSync(root, { recursive: true, force: true });
});
