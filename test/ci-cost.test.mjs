// node --test "test/*.test.mjs" — GitHub Actions cost watch (task #43)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobMinutes, isMacJob, assess, macWorkflows, MACOS_MULTIPLIER } from '../scripts/ci-cost.mjs';

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
  assert.deepEqual(ciCostArgs('/r', { task: 7, repos: ['app', 'staging:ci.yml'] }).slice(1), ['--comment', '7', '--repos', 'app,staging:ci.yml']);
});
