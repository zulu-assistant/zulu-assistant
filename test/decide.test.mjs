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
