#!/usr/bin/env node
// Guardrails gate hook, Node step (run by scripts/gate-hook.sh only after a trigger hit).
// Reads the Claude Code / Codex hook JSON on stdin, asks the board (POST /api/gates/check),
// prints the hook decision. Board unreachable → classify locally and DENY anything gated
// (fail closed). Never prints a secret, never writes a file. docs/GUARDRAILS.md.
// Exit protocol (gate-hook.sh relies on it, so silence can never mean "allow"):
//   3 = pass (not gated: no output) · 0 = a decision JSON on stdout · anything else = failure → deny
export const EXIT_PASS = 3;
import { readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { classify, isShellTool, isEnforced, checkMode, mcpParts, mcpAllowKey, MCP_UNLISTED, DEFAULT_POLICY } from '../src/gates.mjs';
import { parseProcTable, chainOf, looksLikeAgent, workspaceInEnv } from '../src/caller.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The folder a shell call runs in. Claude Code's `cwd` is the shell's own folder. Codex's is the SESSION's:
 * its exec_command takes a `workdir` of its own and gives the hook only `{ command }` (codex-rs 0.162.1,
 * exec_command.rs pre_tool_use_payload; seen in live use), so a Codex shell call's folder is not known
 * unless the input carries one (#548). The session folder stays in `cwd` for what is not about a repository.
 * A `workdir` is believed from Codex only: Claude Code's `cwd` is the shell's folder, and nothing in the tool's
 * input may move it.
 */
export function callFolder(j, engine, shell) {
  const ti = j.tool_input || {};
  const base = j.cwd || process.cwd();
  if (!shell || engine !== 'codex') return { cwd: base };
  if (typeof ti.workdir === 'string' && ti.workdir.trim()) return { cwd: path.resolve(base, ti.workdir), folderFrom: 'workdir' };
  return { cwd: base, folderUnread: true };
}

export function hookInput(j, env = process.env) {
  const ti = j.tool_input || {};
  const raw = ti.command ?? ti.cmd ?? ti.argv ?? null;
  // Codex: every tool hook input carries `turn_id`, a required field (codex-rs 0.162.1, hooks/src/schema.rs
  // Pre/PostToolUseCommandInput `turn_id: String`, not an Option); Claude Code's hook input has no such field. Outside cmux
  // that field is the sign. A Claude input that carried one would only be read more strictly (its folder unread).
  const engine = env.CMUX_AGENT_LAUNCH_KIND === 'codex' || j.turn_id ? 'codex' : 'claude';
  const tool = j.tool_name || 'Bash';
  const shell = raw != null && isShellTool(tool);
  return {
    // #627: Codex's PermissionRequest (asked after PreToolUse, before a call leaves its sandbox) is 'permission'
    event: /post/i.test(j.hook_event_name || '') ? 'post' : j.hook_event_name === 'PermissionRequest' ? 'permission' : 'pre',
    engine,
    tool,
    // #627: which call and turn this is (Codex: PreToolUse and PostToolUse carry the call's id; PermissionRequest only the turn)
    ...(typeof j.tool_use_id === 'string' && j.tool_use_id ? { toolUseId: j.tool_use_id.slice(0, 128) } : {}),
    ...(typeof j.turn_id === 'string' && j.turn_id ? { turn: j.turn_id.slice(0, 128) } : {}),
    command: raw,
    // the agent's own description of a shell call (shown on the row, labelled as the agent's words; not part of what an approval binds)
    ...(raw != null && typeof ti.description === 'string' && ti.description.trim() ? { description: ti.description.slice(0, 600) } : {}),
    filePath: ti.file_path || ti.notebook_path || ti.path || null,
    // non-shell tools: the whole input goes to the board, so an approval binds exactly what was asked
    // (an MCP call's arguments, an edit's old/new text) — not just the tool and the file
    ...(raw == null && Object.keys(ti).length ? { toolInput: ti } : {}),
    ...callFolder(j, engine, shell),
    session: j.session_id || null,
    workspaceId: env.CMUX_WORKSPACE_ID || null,
    // a headless run the board itself started (triage, a dispatched fix session): the launcher exports its role.
    // The board resolves it only when no registered workspace answers; offline it is ignored (unknown = enforced).
    identity: env.MESH_GATE_IDENTITY || null,
    // gh acts on this repo when the command names none: the board must read the same PR the command will merge
    ...(env.GH_REPO ? { ghRepo: String(env.GH_REPO).slice(0, 200) } : {}),
    // an MCP call: which server the tool belongs to and where that server was configured (1.3, MCP default)
    ...(j.mcp_server && typeof j.mcp_server === 'object' ? { mcpServer: { name: String(j.mcp_server.name || ''), source: String(j.mcp_server.source || '') } } : {}),
  };
}

export function hookOutput(decision, reason, event = 'pre', updatedInput = null, engine = 'claude') {
  if (event === 'post' || !['allow', 'deny'].includes(decision)) return '';
  // #627: Codex's permission request. Only `allow` is ever answered (the board never denies one), and with no
  // other field: Codex 0.162.1 fails the hook closed on updated_input / updated_permissions / interrupt.
  if (event === 'permission') return decision === 'allow' ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }) : '';
  // #627: Codex takes only `deny` from PreToolUse (its `allow` is "unsupported", and the hook counts as failed). An
  // approved call gets nothing: the same effect, without the failure line; the permission request that follows is
  // the one answered.
  if (engine === 'codex' && decision === 'allow') return '';
  // updatedInput (an allow only): the call runs with this input instead — how an approved merge is pinned to
  // the head the owner saw (`--match-head-commit`). Honoured in auto mode too (checked on 2.1.321).
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason,
    ...(decision === 'allow' && updatedInput ? { updatedInput } : {}) } });
}

/** host:port of an address, for a message: never a path, a query or a name and password. */
export function hostPort(url) {
  try { const u = new URL(String(url)); return u.port ? `${u.hostname}:${u.port}` : u.hostname; } catch { return 'an address that does not parse'; }
}
const sameBoard = (a, b) => { try { const x = new URL(a); const y = new URL(b); const h = (n) => (n === 'localhost' || n === '[::1]' ? '127.0.0.1' : n); return x.protocol === y.protocol && h(x.hostname) === h(y.hostname) && (x.port || '80') === (y.port || '80'); } catch { return false; } };

/**
 * Where the board is: this checkout's own data/local.env, else the default port. NOT the
 * environment. A settings file's env block reaches this process (seen live on Claude Code
 * 2.1.321), and whoever answers at the address decides what runs. The one way the environment is
 * believed is the argument `--env-board`, which the tests pass: an argument cannot come from a
 * settings file, and the registered command has none.
 * → { url, own, named }   named = the other address the environment names (host:port), or null
 */
export function boardAddress({ env = process.env, args = process.argv.slice(2), root = ROOT, read = (f) => readFileSync(f, 'utf8') } = {}) {
  let port = null;
  try { port = /^MC_PORT=(\d+)\s*$/m.exec(read(path.join(root, 'data', 'local.env')))?.[1] || null; } catch { /* no file: the default */ }
  const own = `http://127.0.0.1:${port || 3210}`;
  const fromEnv = env.MESH_BOARD || (env.MC_PORT ? `http://127.0.0.1:${env.MC_PORT}` : null);
  if (args.includes('--env-board')) return { url: fromEnv || own, own, named: null };
  return { url: own, own, named: fromEnv && !sameBoard(fromEnv, own) ? hostPort(fromEnv) : null };
}

/** Offline identity: CMUX_WORKSPACE_ID → the mesh directory (overlay/config/agents.json). null = unknown. */
export function localAgent(workspaceId, { root = ROOT } = {}) {
  if (!workspaceId) return null;
  for (const f of ['overlay/config/agents.json', 'config/agents.json']) {
    try {
      const d = JSON.parse(readFileSync(path.join(root, f), 'utf8'));
      const list = Array.isArray(d.agents) ? d.agents : Object.values(d.agents || {});
      const a = list.find((x) => String(x.workspaceId || '').toLowerCase() === String(workspaceId).toLowerCase() && x.status !== 'closed');
      return a?.name || null;
    } catch { /* next */ }
  }
  return null;
}

/**
 * Board down: which SESSION does this hook run under? Read from the start environment of the
 * topmost agent process above the hook — not from the hook's own environment, which a child
 * session started with another workspace id would carry. (The board does the same walk when it is
 * up: src/caller.mjs.) → { found: an agent process was found above us, ws: its workspace id | null }
 */
export function sessionWorkspace({ pid = process.pid, run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 1500, maxBuffer: 32e6, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  try {
    const top = [...chainOf(pid, parseProcTable(run('ps', ['-axo', 'pid=,ppid=,lstart=,comm='])))].reverse().find((l) => looksLikeAgent(l.comm));
    if (!top) return { found: false, ws: null };
    return { found: true, ws: workspaceInEnv(run('ps', ['-E', '-o', 'command=', '-p', String(top.pid)])) };
  } catch { return { found: false, ws: null }; }
}

/**
 * Board down: decide locally from the policy file (or the shipped default), honoring
 * mode and enforceFor so an observed agent is not blocked. An unknown identity is
 * enforced (fail closed). `sessionWs` (from sessionWorkspace, when it found the session) replaces
 * the workspace id the hook's own environment carries; null there means unknown, so enforced.
 */
export function localVerdict(input, { root = ROOT, home = os.homedir(), sessionWs = undefined } = {}) {
  let policy = DEFAULT_POLICY;
  for (const f of ['overlay/policy.json', 'policy.json', 'examples/policy.json']) {
    try { policy = JSON.parse(readFileSync(path.join(root, f), 'utf8')); break; } catch { /* next */ }
  }
  if (policy.mode === 'off' || policy.mode === 'observe') return { verdict: 'clear', why: `mode ${policy.mode}` };
  const agent = localAgent(sessionWs === undefined ? input.workspaceId : sessionWs, { root });
  if (agent && !isEnforced(policy, agent)) return { verdict: 'clear', why: `${agent} is observed` };
  const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  const command = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? '');
  const tool = isShellTool(input.tool) ? 'Bash' : input.tool;
  const r = classify({ tool, command, filePath: input.filePath, cwd: input.cwd, ...(input.folderUnread ? { folderUnread: true } : {}), mcpServer: input.mcpServer, workspaceId: input.workspaceId }, policy, { home, boardRoot: root, git, repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']) });
  // An MCP tool that reads as a read by its name, while the board cannot be asked: the board's list of
  // seen tools is what pins a tool to the source it was first seen from, and that list is not here. Its
  // allow file is: one line per tool and source the board lets pass. With the MCP check at enforce, a
  // pair that is not on that file is held until the board answers again (no file = the check never ran
  // here, and the name decides as before).
  if (r.verdict === 'clear' && mcpParts(tool) && checkMode(policy, 'mcpDefault') === 'enforce') {
    let allow = null;
    try { allow = readFileSync(path.join(root, 'data', 'guardrails', 'mcp-allow'), 'utf8'); } catch { /* no file */ }
    if (allow != null && !allow.split('\n').includes(mcpAllowKey(tool, input.mcpServer?.source)))
      return { verdict: 'gate', cls: MCP_UNLISTED.id, label: MCP_UNLISTED.label, check: 'mcpDefault', why: 'the board cannot be asked, and this MCP tool from this source is not on its allow file' };
  }
  return r;
}

/** How long this step waits for the board. gate-hook.sh answers "deny" itself at 12 s, and Claude Code lets a call run when a hook answers after its registered limit, so the wait has a ceiling. */
export const BOARD_WAIT_MS = 8000;
/** The environment may shorten the wait (tests do), never lengthen it: a settings file's env block reaches this process. */
export function boardWait(env = process.env) {
  const asked = Number(env.GATE_TIMEOUT_MS);
  return asked > 0 && asked < BOARD_WAIT_MS ? asked : BOARD_WAIT_MS;
}

/** #708: the board took longer than this hook waits (fetch's own timeout), as opposed to a refused or failed connection. */
export const waitRanOut = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
export const boardLate = (ms) => `GATE: the board did not answer within ${Math.round(ms / 1000)} s — gated command not run (fail closed). Run it again; if it keeps happening, tell the owner.`;

async function main() {
  const raw = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const input = hookInput(raw);
  let r;
  const timeout = boardWait();
  const board = boardAddress();
  try {
    // an environment that names another board is treated as "no board": NOBODY is asked (not that
    // address, and not the real board either, so a test that forgets `--env-board` can never reach a
    // live board), and the call is judged here, as when the board is down: a gated call is denied
    if (board.named) throw new Error('the environment names another board');
    // the deadline tells the board when this hook stops waiting: a request it only gets to later
    // (a frozen or overloaded board) is dropped instead of filing a gate nobody was told about
    const res = await fetch(`${board.url}/api/gates/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, deadline: Date.now() + timeout }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`board said ${res.status}`);
    r = await res.json();
  } catch (e) {
    // a call that already ran, or Codex's own permission request (#627: no board, no allow; Codex asks as usual)
    if (input.event === 'post' || input.event === 'permission') process.exit(EXIT_PASS);
    // the session this hook really runs under, when it can be told (else the declared id, as before)
    const s = sessionWorkspace();
    const v = localVerdict(input, s.found ? { sessionWs: s.ws } : {});
    r = v.verdict !== 'gate' ? { decision: 'pass' }
      : board.named ? { decision: 'deny', reason: `GATE: this session's environment names another board (${board.named}), and the gate hook only asks its own (${hostPort(board.own)}) — gated command not run (fail closed). Tell the owner: MESH_BOARD or MC_PORT is set by a settings file's env block or a shell profile.` }
        // #708: the board was there and slow (the wait ran out) is not the board being down
        : waitRanOut(e) ? { decision: 'deny', reason: boardLate(timeout) }
          : { decision: 'deny', reason: 'GATE: board unreachable — gated command not run (fail closed). Retry when the board is up.' };
  }
  // only a plain string command is rewritten (Claude Code's Bash input); the board falls back to re-reading for anything else
  const updated = r.decision === 'allow' && typeof r.updatedCommand === 'string' && typeof raw.tool_input?.command === 'string' ? { ...raw.tool_input, command: r.updatedCommand } : null;
  const out = hookOutput(r.decision, r.reason, input.event, updated, input.engine);
  if (!out) process.exit(EXIT_PASS);
  process.stdout.write(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => process.exit(1));
