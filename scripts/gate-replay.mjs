#!/usr/bin/env node
// Guardrails replay: run the classifier over the checks the board has recorded and print what the
// 1.3 checks would newly hold. A reading from past traffic before any switch in policy.checks moves.
// Read-only: it classifies recorded text. Nothing is run, nothing is sent to the board, no file is written.
//
//   node scripts/gate-replay.mjs [--since 7d] [--check <name>] [--samples 5] [--json]
//   node scripts/gate-replay.mjs --mentions settings.json,policy.json   (how often recorded calls name a word)
//   node scripts/gate-replay.mjs --mentions <word> --list   (each matching check: time, agent, event, tool, answer; never the call's text)
//                                [--file <checks.jsonl>] [--policy <policy.json>] [--root <checkout>]
//
// What it cannot see: a call the shell fast path passed left no line, so a call that only the new
// trigger lines would catch is not counted. Lines recorded before 1.3 were cut at 160 characters with
// their line breaks removed; they are replayed as recorded and counted apart ("cut").
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { classify, compileTriggers, isShellTool, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A reading the classifier takes without a switch (a parser fix): shown apart from the checks. */
export const FIXED = 'parserFixes';

export function parseSince(v, now = Date.now()) {
  const m = /^(\d+)([dhm])$/.exec(String(v || ''));
  if (!m) return null;
  return now - Number(m[1]) * { d: 86400e3, h: 3600e3, m: 60e3 }[m[2]];
}

/** The recorded lines worth replaying: pre-tool checks, oldest first. */
export function readChecks(text, { since = null } = {}) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.event || 'pre') !== 'pre' || typeof e.command !== 'string') continue;
    if (e.command.startsWith('[withheld')) continue;
    if (since != null && !(Date.parse(e.at) >= since)) continue;
    out.push(e);
  }
  return out;
}

/**
 * Classify every recorded check twice: as before 1.3 (every check off, the old parser readings) and
 * with the named checks on. → { total, cut, range, held: [{ at, agent, check, cls, why, command, cut }], byCheck, byAgent }
 */
export function replay(entries, policy, { checks = CHECKS, home = os.homedir(), root = ROOT } = {}) {
  const git = () => null;                            // history is read as text: no repo is asked anything
  const base = { home, boardRoot: root, git, repoRoot: () => null, triggers: compileTriggers(policy) };
  const off = Object.fromEntries(CHECKS.map((n) => [n, 'off']));
  const held = []; let cut = 0;
  for (const e of entries) {
    const text = typeof e.full === 'string' ? e.full : e.command;
    const wasCut = typeof e.full !== 'string' && e.command.length >= 160;
    if (wasCut) cut++;
    const tool = isShellTool(e.tool) ? 'Bash' : e.tool || 'Bash';
    const input = tool === 'Bash' ? { tool, command: text, cwd: e.cwd || root } : { tool, command: '', filePath: text, cwd: e.cwd || root };
    let before; let fixed; let after;
    try {
      before = classify(input, policy, { ...base, checks: off, legacyParser: true });
      fixed = classify(input, policy, { ...base, checks: off });
      after = classify(input, policy, { ...base, checks: { ...off, ...Object.fromEntries(checks.map((n) => [n, 'enforce'])) } });
    } catch { continue; }
    if (before.verdict !== 'clear') continue;        // held already: not new
    const now = fixed.verdict === 'gate' ? { ...fixed, check: FIXED } : after.verdict === 'gate' ? after : null;
    if (!now) continue;
    held.push({ at: e.at, agent: e.agent || '?', check: now.check || '?', cls: now.cls, why: now.why, command: text.replace(/\s+/g, ' ').slice(0, 200), cut: wasCut });
  }
  const count = (key) => held.reduce((m, h) => { m[h[key]] = (m[h[key]] || 0) + 1; return m; }, {});
  return { total: entries.length, cut, range: entries.length ? [entries[0].at, entries[entries.length - 1].at] : null, held, byCheck: count('check'), byAgent: count('agent') };
}

/** How many recorded checks name each word (case ignored): a rough measure of what a bare-name trigger line would send. */
export function mentions(entries, words) {
  const counts = Object.fromEntries(words.map((w) => [w, 0]));
  for (const e of entries) { const text = String(typeof e.full === 'string' ? e.full : e.command).toLowerCase(); for (const w of words) if (text.includes(w.toLowerCase())) counts[w]++; }
  const days = entries.length ? Math.max(1 / 24, (Date.parse(entries[entries.length - 1].at) - Date.parse(entries[0].at)) / 86400e3) : 0;
  return { counts, total: entries.length, days };
}

/**
 * The recorded checks that name a word: when, who, which event, what the board answered. Never the
 * call's text: this is for judging past calls without anyone reading the log by hand.
 */
export function mentionRows(entries, word) {
  const w = String(word).toLowerCase();
  return entries.filter((e) => String(typeof e.full === 'string' ? e.full : e.command).toLowerCase().includes(w))
    .map((e) => ({ at: e.at, agent: e.agent || '?', event: e.event || 'pre', tool: e.tool || '?', decision: e.decision || '?', ...(e.observed ? { observed: true } : {}), ...(e.task ? { task: e.task } : {}), ...(e.gate ? { gate: e.gate } : {}) }));
}

export function render(r, { samples = 5, policyName = 'policy' } = {}) {
  const out = [];
  if (!r.total) return 'gate replay: no recorded checks to read';
  const days = Math.max(1 / 24, (Date.parse(r.range[1]) - Date.parse(r.range[0])) / 86400e3);
  out.push(`gate replay: ${r.total} recorded checks, ${r.range[0].slice(0, 16)}Z to ${r.range[1].slice(0, 16)}Z (${days.toFixed(1)} days), ${policyName}`);
  if (r.cut) out.push(`  ${r.cut} of them were cut at 160 characters when recorded: read as recorded, so their reading is approximate`);
  out.push('  a call the fast path passed left no line: holds that only the new trigger lines would catch are not counted');
  out.push(`newly held with every check on: ${r.held.length} (${(r.held.length / days).toFixed(1)} a day)`);
  for (const [name, n] of Object.entries(r.byCheck).sort((a, b) => b[1] - a[1])) {
    const mine = r.held.filter((h) => h.check === name);
    out.push(`  ${name}${name === FIXED ? ' (parser fixes, no switch)' : ''}: ${n}, ${(n / days).toFixed(1)} a day${mine.some((h) => h.cut) ? `, ${mine.filter((h) => h.cut).length} on cut lines` : ''}`);
    for (const h of mine.slice(-samples)) out.push(`    ${h.at.slice(5, 16)}Z ${h.agent} :: ${h.why} :: ${h.command.slice(0, 110)}`);
  }
  const agents = Object.entries(r.byAgent).sort((a, b) => b[1] - a[1]);
  if (agents.length) out.push(`by agent: ${agents.map(([a, n]) => `${a} ${n}`).join(' · ')}`);
  return out.join('\n');
}

function loadPolicy(root, file) {
  const tries = file ? [file] : ['overlay/policy.json', 'policy.json', 'examples/policy.json'].map((f) => path.join(root, f));
  for (const f of tries) { try { return { policy: JSON.parse(readFileSync(f, 'utf8')), name: path.relative(root, f) || f }; } catch { /* next */ } }
  if (file) throw new Error(`cannot read the policy file ${file}`);
  return { policy: DEFAULT_POLICY, name: 'the shipped default policy' };
}

function main(argv) {
  const arg = (n) => { const k = argv.indexOf(n); return k >= 0 ? argv[k + 1] : null; };
  if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  const root = path.resolve(arg('--root') || ROOT);
  const file = arg('--file') || path.join(root, 'data', 'guardrails', 'checks.jsonl');
  const only = arg('--check');
  if (only && !CHECKS.includes(only)) throw new Error(`unknown check "${only}" (${CHECKS.join(', ')})`);
  const since = arg('--since') ? parseSince(arg('--since')) : null;
  if (arg('--since') && since == null) throw new Error('--since takes a number and d, h or m (7d, 12h)');
  let text; try { text = readFileSync(file, 'utf8'); } catch { throw new Error(`no recorded checks at ${path.relative(root, file) || file}`); }
  if (arg('--mentions')) {
    const m = mentions(readChecks(text, { since }), arg('--mentions').split(',').map((w) => w.trim()).filter(Boolean));
    for (const [w, n] of Object.entries(m.counts)) console.log(`${w}: ${n} of ${m.total} recorded checks (${m.days ? (n / m.days).toFixed(1) : 0} a day)`);
    // --list: one line per matching check (time, agent, event, tool, the board's answer), without the call's text
    if (process.argv.includes('--list')) {
      for (const w of Object.keys(m.counts)) for (const r of mentionRows(readChecks(text, { since }), w))
        console.log(`  ${w}  ${r.at}  ${r.agent}  ${r.event}  ${r.tool}  ${r.decision}${r.observed ? ' (observed)' : ''}${r.task ? `  #${r.task}${r.gate ? ` ${r.gate}` : ''}` : ''}`);
    }
    console.log('counted: only calls that already reached the board for another reason; calls the fast path passed left no line');
    return;
  }
  const { policy, name } = loadPolicy(root, arg('--policy'));
  const r = replay(readChecks(text, { since }), policy, { checks: only ? [only] : CHECKS, root });
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 1) : render(r, { samples: Number(arg('--samples')) || 5, policyName: name }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`gate-replay: ${e.message}`); process.exit(1); }
}
