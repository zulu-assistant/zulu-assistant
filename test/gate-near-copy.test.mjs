// node --test "test/*.test.mjs" — a new row that nearly repeats a row on the same task carries a note: "near copy of gK".
// Seen in a week of rows: a script's write form run again with `cd <repo> &&` in front after the plain form had run,
// and the same text again after its approval had been used. A warning only: the call is judged, held and filed
// exactly as without a match; nothing is released, no row is merged.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService, denyText, nearKey, nearCopyOf, NEAR_COPY_TEXT, NEAR_COPY_HOURS, dropNearTail } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { OWNER } from '../src/config.mjs';

const A = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const policy = { ...structuredClone(DEFAULT_POLICY), defaultMode: 'enforce', observeFor: [], checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };

async function setup() {
  const dir = realpathSync(await mkdtemp(path.join(os.tmpdir(), 'near-copy-')));
  const work = path.join(dir, 'work');
  await mkdir(work, { recursive: true });
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => (ws === 'WS-1' ? 'worker-a' : null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true,
    prInfo: async () => ({ number: 7, title: 'Add the thing', head: 'feature-x', base: 'main', headOid: A, repo: 'acme/app' }),
    git: (cwd, args) => (args[0] === 'rev-parse' ? 'main' : args[0] === 'remote' ? 'git@github.com:acme/app.git' : null) });
  // a registered agent with one live task: every row of the test lands on it
  await ledger.create({ title: 'Land the thing', requester: 'coordinator', owner: 'worker-a', priority: 'normal' });
  const pre = (command) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: work, workspaceId: 'WS-1' });
  const gate = async (d) => ((await ledger.get(d.task))?.gates || []).find((x) => x.id === d.gate);
  return { work, svc, ledger, pre, gate };
}
const MERGE = `gh pr merge 7 --squash -R acme/app --match-head-commit ${A}`;
// what the filed row holds, apart from its id, time and the note itself
// (cmdHash covers the call's folder, which is another temp folder in the second setup; prev_status is set by a task's
// first row only)
const shape = (g) => { const { id, requested_at, nearCopy, cmdHash, prev_status, ...rest } = g; return rest; };

test('a near copy of a waiting row: filed as without a match, with the note on the row and in the agent text', async () => {
  const s = await setup();
  const first = await s.pre(MERGE);
  assert.equal(first.decision, 'deny');
  const g1 = await s.gate(first);
  assert.equal(g1.nearCopy, undefined);
  // the same merge with `cd <its own folder> &&` in front and other quotes: another fingerprint, so a second row
  const again = await s.pre(`cd "${s.work}" && gh pr merge 7 --squash -R 'acme/app' --match-head-commit ${A}`);
  assert.equal(again.decision, 'deny'); assert.equal(again.task, first.task); assert.notEqual(again.gate, first.gate);
  const g2 = await s.gate(again);
  assert.deepEqual(g2.nearCopy, { of: g1.id, status: 'pending', at: g1.requested_at });
  assert.equal(g2.status, 'pending');
  assert.equal(again.reason, `${denyText.pending(again.task, g2, { noWake: false })} ${NEAR_COPY_TEXT.pending(again.task, g1.id)}`);

  // the same second call on a task without the first row: the same verdict, and the same row but for the note
  const t = await setup();
  const alone = await t.pre(`cd "${t.work}" && gh pr merge 7 --squash -R 'acme/app' --match-head-commit ${A}`);
  assert.equal(alone.decision, again.decision);
  const ga = await t.gate(alone);
  assert.equal(ga.nearCopy, undefined);
  const norm = (g, work) => JSON.parse(JSON.stringify(shape(g)).split(work).join('<work>'));
  assert.deepEqual(norm(ga, t.work), norm(g2, s.work));
  assert.equal(alone.reason, denyText.pending(alone.task, ga, { noWake: false }));
});

test('not a near copy: another PR, another repo, another folder, another class', async () => {
  const s = await setup();
  const first = await s.pre(MERGE);
  for (const cmd of [
    `gh pr merge 8 --squash -R acme/app --match-head-commit ${A}`,
    `gh pr merge 7 --squash -R acme/other --match-head-commit ${A}`,
    `cd /srv/elsewhere && gh pr merge 7 --squash -R acme/app --match-head-commit ${A}`,
  ]) {
    const d = await s.pre(cmd);
    assert.equal(d.decision, 'deny', cmd);
    const g = await s.gate(d);
    assert.equal(g.nearCopy, undefined, cmd);
    assert.doesNotMatch(d.reason, /nearly matches/, cmd);
  }
  assert.ok(first.gate);
});

test('nearKey and nearCopyOf: the shapes that match, the window, the statuses', () => {
  const cwd = '/w/repo';
  assert.equal(nearKey(`cd "${cwd}" && node scripts/x.mjs --commit`, cwd), 'node scripts/x.mjs --commit');
  assert.equal(nearKey(`cd ${cwd}/ && node  scripts/x.mjs   --commit`, cwd), 'node scripts/x.mjs --commit');
  assert.equal(nearKey('cd /other && node scripts/x.mjs --commit', cwd), 'cd /other && node scripts/x.mjs --commit');
  // quotes around one plain word go; a quoted string with a space keeps its quotes (Codex review of e921d78)
  assert.equal(nearKey("gh pr merge 7 -R 'acme/app'", cwd), 'gh pr merge 7 -R acme/app');
  assert.notEqual(nearKey("rm -rf 'build cache'", cwd), nearKey('rm -rf build cache', cwd));
  assert.equal(nearKey('rm -rf "build cache"', cwd), nearKey("rm -rf 'build cache'", cwd));
  const now = Date.parse('2026-11-22T12:00:00Z');
  const row = { cls: 'write', command: `cd "${cwd}" && node scripts/x.mjs --commit`, cwd, agent: 'worker-a' };
  const g = (id, status, at, extra = {}) => ({ id, cls: 'write', status, command: 'node scripts/x.mjs --commit', cwd, agent: 'worker-a', requested_at: at, ...extra });
  // released to run without a run receipt: 'executed' with no `ran`; with the receipt: ran
  assert.deepEqual(nearCopyOf([g('g4', 'executed', '2026-11-22T10:00:00Z', { executed_at: '2026-11-22T10:05:00Z' })], row, now), { of: 'g4', status: 'executed', at: '2026-11-22T10:05:00Z' });
  assert.deepEqual(nearCopyOf([g('g4', 'executed', '2026-11-22T10:00:00Z', { executed_at: '2026-11-22T10:05:00Z', ran_at: '2026-11-22T10:05:02Z' })], row, now), { of: 'g4', status: 'executed', at: '2026-11-22T10:05:02Z', ran: true });
  assert.deepEqual(nearCopyOf([g('g4', 'approved', '2026-11-22T10:00:00Z', { decided_at: '2026-11-22T10:01:00Z', expires_at: '2026-11-22T12:01:00Z' })], row, now), { of: 'g4', status: 'approved', at: '2026-11-22T10:01:00Z' });
  // too old, declined, expired, another class: no note
  assert.equal(nearCopyOf([g('g4', 'executed', new Date(now - (NEAR_COPY_HOURS + 1) * 3600e3).toISOString())], row, now), null);
  for (const st of ['declined', 'expired', 'disputed', 'dry_required']) assert.equal(nearCopyOf([g('g4', st, '2026-11-22T10:00:00Z')], row, now), null, st);
  assert.equal(nearCopyOf([{ ...g('g4', 'executed', '2026-11-22T10:00:00Z'), cls: 'merge' }], row, now), null);
  // an approval whose grant has run out, another agent's row, another folder, a withheld command: no note
  assert.equal(nearCopyOf([g('g4', 'approved', '2026-11-22T09:00:00Z', { expires_at: '2026-11-22T11:00:00Z' })], row, now), null);
  assert.equal(nearCopyOf([g('g4', 'pending', '2026-11-22T10:00:00Z', { agent: 'worker-b' })], row, now), null);
  assert.equal(nearCopyOf([g('g4', 'pending', '2026-11-22T10:00:00Z', { cwd: '/w/other' })], { ...row, command: 'node scripts/x.mjs --commit' }, now), null);
  assert.equal(nearCopyOf([g('g4', 'pending', '2026-11-22T10:00:00Z', { commandRedacted: true })], row, now), null);
  assert.equal(nearCopyOf([g('g4', 'pending', '2026-11-22T10:00:00Z')], { ...row, commandRedacted: true }, now), null);
  // the newest match is named
  assert.equal(nearCopyOf([g('g2', 'executed', '2026-11-22T09:00:00Z'), g('g4', 'pending', '2026-11-22T11:00:00Z')], row, now).of, 'g4');
});

test('the owner\'s row: one line naming the earlier gate, board words only', async () => {
  const ctx = {};
  vm.runInNewContext(await readFile(new URL('../public/decide.js', import.meta.url), 'utf8'), { globalThis: ctx });
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = ctx.BoardDecide.nearCopyHtml({ of: 'g4', status: 'executed', at: '2026-11-22T10:05:00Z' }, esc);
  assert.match(html, /near copy of g4 on this task \(it was released to run at 10:05Z\)/);
  assert.match(ctx.BoardDecide.nearCopyHtml({ of: 'g4', status: 'executed', at: '2026-11-22T10:05:02Z', ran: true }, esc), /\(it ran at 10:05Z\)/);
  assert.match(ctx.BoardDecide.nearCopyHtml({ of: 'g2', status: 'approved', at: null }, esc), /you approved it and it has not been used/);
  assert.equal(ctx.BoardDecide.nearCopyHtml({ of: '<b>x</b>', status: 'pending' }, esc), '');
  assert.equal(ctx.BoardDecide.nearCopyHtml({ of: 'g2', status: 'declined' }, esc), '');
  assert.equal(ctx.BoardDecide.nearCopyHtml(null, esc), '');
  const row = ctx.BoardDecide.gateRowHtml({ id: 'g5', cls: 'write', label: 'A guarded script', why: 'w', command: 'node x --commit', agent: 'a', cwd: '/w', tool: 'Bash', status: 'pending', nearCopy: { of: 'g4', status: 'executed', at: '2026-11-22T10:05:00Z' } }, { esc, age: '1m', key: 'k', actions: '' });
  assert.match(row, /near copy of g4/);
});

// ---- #786 C2: a trailing 2>&1 and a trailing pipe into a plain text filter (the note only) ----
test('#786 C2 nearKey drops a trailing 2>&1 and a pipe into grep/tail/head/cat, and nothing else', () => {
  const X = 'node scripts/x.mjs --commit';
  const same = (a, b) => assert.equal(nearKey(a, '/w'), nearKey(b, '/w'), `${a}  ≈  ${b}`);
  const differ = (a, b) => assert.notEqual(nearKey(a, '/w'), nearKey(b, '/w'), `${a}  ≠  ${b}`);
  // the 734 g5 shape, and its friends
  same(`${X} 2>&1 | grep -v ExperimentalWarning`, X);
  same(`${X} 2>&1 | tail -20`, X);
  same(`${X} | head -n 5`, X);
  same(`${X} 2>&1 | grep -E 'ok|fail' | tail -3`, X);
  same(`${X} 2>&1`, X);
  same(`cd /w && ${X} 2>&1 | cat`, X);
  // a filter that writes, or might: a redirect, tee, an output-looking option, a further command
  differ(`${X} | grep ok > out.txt`, X);
  differ(`${X} | tail -5 >> log.txt`, X);
  differ(`${X} | tee out.txt`, X);
  differ(`${X} | grep -o ok`, X);
  differ(`${X} | head --output=x`, X);
  differ(`${X} | grep ok; rm -rf build`, X);
  differ(`${X} | grep ok && sh deploy.sh`, X);
  // a pipe into a shell, an interpreter or another program is never dropped
  differ(`${X} | sh`, X);
  differ(`${X} | bash -s`, X);
  differ(`${X} | node -`, X);
  differ(`${X} | xargs rm`, X);
  differ(`${X} | sort -o out`, X);
  // two commands that differ before the pipe do not match
  differ(`${X} 2>&1 | tail -20`, 'node scripts/y.mjs --commit');
  differ(`node scripts/x.mjs --commit --all | tail -5`, X);
  // a quoted pipe, an escaped one, one inside $( ) or backticks, and || are not pipes
  assert.equal(dropNearTail(`${X} --msg 'a | grep b'`), `${X} --msg 'a | grep b'`);
  assert.equal(dropNearTail(`${X} --msg "a | tail -1"`), `${X} --msg "a | tail -1"`);
  assert.equal(dropNearTail(`${X} a\\| head`), `${X} a\\| head`);
  assert.equal(dropNearTail(`${X} --n "$(echo 1 | head -1)"`), `${X} --n "$(echo 1 | head -1)"`);
  assert.equal(dropNearTail(`${X} --n $(echo 1 | head -1)`), `${X} --n $(echo 1 | head -1)`);
  assert.equal(dropNearTail(`${X} || tail -1`), `${X} || tail -1`);
  assert.equal(dropNearTail(`${X} |& tail -1`), `${X} |& tail -1`);
  // an unclosed quote: nothing is dropped
  assert.equal(dropNearTail(`${X} 'oops | tail -1`), `${X} 'oops | tail -1`);
});

test('#786 C2 through the gate service: the 734 g5 shape gets the note; verdict, hold and filing as without it', async () => {
  const s = await setup();
  const first = await s.pre(MERGE);
  const g1 = await s.gate(first);
  const again = await s.pre(`${MERGE} 2>&1 | grep -v Warning`);
  assert.equal(again.decision, 'deny'); assert.equal(again.task, first.task); assert.notEqual(again.gate, first.gate);
  const g2 = await s.gate(again);
  assert.deepEqual(g2.nearCopy, { of: g1.id, status: 'pending', at: g1.requested_at });
  // the same call on a task without the first row: the same verdict and the same row but for the note
  const t = await setup();
  const alone = await t.pre(`${MERGE} 2>&1 | grep -v Warning`);
  assert.equal(alone.decision, again.decision);
  const ga = await t.gate(alone);
  assert.equal(ga.nearCopy, undefined);
  const noCwd = (g) => { const { cwd, ...rest } = shape(g); return rest; };   // each setup works in its own temp folder
  assert.deepEqual(noCwd(ga), noCwd(g2));
  // a pipe into a shell after the same merge: no note
  const u = await setup();
  await u.pre(MERGE);
  const piped = await u.pre(`${MERGE} | sh`);
  assert.equal((await u.gate(piped)).nearCopy, undefined);
});
