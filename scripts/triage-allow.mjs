#!/usr/bin/env node
// The scheduled triage pass's allow list (#588), one entry per line, built when the pass starts:
// its one file rule (it writes only data/handoffs/triage-*), the board script, the notice, ONE exact kickstart (no -k) per
// registry job the policy does not list as paidOrOutbound, ONE exact docker restart per registry container, and
// the worker spawn only when the board's dispatch is 'spawn' (SETTINGS.triage.dispatch; 'ask' = the board script's
// ask, see src/triage-ask.mjs). scripts/triage.sh starts the pass with exactly these lines and `--print-prompt`
// prints the same ones. A policy that cannot be read gives no kickstart entry at all (nothing is known to be safe).
// `--dispatch` prints 'ask' or 'spawn' (triage.sh keeps the matching paragraph of the procedure).
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dispatchMode } from '../src/triage-ask.mjs';

// the file rule: an Edit rule covers the Write tool, `/` anchors it at the working folder (probed on 2.1.321)
export const FIXED_HEAD = ['Edit(/data/handoffs/triage-*)', 'Bash(scripts/triage-board.sh:*)', "Bash(cmux notify --title 'Triage':*)"];
export const SPAWN = 'Bash(scripts/agent-spawn.sh:*)';
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;   // what may stand inside an exact entry: no space, quote, glob or paren

export function triageAllowed({ jobs = [], containers = [], paidOrOutbound = null, uid, dispatch = 'spawn' }) {
  if (!Number.isInteger(uid) || uid < 0) throw new Error('triage-allow: no user id');
  const paid = Array.isArray(paidOrOutbound) ? new Set(paidOrOutbound) : null;
  const kick = paid ? [...new Set(jobs.map((j) => j?.label))].filter((l) => typeof l === 'string' && LABEL.test(l) && !paid.has(l)).sort() : [];
  const dock = [...new Set(containers.map((c) => c?.name))].filter((n) => typeof n === 'string' && LABEL.test(n)).sort();
  return [
    ...FIXED_HEAD,
    // no -k: it starts a job that is not running and leaves a running one alone (-k ends it first, and
    // a long job whose card reads `due` may still be running)
    ...kick.map((l) => `Bash(launchctl kickstart gui/${uid}/${l})`),
    ...dock.map((n) => `Bash(docker restart ${n})`),
    ...(dispatch === 'ask' ? [] : [SPAWN]),
  ];
}

export function policyList(file) {
  try {
    const l = JSON.parse(readFileSync(file, 'utf8'))?.lists?.paidOrOutbound;
    return Array.isArray(l) ? l : [];
  } catch { return null; }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const c = await import('../src/config.mjs');
  const dispatch = dispatchMode(c.SETTINGS);
  if (process.argv[2] === '--dispatch') { process.stdout.write(`${dispatch}\n`); process.exit(0); }
  const paidOrOutbound = policyList(c.resolve('policy.json'));
  if (!paidOrOutbound) process.stderr.write('triage-allow: the policy could not be read, so the pass gets no kickstart\n');
  const lines = triageAllowed({ jobs: c.JOBS, containers: c.DOCKER_CONTAINERS, paidOrOutbound, uid: process.getuid(), dispatch });
  process.stdout.write(`${lines.join('\n')}\n`);
}
