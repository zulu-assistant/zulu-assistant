#!/usr/bin/env node
// A fake agent for the cmux demo (`./install.sh --demo --cmux`). It replays a
// scripted, neutral transcript in a terminal pane so the board's screen
// classifier (src/mesh.mjs classifyScreen) and isLiveAgent (src/heal-restore.mjs)
// read it as a Claude or Codex session. Nothing here talks to a model, the
// network or any file: it only draws.
//
//   node scripts/demo-agent.mjs <needs-input|working|blocked|idle|codex> [--name <label>] [--auto <s>]
//
// needs-input works, then parks on a permission prompt; press 1 or Enter to
// answer it (the board's ▲ INPUT row then clears). With no answer it answers
// itself after --auto seconds (default 25) so an unattended demo keeps cycling.
import { pathToFileURL } from 'node:url';

export const ROLES = ['needs-input', 'working', 'blocked', 'idle', 'codex'];

const RULE = '─'.repeat(64);
const claudeFooter = (busy) => (busy
  ? ['  ✻ Working… (esc to interrupt)']
  : ['  ⏵⏵ auto mode on (shift+tab to cycle) · ? for shortcuts']);

// per-role transcript lines (neutral fixtures: no names, hosts or ids)
const SCRIPT = {
  'needs-input': [
    '⏺ Queue worker: retry backoff (task #4).',
    '⏺ Added exponential backoff, capped at 30 s; tests pass (14/14).',
    '⏺ PR #12 is merged; the running worker still has the old code.',
    '⏺ Next step restarts the queue worker in production.',
  ],
  working: [
    '⏺ Rebuilding the search-index mapping for the new product fields (task #2).',
    '  ⎿ mapping drafted · 42 fields',
    '⏺ Reindexing… 18,400 / 61,200 documents',
    '⏺ Reindexing… 39,750 / 61,200 documents',
    '⏺ Reindexing… 58,900 / 61,200 documents',
    '⏺ Verifying counts against the source table.',
  ],
  blocked: [
    '⏺ The export reads the index, which task #2 is still rebuilding.',
    '⏺ Blocked on #2 — recorded in the ledger; I will pick this up when it closes.',
  ],
  idle: [
    '⏺ Done for now; the report is written and the ledger is up to date.',
    '⏺ Waiting for the next task.',
  ],
  codex: [
    '• Reviewed PR #12 (retry backoff for the queue worker).',
    '• One suggestion: cap the backoff at 30 s; otherwise ready to merge.',
  ],
};

const PROMPT = [
  ' Bash command',
  '   ./scripts/restart-worker.sh --env production',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No, and tell Claude what to do differently',
  '',
  ' Esc to cancel · Tab to amend',
];

/**
 * The screen for `role` at `t` seconds since start (pure — tested).
 * state.answeredAt: when the needs-input prompt was answered (null = not yet).
 */
export function frame(role, t, { name = role, answeredAt = null, auto = 25 } = {}) {
  const head = [`  ${name} — demo agent (scripted, nothing real runs)`, ''];
  if (role === 'codex') {
    return [...head, ...SCRIPT.codex, '', '› Ask Codex to do anything', '', '  gpt-5 high · ~/my-app', '  ← for agents · ? for shortcuts'].join('\n');
  }
  if (role === 'working') {
    const n = 1 + (Math.floor(t / 4) % SCRIPT.working.length);
    return [...head, ...SCRIPT.working.slice(0, n), '', ...claudeFooter(true)].join('\n');
  }
  if (role === 'needs-input') {
    const lines = SCRIPT['needs-input'];
    if (answeredAt !== null || t >= 12 + auto) {
      return [...head, ...lines, '⏺ Approved — restarting the worker.', '  ⎿ queue worker up · backlog draining (1,204 → 0)', '', RULE, '❯ ', RULE, ...claudeFooter(false)].join('\n');
    }
    if (t >= 12) return [...head, ...lines, '', ...PROMPT].join('\n');
    const n = 1 + Math.min(lines.length - 1, Math.floor(t / 3));
    return [...head, ...lines.slice(0, n), '', ...claudeFooter(true)].join('\n');
  }
  // blocked / idle: a quiet Claude session waiting at its prompt
  return [...head, ...(SCRIPT[role] || SCRIPT.idle), '', RULE, '❯ ', RULE, ...claudeFooter(false)].join('\n');
}

/** Phase of a needs-input pane, for the board: 'working' | 'input' | 'answered'. */
export function inputPhase(t, answeredAt, auto = 25) {
  if (answeredAt !== null || t >= 12 + auto) return 'answered';
  return t >= 12 ? 'input' : 'working';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const role = args[0];
  if (!ROLES.includes(role)) { console.error(`usage: demo-agent.mjs <${ROLES.join('|')}> [--name <label>] [--auto <s>]`); process.exit(2); }
  const flag = (k, d) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d; };
  const name = flag('--name', role);
  const auto = Number(flag('--auto', 25));
  const CYCLE = 12 + auto + 20;          // work → prompt → answered → quiet, then again
  let start = Date.now();
  let answeredAt = null;
  const draw = () => {
    let t = (Date.now() - start) / 1000;
    if (role === 'needs-input' && t >= CYCLE) { start = Date.now(); answeredAt = null; t = 0; }
    // OSC 0 sets the tab title to the agent's name (not this script's path)
    process.stdout.write(`\x1b]0;${name}\x07\x1b[2J\x1b[H` + frame(role, t, { name, answeredAt, auto }) + '\n');
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', (b) => {
      const k = b.toString();
      if (k === '\u0003') process.exit(0);                       // ctrl-c
      const t = (Date.now() - start) / 1000;
      if (role === 'needs-input' && inputPhase(t, answeredAt, auto) === 'input' && (k === '1' || k === '\r')) {
        answeredAt = t; draw();
      }
    });
  }
  draw();
  setInterval(draw, 1000);
}
