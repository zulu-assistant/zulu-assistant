// node --test "test/*.test.mjs" — #674: a call refused and not filed leaves no task behind.
// A caller with no live task (a headless run, a session nobody registered) gets a task made for its gate. That task was
// made before the last unfiled refusal (a Codex merge with no pin of its own), so the 627 live check left an empty
// task with no gate and no comment for Mission Control. Now the task is made only after every unfiled refusal.
// Adds only: what is held, refused or filed is unchanged.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const policy = { ...structuredClone(DEFAULT_POLICY), defaultMode: 'enforce', observeFor: [], checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

async function setup() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'unfiled-no-task-')));
  const work = path.join(dir, 'work');
  await mkdir(path.join(work, 'scripts'), { recursive: true });
  await writeFile(path.join(work, 'scripts', 'rename.mjs'), 'console.log("reads only")\n');
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async () => null, home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true,
    prInfo: async () => ({ number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: A, repo: 'acme/app' }),
    git: (cwd, args) => (args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : null) });
  const tasks = async () => (await ledger.list({})) || [];
  return { work, svc, tasks };
}

// the three refusals that file nothing, each from a caller with no live task
const REFUSALS = (work) => [
  { name: 'a Codex merge with no pin of its own', input: { engine: 'codex', tool: 'Bash', command: 'gh pr merge 7 --squash -R acme/app', cwd: work, turn: 'T1' }, reason: /--match-head-commit/ },
  { name: 'a Codex call in a folder Codex did not name', input: { engine: 'codex', tool: 'Bash', command: 'node scripts/rename.mjs --commit', cwd: work, folderUnread: true, turn: 'T1' }, reason: /did not name/ },
  { name: 'a call that changes the script it runs', input: { engine: 'claude', tool: 'Bash', command: 'echo "x()" > scripts/rename.mjs && node scripts/rename.mjs --commit', cwd: work }, reason: /also runs it/ },
];
const CALLERS = [{ who: 'a headless run', extra: { identity: 'dispatch' } }, { who: 'an unregistered session', extra: {} }];

for (const c of CALLERS) {
  test(`${c.who} with no live task: a call refused unfiled makes no task`, async () => {
    const s = await setup();
    for (const r of REFUSALS(s.work)) {
      const d = await s.svc.check({ event: 'pre', ...r.input, ...c.extra });
      assert.equal(d.decision, 'deny', r.name); assert.equal(d.unfiled, true, `${r.name}: ${d.reason}`);
      assert.match(d.reason, r.reason, r.name);
      assert.equal(d.task, undefined, r.name);
      assert.deepEqual(await s.tasks(), [], `${r.name}: no task left behind`);
    }
  });

  test(`${c.who} with no live task: a call that is filed still gets its own task, owned by Mission Control`, async () => {
    const s = await setup();
    const d = await s.svc.check({ event: 'pre', engine: 'codex', tool: 'Bash', command: `gh pr merge 7 --squash -R acme/app --match-head-commit ${A}`, cwd: s.work, turn: 'T1', ...c.extra });
    assert.equal(d.decision, 'deny'); assert.equal(d.unfiled, undefined, d.reason); assert.ok(d.task, d.reason);
    const all = await s.tasks();
    assert.equal(all.length, 1);
    assert.equal(all[0].owner, 'coordinator');
    assert.equal(all[0].gates?.length, 1); assert.equal(all[0].gates[0].status, 'pending');
  });
}
