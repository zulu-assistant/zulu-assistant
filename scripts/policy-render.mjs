#!/usr/bin/env node
// Render policy.json (the enforced gates) as the marked block in POLICY.md, so the
// human-readable policy and what the gate hook enforces can't drift (a test checks).
//   node scripts/policy-render.mjs                 print the block for the resolved policy
//   node scripts/policy-render.mjs --write <POLICY.md> <policy.json>   replace the block in place
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

export const BEGIN = '<!-- gates:begin (generated from policy.json by scripts/policy-render.mjs — edit the JSON, not this block) -->';
export const END = '<!-- gates:end -->';

// a list value is either inline (["--dry-run"]) or a reference to policy.lists ("@dryFlags")
const items = (v) => (Array.isArray(v) ? v.map((a) => `\`${a}\``).join(' / ') : String(v));
const ruleText = (r) => {
  const bits = [];
  if (r.scriptIn) bits.push(`a script in ${items(r.scriptIn)}${r.args ? ` run as \`… ${r.args.join(' ')}\`` : ''}`);
  else if (r.script) bits.push('a script');
  if (r.bin) bits.push(`\`${[r.bin, ...(r.args || [])].join(' ')}\``);
  if (r.argsAny) bits.push(`with ${items(r.argsAny)}`);
  if (r.flagsAny) bits.push(`with ${items(r.flagsAny)}`);
  if (r.unlessFlags) bits.push(`(not with ${items(r.unlessFlags)})`);
  if (r.notArgs?.length) bits.push(`(not ${r.notArgs.map((a) => `\`${a.join(' ')}\``).join(', ')})`);
  if (r.method) bits.push(`${r.method}`);
  if (r.urlAny) bits.push(`to ${items(r.urlAny)}`);
  if (r.labels) bits.push(`of a label in ${r.labels}`);
  if (r.unlessLabels) bits.push(`of a label not in ${r.unlessLabels}`);
  if (r.when === 'pushProtected') bits.push(`to ${(r.protectedRefs || []).map((x) => `\`${x}\``).join('/')}, forced, tags, ref deletes, any push to @publicRemotes or @deployOnPush (free: ${(r.allowRefs || []).map((x) => `\`${x}\``).join(', ') || 'other branches'} and feature branches)`);
  if (r.when === 'outsideRepo') bits.push('outside the working tree (or on a glob/variable path)');
  if (r.tool) bits.push(`MCP tool \`${r.tool}\``);
  if (r.sql) bits.push('SQL that drops or truncates a table/schema/database');
  if (r.pathAny) bits.push(`reading or writing ${r.pathAny.join(', ')}`);
  if (r.pathWrite) bits.push(`writing ${r.pathWrite}`);
  if (r.textAny) bits.push(`a command containing ${r.textAny.map((t) => `\`${t}\``).join(' / ')}`);
  return bits.join(' ');
};

export function renderPolicy(p) {
  const d = p.defaults || {};
  const lines = [BEGIN, '', '## ENFORCED GATES (the system holds these, not the model)', '',
    `Mode: **${p.mode || 'enforce'}**${p.enforceFor && !p.enforceFor.includes('*') ? ` for ${p.enforceFor.join(', ')} (everyone else: observe — logged, not blocked)` : ''}. ` +
    `A gated call does not run: it waits on the owner on the ledger, runs once on approval (within ${d.ttlMinutes ?? 120} min), and leaves a receipt on the task.`, ''];
  for (const c of p.classes || []) {
    lines.push(`- **${c.id}** — ${c.label}${c.requireDryRun ? ' · *dry run first, in the same task*' : ''}${c.standing ? ' · *standing: a program go on the task approves it (receipt kept)*' : ''}`);
    for (const r of c.rules || []) lines.push(`  - ${ruleText(r)}`);
  }
  const lists = Object.entries(p.lists || {}).filter(([, v]) => v.length);
  if (lists.length) { lines.push('', 'Lists:'); for (const [k, v] of lists) lines.push(`- @${k}: ${v.map((x) => `\`${x}\``).join(', ')}`); }
  lines.push('', 'Anything that would need a gate but cannot be read with certainty is gated as **opaque**.',
    'A **program go** (the owner\'s approval of a task\'s plan, kind `program`) approves the *standing* classes on that task only — merges only into private repos outside @publicRemotes/@deployOnPush — until it is revoked (`task.sh revoke-go N`) or the task closes. Every other class asks per action.', '', END);
  return lines.join('\n');
}

/** Replace (or append) the generated block. */
export function withBlock(md, block) {
  const a = md.indexOf(BEGIN.slice(0, 20)); const b = md.indexOf(END);
  if (a >= 0 && b > a) return md.slice(0, a) + block + md.slice(b + END.length);
  return md.replace(/\s*$/, '\n\n') + block + '\n';
}
export function blockOf(md) {
  const a = md.indexOf(BEGIN.slice(0, 20)); const b = md.indexOf(END);
  return a >= 0 && b > a ? md.slice(a, b + END.length) : null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--write') {
    const [md, json] = args.slice(1);
    const block = renderPolicy(JSON.parse(await readFile(json, 'utf8')));
    await writeFile(md, withBlock(await readFile(md, 'utf8'), block));
    return console.log(`done   ${md}: gates block rendered from ${json}`);
  }
  const { resolve } = await import('../src/config.mjs');
  console.log(renderPolicy(JSON.parse(await readFile(resolve('policy.json'), 'utf8'))));
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exit(1); });
