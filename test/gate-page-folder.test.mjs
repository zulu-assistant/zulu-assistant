// The trigger line of a guarded folder whose path is one name (the board's page folder) is that name as a
// whole path segment, never a part of a longer word (#541). Before, the line was the bare word: every call
// whose text or folder contained it started the Node step, and a checkout in a folder such as
// `…/zulu-public` failed three hook tests (so the installer's verify step and an upgrade's test step failed there).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, triggerLines, normalizeForTriggers, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';
import { routing, renderRouting, readChecks } from '../scripts/gate-replay.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LINE = triggerLines(DEFAULT_POLICY).find((l) => /public/.test(l) && !l.includes('--public'));
const hookText = (command, cwd) => normalizeForTriggers(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's' }));

// calls that name the page folder (or are made from inside it): the old bare word matched each of them
const NAMES_IT = [
  ['cat public/index.html', '/srv/zulu'], ['rm -r public', '/srv/zulu'], ['rm -rf ./public', '/srv/zulu'], ['cd public && rm index.html', '/srv/zulu'],
  ['echo x > /srv/zulu/public/app.js', '/tmp'], ['cp /tmp/new.js "public/app.js"', '/srv/zulu'], ['tar -xf /tmp/x.tar -C public', '/srv/zulu'],
  ['tar -Cpublic -xf /tmp/x.tar', '/srv/zulu'], ['tar -xfC /tmp/x.tar public', '/srv/zulu'], ['make -Cpublic clean', '/srv/zulu'], ['rm -r *public*', '/srv/zulu'],
  ['mv public{,.bak}', '/srv/zulu'], ['mv zulu/{public,old}', '/srv'], ['d=public; rm -r $d', '/srv/zulu'], ['rm -r ${root}public', '/srv/zulu'],
  ['rsync -a /tmp/x/ host:public', '/srv/zulu'], ['dd of=public/app.js', '/srv/zulu'], ['unzip -o /tmp/x.zip -d public', '/srv/zulu'],
  ['git rm -r public', '/srv/zulu'], ['rm index.html', '/srv/zulu/public'], ['rm app.js', '/srv/zulu/public/media'], ['ls PUBLIC/', '/srv/zulu'],
  ['find . -name public -prune', '/srv/zulu'], ['(cd public; ls)', '/srv/zulu'], ['ls public;', '/srv/zulu'], ['sed -i "" s/a/b/ public/index.html', '/srv/zulu'],
];
// calls that only contain the letters: a checkout or a word that is not the folder
const OTHER = [
  ['git status && ls -la src', '/Users/u/zulu-public'], ['ls', '/Users/u/zulu_public/src'], ['npm test', '/srv/republic/app'], ['ls', '/srv/my-republic'],
  ['grep publicRemotes examples/policy.json', '/srv/zulu'], ['gh repo view --json isPublic', '/srv/zulu'],
  ['ls ~/zulu-assistant-public/src', '/srv/zulu'], ['cat public.bak', '/srv/zulu'], ['ls public_html', '/srv/site'], ['ls public-old', '/srv/zulu'],
  ['echo unpublicized', '/srv/zulu'], ['cat notes/publication.md', '/srv/zulu'], ['ls /srv/site-public/assets', '/tmp'],
];

test('the shipped line for the page folder is a path segment, and no line is the bare word', () => {
  assert.ok(LINE, 'a line for the page folder');
  assert.notEqual(LINE, 'public');
  assert.equal(triggerLines(DEFAULT_POLICY).includes('public'), false);
  // with the checkout known, the name inside the checkout's own line is the same segment form
  const live = triggerLines(DEFAULT_POLICY, { boardRoot: '/Users/u/zulu', home: '/Users/u' }).filter((l) => /public/.test(l) && !l.includes('--public'));
  assert.ok(live.length && live.every((l) => !/[|(]public[|)]/.test(l)), 'the bare word inside the live line');
});

test('grep and the JS twin agree: every call that names the page folder still reaches the Node step; a longer word does not', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-page-')); const file = path.join(dir, 'triggers'); writeFileSync(file, LINE + '\n');
  const js = compileTriggers(DEFAULT_POLICY).find((t) => t.ere === LINE).re;
  const sh = (text) => spawnSync('/usr/bin/grep', ['-qiE', '-f', file], { input: text }).status === 0;
  for (const [c, cwd] of NAMES_IT) {
    const text = hookText(c, cwd);
    assert.ok(/public/i.test(text), `"${c}": the old line`);
    assert.equal(sh(text), true, `grep: "${c}" in ${cwd}`); assert.equal(js.test(text), true, `js: "${c}" in ${cwd}`);
  }
  for (const [c, cwd] of OTHER) {
    const text = hookText(c, cwd);
    assert.ok(/public/i.test(text), `"${c}": the old line matched it`);
    assert.equal(sh(text), false, `grep: "${c}" in ${cwd}`); assert.equal(js.test(text), false, `js: "${c}" in ${cwd}`);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('no line of the shipped file matches a call that only sits in a folder with the word in its name', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'trig-all-')); const file = path.join(dir, 'triggers'); writeFileSync(file, triggerLines(DEFAULT_POLICY).join('\n') + '\n');
  for (const cwd of ['/Users/u/zulu-public', '/Users/u/zulu-assistant-public/test', '/srv/republic/app', '/Users/u/my_public_copy']) {
    assert.equal(spawnSync('/usr/bin/grep', ['-qiE', '-f', file], { input: hookText('git status && ls -la src && node --version', cwd) }).status, 1, cwd);
  }
  rmSync(dir, { recursive: true, force: true });
});

test('the hook itself, run from a checkout in a folder with the word in its name: a free call never starts Node, a call on the page folder does', () => {
  const base = mkdtempSync(path.join(os.tmpdir(), 'gate-where-'));
  for (const name of ['zulu-public', 'republic', 'my_public_copy']) {
    const co = path.join(base, name); mkdirSync(path.join(co, 'scripts'), { recursive: true });
    for (const f of ['gate-hook.sh', 'gate-triggers.default']) cpSync(path.join(ROOT, 'scripts', f), path.join(co, 'scripts', f));
    const marker = path.join(co, 'ran'); const shim = path.join(base, `node-${name}`);
    writeFileSync(shim, `#!/bin/sh\n: > "${marker}"\nexit 3\n`, { mode: 0o755 });
    const run = (command, cwd = co) => spawnSync('sh', [path.join(co, 'scripts', 'gate-hook.sh'), '--env-board'], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd, session_id: 's' }),
      env: { ...process.env, GATE_NODE: shim, MESH_BOARD: 'http://127.0.0.1:9', CMUX_WORKSPACE_ID: '' }, encoding: 'utf8' });
    for (const c of ['git status && ls -la src && node --version', 'ls -la', 'cat README.md']) {
      const r = run(c); assert.equal(r.status, 0, name); assert.equal(r.stdout, '', name);
      assert.equal(existsSync(marker), false, `${name}: "${c}" started Node`);
    }
    run('cat public/index.html');
    assert.equal(existsSync(marker), true, `${name}: a call on the page folder reaches the Node step`);
    rmSync(marker); run('ls', path.join(co, 'public'));
    assert.equal(existsSync(marker), true, `${name}: a call made from inside the page folder reaches the Node step`);
  }
  rmSync(base, { recursive: true, force: true });
});

// what is held stays held: writes to the page folder of the live checkout, under the lines the board writes
// (checkout known) and under the shipped file's lines (checkout not known)
test('writes to the live page folder are held as before, under both sets of lines', () => {
  const L = '/home/u/zulu-public'; const W = '/home/u/wt-7';      // a live checkout with the word in its own name
  const policy = { ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), selfProtect: 'enforce' } };
  const ctx = { home: '/home/u', boardRoot: L, board: { pids: [4242], port: 3999, label: 'com.example.board' }, repoRoot: (d) => (d.startsWith(L) ? L : d.startsWith(W) ? W : null), git: () => null };
  const sets = { board: compileTriggers(policy, ctx), shipped: compileTriggers(policy) };
  const verdict = (command, cwd, triggers) => classify({ tool: 'Bash', command, cwd }, policy, { ...ctx, triggers });
  for (const [which, triggers] of Object.entries(sets)) {
    for (const [c, cwd] of [['echo x > public/app.js', L], ['rm -r public', L], ['cp /tmp/a.js public/app.js', L], ['unzip -o /tmp/x.zip -d public', L], ['ditto /tmp/x public', L],
      ['git rm -r public', L], ['tar -Cpublic -xf /tmp/x.tar', L], ['rm index.html', `${L}/public`], [`echo x > ${L}/public/app.js`, '/tmp'], [`cd ${L} && rm -r public`, '/tmp']]) {
      const r = verdict(c, cwd, triggers);
      assert.equal(r.verdict, 'gate', `${which}: "${c}" in ${cwd} → ${r.why}`); assert.equal(r.cls, 'self', `${which}: "${c}"`);
    }
    // the same checkout: a call that touches nothing guarded is clear, and a worktree's own page folder is not the live one
    assert.equal(verdict('git status && ls -la src', L, triggers).verdict, 'clear', which);
    assert.equal(verdict('echo x > public/app.js', W, triggers).verdict, 'clear', which);
  }
  // …and that free call hits no line at all in such a checkout (before: the bare word matched its folder)
  const t = sets.shipped; const text = hookText('git status && ls -la src', L);
  assert.deepEqual(t.filter((x) => x.re.test(text)).map((x) => x.ere), []);
});

test('gate-replay --lines-before: which recorded calls an older trigger file routed and today\'s lines do not, with the words that did it and never the call', () => {
  const rec = (command, cwd, agent = 'a') => JSON.stringify({ at: '2026-01-01T00:00:00.000Z', event: 'pre', tool: 'Bash', agent, command, cwd });
  const log = [rec('npm test', '/Users/u/zulu-public'), rec('grep publicRemotes notes.txt', '/srv/app', 'b'), rec('cat public/index.html', '/srv/app'),
    rec('gh pr merge 3', '/Users/u/zulu-public'), rec('ls -la', '/srv/app')].join('\n');
  const now = triggerLines(DEFAULT_POLICY); const before = now.map((l) => (l === LINE ? 'public' : l));
  const r = routing(readChecks(log), before, now);
  assert.equal(r.total, 5); assert.equal(r.withFolder, 5); assert.equal(r.before, 4); assert.equal(r.now, 2);
  assert.equal(r.stopped, 2); assert.equal(r.started, 0);
  assert.deepEqual(r.words, { 'zulu-public': 1, publicremotes: 1 }); assert.deepEqual(r.byAgent, { a: 1, b: 1 });
  const out = renderRouting(r);
  assert.match(out, /stop reaching the Node step: 2 /); assert.doesNotMatch(out, /npm test|grep /);
  assert.equal(routing([], before, now).total, 0);
});
