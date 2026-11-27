#!/usr/bin/env node
// Which AI engine runs each role, and the exact command line that starts it.
//
//   node scripts/engine.mjs <role>                         → claude | codex | gemini
//   node scripts/engine.mjs cmd <role> [--name N] [--model M] [--prompt-file F] [--engine claude|codex|gemini]
//                                                          → the launch command (shell-quoted)
// Roles: master (Mission Control) · worker (agent-spawn) · resident · triage (headless)
//
// The choice lives in config/models.json `engine: { master, worker, resident?, triage }`
// (written by `zulu setup --step engines`; resident falls back to worker; default claude
// everywhere, so an install that never chose keeps today's behaviour).
// Optional `codex: { model, workerModel }` pins Codex models; unset = Codex's own default.
//
// Bounds differ by engine and the docs say so: Claude roles keep their per-tool
// allowlists / permission modes; Codex has no per-tool allowlist, so Codex roles
// run in Codex's workspace-write sandbox with on-request approvals (interactive)
// or the same sandbox with approvals off (headless triage — it can only write in
// the repo; network is enabled because the board is on localhost).
// Gemini CLI (#812) is a RESIDENT engine only: `gemini --approval-mode default` (Gemini asks before every tool
// call), never `--yolo` or another mode, whatever models.json says, because Gemini sessions are outside the
// Guardrails hook. Optional `gemini: { model }` pins the model. `engine.<role> = gemini` for any other role reads
// as claude (no headless or Mission Control Gemini), and `--engine gemini` for one is refused.
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from '../src/config.mjs';

export const ROLES = ['master', 'worker', 'resident', 'triage'];
export const ENGINES = ['claude', 'codex', 'gemini'];
/** Engines a role may run; Gemini only as a resident. */
export const enginesFor = (role) => (role === 'resident' ? ENGINES : ENGINES.filter((e) => e !== 'gemini'));

export function engineFor(role, models = {}) {
  const e = models.engine || {};
  // a resident falls back to the worker's engine only when a worker could run it (never gemini that way)
  const own = e[role] || (role === 'resident' && e.worker !== 'gemini' ? e.worker : null) || 'claude';
  return enginesFor(role).includes(own) ? own : 'claude';
}

/** The Gemini resident's approval mode: always `default`. */
export const GEMINI_APPROVAL = 'default';

/** POSIX single-quote a word for a command string. */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const CODEX_SANDBOX = ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
export const CODEX_APPROVALS = ['on-request', 'never'];

/**
 * Interactive Codex approvals and extra writable folders (models.json `codex.approval`, `codex.addDirs`).
 * `never` = Codex asks nothing; a sandbox refusal goes back to the model, and the Guardrails hook still holds
 * gated calls before Codex runs them (probed on 0.170.0). Default `on-request`, no extra folders.
 * addDirs: absolute paths or `~/…` (expanded with this home). Anything else, a `..` part, `/`, the home or any
 * folder above it is skipped, also when a link leads there (the real path is checked when the folder exists),
 * so a typo never opens the whole home.
 */
export function codexInteractive(models = {}, home = os.homedir(), real = realOrSelf) {
  const c = models.codex || {};
  const approval = CODEX_APPROVALS.includes(c.approval) ? c.approval : 'on-request';
  const homes = [path.resolve(home), real(path.resolve(home))];
  const opensHome = (r) => r === '/' || homes.some((h) => h === r || h.startsWith(r.endsWith('/') ? r : `${r}/`));
  const addDirs = [];
  for (const d of Array.isArray(c.addDirs) ? c.addDirs : []) {
    if (typeof d !== 'string' || d.split('/').includes('..')) continue;
    const p = d.startsWith('~/') ? path.join(home, d.slice(2)) : d;
    if (!path.isAbsolute(p)) continue;
    const r = path.resolve(p);
    if (opensHome(r) || opensHome(real(r))) continue;
    if (!addDirs.includes(r)) addDirs.push(r);
  }
  return { approval, addDirs };
}

/** The real path of a folder that exists, else the path as given. */
function realOrSelf(p) {
  try { return realpathSync(p); } catch { return p; }
}

/**
 * The launch argv for an interactive role (cmux runs it as the workspace command),
 * or for the headless triage pass. Returns { engine, argv, stdin? }.
 * `engine` names the engine for this one launch (a Codex resident on a Claude fleet); unknown = the role's own.
 */
export function launchSpec(role, { models = {}, name = null, model = null, promptFile = null, allowed = null, engine: forced = null } = {}) {
  const engine = enginesFor(role).includes(forced) ? forced : engineFor(role, models);
  if (engine === 'gemini') {
    const gm = model || models.gemini?.model || null;
    return { engine, argv: ['gemini', '--approval-mode', GEMINI_APPROVAL, ...(gm ? ['-m', gm] : [])] };
  }
  if (engine === 'claude') {
    const argv = ['claude'];
    if (role === 'triage') return { engine, argv: [...argv, '-p', ...(model ? ['--model', model] : []), '--permission-mode', 'acceptEdits', '--allowedTools', allowed || ''], stdin: promptFile };
    if (name) argv.push('--name', name);
    argv.push('--permission-mode', role === 'worker' ? 'auto' : 'acceptEdits');
    if (model) argv.push('--model', model);
    return { engine, argv };
  }
  const cm = model || (role === 'master' ? models.codex?.model : models.codex?.workerModel || models.codex?.model) || null;
  if (role === 'triage') {
    return { engine, argv: ['codex', 'exec', ...CODEX_SANDBOX, '--skip-git-repo-check', ...(cm ? ['-m', cm] : []), '-'], stdin: promptFile };
  }
  const ci = codexInteractive(models);
  return { engine, argv: ['codex', ...CODEX_SANDBOX, '-a', ci.approval, ...ci.addDirs.flatMap((d) => ['--add-dir', d]), ...(cm ? ['-m', cm] : [])] };
}

export const commandLine = (spec) => spec.argv.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : q(a))).join(' ');

function loadModels() {
  try { return JSON.parse(readFileSync(resolve('config/models.json'), 'utf8')); } catch { return {}; }
}

function main() {
  const [a, b, ...rest] = process.argv.slice(2);
  const flag = (k) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : null; };
  const models = loadModels();
  if (ROLES.includes(a)) return console.log(engineFor(a, models));
  if (a === 'cmd' && ROLES.includes(b)) {
    const forced = flag('engine');
    if (forced && !enginesFor(b).includes(forced)) { console.error(`engine.mjs: engine ${forced} cannot run the ${b} role`); process.exit(2); }
    return console.log(commandLine(launchSpec(b, { models, name: flag('name'), model: flag('model'), promptFile: flag('prompt-file'), engine: forced })));
  }
  console.error('usage: engine.mjs <master|worker|resident|triage> | engine.mjs cmd <role> [--name N] [--model M] [--engine claude|codex|gemini]');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
