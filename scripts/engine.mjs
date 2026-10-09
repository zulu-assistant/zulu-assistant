#!/usr/bin/env node
// Which AI engine runs each role, and the exact command line that starts it.
//
//   node scripts/engine.mjs <role>                         → claude | codex
//   node scripts/engine.mjs cmd <role> [--name N] [--model M] [--prompt-file F]
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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from '../src/config.mjs';

export const ROLES = ['master', 'worker', 'resident', 'triage'];
export const ENGINES = ['claude', 'codex'];

export function engineFor(role, models = {}) {
  const e = models.engine || {};
  const v = e[role] || (role === 'resident' ? e.worker : null) || 'claude';
  return ENGINES.includes(v) ? v : 'claude';
}

/** POSIX single-quote a word for a command string. */
export const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const CODEX_SANDBOX = ['-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];

/**
 * The launch argv for an interactive role (cmux runs it as the workspace command),
 * or for the headless triage pass. Returns { engine, argv, stdin? }.
 */
export function launchSpec(role, { models = {}, name = null, model = null, promptFile = null, allowed = null } = {}) {
  const engine = engineFor(role, models);
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
  return { engine, argv: ['codex', ...CODEX_SANDBOX, '-a', 'on-request', ...(cm ? ['-m', cm] : [])] };
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
    return console.log(commandLine(launchSpec(b, { models, name: flag('name'), model: flag('model'), promptFile: flag('prompt-file') })));
  }
  console.error('usage: engine.mjs <master|worker|resident|triage> | engine.mjs cmd <role> [--name N] [--model M]');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
