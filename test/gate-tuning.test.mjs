import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { classify, compileTriggers, triggerLines, commandCwd, parseCommand, isScratch, cmdHash, HASH_VERSION, DEFAULT_POLICY } from '../src/gates.mjs';
import { ownerPill } from '../src/chrome.mjs';
import { createLedger } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { focusOf } from '../src/gate-ledger.mjs';
import { OWNER } from '../src/config.mjs';

// Post-pilot tuning (#343): help exemption, scratch rm, guarded scripts, owner CLI is self,
// cd / git -C awareness, focus rule, PR subject, hash carry-over, request deadline, sidebar mirror.
const policy = structuredClone(DEFAULT_POLICY);
policy.lists.deployOnPush = ['acme/site'];
policy.lists.guardedScripts = ['~/shop/theme/append.sh'];
const remotes = { '/work/app': 'git@github.com:acme/app.git', '/work/site': 'git@github.com:acme/site.git' };
const ctx = {
  home: '/home/u', boardRoot: '/work/board', tmpdir: '/var/folders/x/T', triggers: compileTriggers(policy),
  repoRoot: (d) => (d.startsWith('/work/app') ? '/work/app' : d.startsWith('/work/site') ? '/work/site' : null),
  git: (cwd, args) => (args[0] === 'remote' ? remotes[cwd] || null : args[0] === 'rev-parse' ? 'feature-x' : null),
};
const run = (command, cwd = '/work/app') => classify({ tool: 'Bash', command, cwd }, policy, ctx);
const gated = (command, cls, cwd) => { const r = run(command, cwd); assert.equal(r.verdict, 'gate', `${command} → ${r.verdict} (${r.why})`); if (cls) assert.equal(r.cls, cls, `${command} → ${r.cls} (${r.why})`); return r; };
const clear = (command, cwd) => { const r = run(command, cwd); assert.equal(r.verdict, 'clear', `${command} → gated ${r.cls}: ${r.why}`); return r; };

test('1: --help / -h / --version on a gated bin is not the action; scripts keep their gate', () => {
  clear('gh pr merge --help'); clear('gh pr merge 5 -h'); clear('git push --help'); clear('vercel --version'); clear('launchctl help');
  clear('crontab -h 2>/dev/null || true');
  gated('gh pr merge 5', 'merge');
  gated('python3 tool.py --commit --help', 'write');            // never for script rules
  gated('$GH pr merge --help', 'opaque');                         // never for opaque
});

test('2: rm -r inside the caller\'s own scratch tree is not a delete; its root and other temp dirs are', () => {
  clear('rm -rf /private/tmp/claude-501/proj/sess/scratchpad/old');
  clear('W="/private/tmp/claude-501/proj/sess/scratchpad/pr 28 test"; rm -rf "$W"');
  clear('rm -rf /var/folders/x/T/claude-abc/work');
  gated('rm -rf /private/tmp/claude-501', 'delete');              // the root itself
  gated('rm -rf /tmp/other', 'delete');
  gated('W=$HOME/x; rm -rf "$W"', 'delete');                      // not a literal
  assert.ok(isScratch('/tmp/claude-1/a', {}) && !isScratch('/tmp/claude-1', {}));
});

test('6: a script on @guardedScripts gates on every run, except with a dry flag', () => {
  gated('/home/u/shop/theme/append.sh values.csv', 'guarded');
  gated('bash theme/append.sh values.csv', 'guarded', '/home/u/shop');
  gated('cd /home/u/shop && ./theme/append.sh values.csv', 'guarded');
  clear('/home/u/shop/theme/append.sh --dry-run values.csv');
  clear('/home/u/shop/theme/other.sh values.csv');
  assert.ok(triggerLines(policy).some((l) => l.startsWith('append\\.sh')));
});

test('4: the owner CLI decision is class self when an agent runs it', () => {
  gated('scripts/task.sh gate 343 g1 approve', 'self');
  gated('bash scripts/task.sh gate 343 g1 decline "no"', 'self');
  gated('node scripts/mesh-cli.mjs task gate 343 g1 approve', 'self');
  clear('scripts/task.sh comment 343 "the gate held"');
  clear('scripts/task.sh gate-approved 343 g1 "owner said yes in the pane"');   // the server makes this MC-only
});

test('cd and git -C: each command is judged in the folder it runs in; an unresolvable cd decides conservatively', () => {
  gated('cd /elsewhere && rm -rf build', 'delete');              // used to clear (judged inside the repo)
  // outside any git repo there is no working tree: rm -r gates (the home folder used to count as "inside")
  gated('rm -rf Downloads/x', 'delete', '/home/u');
  gated('cd ~ && rm -rf Downloads/x', 'delete');
  clear('rm -rf /private/tmp/claude-501/p/s/old', '/home/u');    // the caller's scratch space stays free anywhere
  clear('cd sub && rm -rf build');                                // still inside the repo
  clear('(cd /elsewhere && make) && rm -rf build');               // a subshell's cd stays inside it
  gated('cd "$X" && rm -rf build', 'delete');
  gated('cd "$X" && git push origin feature-x', 'push');
  gated('git -C /work/site push origin feature-x', 'push');       // deploy-on-push repo found through -C
  gated('cd /work/site && git push origin feature-x', 'push');
  clear('git -C /work/app push origin feature-x');
  const p = parseCommand('cd /a && cd b; echo x');
  assert.equal(commandCwd(p.cmds[2], '/w', ctx).cwd, '/a/b');
  assert.equal(commandCwd({ bin: 'git', tokens: ['git', '-C', '../x', 'push'], cdTargets: [] }, '/w/r', ctx).cwd, '/w/x');
});

test('readers: read-only tools on a guarded config are free; their writing forms still gate (#335 g1 FP)', () => {
  clear('sed -n 1,5p ~/.claude/settings.json');
  clear('stat ~/.claude/settings.json && awk "/hooks/" ~/.claude/settings.json | sort | uniq -c');
  clear('cut -c1-80 ~/.claude/settings.json | nl | column -t; xxd ~/.claude/settings.json | head; du -h ~/.claude/settings.json');
  clear('find ~/.claude -name settings.json');
  gated('sed -i "" "s/x/y/" ~/.claude/settings.json', 'self');
  gated('sed --in-place=.bak s/x/y/ ~/.claude/settings.json', 'self');
  gated('find ~/.claude -name settings.json -delete', 'delete');     // names the file by pattern: judged like rm -r
  gated('find ~/.claude -name settings.json -exec rm {} ;', 'delete');
  clear('find build -name "*.tmp" -delete');                          // inside the repo, like rm -rf build
  clear('find . -name "*.pyc" -delete');                              // repo root, filtered
  gated('find . -delete', 'delete');                                  // repo root, unfiltered = rm -r .
  gated('find . -name x -exec gh pr merge 5 ;', 'opaque');           // -exec running a gated action
  gated('sort -o ~/.claude/settings.json ~/.claude/settings.json', 'self');
  gated('cat x > ~/.claude/settings.json', 'self');                // a redirect target always counts
});

test('3: gates waiting lead the sidebar progress label (the custom sidebar reads only progress)', () => {
  const t = { id: 7, status: 'needs_approval', checklist: { a: true, b: false }, gates: [{ status: 'pending' }, { status: 'pending' }, { status: 'executed' }] };
  assert.match(ownerPill([t]).progress.label, /^⛨ 2 GATES · #7 /);
  assert.doesNotMatch(ownerPill([{ ...t, gates: [] }]).progress.label, /GATE/);
});

async function service(over = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate tuning-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  let t = Date.parse('2026-01-05T10:00:00Z');
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async () => 'builder', git: () => null, home: '/home/u', now: () => t, prInfo: over.prInfo || (async () => null) });
  const check = (command, extra = {}) => svc.check({ event: 'pre', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  return { dir, ledger, svc, check, tick: (ms) => { t += ms; }, now: () => t };
}

test('focus: claim/start never override a focus the agent set on a live task; they do once it closes', async () => {
  const s = await service();
  const a = await s.ledger.create({ title: 'a', requester: 'helper', owner: 'builder' });
  const b = await s.ledger.create({ title: 'b', requester: 'helper', owner: 'builder' });
  await s.svc.setFocus('builder', a.id);
  assert.equal(await s.svc.autoFocus('builder', b.id), false);
  assert.equal(focusOf(await s.svc.store.focus(), 'builder').task, a.id);
  await s.ledger.update(a.id, { op: 'cancel', actor: 'helper' });
  assert.equal(await s.svc.autoFocus('builder', b.id), true);
  assert.deepEqual(focusOf(await s.svc.store.focus(), 'builder'), { task: b.id, explicit: false });
  assert.deepEqual(focusOf({ x: 9 }, 'x'), { task: 9, explicit: false });          // older entries
});

test('a merge gate names its PR (title, branches, repo)', async () => {
  const s = await service({ prInfo: async () => ({ number: 45, title: 'gate probe', head: 'gate-probe-head', base: 'gate-probe-base', repo: 'acme/app' }) });
  await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  const r = await s.check('gh pr merge 45 --merge');
  const g = (await s.ledger.get(r.task)).gates[0];
  assert.match(g.why, /PR #45 "gate probe" \(gate-probe-head → gate-probe-base\) · acme\/app/);
  assert.equal(g.hashVersion, HASH_VERSION);
});

test('an approval of a gate filed under an older fingerprint version still runs that exact command', async () => {
  const s = await service();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await s.ledger.update(task.id, { op: 'start', actor: 'builder' });
  // a gate as an older board filed it: v1 hash, no hashVersion
  await s.ledger.update(task.id, { op: 'gate_request', actor: 'board', gate: { cls: 'merge', label: 'Merge', command: 'gh pr merge 9', cwd: '/work/app', tool: 'Bash', agent: 'builder', cmdHash: 'old-v1-hash' } }, { gateSystem: true });
  const d = await s.ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' }, { decider: true, now: s.now() });
  await s.svc.afterDecision(d.task, 'g1');
  assert.equal((await s.check('gh pr merge 9')).decision, 'allow');
  assert.notEqual(cmdHash({ cwd: '/work/app', command: 'gh pr merge 9' }), 'old-v1-hash');
});

test('a request served after the hook\'s deadline is dropped: no gate is filed', async () => {
  const s = await service();
  const task = await s.ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  const r = await s.check('gh pr merge 3', { deadline: s.now() - 1 });
  assert.equal(r.decision, 'deny'); assert.equal(r.stale, true);
  assert.equal((await s.ledger.get(task.id)).gates, undefined);
  assert.equal((await s.check('gh pr merge 3', { deadline: s.now() + 5000 })).decision, 'deny');
  assert.equal((await s.ledger.get(task.id)).gates.length, 1);
});
