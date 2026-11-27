// The alerts step answered on the setup page (graphical mode, level 1): the one setup form that writes the
// secrets file. src/setup-write.mjs runs it as a step (same route, same door, same one-at-a-time chain);
// this module holds what is particular to it.
//
// What it writes: data/secrets.env through src/setup-actions.mjs upsertSecrets (owner-only), and only the
// ten keys of ALERT_KEYS. The other keys in that file (chat intake, relay, the heartbeat's read side) are
// never written from the page and stay as they are.
//
// Rules, all checked before the file is touched:
//   - every value is one line of text, at most 500 characters: a line break must never be able to start a
//     second line in the secrets file
//   - by field: a host name, a port number, one mail address, phone numbers, https addresses (http only to
//     this machine) with no user name or password in them
//   - an empty field leaves the stored value as it is; the page cannot clear a value
//   - a channel is saved whole or not at all, counting what is already stored: the keys its sender asks for
// What never happens: a stored value is not sent to the page, a typed value is not repeated in an answer or
// a log line (an answer names keys, a refusal names the field), and nothing is sent anywhere as a test.
//
// Switch: SETTINGS.setupPage { mode: 'write', alerts: true }, AND the decision door must refuse a sender
// that is not a browser (SETTINGS.callerEvidence.tripwire 'browser'). Either one missing = no alerts form.
import { readFile } from 'node:fs/promises';
import { upsertSecrets, ONE_LINE } from './setup-actions.mjs';
import { TEMPLATE_EXAMPLES } from './setup.mjs';
import { parseEnv } from './config.mjs';

export const ALERT_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO', 'SMS_WEBHOOK_URL', 'SMS_WEBHOOK_KEY', 'SMS_ALERT_TO', 'HEARTBEAT_URL', 'HEARTBEAT_KEY'];
/** The three that are typed hidden and are never trimmed. */
export const HIDDEN_KEYS = ['SMTP_PASS', 'SMS_WEBHOOK_KEY', 'HEARTBEAT_KEY'];
/** A channel, the keys that belong to it, and the keys its sender needs before it sends (src/setup.mjs alertTiers). */
export const CHANNELS = [
  { id: 'email', keys: ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'ALERT_EMAIL_TO'], needs: ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'] },
  { id: 'sms', keys: ['SMS_WEBHOOK_URL', 'SMS_WEBHOOK_KEY', 'SMS_ALERT_TO'], needs: ['SMS_WEBHOOK_URL', 'SMS_WEBHOOK_KEY', 'SMS_ALERT_TO'] },
  { id: 'heartbeat', keys: ['HEARTBEAT_URL', 'HEARTBEAT_KEY'], needs: ['HEARTBEAT_URL', 'HEARTBEAT_KEY'] },
];
export const MAX_VALUE = 500;

/** The alerts form is offered only with its own key AND a door that refuses a sender that is not a browser. */
export const alertsOffered = (cfg, tripwire) => cfg?.mode === 'write' && cfg.alerts === true && tripwire === 'browser';

export class AlertRefused extends Error {
  constructor(msg) { super(msg); this.status = 400; }
}
const refuse = (msg) => { throw new AlertRefused(msg); };

const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MAIL = /^[^\s@,;<>"'\\]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const THIS_MACHINE = ['localhost', '127.0.0.1', '[::1]'];

function address(key, v) {
  if (/[\s<>"'`\\]/.test(v)) refuse(`${key} must be one https address`);
  let u; try { u = new URL(v); } catch { refuse(`${key} is not an address`); }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && THIS_MACHINE.includes(u.hostname))) refuse(`${key} must be an https address (http only to this machine)`);
  if (u.username || u.password) refuse(`${key} must not carry a user name or password`);
  return v;
}

const RULES = {
  SMTP_HOST: (v) => (HOST.test(v) ? v : refuse('SMTP_HOST must be a host name')),
  SMTP_PORT: (v) => (/^\d{1,5}$/.test(v) && Number(v) >= 1 && Number(v) <= 65535 ? String(Number(v)) : refuse('SMTP_PORT must be a number from 1 to 65535')),
  SMTP_USER: (v) => (/\s/.test(v) ? refuse('SMTP_USER must not hold a space') : v),
  SMTP_PASS: (v) => v,
  ALERT_EMAIL_TO: (v) => (MAIL.test(v) ? v : refuse('ALERT_EMAIL_TO must be one mail address')),
  SMS_WEBHOOK_URL: (v) => address('SMS_WEBHOOK_URL', v),
  SMS_WEBHOOK_KEY: (v) => v,
  SMS_ALERT_TO: (v) => {
    const all = v.split(',').map((x) => x.trim()).filter(Boolean);
    if (!all.length || all.length > 5 || !all.every((x) => PHONE.test(x))) refuse('SMS_ALERT_TO must be phone numbers as +15555550100, several separated by commas');
    return all.join(',');
  },
  HEARTBEAT_URL: (v) => address('HEARTBEAT_URL', v),
  HEARTBEAT_KEY: (v) => v,
};

/**
 * Check the form's answers against what is stored. → the pairs to write (only the fields that were filled).
 * Throws AlertRefused; a refusal names the field, never its value.
 *   current  the secrets as stored now (parseEnv of the file), for "a channel is saved whole"
 */
export function checkAlerts(answers, current = {}) {
  const pairs = {};
  for (const key of ALERT_KEYS) {
    const raw = answers?.[key];
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw !== 'string') refuse(`${key} must be text`);
    if (raw.length > MAX_VALUE) refuse(`${key} is too long (at most ${MAX_VALUE} characters)`);
    if (ONE_LINE.test(raw)) refuse(`${key} must be one line, with no control character`);
    const v = HIDDEN_KEYS.includes(key) ? raw : raw.trim();
    if (v === '') continue;
    pairs[key] = RULES[key](v);
  }
  if (!Object.keys(pairs).length) refuse('nothing to save: fill in at least one channel');
  // a key counts as stored when it holds something that is not the old template's example value
  const have = (k) => k in pairs || (Boolean(current[k]) && current[k] !== TEMPLATE_EXAMPLES[k]);
  for (const ch of CHANNELS) {
    if (!ch.keys.some((k) => k in pairs)) continue;
    const missing = ch.needs.filter((k) => !have(k));
    if (missing.length) refuse(`the ${ch.id} channel also needs: ${missing.join(', ')}`);
  }
  return pairs;
}

/** The secrets as stored now ({} when there is no file yet). */
export async function storedSecrets(secretsFile) {
  return parseEnv(await readFile(secretsFile, 'utf8').catch(() => ''));
}

/** Write the checked pairs. → the keys that were written (names only). */
export const saveAlerts = (pairs, { secretsFile, root } = {}) => upsertSecrets(pairs, { secretsFile, ...(root ? { root } : {}) });
