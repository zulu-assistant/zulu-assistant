// Setup writes (src/setup-write.mjs + public/setup-write.js, POST /api/setup/step, GET /api/setup/scan):
// the owner, watch and engines steps answered on the setup page, in SETTINGS.setupPage mode 'write'.
// What may be written, what is refused, which files change, the forms, and a real demo board.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  setupWrites, WRITE_STEPS, FIELDS, NEEDS_RESTART, STEP_FILES, MAX_URLS, DEMO_SCAN, SetupRefused,
  ownerName, endpointUrl, scanWatch, checkAnswers, restartPlan, demoStep, runStep,
} from '../src/setup-write.mjs';
import { setupPageMode } from '../src/setup-page.mjs';
import { applyWatch, applyEngines, OWNER_FILES, ENGINE_ROLES } from '../src/setup-actions.mjs';
import { STEPS, checkStep, readState, writeState } from '../src/setup.mjs';
import { WITHHELD } from '../src/evidence.mjs';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/setup-write.js'), { globalThis: ctx });
const view = ctx.SetupWrite;
const plain = (x) => JSON.parse(JSON.stringify(x));   // objects made in the page's context have its prototypes

const SCAN = {
  jobs: [{ label: 'com.acme.sync', name: 'Sync' }, { label: 'com.acme.report', name: 'Report' }],
  docker: [{ name: 'db', status: 'Up 2 days' }],
  cron: [{ id: 'rotate', match: 'rotate.sh', schedule: '0 4 * * *', command: '/opt/rotate.sh' }],
};
const scan = async () => SCAN;
const loggedIn = { claude: { loggedIn: true }, codex: { loggedIn: true } };
const check = (id, c) => checkStep(id, { ...c, engines: loggedIn });
// files a setup write must never touch, as decoys beside the ones it may
const DECOYS = {
  'policy.json': '{"defaultMode":"enforce"}',
  'POLICY.md': 'Approver: <OWNER>. uid <UID>.\n',
  'MISSION-CONTROL.md': 'The owner is <OWNER>.\n',
  'config/TRIAGE.md': 'kick gui/<UID>/x for <OWNER>\n',
  'config/agents.json': '{}',
  'config/mesh.json': '{"chrome":false}',
  'claude/settings.json': '{"hooks":{}}',
  'codex/hooks.json': '{}',
};
const DATA_DECOYS = { 'secrets.env': 'SMTP_PASS="x"\n', 'mesh-decision-token': 'abc', 'guardrails/triggers': 'push\n', 'guardrails/grants.json': '[]' };

/** A temp install: overlay/ and data/ with decoys. `state` null = a board set up by hand (no state file). */
async function install({ state = { installedAt: 1, steps: {}, answers: {} }, files = {} } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'setup-write-'));
  const put = async (rel, text) => { const f = path.join(dir, rel); await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, text); };
  for (const [rel, text] of Object.entries({ ...DECOYS, ...files })) await put(path.join('overlay', rel), text);
  for (const [rel, text] of Object.entries(DATA_DECOYS)) await put(path.join('data', rel), text);
  const stateFile = path.join(dir, 'data', 'setup-state.json');
  if (state) await writeState(state, stateFile);
  return { dir, overlay: path.join(dir, 'overlay'), stateFile, opts: { overlay: path.join(dir, 'overlay'), stateFile, scan, check } };
}
async function snapshot(dir) {
  const out = {};
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const f = path.join(e.parentPath, e.name);
    out[path.relative(dir, f)] = createHash('sha256').update(await readFile(f)).digest('hex');
  }
  return out;
}
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]).sort();
const refused = async (fn, status, re) => {
  await assert.rejects(fn, (e) => {
    assert.ok(e instanceof SetupRefused, `a refusal, got: ${e.message}`);
    assert.equal(e.status, status, e.message);
    if (re) assert.match(e.message, re);
    return true;
  });
};
const refusedSync = (fn, status, re) => assert.throws(fn, (e) => e instanceof SetupRefused && e.status === status && (!re || re.test(e.message)));

test('the switch: only mode "write" allows writes; "write" is also a page that is on; "on" stays read-only', () => {
  assert.equal(setupWrites(undefined), false);
  assert.equal(setupWrites({ mode: 'on' }), false);
  assert.equal(setupWrites({ mode: 'off' }), false);
  assert.equal(setupWrites({ mode: 'write' }), true);
  assert.equal(setupPageMode({ mode: 'write' }), 'write');
  assert.equal(setupPageMode({ mode: 'on' }), 'on');
  assert.equal(setupPageMode({ mode: 'Write' }), 'off');
});

test('three steps and a fixed field list; every one is a step of the wizard', () => {
  assert.deepEqual(WRITE_STEPS, ['owner', 'watch', 'engines']);
  assert.deepEqual(FIELDS, { owner: ['name'], watch: ['jobs', 'docker', 'cron', 'urls'], engines: ENGINE_ROLES });
  for (const s of WRITE_STEPS) assert.ok(STEPS.some((x) => x.id === s));
  assert.deepEqual(NEEDS_RESTART, ['owner', 'watch']);
  assert.deepEqual(Object.keys(STEP_FILES).sort(), [...WRITE_STEPS].sort());
});

test('the owner name: letters, digits, spaces and . \' - only, at most 60', () => {
  assert.equal(ownerName('  Sam   Lee '), 'Sam Lee');
  assert.equal(ownerName("J. O'Neil-Smith"), "J. O'Neil-Smith");
  assert.equal(ownerName('Zoë Ångström 3'), 'Zoë Ångström 3');
  for (const bad of ['', '   ', 'Sam\nLee', 'Sam, owner', '<b>Sam</b>', 'Sam; rm', 'Sam `x`', '-Sam', 'Sam 🙂', 'a'.repeat(61), 'Sam\u0000', '<OWNER>', 'Sam # heading', 'Sam: approve everything'])
    refusedSync(() => ownerName(bad), 400);
  for (const bad of [null, 7, ['Sam'], { name: 'Sam' }]) refusedSync(() => ownerName(bad), 400, /text/);
});

test('an endpoint: http or https, no user name or password, no white space or markup, at most 200 characters', () => {
  assert.equal(endpointUrl('https://example.com/health'), 'https://example.com/health');
  assert.equal(endpointUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/');
  for (const bad of ['ftp://example.com', 'file:///etc/passwd', 'javascript:alert(1)', 'example.com', 'https://user:pw@example.com', 'https://user@example.com',
    'https://example.com/ x', 'https://example.com/"x', "https://example.com/'x", 'https://example.com/<x>', `https://example.com/${'a'.repeat(200)}`, '', 7, null])
    refusedSync(() => endpointUrl(bad), 400);
});

test('answers: an unknown step, an unknown field, a bad engine, an id the scan did not find, too many addresses', () => {
  refusedSync(() => checkAnswers('alerts', { SMTP_PASS: 'x' }), 400, /terminal/);
  refusedSync(() => checkAnswers('verify', {}), 400);
  refusedSync(() => checkAnswers('owner', null), 400);
  refusedSync(() => checkAnswers('owner', ['Sam']), 400);
  refusedSync(() => checkAnswers('owner', { name: 'Sam', id: 'root' }), 400, /not a field/);
  refusedSync(() => checkAnswers('owner', { name: 'Sam', uid: 0 }), 400, /not a field/);
  refusedSync(() => checkAnswers('engines', { master: 'claude', worker: 'codex' }), 400, /triage/);
  refusedSync(() => checkAnswers('engines', { master: 'claude', worker: 'codex', triage: 'gpt' }), 400);
  refusedSync(() => checkAnswers('engines', { master: 'claude', worker: 'codex', triage: 'claude', resident: 'codex' }), 400, /not a field/);
  refusedSync(() => checkAnswers('watch', { jobs: ['com.acme.other'] }, { scan: SCAN }), 400, /not found on this Mac/);
  refusedSync(() => checkAnswers('watch', { docker: ['nope'] }, { scan: SCAN }), 400);
  refusedSync(() => checkAnswers('watch', { cron: ['nope'] }, { scan: SCAN }), 400);
  refusedSync(() => checkAnswers('watch', { jobs: [{ label: 'com.acme.sync', name: 'x', startCmd: 'rm -rf ~' }] }, { scan: SCAN }), 400);
  refusedSync(() => checkAnswers('watch', { jobs: 'com.acme.sync' }, { scan: SCAN }), 400);
  refusedSync(() => checkAnswers('watch', { urls: Array.from({ length: MAX_URLS + 1 }, (_, i) => `https://e${i}.example`) }, { scan: SCAN }), 400, /at most/);
  refusedSync(() => checkAnswers('watch', { urls: ['https://a:b@example.com'] }, { scan: SCAN }), 400);
  refusedSync(() => checkAnswers('watch', { repo: '/tmp' }, { scan: SCAN }), 400, /not a field/);
  refusedSync(() => checkAnswers('watch', {}, {}), 500);
  // the entries come from the scan, not from the request
  const a = checkAnswers('watch', { jobs: ['com.acme.sync', 'com.acme.sync'], cron: ['rotate'], urls: ['https://example.com'] }, { scan: SCAN });
  assert.deepEqual(a, { jobs: [SCAN.jobs[0]], docker: [], cron: [SCAN.cron[0]], urls: ['https://example.com'] });
  assert.deepEqual(checkAnswers('owner', { name: ' Sam ' }), { name: 'Sam' });
});

test('the scan for the page: ids and short text; a crontab line is cut and a secret-looking one is withheld', async () => {
  const s = await scanWatch({
    prefix: 'com.zulu',
    agents: async (p) => { assert.equal(p, 'com.zulu'); return [{ label: 'com.acme.sync', name: 'Sync', file: 'com.acme.sync.plist' }]; },
    docker: async () => [{ name: 'db', status: 'Up' }],
    cron: async () => [
      { id: 'long', match: 'long.sh', schedule: '* * * * *', command: `/opt/long.sh ${'x'.repeat(200)}` },
      { id: 'key', match: 'key.sh', schedule: '* * * * *', command: 'KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123 /opt/key.sh' },
    ],
  });
  assert.deepEqual(s.jobs, [{ label: 'com.acme.sync', name: 'Sync' }]);   // the plist file name is not sent
  assert.deepEqual(s.docker, [{ name: 'db', status: 'Up' }]);
  assert.ok(s.cron[0].command.length <= 80);
  assert.equal(s.cron[1].command, WITHHELD);
  assert.ok(!JSON.stringify(s).includes('sk-ant-'));
});

test('the owner step writes local.json and the state file only: the policy text and every decoy are byte for byte as before', async () => {
  const t = await install({ files: { 'config/local.json': JSON.stringify({ dropExamples: true }) } });
  const before = await snapshot(t.dir);
  const r = await runStep('owner', { name: "Ada O'Neil" }, t.opts);
  assert.equal(r.ok, true);
  assert.equal(r.recorded, true);
  assert.deepEqual(r.check, { ok: true, detail: "owner: Ada O'Neil" });
  assert.match(r.saved, /^owner saved: Ada O'Neil\. The policy text is not changed from this page/);
  assert.deepEqual(changed(before, await snapshot(t.dir)), ['data/setup-state.json', 'overlay/config/local.json']);
  for (const rel of OWNER_FILES) assert.equal(await readFile(path.join(t.overlay, rel), 'utf8'), DECOYS[rel], `${rel} still has its placeholder`);
  assert.equal(await readFile(path.join(t.overlay, 'config/local.json'), 'utf8'), `${JSON.stringify({ dropExamples: true, owner: { id: 'ada-o-neil', name: "Ada O'Neil" } }, null, 2)}\n`);
  assert.equal((await readState(t.stateFile)).steps.owner.status, 'done');
});

test('the module never opens the three text files: the owner action is called with files: false, and no other writer is imported', async () => {
  const src = await read('src/setup-write.mjs');
  assert.match(src, /applyOwner\(a\.name, \{ overlay, files: false \}\)/);
  assert.doesNotMatch(src, /upsertSecrets|writeFile|writePrivate|rename\(|child_process|OWNER_FILES/);
  assert.doesNotMatch(src.replace(/^\/\/.*$/gm, ''), /POLICY|policy\.json|secrets\.env|settings\.json|triggers/);
});

test('the watch step writes local.json and the state file only, with the bytes the terminal wizard writes', async () => {
  const t = await install();
  const before = await snapshot(t.dir);
  const answers = { jobs: ['com.acme.report'], docker: ['db'], cron: ['rotate'], urls: ['https://example.com/health'] };
  const r = await runStep('watch', answers, t.opts);
  assert.equal(r.saved, 'watching 1 LaunchAgent(s), 1 container(s), 1 crontab line(s), 1 endpoint(s)');
  assert.equal(r.check.ok, true);
  assert.deepEqual(changed(before, await snapshot(t.dir)), ['data/setup-state.json', 'overlay/config/local.json']);
  const wizard = await install();
  await applyWatch({ jobs: [SCAN.jobs[1]], docker: SCAN.docker, cron: SCAN.cron, urls: answers.urls }, { overlay: wizard.overlay });
  assert.equal(await readFile(path.join(t.overlay, 'config/local.json'), 'utf8'), await readFile(path.join(wizard.overlay, 'config/local.json'), 'utf8'));
  // the scan's display text (a container's status, a crontab command) is not written
  const doc = JSON.parse(await readFile(path.join(t.overlay, 'config/local.json'), 'utf8'));
  assert.ok(!JSON.stringify(doc).includes('Up 2 days') && !JSON.stringify(doc).includes('/opt/rotate.sh'));
});

test('the engines step writes models.json and the state file only, with the bytes the terminal wizard writes', async () => {
  const t = await install();
  const before = await snapshot(t.dir);
  const answers = { master: 'claude', worker: 'codex', triage: 'claude' };
  const r = await runStep('engines', answers, t.opts);
  assert.match(r.saved, /^engines saved: master=claude · worker=codex · triage=claude/);
  assert.equal(r.recorded, true);
  assert.deepEqual(changed(before, await snapshot(t.dir)), ['data/setup-state.json', 'overlay/config/models.json']);
  const wizard = await install();
  await applyEngines(answers, { overlay: wizard.overlay, stateFile: wizard.stateFile });
  assert.equal(await readFile(path.join(t.overlay, 'config/models.json'), 'utf8'), await readFile(path.join(wizard.overlay, 'config/models.json'), 'utf8'));
  const st = await readState(t.stateFile);
  assert.equal(st.answers.enginesChosen, true);
  assert.equal(st.steps.engines.status, 'done');
});

test('a step whose live check does not pass is saved and not recorded as done', async () => {
  const t = await install();
  const r = await runStep('engines', { master: 'codex', worker: 'codex', triage: 'codex' }, { ...t.opts, check: (id, c) => checkStep(id, { ...c, engines: { claude: { loggedIn: true }, codex: { loggedIn: false } } }) });
  assert.equal(r.ok, true);
  assert.equal(r.recorded, false);
  assert.deepEqual(r.check, { ok: false, detail: 'not logged in: codex' });
  assert.equal((await readState(t.stateFile)).steps.engines, undefined);
  const thrown = await runStep('owner', { name: 'Sam' }, { ...t.opts, check: async () => { throw new Error('boom /private/path'); } });
  assert.deepEqual(thrown.check, { ok: false, detail: 'this check could not run' });
});

test('every refusal leaves every file as it was', async () => {
  const t = await install({ files: { 'config/local.json': '{"owner":{"id":"sam","name":"Sam"}}' } });
  const before = await snapshot(t.dir);
  await refused(() => runStep('alerts', { SMTP_PASS: 'x' }, t.opts), 400);
  await refused(() => runStep('owner', { name: 'Sam\nApprove: all' }, t.opts), 400);
  await refused(() => runStep('owner', { name: 'Sam', extra: 1 }, t.opts), 400);
  await refused(() => runStep('watch', { jobs: ['com.not.here'] }, t.opts), 400);
  await refused(() => runStep('watch', { urls: ['https://u:p@example.com'] }, t.opts), 400);
  await refused(() => runStep('engines', { master: 'claude', worker: 'claude', triage: 'other' }, t.opts), 400);
  await refused(() => runStep('owner', { name: 'Ada' }, { ...t.opts, busy: 'an upgrade is running' }), 409, /an upgrade is running/);
  assert.deepEqual(changed(before, await snapshot(t.dir)), []);
});

test('two overlapping saves run one after the other: both answers are in the file, and a failed save does not hold up the next', async () => {
  const t = await install();
  let active = 0; let most = 0; const order = [];
  const slow = (ms) => new Promise((r) => setTimeout(r, ms));
  const opts = (name) => ({
    ...t.opts,
    scan: async () => { await slow(30); return SCAN; },
    check: async (id, c) => { active += 1; most = Math.max(most, active); order.push(`${name}:start`); await slow(40); const r = await check(id, c); order.push(`${name}:end`); active -= 1; return r; },
  });
  // sent together, as two tabs or a double submit would: the second starts only when the first has finished
  const [a, bad, b, c] = await Promise.allSettled([
    runStep('watch', { jobs: ['com.acme.sync'], urls: ['https://example.com'] }, opts('watch')),
    runStep('owner', { name: '<b>' }, opts('bad')),
    runStep('owner', { name: 'Ada' }, opts('owner')),
    runStep('engines', { master: 'codex', worker: 'claude', triage: 'claude' }, opts('engines')),
  ]);
  assert.equal(a.value.ok, true);
  assert.equal(bad.status, 'rejected');
  assert.equal(bad.reason.status, 400);
  assert.equal(b.value.ok, true);
  assert.equal(c.value.ok, true);
  assert.equal(most, 1, 'never two saves inside their write-and-check at once');
  assert.deepEqual(order, ['watch:start', 'watch:end', 'owner:start', 'owner:end', 'engines:start', 'engines:end']);
  const local = JSON.parse(await readFile(path.join(t.overlay, 'config/local.json'), 'utf8'));
  assert.deepEqual(local.owner, { id: 'ada', name: 'Ada' });
  assert.deepEqual(local.jobs, [{ label: 'com.acme.sync', name: 'Sync', domain: 'mine' }]);
  assert.equal(local.endpoints.length, 1);
  const st = await readState(t.stateFile);
  assert.deepEqual(Object.keys(st.steps).sort(), ['engines', 'owner', 'watch']);
  assert.equal(st.answers.enginesChosen, true);
  // the same answers sent twice at once: one file, written twice, the same bytes as one save
  const twice = await install();
  await Promise.all([runStep('owner', { name: 'Ada' }, twice.opts), runStep('owner', { name: 'Ada' }, twice.opts)]);
  assert.equal(await readFile(path.join(twice.overlay, 'config/local.json'), 'utf8'), `${JSON.stringify({ owner: { id: 'ada', name: 'Ada' } }, null, 2)}\n`);
  const src = await read('server.mjs');
  assert.equal([...src.matchAll(/runSetupStep\(/g)].length, 1, 'the route saves only through the serial runner');
});

test('a board set up by hand (config in place, no setup record): 409 "use the terminal", nothing written, no state file made', async () => {
  // shaped like a hand-built board: its own registry answers and directory, and no data/setup-state.json
  const t = await install({ state: null, files: { 'config/local.json': '{"owner":{"id":"pat","name":"Pat"},"dropExamples":true}', 'config/models.json': '{"engine":{"master":"claude"}}', 'config/jobs.mjs': 'export const JOBS = [];\n' } });
  const before = await snapshot(t.dir);
  for (const [step, answers] of [['owner', { name: 'Ada' }], ['watch', { jobs: ['com.acme.sync'] }], ['engines', { master: 'codex', worker: 'codex', triage: 'codex' }]])
    await refused(() => runStep(step, answers, t.opts), 409, /set up by hand.*use the terminal/);
  const after = await snapshot(t.dir);
  assert.deepEqual(changed(before, after), []);
  assert.ok(!('data/setup-state.json' in after), 'no state file appears, so no setup card appears');
});

test('a config file that is not valid JSON is left as it is (409), and the answer does not quote it', async () => {
  const broken = '{ "owner": { "name": "Pat" }, SECRET_NOTE_do_not_echo';
  const t = await install({ files: { 'config/local.json': broken, 'config/models.json': '[1,2]' } });
  const before = await snapshot(t.dir);
  for (const [step, answers] of [['owner', { name: 'Ada' }], ['watch', {}], ['engines', { master: 'codex', worker: 'codex', triage: 'codex' }]]) {
    await assert.rejects(() => runStep(step, answers, t.opts), (e) => {
      assert.equal(e.status, 409);
      assert.ok(!e.message.includes('SECRET_NOTE') && !e.message.includes(t.dir), 'no file text, no path');
      return true;
    });
  }
  assert.deepEqual(changed(before, await snapshot(t.dir)), []);
});

test('an answer never carries a file\'s contents: only counts, the name that was sent and the check line', async () => {
  const t = await install({ files: { 'config/local.json': JSON.stringify({ jobs: [{ label: 'com.private.thing', name: 'PRIVATE-NAME' }], note: 'KEEP-OUT' }) } });
  const out = [
    await runStep('owner', { name: 'Ada' }, t.opts),
    await runStep('watch', { docker: ['db'] }, t.opts),
    await runStep('engines', { master: 'claude', worker: 'claude', triage: 'claude' }, t.opts),
  ];
  const all = JSON.stringify(out);
  for (const word of ['PRIVATE-NAME', 'KEEP-OUT', 'com.private.thing', '<OWNER>', t.dir, 'defaultMode']) assert.ok(!all.includes(word), word);
  for (const r of out) assert.deepEqual(Object.keys(r).sort(), ['check', 'ok', 'recorded', 'saved', 'step']);
});

test('restart: the board ends itself only as its own LaunchAgent; never a demo board, never with ZULU_NO_LAUNCHD; engines needs none', () => {
  const label = 'com.zulu.master-console';
  assert.equal(restartPlan('owner', { env: { XPC_SERVICE_NAME: label }, label }), 'self');
  assert.equal(restartPlan('watch', { env: { XPC_SERVICE_NAME: label }, label }), 'self');
  assert.equal(restartPlan('engines', { env: { XPC_SERVICE_NAME: label }, label }), 'none');
  assert.equal(restartPlan('owner', { env: {}, label }), 'manual');                                   // started by hand
  assert.equal(restartPlan('owner', { env: { XPC_SERVICE_NAME: 'com.other.job' }, label }), 'manual');
  assert.equal(restartPlan('owner', { env: { XPC_SERVICE_NAME: '0' }, label }), 'manual');
  assert.equal(restartPlan('owner', { demo: true, env: { XPC_SERVICE_NAME: label }, label }), 'manual');
  assert.equal(restartPlan('owner', { env: { XPC_SERVICE_NAME: label, ZULU_NO_LAUNCHD: '1' }, label }), 'manual');
  assert.equal(restartPlan('owner', { env: { XPC_SERVICE_NAME: '' }, label: '' }), 'manual');
});

test('a demo board checks the answers and writes nothing', () => {
  assert.deepEqual(demoStep('owner', { name: 'Ada' }), { ok: true, step: 'owner', demo: true, saved: 'demo: would save the owner step', restart: 'none', check: null });
  assert.equal(demoStep('watch', { jobs: [DEMO_SCAN.jobs[0].label] }).saved, 'demo: would save what this board watches');
  refusedSync(() => demoStep('watch', { jobs: ['com.not.in.demo'] }), 400);
  refusedSync(() => demoStep('owner', { name: '<b>' }), 400);
  refusedSync(() => demoStep('alerts', {}), 400);
});

// ---- the route's own checks, read from the source (a demo board cannot be asked from another device) ----
test('the routes: mode, then this Mac only, then the door, no agent or intake identity, the token; nothing runs before them', async () => {
  const src = await read('server.mjs');
  const at = src.indexOf("url.pathname === '/api/setup/step' && req.method === 'POST'");
  assert.ok(at > 0);
  const body = src.slice(at, src.indexOf("const am = url.pathname.match", at));
  const order = ['if (!setupWrite) return sendJson(res, 404', 'if (!localOnly(req)) return sendJson(res, 403', 'await decisionDoor(req,',
    "req.headers['x-mesh-agent']", 'if (!isDecider(req))', 'demoSetupStep(', 'readUpgradeState()', 'runSetupStep('];
  let last = -1;
  for (const piece of order) { const i = body.indexOf(piece); assert.ok(i > last, `${piece} comes in order`); last = i; }
  assert.match(body, /busy: up\?\.running \? 'an upgrade is running' : null/);
  assert.match(body, /b\.actor/);
  assert.doesNotMatch(body, /launchctl|kickstart/, 'no launchctl call from this route');
  assert.match(body, /msg: 'the step could not be saved; the board log says why'/, 'an unexpected error is not quoted to the page');
  const scanAt = src.indexOf("url.pathname === '/api/setup/scan' && req.method === 'GET'");
  const scanBody = src.slice(scanAt, at);
  let s = -1;
  for (const piece of ['if (!setupWrite)', 'if (!localOnly(req))', 'if (!isDecider(req))', 'scanWatch()']) { const i = scanBody.indexOf(piece); assert.ok(i > s, piece); s = i; }
  // the script and the token are served only in mode 'write'
  assert.match(src, /if \(!setupWrite && safe === 'setup-write\.js'\) \{ res\.writeHead\(404\)/);
  assert.match(src, /replace\('%%SETUP_WRITE%%', setupWrite \? /);
});

// ---- the forms ----
test('the forms: three steps on an installed board; a hand-built board gets a sentence; nothing without write mode', () => {
  assert.equal(view.render({ write: null, installed: true }), '');
  assert.equal(view.render(null), '');
  const hand = view.render({ write: { steps: WRITE_STEPS }, installed: false });
  assert.match(hand, /set up by hand/);
  assert.doesNotMatch(hand, /<form|<input|sw-save/);
  const html = view.render({ write: { steps: WRITE_STEPS }, installed: true });
  assert.deepEqual([...html.matchAll(/data-form="(\w+)"/g)].map((m) => m[1]), ['owner', 'engines', 'watch']);
  assert.equal([...html.matchAll(/class="sw-btn sw-save"/g)].length, 3);
  for (const role of ENGINE_ROLES) assert.match(html, new RegExp(`<select name="${role}">`));
  assert.doesNotMatch(html, /type="password"|SMTP|token/i);
});

test('the forms: scan text is escaped; answers are built from the fields; a 403 reads "reload"', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = view.scanLists({ jobs: [{ label: `com.x"${evil}`, name: evil }], docker: [{ name: evil, status: evil }], cron: [{ id: evil, schedule: '* * * * *', command: evil }] });
  assert.ok(!html.includes('<img'), 'no markup from the scan');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(view.scanLists({ jobs: [], docker: [], cron: [] }), /LaunchAgents: none found/);
  const get = { text: (n) => ({ name: ' Ada ', master: 'claude', worker: 'codex', triage: 'claude', urls: ' https://a.example \n\n https://b.example ' }[n] ?? ''), ticked: (n) => (n === 'jobs' ? ['com.acme.sync'] : []) };
  assert.deepEqual(plain(view.answersOf('owner', get)), { name: ' Ada ' });
  assert.deepEqual(plain(view.answersOf('engines', get)), { master: 'claude', worker: 'codex', triage: 'claude' });
  assert.deepEqual(plain(view.answersOf('watch', get)), { jobs: ['com.acme.sync'], docker: [], cron: [], urls: ['https://a.example', 'https://b.example'] });
  assert.deepEqual(plain(view.outcome(403, { ok: false, msg: 'decision token rejected' })), { bad: true, text: 'decision token rejected (reload)' });
  assert.equal(view.outcome(400, { ok: false, msg: 'a name is letters' }).bad, true);
  assert.equal(view.outcome(200, { ok: true, saved: 'owner saved: Ada', check: { ok: true, detail: 'owner: Ada' }, restart: 'self' }).text, 'owner saved: Ada · check passed: owner: Ada · the board restarts now to show it');
  assert.equal(view.outcome(200, { ok: true, saved: 'demo: would save the owner step', check: null, restart: 'none' }).text, 'demo: would save the owner step');
  // a save needs a second click and never a browser dialog
  const js = await read('public/setup-write.js');
  assert.doesNotMatch(js, /confirm\(|alert\(|prompt\(/);
  assert.match(js, /sw-armed/);
  assert.equal([...js.matchAll(/method: 'POST'/g)].length, 2, 'two writes: the step, and a button\'s id (test/setup-buttons.test.mjs)');
  assert.match(js, /fetch\('\/api\/setup\/button', \{ method: 'POST'/);
  assert.match(js, /fetch\('\/api\/setup\/step'/);
});

// ---- a real demo board ----
async function board(mode, fn, extra = {}) {
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'setup-write-overlay-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { setupPage: { mode } } }));
  const port = await freePort();
  const env = demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1', ...extra });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    await fn(base, overlay);
  } finally { child.kill(); }
}
const json = { 'content-type': 'application/json' };
const post = (base, body, headers = json) => fetch(`${base}/api/setup/step`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('a real board in mode "write": the page carries the token and the forms script; each refusal; a good save says "demo: would" and writes nothing', async () => {
  await board('write', async (base, overlay) => {
    const html = await (await fetch(`${base}/?setup=1`)).text();
    const token = html.match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    assert.ok(token, 'the setup page carries the token in mode write');
    assert.match(html, /<script src="\/setup-write\.js" defer><\/script>/);
    assert.doesNotMatch(html, /%%SETUP_WRITE%%/);
    assert.equal((await fetch(`${base}/setup-write.js`)).status, 200);
    const reading = await (await fetch(`${base}/api/setup`)).json();
    assert.deepEqual(reading.write, { steps: WRITE_STEPS });
    const good = { step: 'owner', answers: { name: 'Ada' } };
    const withToken = { ...json, 'x-mesh-decision': token };
    const before = await snapshot(overlay);

    assert.equal((await post(base, good, { 'content-type': 'text/plain', 'x-mesh-decision': token })).status, 415);
    assert.equal((await post(base, good, { ...json, 'x-mesh-decision': token, origin: 'https://evil.example' })).status, 403);
    let res = await post(base, good);
    assert.equal(res.status, 403);
    assert.match((await res.json()).msg, /reload/);
    assert.equal((await post(base, good, { ...json, 'x-mesh-decision': 'f'.repeat(token.length) })).status, 403);
    res = await post(base, good, { ...withToken, 'x-mesh-agent': 'some-agent' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).msg, /no agent or intake identity/);
    assert.equal((await post(base, good, { ...withToken, 'x-mesh-intake': 'x' })).status, 403);
    assert.equal((await post(base, { ...good, actor: 'some-agent' }, withToken)).status, 403);
    for (const bad of [{ step: 'alerts', answers: { SMTP_PASS: 'x' } }, { step: 'owner', answers: { name: '<b>x</b>' } }, { step: 'owner', answers: { name: 'Ada', id: 'root' } },
      { step: 'watch', answers: { jobs: ['com.not.in.demo'] } }, { step: 'engines', answers: { master: 'x', worker: 'claude', triage: 'claude' } }, { step: 'owner' }, {}])
      assert.equal((await post(base, bad, withToken)).status, 400, JSON.stringify(bad));

    res = await post(base, good, withToken);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, step: 'owner', demo: true, saved: 'demo: would save the owner step', restart: 'none', check: null });
    assert.equal((await post(base, { step: 'watch', answers: { jobs: [DEMO_SCAN.jobs[0].label], urls: ['https://example.com'] } }, withToken)).status, 200);
    assert.equal((await post(base, { step: 'engines', answers: { master: 'codex', worker: 'codex', triage: 'codex' } }, withToken)).status, 200);
    assert.deepEqual(changed(before, await snapshot(overlay)), [], 'a demo board writes nothing to its overlay');

    // the scan: behind the token, and a demo board scans nothing of this machine
    assert.equal((await fetch(`${base}/api/setup/scan`)).status, 403);
    res = await fetch(`${base}/api/setup/scan`, { headers: { 'x-mesh-decision': token } });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).scan, DEMO_SCAN);
  });
});

test('a real board in mode "on" stays read-only: no write route, no scan, no forms script, no token in the page', async () => {
  await board('on', async (base) => {
    const index = await (await fetch(`${base}/`)).text();
    const token = index.match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    assert.ok(token);
    const withToken = { ...json, 'x-mesh-decision': token };
    assert.equal((await post(base, { step: 'owner', answers: { name: 'Ada' } }, withToken)).status, 404);
    assert.equal((await fetch(`${base}/api/setup/scan`, { headers: withToken })).status, 404);
    assert.equal((await fetch(`${base}/setup-write.js`)).status, 404);
    const html = await (await fetch(`${base}/?setup=1`)).text();
    assert.ok(!html.includes(token), 'no token in the read-only page');
    assert.doesNotMatch(html, /setup-write\.js|%%SETUP_WRITE%%|mesh-decision/);
    assert.equal((await (await fetch(`${base}/api/setup`)).json()).write, null);
  });
});

test('a real board with the decision door on: a save that does not come from a browser is refused, even with the token', async () => {
  await board('write', async (base) => {
    const html = await (await fetch(`${base}/?setup=1`)).text();
    const token = html.match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    const res = await post(base, { step: 'owner', answers: { name: 'Ada' } }, { ...json, 'x-mesh-decision': token });
    assert.equal(res.status, 403);
  }, { MC_DEMO_CALLER: 'on,browser' });
});

test('the shipped switches: the examples ship the page off; this checkout\'s overlay, when it has the key, is not "write"', async () => {
  const mode = (text) => text.match(/setupPage:\s*\{\s*mode:\s*'(\w+)'/)?.[1];
  assert.equal(mode(await read('examples/config/jobs.mjs')), 'off');
  const own = await read('overlay/config/jobs.mjs').catch(() => null);
  if (own && mode(own)) assert.notEqual(mode(own), 'write');
});
