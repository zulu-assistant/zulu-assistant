import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderPolicy, blockOf, withBlock } from '../scripts/policy-render.mjs';
import { mergeHooks, removeHooks } from '../scripts/merge-hooks.mjs';
import { demoBeats, GATE_AT, GATE_APPROVE_AT, T0 } from '../src/demo.mjs';
import { gateCard, showsBridgeCard } from '../src/status.mjs';
import { failOpenEntries, hookEntries } from '../src/gate-integrity.mjs';
import { policyProblems } from '../src/gate-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('POLICY.md\'s gates block is exactly what policy.json renders (both skins: examples always, overlay when present)', () => {
  for (const dir of ['examples', 'overlay']) {
    if (!existsSync(path.join(ROOT, dir, 'policy.json'))) continue;
    const policy = JSON.parse(read(`${dir}/policy.json`));
    assert.deepEqual(policyProblems(policy), [], `${dir}/policy.json`);
    assert.equal(blockOf(read(`${dir}/POLICY.md`)), renderPolicy(policy), `${dir}/POLICY.md is stale: node scripts/policy-render.mjs --write ${dir}/POLICY.md ${dir}/policy.json`);
  }
  const md = withBlock('# P\n\nprose\n', renderPolicy(JSON.parse(read('examples/policy.json'))));
  assert.ok(md.startsWith('# P\n\nprose\n') && blockOf(md));
  assert.equal(withBlock(md, 'X'.repeat(0) + renderPolicy(JSON.parse(read('examples/policy.json')))), md);   // idempotent
});

test('installing and removing the gate hook is idempotent and leaves other hooks alone', () => {
  const tpl = JSON.parse(read('examples/claude/guardrails-hooks.json.tmpl').replace(/__REPO__/g, '/r').replace(/__NODE_BIN_DIR__/g, '/n'));
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }] } };
  const once = mergeHooks(mine, tpl); const twice = mergeHooks(once.settings, tpl);
  assert.equal(once.added, 3); assert.equal(twice.added, 0);          // the gate hook twice, and the settings-change hook next to it
  const half = removeHooks(once.settings, 'scripts/gate-hook.sh');
  assert.equal(half.removed, 2);
  // the installer's --remove takes the settings-change hook out as well (scripts/guardrails-install.sh)
  const gone = removeHooks(half.settings, 'scripts/gate-config-hook.sh');
  assert.equal(gone.removed, 1);
  assert.deepEqual(gone.settings, mine);
  const codex = JSON.parse(read('examples/codex/guardrails-hooks.json.tmpl'));
  assert.ok(codex.hooks.PreToolUse[0].hooks[0].timeout >= 1000, 'codex timeouts are milliseconds');
});

// ── the two entries that can stop something fail closed (task 503) ──
const TPL = () => JSON.parse(read('examples/claude/guardrails-hooks.json.tmpl').replace(/__REPO__/g, '/r').replace(/__NODE_BIN_DIR__/g, '/n'));
/** The template as the installer wrote it before the field existed. */
const oldInstall = () => { const t = TPL(); for (const groups of Object.values(t.hooks)) for (const g of groups) for (const h of g.hooks) delete h.onFailure; return t; };

test('the template: the gate hook before a call and the settings-change hook say onFailure "block"; the after-call entry and Codex do not', () => {
  const t = TPL();
  const field = (event) => t.hooks[event].flatMap((g) => g.hooks.map((h) => h.onFailure ?? null));
  assert.deepEqual(field('PreToolUse'), ['block']);        // a hook that cannot start, or answers late, stops the call
  assert.deepEqual(field('ConfigChange'), ['block']);      // … or stops the settings change
  assert.deepEqual(field('PostToolUse'), [null]);          // the call has already run: nothing to stop
  assert.doesNotMatch(read('examples/codex/guardrails-hooks.json.tmpl'), /onFailure/, 'a Claude Code field');
  // the card reads the field with the entry
  assert.deepEqual(hookEntries(t).map((e) => [e.event, e.onFailure]), [['PreToolUse', 'block'], ['PostToolUse', null], ['ConfigChange', 'block']]);
});

test('an install made before the field existed gets it when the installer runs again: only its own entries, only the template\'s fields', () => {
  const tpl = TPL();
  const old = oldInstall();
  old.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard', timeout: 5 }] });
  old.hooks.PreToolUse[1].hooks[0].note = 'kept';                     // a key the template does not have stays
  old.permissions = { allow: ['Bash(ls:*)'] };
  // without the refresh nothing happens: the commands are already there (what the old merge did)
  const plain = mergeHooks(old, tpl);
  assert.equal(plain.added, 0); assert.deepEqual(plain.refreshed, []); assert.deepEqual(plain.settings, old);
  // with it: the two fields, nothing else
  const r = mergeHooks(old, tpl, { refresh: true });
  assert.equal(r.added, 0);
  assert.deepEqual(r.refreshed, ['PreToolUse: onFailure', 'ConfigChange: onFailure']);
  assert.deepEqual(failOpenEntries(old, { repo: '/r' }), ['the gate hook', 'the settings-change hook']);
  assert.deepEqual(failOpenEntries(r.settings, { repo: '/r' }), []);
  assert.deepEqual(r.settings.hooks.PreToolUse[0], old.hooks.PreToolUse[0], 'another program\'s hook is not touched');
  assert.equal(r.settings.hooks.PreToolUse[1].hooks[0].note, 'kept');
  assert.deepEqual(r.settings.permissions, old.permissions);
  // once more: nothing left to do
  const again = mergeHooks(r.settings, tpl, { refresh: true });
  assert.deepEqual([again.added, again.refreshed], [0, []]);
  // a changed timeout in the template is refreshed the same way
  const t2 = TPL(); t2.hooks.PreToolUse[0].hooks[0].timeout = 20;
  assert.deepEqual(mergeHooks(r.settings, t2, { refresh: true }).refreshed, ['PreToolUse: timeout']);
  // an entry of ANOTHER checkout's gate hook is not ours: not refreshed, and a second entry is added beside it
  const other = JSON.parse(JSON.stringify(oldInstall()).replaceAll('/r/scripts', '/elsewhere/scripts'));
  const mixed = mergeHooks(other, tpl, { refresh: true });
  assert.equal(mixed.added, 3); assert.deepEqual(mixed.refreshed, []);
  // the card's note: which of ours lack the field; one that is not registered at all is not listed here
  assert.deepEqual(failOpenEntries({ hooks: { PreToolUse: old.hooks.PreToolUse } }, { repo: '/r' }), ['the gate hook']);
  assert.deepEqual(failOpenEntries(null, { repo: '/r' }), []);
  assert.deepEqual(failOpenEntries(tpl, { repo: '/another' }), []);
  // taking it out again leaves the file as it was before the installer ever ran
  const base = { permissions: old.permissions, hooks: { PreToolUse: [old.hooks.PreToolUse[0]] } };
  const gone = removeHooks(removeHooks(r.settings, 'scripts/gate-hook.sh').settings, 'scripts/gate-config-hook.sh');
  assert.deepEqual(gone.settings, base);
});

test('the installer itself: refreshes an older install, says what the field means, refuses to write on an older Claude Code, and its remove form leaves nothing behind', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'gate install-'));
  const bin = path.join(home, 'bin'); mkdirSync(bin); mkdirSync(path.join(home, '.claude'));
  const claude = (version) => { writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`); chmodSync(path.join(bin, 'claude'), 0o755); };
  const run = (...args) => spawnSync('bash', [path.join(ROOT, 'scripts', 'guardrails-install.sh'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, CLAUDE_BIN: path.join(bin, 'claude') } });
  const file = path.join(home, '.claude', 'settings.json');
  const settings = () => JSON.parse(readFileSync(file, 'utf8'));
  // an older install, as rendered for THIS checkout, with another program's hook beside it
  claude('2.1.321');
  let r = run('--apply'); assert.equal(r.status, 0, r.stderr);
  const fresh = settings();
  const old = structuredClone(fresh); for (const groups of Object.values(old.hooks)) for (const g of groups) for (const h of g.hooks) delete h.onFailure;
  old.hooks.Stop = [{ hooks: [{ type: 'command', command: 'say done' }] }];
  writeFileSync(file, JSON.stringify(old, null, 2));
  // shown first, nothing written
  r = run();
  assert.match(r.stdout, /would  refresh 2 field\(s\) of the entries already there \(PreToolUse: onFailure, ConfigChange: onFailure\)/);
  assert.match(r.stdout, /note   the gate hook and the settings-change hook are registered with onFailure: "block": if their script cannot start or answers late, Claude Code stops the call/);
  assert.match(r.stdout, /note   before you move or delete this checkout, take them out first: scripts\/guardrails-install\.sh --remove --apply/);
  assert.doesNotMatch(r.stdout, /WARN/);
  assert.deepEqual(settings(), old);
  // applied: the two fields, the other hook untouched, a backup beside
  r = run('--apply');
  assert.match(r.stdout, /done   refreshed 2 field\(s\)/);
  assert.deepEqual(settings(), { ...fresh, hooks: { ...fresh.hooks, Stop: old.hooks.Stop } });
  assert.match(run('--apply').stdout, /^skip   hooks already in /);
  // an older Claude Code. Shown: a warning that says the write form will refuse.
  claude('2.1.290');
  r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARN   Claude Code 2\.1\.290 is older than 2\.1\.295: it is not tested what it does with onFailure\. Update it \(npm i -g @anthropic-ai\/claude-code\)\. The write form refuses until then \(or takes --allow-older-claude\)\./);
  // The write form: refused BEFORE anything is written (no file, no backup, no folder made), with the reason and the update command
  const empty = mkdtempSync(path.join(os.tmpdir(), 'gate install-old-'));
  const inEmpty = (...args) => spawnSync('bash', [path.join(ROOT, 'scripts', 'guardrails-install.sh'), ...args], { encoding: 'utf8', env: { ...process.env, HOME: empty, CLAUDE_BIN: path.join(bin, 'claude') } });
  r = inEmpty('--apply');
  assert.equal(r.status, 3); assert.equal(r.stdout, '');
  assert.match(r.stderr, /^REFUSED  Claude Code 2\.1\.290 is older than 2\.1\.295, and nothing was written\./);
  assert.match(r.stderr, /npm i -g @anthropic-ai\/claude-code/); assert.match(r.stderr, /--apply --allow-older-claude/);
  assert.deepEqual(readdirSync(empty), []);
  r = inEmpty('--apply', '--codex'); assert.equal(r.status, 3); assert.deepEqual(readdirSync(empty), []);   // Codex's file is not written either
  // an install that is already there is left as it was, byte for byte
  const before = readFileSync(file, 'utf8'); const names = readdirSync(path.dirname(file)).sort();
  r = run('--apply'); assert.equal(r.status, 3);
  assert.equal(readFileSync(file, 'utf8'), before); assert.deepEqual(readdirSync(path.dirname(file)).sort(), names);
  // with the override word it writes, and repeats the warning (without the sentence about refusing)
  r = inEmpty('--apply', '--allow-older-claude'); assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARN   Claude Code 2\.1\.290 is older than 2\.1\.295: it is not tested what it does with onFailure\. Update it \(npm i -g @anthropic-ai\/claude-code\)\.$/m);
  assert.equal(JSON.parse(readFileSync(path.join(empty, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].onFailure, 'block');
  // the override word alone writes nothing; the remove form never asks for the version
  assert.match(inEmpty('--allow-older-claude').stdout, /\(dry run/);
  r = inEmpty('--remove', '--apply'); assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout + r.stderr, /REFUSED|WARN/);
  // the first version that knows the field, and a newer one: no warning, written
  claude('2.1.295'); assert.doesNotMatch(run().stdout, /WARN/); assert.equal(run('--apply').status, 0);
  claude('2.2.0'); assert.doesNotMatch(run().stdout, /WARN/);
  // no claude at all, or a version line nobody can read: a note, and the write form goes ahead
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "claude-next (Claude Code)"\n');
  r = run('--apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /note   the Claude Code version could not be read here/);
  rmSync(path.join(bin, 'claude'));
  r = run('--apply'); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /note   claude is not on PATH here: the field needs Claude Code 2\.1\.295 or later/);
  claude('2.2.0');
  // the remove form: all three entries out, the other hook stays, and no note about a field that is no longer there
  r = run('--remove', '--apply'); assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /onFailure/);
  assert.deepEqual(settings(), { hooks: { Stop: old.hooks.Stop } });
});

test('demo mode scripts a gate: filed, then approved and run once', () => {
  const base = T0;   // the demo cycle starts when the module loads
  const beats = (a, b) => demoBeats(base + a * 1000, base + b * 1000);
  assert.ok(beats(GATE_AT - 1, GATE_AT + 1).some((x) => x.gate === 'file'));
  assert.ok(beats(GATE_APPROVE_AT - 1, GATE_APPROVE_AT + 1).some((x) => x.gate === 'approve'));
});

test('guardrails card: amber while waiting or the hook is missing, red only for a broken policy, stale when old', () => {
  const now = 1e12;
  assert.equal(gateCard(null), null);
  assert.equal(gateCard({ status: 'ok', detail: 'enforce', at: now }, now).status, 'ok');
  assert.equal(gateCard({ status: 'warn', detail: '1 waiting', at: now }, now).status, 'warn');
  assert.equal(gateCard({ status: 'failed', detail: 'hook: claude MISSING', at: now }, now).status, 'warn');
  // the integrity check (src/gate-integrity.mjs) decides the colour too: red for a changed gate file or a dropped hook,
  // amber while the checkout is behind, and what is wrong is said first
  const integ = (status, detail) => gateCard({ status: 'ok', detail: 'enforce', integrity: { status, detail }, at: now }, now);
  assert.deepEqual([integ('ok', 'gate files match abc1234 (22 files)').status, integ('ok', 'gate files match abc1234 (22 files)').detail], ['ok', 'enforce · gate files match abc1234 (22 files)']);
  assert.deepEqual([integ('down', 'gate files differ from abc1234: src/gates.mjs').status, integ('down', 'gate files differ from abc1234: src/gates.mjs').detail], ['failed', 'gate files differ from abc1234: src/gates.mjs · enforce']);
  assert.equal(integ('warn', 'gate files are behind by 1 commit (4 min)').status, 'warn');
  assert.equal(integ('unknown', 'gate files not checked: the remote head has not been read').status, 'ok', 'a check that cannot run is said, not coloured');
  assert.equal(gateCard({ status: 'warn', detail: '1 waiting', integrity: { status: 'ok', detail: 'x' }, at: now }, now).status, 'warn');
  assert.equal(gateCard({ status: 'ok', detail: 'enforce', integrity: { status: 'down', detail: 'x' }, at: now - 11 * 60e3 }, now).status, 'stale');
  assert.equal(gateCard({ status: 'failed', detail: 'policy invalid (x)', at: now }, now).status, 'failed');
  assert.equal(gateCard({ status: 'ok', detail: '', at: now - 11 * 60e3 }, now).status, 'stale');
});

test('a light install that never installed the gate has no guardrails card and no cmux card; every other install is unchanged', () => {
  const now = 1e12;
  const light = { installedAt: 1, mode: 'light', steps: {}, answers: {} };
  const missing = { status: 'failed', detail: 'enforce · hook: claude MISSING · receipts: 1 chained', pending: 0, hook: false, at: now };
  assert.equal(gateCard(missing, now, light), null, 'light, no hook, nothing waiting: no card');
  // every other install reads as before: no state file, a full install's state file, a card written before the field existed
  assert.equal(gateCard(missing, now).status, 'warn');
  assert.equal(gateCard(missing, now, null).status, 'warn');
  assert.equal(gateCard(missing, now, { installedAt: 1, steps: {}, answers: {} }).status, 'warn', 'a full install');
  const { hook, ...older } = missing;
  assert.equal(gateCard(older, now, light).status, 'warn', 'a card file without the hook field is not hidden');
  // on a light install the card is back as soon as there is something to say
  assert.equal(gateCard({ ...missing, hook: true, status: 'ok', detail: 'enforce · hook: claude on' }, now, light).status, 'ok', 'the hook is registered');
  assert.equal(gateCard({ ...missing, pending: 1 }, now, light).status, 'warn', 'a gate waits');
  assert.equal(gateCard({ ...missing, gates: 2 }, now, light).status, 'warn', 'a live task holds a gate, decided or not');
  // a LOST hook is never hidden: once the gate was seen here the state file carries the mark, and the card reads MISSING
  const seen = { ...light, guardrailsSeen: now - 5 };
  const lost = gateCard(missing, now, seen);
  assert.equal(lost.status, 'warn'); assert.match(lost.detail, /hook: claude MISSING/);
  // after the full install the state file no longer says light: the card of a full board
  assert.equal(gateCard(missing, now, { ...light, mode: 'full' }).status, 'warn');
  assert.equal(showsBridgeCard({ ...light, mode: 'full' }, false), true);
  assert.equal(gateCard({ ...missing, detail: 'policy invalid (x) · hook: claude MISSING' }, now, light).status, 'failed', 'a broken rules file');
  assert.equal(gateCard({ ...missing, integrity: { status: 'down', detail: 'a gate file changed' } }, now, light).status, 'failed', 'the integrity check is red');
  assert.equal(gateCard({ ...missing, at: now - 11 * 60e3, hook: true }, now, light).status, 'stale');
  // the cmux card: left out only on a light install with no cmux
  assert.equal(showsBridgeCard(light, false), false);
  assert.equal(showsBridgeCard(light, true), true, 'cmux is there: the card says how the socket is');
  assert.equal(showsBridgeCard(null, false), true, 'a full or hand-built board without cmux keeps its amber card');
  assert.equal(showsBridgeCard({ installedAt: 1, steps: {} }, false), true);
});

test('light, hook registered, hook removed: the mark is written once and the card is back, amber; the full install ends light', async () => {
  const { noteGuardrailsSeen, leaveLight, readState, writeState } = await import('../src/setup.mjs');
  const { installKind } = await import('../scripts/upgrade.mjs');
  const now = 1e12;
  const root = mkdtempSync(path.join(os.tmpdir(), 'light mark-'));
  mkdirSync(path.join(root, 'data')); mkdirSync(path.join(root, 'overlay/config'), { recursive: true });
  const file = path.join(root, 'data/setup-state.json');
  const missing = { status: 'failed', detail: 'enforce · hook: claude MISSING', pending: 0, hook: false, gates: 0, at: now };
  // no state file (a full or hand-built board): nothing is written, ever
  assert.equal(await noteGuardrailsSeen(file), false); assert.equal(existsSync(file), false);
  await writeState({ installedAt: 1, mode: 'light', steps: {}, answers: {} }, file);
  assert.equal(gateCard(missing, now, await readState(file)), null, '1. light, never installed: no card');
  // 2. the owner installs Guardrails: the board sees the hook and marks the state file, once
  assert.equal(await noteGuardrailsSeen(file), true);
  const marked = await readState(file);
  assert.ok(marked.guardrailsSeen > 0); assert.equal(marked.mode, 'light');
  assert.equal(await noteGuardrailsSeen(file), false, 'written once');
  assert.deepEqual(await readState(file), marked);
  assert.equal(gateCard({ ...missing, hook: true, status: 'ok', detail: 'enforce · hook: claude on' }, now, marked).status, 'ok');
  // 3. the hook is lost (an uninstall, a settings file written over): the card is there and amber
  const back = gateCard(missing, now, await readState(file));
  assert.equal(back.status, 'warn'); assert.match(back.detail, /hook: claude MISSING/);
  // the full install on top of the light one: the state stops saying light, the kind is full, the cards a full board's
  assert.equal(await installKind(root, path.join(root, 'overlay')), 'light');
  assert.equal(await leaveLight(file), true);
  const full = await readState(file);
  assert.equal(full.mode, 'full'); assert.ok(full.fullAt > 0); assert.equal(full.guardrailsSeen, marked.guardrailsSeen, 'nothing else is lost');
  assert.equal(await leaveLight(file), false, 'once');
  assert.equal(await installKind(root, path.join(root, 'overlay')), 'full', 'an upgrade runs the bootstrap again');
  assert.equal(gateCard(missing, now, { installedAt: 1, mode: 'full', steps: {} }).status, 'warn');
  assert.equal(showsBridgeCard(full, false), true);
  // a state file of a full install is never touched by either
  await writeState({ installedAt: 1, steps: {}, answers: {} }, file);
  assert.equal(await noteGuardrailsSeen(file), false); assert.equal(await leaveLight(file), false);
  assert.deepEqual(await readState(file), { installedAt: 1, steps: {}, answers: {} });
  // the full install's steps mark it: bootstrap.sh calls leaveLight, and plans it in a dry run
  const sh = readFileSync(path.join(ROOT, 'scripts/bootstrap.sh'), 'utf8');
  assert.match(sh, /m\.leaveLight\(\)/); assert.match(sh, /step would "data\/setup-state\.json: mode light → full/);
  rmSync(root, { recursive: true, force: true });
});

test('the Guardrails-only profile drops the example entries only in a local.json it creates', async () => {
  const { setProfile } = await import('../scripts/guardrails-profile.mjs');
  const fresh = mkdtempSync(path.join(os.tmpdir(), 'profile new-'));
  mkdirSync(path.join(fresh, 'config'));
  writeFileSync(path.join(fresh, 'policy.json'), JSON.stringify({ mode: 'enforce', classes: [] }));
  const dry = await setProfile({ overlay: fresh, apply: false });
  assert.match(dry[0].change, /dropExamples: true/); assert.equal(existsSync(path.join(fresh, 'config/local.json')), false, 'a dry run writes nothing');
  await setProfile({ overlay: fresh, apply: true });
  assert.deepEqual(JSON.parse(readFileSync(path.join(fresh, 'config/local.json'), 'utf8')), { settings: { profile: 'guardrails' }, dropExamples: true });
  // a file that exists is the owner's: the profile is set, nothing else is added or removed
  const own = mkdtempSync(path.join(os.tmpdir(), 'profile own-'));
  mkdirSync(path.join(own, 'config'));
  writeFileSync(path.join(own, 'policy.json'), JSON.stringify({ mode: 'enforce', classes: [] }));
  writeFileSync(path.join(own, 'config/local.json'), JSON.stringify({ jobs: [{ label: 'com.acme.sync' }] }));
  const res = await setProfile({ overlay: own, apply: true });
  assert.doesNotMatch(res[0].change, /dropExamples/);
  assert.deepEqual(JSON.parse(readFileSync(path.join(own, 'config/local.json'), 'utf8')), { jobs: [{ label: 'com.acme.sync' }], settings: { profile: 'guardrails' } });
  rmSync(fresh, { recursive: true, force: true }); rmSync(own, { recursive: true, force: true });
});
