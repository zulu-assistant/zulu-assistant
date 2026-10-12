// node --test "test/*.test.mjs" — the cmux demo (src/demo-cmux.mjs, scripts/demo-agent.mjs; task #152)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scopedRun, syncDemoCmux, demoUp, demoDown, PANES, paneTitle } from '../src/demo-cmux.mjs';
import { frame, ROLES } from '../scripts/demo-agent.mjs';
import { classifyScreen, DEMO_TITLE_PREFIX, isDemoWorkspace } from '../src/mesh.mjs';
import { isLiveAgent } from '../src/heal-restore.mjs';
import { seedDemoLedger, useDemoPanes, observeDemoScreens } from '../src/demo.mjs';
import { createLedger } from '../src/tasks.mjs';

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`.toUpperCase();
const DEMO = [id(901), id(902)];
const REAL = id(1);

test('demo-agent: every role reads as a live agent, in the state the board needs', () => {
  const want = { 'needs-input': 'dialog', working: 'busy', blocked: 'ready', idle: 'ready', codex: 'ready' };
  for (const role of ROLES) {
    const f = frame(role, role === 'needs-input' ? 15 : 5);
    assert.equal(classifyScreen(f).state, want[role], role);
    assert.equal(isLiveAgent(f), true, role);
  }
  assert.equal(classifyScreen(frame('needs-input', 3)).state, 'busy', 'works before it asks');
  assert.equal(classifyScreen(frame('needs-input', 15, { answeredAt: 14 })).state, 'ready', 'answered');
  assert.equal(classifyScreen(frame('needs-input', 99)).state, 'ready', 'auto-answers after --auto');
  for (const role of ROLES) assert.doesNotMatch(frame(role, 15), /@|https?:|\/Users\//, `${role}: neutral fixture`);
});

test('scopedRun: chrome writes to demo workspaces only; everything else refused', async () => {
  const calls = [];
  const run = async (args) => { calls.push(args.join(' ')); return { err: null, out: args.includes('--json') ? JSON.stringify({ workspaces: [{ id: DEMO[0] }, { id: REAL }] }) : 'ok' }; };
  const sr = scopedRun(run, DEMO.map((x) => x.toLowerCase()));          // ids are compared case-insensitively
  const ok = [
    ['set-status', 'task', '#1 OPEN', '--workspace', DEMO[0]],
    ['set-progress', '0.4', '--label', 'ctx 40%', '--workspace', DEMO[1]],
    ['workspace-action', '--workspace', DEMO[0], '--action', 'set-color', '--color', '#28FE14'],
    ['read-screen', '--workspace', DEMO[1]],
  ];
  for (const a of ok) assert.equal((await sr(a)).err, null, a.join(' '));
  const no = [
    ['set-status', 'task', '#1 OPEN', '--workspace', REAL],
    ['workspace-action', '--workspace', DEMO[0], '--action', 'rename', '--title', 'x'],
    ['workspace-action', '--workspace', REAL, '--action', 'set-color', '--color', '#fff'],
    ['read-screen', '--workspace', REAL],
    ['send', '--workspace', DEMO[0], '--', 'rm -rf'],
    ['send-key', '--workspace', DEMO[0], 'enter'],
    ['close-workspace', '--workspace', DEMO[0]],
    ['new-workspace', '--name', 'x'],
    ['right-sidebar', 'set', 'custom', 'phosphor'],
    ['set-status', 'task', 'x'],                                         // no --workspace = the caller's: refused
  ];
  const before = calls.length;
  for (const a of no) assert.match((await sr(a)).err || '', /demo: refused/, a.join(' '));
  assert.equal(calls.length, before, 'a refused command never reaches cmux');
  const listed = JSON.parse((await sr(['workspace', 'list', '--json'])).out).workspaces.map((w) => w.id);
  assert.deepEqual(listed, [DEMO[0]], 'listings are filtered to the demo');
});

test('syncDemoCmux: one pass writes INPUT/BLOCKED/ctx chrome to the demo panes and nowhere else', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-cmux-'));
  const panes = PANES.map((p, i) => ({ ...p, wsId: id(900 + i) }));
  const file = path.join(dir, 'state.json');
  await writeFile(file, JSON.stringify({ windowId: id(800), panes, workspaceIds: panes.map((p) => p.wsId) }));
  const ledger = await seedDemoLedger(path.join(dir, 'tasks'), createLedger);
  const screens = new Map(panes.map((p) => [p.wsId, frame(p.role, p.role === 'needs-input' ? 15 : 5, { name: p.name })]));
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'list-windows') return { err: null, out: `* 0: ${id(800)} workspaces=6` };
    if (args[0] === 'workspace') return { err: null, out: JSON.stringify({ workspaces: [...panes.map((p) => ({ id: p.wsId, custom_color: null, description: null })), { id: REAL, custom_color: '#111111' }] }) };
    if (args[0] === 'read-screen') return { err: null, out: screens.get(args[args.indexOf('--workspace') + 1]) };
    return { err: null, out: 'OK' };
  };
  try {
    const r = await syncDemoCmux({ ledger, run, file, chromeFile: path.join(dir, 'chrome.json') });
    assert.deepEqual(r, { panes: 6, input: 1 });
    const writes = calls.filter((a) => !['list-windows', 'workspace', 'read-screen'].includes(a[0]));
    assert.ok(writes.length > 10);
    const ids = new Set(panes.map((p) => p.wsId));
    for (const a of writes) assert.ok(ids.has(a[a.indexOf('--workspace') + 1]), `write outside the demo: ${a.join(' ')}`);
    const by = (name) => panes.find((p) => p.name === name).wsId;
    const progress = (wsId) => writes.find((a) => a[0] === 'set-progress' && a.includes(wsId));
    assert.match(progress(by('app-resident')).join(' '), /▲ INPUT · /, 'the asking pane rises to the top of ATTENTION');
    assert.match(progress(by('fix-weekly-export')).join(' '), /BLOCKED/);
    assert.match(progress(by('docs-worker')).join(' '), /APPROVAL/);
    assert.ok(writes.some((a) => a[0] === 'workspace-action' && a.includes(by('codex-review')) && a.includes('#9D7BFF')), 'codex violet');
    assert.ok(writes.some((a) => a[0] === 'set-status' && a[1] === 'ctx' && a.includes(by('data-resident'))));
  } finally { useDemoPanes(new Map()); observeDemoScreens(new Map()); }
});

// a tiny cmux simulator for up/down: windows, workspaces, one group
function fakeCmux({ placeholderWindow = 'demo' } = {}) {
  const windows = new Map([[id(700), [{ id: REAL, ref: 'workspace:1', title: 'real' }]]]);
  let next = 10; let demoWin = null; const calls = []; const groups = [];
  const all = () => [...windows.values()].flat();
  const run = async (args) => {
    calls.push(args.join(' '));
    const a = args[0] === '--id-format' ? args.slice(2) : args;
    const opt = (k) => a[a.indexOf(k) + 1];
    switch (a[0]) {
      case 'list-windows': return { err: null, out: [...windows.keys()].map((w, i) => `${i ? ' ' : '*'} ${i}: ${w} workspaces=${windows.get(w).length}`).join('\n') };
      case 'new-window': demoWin = id(701); windows.set(demoWin, [{ id: id(next), ref: `workspace:${next++}`, title: opt('--name') }]); return { err: null, out: 'OK' };
      case 'workspace': {
        const rows = a.includes('--window') ? windows.get(opt('--window')) || [] : all();
        if (args.includes('--json') === false) return { err: null, out: rows.map((w) => `${w.ref} ${w.id} ${w.title}`).join('\n') };
        return { err: null, out: JSON.stringify({ workspaces: rows }) };
      }
      case 'new-workspace': {
        const w = { id: id(next), ref: `workspace:${next++}`, title: opt('--name') };
        windows.get(opt('--window')).push(w);
        // like cmux 0.65: --id-format is ignored when --window is given
        return { err: null, out: a.includes('--window') ? `OK ${w.ref}` : `OK ${w.ref} (${w.id})` };
      }
      case 'workspace-group': {
        if (a[1] === 'create') {
          const ph = { id: id(next), ref: `workspace:${next++}`, title: opt('--name') };
          windows.get(placeholderWindow === 'demo' ? demoWin : id(700)).push(ph);
          groups.push({ ref: 'workspace_group:1', name: opt('--name'), anchor_workspace_ref: ph.ref, anchor_workspace_is_generated: true });
        }
        if (a[1] === 'list') return { err: null, out: JSON.stringify({ groups: a.includes('--window') ? groups : [] }) };   // like 0.65: caller's window only
        return { err: null, out: 'OK' };
      }
      case 'close-workspace': for (const ws of windows.values()) { const i = ws.findIndex((w) => w.id === opt('--workspace')); if (i >= 0) ws.splice(i, 1); } return { err: null, out: 'OK' };
      case 'close-window': windows.delete(opt('--window')); return { err: null, out: 'OK' };
      default: return { err: null, out: 'OK' };
    }
  };
  return { run, calls, windows, realWindow: () => windows.get(id(700)), demoWindow: () => windows.get(demoWin) };
}

test('demoUp: a separate window, one pane per agent, the placeholder closed; demoDown closes only the demo', async () => {
  for (const where of ['demo', 'real']) {          // cmux may put the generated anchor in either window
    const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-up-'));
    const file = path.join(dir, 'state.json');
    const c = fakeCmux({ placeholderWindow: where });
    const r = await demoUp({ run: c.run, file, root: '/opt/zulu', cwdRoot: path.join(dir, 'cwd'), log: () => {}, sleep: async () => {} });
    assert.ok(c.calls.filter((x) => x.includes('new-workspace')).every((x) => x.includes(`--cwd ${path.join(dir, 'cwd')}/`)), 'panes start in the neutral demo dirs');
    assert.equal(r.ok, true, where);
    assert.ok(c.calls.filter((x) => x.startsWith('workspace-group')).every((x) => x.includes('--window')), 'group commands name the demo window');
    assert.match(r.hint, /right-sidebar set custom phosphor --window .+ --no-focus/, 'prints the one-liner, never runs it');
    assert.ok(!c.calls.some((x) => x.startsWith('right-sidebar')), 'sidebar selection is never touched');
    assert.deepEqual(c.demoWindow().map((w) => w.title), PANES.map(paneTitle), `${where}: only the agent panes remain`);
    assert.ok(c.demoWindow().every((w) => isDemoWorkspace(w)), 'every demo pane is recognisable as demo');
    assert.deepEqual(c.realWindow().map((w) => w.id), [REAL], `${where}: the real window is exactly as it was`);
    const st = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(st.panes.length, PANES.length);
    assert.ok(c.calls.filter((x) => x.startsWith('close-workspace')).every((x) => st.workspaceIds.some((i) => x.includes(i))), 'closes only what it created');
    const d = await demoDown({ run: c.run, file, chromeFile: path.join(dir, 'chrome.json') });
    assert.equal(d.msg, 'demo window closed');
    assert.deepEqual(c.realWindow().map((w) => w.id), [REAL]);
    assert.equal(await readFile(file, 'utf8').catch(() => null), null, 'state forgotten');
  }
});

test('demoDown leaves the window open if a real workspace was moved into it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-down-'));
  const file = path.join(dir, 'state.json');
  const c = fakeCmux();
  await demoUp({ run: c.run, file, root: '/opt/zulu', cwdRoot: path.join(dir, 'cwd'), log: () => {}, sleep: async () => {} });
  c.demoWindow().push({ id: id(555), ref: 'workspace:555', title: 'my notes' });
  const d = await demoDown({ run: c.run, file });
  assert.match(d.msg, /left the window open .*my notes/);
  assert.deepEqual(c.demoWindow().map((w) => w.id), [id(555)], 'only the demo panes were closed');
  assert.ok(!c.calls.some((x) => x.startsWith('close-window')));
});

test('demoUp refuses a second demo and reports a missing cmux', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-twice-'));
  const file = path.join(dir, 'state.json');
  await writeFile(file, '{"panes":[]}');
  assert.match((await demoUp({ run: async () => ({ err: null, out: '' }), file })).reason, /already up/);
  const none = await demoUp({ run: async () => ({ err: 'connect ENOENT', out: '' }), file: path.join(dir, 'x.json') });
  assert.match(none.reason, /cmux not reachable/);
  assert.equal(DEMO_TITLE_PREFIX, 'ZULU DEMO');
});
