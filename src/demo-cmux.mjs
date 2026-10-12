// The cmux half of the demo (`./install.sh --demo --cmux`, task #152).
//
// `up` opens a SEPARATE cmux window ("ZULU DEMO"), fills it with fake agent
// panes (scripts/demo-agent.mjs), groups them as "ZULU DEMO" and records every
// id it created in data/demo-cmux-state.json. While the demo board runs, each
// poll reads the demo panes' screens and writes the same chrome the real board
// writes (domain color, description, task + ctx pills, progress label with
// ▲ INPUT) — through scopedRun, which refuses any cmux command that is not a
// read or one of those writes, or that targets a workspace the demo did not
// create. `down` closes the demo window (only if it holds nothing but demo
// workspaces) and forgets the state.
//
// The live board never registers these workspaces (isDemoWorkspace: the
// "ZULU DEMO" title prefix and the ids in the state file), every listing spans
// all windows (src/cmux-windows.mjs), and the sidebar SELECTION is never
// changed: `up` prints the one-liner for the demo window instead.
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cmux, classifyScreen, parseCreatedWorkspace, isDemoWorkspace, DEMO_TITLE_PREFIX } from './mesh.mjs';
import { parseWindows, acrossWindows } from './cmux-windows.mjs';
import { applyChrome, applyPills } from './chrome.mjs';
import { demoDirectory, demoContext, useDemoPanes, observeDemoScreens } from './demo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STATE_FILE = path.join(ROOT, 'data', 'demo-cmux-state.json');
export const CHROME_FILE = path.join(ROOT, 'data', 'demo-chrome-state.json');

// one pane per synthetic agent in src/demo.mjs (n = its AGENTS number); `dir`
// is its working directory under DEMO_CWD — neutral, no git, so the sidebar
// shows no real branch, PR or checkout path
export const PANES = [
  { n: 1, role: 'idle',        name: 'mission-control',   title: '⌘ MISSION CONTROL', dir: 'zulu-assistant' },
  { n: 2, role: 'needs-input', name: 'app-resident',      title: 'app — resident',     dir: 'my-app' },
  { n: 3, role: 'working',     name: 'data-resident',     title: 'data — resident',    dir: 'data-pipeline' },
  { n: 4, role: 'blocked',     name: 'fix-weekly-export', title: 'fix: Weekly export', dir: 'data-pipeline' },
  { n: 5, role: 'idle',        name: 'docs-worker',       title: 'docs — worker',      dir: 'zulu-assistant' },
  { n: 6, role: 'codex',       name: 'codex-review',      title: 'codex — review',     dir: 'my-app' },
];
export const DEMO_CWD = '/tmp/zulu-demo';
export const paneTitle = (p) => `${DEMO_TITLE_PREFIX} · ${p.title}`;

// ---- the write filter (pure apart from `run`) ------------------------------------

const CHROME_VERBS = new Set(['workspace-action', 'set-status', 'clear-status', 'set-progress', 'clear-progress']);
const WS_ACTIONS = new Set(['set-color', 'set-description', 'clear-color', 'clear-description']);
const refuse = (args, why) => ({ err: `demo: refused "${args.slice(0, 2).join(' ')}" — ${why}`, out: '' });

/**
 * A cmux runner that can only read, and write chrome to the demo's own
 * workspaces. Listings are filtered down to those workspaces too.
 */
export function scopedRun(run, allowedIds) {
  const allowed = new Set([...allowedIds].map((x) => String(x).toUpperCase()));
  const target = (args) => {
    const i = args.indexOf('--workspace');
    return i >= 0 ? String(args[i + 1] || '').toUpperCase() : null;
  };
  return async (args) => {
    const verb = args[0];
    if (verb === 'list-windows') return run(args);
    if (verb === 'workspace' && args[1] === 'list') {
      const r = await run(args);
      if (r.err || !args.includes('--json')) return r;
      try {
        const j = JSON.parse(r.out);
        return { err: null, out: JSON.stringify({ ...j, workspaces: (j.workspaces || []).filter((w) => allowed.has(String(w.id).toUpperCase())) }) };
      } catch { return refuse(args, 'unreadable listing'); }
    }
    if (verb === 'read-screen') return allowed.has(target(args)) ? run(args) : refuse(args, 'not a demo workspace');
    if (CHROME_VERBS.has(verb)) {
      if (!allowed.has(target(args))) return refuse(args, 'not a demo workspace');
      if (verb === 'workspace-action' && !WS_ACTIONS.has(args[args.indexOf('--action') + 1])) return refuse(args, 'only color/description actions');
      return run(args);
    }
    return refuse(args, 'not a demo chrome command');
  };
}

// ---- state ----------------------------------------------------------------------

export async function readDemoState(file = STATE_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
async function writeState(s, file = STATE_FILE) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(s, null, 2));
}

// ---- per poll (demo board) ---------------------------------------------------------

/**
 * Read the demo panes and write their chrome. Returns null when no cmux demo
 * is up. `ledger` is the demo ledger (data/demo-tasks).
 */
export async function syncDemoCmux({ ledger, run = cmux, now = Date.now(), file = STATE_FILE, chromeFile = CHROME_FILE } = {}) {
  const st = await readDemoState(file);
  if (!st?.panes?.length) return null;
  useDemoPanes(new Map(st.panes.map((p) => [p.n, p.wsId])));
  const sr = scopedRun(run, st.panes.map((p) => p.wsId));
  const prompts = new Map();
  const observed = new Map();
  for (const p of st.panes) {
    const r = await sr(['read-screen', '--workspace', p.wsId]);
    if (r.err) continue;
    const c = classifyScreen(r.out);
    observed.set(p.wsId, c.state);
    if (c.state === 'dialog') prompts.set(p.wsId, 'permission');
  }
  observeDemoScreens(observed);
  const ids = new Set(st.panes.map((p) => p.wsId));
  const dir = demoDirectory().filter((a) => ids.has(a.workspaceId));   // only panes that exist (up may still be running)
  await applyChrome(dir, { run: sr, file: chromeFile, max: 12 });
  const tasks = ledger ? await ledger.list({ status: 'live' }) : [];
  await applyPills(dir, tasks, { run: sr, file: chromeFile, prompts, ctx: demoContext(now) });
  return { panes: st.panes.length, input: prompts.size };
}

// ---- up / down -----------------------------------------------------------------------

/** Open the demo window, its panes and group. Returns { ok, windowId, hint } or { ok:false, reason }. */
export async function demoUp({ port = 3210, run = cmux, file = STATE_FILE, root = ROOT, cwdRoot = DEMO_CWD, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (await readDemoState(file)) return { ok: false, reason: 'a cmux demo is already up — ./install.sh demo-stop first' };
  const w0 = await run(['list-windows']);
  if (w0.err) return { ok: false, reason: `cmux not reachable (${w0.err.slice(0, 80)})` };
  const before = new Set(parseWindows(w0.out));

  const nw = await run(['new-window', '--name', DEMO_TITLE_PREFIX]);
  if (nw.err) return { ok: false, reason: `new-window failed: ${nw.err.slice(0, 80)}` };
  const windowId = parseWindows((await run(['list-windows'])).out).find((id) => !before.has(id));
  if (!windowId) return { ok: false, reason: 'the new window did not show up in list-windows' };
  const st = { windowId, port, startedAt: new Date().toISOString(), panes: [], workspaceIds: [] };
  // the window's own first workspace is ours too
  try { st.workspaceIds = (JSON.parse((await run(['workspace', 'list', '--json', '--window', windowId])).out).workspaces || []).map((w) => w.id.toUpperCase()); } catch { /* recorded below */ }
  st.initialIds = [...st.workspaceIds];
  await writeState(st, file);                        // record before creating anything else

  for (const p of PANES) {
    const cwd = path.join(cwdRoot, p.dir);
    await mkdir(cwd, { recursive: true });
    const cmd = `node "${path.join(root, 'scripts', 'demo-agent.mjs')}" ${p.role} --name ${p.name}`;
    const r = await run(['--id-format', 'both', 'new-workspace', '--window', windowId, '--name', paneTitle(p),
      '--cwd', cwd, '--focus', 'false', '--command', cmd]);
    // cmux 0.65 ignores --id-format when --window is given ("OK workspace:N"), so
    // fall back to that ref in OUR window's listing (never a title match elsewhere)
    let wsId = r.err ? null : parseCreatedWorkspace(r.out);
    const ref = (String(r.out).match(/workspace:\d+/) || [])[0];
    for (let i = 0; !r.err && !wsId && ref && i < 6; i++) {   // the listing can lag the create
      if (i) await sleep(500);
      const rows = JSON.parse((await run(['workspace', 'list', '--json', '--window', windowId])).out || '{"workspaces":[]}').workspaces || [];
      wsId = rows.find((w) => w.ref === ref)?.id?.toUpperCase() || null;
    }
    if (r.err || !wsId) { log(`demo: could not create ${p.name}: ${r.err || `no id for ${ref || 'the new workspace'}`}`); continue; }
    st.panes.push({ ...p, wsId });
    st.workspaceIds.push(wsId);
    await writeState(st, file);
  }
  if (!st.panes.length) return { ok: false, reason: 'no demo panes could be created', windowId };

  // the board's compact view beside the pane that will ask for input
  const asker = st.panes.find((p) => p.role === 'needs-input');
  if (asker) await run(['new-pane', '--type', 'browser', '--workspace', asker.wsId, '--direction', 'right', '--focus', 'false', '--url', `http://localhost:${port}/?dock=1`]);

  // group them; cmux generates an empty placeholder anchor — re-anchor on a real
  // pane, take the placeholder out of the group and close it (it is ours)
  const ids = st.panes.map((p) => p.wsId);
  // group commands default to the CALLER's window: always name the demo window
  const g = await run(['workspace-group', 'create', '--window', windowId, '--name', DEMO_TITLE_PREFIX, '--idempotency-key', `zulu-demo-${windowId}`, '--from', ids.join(',')]);
  if (!g.err) {
    let group = null;
    try { group = (JSON.parse((await run(['workspace-group', 'list', '--window', windowId, '--json'])).out).groups || []).find((x) => x.name === DEMO_TITLE_PREFIX); } catch { /* left ungrouped */ }
    if (group) {
      st.groupRef = group.ref;
      // the placeholder is exactly the group's GENERATED anchor (wherever cmux put it)
      const generated = group.anchor_workspace_is_generated || group.anchor_workspace_provenance === 'generated';
      let placeholder = null;
      if (generated) {
        const rows = JSON.parse((await acrossWindows(run, ['workspace', 'list', '--json'])).out || '{"workspaces":[]}').workspaces || [];
        placeholder = rows.find((w) => w.ref === group.anchor_workspace_ref)?.id?.toUpperCase() || null;
      }
      await run(['workspace-group', 'set-anchor', '--window', windowId, '--group', group.ref, '--workspace', ids[0]]);
      if (placeholder && !ids.includes(placeholder)) {
        st.workspaceIds.push(placeholder);
        await writeState(st, file);
        await run(['workspace-group', 'remove', '--window', windowId, '--workspace', placeholder]);
        await run(['close-workspace', '--workspace', placeholder]);
      }
      await run(['workspace-group', 'set-color', '--window', windowId, group.ref, '--hex', '#28FE14']);
    }
  }
  // the window's initial (empty) workspace is not needed once the panes exist
  for (const id of st.initialIds || []) await run(['close-workspace', '--workspace', id, '--window', windowId]);
  await writeState(st, file);
  return { ok: true, windowId, panes: st.panes.length, hint: `cmux right-sidebar set custom phosphor --window ${windowId} --no-focus` };
}

/** Close the demo window if it holds only demo workspaces; forget the state. */
export async function demoDown({ run = cmux, file = STATE_FILE, chromeFile = CHROME_FILE } = {}) {
  const st = await readDemoState(file);
  if (!st) return { ok: true, msg: 'no cmux demo is up' };
  const ours = new Set(st.workspaceIds.map((x) => x.toUpperCase()));
  const isOurs = (w) => ours.has(String(w.id).toUpperCase()) || isDemoWorkspace(w);   // demo-titled AND in our window
  const r = await run(['workspace', 'list', '--json', '--window', st.windowId]);
  let msg;
  if (r.err) msg = `demo window already gone (${r.err.slice(0, 60)})`;
  else {
    const rows = JSON.parse(r.out).workspaces || [];
    const foreign = rows.filter((w) => !isOurs(w));
    if (foreign.length) {
      // someone moved a real workspace into the demo window: close only ours
      for (const w of rows.filter(isOurs)) await run(['close-workspace', '--workspace', w.id, '--window', st.windowId]);
      msg = `closed the demo workspaces; left the window open (it also holds: ${foreign.map((w) => w.title).join(', ')})`;
    } else {
      const c = await run(['close-window', '--window', st.windowId, '--force']);
      msg = c.err ? `close-window failed: ${c.err.slice(0, 80)}` : 'demo window closed';
    }
  }
  await rm(file, { force: true });
  await rm(chromeFile, { force: true });
  return { ok: true, msg };
}

// CLI: node src/demo-cmux.mjs up [--port N] | down
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd] = process.argv.slice(2);
  const i = process.argv.indexOf('--port');
  const port = i > 0 ? Number(process.argv[i + 1]) : 3210;
  const r = cmd === 'up' ? await demoUp({ port }) : cmd === 'down' ? await demoDown() : { ok: false, reason: 'usage: demo-cmux.mjs up [--port N] | down' };
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
