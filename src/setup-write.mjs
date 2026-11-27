// Setup writes (graphical mode, level 1): three of the guided setup's steps answered on the setup page.
//
// What can be written from the page, and nothing else:
//   owner     the owner's name     → src/setup-actions.mjs applyOwner with { files: false }:
//                                    overlay/config/local.json ONLY. The policy text and the two other
//                                    files that carry the name as a placeholder are never opened from
//                                    here; the terminal step fills them.
//   watch     what the board watches, ticked from a scan of this Mac, plus endpoints  → applyWatch
//   engines   Claude Code or Codex per role, the choice only (no login)               → applyEngines
// plus the setup state file (a step whose live check passes is recorded, as the terminal wizard does).
// Every other step is still done in a terminal.
//
// This module decides WHAT may be written; the route (server.mjs, POST /api/setup/step) decides WHO may
// write: this Mac only, the decision door, the decision token, no agent or intake identity.
//
// Rules here:
//   - a fixed field list per step; an unknown step or an unknown field is refused, nothing written
//   - the owner's name is letters, digits, spaces and . ' -, at most 60 (it becomes the board's header
//     and the owner's id, so it must not be able to carry text of its own)
//   - watch items are named by id and looked up in a scan the BOARD ran: the page cannot make an entry up
//   - an endpoint is an http(s) address with no user name or password in it, at most 10
//   - only on an install the installer made (a setup state file exists): a board set up by hand keeps its
//     hand-written config, and is told to use the terminal
//   - a config file that exists and cannot be read as JSON is left as it is (the terminal is named)
//   - not while an upgrade runs
//   - an answer never carries a file's contents: counts, the name that was sent, the step's check line
// Never touched: the rules file, a settings file of an agent program, the trigger file, the token, the
// secrets file.
//
// Switch: SETTINGS.setupPage { mode: 'write' } (mode 'on' = the read-only page; absent or 'off' = no page).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { applyOwner, applyWatch, applyEngines, ENGINE_ROLES, ENGINES } from './setup-actions.mjs';
import { ROOT, STATE_FILE, readState, markStep, checkStep, shellEnv } from './setup.mjs';
import { scanLaunchAgents, scanDocker, scanCron } from './setup-scan.mjs';
import { safeText } from './evidence.mjs';
import { ALERT_KEYS, AlertRefused, checkAlerts, storedSecrets, saveAlerts } from './setup-alerts.mjs';

export const setupWrites = (cfg) => cfg?.mode === 'write';
export const WRITE_STEPS = ['owner', 'watch', 'engines'];
/** The steps this board answers on the page: the three, plus the alerts form where it is offered (src/setup-alerts.mjs). */
export const stepsFor = ({ alerts = false } = {}) => (alerts ? [...WRITE_STEPS, 'alerts'] : WRITE_STEPS);
export const FIELDS = { owner: ['name'], watch: ['jobs', 'docker', 'cron', 'urls'], engines: [...ENGINE_ROLES] };
/** Steps after which the board must start again to show the change (it reads its registry once, at start). */
export const NEEDS_RESTART = ['owner', 'watch'];
/** The config files a step reads before it writes them, relative to overlay/. */
export const STEP_FILES = { owner: ['config/local.json'], watch: ['config/local.json'], engines: ['config/models.json'] };
export const MAX_URLS = 10;
export const MAX_PICKS = 200;
export const USE_TERMINAL = 'use the terminal: zulu setup';
const NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .'’-]{0,58}[\p{L}\p{N}.])?$/u;

export class SetupRefused extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const refuse = (status, msg) => { throw new SetupRefused(status, msg); };
const notHere = () => refuse(400, `that step is not answered on this page (${WRITE_STEPS.join(', ')} are); the others are done in a terminal`);

/** The owner's name as it may be written, or a refusal. */
export function ownerName(v) {
  if (typeof v !== 'string') refuse(400, 'the name must be text');
  const name = v.trim().replace(/ {2,}/g, ' ');
  if (!NAME.test(name)) refuse(400, 'a name is letters, digits, spaces and . \' - (at most 60 characters)');
  return name;
}

/** An endpoint address as it may be written, or a refusal. */
export function endpointUrl(v) {
  if (typeof v !== 'string' || v.length > 200 || /[\s<>"'`\\]/.test(v)) refuse(400, 'an endpoint is one http or https address');
  let u; try { u = new URL(v); } catch { refuse(400, `not an address: ${safeText(v, 60)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') refuse(400, 'an endpoint is an http or https address');
  if (u.username || u.password) refuse(400, 'an endpoint address must not carry a user name or password');
  return v;
}

const idList = (v, what) => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_PICKS || v.some((x) => typeof x !== 'string' || !x || x.length > 300)) refuse(400, `${what} must be a list of names from the scan`);
  return [...new Set(v)];
};

/**
 * The scan the watch step ticks from, as the page may show it: ids and short display text only.
 * A crontab line is cut and goes through the secret check (a command can carry a key).
 */
export async function scanWatch({ prefix, agents = scanLaunchAgents, docker = scanDocker, cron = scanCron } = {}) {
  const p = prefix ?? (await shellEnv()).prefix;
  const [jobs, containers, lines] = await Promise.all([agents(p), docker(), cron()]);
  return {
    jobs: jobs.map((j) => ({ label: j.label, name: j.name })),
    docker: containers.map((c) => ({ name: c.name, status: safeText(c.status || '', 60) })),
    cron: lines.map((c) => ({ id: c.id, match: c.match, schedule: c.schedule, command: safeText(String(c.command || '').slice(0, 70), 80) })),
  };
}

/** A demo board scans nothing of this machine. */
export const DEMO_SCAN = {
  jobs: [{ label: 'com.example.nightly-report', name: 'Nightly Report' }, { label: 'com.example.sync', name: 'Sync' }],
  docker: [{ name: 'demo-db', status: 'Up 3 days' }],
  cron: [{ id: 'rotate-logs', match: 'rotate-logs.sh', schedule: '0 4 * * *', command: '/usr/local/bin/rotate-logs.sh' }],
};

/**
 * Check a step's answers. → the answers as the action takes them. Throws SetupRefused.
 *   scan   (watch only) what scanWatch returned for THIS request: the only source of entries
 */
export function checkAnswers(step, answers, { scan = null, alerts = false, secrets = {} } = {}) {
  if (!stepsFor({ alerts }).includes(step)) notHere();
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) refuse(400, 'answers must be an object');
  const fields = step === 'alerts' ? ALERT_KEYS : FIELDS[step];
  const extra = Object.keys(answers).filter((k) => !fields.includes(k));
  if (extra.length) refuse(400, `not a field of the ${step} step: ${extra.map((k) => safeText(k, 30)).join(', ')}`);
  if (step === 'alerts') {
    // (alerts === true only where the form is offered) `secrets` = what is stored now, for "a channel is saved whole"
    try { return checkAlerts(answers, secrets); } catch (e) { if (e instanceof AlertRefused) refuse(e.status, e.message); throw e; }
  }
  if (step === 'owner') return { name: ownerName(answers.name) };
  if (step === 'engines') {
    for (const role of ENGINE_ROLES) if (!ENGINES.includes(answers[role])) refuse(400, `choose ${ENGINES.join(' or ')} for ${role}`);
    return Object.fromEntries(ENGINE_ROLES.map((r) => [r, answers[r]]));
  }
  // watch: every id must be one the board's own scan found
  if (!scan) refuse(500, 'no scan to choose from');
  const pick = (ids, found, key, what) => ids.map((id) => found.find((x) => x[key] === id) || refuse(400, `${what} not found on this Mac: ${safeText(id, 80)}`));
  const urls = answers.urls === undefined ? [] : answers.urls;
  if (!Array.isArray(urls) || urls.length > MAX_URLS) refuse(400, `at most ${MAX_URLS} endpoints`);
  return {
    jobs: pick(idList(answers.jobs, 'jobs'), scan.jobs, 'label', 'a LaunchAgent'),
    docker: pick(idList(answers.docker, 'docker'), scan.docker, 'name', 'a container'),
    cron: pick(idList(answers.cron, 'cron'), scan.cron, 'id', 'a crontab line'),
    urls: [...new Set(urls.map(endpointUrl))],
  };
}

/** A config file the step is about to rewrite: absent is fine, present must be a JSON object. */
async function readable(file) {
  const text = await readFile(file, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : refuse(409, `a config file of this step cannot be read; ${USE_TERMINAL}`)));
  if (text === null) return;
  let doc; try { doc = JSON.parse(text); } catch { doc = null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) refuse(409, `a config file of this step is not valid JSON, so the page leaves it as it is; ${USE_TERMINAL}`);
}

/**
 * How the board shows a saved step:
 *   'none'    nothing to restart for this step
 *   'self'    the board ends itself after it has answered, and its LaunchAgent (KeepAlive) starts it again.
 *             Only when this process IS the board's LaunchAgent; never a demo board, never with ZULU_NO_LAUNCHD.
 *   'manual'  it shows after the board is restarted some other way
 * No launchctl call either way.
 */
export function restartPlan(step, { demo = false, env = process.env, label = '' } = {}) {
  if (!NEEDS_RESTART.includes(step)) return 'none';
  if (demo || env.ZULU_NO_LAUNCHD || !label || env.XPC_SERVICE_NAME !== label) return 'manual';
  return 'self';
}

const WOULD = { owner: 'save the owner step', watch: 'save what this board watches', engines: 'save the engine choice', alerts: 'save the alert channels' };
/** What a demo board says in place of a write. The answers are still checked, against the demo scan and an empty secrets file. */
export function demoStep(step, answers, { alerts = false } = {}) {
  checkAnswers(step, answers, { scan: step === 'watch' ? DEMO_SCAN : null, alerts });
  return { ok: true, step, demo: true, saved: `demo: would ${WOULD[step]}`, restart: 'none', check: null };
}

/**
 * Run one step from the page. → { ok: true, step, saved, check, recorded }
 *   saved     one plain sentence of what was written (counts and the name that was sent; never file text)
 *   check     the step's live check after the write ({ ok, detail }); a pass is recorded in the state file
 *   recorded  true when the step was marked done
 * ctx: { overlay, stateFile, scan (async, watch only), check, busy }: tests inject all of them.
 *   busy      a sentence when the install is being changed by something else (an upgrade): refused, nothing written
 */
export function runStep(step, answers, ctx = {}) {
  // One save at a time: every step reads a config file and writes it back whole, so two overlapping saves
  // (two tabs, a double submit) would each write over the other's answer. A save that fails does not hold
  // up the next one. Same process only: the board is the one writer.
  const run = chain.then(() => stepNow(step, answers, ctx));
  chain = run.catch(() => {});
  return run;
}
let chain = Promise.resolve();
async function stepNow(step, answers, { overlay = process.env.MC_OVERLAY || path.join(ROOT, 'overlay'), stateFile = STATE_FILE, scan = scanWatch, check = checkStep, busy = null, alerts = false, alertsFile, root } = {}) {
  if (!stepsFor({ alerts }).includes(step)) notHere();
  if (busy) refuse(409, `${busy}: nothing is saved while it runs, try again when it has finished`);
  const state = await readState(stateFile);
  if (!state) refuse(409, `this board was set up by hand (it has no setup record), so the page does not change its config; ${USE_TERMINAL}`);
  if (step === 'alerts') {
    // the one step that writes the secrets file: only where the form is offered, and `alertsFile` is the route's to give
    if (!alertsFile) refuse(500, 'no place to save the alert settings');
    const pairs = checkAnswers(step, answers, { alerts, secrets: await storedSecrets(alertsFile) });
    const written = await saveAlerts(pairs, { secretsFile: alertsFile, root });
    const c = await check(step, { overlay, state, secrets: await storedSecrets(alertsFile) }).catch(() => ({ ok: false, detail: 'this check could not run' }));
    if (c.ok) await markStep(step, 'done', c.detail, stateFile);
    // key names only: a value that was typed is never repeated
    return { ok: true, step, saved: `alert settings saved: ${written.join(', ')}`, recorded: Boolean(c.ok), check: { ok: Boolean(c.ok), detail: safeText(c.detail || '', 200) } };
  }
  const a = checkAnswers(step, answers, { scan: step === 'watch' ? await scan() : null });
  for (const rel of STEP_FILES[step]) await readable(path.join(overlay, rel));
  let saved;
  if (step === 'owner') {
    const r = await applyOwner(a.name, { overlay, files: false });
    saved = `owner saved: ${r.owner.name}. The policy text is not changed from this page: if it still names a placeholder, zulu setup --step owner fills it`;
  } else if (step === 'watch') {
    const n = await applyWatch(a, { overlay });
    saved = `watching ${n.jobs} LaunchAgent(s), ${n.docker} container(s), ${n.cron} crontab line(s), ${n.endpoints} endpoint(s)`;
  } else {
    const e = await applyEngines(a, { overlay, stateFile });
    saved = `engines saved: ${ENGINE_ROLES.map((r) => `${r}=${e[r]}`).join(' · ')} (logging in is each tool's own step, in a terminal)`;
  }
  const c = await check(step, { overlay, state: await readState(stateFile) }).catch(() => ({ ok: false, detail: 'this check could not run' }));
  if (c.ok) await markStep(step, 'done', c.detail, stateFile);
  return { ok: true, step, saved, recorded: Boolean(c.ok), check: { ok: Boolean(c.ok), detail: safeText(c.detail || '', 200) } };
}
