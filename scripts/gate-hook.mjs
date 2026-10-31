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
import { classify, isEnforced, DEFAULT_POLICY } from '../src/gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function hookInput(j, env = process.env) {
  const ti = j.tool_input || {};
  const raw = ti.command ?? ti.cmd ?? ti.argv ?? null;
  return {
    event: /post/i.test(j.hook_event_name || '') ? 'post' : 'pre',
    engine: env.CMUX_AGENT_LAUNCH_KIND === 'codex' || j.turn_id ? 'codex' : 'claude',
    tool: j.tool_name || 'Bash',
    command: raw,
    filePath: ti.file_path || ti.notebook_path || ti.path || null,
    // non-shell tools: the whole input goes to the board, so an approval binds exactly what was asked
    // (an MCP call's arguments, an edit's old/new text) — not just the tool and the file
    ...(raw == null && Object.keys(ti).length ? { toolInput: ti } : {}),
    cwd: j.cwd || process.cwd(),
    session: j.session_id || null,
    workspaceId: env.CMUX_WORKSPACE_ID || null,
  };
}

export function hookOutput(decision, reason, event = 'pre') {
  if (event === 'post' || !['allow', 'deny'].includes(decision)) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
}

function boardUrl(env = process.env) {
  if (env.MESH_BOARD) return env.MESH_BOARD;
  let port = env.MC_PORT;
  if (!port) { try { port = /^MC_PORT=(\d+)/m.exec(readFileSync(path.join(ROOT, 'data', 'local.env'), 'utf8'))?.[1]; } catch { /* default */ } }
  return `http://127.0.0.1:${port || 3210}`;
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
 * Board down: decide locally from the policy file (or the shipped default), honoring
 * mode and enforceFor so an observed agent is not blocked. An unknown identity is
 * enforced (fail closed).
 */
export function localVerdict(input, { root = ROOT, home = os.homedir() } = {}) {
  let policy = DEFAULT_POLICY;
  for (const f of ['overlay/policy.json', 'policy.json', 'examples/policy.json']) {
    try { policy = JSON.parse(readFileSync(path.join(root, f), 'utf8')); break; } catch { /* next */ }
  }
  if (policy.mode === 'off' || policy.mode === 'observe') return { verdict: 'clear', why: `mode ${policy.mode}` };
  const agent = localAgent(input.workspaceId, { root });
  if (agent && !isEnforced(policy, agent)) return { verdict: 'clear', why: `${agent} is observed` };
  const git = (cwd, args) => { try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
  const command = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? '');
  const tool = /^(shell|exec_command|local_shell|container\.exec|unified_exec)$/i.test(input.tool) ? 'Bash' : input.tool;
  return classify({ tool, command, filePath: input.filePath, cwd: input.cwd }, policy, { home, boardRoot: root, git, repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']) });
}

async function main() {
  const input = hookInput(JSON.parse(readFileSync(0, 'utf8') || '{}'));
  let r;
  const timeout = Number(process.env.GATE_TIMEOUT_MS) || 8000;
  try {
    // the deadline tells the board when this hook stops waiting: a request it only gets to later
    // (a frozen or overloaded board) is dropped instead of filing a gate nobody was told about
    const res = await fetch(`${boardUrl()}/api/gates/check`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, deadline: Date.now() + timeout }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) throw new Error(`board said ${res.status}`);
    r = await res.json();
  } catch {
    if (input.event === 'post') process.exit(EXIT_PASS);
    const v = localVerdict(input);
    r = v.verdict === 'gate'
      ? { decision: 'deny', reason: 'GATE: board unreachable — gated command not run (fail closed). Retry when the board is up.' }
      : { decision: 'pass' };
  }
  const out = hookOutput(r.decision, r.reason, input.event);
  if (!out) process.exit(EXIT_PASS);
  process.stdout.write(out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch(() => process.exit(1));
