// Self-heal for the cmux socket bridge.
// cmux 0.64.x scrubs automation.socketPassword out of cmux.json on every cold
// app launch (migration into its private store) but the store write is broken
// — so after any reboot or cmux relaunch the socket rejects every call
// ("Password mode is enabled but no socket password is configured") and
// dispatch + notify silently die. Recovery is mechanical and idempotent:
// re-inject the canonical password (data/cmux-socket-password) into cmux.json,
// `cmux reload-config` (accepted even while auth is broken), then verify.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SETTINGS } from './config.mjs';

const PW_FILE = fileURLToPath(new URL('../data/cmux-socket-password', import.meta.url));
const CMUX_JSON = `${process.env.HOME}/.config/cmux/cmux.json`;

const run = (args, env = {}) => new Promise((resolve) => {
  execFile(SETTINGS.cmuxBin, args,
    { timeout: 8000, killSignal: 'SIGKILL', env: { ...process.env, CMUX_QUIET: '1', ...env } },
    (e, so, se) => resolve({ err: e ? (String(se || '').trim() || e.message) : null, out: String(so || '') }));
});

let lastAttempt = 0;

export async function maybeHealCmuxBridge(bridgeJob, notify) {
  if (!bridgeJob || bridgeJob.status === 'ok') return;
  if (!/password/i.test(bridgeJob.detail || '')) return; // only the known wipe signature
  if (Date.now() - lastAttempt < 5 * 60000) return;      // don't thrash if the heal can't stick
  lastAttempt = Date.now();

  const pw = (await readFile(PW_FILE, 'utf8')).trim();
  const cfg = JSON.parse(await readFile(CMUX_JSON, 'utf8'));
  cfg.automation = { ...cfg.automation, socketControlMode: 'password', socketPassword: pw };
  await writeFile(CMUX_JSON, JSON.stringify(cfg, null, 2) + '\n');

  await run(['reload-config'], { CMUX_SOCKET_PASSWORD: pw });
  const check = await run(['workspace', 'list'], { CMUX_SOCKET_PASSWORD: pw });
  const healed = !check.err;
  console.log('[heal-cmux]', healed ? 'socket auth restored' : `failed: ${check.err}`);
  await notify('Ops Board · self-heal', 'cmux bridge',
    healed
      ? 'socket password re-injected after cmux relaunch — dispatch/notify restored'
      : `auto-restore FAILED: ${String(check.err).slice(0, 80)} — manual recipe: docs/CMUX-SETUP.md`);
}
