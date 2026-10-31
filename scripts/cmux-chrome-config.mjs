#!/usr/bin/env node
// cmux Tier 2 pane chrome + group tints for ~/.config/cmux/cmux.json.
//
//   node scripts/cmux-chrome-config.mjs            dry run: prints the keys it would set
//   node scripts/cmux-chrome-config.mjs --apply    timestamped .bak, patch, `cmux config doctor`, `cmux reload-config`
//   node scripts/cmux-chrome-config.mjs --revert <bak-file>   restore a backup + reload
//
// Only touches: app.reorderOnNotification, notifications.unreadPaneRing,
// notifications.paneFlashColor, activePaneBorderColor, paneBorderColor,
// workspaceGroups.byCwd. Every other key (socket password, automation, sidebar…)
// is carried over untouched. NOT touched by design (Tier 3, the owner decides):
// app.minimalMode, app.appIcon, ~/.config/ghostty/config.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve as resolveConfig } from '../src/config.mjs';
import { domainTable } from '../src/chrome.mjs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILE = path.join(os.homedir(), '.config', 'cmux', 'cmux.json');
const PW = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'cmux-socket-password');

// group header tint for any group anchored in these repos (longest match wins;
// explicit group colors set by `mesh-cli.mjs sync-groups` take precedence).
// The repo → domain map is config/mesh.json `repoDomains`; domain colors and
// icons come from its `domains` (src/chrome.mjs domainTable).
const MESH = JSON.parse(readFileSync(resolveConfig('config/mesh.json'), 'utf8'));
const REPOS = MESH.repoDomains || {};
const TABLE = domainTable(MESH);
const DOMAIN = Object.fromEntries(Object.keys(TABLE.labels).map((d) => [d, [TABLE.colors[d], TABLE.icons[d]]]));

export function patchConfig(cfg, repos = REPOS) {
  const d = structuredClone(cfg);
  d.app = { ...(d.app || {}), reorderOnNotification: true };
  d.notifications = { ...(d.notifications || {}), unreadPaneRing: true, paneFlashColor: '#28FE14' };
  d.activePaneBorderColor = '#28FE14';   // phosphor green, focused pane
  d.paneBorderColor = '#0D5F0D';         // board --card-edge, dim green dividers
  d.workspaceGroups = {
    ...(d.workspaceGroups || {}),
    byCwd: { ...(d.workspaceGroups?.byCwd || {}),
      ...Object.fromEntries(Object.entries(repos).filter(([, dom]) => DOMAIN[dom]).map(([k, dom]) => [k, { color: DOMAIN[dom][0], icon: DOMAIN[dom][1] }])) },
  };
  return d;
}

const cmux = (...args) => execFileSync('cmux', args, {
  encoding: 'utf8', env: { ...process.env, CMUX_QUIET: '1', CMUX_SOCKET_PASSWORD: readPw() } });
function readPw() { try { return String(execFileSync('cat', [PW])).trim(); } catch { return ''; } }

const redact = (o) => JSON.stringify(o, (k, v) => (/password/i.test(k) ? '«kept»' : v), 2);

async function main() {
  const [flag, arg] = process.argv.slice(2);
  if (flag === '--revert') {
    if (!arg) throw new Error('usage: --revert <path to cmux.json.bak-…>');
    await copyFile(arg, FILE);
    console.log(`restored ${arg} → ${FILE}`);
    console.log(cmux('reload-config'));
    return;
  }
  const cur = JSON.parse(await readFile(FILE, 'utf8'));
  const next = patchConfig(cur);
  if (flag !== '--apply') {
    const changed = Object.fromEntries(['app', 'notifications', 'activePaneBorderColor', 'paneBorderColor', 'workspaceGroups']
      .filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k])).map((k) => [k, next[k]]));
    console.log(Object.keys(changed).length ? `would set (dry run):\n${redact(changed)}` : 'already applied');
    return;
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const bak = `${FILE}.bak-${ts}`;
  await copyFile(FILE, bak);
  await writeFile(FILE, JSON.stringify(next, null, 2) + '\n');
  console.log(`backup: ${bak}`);
  try { console.log(cmux('config', 'doctor')); } catch (e) {
    await copyFile(bak, FILE);
    throw new Error(`cmux config doctor failed — restored the backup:\n${e.stdout || e.message}`);
  }
  console.log(cmux('reload-config'));
  console.log(`applied. revert: node scripts/cmux-chrome-config.mjs --revert "${bak}"`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main().catch((e) => { console.error(e.message); process.exit(1); });
