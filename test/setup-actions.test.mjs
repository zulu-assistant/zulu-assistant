// What the guided setup's data steps write (src/setup-actions.mjs): answers in, files out. The terminal
// wizard (scripts/setup.mjs) calls these, so what it wrote before the functions were moved out is pinned
// here byte for byte.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyOwner, applyWatch, applyEngines, upsertSecrets, ownerId, OWNER_FILES, ENGINE_ROLES } from '../src/setup-actions.mjs';
import { readState, writeState, checkStep } from '../src/setup.mjs';
import { mergeLocal, parseEnv } from '../src/config.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
async function overlay(files = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'setup-actions-'));
  await mkdir(path.join(dir, 'config'), { recursive: true });
  for (const [rel, text] of Object.entries(files)) await writeFile(path.join(dir, rel), text);
  return dir;
}
const text = (dir, rel) => readFile(path.join(dir, rel), 'utf8');
const list = async (dir) => (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name))).sort();

test('ownerId: a name becomes a plain id; a name with nothing usable is "owner"', () => {
  assert.equal(ownerId('Sam Lee'), 'sam-lee');
  assert.equal(ownerId('  Dr. Ada  O\'Neil-3 '), 'dr-ada-o-neil-3');
  assert.equal(ownerId('!!!'), 'owner');
});

test('applyOwner: the owner in local.json (other answers kept), placeholders filled where they still stand, nothing else written', async () => {
  const dir = await overlay({
    'config/local.json': JSON.stringify({ dropExamples: true, jobs: [{ label: 'x' }] }),
    'POLICY.md': 'Approver: <OWNER>. uid <UID>. Again <OWNER>.\n',
    'MISSION-CONTROL.md': 'already filled for Sam\n',
    'config/TRIAGE.md': 'kick gui/<UID>/x for <OWNER>\n',
    'policy.json': '{"defaultMode":"enforce"}',
  });
  const r = await applyOwner('Sam Lee', { overlay: dir, uid: 501 });
  assert.deepEqual(r, { owner: { id: 'sam-lee', name: 'Sam Lee' }, filled: ['POLICY.md', 'config/TRIAGE.md'] });
  assert.equal(await text(dir, 'config/local.json'), `${JSON.stringify({ dropExamples: true, jobs: [{ label: 'x' }], owner: { id: 'sam-lee', name: 'Sam Lee' } }, null, 2)}\n`);
  assert.equal(await text(dir, 'POLICY.md'), 'Approver: Sam Lee. uid 501. Again Sam Lee.\n');
  assert.equal(await text(dir, 'MISSION-CONTROL.md'), 'already filled for Sam\n');
  assert.equal(await text(dir, 'config/TRIAGE.md'), 'kick gui/501/x for Sam Lee\n');
  assert.equal(await text(dir, 'policy.json'), '{"defaultMode":"enforce"}', 'the rules file is not this step\'s');
  assert.deepEqual(await list(dir), ['MISSION-CONTROL.md', 'POLICY.md', 'config/TRIAGE.md', 'config/local.json', 'policy.json']);
  assert.deepEqual(OWNER_FILES, ['POLICY.md', 'MISSION-CONTROL.md', 'config/TRIAGE.md']);
  // the board reads it the way it reads the wizard's answer
  assert.deepEqual(mergeLocal({ SETTINGS: {} }, JSON.parse(await text(dir, 'config/local.json'))).SETTINGS.owner, { id: 'sam-lee', name: 'Sam Lee' });
  assert.equal((await checkStep('owner', { overlay: dir })).ok, true);
});

test('applyOwner: no name writes nothing; no local.json yet makes one', async () => {
  const dir = await overlay({ 'POLICY.md': '<OWNER>' });
  assert.equal(await applyOwner('', { overlay: dir }), null);
  assert.deepEqual(await list(dir), ['POLICY.md']);
  assert.equal(await text(dir, 'POLICY.md'), '<OWNER>');
  await applyOwner('Ada', { overlay: dir, uid: 7 });
  assert.equal(await text(dir, 'config/local.json'), '{\n  "owner": {\n    "id": "ada",\n    "name": "Ada"\n  }\n}\n');
});

test('applyWatch: the ticked items become the board\'s registry entries; the owner answer is kept; the examples are dropped', async () => {
  const dir = await overlay({ 'config/local.json': JSON.stringify({ owner: { id: 'ada', name: 'Ada' }, jobs: [{ label: 'old' }] }) });
  const counts = await applyWatch({
    jobs: [{ label: 'com.example.sync', name: 'Sync', path: '/x.plist' }],
    docker: [{ name: 'db', status: 'Up 3 days' }],
    cron: [{ id: 'backup-sh', match: 'backup.sh', schedule: '0 3 * * *', command: '/usr/local/bin/backup.sh --all' }],
    urls: ['https://example.test/health', 'http://localhost:8080'],
  }, { overlay: dir });
  assert.deepEqual(counts, { jobs: 1, docker: 1, cron: 1, endpoints: 2 });
  assert.deepEqual(JSON.parse(await text(dir, 'config/local.json')), {
    owner: { id: 'ada', name: 'Ada' },
    jobs: [{ label: 'com.example.sync', name: 'Sync', domain: 'mine' }],
    domains: [{ id: 'mine', name: 'My Jobs', accent: '#00e5e5' }],
    docker: [{ name: 'db', display: 'Docker: db', domain: 'mine' }],
    cron: [{ id: 'backup-sh', name: 'backup.sh', domain: 'mine', schedule: '0 3 * * *', match: 'backup.sh', quietOk: true }],
    endpoints: [{ id: 'ep1', name: 'example.test/health', url: 'https://example.test/health', everyPolls: 5 }, { id: 'ep2', name: 'localhost:8080', url: 'http://localhost:8080', everyPolls: 5 }],
    dropExamples: true,
  });
  assert.match(await text(dir, 'config/local.json'), /^\{\n  "owner"/, 'two-space JSON with a final newline, as the wizard wrote it');
  assert.equal((await checkStep('watch', { overlay: dir })).detail, '5 item(s) from this Mac on the board');
  // nothing ticked is a valid answer: watch nothing, still drop the examples
  assert.deepEqual(await applyWatch({}, { overlay: dir }), { jobs: 0, docker: 0, cron: 0, endpoints: 0 });
  assert.equal(JSON.parse(await text(dir, 'config/local.json')).dropExamples, true);
  assert.deepEqual(await list(dir), ['config/local.json']);
});

test('applyEngines: the choice goes into models.json (the rest of the file kept) and the state file says a choice was made', async () => {
  const dir = await overlay({ 'config/models.json': JSON.stringify({ master: 'model-a', contextWindows: { 'model-a': 1000 }, engine: { master: 'claude', resident: 'claude' } }) });
  const state = path.join(dir, 'state.json');
  await writeState({ installedAt: 5, steps: { github: { status: 'done' } }, answers: { macosConfirmed: true } }, state);
  const engine = await applyEngines({ master: 'codex', worker: 'claude', triage: 'codex', extra: 'ignored' }, { overlay: dir, stateFile: state });
  assert.deepEqual(engine, { master: 'codex', worker: 'claude', triage: 'codex' });
  assert.equal(await text(dir, 'config/models.json'), `${JSON.stringify({ master: 'model-a', contextWindows: { 'model-a': 1000 }, engine }, null, 2)}\n`);
  assert.deepEqual(await readState(state), { installedAt: 5, steps: { github: { status: 'done' } }, answers: { macosConfirmed: true, enginesChosen: true } });
  assert.deepEqual(ENGINE_ROLES, ['master', 'worker', 'triage']);
});

test('applyEngines: no models.json yet starts from the shipped one; no state file yet makes one; a bad choice writes nothing', async () => {
  const dir = await overlay();
  const state = path.join(dir, 'state.json');
  await applyEngines({ master: 'claude', worker: 'claude', triage: 'claude' }, { overlay: dir, stateFile: state });
  const shipped = JSON.parse(await read('examples/config/models.json'));
  assert.deepEqual(JSON.parse(await text(dir, 'config/models.json')), { ...shipped, engine: { master: 'claude', worker: 'claude', triage: 'claude' } });
  assert.deepEqual(await readState(state), { steps: {}, answers: { enginesChosen: true } });
  const dir2 = await overlay();
  for (const bad of [null, {}, { master: 'claude', worker: 'claude' }, { master: 'claude', worker: 'gpt', triage: 'claude' }, { master: 'Claude', worker: 'claude', triage: 'claude' }, { master: ['claude'], worker: 'claude', triage: 'claude' }]) {
    await assert.rejects(applyEngines(bad, { overlay: dir2, stateFile: path.join(dir2, 'state.json') }), /must be one of: claude, codex/);
  }
  assert.deepEqual(await list(dir2), []);
});

test('upsertSecrets: a present key is replaced in place, a new one is added, an empty answer leaves the key alone; the file is owner-only', async () => {
  const dir = await overlay();
  const file = path.join(dir, 'data', 'secrets.env');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '# alerts\nSMTP_HOST="old.example.test"\nexport SMTP_PORT=25\nKEEP_ME=1\n', { mode: 0o644 });
  const written = await upsertSecrets({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_PASS: 'p"q$ r', ALERT_EMAIL_TO: '', SMS_ALERT_TO: undefined }, { secretsFile: file, root: dir });
  assert.deepEqual(written, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_PASS']);
  assert.equal(await readFile(file, 'utf8'), '# alerts\nSMTP_HOST="smtp.example.test"\nSMTP_PORT="587"\nKEEP_ME=1\n\nSMTP_PASS="p"q$ r"');
  assert.equal((await stat(file)).mode & 0o077, 0, 'nothing for group or other');
  const env = parseEnv(await readFile(file, 'utf8'));
  assert.equal(env.SMTP_HOST, 'smtp.example.test'); assert.equal(env.KEEP_ME, '1');
  assert.equal(env.SMTP_PASS, 'p"q$ r', 'the value reads back as it was given');
  assert.deepEqual(await upsertSecrets({}, { secretsFile: file, root: dir }), []);
});

test('upsertSecrets: every value reads back through the board\'s own reader exactly as given (quotes, backslashes, =, #, spaces)', async () => {
  const dir = await overlay({ 'secrets.env.example': 'SMTP_PASS=\n' });
  const file = path.join(dir, 'data', 'secrets.env');
  const hard = ['a"b', "a'b", 'a\\b', 'a\\"b', '\\', '"', "'", '"quoted"', "'quoted'", 'a=b==', 'a#b # c', ' lead and trail ', 'a$HOME`x`', 'x\\n', 'ünï 🙂', '{"j":1}', 'a\\\\'];
  for (const v of hard) {
    await upsertSecrets({ SMTP_PASS: v }, { secretsFile: file, root: dir });
    assert.equal(parseEnv(await readFile(file, 'utf8')).SMTP_PASS, v, `reads back: ${JSON.stringify(v)}`);
    assert.equal((await readFile(file, 'utf8')).split('\n').filter((l) => l.startsWith('SMTP_PASS=')).length, 1, 'one line for the key');
  }
});

test('upsertSecrets: a value that cannot be one line, and a name that is not a setting\'s name, are refused before anything is written', async () => {
  const dir = await overlay({ 'secrets.env.example': 'SMTP_HOST=\n' });
  const file = path.join(dir, 'data', 'secrets.env');
  await mkdir(path.dirname(file), { recursive: true });
  const before = 'SMTP_HOST="keep.example.test"\n';
  await writeFile(file, before);
  for (const bad of ['a\nEVIL=1', 'a\rb', 'a\u2028b', 'a\u2029b', 'a\u0085b', 'a\u0000b', 'a\tb', 7, null, ['x'], { a: 1 }])
    await assert.rejects(() => upsertSecrets({ SMTP_HOST: 'new.example.test', SMTP_PASS: bad }, { secretsFile: file, root: dir }), /one line of text/);
  for (const name of ['smtp_pass', 'A B', 'A=B', 'A\nB', '', '1A'])
    await assert.rejects(() => upsertSecrets({ [name]: 'x' }, { secretsFile: file, root: dir }), /capital letters/);
  assert.equal(await readFile(file, 'utf8'), before, 'not even the good key of a refused call is written');
});

test('upsertSecrets: no secrets file yet starts from the template', async () => {
  const dir = await overlay({ 'secrets.env.example': '# template\nSMTP_HOST=\nALERT_EMAIL_TO=\n' });
  const file = path.join(dir, 'data', 'secrets.env');
  await upsertSecrets({ ALERT_EMAIL_TO: 'alerts@example.test' }, { secretsFile: file, root: dir });
  assert.equal(await readFile(file, 'utf8'), '# template\nSMTP_HOST=\nALERT_EMAIL_TO="alerts@example.test"\n');
  assert.equal((await stat(file)).mode & 0o077, 0);
});

test('the terminal wizard writes these four steps through the shared functions, and the functions never prompt, print or restart', async () => {
  const wizard = await read('scripts/setup.mjs');
  assert.match(wizard, /import \{ applyOwner, applyWatch, applyEngines, upsertSecrets \} from '\.\.\/src\/setup-actions\.mjs'/);
  for (const call of ['await applyOwner(name, { overlay: OVERLAY })', 'await applyWatch({ jobs, docker, cron, urls }, { overlay: OVERLAY })', 'await applyEngines(engine, { overlay: OVERLAY })', 'await upsertSecrets(p, { secretsFile: SECRETS })'])
    assert.ok(wizard.includes(call), `the wizard calls: ${call}`);
  assert.doesNotMatch(wizard, /local\.(owner|jobs|docker|cron|endpoints|dropExamples) =/, 'no second copy of the writes in the wizard');
  const mod = await read('src/setup-actions.mjs');
  assert.doesNotMatch(mod, /child_process|readline|console\.|process\.stdout|launchctl|policy\.json|settings\.json/);
});

test('upsertSecrets: an ordinary value is written byte for byte as before (the same line the JSON form gave), and reads back', async () => {
  const dir = await overlay({ 'secrets.env.example': '' });
  const file = path.join(dir, 'data', 'secrets.env');
  const ordinary = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'board@example.test', ALERT_EMAIL_TO: 'me@example.test', SMS_WEBHOOK_URL: 'https://hooks.example.test/s?a=1&b=2', SMS_ALERT_TO: '+15555550199', HEARTBEAT_URL: 'https://db.example.test/rest/v1/row?id=eq.1', SMTP_PASS: 'plain words 123 !@%^*()-_+[]{};:,.<>?/|~' };
  await upsertSecrets(ordinary, { secretsFile: file, root: dir });
  const text = await readFile(file, 'utf8');
  for (const [k, v] of Object.entries(ordinary)) {
    assert.ok(text.split('\n').includes(`${k}=${JSON.stringify(v)}`), `${k}: the line the old writer wrote`);
    assert.equal(parseEnv(text)[k], v);
  }
});
