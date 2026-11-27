// node --test "test/*.test.mjs" — the refusal of an avoidable `opaque` row says what the agent can do instead.
// Seen in a week of rows: heredoc programs that only rewrote a source file, and messages held in a shell variable whose
// text held a gated word, each a row the owner had to see. Text only: the call is still held, the row is still filed,
// every other refusal is unchanged.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService, denyText, opaqueHint, OPAQUE_HINTS } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const policy = { ...structuredClone(DEFAULT_POLICY), defaultMode: 'enforce', observeFor: [], checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

async function setup() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'refusal-hints-')));
  const work = path.join(dir, 'work');
  await mkdir(work, { recursive: true });
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async () => null, home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true,
    prInfo: async () => ({ number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: A, repo: 'acme/app' }),
    git: (cwd, args) => (args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : null) });
  const gatesOf = async (id) => (await ledger.get(id))?.gates || [];
  return { work, svc, gatesOf };
}

const HEREDOC = "python3 - <<'EOF'\np='src/app.ts'\ns=open(p).read()\ns=s.replace('a','b')  # then gh pr merge 7\nopen(p,'w').write(s)\nEOF";
const MESSAGE = 'M="head abc1234, not pushed; I push after your read" && echo "$M" | wc -c';
const pre = (s, command) => s.svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: s.work, identity: 'dispatch' });

test('a heredoc program that mentions a gated action: held, filed, and told to use the edit tool', async () => {
  const s = await setup();
  const d = await pre(s, HEREDOC);
  assert.equal(d.decision, 'deny'); assert.ok(d.task && d.gate, d.reason);
  const g = (await s.gatesOf(d.task)).find((x) => x.id === d.gate);
  assert.equal(g.cls, 'opaque'); assert.equal(g.status, 'pending');
  assert.equal(d.reason, `${denyText.pending(d.task, g, { noWake: true })} ${OPAQUE_HINTS.program(d.task, g.id)}`);
  assert.match(d.reason, /the Edit or Write tool/); assert.match(d.reason, /a guarded file is held there too/);
  assert.doesNotMatch(d.reason, /apply_patch|Codex/);
  // #786 B: the hint names the withdraw step for this very row
  assert.match(d.reason, new RegExp(`withdraw this row: task\\.sh withdraw ${d.task} ${g.id} '<why it is not needed>'`));
  // the same call again: still waiting, the same hint, no second row
  const again = await pre(s, HEREDOC);
  assert.equal(again.decision, 'deny'); assert.equal(again.gate, d.gate);
  assert.ok(again.reason.endsWith(OPAQUE_HINTS.program(d.task, g.id)), again.reason);
  assert.equal((await s.gatesOf(d.task)).length, 1);
});

test('a gated word the parser cannot place (a message in a variable): held, filed, and told to send it literally', async () => {
  const s = await setup();
  const d = await pre(s, MESSAGE);
  assert.equal(d.decision, 'deny'); assert.ok(d.gate, d.reason);
  const g = (await s.gatesOf(d.task)).find((x) => x.id === d.gate);
  assert.equal(g.cls, 'opaque'); assert.match(g.why, /could not attribute/);
  assert.equal(d.reason, `${denyText.pending(d.task, g, { noWake: true })} ${OPAQUE_HINTS.message(d.task, g.id)}`);
  assert.match(d.reason, /in single quotes instead, with no apostrophe inside/); assert.match(d.reason, /--task <its task>\)/);
});

test('other rows get no hint: their text is byte-for-byte what it was', async () => {
  const s = await setup();
  const d = await pre(s, `gh pr merge 7 --squash -R acme/app --match-head-commit ${A}`);
  assert.equal(d.decision, 'deny');
  const g = (await s.gatesOf(d.task)).find((x) => x.id === d.gate);
  assert.equal(g.cls, 'merge');
  assert.equal(d.reason, denyText.pending(d.task, g, { noWake: true }));
});

test('opaqueHint: only the two opaque reasons; a program inside a guarded folder and any other class get nothing', () => {
  const o = (why, cls = 'opaque') => opaqueHint(5, { id: 'g2', cls, why });
  assert.equal(o('python3 program from a heredoc mentions a gated action'), ` ${OPAQUE_HINTS.program(5, 'g2')}`);
  assert.equal(o('node program passed on the command line mentions a gated action'), ` ${OPAQUE_HINTS.program(5, 'g2')}`);
  assert.equal(o('a gated pattern the parser could not attribute (push)'), ` ${OPAQUE_HINTS.message(5, 'g2')}`);
  assert.equal(o('python3 program from a heredoc runs inside a guarded folder'), '');
  assert.equal(o('node program passed on the command line runs inside a guarded folder'), '');
  assert.equal(o('eval runs a command the gate cannot read'), '');
  assert.equal(o('python3 program from a heredoc mentions a gated action', 'self'), '');
  // a Codex patch is not read for the file it touches, so a Codex session is not pointed at its edit tool
  assert.equal(opaqueHint(5, { id: 'g2', cls: 'opaque', why: 'python3 program from a heredoc mentions a gated action' }, 'codex'), '');
  assert.equal(opaqueHint(5, { id: 'g2', cls: 'opaque', why: 'a gated pattern the parser could not attribute (push)' }, 'codex'), ` ${OPAQUE_HINTS.message(5, 'g2')}`);
  assert.equal(opaqueHint(5, null), '');
});
