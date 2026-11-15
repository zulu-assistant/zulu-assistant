#!/usr/bin/env node
// The Guardrails-only profile, as two settings (run by `./install.sh --guardrails`; safe by hand).
//   node scripts/guardrails-profile.mjs             what would change (nothing is written)
//   node scripts/guardrails-profile.mjs --apply     write it
//   node scripts/guardrails-profile.mjs --full [--apply]   back to the full profile (the policy is left as it is)
//   --switch   needed with --apply on an install that already runs the FULL board (see runsFullBoard):
//              switching stops the fleet cards, the mesh and the session heals at the next restart, so
//              it is never done by a plain yes. Without it the write form prints what would change and stops.
// On a LIGHT install (the default `./install.sh`, see lightInstall) the profile is left as it is: the
// board keeps the sessions and cards it shows, and only step 2 below is done. Nothing stops, so no
// --switch is asked for.
//
// 1. overlay/config/local.json  settings.profile = "guardrails"
//    The board then runs the ledger, the gate and the waiting rows: no fleet collector, no mesh, no heal.
// 2. the overlay policy          "defaultMode": "enforce"   (only when the key is absent)
//    Without cmux no session is registered in the mesh. The shipped policy holds registered agents and
//    only observes the rest, so a Guardrails-only install would hold nothing. With this line every
//    session is held. A value you set yourself is never changed.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async (f) => { try { return JSON.parse(await readFile(f, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : (() => { throw new Error(`${f} does not parse: ${e.message}`); })(); } };

// the shipped example directory has placeholder ids (00000000-0000-4000-8000-…): those are not registered agents
async function registeredAgents(overlay) {
  const dir = await readJson(path.join(overlay, 'config', 'agents.json')).catch(() => null);
  return (dir?.agents || []).filter((a) => a && a.workspaceId && a.status !== 'closed' && !/^00000000-0000-4000-8000-/.test(String(a.workspaceId)));
}

/**
 * Is this the light install (the default `./install.sh`)? Its state file says so, and no agent is
 * registered in a mesh. Once agents are registered it is a full board, whatever the state file says.
 */
export async function lightInstall({ overlay, root = ROOT } = {}) {
  const state = await readJson(path.join(root, 'data', 'setup-state.json')).catch(() => null);
  return state?.mode === 'light' && (await registeredAgents(overlay)).length === 0;
}

/**
 * Does this checkout already run the full board? → [reasons] (empty = no).
 * The profile is not guardrails AND (the owner's overlay has a mesh directory with registered agents,
 * OR the board's LaunchAgent in this home is loaded from this checkout).
 */
export async function runsFullBoard({ overlay, root = ROOT, home = process.env.HOME || '' } = {}) {
  const local = (await readJson(path.join(overlay, 'config', 'local.json')).catch(() => null)) || {};
  if (local.settings?.profile === 'guardrails') return [];
  const why = [];
  const live = await registeredAgents(overlay);
  if (live.length) why.push(`the mesh directory has ${live.length} registered agent${live.length === 1 ? '' : 's'}`);
  try {
    const la = path.join(home, 'Library', 'LaunchAgents');
    for (const f of await readdir(la)) {
      if (!f.endsWith('.master-console.plist')) continue;
      if ((await readFile(path.join(la, f), 'utf8')).includes(`${root}/scripts/start.sh`)) why.push(`the board's LaunchAgent (${f}) runs from this checkout`);
    }
  } catch { /* no LaunchAgents folder */ }
  return why;
}

/**
 * Apply the profile under `overlay`. → [{ file, change, written }]
 * `keepProfile` (a light install): settings.profile is not touched, only the policy line is added.
 */
export async function setProfile({ overlay, profile = 'guardrails', apply = false, keepProfile = false } = {}) {
  const out = [];
  const localFile = path.join(overlay, 'config', 'local.json');
  const onDisk = await readJson(localFile);
  const local = onDisk || {};
  const have = local.settings?.profile || 'full';
  if (keepProfile && profile === 'guardrails') out.push({ file: localFile, change: `profile stays "${have}" (a light install: the board keeps what it shows, the gate is added to it)`, written: false, same: true });
  else if (have === profile) out.push({ file: localFile, change: `profile is already "${profile}"`, written: false, same: true });
  else {
    const next = { ...local, settings: { ...(local.settings || {}), profile } };
    if (profile === 'full') delete next.settings.profile;
    // A file this script CREATES also drops the example registry entries, as the light install does: the profile
    // hides their tiles, and the page counted them as watched. A file that exists is the owner's: left as it is.
    const drops = profile === 'guardrails' && onDisk == null;
    if (drops) next.dropExamples = true;
    if (apply) { await mkdir(path.dirname(localFile), { recursive: true }); await writeFile(localFile, JSON.stringify(next, null, 2) + '\n'); }
    out.push({ file: localFile, change: `settings.profile: "${have}" → "${profile}"${drops ? '; dropExamples: true (a new file: the example entries are not watched)' : ''}`, written: apply });
  }
  if (profile !== 'guardrails') return out;
  const policyFile = path.join(overlay, 'policy.json');
  const policy = await readJson(policyFile);
  if (!policy) out.push({ file: policyFile, change: 'no policy file here: run ./install.sh init first (the board then uses the shipped policy, which only observes unregistered sessions)', written: false, missing: true });
  else if (policy.defaultMode !== undefined) out.push({ file: policyFile, change: `defaultMode is "${policy.defaultMode}" (yours; left as it is)`, written: false, same: true });
  else {
    // keep the file's own key order: the new key goes right after "mode"
    const next = {};
    for (const [k, v] of Object.entries(policy)) { next[k] = v; if (k === 'mode') next.defaultMode = 'enforce'; }
    if (next.defaultMode === undefined) next.defaultMode = 'enforce';
    if (apply) await writeFile(policyFile, JSON.stringify(next, null, 2) + '\n');
    out.push({ file: policyFile, change: 'defaultMode: "enforce" added (every session is held, registered in a mesh or not)', written: apply });
  }
  return out;
}

// realpath: a checkout under a symlinked folder (/var → /private/var, a linked home) must still run this
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const a = process.argv.slice(2);
  let apply = a.includes('--apply');
  const overlay = process.env.MC_OVERLAY || path.join(ROOT, 'overlay');
  const toGuardrails = !a.includes('--full');
  const light = toGuardrails && await lightInstall({ overlay });
  const full = toGuardrails && !light ? await runsFullBoard({ overlay }) : [];
  if (a.includes('--is-full')) { for (const w of full) console.log(w); process.exit(full.length ? 0 : 1); }
  const refused = apply && full.length > 0 && !a.includes('--switch');
  if (refused) apply = false;
  const res = await setProfile({ overlay, profile: a.includes('--full') ? 'full' : 'guardrails', apply, keepProfile: light }).catch((e) => { console.error(`refused: ${e.message}`); process.exit(1); });
  for (const r of res) console.log(`${r.written ? 'done  ' : r.missing ? 'note  ' : r.same ? 'skip  ' : 'would '} ${path.relative(ROOT, r.file)}: ${r.change}`);
  if (refused) {
    console.error(`refused: this install already runs the full board (${full.join('; ')}).`);
    console.error('         Switching it to Guardrails only stops the fleet cards, the mesh and the session heals at the next restart.');
    console.error('         Nothing was written. To switch on purpose, add --switch.');
    process.exit(3);
  }
  if (!apply) console.log('(dry run: add --apply to write)');
}
