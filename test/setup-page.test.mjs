// Setup page (src/setup-page.mjs + public/setup.js, /?setup=1 + GET /api/setup): the guided setup's
// checklist with its live checks, read-only. The reading, the cache, the page render, the switch,
// and a real demo board with the page on and off.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { setupPageMode, setupReading, createSetupReader, demoSetupReader, commandFor, NO_LIVE_CHECK, CACHE_MS } from '../src/setup-page.mjs';
import { STEPS, NEXT_STEPS, checkStep, writeState, readState } from '../src/setup.mjs';
import { WITHHELD } from '../src/evidence.mjs';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/setup.js'), { globalThis: ctx });
const view = ctx.SetupView;

const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123';
// a planted value for a key setting, put together at run time: a literal beside a KEY name reads as a real key to the secret scanner
const PLANTED = ['planted', 'value', 'for', 'the', 'test'].join('-');
const NOW = Date.parse('2026-01-20T12:00:00Z');
const okAll = Object.fromEntries(STEPS.map((s) => [s.id, { ok: true, detail: `${s.id} fine` }]));
const failAll = Object.fromEntries(STEPS.map((s) => [s.id, { ok: false, detail: `${s.id} open` }]));

test('setupPageMode: only "on" turns the page on', () => {
  assert.equal(setupPageMode(undefined), 'off');
  assert.equal(setupPageMode({ mode: 'off' }), 'off');
  assert.equal(setupPageMode({ mode: 'observe' }), 'off');
  assert.equal(setupPageMode({ mode: 'on' }), 'on');
});

test('setupReading: the wizard\'s ten steps, in its order, each with the command that does it today', () => {
  const r = setupReading({ state: { steps: {}, answers: {} }, checks: failAll, now: NOW });
  assert.deepEqual(r.steps.map((s) => s.id), STEPS.map((s) => s.id));
  assert.equal(r.steps.length, 10);
  for (const s of r.steps) assert.equal(s.command, `zulu setup --step ${s.id}`);
  assert.equal(commandFor('watch'), 'zulu setup --step watch');
  assert.deepEqual(r.steps.filter((s) => s.required).map((s) => s.id), ['github', 'engines', 'owner', 'verify']);
  assert.equal(r.at, '2026-01-20T12:00:00.000Z');
  assert.equal(r.checking, false);
  assert.deepEqual(r.nextSteps.map((n) => n.run), NEXT_STEPS.map((n) => n.run));
});

test('setupReading: done by a live pass or by the record; skipped; a recorded step whose check now fails reads "check"', () => {
  const state = { steps: { github: { status: 'done' }, alerts: { status: 'skipped' }, verify: { status: 'done' } }, answers: {} };
  const r = setupReading({ state, checks: { ...failAll, owner: { ok: true, detail: 'owner: Sam' } }, now: NOW });
  const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.equal(by.owner.status, 'done');                 // live pass, never recorded
  assert.equal(by.owner.recorded, 'todo');
  assert.equal(by.github.status, 'check');               // recorded done, the check fails now
  assert.equal(by.alerts.status, 'skipped');
  assert.equal(by.watch.status, 'todo');
  // residents and verify have no live check: the record is all there is
  for (const id of NO_LIVE_CHECK) assert.equal(by[id].live, null);
  assert.equal(by.verify.status, 'done');
  assert.equal(by.residents.status, 'todo');
  assert.equal(r.summary.handled, 3);
  assert.deepEqual(r.summary.requiredOpen, ['GitHub account', 'AI engines (Claude / Codex)']);
  assert.equal(r.summary.complete, false);
});

test('setupReading: no checks yet = checking, statuses from the state file alone', () => {
  const r = setupReading({ state: { steps: { github: { status: 'done' } } }, checks: null, now: NOW });
  assert.equal(r.checking, true);
  assert.equal(r.steps[0].status, 'done');
  assert.equal(r.steps[0].live, null);
  assert.equal(r.steps[1].status, 'todo');
});

test('setupReading: a hand-built board, a light install and a Guardrails-only board each say what they are', () => {
  const hand = setupReading({ state: null, checks: okAll, now: NOW });
  assert.equal(hand.installed, false); assert.equal(hand.mode, null); assert.equal(hand.lead, 'checklist');
  const light = setupReading({ state: { mode: 'light', steps: {}, answers: {} }, checks: failAll, now: NOW });
  assert.equal(light.mode, 'light'); assert.equal(light.lead, 'next');
  const started = setupReading({ state: { mode: 'light', steps: { owner: { status: 'done' } } }, checks: failAll, now: NOW });
  assert.equal(started.lead, 'checklist', 'a light install that started the guided setup shows the checklist first');
  const full = setupReading({ state: { steps: {} }, checks: failAll, now: NOW });
  assert.equal(full.mode, 'full'); assert.equal(full.lead, 'checklist');
  const g = setupReading({ state: { steps: {} }, checks: failAll, profile: 'guardrails', now: NOW });
  assert.equal(g.profile, 'guardrails'); assert.equal(g.lead, 'next');
});

test('setupReading: a secret-looking detail is withheld, and details are cut short', () => {
  const r = setupReading({ state: null, checks: { ...failAll, alerts: { ok: false, detail: `key ${SECRET}` }, vault: { ok: false, detail: 'x'.repeat(900) } }, now: NOW });
  const by = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.equal(by.alerts.live.detail, WITHHELD);
  assert.ok(by.vault.live.detail.length <= 201);
  assert.ok(!JSON.stringify(r).includes(SECRET));
});

test('the reader: the real alerts check is given the secrets and no value of theirs is in the reading or the page', async () => {
  const secrets = { SMTP_HOST: 'smtp.example.test', SMTP_USER: 'board@example.test', SMTP_PASS: SECRET, ALERT_EMAIL_TO: 'alerts@example.test', SMS_WEBHOOK_URL: 'https://hooks.example.test/s', SMS_WEBHOOK_KEY: PLANTED, SMS_ALERT_TO: '+15555550199', HEARTBEAT_URL: 'https://db.example.test/rest', HEARTBEAT_KEY: 'planted-heartbeat-key' };
  // the real check for alerts (it reads only the secrets it is handed); every other step is stubbed: no child process in a test
  const reader = createSetupReader({ state: async () => ({ steps: {}, answers: {} }), secrets: () => secrets,
    check: (id, c) => (id === 'alerts' ? checkStep('alerts', c) : { ok: false, detail: '' }) });
  const r = await reader.refresh();
  const alerts = r.steps.find((s) => s.id === 'alerts');
  assert.equal(alerts.status, 'done');
  assert.equal(alerts.live.detail, 'on: email, sms, heartbeat');
  const out = JSON.stringify(r) + view.render(r);
  for (const v of Object.values(secrets)) assert.ok(!out.includes(v), `a secrets value is in the output: ${v.slice(0, 6)}…`);
});

test('the reader: peek answers at once from the state file, then from the reading; one refresh at a time; the cache ages out', async () => {
  let t = NOW; let calls = 0; let release;
  const gate = new Promise((res) => { release = res; });
  const reader = createSetupReader({ now: () => t, state: async () => ({ steps: { github: { status: 'done' } } }), secrets: () => ({}),
    check: async (id) => { calls += 1; await gate; return { ok: id === 'owner', detail: id }; } });
  const first = await reader.peek();                       // nothing cached: the state alone, a refresh starts
  assert.equal(first.checking, true);
  assert.equal(first.steps[0].status, 'done');
  await reader.peek();                                     // still in flight: no second round of checks
  const perRound = STEPS.length - NO_LIVE_CHECK.length;
  assert.equal(calls, perRound);
  release();
  const full = await reader.refresh();
  assert.equal(calls, perRound, 'refresh joined the round in flight');
  assert.equal(full.checking, false);
  assert.equal((await reader.peek()).checking, false);     // cached
  assert.equal(calls, perRound);
  t += CACHE_MS + 1;
  const stale = await reader.peek();                       // aged out: the old reading, marked, and a new round starts
  assert.equal(stale.checking, true);
  assert.equal(stale.steps.find((s) => s.id === 'owner').status, 'done');
  await reader.refresh();
  assert.equal(calls, perRound * 2);
});

test('the reader: a check that throws is that step\'s failed check, not a failed reading', async () => {
  const reader = createSetupReader({ state: async () => null, secrets: () => ({}), check: async (id) => { if (id === 'github') throw new Error('boom'); return { ok: true, detail: 'fine' }; } });
  const r = await reader.refresh();
  assert.equal(r.steps[0].status, 'todo');
  assert.equal(r.steps[0].live.detail, 'this check could not run');
  assert.equal(r.steps[2].status, 'done');
});

test('the reader never writes the state file, even when a live check passes on a step the file has open', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'setup-page-'));
  const file = path.join(dir, 'setup-state.json');
  await writeState({ installedAt: 1, mode: 'light', steps: {}, answers: {} }, file);
  const before = { text: await readFile(file, 'utf8'), mtime: (await stat(file)).mtimeMs };
  const reader = createSetupReader({ state: () => readState(file), secrets: () => ({}), check: async () => ({ ok: true, detail: 'passes' }) });
  const r = await reader.refresh();
  await reader.peek();
  assert.equal(r.steps[0].status, 'done');
  assert.equal(await readFile(file, 'utf8'), before.text);
  assert.equal((await stat(file)).mtimeMs, before.mtime);
});

test('the module and the page have no way to write: no file write, no child process, no POST', async () => {
  const mod = await read('src/setup-page.mjs');
  assert.doesNotMatch(mod, /writeFile|writeState|markStep|rename\(|child_process|node:fs/);
  const js = await read('public/setup.js');
  assert.doesNotMatch(js, /method:|POST|PATCH|mesh-decision|x-mesh/i);
  assert.equal([...js.matchAll(/fetch\(/g)].length, 1, 'one fetch: the read');
  const html = await read('public/setup.html');
  assert.doesNotMatch(html, /%%MESH_DECISION%%|mesh-decision/, 'the page carries no decision token');
});

test('the page: each status has a glyph and a word; an open step shows its command, a done one does not', () => {
  const state = { steps: { github: { status: 'done' }, alerts: { status: 'skipped' } }, answers: {} };
  const r = setupReading({ state, checks: { ...failAll, owner: { ok: true, detail: 'owner: Sam' } }, now: NOW });
  const html = view.render(r);
  assert.match(html, /data-step="owner">.*?✔<\/span> DONE/s);
  assert.match(html, /data-step="github">.*?⚠<\/span> CHECK AGAIN.*?was done; now: github open/s);
  assert.match(html, /data-step="alerts">.*?–<\/span> SKIPPED/s);
  assert.match(html, /data-step="watch">.*?○<\/span> TO DO/s);
  const owner = html.slice(html.indexOf('data-step="owner"'), html.indexOf('data-step="watch"'));
  assert.doesNotMatch(owner, /zulu setup --step owner/);
  assert.match(html, /<kbd>zulu setup --step watch<\/kbd>/);
  assert.match(html, /\(optional\)/);
  assert.match(html, /It changes nothing\./);
  assert.match(view.headline(r), /^Setup: 2 of 10 steps handled\.$/);
});

test('the page: text from the reading is escaped; a light install leads with the next steps; while checking it says so', () => {
  const evil = setupReading({ state: null, checks: { ...failAll, owner: { ok: false, detail: '<img src=x onerror=alert(1)>' } }, now: NOW });
  const html = view.render(evil);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x/);
  assert.match(view.headline(evil), /set up by hand/);
  const light = view.render(setupReading({ state: { mode: 'light', steps: {} }, checks: failAll, now: NOW }));
  assert.ok(light.indexOf('WHEN YOU WANT MORE') < light.indexOf('THE GUIDED SETUP (FULL INSTALL)'));
  assert.match(light, /<kbd>\.\/install\.sh --guardrails<\/kbd>/);
  const full = view.render(setupReading({ state: { steps: {} }, checks: failAll, now: NOW }));
  assert.ok(full.indexOf('STEPS') < full.indexOf('WHEN YOU WANT MORE'));
  assert.match(view.render(setupReading({ state: { steps: {} }, checks: null, now: NOW })), /checking…/);
  assert.match(view.headline(setupReading({ state: { steps: {} }, checks: failAll, profile: 'guardrails', now: NOW })), /Guardrails-only install/);
  assert.match(view.render(null), /no reading/);
});

test('the demo reader reads nothing of this machine: fixed steps, no state file', async () => {
  const r = await demoSetupReader().refresh();
  assert.equal(r.installed, true);
  assert.equal(r.steps.find((s) => s.id === 'owner').live.detail, 'owner: Demo Owner');
  assert.equal(r.steps.find((s) => s.id === 'alerts').status, 'skipped');
});

// ---- a real board ----
async function board(mode, fn) {
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'setup-page-overlay-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { setupPage: { mode } } }));
  const port = await freePort();
  const env = demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1' });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    await fn(base);
  } finally { child.kill(); }
}

test('a real board with the page on: the route answers, the page is served without a token, the board page links to it', async () => {
  await board('on', async (base) => {
    let r = null;
    for (let i = 0; i < 40; i += 1) {
      const res = await fetch(`${base}/api/setup`);
      assert.equal(res.status, 200);
      r = await res.json();
      if (!r.checking) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.equal(r.ok, true);
    assert.equal(r.checking, false);
    assert.equal(r.steps.length, 10);
    assert.equal(r.steps.find((s) => s.id === 'github').status, 'done');
    const page = await fetch(`${base}/?setup=1`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Setup · /);
    assert.match(html, /src="\/setup\.js"/);
    const index = await (await fetch(`${base}/`)).text();
    const token = index.match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    assert.ok(token, 'the board page has its token');
    assert.ok(!html.includes(token), 'the setup page does not');
    assert.match(index, /name="setup-page" content="on"/);
    assert.equal((await fetch(`${base}/setup.js`)).status, 200);
    // a write to the route is not a thing
    const post = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok(post.status >= 400, `POST answered ${post.status}`);
  });
});

test('a real board with the page off: no route, no page, no script, and ?setup=1 is the board page', async () => {
  await board('off', async (base) => {
    assert.equal((await fetch(`${base}/api/setup`)).status, 404);
    assert.equal((await fetch(`${base}/setup.html`)).status, 404);
    assert.equal((await fetch(`${base}/setup.js`)).status, 404);
    const index = await (await fetch(`${base}/?setup=1`)).text();
    assert.match(index, /name="setup-page" content="off"/);
    assert.match(index, /name="mesh-decision"/);
  });
});
