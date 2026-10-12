// node --test "test/*.test.mjs" — GitHub repo stats (src/repo-stats.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeDays, repoSummary, repoCards, digestLines, maybeRepoStats, readStatsSync } from '../src/repo-stats.mjs';

const CFG = { repos: ['acme/widget'], everyHours: 6 };
const day = (d, count, uniques) => ({ timestamp: `${d}T00:00:00Z`, count, uniques });

test('mergeDays keeps history beyond GitHub\'s 14 days and overwrites a re-reported day', () => {
  const a = mergeDays({}, [day('2026-01-01', 1, 1)]);
  const b = mergeDays(a, [day('2026-01-01', 3, 2), day('2026-01-15', 5, 4)]);
  assert.deepEqual(b, { '2026-01-01': { count: 3, uniques: 2 }, '2026-01-15': { count: 5, uniques: 4 } });
});

test('summary: 14-day totals come from GitHub (true uniques), all-time from the stored days', () => {
  const r = { meta: { stars: 2, forks: 1, watchers: 3 }, clones: mergeDays({}, [day('2026-01-01', 4, 2), day('2026-02-10', 6, 3)]),
    views: {}, clones14: { count: 6, uniques: 3 }, views14: { count: 0, uniques: 0 }, since: '2026-01-01' };
  const s = repoSummary(r, '2026-02-10');
  assert.equal(s.clonesToday, 6);
  assert.deepEqual(s.clones14, { count: 6, uniques: 3 });
  assert.equal(s.clonesAll, 10);
  assert.equal(s.since, '2026-01-01');
});

test('cards: off without config; due before a reading; ok after; stale after a day', () => {
  assert.deepEqual(repoCards({}, null), []);
  assert.equal(repoCards({ repos: {} }, CFG)[0].status, 'due');
  const now = new Date('2026-02-10T12:00:00Z');
  const state = { repos: { 'acme/widget': { lastOk: now.getTime() - 3600e3, meta: { stars: 1, forks: 0, watchers: 1 }, clones: {}, views: {} } } };
  const c = repoCards(state, CFG, now)[0];
  assert.equal(c.label, 'repo:acme/widget');
  assert.equal(c.status, 'ok');
  assert.match(c.detail, /★ 1 · 0 forks · 1 watching/);
  state.repos['acme/widget'].lastOk = now.getTime() - 30 * 3600e3;
  assert.equal(repoCards(state, CFG, now)[0].status, 'stale');
  assert.match(digestLines(state, CFG, now).join('\n'), /acme\/widget: ★ 1/);
});

test('maybeRepoStats: fetches via gh, writes history, announces new stars, respects the interval', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'zulu-stats-')), 'repo-stats.json');
  let stars = 1; const calls = [];
  const run = (cmd, args, opts, cb) => {
    calls.push(args.join(' '));
    const p = args[1];
    const body = p.endsWith('/traffic/clones') ? { count: 4, uniques: 2, clones: [day('2026-02-10', 4, 2)] }
      : p.endsWith('/traffic/views') ? { count: 9, uniques: 5, views: [day('2026-02-10', 9, 5)] }
        : p.endsWith('/referrers') ? [{ referrer: 'news.example.com', count: 7, uniques: 5 }]
          : { stargazers_count: stars, forks_count: 0, subscribers_count: 1 };
    cb(null, JSON.stringify(body), '');
  };
  const lines = []; const record = async (k, t) => { lines.push(t); };
  const t0 = new Date('2026-02-10T08:00:00Z');
  await maybeRepoStats({ cfg: CFG, now: t0, file, run, record });
  let s = readStatsSync(file).repos['acme/widget'];
  assert.equal(s.meta.stars, 1);
  assert.equal(s.since, '2026-02-10');
  assert.deepEqual(s.clones14, { count: 4, uniques: 2 });
  assert.equal(calls.length, 4);
  await maybeRepoStats({ cfg: CFG, now: new Date(t0.getTime() + 3600e3), file, run, record });   // inside 6h → no fetch
  assert.equal(calls.length, 4);
  stars = 3;
  await maybeRepoStats({ cfg: CFG, now: new Date(t0.getTime() + 7 * 3600e3), file, run, record });
  s = readStatsSync(file).repos['acme/widget'];
  assert.equal(s.meta.stars, 3);
  assert.ok(lines.some((l) => /2 new star\(s\) — now 3/.test(l)));
});
