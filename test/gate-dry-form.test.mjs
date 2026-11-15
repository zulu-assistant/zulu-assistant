import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, copyFile, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createLedger } from '../src/tasks.mjs';
import { createGateService, policyProblems } from '../src/gate-service.mjs';
import { DEFAULT_POLICY, classify } from '../src/gates.mjs';
import { OWNER } from '../src/config.mjs';

// #598: for a write form (`--live`) the gate asked for "the same call without the flag" first. For a script whose
// flagless run still pays (a runner that buys without `--live`; its preview is `--quote`) that is not a dry run.
// The dry form must itself be a call the rules let through, and a script can name its own dry flags (`dryForms`).
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = '/work/app/src/run.mjs';
const PAID = { id: 'paid-script', label: 'Run a script that pays or sends', rules: [{ scriptIn: [RUNNER], unlessFlags: ['--quote'] }] };
const LIVE = 'node src/run.mjs 1001 --live --yes --tier basic';
const QUOTE = 'node src/run.mjs 1001 --yes --tier basic --quote';

// the paid rule goes AFTER the write class: the write form is matched by `write` first, so only the dry-form
// reading keeps it from a hint (in the order the doc advises, see the last test, the paid class holds it outright)
function policyWith({ paid = false, dryForms } = {}) {
  const base = structuredClone(DEFAULT_POLICY);
  return { ...base, classes: [...base.classes, ...(paid ? [PAID] : [])], ...(dryForms ? { dryForms } : {}) };
}

async function setup(opts = {}, stateDir = null) {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'gate-dry-')));
  const ledger = createLedger(path.join(dir, 'tasks'));
  const policy = policyWith(opts);
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: stateDir || path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, now: () => Date.parse('2026-01-05T10:00:00Z'), afterTaskChange: async () => {},
  });
  const check = (command, event = 'pre') => svc.check({ event, engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  const task = await ledger.create({ title: 'order', requester: 'coordinator', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const gates = async () => (await ledger.get(task.id)).gates || [];
  return { svc, ledger, check, task, gates };
}

test('a write form whose flagless form is held too: no dry-form hint, filed as it stands, and the record says no dry run was done', async () => {
  const s = await setup({ paid: true });
  const r = await s.check(LIVE);
  assert.equal(r.decision, 'deny');
  assert.doesNotMatch(r.reason, /dry form/);
  assert.match(r.reason, /waiting on the owner/i);
  const t = await s.ledger.get(s.task.id); const g = t.gates[0];
  assert.equal(g.status, 'pending'); assert.equal(g.cls, 'write');
  assert.match(g.why, /no dry form: the same call without its write flag is held too \(Run a script that pays or sends\)/);
  // the record: a dry run was required, none was asked for, none ran
  assert.deepEqual(g.dryRun, { required: true, seen_at: null, dryHash: null, command: null, notAsked: { cls: 'paid-script', label: 'Run a script that pays or sends' } });
  assert.ok(t.comments.some((c) => /dry run NONE \(not asked: that form is held too, Run a script that pays or sends\)/.test(c.text)), 'the ledger comment');
  // the row, where the dry-run line is
  const ctx = {}; vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: ctx });
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  assert.match(ctx.BoardDecide.gateRowHtml(g, { key: '1:g1', esc, age: '1m', open: false, actions: '' }), /dry run: NONE: not asked, that form is held too \(Run a script that pays or sends\)/);
  // and that flagless form is held as what it is, never recorded as a dry run
  const flagless = await s.check('node src/run.mjs 1001 --yes --tier basic');
  assert.equal(flagless.decision, 'deny');
  assert.equal((await s.gates())[1].cls, 'paid-script');
});

test("a script's own dry flag goes into the hint, and that run counts as the dry run", async () => {
  const s = await setup({ paid: true, dryForms: [{ scriptIn: RUNNER, flags: ['--quote'] }] });
  const r = await s.check(LIVE);
  assert.match(r.reason, /run the dry form first.*node src\/run\.mjs 1001 --yes --tier basic --quote — then/);
  assert.match(r.reason, /Run it only if this script changes nothing in that form/);
  assert.equal((await s.gates())[0].status, 'dry_required');
  assert.deepEqual(await s.check(QUOTE), { decision: 'pass' });
  await s.check(QUOTE, 'post');
  const again = await s.check(LIVE);
  assert.match(again.reason, /waiting on the owner/i);
  const g = (await s.gates()).find((x) => x.status === 'pending');
  assert.ok(g.dryRun.required && g.dryRun.seen_at); assert.equal(g.dryRun.notAsked, undefined);
  assert.match(g.dryRun.command, /--quote$/);
});

test('after a `--` the dry flag is put before it, and a run with the flag after it is not the dry run', async () => {
  const s = await setup({ paid: true, dryForms: [{ scriptIn: RUNNER, flags: ['--quote'] }] });
  const r = await s.check('node src/run.mjs --live --yes -- 1001');
  assert.match(r.reason, /run the dry form first.*: node src\/run\.mjs --yes --quote -- 1001 — then/);
  // the flag after `--`: the script reads it as an argument and pays. The paid rule's freeing flag counts only
  // before `--`, so that call is held as paid, and it is never taken for the dry run
  const after = await s.check('node src/run.mjs --yes -- 1001 --quote');
  assert.equal(after.decision, 'deny'); assert.equal((await s.gates()).at(-1).cls, 'paid-script');
  await s.check('node src/run.mjs --yes -- 1001 --quote', 'post');
  assert.match((await s.check('node src/run.mjs --live --yes -- 1001')).reason, /run the dry form first/);
  await s.check('node src/run.mjs --yes --quote -- 1001'); await s.check('node src/run.mjs --yes --quote -- 1001', 'post');
  assert.match((await s.check('node src/run.mjs --live --yes -- 1001')).reason, /waiting on the owner/i);
  // a dry flag the write call already carries after `--` is an argument there, not present: the hint adds it before
  const s2 = await setup({ paid: true, dryForms: [{ scriptIn: RUNNER, flags: ['--quote'] }] });
  assert.match((await s2.check('node src/run.mjs --live -- 1001 --quote')).reason, /run the dry form first.*: node src\/run\.mjs --quote -- 1001 --quote — then/);
});

test('a freeing flag (unlessFlags) counts only before `--`; a held flag (flagsAny) is still read anywhere', () => {
  const p = policyWith({ paid: true });
  const run = (command) => classify({ tool: 'Bash', command, cwd: '/work/app' }, p, { home: '/home/u' });
  assert.equal(run('node src/run.mjs --quote -- 1001').verdict, 'clear');
  assert.equal(run('node src/run.mjs -- 1001 --quote').cls, 'paid-script');
  assert.equal(run('crontab -l').verdict, 'clear');
  assert.equal(run('crontab -- -l').cls, 'schedule');
  assert.equal(run('python3 scripts/archive.py -- --commit').cls, 'write', 'a write flag after `--` still holds (main reads it too)');
});

test('a dry flag that does not free the call is no dry form either', async () => {
  const s = await setup({ paid: true, dryForms: [{ scriptIn: RUNNER, flags: ['--preview'] }] });
  const r = await s.check(LIVE);
  assert.doesNotMatch(r.reason, /dry form first/);
  const g = (await s.gates())[0];
  assert.match(g.why, /no dry form: the call with --preview and without its write flag is held too/);
  assert.equal(g.dryRun.notAsked.cls, 'paid-script');
});

test('scripts with no dry setting keep the old hint; an entry touches only its own script, found in the folder the call runs in', () => {
  const policy = policyWith({ dryForms: [{ scriptIn: RUNNER, flags: ['--quote'] }] });
  const r = classify({ tool: 'Bash', command: 'python3 scripts/archive.py --commit', cwd: '/work/app' }, policy, { home: '/home/u' });
  assert.equal(r.cls, 'write'); assert.deepEqual(r.dryTokens, ['python3', 'scripts/archive.py']);
  const q = classify({ tool: 'Bash', command: 'cd /work/app && node src/run.mjs 1 --live', cwd: '/elsewhere' }, policy, { home: '/home/u' });
  assert.deepEqual(q.dryTokens, ['node', 'src/run.mjs', '1', '--quote']);
  // an entry naming the script through a list
  const listed = { ...policy, lists: { ...policy.lists, payingScripts: [RUNNER] }, dryForms: [{ scriptIn: '@payingScripts', flags: ['--quote'] }] };
  assert.deepEqual(classify({ tool: 'Bash', command: 'node src/run.mjs 1 --live', cwd: '/work/app' }, listed, { home: '/home/u' }).dryTokens, ['node', 'src/run.mjs', '1', '--quote']);
});

test('the rendered policy names the dry forms only when there are some', async () => {
  const { renderPolicy } = await import('../scripts/policy-render.mjs');
  assert.doesNotMatch(renderPolicy(DEFAULT_POLICY), /Dry forms/);
  assert.match(renderPolicy({ ...DEFAULT_POLICY, dryForms: [{ scriptIn: '**/run.mjs', flags: ['--quote'] }] }), /- a script in \*\*\/run\.mjs: `--quote`/);
});

test('policy validation: dryForms', () => {
  const p = (dryForms, lists) => policyProblems({ ...structuredClone(DEFAULT_POLICY), ...(lists ? { lists: { ...DEFAULT_POLICY.lists, ...lists } } : {}), dryForms });
  assert.deepEqual(p([{ scriptIn: '**/run.mjs', flags: ['--quote'] }]), []);
  assert.deepEqual(p([{ scriptIn: '@guardedScripts', flags: ['--dry-run'] }]), []);
  assert.ok(p({}).some((x) => /dryForms must be a list/.test(x)));
  assert.ok(p([{ scriptIn: 'x.mjs', flags: [] }]).some((x) => /non-empty flags/.test(x)));
  assert.ok(p([{ scriptIn: 'x.mjs', flags: ['quote'] }]).some((x) => /non-empty flags/.test(x)));
  assert.ok(p([{ scriptIn: '@nope', flags: ['--quote'] }]).some((x) => /list @nope is not defined/.test(x)));
  // one string only: a list of globs matched nothing (the rules' scriptIn reads one glob or one @list)
  for (const bad of [['a.mjs', 'b.mjs'], [RUNNER], { glob: 'x' }, 7]) assert.ok(p([{ scriptIn: bad, flags: ['--quote'] }]).some((x) => /scriptIn must be one string/.test(x)), JSON.stringify(bad));
  // a write flag as the dry flag would turn every write form of the script into its own dry run
  for (const f of ['--live', '--commit', '--apply=all']) assert.ok(p([{ scriptIn: 'x.mjs', flags: [f] }]).some((x) => /is a write flag, never a dry one/.test(x)), f);
  // a glob that names every script (refused: one dry flag for every script is never right, and a script that does
  // not know the flag ignores it and runs its flagless form, the very call this guards against)
  for (const g of ['*', '**', '**/*', '~/x/**/*', '**/*.*']) assert.ok(p([{ scriptIn: g, flags: ['--quote'] }]).some((x) => /names every script/.test(x)), g);
  assert.ok(p([{ scriptIn: '@every', flags: ['--quote'] }], { every: ['**/*'] }).some((x) => /names every script/.test(x)));
  assert.deepEqual(p([{ scriptIn: '**/*.mjs', flags: ['--quote'] }]).filter((x) => /every script/.test(x)), [], 'an extension is a name part');
});

// ── the real hook script, with the trigger file the service writes, against a service that answers ──
test('real hook input: the deny names the dry-flag form, that run is recorded through the hook, the next write form is filed; without an entry: filed as it stands', async () => {
  for (const withEntry of [true, false]) {
    // a checkout of the hook whose data/guardrails is the service's own folder, so the hook reads the lines the service writes
    const home = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'gate-dry-hook-')));
    await mkdir(path.join(home, 'scripts')); await mkdir(path.join(home, 'data', 'guardrails'), { recursive: true });
    for (const f of ['gate-hook.sh', 'gate-hook.mjs', 'gate-triggers.default']) await copyFile(path.join(ROOT, 'scripts', f), path.join(home, 'scripts', f));
    await symlink(path.join(ROOT, 'src'), path.join(home, 'src'));
    const s = await setup({ paid: true, ...(withEntry ? { dryForms: [{ scriptIn: RUNNER, flags: ['--quote'] }] } : {}) }, path.join(home, 'data', 'guardrails'));
    const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', async () => { const r = await s.svc.check(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r)); }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const hook = (command, event = 'PreToolUse') => new Promise((resolve) => {
      const c = spawn('sh', [path.join(home, 'scripts', 'gate-hook.sh'), '--env-board'], { env: { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: `http://127.0.0.1:${port}`, GATE_TIMEOUT_MS: '4000', CMUX_WORKSPACE_ID: 'W1', GH_REPO: '' } });
      let out = ''; c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(out ? JSON.parse(out).hookSpecificOutput : { permissionDecision: 'pass' }));
      c.stdin.end(JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/work/app', permission_mode: 'auto', hook_event_name: event, tool_name: 'Bash', tool_input: { command, description: 'an order' }, tool_use_id: 'toolu_1', ...(event === 'PostToolUse' ? { tool_response: { stdout: '' } } : {}) }));
    });
    try {
      const first = await hook(LIVE);
      assert.equal(first.permissionDecision, 'deny');
      if (withEntry) {
        assert.match(first.permissionDecisionReason, /run the dry form first.*--tier basic --quote — then/);
        assert.equal((await hook(QUOTE)).permissionDecision, 'pass', 'the quote run is free');
        await hook(QUOTE, 'PostToolUse');
        const second = await hook(LIVE);
        assert.match(second.permissionDecisionReason, /waiting on the owner/i);
        const g = (await s.gates()).find((x) => x.status === 'pending');
        assert.ok(g.dryRun.seen_at, 'the dry run was recorded through the hook');
      } else {
        assert.doesNotMatch(first.permissionDecisionReason, /dry form/);
        assert.match(first.permissionDecisionReason, /waiting on the owner/i);
        const g = (await s.gates())[0];
        assert.equal(g.status, 'pending'); assert.equal(g.dryRun.notAsked.cls, 'paid-script');
      }
    } finally { server.close(); }
  }
});

// Pins the advice in docs/GUARDRAILS.md (it passes on main too, by design): a paying script's rule in a class that
// comes before `write`, with its preview flag on unlessFlags, holds the write form outright with no dry form, holds
// the flagless form, and frees only the preview. If the class order or the rule reading changes, the doc is wrong.
test('the advised placement: a paying script in deploy (before write) holds every run without its preview flag, with no dry form', () => {
  const base = structuredClone(DEFAULT_POLICY);
  base.classes.find((c) => c.id === 'deploy').rules.push({ scriptIn: ['~/billing/src/run.mjs'], unlessFlags: ['--quote'] });
  const run = (command) => classify({ tool: 'Bash', command, cwd: '/home/u/billing' }, base, { home: '/home/u' });
  const live = run('node src/run.mjs 1 --live --yes');
  assert.equal(live.cls, 'deploy'); assert.equal(live.requireDryRun, false);
  assert.equal(run('node src/run.mjs 1 --yes').cls, 'deploy');
  assert.equal(run('node src/run.mjs 1 --quote').verdict, 'clear');
});
