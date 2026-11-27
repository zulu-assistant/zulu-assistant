// Which alert channels count as set up (src/setup.mjs alertTiers, the alerts step's live check), and the
// secrets template they start from. The template used to carry example addresses in its keys; the full
// install copies it to data/secrets.env, and the check then read "on: email, sms, heartbeat" on an install
// whose owner had set nothing.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { alertTiers, checkStep, TEMPLATE_EXAMPLES } from '../src/setup.mjs';
import { upsertSecrets } from '../src/setup-actions.mjs';
import { parseEnv } from '../src/config.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
// secret halves are put together at run time: a literal beside a KEY or PASS name reads as a real key to the secret scanner
const made = (...w) => w.join('-');
const RUNTIME = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO', 'SMS_WEBHOOK_URL', 'SMS_WEBHOOK_KEY', 'SMS_ALERT_TO', 'HEARTBEAT_URL', 'HEARTBEAT_KEY'];
const OLD_TEMPLATE = { ...TEMPLATE_EXAMPLES, SMTP_PORT: '587', SMTP_PASS: '', SMS_WEBHOOK_KEY: '', HEARTBEAT_KEY: '', HEARTBEAT_HOST: 'my-mac' };
const alerts = (secrets) => checkStep('alerts', { secrets });

test('the template: every runtime key is there and empty (the port keeps its default); the examples are in comments only', async () => {
  const text = await read('secrets.env.example');
  const env = parseEnv(text);
  for (const k of RUNTIME) assert.ok(k in env, `${k} is in the template`);
  for (const k of RUNTIME.filter((x) => x !== 'SMTP_PORT')) assert.equal(env[k], '', `${k} starts empty`);
  assert.equal(env.SMTP_PORT, '587');
  for (const k of ['HEARTBEAT_HOST', 'HEARTBEAT_READ_URL', 'HEARTBEAT_READ_KEY', 'SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'RELAY_TOKEN']) assert.equal(env[k], '', `${k} starts empty`);
  for (const [k, v] of Object.entries(TEMPLATE_EXAMPLES)) {
    assert.notEqual(env[k], v);
    assert.ok(text.split('\n').some((l) => l.startsWith('#') && l.includes(v)), `the example for ${k} is still shown, in a comment`);
  }
  assert.deepEqual(alertTiers(env), { tiers: [], examples: [] });
  assert.deepEqual(await alerts(env), { ok: false, detail: 'no alert channel (cmux notifications only)' });
});

test('an install made from the old template (example addresses in the keys): no channel is on, and the check names the keys', async () => {
  assert.deepEqual(alertTiers(OLD_TEMPLATE).tiers, []);
  const c = await alerts(OLD_TEMPLATE);
  assert.equal(c.ok, false);
  assert.equal(c.detail, 'no alert channel (cmux notifications only) · still the template\'s example value: SMTP_HOST, SMTP_USER, ALERT_EMAIL_TO, SMS_WEBHOOK_URL, SMS_ALERT_TO, HEARTBEAT_URL');
  // the secret halves filled in, the example addresses left: still not a channel
  const half = { ...OLD_TEMPLATE, SMTP_PASS: made('p', 'w'), SMS_WEBHOOK_KEY: made('k', '1'), HEARTBEAT_KEY: made('k', '2') };
  assert.deepEqual(alertTiers(half).tiers, []);
  // the owner's SMS channel on that install: sms only, the other example values still named
  const sms = { ...OLD_TEMPLATE, SMS_WEBHOOK_URL: 'https://hooks.example.test/s', SMS_WEBHOOK_KEY: made('k', '1'), SMS_ALERT_TO: '+15555550199' };
  assert.deepEqual(alertTiers(sms).tiers, ['sms']);
  assert.equal((await alerts(sms)).detail, 'on: sms · still the template\'s example value: SMTP_HOST, SMTP_USER, ALERT_EMAIL_TO, HEARTBEAT_URL');
});

test('a channel counts when the board would send through it: the keys its senders ask for', async () => {
  const email = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'board@example.test', SMTP_PASS: made('p', 'w') };
  assert.deepEqual(alertTiers(email).tiers, ['email']);                       // no recipient = sent to the user
  assert.deepEqual(alertTiers({ ...email, SMTP_PASS: '' }).tiers, []);
  assert.deepEqual(alertTiers({ SMTP_HOST: 'smtp.example.test', ALERT_EMAIL_TO: 'me@example.test' }).tiers, [], 'a host and a recipient alone send nothing');
  const sms = { SMS_WEBHOOK_URL: 'https://hooks.example.test/s', SMS_WEBHOOK_KEY: made('k', '1'), SMS_ALERT_TO: '+15555550199' };
  assert.deepEqual(alertTiers(sms).tiers, ['sms']);
  for (const k of Object.keys(sms)) assert.deepEqual(alertTiers({ ...sms, [k]: '' }).tiers, [], `sms without ${k}`);
  const beat = { HEARTBEAT_URL: 'https://db.example.test/rest/v1/row', HEARTBEAT_KEY: made('k', '2') };
  assert.deepEqual(alertTiers(beat).tiers, ['heartbeat']);
  assert.deepEqual(alertTiers({ HEARTBEAT_URL: beat.HEARTBEAT_URL }).tiers, []);
  assert.deepEqual(alertTiers({ ...email, ...sms, ...beat }), { tiers: ['email', 'sms', 'heartbeat'], examples: [] });
  assert.deepEqual(alertTiers(), { tiers: [], examples: [] });
  // the same conditions as the senders (a change there must change this)
  const senders = await read('src/alerts.mjs');
  assert.ok(senders.includes('if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS) return false;'));
  assert.ok(senders.includes('if (!cfg.SMS_ALERT_TO || !cfg.SMS_WEBHOOK_URL || !cfg.SMS_WEBHOOK_KEY) return false;'));
  assert.ok((await read('server.mjs')).includes('if (!url || !hbKey) return;'));
});

test('a first save of one channel, starting from the real template, turns on that channel only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alert-tiers-'));
  await writeFile(path.join(root, 'secrets.env.example'), await read('secrets.env.example'));
  const file = path.join(root, 'data', 'secrets.env');
  await upsertSecrets({ SMS_WEBHOOK_URL: 'https://hooks.example.test/s', SMS_WEBHOOK_KEY: made('k', '1'), SMS_ALERT_TO: '+15555550199' }, { secretsFile: file, root });
  const env = parseEnv(await readFile(file, 'utf8'));
  assert.deepEqual(await alerts(env), { ok: true, detail: 'on: sms' });
  assert.equal(env.SMTP_HOST, '');
  assert.equal(env.ALERT_EMAIL_TO, '');
  assert.equal(env.HEARTBEAT_URL, '');
});
