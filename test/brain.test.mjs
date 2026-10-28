// node --test "test/*.test.mjs" — brain autopilot (src/brain.mjs) + the verified close gate
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, utimes, appendFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  routeStale, planStale, projectOf, scanRebuild, recentFailures, parseReposTsv, graphBehind, graphFacts,
  vaultCandidates, vaultCommitOf, judgeClose, verifyClose, brainCard, maybeBrain, GRAPH_GRACE_MS,
} from '../src/brain.mjs';
import { newTask, applyPatch, createLedger, CHECKLIST, MeshError } from '../src/tasks.mjs';

const H = 3600e3;
const agents = [
  { name: 'shop-agent', repo: '/work/shop', status: 'active' },
  { name: 'books-agent', repo: '/work/books', status: 'active' },
  { name: 'nested-agent', repo: '/work/hub/backend', status: 'active' },
  { name: 'gone-agent', repo: '/work/old', status: 'closed' },
];
const row = (o) => ({ project: 'Shop', note: 'Shop/Shop.md', synced: '2026-01-01', latest: '2026-01-20', latestDir: '/work/shop', sources: ['/work/shop'], stale: true, days: 19, ...o });
const report = (rows, date = '2026-01-21') => ({ at: `${date}T13:00:00Z`, date, rows });

test('routeStale: most recently active dir wins, nested repos match, closed agents and no match → fallback', () => {
  assert.equal(routeStale(row(), agents), 'shop-agent');
  // a multi-dir project: the dir with the newest activity decides, not the first listed
  assert.equal(routeStale(row({ sources: ['/work/shop', '/work/books'], latestDir: '/work/books' }), agents), 'books-agent');
  assert.equal(routeStale(row({ sources: ['/work/hub'], latestDir: '/work/hub' }), agents), 'nested-agent');
  assert.equal(routeStale(row({ sources: ['/work/old'], latestDir: '/work/old' }), agents, 'mc'), 'mc');
  assert.equal(routeStale(row({ sources: ['/elsewhere'], latestDir: '/elsewhere' }), agents, 'mc'), 'mc');
});

test('planStale: one task per project; a newer report comments instead of re-filing; closed-since is not re-filed', () => {
  const opts = { agents, requester: 'mc', fallback: 'mc' };
  const acts = planStale(report([row(), row({ project: 'Books', note: 'Books/Books.md', latestDir: '/work/books', sources: ['/work/books'] }), row({ project: 'Fine', stale: false })]), [], {}, opts);
  assert.deepEqual(acts.map((a) => [a.kind, a.project, a.input.owner, a.input.priority]), [['create', 'Shop', 'shop-agent', 'low'], ['create', 'Books', 'books-agent', 'low']]);
  assert.match(acts[0].input.body, /--vault "Shop\/Shop.md"/);
  assert.equal(projectOf({ source: acts[0].input.source }), 'Shop');

  // the same report again with the task live: nothing (it was filed from this report)
  const live = { ...newTask(acts[0].input, { id: 7, now: Date.parse('2026-01-21T14:00:00Z') }), status: 'claimed' };
  assert.deepEqual(planStale(report([row()]), [live], { noted: { Shop: '2026-01-21' } }, opts), []);
  // next week's report: ONE comment on the live task, keyed on the project
  const next = planStale(report([row({ days: 26 })], '2026-01-28'), [live], { noted: { Shop: '2026-01-21' } }, opts);
  assert.deepEqual(next.map((a) => [a.kind, a.id]), [['comment', 7]]);
  assert.match(next[0].text, /still stale in the 2026-01-28/);
  assert.deepEqual(planStale(report([row()], '2026-01-28'), [live], { noted: { Shop: '2026-01-28' } }, opts), [], 'once per report date');

  // closed after the report was written: handled, wait for the next report
  const done = { ...live, status: 'done', closed_at: '2026-01-22T09:00:00Z' };
  assert.deepEqual(planStale(report([row()]), [done], {}, opts), []);
  // still stale in a LATER report after that close → a new task
  assert.equal(planStale(report([row()], '2026-01-28'), [done], {}, opts)[0].kind, 'create');
  // fresh again while the task is live → one comment
  const fresh = planStale(report([row({ stale: false })], '2026-01-28'), [live], {}, opts);
  assert.match(fresh[0].text, /fresh in the 2026-01-28/);
  assert.deepEqual(planStale(null, [], {}, opts), []);
});

test('scanRebuild: first look only sets the cursor; new failures are stamped; truncation restarts; 24h window', () => {
  let st = scanRebuild({}, { size: 500, now: 0 });
  assert.equal(st.cursor, 500);
  assert.deepEqual(st.failures, [], 'old failures stay quiet');
  st = scanRebuild(st, { size: 600, text: 'ok\n[graphify watch] Rebuild failed: graphify rebuild exceeded 600s\n', now: 10 * H });
  assert.equal(st.failures.length, 1);
  assert.equal(st.failures[0].why, 'graphify rebuild exceeded 600s');
  assert.equal(recentFailures(st, 20 * H).length, 1);
  assert.equal(recentFailures(st, 35 * H).length, 0);
  assert.equal(scanRebuild({ cursor: 900, failures: [] }, { size: 100, text: '', now: 0 }).cursor, 0, 'a shrunk log restarts');
});

test('parseReposTsv + graphBehind', () => {
  assert.deepEqual(parseReposTsv('a\t/x/a\n# skip\t/y\n\nb\t/x/b sp\n'), [{ tag: 'a', dir: '/x/a' }, { tag: 'b', dir: '/x/b sp' }]);
  const now = 10 * H;
  assert.equal(graphBehind({ graphAt: 5 * H, commitAt: 4 * H, now }), false);
  assert.equal(graphBehind({ graphAt: 4 * H, commitAt: 5 * H, now }), true);
  assert.equal(graphBehind({ graphAt: 4 * H, commitAt: now - GRAPH_GRACE_MS / 2, now }), false, 'hook still running');
  assert.equal(graphBehind({ graphAt: 0, commitAt: 0, now }), false);
});

async function gitRepo(dir, { hook = false } = {}) {
  await mkdir(dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  g('init', '-q');
  g('config', 'core.hooksPath', '.git/hooks');      // never the developer's global hooks
  await writeFile(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
  g('add', '.'); g('commit', '-q', '--no-verify', '-m', 'one');
  if (hook) { await mkdir(path.join(dir, '.git', 'hooks'), { recursive: true }); await writeFile(path.join(dir, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# graphify-hook-start\n'); }
  return g;
}

test('graphFacts: graph vs last non-graph commit, manifest re-stamp counts, hook detection', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'brain-')), 'r');
  await gitRepo(dir, { hook: true });
  const commitAt = Number(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct'])) * 1000;
  const later = commitAt + 2 * H;
  let f = await graphFacts(dir, { now: later });
  assert.equal(f.graphAt, 0);
  assert.equal(f.hook, true);
  assert.equal(f.behind, true, 'no graph two hours after a commit');
  await mkdir(path.join(dir, 'graphify-out'));
  await writeFile(path.join(dir, 'graphify-out', 'graph.json'), '{}');
  await writeFile(path.join(dir, 'graphify-out', 'manifest.json'), '{}');
  const old = new Date(commitAt - H);
  await utimes(path.join(dir, 'graphify-out', 'graph.json'), old, old);
  await utimes(path.join(dir, 'graphify-out', 'manifest.json'), old, old);
  assert.equal((await graphFacts(dir, { now: later })).behind, true);
  // a same-topology rebuild re-stamps manifest.json only — that is "current"
  const fresh = new Date(commitAt + H);
  await utimes(path.join(dir, 'graphify-out', 'manifest.json'), fresh, fresh);
  f = await graphFacts(dir, { now: later });
  assert.equal(f.behind, false);
});

test('graphFacts: a docs-only commit (root + nested .md, .txt) never puts the graph behind (#286)', async () => {
  const dir = path.join(await mkdtemp(path.join(os.tmpdir(), 'brain-')), 'r');
  await gitRepo(dir, { hook: true });
  const codeAt = Number(execFileSync('git', ['-C', dir, 'log', '-1', '--format=%ct'])) * 1000;
  await mkdir(path.join(dir, 'graphify-out'));
  await writeFile(path.join(dir, 'graphify-out', 'graph.json'), '{}');
  const built = new Date(codeAt + 1000);
  await utimes(path.join(dir, 'graphify-out', 'graph.json'), built, built);
  await mkdir(path.join(dir, 'overlay'));
  await writeFile(path.join(dir, 'CLAUDE.md'), '# rules\n');
  await writeFile(path.join(dir, 'overlay', 'POLICY.md'), '# policy\n');
  await writeFile(path.join(dir, 'notes.txt'), 'n\n');
  const at = String(Math.floor(codeAt / 1000) + 3600);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '--no-verify', '-m', 'docs'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: `${at} +0000` } });
  let f = await graphFacts(dir, { now: codeAt + 3 * H });
  assert.equal(f.commitAt, codeAt, 'the docs commit is not the last code commit');
  assert.equal(f.behind, false);
  // a later commit that touches code again does count
  await writeFile(path.join(dir, 'a.mjs'), 'export const a = 2;\n');
  execFileSync('git', ['-C', dir, 'commit', '-qam', 'code', '--no-verify'], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_COMMITTER_DATE: `${Number(at) + 60} +0000` } });
  f = await graphFacts(dir, { now: codeAt + 3 * H });
  assert.equal(f.behind, true);
});

test('vaultCandidates resolves every links.vault shape seen in closed tasks', () => {
  assert.deepEqual(vaultCandidates('Proj/Proj.md', '/v'), ['/v/Proj/Proj.md']);
  assert.deepEqual(vaultCandidates('Proj/Note', '/v'), ['/v/Proj/Note', '/v/Proj/Note.md']);
  assert.deepEqual(vaultCandidates('/v/Proj/Abs Note.md', '/v'), ['/v/Proj/Abs Note.md']);
  assert.deepEqual(vaultCandidates('', '/v'), []);
  assert.equal(vaultCommitOf('https://github.com/acme/notes/commit/ABCDEF1234'), 'abcdef1234');
  assert.equal(vaultCommitOf('abcdef1'), 'abcdef1');
  assert.equal(vaultCommitOf('Proj/Proj.md'), null);
});

test('verifyClose: a linked vault commit counts by its commit time', async () => {
  const vault = path.join(await mkdtemp(path.join(os.tmpdir(), 'brain-')), 'v');
  await gitRepo(vault);
  const sha = execFileSync('git', ['-C', vault, 'rev-parse', 'HEAD']).toString().trim();
  const at = Number(execFileSync('git', ['-C', vault, 'log', '-1', '--format=%ct'])) * 1000;
  const t = (created) => ({ id: 1, created_at: new Date(created).toISOString(), links: { vault: `https://example.test/notes/commit/${sha}` } });
  assert.equal((await verifyClose(t(at - H), { cfg: { vault } })).vault_synced.ok, true);
  assert.equal((await verifyClose(t(at + H), { cfg: { vault } })).vault_synced.ok, false, 'a commit from before the task');
  assert.equal((await verifyClose({ ...t(at - H), links: { vault: 'deadbeef00' } }, { cfg: { vault } })).vault_synced.ok, false);
});

test('judgeClose + verifyClose: vault note must be edited during the task; graph current or hook in flight', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-'));
  const vault = path.join(root, 'vault');
  await mkdir(path.join(vault, 'Proj'), { recursive: true });
  await writeFile(path.join(vault, 'Proj', 'Proj.md'), '# p\n');
  const created = Date.now() - 3 * H;
  const task = { id: 1, owner: 'shop-agent', created_at: new Date(created).toISOString(), links: { vault: 'Proj/Proj' } };
  const cfg = { vault };
  let v = await verifyClose(task, { cfg, agents: [] });
  assert.equal(v.vault_synced.ok, true);
  assert.equal(v.graphify_updated.ok, true, 'no repo → nothing to graph');
  const old = new Date(created - H);
  await utimes(path.join(vault, 'Proj', 'Proj.md'), old, old);
  v = await verifyClose(task, { cfg, agents: [] });
  assert.equal(v.vault_synced.ok, false);
  assert.match(v.vault_synced.why, /not edited since the task was filed/);
  v = await verifyClose({ ...task, links: {} }, { cfg, agents: [] });
  assert.match(v.vault_synced.why, /--vault "<note>"\) or pass --no-vault/);
  v = await verifyClose({ ...task, links: { vault: 'Nope/Nope.md' } }, { cfg, agents: [] });
  assert.match(v.vault_synced.why, /not found/);

  // graph judged on the owner's repo from the directory (links.repo wins when set)
  const now = 10 * H;
  const g = { dir: '/r', graphAt: 1 * H, commitAt: 2 * H, hook: true, behind: true };
  assert.equal(judgeClose(task, { vaultNoteAt: 0, graph: g }, now).graphify_updated.ok, false);
  assert.match(judgeClose(task, { vaultNoteAt: 0, graph: g }, now).graphify_updated.why, /graphify update \./);
  assert.equal(judgeClose(task, { vaultNoteAt: 0, graph: { ...g, commitAt: now - 60e3 } }, now).graphify_updated.ok, true, 'hook rebuild in flight');
  assert.equal(judgeClose(task, { vaultNoteAt: 0, graph: { ...g, graphAt: 0 } }, now).graphify_updated.ok, true, 'repo without a graph');
});

test('close gate: a failed verification is a 409; a reasoned waiver passes and stays on the task; absent = unchanged', () => {
  const item = CHECKLIST[0];                 // present in both skins
  const all = Object.fromEntries(CHECKLIST.map((k) => [k, true]));
  let t = newTask({ title: 'x', requester: 'mission-control', owner: 'app-ops' }, { id: 1, now: 0 });
  t = applyPatch(t, { op: 'claim', actor: 'app-ops' }).task;
  const close = { op: 'close', actor: 'app-ops', checklist: all, links: { handoff: 'r.md' } };
  const verified = { [item]: { ok: false, why: 'note not edited' } };
  try { applyPatch(t, close, { verified }); assert.fail('should reject'); } catch (e) {
    assert.ok(e instanceof MeshError);
    assert.equal(e.status, 409);
    assert.deepEqual(e.extra.missing, [item]);
    assert.match(e.message, /not verified — note not edited/);
  }
  assert.throws(() => applyPatch(t, { ...close, waive: { [item]: '  ' } }, { verified }), /needs a reason/);
  assert.throws(() => applyPatch(t, { ...close, waive: { nope: 'x' } }, { verified }), /cannot waive "nope"/);
  const r = applyPatch(t, { ...close, waive: { [item]: 'ops-only task, no project note' } }, { verified });
  assert.equal(r.task.status, 'done');
  assert.equal(r.task.verify_waived[item], 'ops-only task, no project note');
  assert.ok(r.task.comments.some((c) => /close waived: .*ops-only task/.test(c.text)));
  assert.equal(applyPatch(t, close, { verified: { [item]: { ok: true, why: 'fine' } } }).task.status, 'done');
  assert.equal(applyPatch(t, close).task.status, 'done', 'no verifier = the old gate');
});

test('brainCard: off without settings; amber (warn, never red) on any count', () => {
  assert.equal(brainCard({}, null), null);
  assert.equal(brainCard({}, {}).status, 'due');
  const now = 100 * H;
  assert.equal(brainCard({ lastRun: now, stale: [], behind: [], rebuild: { failures: [] } }, {}, now).status, 'ok');
  const c = brainCard({ lastRun: now, stale: [{ project: 'Shop', task: 7 }], behind: ['books'], rebuild: { failures: [{ at: now - H, why: 'exceeded 600s' }] } }, {}, now);
  assert.equal(c.status, 'warn');
  assert.match(c.detail, /stale 1 · rebuild fails 1\/24h · graphs behind 1/);
  assert.match(c.detail, /Shop #7/);
});

test('maybeBrain: files once, comments next week, writes only its state + ledger', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brain-'));
  const L = createLedger(path.join(root, 'tasks'));
  const stalenessFile = path.join(root, 'staleness.json');
  const log = path.join(root, 'rebuild.log');
  await writeFile(log, 'Rebuild failed: old one\n');
  const file = path.join(root, 'brain-state.json');
  const cfg = { vault: path.join(root, 'v'), staleness: stalenessFile, rebuildLog: log, requester: 'mission-control', fallbackOwner: 'mission-control', everyMinutes: 10 };
  await writeFile(stalenessFile, JSON.stringify(report([row()])));
  const woke = [];
  let now = Date.parse('2026-01-21T14:00:00Z');
  await maybeBrain({ cfg, ledger: L, agents, now, file, afterCreate: async (t) => woke.push(t.owner) });
  let tasks = await L.list({});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].owner, 'shop-agent');
  assert.deepEqual(woke, ['shop-agent']);
  let st = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(st.stale, [{ project: 'Shop', task: tasks[0].id }]);
  assert.equal(recentFailures(st.rebuild, now).length, 0, 'pre-existing failures are not news');

  await maybeBrain({ cfg, ledger: L, agents, now: now + 60e3, file });          // throttled
  now += 7 * 24 * H;
  await appendFile(log, '[graphify watch] Rebuild failed: graphify rebuild exceeded 600s\n');
  await writeFile(stalenessFile, JSON.stringify(report([row({ days: 26 })], '2026-01-28')));
  await maybeBrain({ cfg, ledger: L, agents, now, file });
  tasks = await L.list({});
  assert.equal(tasks.length, 1, 'never re-filed while live');
  assert.ok(tasks[0].comments.some((c) => c.who === 'board' && /still stale in the 2026-01-28/.test(c.text)));
  st = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(recentFailures(st.rebuild, now).length, 1);
  assert.equal(brainCard(st, cfg, now).status, 'warn');
});
