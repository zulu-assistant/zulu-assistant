// Buttons on the setup page (graphical mode): four fixed command lines the board may start for the owner.
//
//   guardrails-check   ./install.sh --guardrails --dry-run          writes nothing; its output is shown
//   guardrails         ./install.sh --guardrails --yes              only after a check, and only when a fresh
//                                                                   check reads the same as the one shown
//   backup             node scripts/backup.mjs backup               one archive in data/backups/, no secrets
//   restore-check      node scripts/backup.mjs restore <newest>     the dry run: nothing is written
//
// The request carries the button's id and nothing else. The command line comes from BUTTONS below; no word
// of it comes from the request. The archive a restore check reads is the newest one in data/backups/, picked
// here. Never passed, and a test reads the table for them: --switch, --remove, --allow-older-claude, --codex,
// --apply, --with-secrets, --full, --out.
//
// What "guardrails" writes is what the terminal command writes: "defaultMode": "enforce" in the overlay
// rules file when that key is absent, the board's LaunchAgent (the board restarts), and the gate hook in the
// Claude Code settings file (a backup is taken first). On an install that already runs the full board the
// installer refuses by itself, because --switch is never passed.
//
// The child: an environment built from nothing (no board token, no mesh or cmux variable, no secret), an
// argument array (no shell), the checkout as its folder, a time limit. The guardrails write restarts the
// board, so that one child runs in its own session with its output in an owner-only log file; the page reads
// the result once the board answers again.
//
// One run at a time: a click while one is in flight is refused, never queued.
//
// WHO may click is the route's (server.mjs, POST /api/setup/button): this Mac, the decision door, the
// decision token, no agent or intake identity, and here also positive evidence that the sender is a browser
// (browserProven): a lookup that failed or a sender that has left is refused, where the forms let it pass.
//
// Switch: SETTINGS.setupPage { mode: 'write', buttons: true } AND callerEvidence.tripwire 'browser'.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, readdir, stat, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from './private-file.mjs';
import { containsSecret } from './secret-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = Symbol('the newest archive');
const NODE = Symbol('this Node program');

/** The whole table. `says` is shown before the second click. */
export const BUTTONS = Object.freeze({
  'guardrails-check': Object.freeze({
    title: 'CHECK WHAT GUARDRAILS WOULD CHANGE', cmd: '/bin/bash', args: Object.freeze(['install.sh', '--guardrails', '--dry-run']),
    says: 'Shows what turning Guardrails on would change. Nothing is written.',
  }),
  guardrails: Object.freeze({
    title: 'TURN GUARDRAILS ON', cmd: '/bin/bash', args: Object.freeze(['install.sh', '--guardrails', '--yes']), needsCheck: true, detached: true,
    says: 'Writes what the check above lists: the rules file gets the enforce default when it has none (every agent session is then held, not only watched), the gate hook is added to the Claude Code settings file (a backup is taken first), and the board restarts. It is not undone from this page.',
  }),
  backup: Object.freeze({
    title: 'BACK UP NOW', cmd: NODE, args: Object.freeze(['scripts/backup.mjs', 'backup']),
    says: 'Writes one archive of your state and config into data/backups/. Secrets are left out.',
  }),
  'restore-check': Object.freeze({
    title: 'CHECK THE NEWEST BACKUP', cmd: NODE, args: Object.freeze(['scripts/backup.mjs', 'restore', ARCHIVE]),
    says: 'Reads the newest archive in data/backups/ and says what restoring it would change. Nothing is written; a restore itself is a terminal command.',
  }),
});
export const BUTTON_IDS = Object.freeze(Object.keys(BUTTONS));
/** Flags no button may ever pass. */
export const NEVER_FLAGS = Object.freeze(['--switch', '--remove', '--allow-older-claude', '--codex', '--apply', '--with-secrets', '--full', '--out', '--force']);
export const CHECK_MINUTES = 10;
export const TIMEOUT_MS = 120e3;
export const MAX_OUTPUT = 16 * 1024;
export const RUNS_DIR = 'data/setup-runs';

/** Offered only with their own key, write mode, and a door that refuses a sender that is not a browser. */
export const buttonsOffered = (cfg, tripwire) => cfg?.mode === 'write' && cfg.buttons === true && tripwire === 'browser';

/**
 * Positive evidence that a browser on this machine sent the request, with no agent session behind it.
 * No evidence, a failed lookup ('unknown'), a sender that has left ('gone') and another device are all false.
 */
export const browserProven = (ev) => Boolean(ev && ev.browser === true && !ev.agentAncestor && !['unknown', 'gone', 'remote'].includes(ev.kind));

export class ButtonRefused extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const refuse = (status, msg) => { throw new ButtonRefused(status, msg); };

/** The environment every child gets: nothing from the board's own but who and where the user is. */
export function bareEnv({ env = process.env, node = process.execPath } = {}) {
  const out = { PATH: `${path.dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: env.HOME || os.homedir(), LANG: env.LANG || 'en_US.UTF-8' };
  for (const k of ['USER', 'LOGNAME', 'TMPDIR']) if (env[k]) out[k] = env[k];
  // the two switches the installer's own tests use, so a board started without launchd starts none here either
  for (const k of ['ZULU_NO_LAUNCHD', 'ZULU_NO_OPEN']) if (env[k]) out[k] = env[k];
  return out;
}

/** The newest `.tgz` in the backups folder → its absolute path, or null. A name with anything odd in it is not taken. */
export async function newestArchive(root = ROOT) {
  const dir = path.join(root, 'data', 'backups');
  let best = null;
  for (const name of await readdir(dir).catch(() => [])) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(name)) continue;
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (s?.isFile() && (!best || s.mtimeMs > best.at)) best = { file: path.join(dir, name), at: s.mtimeMs };
  }
  return best?.file || null;
}

/** The command line of one button → { cmd, args }. Unknown id = refused. Reads nothing from a request. */
export async function commandFor(id, { root = ROOT, node = process.execPath } = {}) {
  if (typeof id !== 'string' || !Object.hasOwn(BUTTONS, id)) refuse(400, 'that button does not exist');
  const b = BUTTONS[id];
  const args = [];
  for (const [i, a] of b.args.entries()) {
    if (a === ARCHIVE) {
      const file = await newestArchive(root);
      if (!file) refuse(409, 'there is no backup in data/backups/ yet: BACK UP NOW makes one');
      args.push(file);
    } else args.push(i === 0 ? path.join(root, a) : a);          // the script, by its full path
  }
  return { cmd: b.cmd === NODE ? node : b.cmd, args };
}

/** Output for the page: the last 16 KB, a line that looks like a secret withheld. */
export function shownOutput(text) {
  const s = String(text || '');
  const tail = s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT).replace(/^[^\n]*\n/, '') : s;
  return tail.split('\n').map((l) => (containsSecret(l) ? '(a line withheld: it looks like a secret)' : l)).join('\n');
}

const digest = (code, out) => createHash('sha256').update(`${code}\n${out}`).digest('hex');

/** Run one command to its end (attached). → { code, out }; a time limit that passes = code null, timedOut. */
export function runAttached(cmd, args, { root = ROOT, env = bareEnv(), timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: root, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, shell: false }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      if (!err) return resolve({ code: 0, out });
      if (err.killed || err.signal) return resolve({ code: null, timedOut: true, out });
      resolve({ code: typeof err.code === 'number' ? err.code : 1, out: out || String(err.message || '') });
    });
  });
}

/** Start one command in its own session with its output in an owner-only log. → { log, child }. */
export async function runDetached(cmd, args, { root = ROOT, env = bareEnv(), now = new Date() } = {}) {
  const dir = path.join(root, RUNS_DIR);
  await mkdir(dir, { recursive: true });
  const log = path.join(dir, `guardrails-${now.toISOString().replace(/[:.]/g, '-')}.log`);
  await writePrivate(log, '');
  const fh = await open(log, 'a');
  try {
    const child = spawn(cmd, args, { cwd: root, env, detached: true, stdio: ['ignore', fh.fd, fh.fd], shell: false });
    child.unref();
    return { log, child };
  } finally { await fh.close(); }
}

/** The newest guardrails run's log, for the page after the board is back. → { at, text } | null */
export async function lastRun(root = ROOT) {
  const dir = path.join(root, RUNS_DIR);
  const names = (await readdir(dir).catch(() => [])).filter((n) => /^guardrails-[0-9TZ-]+\.log$/.test(n)).sort();
  const name = names.at(-1);
  if (!name) return null;
  const s = await stat(path.join(dir, name)).catch(() => null);
  const text = await readFile(path.join(dir, name), 'utf8').catch(() => '');
  return { at: s ? new Date(s.mtimeMs).toISOString() : null, text: shownOutput(text) };
}

/**
 * The runner one board keeps. `run(id, { busy })` → { ok, id, code, output, [checked], [started] }.
 * State in memory only: which run is in flight, and the last check's digest and time.
 * Tests inject attached / detached / now.
 */
export function createButtons({ root = ROOT, node = process.execPath, env = () => bareEnv({ node }), attached = runAttached, detached = runDetached, now = () => Date.now() } = {}) {
  let inFlight = null;
  let lastCheck = null;          // { hash, at }
  async function run(id, { busy = null } = {}) {
    if (typeof id !== 'string' || !Object.hasOwn(BUTTONS, id)) refuse(400, 'that button does not exist');
    if (busy) refuse(409, `${busy}: nothing is started while it runs, try again when it has finished`);
    if (inFlight) refuse(409, `"${BUTTONS[inFlight].title}" is still running: wait for it to finish, then click again`);
    inFlight = id;
    let release = true;
    try {
      const b = BUTTONS[id];
      if (b.needsCheck) {
        if (!lastCheck || now() - lastCheck.at > CHECK_MINUTES * 60e3) refuse(409, `run the check first and read it (a check counts for ${CHECK_MINUTES} minutes)`);
        const c = await commandFor('guardrails-check', { root, node });
        const again = await attached(c.cmd, c.args, { root, env: env() });
        if (again.code !== 0 || digest(again.code, again.out) !== lastCheck.hash) {
          lastCheck = null;
          refuse(409, 'the check reads differently now than when you read it: run the check again, nothing was written');
        }
        lastCheck = null;                                       // one check, one write
      }
      const { cmd, args } = await commandFor(id, { root, node });
      if (b.detached) {
        const { log, child } = await detached(cmd, args, { root, env: env() });
        release = false;                                        // in flight until that child ends (or the board restarts)
        child?.once?.('exit', () => { inFlight = null; });
        child?.once?.('error', () => { inFlight = null; });
        return { ok: true, id, started: true, log: path.relative(root, log), output: '' };
      }
      const r = await attached(cmd, args, { root, env: env() });
      if (id === 'guardrails-check') lastCheck = r.code === 0 ? { hash: digest(r.code, r.out), at: now() } : null;
      return { ok: r.code === 0, id, code: r.code, timedOut: Boolean(r.timedOut), checked: id === 'guardrails-check' && r.code === 0, output: shownOutput(r.out) };
    } finally { if (release) inFlight = null; }
  }
  return { run, running: () => inFlight, checkedAt: () => lastCheck?.at ?? null };
}

/** What a demo board answers: nothing is started. */
export function demoButton(id) {
  if (typeof id !== 'string' || !Object.hasOwn(BUTTONS, id)) refuse(400, 'that button does not exist');
  return { ok: true, id, code: 0, output: `demo: would run "${BUTTONS[id].title}" (nothing was started)`, checked: id === 'guardrails-check' };
}

/** What the page needs to draw the buttons (no command lines). */
export const buttonList = () => BUTTON_IDS.map((id) => ({ id, title: BUTTONS[id].title, says: BUTTONS[id].says, needsCheck: Boolean(BUTTONS[id].needsCheck) }));
