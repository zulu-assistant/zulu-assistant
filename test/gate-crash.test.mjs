// Guardrails crash and restart (#369, from public feedback): an approval must never run twice, even
// when the board dies between spending the grant and writing the receipt. Temp dirs only; the
// "board" here is the gate service itself, and the crash is a real child process exiting mid-call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createLedger } from '../src/tasks.mjs';
import { createGateService, RESTART_NOTE } from '../src/gate-service.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const T0 = Date.parse('2026-01-05T10:00:00Z');
const CMD = 'gh pr merge 7 --merge';

// one "board boot": a service over the dir (same fixtures as gate-ledger.test.mjs)
function boot(dir, { ledger = createLedger(path.join(dir, 'tasks')), t = T0 } = {}) {
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator',
    git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, now: () => t,
  });
  const check = (command = CMD) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1' });
  return { svc, ledger, check };
}

// a task with gate g1 approved (grant minted, unspent)
async function approved() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate crash-'));   // a space, like the live checkout
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(DEFAULT_POLICY));
  const b = boot(dir);
  const task = await b.ledger.create({ title: 'ship it', requester: 'helper', owner: 'builder' });
  await b.ledger.update(task.id, { op: 'start', actor: 'builder' });
  assert.equal((await b.check()).gate, 'g1');
  const r = await b.ledger.update(task.id, { op: 'gate_decide', actor: OWNER.id, gate: 'g1', decision: 'approve' }, { decider: true, now: T0 });
  await b.svc.afterDecision(r.task, 'g1');
  return { dir, id: task.id };
}
const grants = async (dir) => JSON.parse(await readFile(path.join(dir, 'guardrails', 'grants.json'), 'utf8'));

// the child "board": redeems, then dies (exit 9) at the moment it would write the executed receipt
const CHILD = `
import path from 'node:path';
import { createLedger } from ${JSON.stringify(path.join(ROOT, 'src/tasks.mjs'))};
import { createGateService } from ${JSON.stringify(path.join(ROOT, 'src/gate-service.mjs'))};
const dir = process.env.CRASH_DIR;
const real = createLedger(path.join(dir, 'tasks'));
const ledger = new Proxy(real, { get: (o, k) => k === 'update'
  ? (id, patch, ctx) => { if (patch.op === 'gate_event' && patch.event === 'executed') process.exit(9); return o.update(id, patch, ctx); }
  : (typeof o[k] === 'function' ? o[k].bind(o) : o[k]) });
const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'),
  ownerId: process.env.CRASH_OWNER, identifyWs: async (ws) => (ws === 'W1' ? 'builder' : null), home: '/home/u', mcName: async () => 'coordinator',
  git: () => null, isPrivateRepo: async () => null, prInfo: async () => null, now: () => Number(process.env.CRASH_T) });
const r = await svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: process.env.CRASH_CMD, cwd: '/work/app', workspaceId: 'W1' });
console.log('ANSWERED ' + r.decision);   // reaching here means the crash did not happen
`;

test('(a) the board dies after spending the grant, before the receipt: restart never allows the call again', async () => {
  const { dir, id } = await approved();
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    env: { ...process.env, CRASH_DIR: dir, CRASH_OWNER: OWNER.id, CRASH_T: String(T0 + 60e3), CRASH_CMD: CMD }, encoding: 'utf8' });
  assert.equal(child.status, 9, `child should die mid-call: ${child.stderr}${child.stdout}`);
  assert.doesNotMatch(child.stdout, /ANSWERED/, 'the hook never got an answer, so nothing ran');
  const [g] = await grants(dir);
  assert.ok(g.used_at && g.used_at !== 'expired', 'the grant was spent before the crash');
  assert.equal((await createLedger(path.join(dir, 'tasks')).get(id)).gates[0].status, 'approved', 'the receipt was not written');

  // restart: a fresh service over the same files; the startup reconcile writes the missing receipt
  const b = boot(dir, { t: T0 + 2 * 60e3 });
  assert.deepEqual(await b.svc.reconcile(), { checked: 1, repaired: 1 });
  const t = await b.ledger.get(id);
  assert.equal(t.gates[0].status, 'executed');
  assert.equal(t.gates[0].executed_at, g.used_at, 'the receipt carries the time the grant was spent');
  assert.equal(t.gates[0].note, RESTART_NOTE);
  assert.ok(t.comments.some((c) => /GATE g1 released to run once .*recorded after restart; outcome unknown/.test(c.text)));
  assert.match((await b.svc.audit(id)).find((r) => r.gate === 'g1' && r.event.startsWith('released')).via, /outcome unknown/);
  assert.deepEqual(await b.svc.reconcile(), { checked: 1, repaired: 0 }, 'a second start changes nothing');

  const again = await b.check();
  assert.equal(again.decision, 'deny');
  assert.equal(again.gate, 'g2', 'a new gate: the owner is asked again');
  assert.equal((await b.check()).decision, 'deny');
});

test('(b) the normal path, then a restart: the same call is a new gate; reconcile finds nothing', async () => {
  const { dir, id } = await approved();
  const first = boot(dir, { t: T0 + 60e3 });
  assert.equal((await first.check()).decision, 'allow');
  const t = await first.ledger.get(id);
  assert.ok(t.comments.some((c) => /GATE g1 released to run once \S+Z \(single-use grant\) — the agent reports the outcome on this task/.test(c.text)));
  const b = boot(dir, { t: T0 + 2 * 60e3 });
  assert.deepEqual(await b.svc.reconcile(), { checked: 1, repaired: 0 });
  const r = await b.check();
  assert.equal(r.decision, 'deny');
  assert.equal(r.gate, 'g2');
});

test('(b2) a grant that expired unused, then a crash before the receipt: reconcile marks the gate expired', async () => {
  const { dir, id } = await approved();
  const late = boot(dir, { t: T0 + 24 * 3600e3 });          // well past the TTL
  const real = late.ledger.update.bind(late.ledger);
  late.ledger.update = async (tid, patch, ctx) => { if (patch.event === 'expired') throw new Error('crash'); return real(tid, patch, ctx); };
  await late.check().catch(() => {});
  const [g] = await grants(dir);
  assert.equal(g.used_at, 'expired');
  const b = boot(dir, { t: T0 + 25 * 3600e3 });
  assert.deepEqual(await b.svc.reconcile(), { checked: 1, repaired: 1 });
  assert.equal((await b.ledger.get(id)).gates[0].status, 'expired');
});

test('(c) torn or corrupt grant state fails closed: a stray tmp copy is never read, a corrupt file means no grant', async () => {
  // a leftover tmp file holding an UNSPENT copy beside a good, spent grants.json
  const s = await approved();
  const b = boot(s.dir, { t: T0 + 60e3 });
  assert.equal((await b.check()).decision, 'allow');
  const spent = await grants(s.dir);
  await writeFile(path.join(s.dir, 'guardrails', 'grants.json.4242.abcdef.tmp'), JSON.stringify(spent.map((g) => ({ ...g, used_at: null }))));
  assert.equal((await boot(s.dir, { t: T0 + 2 * 60e3 }).check()).decision, 'deny');

  // a corrupt grants.json (a torn write that somehow landed): no grant found, deny + a new gate, no crash
  const c = await approved();
  await writeFile(path.join(c.dir, 'guardrails', 'grants.json'), '[{"id": "half-writ');
  const r = await boot(c.dir, { t: T0 + 60e3 }).check();
  assert.equal(r.decision, 'deny');
  assert.equal(r.gate, 'g2');
});

test('(d) two concurrent attempts at one approved call: exactly one allow', async () => {
  const { dir } = await approved();
  const b = boot(dir, { t: T0 + 60e3 });
  const out = await Promise.all([b.check(), b.check(), b.check()]);
  assert.equal(out.filter((r) => r.decision === 'allow').length, 1, JSON.stringify(out.map((r) => r.decision)));
});
