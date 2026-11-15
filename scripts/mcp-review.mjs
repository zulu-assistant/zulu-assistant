#!/usr/bin/env node
// Guardrails MCP review: the MCP tools the gate hook has shown the board, in three groups —
// held by a rule, passing as a read, and not classified (held as `mcp-unlisted` once the
// `mcpDefault` check is `enforce`). Prints a proposed read list. Read-only.
//
//   node scripts/mcp-review.mjs [--json] [--root <checkout>] [--policy <policy.json>]
//
// The read list changes only through an edit of the policy file (lists.mcpRead), which is a held action.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify, mcpParts, MCP_UNLISTED, DEFAULT_POLICY } from '../src/gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** seen: { tool: { server, source, count, lastSeen, agents } } → { rule: [], read: [], unlisted: [] } with the policy as it is now. */
export function review(seen, policy) {
  const out = { rule: [], read: [], unlisted: [] };
  for (const [tool, e] of Object.entries(seen || {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!mcpParts(tool)) continue;
    const r = classify({ tool, command: '', filePath: null, cwd: '/', mcpServer: { name: e.server, source: e.source } }, policy,
      { triggers: [], mcpSeen: seen, checks: { mcpDefault: 'enforce', desktop: 'enforce' } });
    const row = { tool, server: e.server, source: e.source || '', count: e.count || 0, lastSeen: e.lastSeen || '', agents: e.agents || [] };
    if (r.verdict === 'clear') out.read.push(row);
    else if (r.cls === MCP_UNLISTED.id) out.unlisted.push({ ...row, why: r.why });
    else out.rule.push({ ...row, cls: r.cls });
  }
  return out;
}

export function render(g) {
  const line = (r, extra = '') => `  ${r.tool}${extra}  · ${r.count}× · last ${String(r.lastSeen).slice(0, 10) || '?'}${r.source ? ` · ${r.source}` : ''}`;
  const out = [`MCP tools seen: ${g.rule.length + g.read.length + g.unlisted.length}`];
  out.push(`held by a rule (${g.rule.length}):`, ...g.rule.map((r) => line(r, `  [${r.cls}]`)));
  out.push(`passing as a read (${g.read.length}):`, ...g.read.map((r) => line(r)));
  out.push(`not classified, held once mcpDefault is enforce (${g.unlisted.length}):`, ...g.unlisted.map((r) => line(r)));
  if (g.unlisted.length) {
    out.push('', 'For each unclassified tool: if it only reads, add its exact name to lists.mcpRead in the policy file;', 'if it changes something, add a rule under the class it belongs to. As a starting point:',
      JSON.stringify({ mcpRead: g.unlisted.map((r) => r.tool) }, null, 2));
  }
  return out.join('\n');
}

function main(argv) {
  const arg = (n) => { const k = argv.indexOf(n); return k >= 0 ? argv[k + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 9).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const root = path.resolve(arg('--root') || ROOT);
  let seen = {}; try { seen = JSON.parse(readFileSync(path.join(root, 'data', 'guardrails', 'mcp-seen.json'), 'utf8')); } catch { /* nothing seen yet */ }
  let policy = DEFAULT_POLICY;
  for (const f of arg('--policy') ? [arg('--policy')] : ['overlay/policy.json', 'policy.json', 'examples/policy.json'].map((x) => path.join(root, x))) {
    try { policy = JSON.parse(readFileSync(f, 'utf8')); break; } catch { /* next */ }
  }
  const g = review(seen, policy);
  console.log(argv.includes('--json') ? JSON.stringify(g, null, 1) : render(g));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`mcp-review: ${e.message}`); process.exit(1); }
}
