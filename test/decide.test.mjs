// WORK-panel approval logic (public/decide.js) + the page/server wiring that
// task #85 depends on: no window.confirm, boot id injected, 403 on a bad token.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/decide.js'), { globalThis: ctx });
const { armClick, decisionOutcome, staleBoot, ARM_MS } = ctx.BoardDecide;
const { BoardDecide } = ctx;

test('armClick: first click arms, a second matching click within the window fires', () => {
  const a = armClick(null, 81, 'approve', 1000);
  assert.equal(a.fire, false);
  assert.deepEqual({ ...a.armed }, { task: '81', decision: 'approve', until: 1000 + ARM_MS });
  assert.equal(armClick(a.armed, '81', 'approve', 2000).fire, true);
  assert.equal(armClick(a.armed, '81', 'decline', 2000).fire, false, 'the other button re-arms, never fires');
  assert.equal(armClick(a.armed, '82', 'approve', 2000).fire, false, 'another task re-arms');
  assert.equal(armClick(a.armed, '81', 'approve', 1000 + ARM_MS).fire, false, 'expired arm re-arms');
});

test('decisionOutcome: every failure is spelled out, 403 asks for a reload', () => {
  assert.equal(decisionOutcome(200, { ok: true }).ok, true);
  const net = decisionOutcome(0, null);
  assert.equal(net.ok, false);
  assert.match(net.text, /NOT SENT/);
  const tok = decisionOutcome(403, { ok: false, msg: 'decision token rejected' });
  assert.equal(tok.reload, true);
  assert.match(tok.text, /reload/i);
  assert.match(decisionOutcome(409, { ok: false, msg: 'task #81 is not awaiting approval' }).text, /not awaiting approval/);
  assert.match(decisionOutcome(500, null).text, /HTTP 500/);
});

test('staleBoot: only a real mismatch counts', () => {
  assert.equal(staleBoot('aaa', 'bbb'), true);
  assert.equal(staleBoot('aaa', 'aaa'), false);
  assert.equal(staleBoot('', 'bbb'), false, 'older server/page without ids: no banner');
  assert.equal(staleBoot('%%BOOT_ID%%', 'bbb'), false, 'un-rendered template: no banner');
});

test('wiring: the panel never uses window.confirm; page + server carry the boot id and the 403', async () => {
  const [app, html, server] = await Promise.all([read('public/app.js'), read('public/index.html'), read('server.mjs')]);
  const code = app.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\bconfirm\(/, 'embedded web views may cancel confirm() silently');
  assert.match(html, /<script src="decide\.js"><\/script>\s*<script src="app\.js">/);
  assert.match(html, /name="board-boot" content="%%BOOT_ID%%"/);
  assert.match(html, /id="notice"/);
  assert.match(server, /replace\('%%BOOT_ID%%', BOOT_ID\)/);
  assert.match(server, /bootId: BOOT_ID/);
  assert.match(server, /MeshError\(403, 'decision token rejected/);
});

// the Dock's section holds only blocks + snoozed (#450); it says nothing on its own when those are empty
test('decisionsState: full board hides an empty strip; the Dock section shows only with blocks or snoozed', () => {
  assert.deepEqual({ ...BoardDecide.decisionsState(0, false) }, { hidden: true, empty: true });
  assert.deepEqual({ ...BoardDecide.decisionsState(2, false) }, { hidden: false, empty: false });
  assert.deepEqual({ ...BoardDecide.decisionsState(0, true) }, { hidden: true, empty: false });
  assert.deepEqual({ ...BoardDecide.decisionsState(3, true) }, { hidden: true, empty: false }, 'decisions alone: they are in NEEDS ATTENTION');
  assert.deepEqual({ ...BoardDecide.decisionsState(3, true, 0, 2) }, { hidden: false, empty: false });
  assert.deepEqual({ ...BoardDecide.decisionsState(0, true, 1) }, { hidden: false, empty: false });
});

// #444: the buttons come before the command, and a long command folds without ever losing text
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1} <x>`).join('\n');
const pending = (command) => ({ id: 'g1', cls: 'merge', label: 'Merge a pull request', agent: 'res-a', cwd: '/repo', tool: 'Bash', why: 'a merge', command });
const row = (command, open = false) => BoardDecide.gateRowHtml(pending(command), { key: '7:g1', esc, age: '3m', open, actions: '<button class="act-approve">RUN</button>' });
const cmdText = (html) => html.match(/<pre class="gate-cmd">([\s\S]*?)<\/pre>/)[1];

test('gate row order: label, why, agent, buttons, command', () => {
  const html = row(lines(25));
  const at = ['gate-label', 'a merge', 'res-a', 'act-approve', 'gate-cmd"', 'data-cmd-toggle'].map((s) => html.indexOf(s));
  assert.ok(at.every((n) => n >= 0), `all parts present: ${at}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b));
});

test('foldCommand: at the limits nothing folds; one more line or char does', () => {
  const { foldCommand, CMD_LINES, CMD_CHARS } = BoardDecide;
  assert.equal(foldCommand(lines(CMD_LINES)).long, false);
  assert.equal(foldCommand(`${lines(CMD_LINES)}\n\n`).long, false, 'trailing newlines are not lines');
  assert.equal(foldCommand('x'.repeat(CMD_CHARS)).long, false);
  const f = foldCommand(lines(CMD_LINES + 1));
  assert.equal(f.long, true);
  assert.equal(f.lines, CMD_LINES + 1);
  assert.equal(f.preview.split('\n').length, CMD_LINES);
  const wide = foldCommand('x'.repeat(CMD_CHARS + 1));
  assert.equal(wide.long, true);
  assert.equal(wide.preview.length, CMD_CHARS);
  assert.equal(foldCommand(undefined).preview, '');
});

test('a short command shows as it is, with no toggle', () => {
  const html = row(lines(6));
  assert.equal(cmdText(html), esc(lines(6)));
  assert.doesNotMatch(html, /data-cmd-toggle/);
});

test('a long command: folded shows the first lines and the count; unfolded is the exact text', () => {
  const cmd = lines(25);
  const folded = row(cmd);
  assert.equal(cmdText(folded).split('\n').length, 6);
  assert.doesNotMatch(cmdText(folded), /line 7 /);
  assert.match(cmdText(folded), / …$/, 'the cut is marked');
  assert.match(folded, /data-cmd-toggle="7:g1" aria-expanded="false">▸ show full command \(25 lines\)/);
  const open = row(cmd, true);
  assert.equal(cmdText(open), esc(cmd), 'every line, nothing cut, no marker');
  assert.match(open, /aria-expanded="true">▾ fold command/);
  assert.match(row('y'.repeat(900)), /show full command \(900 chars\)/);
});

test('command text is escaped both folded and unfolded', () => {
  const cmd = `${lines(7)}\n<script>alert(1)</script>`;
  assert.doesNotMatch(row(cmd), /<script>/);
  assert.doesNotMatch(row(cmd, true), /<script>/);
});

test('the row gets the whole stored command, so unfolding really shows all of it', async () => {
  const { pendingGates } = await import('../src/gate-ledger.mjs');
  const command = 'x'.repeat(5000);
  assert.equal(pendingGates({ gates: [{ id: 'g1', status: 'pending', command }] })[0].command, command);
});

test('wiring: the toggle works on the strip and in WORK, and the page remembers it per gate', async () => {
  const app = await read('public/app.js');
  assert.match(app, /BoardDecide\.gateRowHtml\(g, \{ key,[^}]*open: gateCmdOpen\.has\(key\)/);
  assert.match(app, /\$\('work-cols'\)\.addEventListener\('click', onCommandToggle\)/);
  assert.match(app, /\$\('decisions-list'\)\.addEventListener\('click', onCommandToggle\)/);
  // measured at 360px: with a plain 1fr, a long no-wrap title pushed DECLINE to x=612
  assert.match(await read('public/style.css'), /max-width: 520px\) \{ \.decisions-list \{ grid-template-columns: minmax\(0, 1fr\); \}/);
});

// #450 (reverses #376): header, NEEDS ATTENTION led by the decisions, then the blocks
test('dockLayout: header, then NEEDS ATTENTION holding the decisions above the cards, then WAITING ON YOU', async () => {
  const html = await read('public/index.html');
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script'));
  // the page's top-level order, as the browser builds it
  const order = [...body.matchAll(/^<(header|section|div)\b([^>]*)>/gm)]
    .map((m) => (m[1] === 'header' ? 'header' : (m[2].match(/id="([\w-]+)"/) || [])[1] || m[1]));
  assert.ok(order.indexOf('decisions') < order.indexOf('attention-row'), 'full board: the strip comes first (unchanged)');
  const node = (id) => ({
    id, kids: [],
    insertBefore(n, ref) {
      n.parentNode.kids.splice(n.parentNode.kids.indexOf(n), 1);
      this.kids.splice(this.kids.indexOf(ref), 0, n);
      n.parentNode = this;
    },
    append(...ns) { for (const n of ns) { n.parentNode = this; this.kids.push(n); } return this; },
  });
  const page = node('page').append(...order.map(node));
  const by = (id) => page.kids.find((k) => k.id === id);
  const list = node('decisions-list'), fold = node('decisions-fold'), grid = node('attention-grid');
  by('decisions').append(list, fold);
  by('attention-row').append(grid);
  const all = { 'decisions-list': list, 'decisions-fold': fold, 'attention-grid': grid };
  BoardDecide.dockLayout({ getElementById: (id) => all[id] || by(id) || null });
  const ids = page.kids.map((k) => k.id);
  assert.ok(ids.indexOf('header') < ids.indexOf('attention-row'), 'header first');
  assert.equal(ids.indexOf('decisions'), ids.indexOf('attention-row') + 1, 'WAITING ON YOU right after NEEDS ATTENTION');
  assert.ok(ids.indexOf('decisions') < ids.indexOf('agents-row'), 'above the agent sessions');
  assert.deepEqual(by('attention-row').kids.map((k) => k.id), ['decisions-list', 'attention-grid'], 'decisions before the cards');
  assert.deepEqual(by('decisions').kids.map((k) => k.id), ['decisions-fold'], 'only the blocks and snoozed folds stay');
  assert.equal(list.parentNode, by('attention-row'));
  const notAll = { getElementById: (id) => (id === 'decisions' ? by('decisions') : null) };
  assert.doesNotThrow(() => BoardDecide.dockLayout(notAll), 'a page without the parts is left alone');
  assert.match(html, /id="attention-title"/);
  assert.match(html, /class="decisions-empty">⛨ nothing waiting on you</);
  const [app, css] = await Promise.all([read('public/app.js'), read('public/style.css')]);
  assert.match(app, /if \(dockMode\) \{[^}]*BoardDecide\.dockLayout\(document\)/);
  assert.match(app, /toggle\('hidden', attention\.length === 0 && !dockMode\)/, 'the Dock keeps NEEDS ATTENTION on screen when no card is amber');
  assert.match(app, /e\.currentTarget\.id === 'decisions-list'/, 'the strip receipt follows the moved list');
  assert.match(css, /\.decisions \{ position: sticky; top: 0;/, 'full board: still sticky');
  assert.match(css, /body\.dock \.decisions \{ position: static; max-height: none; overflow: visible; border-color: var\(--ink-3\); box-shadow: none;/, 'Dock: blocks never sticky, no glow');
});
