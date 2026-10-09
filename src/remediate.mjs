// Disk auto-remediation: when the disk gauge goes amber/red, run ONLY the
// levers the registry blesses (REMEDIATION_LEVERS in config/jobs.mjs), at most
// once per cooldown window, then report exactly what was freed via cmux/notify.
// The mechanism is generic; WHICH caches are safe to delete is owner knowledge,
// so the lever list lives in the registry (examples/ ships it empty). An empty
// list means remediation never runs. Each lever is
//   { name, run: async ({ run, rm, HOME, npmBin }) => {} }
// and must only touch regenerable data: no user data, no docker volumes, no
// live images.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS, REMEDIATION_LEVERS } from './config.mjs';

const STATE_FILE = fileURLToPath(new URL('../data/remediation-state.json', import.meta.url));
const HOME = process.env.HOME;

function run(cmd, args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (e, out) => resolve(String(out || '')));
  });
}

async function freeKB() {
  const out = await run('df', ['-k', '/System/Volumes/Data'], 10000);
  return Number((out.split('\n')[1] || '').split(/\s+/)[3] || 0);
}

export async function maybeRemediate(diskStatus, notify, levers = REMEDIATION_LEVERS) {
  if (diskStatus === 'ok' || !levers?.length) return;
  let state = {};
  try { state = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { /* first run */ }
  const cooldownMs = SETTINGS.remediation.cooldownHours * 3600000;
  if (state.lastRunAt && Date.now() - state.lastRunAt < cooldownMs) return;
  state.lastRunAt = Date.now();
  await writeFile(STATE_FILE, JSON.stringify(state)).catch(() => {});

  const before = await freeKB();
  // npm lives under nvm, which is NOT on a launchd-inherited PATH — levers get
  // the running node's own bin dir
  const ctx = { run, rm, HOME, npmBin: `${dirname(process.execPath)}/npm` };
  for (const lever of levers) await Promise.resolve(lever.run(ctx)).catch(() => {});
  const after = await freeKB();
  const freedGB = Math.max(0, (after - before) / 1048576).toFixed(1);
  await notify('Ops Board', 'Disk auto-remediation ran',
    `Freed ${freedGB} GB via blessed caches (${levers.map((l) => l.name).join('/')}). ` +
    `Free now: ${(after / 1048576).toFixed(1)} GB. Next auto-run allowed in ${SETTINGS.remediation.cooldownHours}h.`);
}
