// node --test "test/*.test.mjs" — GitHub Actions cost watch (task #43)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobMinutes, isMacJob, assess, macWorkflows, MACOS_MULTIPLIER, skuWeight, summarizeUsage, repoBreakdown } from '../scripts/ci-cost.mjs';

test('jobMinutes: wall time rounded UP per job; unfinished jobs are free', () => {
  assert.equal(jobMinutes({ started_at: '2026-09-29T09:28:42Z', completed_at: '2026-09-29T09:29:00Z' }), 1);
  assert.equal(jobMinutes({ started_at: '2026-09-29T09:00:00Z', completed_at: '2026-09-29T09:02:01Z' }), 3);
  assert.equal(jobMinutes({ started_at: '2026-09-29T09:00:00Z', completed_at: null }), 0);
});

test('isMacJob: by runner label or runner name', () => {
  assert.ok(isMacJob({ labels: ['macos-latest'] }));
  assert.ok(isMacJob({ labels: [], runner_name: 'GitHub Actions 12 (macOS)' }));
  assert.ok(!isMacJob({ labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 3' }));
});

test('assess: 10× multiplier, linear projection, the three review triggers', () => {
  assert.equal(MACOS_MULTIPLIER, 10);
  const ok = assess({ macMinutes: 3, included: 2000, now: new Date('2026-09-29T12:00:00Z') });
  assert.deepEqual([ok.billed, ok.pct, ok.projected, ok.triggers.length], [30, 2, 31, 0]);
  const half = assess({ macMinutes: 100, included: 2000, now: new Date('2026-09-29T12:00:00Z') });
  assert.match(half.triggers.join(), /≥ 50%/);
  const fast = assess({ macMinutes: 20, included: 2000, now: new Date('2026-09-03T12:00:00Z') });
  assert.equal(fast.projected, 2000);                                     // 200 billed in 3 of 30 days
  assert.equal(fast.triggers.length, 0);                                  // exactly at the line is not over it
  assert.match(assess({ macMinutes: 21, included: 2000, now: new Date('2026-09-03T12:00:00Z') }).triggers.join(), /projected/);
  assert.match(assess({ macMinutes: 1, otherMacRepos: ['staging'], included: 2000 }).triggers.join(), /also running in: staging/);
});

test('macWorkflows: only workflow files that run on macOS are walked', () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'mc-wf-'));
  mkdirSync(path.join(d, 'wf'));
  writeFileSync(path.join(d, 'wf/ci.yml'), 'jobs:\n  test:\n    runs-on: macos-latest\n');
  writeFileSync(path.join(d, 'wf/deadman.yml'), 'jobs:\n  beat:\n    runs-on: ubuntu-latest\n');
  writeFileSync(path.join(d, 'wf/notes.txt'), 'runs-on: macos-latest');
  assert.deepEqual(macWorkflows(path.join(d, 'wf')), ['ci.yml']);
});

test('weekly slot + due(): Monday 08:00 local, once per week, catch-up after downtime, hourly retry', async () => {
  const { lastWeeklySlot, due } = await import('../src/ci-cost-watch.mjs');
  const mon0800 = new Date(2026, 8, 28, 8, 0).getTime();                  // Mon 2026-09-28 08:00 local
  assert.equal(lastWeeklySlot(new Date(2026, 8, 29, 9, 0)), mon0800);     // Tue → back to Monday
  assert.equal(lastWeeklySlot(new Date(2026, 8, 28, 7, 59)), new Date(2026, 8, 21, 8, 0).getTime());   // before the slot → last week
  const cfg = { task: 43, weekday: 1, hour: 8 };
  const now = new Date(2026, 8, 30, 12, 0);                               // Wed: Mac was off Monday → catch up
  assert.equal(due({ now, cfg, state: {} }), true);
  assert.equal(due({ now, cfg, state: { lastRun: mon0800 + 1 } }), false); // already read this week
  assert.equal(due({ now, cfg, state: { lastAttempt: now.getTime() - 60e3 } }), false);   // failed a minute ago
  assert.equal(due({ now, cfg: null, state: {} }), false);                 // not configured = off
});

test('ciCostArgs: configured repos are passed through; default = this repo only', async () => {
  const { ciCostArgs } = await import('../src/ci-cost-watch.mjs');
  assert.deepEqual(ciCostArgs('/r', { task: 7 }).slice(1), ['--comment', '7']);
  assert.deepEqual(ciCostArgs('/r', { task: 7, included: 3000 }).slice(-2), ['--included', '3000']);   // the plan's allowance
  assert.deepEqual(ciCostArgs('/r', { task: 7, repos: ['app', 'staging:ci.yml'] }).slice(1), ['--comment', '7', '--repos', 'app,staging:ci.yml']);
});

// ---- account-wide (task #189: 1,440 Linux minutes elsewhere were invisible) ----

const item = (repo, sku, quantity, extra = {}) => ({ product: 'actions', sku, quantity, unitType: 'Minutes', repositoryName: repo, grossAmount: 0, netAmount: 0, ...extra });
// the shape of the real October 2026 report, with neutral repo names
const OCT = [
  item('board', 'Actions Linux', 869.67), item('board', 'Actions macOS 3-core', 53),
  item('helpdesk', 'Actions Linux', 402), item('service', 'Actions Linux', 113),
  item('site', 'Actions Linux', 20), item('tool', 'Actions Linux', 20), item('misc', 'Actions Linux', 14),
  item('staging', 'Actions Linux', 2), item('staging', 'Actions macOS 3-core', 2),
  { product: 'actions', sku: 'Actions storage', quantity: 0.5, unitType: 'GigabyteHours', repositoryName: 'board', grossAmount: 0.01, netAmount: 0 },
  { product: 'packages', sku: 'Packages data transfer', quantity: 3, unitType: 'Gigabytes', repositoryName: 'board' },
];

test('skuWeight: Linux 1×, Windows 2×, macOS 10× (any macOS size)', () => {
  assert.equal(skuWeight('Actions Linux'), 1);
  assert.equal(skuWeight('Actions Windows'), 2);
  assert.equal(skuWeight('Actions macOS 3-core'), 10);
  assert.equal(skuWeight('Actions macOS 12-core'), 10);
});

test('summarizeUsage: every repo and SKU counts toward included minutes; storage/packages do not', () => {
  const u = summarizeUsage(OCT);
  assert.deepEqual(u.byKind, { linux: 1441, windows: 0, macos: 55 });
  assert.equal(u.equivalent, 1991, '1,440.67 Linux + 55 macOS × 10');
  assert.deepEqual(u.perRepo.board, { linux: 870, windows: 0, macos: 53, equivalent: 1400 });
  assert.equal(u.perRepo.helpdesk.equivalent, 402);
  assert.ok(!('(no repo)' in u.perRepo));
  assert.match(repoBreakdown(u.perRepo, 3), /^board 1400 \(870 Linux \+ 53 macOS\), helpdesk 402, service 113, \+4 more$/);
});

test('assess on the account total: the October reading would have fired (it said 28%)', () => {
  const u = summarizeUsage(OCT);
  const a = assess({ equivalent: u.equivalent, macMinutes: u.byKind.macos, included: 2000, now: new Date('2026-10-20T12:00:00Z') });
  assert.equal(a.pct, 100);
  assert.match(a.triggers.join(), /included minutes nearly used up \(1991\/2000, 100%\)/);
  assert.match(assess({ equivalent: 2004, included: 2000 }).triggers.join(), /used up \(2004\/2000\)/);
  // a week earlier: 50% trigger + projection, not "used up"
  const early = assess({ equivalent: 1050, included: 2000, now: new Date('2026-10-12T12:00:00Z') });
  assert.match(early.triggers.join(), /≥ 50%/);
  assert.match(early.triggers.join(), /projected 2713 > 2000/);
  assert.match(assess({ equivalent: 10, included: 2000, overageUsd: 4.2, now: new Date('2026-10-20T12:00:00Z') }).triggers.join(), /billed overage \$4\.20/);
  // old callers (jobs-API fallback) still get macOS × 10
  assert.equal(assess({ macMinutes: 3, included: 2000 }).billed, 30);
});
