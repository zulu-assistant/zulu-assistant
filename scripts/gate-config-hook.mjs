#!/usr/bin/env node
// Guardrails settings-change hook, Node step (run by scripts/gate-config-hook.sh).
// Reads the Claude Code ConfigChange hook JSON on stdin ({ source, file_path?, cwd, session_id }),
// reads the changed settings file AND the other settings files of the session, and decides HERE
// (src/gate-integrity.mjs sessionVerdict): blocking needs no board. The board is told afterwards,
// so the owner sees it on the ticker.
// Exit protocol (gate-config-hook.sh relies on it, so silence can never mean "apply"):
//   3 = let the change apply (no output) · 0 = a decision JSON on stdout · anything else = failure → blocked
// `--home <dir>` (tests only) names the user's folder. It is an argument, not an environment
// variable: a settings file can set a session's environment, and cannot add an argument to the
// registered command without the card saying so.
export const EXIT_PASS = 3;
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { sessionVerdict } from '../src/gate-integrity.mjs';
import { boardAddress } from './gate-hook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The user's folder from the account record, not from HOME: the session's environment is not trusted here. */
const accountHome = () => { try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); } };

/** The file that changed: the one the hook input names, else the usual place for that source. */
export function settingsFileFor(j, home = accountHome()) {
  if (typeof j.file_path === 'string' && j.file_path) return j.file_path;
  const cwd = j.cwd || process.cwd();
  if (j.source === 'user_settings') return path.join(home, '.claude', 'settings.json');
  if (j.source === 'project_settings') return path.join(cwd, '.claude', 'settings.json');
  if (j.source === 'local_settings') return path.join(cwd, '.claude', 'settings.local.json');
  return null;
}

/** Every folder that may be the session's project: what Claude Code names, the hook input's folder, the changed file's own. */
export function sessionFolders(j, projectDir) {
  const dirs = [projectDir, j.cwd];
  if ((j.source === 'project_settings' || j.source === 'local_settings') && typeof j.file_path === 'string' && path.basename(path.dirname(j.file_path)) === '.claude') dirs.push(path.dirname(path.dirname(j.file_path)));
  return [...new Set(dirs.filter((d) => typeof d === 'string' && d).map((d) => path.resolve(d)))];
}

/**
 * → { block, why, file, changed }. `changed` is the file the event names; `file` is the one that is
 * the reason (another file when a change blocked earlier is still on disk). A file that is gone
 * or is not JSON reads as null: for the user's own file that drops the gate.
 */
export function judgeChange(j, { root = ROOT, home = accountHome(), read = (f) => readFileSync(f, 'utf8'), projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  const parse = (f) => { try { return JSON.parse(read(f)); } catch { return null; } };
  const changed = settingsFileFor(j, home);
  const others = [{ source: 'user_settings', file: path.join(home, '.claude', 'settings.json') }];
  for (const d of sessionFolders(j, projectDir)) others.push({ source: 'project_settings', file: path.join(d, '.claude', 'settings.json') }, { source: 'local_settings', file: path.join(d, '.claude', 'settings.local.json') });
  const v = sessionVerdict({
    changed: { source: j.source, settings: changed ? parse(changed) : null, file: changed },
    others: others.filter((o) => o.file !== changed).map((o) => ({ ...o, settings: parse(o.file) })),
    repo: root,
  });
  return { ...v, file: v.file || changed, changed };
}

/** What Claude Code reads: `decision: "block"` keeps the new settings from the running session. */
export const blockOutput = (why) => JSON.stringify({ decision: 'block', reason: `GATE: this settings change is not applied to the running session — ${why}` });

/**
 * Where the notice goes: this checkout's own board, by the gate hook's own rule (scripts/gate-hook.mjs
 * boardAddress: data/local.env, else the default port; the environment only with the tests' argument
 * `--env-board`). An environment that names another board gets no notice at all: null.
 */
export function boardUrl(o = {}) {
  const b = boardAddress(o);
  return b.named ? null : b.url;
}

async function main() {
  const j = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const at = process.argv.indexOf('--home');
  const v = judgeChange(j, at > 1 && process.argv[at + 1] ? { home: process.argv[at + 1] } : {});
  if (!v.block) process.exit(EXIT_PASS);
  // tell the board (best effort, 2 s): the block itself never waits on it
  const board = boardUrl();
  if (board) await fetch(`${board}/api/gates/config-change`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(2000),
    body: JSON.stringify({ source: j.source || null, file: v.file, changed: v.changed, why: v.why, cwd: j.cwd || null, session: j.session_id || null }),
  }).catch(() => {});
  process.stdout.write(blockOutput(v.why));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => process.exit(1));
