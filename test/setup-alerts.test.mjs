// The alerts step on the setup page (src/setup-alerts.mjs, run as a step by src/setup-write.mjs): the one setup
// form that writes the secrets file. The field rules, what changes on disk, what never leaves the board, the
// switch, the form, and a real demo board.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { ALERT_KEYS, HIDDEN_KEYS, CHANNELS, MAX_VALUE, AlertRefused, alertsOffered, checkAlerts, storedSecrets } from '../src/setup-alerts.mjs';
import { runStep, demoStep, checkAnswers, stepsFor, WRITE_STEPS, SetupRefused } from '../src/setup-write.mjs';
import { upsertSecrets } from '../src/setup-actions.mjs';
import { alertTiers, checkStep, readState, writeState, TEMPLATE_EXAMPLES } from '../src/setup.mjs';
import { parseEnv } from '../src/config.mjs';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/setup-write.js'), { globalThis: ctx });
const view = ctx.SetupWrite;
const plain = (x) => JSON.parse(JSON.stringify(x));

// hidden values are put together at run time: a literal beside a PASS or KEY name reads as a real key to the secret scanner
const made = (...w) => w.join('-');
const PW = made('correct', 'horse', 'pw');
const SMS_K = made('sms', 'hook', 'value');
const BEAT_K = made('beat', 'row', 'value');
const EMAIL = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'board@example.test', SMTP_PASS: PW, ALERT_EMAIL_TO: 'me@example.test' };
const SMS = { SMS_WEBHOOK_URL: 'https://hooks.example.test/s', SMS_WEBHOOK_KEY: SMS_K, SMS_ALERT_TO: '+15555550199' };
const BEAT = { HEARTBEAT_URL: 'https://db.example.test/rest/v1/row?id=eq.1', HEARTBEAT_KEY: BEAT_K };
const TEMPLATE = await read('secrets.env.example');
const OTHER_LINE = `SLACK_BOT_TOKEN="${made('kept', 'as', 'it', 'is')}"`;

/** A temp install: data/ with a setup record and (unless `file` is null) a secrets file. */
async function install({ file = TEMPLATE, state = { installedAt: 1, steps: {}, answers: {} } } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'setup-alerts-'));
  await mkdir(path.join(dir, 'data'), { recursive: true });
  await mkdir(path.join(dir, 'overlay', 'config'), { recursive: true });
  await writeFile(path.join(dir, 'secrets.env.example'), TEMPLATE);
  await writeFile(path.join(dir, 'overlay', 'policy.json'), '{"defaultMode":"enforce"}');
  await writeFile(path.join(dir, 'overlay', 'POLICY.md'), 'Approver: <OWNER>.\n');
  await writeFile(path.join(dir, 'overlay', 'config', 'local.json'), '{"owner":{"id":"sam","name":"Sam"}}');
  await writeFile(path.join(dir, 'data', 'mesh-decision-token'), 'abc');
  const secretsFile = path.join(dir, 'data', 'secrets.env');
  if (file !== null) await writeFile(secretsFile, file, { mode: 0o600 });
  const stateFile = path.join(dir, 'data', 'setup-state.json');
  if (state) await writeState(state, stateFile);
  return { dir, secretsFile, stateFile, opts: { overlay: path.join(dir, 'overlay'), stateFile, alerts: true, alertsFile: secretsFile, root: dir } };
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
const bad = (answers, re, current) => assert.throws(() => checkAlerts(answers, current), (e) => e instanceof AlertRefused && e.status === 400 && (!re || re.test(e.message)), JSON.stringify(Object.keys(answers)));

test('the ten keys, the three hidden ones, and each channel\'s needs are the senders\' own', () => {
  assert.deepEqual(ALERT_KEYS, ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO', 'SMS_WEBHOOK_URL', 'SMS_WEBHOOK_KEY', 'SMS_ALERT_TO', 'HEARTBEAT_URL', 'HEARTBEAT_KEY']);
  assert.deepEqual(HIDDEN_KEYS, ['SMTP_PASS', 'SMS_WEBHOOK_KEY', 'HEARTBEAT_KEY']);
  assert.deepEqual(CHANNELS.flatMap((c) => c.keys), ALERT_KEYS);
  // a channel that has exactly its needs is one the alerts check counts as on
  for (const ch of CHANNELS) assert.deepEqual(alertTiers(Object.fromEntries(ch.needs.map((k) => [k, 'x']))).tiers, [ch.id]);
});

test('the switch: its own key, mode write, AND a door that refuses a sender that is not a browser', () => {
  assert.equal(alertsOffered({ mode: 'write', alerts: true }, 'browser'), true);
  assert.equal(alertsOffered({ mode: 'write', alerts: true }, 'agent'), false);
  assert.equal(alertsOffered({ mode: 'write', alerts: true }, null), false);
  assert.equal(alertsOffered({ mode: 'write', alerts: true }, undefined), false);
  assert.equal(alertsOffered({ mode: 'write' }, 'browser'), false);
  assert.equal(alertsOffered({ mode: 'write', alerts: 'true' }, 'browser'), false);
  assert.equal(alertsOffered({ mode: 'on', alerts: true }, 'browser'), false);
  assert.equal(alertsOffered(undefined, 'browser'), false);
  assert.deepEqual(stepsFor(), WRITE_STEPS);
  assert.deepEqual(stepsFor({ alerts: true }), [...WRITE_STEPS, 'alerts']);
  // where it is not offered the step does not exist, whatever is sent
  assert.throws(() => checkAnswers('alerts', EMAIL), (e) => e instanceof SetupRefused && e.status === 400 && /not answered on this page/.test(e.message));
  assert.throws(() => demoStep('alerts', EMAIL), SetupRefused);
  assert.equal(demoStep('alerts', EMAIL, { alerts: true }).saved, 'demo: would save the alert channels');
  // the examples do not ship the key
  return read('examples/config/jobs.mjs').then((t) => assert.doesNotMatch(t.replace(/^\s*\/\/.*$/gm, ''), /alerts:\s*true/));
});

test('only the ten keys: any other key of the secrets file is refused as a field', () => {
  for (const k of ['HEARTBEAT_HOST', 'HEARTBEAT_READ_KEY', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'RELAY_TOKEN', 'MADE_UP', 'smtp_host', '__proto__', 'PATH'])
    assert.throws(() => checkAnswers('alerts', { ...EMAIL, [k]: 'x' }, { alerts: true }), (e) => e instanceof SetupRefused && e.status === 400 && /not a field of the alerts step/.test(e.message), k);
  assert.throws(() => checkAnswers('alerts', [EMAIL], { alerts: true }), SetupRefused);
  assert.throws(() => checkAnswers('alerts', null, { alerts: true }), SetupRefused);
});

test('every value is one line of text, at most 500 characters: no key can carry a line break or a control character', () => {
  const whole = { ...EMAIL, ...SMS, ...BEAT };
  for (const key of ALERT_KEYS) {
    for (const tail of ['\nSMTP_HOST=evil.example.test', '\r\nX=1', '\u2028X=1', '\u2029X=1', '\u0085X=1', '\u0000', '\u001b[2J', '\tx'])
      bad({ ...whole, [key]: `${whole[key]}${tail}` }, new RegExp(`^${key} must be one line`));
    bad({ ...whole, [key]: 'a'.repeat(MAX_VALUE + 1) }, new RegExp(`^${key} is too long`));
    for (const v of [7, true, ['x'], { v: 'x' }]) bad({ ...whole, [key]: v }, new RegExp(`^${key} must be text`));
  }
  assert.deepEqual(checkAlerts(whole), whole);
});

test('by field: a host name, a port, one mail address, phone numbers, https addresses without credentials', () => {
  const email = (over) => ({ ...EMAIL, ...over });
  for (const v of ['smtp.example.test/x', 'smtp example', 'https://smtp.example.test', '-smtp.example.test', 'smtp.example.test;x', 'a@b']) bad(email({ SMTP_HOST: v }), /^SMTP_HOST must be a host name/);
  for (const v of ['0', '65536', '587x', '-1', '5 87', '1e3', '999999']) bad(email({ SMTP_PORT: v }), /^SMTP_PORT must be a number/);
  assert.equal(checkAlerts(email({ SMTP_PORT: '0465' })).SMTP_PORT, '465');
  bad(email({ SMTP_USER: 'board user' }), /^SMTP_USER must not hold a space/);
  for (const v of ['me', 'me@', '@example.test', 'a@b', 'me@example.test, you@example.test', 'me@example.test;x', '<me@example.test>', 'me@exa mple.test', 'me@example.test\\']) bad(email({ ALERT_EMAIL_TO: v }), /^ALERT_EMAIL_TO must be one mail address/);
  const sms = (over) => ({ ...SMS, ...over });
  for (const v of ['5555550199', '+0155555501', '+1 555 555 0199', '+1555', 'call me', '+15555550199;+15555550198', `${Array.from({ length: 6 }, (_, i) => `+1555555019${i}`).join(',')}`]) bad(sms({ SMS_ALERT_TO: v }), /^SMS_ALERT_TO must be phone numbers/);
  assert.equal(checkAlerts(sms({ SMS_ALERT_TO: ' +15555550199 , +15555550198 ' })).SMS_ALERT_TO, '+15555550199,+15555550198');
  for (const key of ['SMS_WEBHOOK_URL', 'HEARTBEAT_URL']) {
    const base = key === 'SMS_WEBHOOK_URL' ? SMS : BEAT;
    for (const v of ['http://hooks.example.test/s', 'ftp://hooks.example.test', 'file:///etc/hosts', 'javascript:alert(1)', 'hooks.example.test/s', 'https://user:pw@hooks.example.test/s', 'https://user@hooks.example.test/s', 'https://hooks.example.test/a b', 'https://hooks.example.test/"x', 'http://127.0.0.1.example.test/s', 'http://localhost.example.test/s'])
      bad({ ...base, [key]: v }, new RegExp(`^${key} `));
    for (const v of ['http://localhost:8080/hook', 'http://127.0.0.1:9/x', 'http://[::1]:9/x', 'https://hooks.example.test/s?a=1&b=2'])
      assert.equal(checkAlerts({ ...base, [key]: v })[key], v);
  }
  // a refusal names the field and never repeats the value
  for (const [answers, secret] of [[email({ SMTP_HOST: 'bad host PRIVATE-HOST' }), 'PRIVATE-HOST'], [sms({ SMS_WEBHOOK_URL: 'https://u:PRIVATE-PW@x.example.test' }), 'PRIVATE-PW'], [email({ ALERT_EMAIL_TO: 'PRIVATE-ADDRESS' }), 'PRIVATE-ADDRESS']])
    assert.throws(() => checkAlerts(answers), (e) => e instanceof AlertRefused && !e.message.includes(secret));
});

test('a hidden value is taken exactly as typed; the other fields are trimmed; an empty field is not written', () => {
  const odd = ' p"q\\\'r =#$` ';
  const out = checkAlerts({ SMTP_HOST: '  smtp.example.test ', SMTP_USER: ' board@example.test ', SMTP_PASS: odd, ALERT_EMAIL_TO: '', SMTP_PORT: '   ' });
  assert.deepEqual(out, { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'board@example.test', SMTP_PASS: odd });
  bad({}, /^nothing to save/);
  bad({ SMTP_HOST: '', SMS_ALERT_TO: '  ' }, /^nothing to save/);
});

test('a channel is saved whole or not at all, counting what is stored; an old template\'s example value does not count as stored', () => {
  bad({ SMTP_HOST: 'smtp.example.test' }, /^the email channel also needs: SMTP_USER, SMTP_PASS$/);
  bad({ ALERT_EMAIL_TO: 'me@example.test' }, /^the email channel also needs: SMTP_HOST, SMTP_USER, SMTP_PASS$/);
  bad({ SMS_WEBHOOK_URL: SMS.SMS_WEBHOOK_URL }, /^the sms channel also needs: SMS_WEBHOOK_KEY, SMS_ALERT_TO$/);
  bad({ HEARTBEAT_URL: BEAT.HEARTBEAT_URL }, /^the heartbeat channel also needs: HEARTBEAT_KEY$/);
  bad({ ...EMAIL, SMS_ALERT_TO: '+15555550199' }, /^the sms channel also needs/);     // one whole channel does not carry a half one
  // what is stored counts: a new recipient alone, a new password alone
  assert.deepEqual(checkAlerts({ ALERT_EMAIL_TO: 'new@example.test' }, EMAIL), { ALERT_EMAIL_TO: 'new@example.test' });
  assert.deepEqual(checkAlerts({ SMTP_PASS: 'x y' }, { ...EMAIL, SMTP_PASS: '' }), { SMTP_PASS: 'x y' });
  // an install made from the old template: its example host and user are not the owner's
  const old = { ...TEMPLATE_EXAMPLES, SMTP_PORT: '587', SMTP_PASS: '', SMS_WEBHOOK_KEY: '', HEARTBEAT_KEY: '' };
  bad({ SMTP_PASS: PW }, /^the email channel also needs: SMTP_HOST, SMTP_USER$/, old);
  bad({ SMS_WEBHOOK_KEY: SMS_K }, /^the sms channel also needs: SMS_WEBHOOK_URL, SMS_ALERT_TO$/, old);
  bad({ HEARTBEAT_KEY: BEAT_K }, /^the heartbeat channel also needs: HEARTBEAT_URL$/, old);
});

test('a save writes the secrets file and the setup record only; other keys in the file stay byte for byte; the file is owner-only', async () => {
  const t = await install({ file: `${TEMPLATE}\n${OTHER_LINE}\n` });
  const before = await snapshot(t.dir);
  const r = await runStep('alerts', SMS, t.opts);
  assert.deepEqual(r, { ok: true, step: 'alerts', saved: 'alert settings saved: SMS_WEBHOOK_URL, SMS_WEBHOOK_KEY, SMS_ALERT_TO', recorded: true, check: { ok: true, detail: 'on: sms' } });
  assert.deepEqual(changed(before, await snapshot(t.dir)), ['data/secrets.env', 'data/setup-state.json']);
  const text = await readFile(t.secretsFile, 'utf8');
  assert.ok(text.split('\n').includes(OTHER_LINE), 'a key the form does not own is unchanged');
  const env = parseEnv(text);
  for (const [k, v] of Object.entries(SMS)) assert.equal(env[k], v);
  assert.equal(env.SMTP_HOST, '');
  assert.equal((await stat(t.secretsFile)).mode & 0o077, 0, 'nothing for group or other');
  assert.equal((await readState(t.stateFile)).steps.alerts.status, 'done');
  // the same answers through the terminal wizard's function give the same file
  const wizard = await install({ file: `${TEMPLATE}\n${OTHER_LINE}\n` });
  await upsertSecrets(SMS, { secretsFile: wizard.secretsFile, root: wizard.dir });
  assert.equal(text, await readFile(wizard.secretsFile, 'utf8'));
});

test('no secrets file yet: it starts from the template, owner-only, and only the saved channel is on', async () => {
  const t = await install({ file: null });
  const r = await runStep('alerts', { ...EMAIL, ...BEAT }, t.opts);
  assert.equal(r.check.detail, 'on: email, heartbeat');
  assert.equal((await stat(t.secretsFile)).mode & 0o077, 0);
  const env = await storedSecrets(t.secretsFile);
  assert.equal(env.SMS_WEBHOOK_URL, '');
  assert.equal(env.SLACK_BOT_TOKEN, '');
});

test('a hidden value with quotes, backslashes, = and # reads back through the board\'s own reader exactly as typed', async () => {
  for (const odd of ['p"q', "p'q", 'p\\q', 'p\\"q', '"', '\\', ' lead trail ', 'a=b#c $HOME `x`', '"wrapped"', 'ünï🙂', 'x\\n']) {
    const t = await install();
    await runStep('alerts', { ...EMAIL, SMTP_PASS: odd }, t.opts);
    assert.equal((await storedSecrets(t.secretsFile)).SMTP_PASS, odd, JSON.stringify(odd));
    // and a second save of another channel leaves it as it was
    await runStep('alerts', SMS, t.opts);
    assert.equal((await storedSecrets(t.secretsFile)).SMTP_PASS, odd, `after a second save: ${JSON.stringify(odd)}`);
  }
});

test('an empty field leaves the stored value; a second save changes only what it names', async () => {
  const t = await install();
  await runStep('alerts', EMAIL, t.opts);
  const r = await runStep('alerts', { ALERT_EMAIL_TO: 'new@example.test', SMTP_PASS: '', SMTP_HOST: '' }, t.opts);
  assert.equal(r.saved, 'alert settings saved: ALERT_EMAIL_TO');
  const env = await storedSecrets(t.secretsFile);
  assert.equal(env.SMTP_PASS, PW);
  assert.equal(env.SMTP_HOST, EMAIL.SMTP_HOST);
  assert.equal(env.ALERT_EMAIL_TO, 'new@example.test');
});

test('every refusal leaves the secrets file byte for byte as it was, and makes none when there was none', async () => {
  const t = await install({ file: `${TEMPLATE}\n${OTHER_LINE}\n` });
  const before = await snapshot(t.dir);
  const refused = (answers, opts = t.opts, status = 400) => assert.rejects(() => runStep('alerts', answers, opts), (e) => e instanceof SetupRefused && e.status === status);
  await refused({ ...EMAIL, SMTP_PASS: `${PW}\nSMS_WEBHOOK_URL=https://evil.example.test` });
  await refused({ ...EMAIL, SLACK_BOT_TOKEN: 'x' });
  await refused({ SMTP_HOST: 'smtp.example.test' });
  await refused({ ...SMS, SMS_WEBHOOK_URL: 'http://hooks.example.test/s' });
  await refused({});
  await refused(EMAIL, { ...t.opts, alerts: false });                                  // not offered
  await refused(EMAIL, { ...t.opts, busy: 'an upgrade is running' }, 409);
  await refused(EMAIL, { ...t.opts, alertsFile: undefined }, 500);
  assert.deepEqual(changed(before, await snapshot(t.dir)), []);
  const none = await install({ file: null });
  await refused({ SMTP_HOST: 'smtp.example.test' }, none.opts);
  await assert.rejects(() => stat(none.secretsFile), { code: 'ENOENT' });
  // a board set up by hand: nothing, and no setup record appears
  const hand = await install({ state: null });
  const handBefore = await snapshot(hand.dir);
  await refused(EMAIL, hand.opts, 409);
  assert.deepEqual(changed(handBefore, await snapshot(hand.dir)), []);
});

test('no typed and no stored value is in any answer or refusal: key names and the check line only', async () => {
  const stored = `SMTP_HOST="stored-host.example.test"\nSMTP_USER="stored-user@example.test"\nSMTP_PASS="${made('stored', 'pw')}"\nSMTP_PORT=587\nALERT_EMAIL_TO=\nSMS_WEBHOOK_URL=\nSMS_WEBHOOK_KEY=\nSMS_ALERT_TO=\nHEARTBEAT_URL=\nHEARTBEAT_KEY=\n${OTHER_LINE}\n`;
  const t = await install({ file: stored });
  const seen = [];
  seen.push(JSON.stringify(await runStep('alerts', { ...SMS, ...BEAT, ALERT_EMAIL_TO: 'typed@example.test' }, t.opts)));
  for (const answers of [{ ...EMAIL, SMTP_HOST: 'bad host' }, { ...SMS, SMS_ALERT_TO: 'nope' }, { ...BEAT, HEARTBEAT_URL: 'http://db.example.test' }, { ...EMAIL, SMTP_PASS: `${PW}\n` }, { HEARTBEAT_KEY: BEAT_K, EXTRA: PW }])
    await runStep('alerts', answers, { ...t.opts, alertsFile: (await install()).secretsFile }).then((r) => seen.push(JSON.stringify(r)), (e) => seen.push(`${e.status} ${e.message}`));
  const all = seen.join('\n');
  for (const v of [PW, SMS_K, BEAT_K, made('stored', 'pw'), made('kept', 'as', 'it', 'is'), 'stored-host', 'stored-user', 'typed@example.test', SMS.SMS_WEBHOOK_URL, SMS.SMS_ALERT_TO, BEAT.HEARTBEAT_URL, 'hooks.example.test', t.dir])
    assert.ok(!all.includes(v), `in an answer: ${v.slice(0, 8)}…`);
  assert.equal(seen.length, 6);
});

test('the modules: the rules module writes only through the shared writer; the step runner does not name the secrets file; the route logs no body', async () => {
  const rules = await read('src/setup-alerts.mjs');
  assert.doesNotMatch(rules, /writeFile|writePrivate|rename\(|child_process|console\.|fetch\(/);
  assert.match(rules, /upsertSecrets\(pairs, /);
  const runner = (await read('src/setup-write.mjs')).replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(runner, /secrets\.env|upsertSecrets|console\./);
  const server = await read('server.mjs');
  const at = server.indexOf("url.pathname === '/api/setup/step' && req.method === 'POST'");
  const body = server.slice(at, server.indexOf('const am = url.pathname.match', at));
  assert.match(body, /alerts: setupAlerts, alertsFile: SECRETS_FILE/);
  assert.doesNotMatch(body, /b\.answers\)|JSON\.stringify\(b|answers\}/, 'the answers are never logged or put on the ticker');
  for (const line of body.split('\n').filter((l) => /console\.|recordEvent\(/.test(l))) assert.doesNotMatch(line, /answers/, line.trim().slice(0, 60));
  assert.match(server, /const setupAlerts = alertsOffered\(SETTINGS\.setupPage, CALLER\.tripwire\);/);
});

// ---- the form ----
test('the form: only where the board offers the step; hidden inputs for the three; nothing prefilled; nothing kept after a save', async () => {
  const without = view.render({ write: { steps: WRITE_STEPS }, installed: true });
  assert.doesNotMatch(without, /data-form="alerts"|type="password"|SMTP/);
  const html = view.render({ write: { steps: [...WRITE_STEPS, 'alerts'] }, installed: true });
  assert.match(html, /<form class="sw-form" data-form="alerts" autocomplete="off">/);
  for (const k of ALERT_KEYS) assert.equal([...html.matchAll(new RegExp(`name="${k}"`, 'g'))].length, 1, k);
  for (const k of ALERT_KEYS) assert.match(html, new RegExp(`<input type="${HIDDEN_KEYS.includes(k) ? 'password' : 'text'}" name="${k}"`), `${k} input type`);
  assert.doesNotMatch(view.alertsForm(), / value=/, 'no field starts with a value');
  assert.equal([...view.alertsForm().matchAll(/autocomplete="new-password"/g)].length, 3);
  assert.doesNotMatch(view.render({ write: { steps: [...WRITE_STEPS, 'alerts'] }, installed: false }), /<form|<input/);
  // only filled fields are sent
  const get = { text: (n) => ({ SMTP_HOST: 'smtp.example.test', SMTP_PASS: ' x ' }[n] ?? ''), ticked: () => [] };
  assert.deepEqual(plain(view.answersOf('alerts', get)), { SMTP_HOST: 'smtp.example.test', SMTP_PASS: ' x ' });
  const js = await read('public/setup-write.js');
  assert.match(js, /if \(step === 'alerts'\) b\.closest\('form'\)\.reset\(\);\n\s+const res = await fetch\('\/api\/setup\/step'/, 'the form is emptied before the answer comes back, saved or not');
  assert.doesNotMatch(js, /localStorage|sessionStorage|console\./);
  assert.doesNotMatch(js, /test alert|send a test/i);
});

// ---- a real demo board ----
async function board(settings, extra, fn) {
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'setup-alerts-overlay-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { setupPage: settings } }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1', ...extra }), stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    const token = (await (await fetch(`${base}/?setup=1`)).text()).match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    await fn(base, { 'content-type': 'application/json', 'x-mesh-decision': token });
  } finally { child.kill(); }
}
const save = (base, headers, answers) => fetch(`${base}/api/setup/step`, { method: 'POST', headers, body: JSON.stringify({ step: 'alerts', answers }) });

test('a real board with the key and no browser door: the alerts step is not offered, and a save of it is refused as "not on this page"', async () => {
  await board({ mode: 'write', alerts: true }, {}, async (base, headers) => {
    assert.deepEqual((await (await fetch(`${base}/api/setup`)).json()).write, { steps: WRITE_STEPS });
    const res = await save(base, headers, EMAIL);
    assert.equal(res.status, 400);
    assert.match((await res.json()).msg, /not answered on this page/);
  });
});

test('a real board in mode write without the key, with the browser door: the three steps only', async () => {
  await board({ mode: 'write' }, { MC_DEMO_CALLER: 'on,browser' }, async (base) => {
    assert.deepEqual((await (await fetch(`${base}/api/setup`)).json()).write, { steps: WRITE_STEPS });
  });
});

test('a real board with the key and the browser door: the step is offered, and a save that is not from a browser is refused at the door, token or not', async () => {
  await board({ mode: 'write', alerts: true }, { MC_DEMO_CALLER: 'on,browser' }, async (base, headers) => {
    assert.deepEqual((await (await fetch(`${base}/api/setup`)).json()).write, { steps: [...WRITE_STEPS, 'alerts'] });
    const res = await save(base, headers, EMAIL);
    assert.equal(res.status, 403);
    const text = await res.text();
    for (const v of [PW, EMAIL.SMTP_HOST]) assert.ok(!text.includes(v));
    assert.equal((await save(base, { 'content-type': 'application/json' }, EMAIL)).status, 403);
    // nothing of the board's own reading carries a value
    const reading = await (await fetch(`${base}/api/setup`)).text();
    assert.ok(!reading.includes(PW));
  });
});
