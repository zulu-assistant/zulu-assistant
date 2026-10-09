// node --test "test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCron, lastCronSlot, nextCronSlot, cronSlotsInWindow, cronJobStatus,
} from '../src/status.mjs';
import { cronPresence } from '../src/collect.mjs';

// local wall-clock dates — cron slots are always local time, like the crontab
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);
const iso = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
  `${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:` +
  `${String(d.getMinutes()).padStart(2, '0')}` : null);

// ---- field parsing --------------------------------------------------------

test('parseCron accepts the registry subset', () => {
  assert.ok(parseCron('0 7,11,18 * * *'));
  assert.ok(parseCron('45 6 * * *'));
  assert.ok(parseCron('0 4 * * 0'));
  assert.ok(parseCron('0 */2 * * *'));
  assert.ok(parseCron('*/15 9-17 1-15 1,7 1-5'));
});

test('parseCron rejects malformed / out-of-range / macro exprs', () => {
  for (const bad of ['', '0 7 * *', '0 7 * * * *', '@daily', '60 7 * * *',
    '0 24 * * *', '0 7 * * 8', 'x 7 * * *', '0 7 * * 5-1', '0 */0 * * *']) {
    assert.equal(parseCron(bad), null, `expected null for "${bad}"`);
  }
});

test('*/n expands to a stepped set; 7 folds onto Sunday', () => {
  assert.deepEqual([...parseCron('0 */2 * * *').hour], [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
  assert.deepEqual([...parseCron('*/20 * * * *').minute], [0, 20, 40]);
  assert.deepEqual([...parseCron('0 4 * * 7').dow], [0]);
  assert.deepEqual([...parseCron('0 9 * * 1-5').dow], [1, 2, 3, 4, 5]);
});

// ---- last/next due slot ---------------------------------------------------

test('multiple daily slots pick the most recent one that has passed', () => {
  const expr = '0 7,11,18 * * *';                       // nightly report
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 7, 12, 30))), '2026-08-07 11:00');
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 7, 7, 0))), '2026-08-07 07:00');  // exactly on the slot
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 7, 6, 59))), '2026-08-06 18:00'); // rolls to yesterday
  assert.equal(iso(nextCronSlot(expr, at(2026, 8, 7, 12, 30))), '2026-08-07 18:00');
  assert.equal(iso(nextCronSlot(expr, at(2026, 8, 7, 18, 0))), '2026-08-08 07:00'); // strictly after now
});

test('*/2 hours steps every other hour and rolls across midnight', () => {
  const expr = '0 */2 * * *';                            // health-check shape
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 7, 9, 30))), '2026-08-07 08:00');
  assert.equal(iso(nextCronSlot(expr, at(2026, 8, 7, 9, 30))), '2026-08-07 10:00');
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 7, 0, 30))), '2026-08-07 00:00');
  assert.equal(iso(nextCronSlot(expr, at(2026, 8, 7, 23, 30))), '2026-08-08 00:00');
});

test('weekday-restricted weekly job walks back to its own day', () => {
  const expr = '0 4 * * 0';                              // docker prune, Sun 04:00
  // Fri 2026-08-07 -> last Sunday was 2026-08-02
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 7, 12, 0))), '2026-08-02 04:00');
  assert.equal(iso(nextCronSlot(expr, at(2026, 8, 7, 12, 0))), '2026-08-09 04:00');
  // Sunday before the slot -> previous Sunday
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 9, 3, 59))), '2026-08-02 04:00');
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 9, 4, 0))), '2026-08-09 04:00');
});

test('weekday range only fires Mon–Fri', () => {
  const expr = '30 9 * * 1-5';
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 8, 12, 0))), '2026-08-07 09:30'); // Sat -> Fri
  assert.equal(iso(nextCronSlot(expr, at(2026, 8, 8, 12, 0))), '2026-08-10 09:30'); // Sat -> Mon
});

test('restricted dom AND dow are OR-ed, per cron semantics', () => {
  const expr = '0 5 1 * 0';   // the 1st of the month OR any Sunday
  assert.equal(iso(lastCronSlot(expr, at(2026, 8, 3, 12, 0))), '2026-08-02 05:00'); // Sunday
  assert.equal(iso(lastCronSlot(expr, at(2026, 9, 1, 12, 0))), '2026-09-01 05:00'); // 1st (a Tuesday)
});

test('a schedule with no slot in the lookback window returns null', () => {
  // Feb 30 never exists -> nothing within the 8-day walk
  assert.equal(lastCronSlot('0 5 30 2 *', at(2026, 8, 7, 12, 0)), null);
  assert.equal(lastCronSlot('nonsense', at(2026, 8, 7, 12, 0)), null);
});

// ---- ±12h timeline window -------------------------------------------------

test('cronSlotsInWindow returns only slots inside ±12h, sorted', () => {
  const slots = cronSlotsInWindow('0 7,11,18 * * *', at(2026, 8, 7, 12, 0)).map(iso);
  assert.deepEqual(slots, ['2026-08-07 07:00', '2026-08-07 11:00', '2026-08-07 18:00']);
  // weekly job, five days from its slot -> nothing in the window
  assert.deepEqual(cronSlotsInWindow('0 4 * * 0', at(2026, 8, 7, 12, 0)), []);
});

// ---- status derivation ----------------------------------------------------

const JOB = {
  id: 'nightly-report', name: 'Nightly report', domain: 'infra',
  schedule: '0 7,11,18 * * *', log: '/tmp/x.log', grace: 60, present: true,
};

test('log newer than the due slot is ok', () => {
  const now = at(2026, 8, 7, 12, 0);
  const j = cronJobStatus({ ...JOB, mtime: +at(2026, 8, 7, 11, 2) }, now);
  assert.equal(j.status, 'ok');
  assert.equal(j.label, 'cron:nightly-report');
  assert.equal(j.schedule, 'cron 0 7,11,18 * * *');
  assert.equal(j.logAvailable, true);
});

test('grace boundary: due inside grace, overdue one minute past it', () => {
  const due = at(2026, 8, 7, 11, 0);
  const stale = +at(2026, 8, 7, 7, 1);                  // ran the 07:00 slot, not 11:00
  // exactly at the 60-minute boundary -> still due
  assert.equal(cronJobStatus({ ...JOB, mtime: stale }, new Date(+due + 60 * 60000)).status, 'due');
  // one minute past -> overdue
  const late = cronJobStatus({ ...JOB, mtime: stale }, new Date(+due + 61 * 60000));
  assert.equal(late.status, 'overdue');
  assert.match(late.detail, /MISSED/);
});

test('missing log never counts as a run', () => {
  const j = cronJobStatus({ ...JOB, mtime: null }, at(2026, 8, 7, 23, 0));
  assert.equal(j.status, 'overdue');
  assert.match(j.detail, /never ran/);
});

test('quietOk / log-less entries are judged by crontab presence alone', () => {
  const rotate = { id: 'log-rotate', name: 'Log rotation', domain: 'infra',
    schedule: '0 2 * * *', quietOk: true, present: true, mtime: null };
  const ok = cronJobStatus(rotate, at(2026, 8, 7, 23, 0));
  assert.equal(ok.status, 'ok');
  assert.equal(ok.logAvailable, false);
  assert.equal(cronJobStatus({ ...rotate, present: false }, at(2026, 8, 7, 23, 0)).status, 'down');
});

test('unknown crontab presence never manufactures an alert', () => {
  const j = cronJobStatus({ ...JOB, present: null, mtime: +at(2026, 8, 7, 11, 2) }, at(2026, 8, 7, 12, 0));
  assert.equal(j.status, 'ok');
});

test('a line removed from the crontab is DOWN regardless of log freshness', () => {
  const j = cronJobStatus({ ...JOB, present: false, mtime: Date.now() }, at(2026, 8, 7, 12, 0));
  assert.equal(j.status, 'down');
  assert.match(j.detail, /missing from crontab/);
});

test('an unparseable registry schedule is surfaced, not silently ok', () => {
  const j = cronJobStatus({ ...JOB, schedule: '@daily' }, at(2026, 8, 7, 12, 0));
  assert.equal(j.status, 'down');
  assert.match(j.detail, /unparseable/);
});

// ---- crontab drift check --------------------------------------------------

test('cronPresence ignores comments and @reboot self-heal lines', () => {
  const text = [
    '# nightly report',
    '0 7 * * * /Users/x/app/scripts/run_report.sh >> /x/cron.log 2>&1',
    '# the scheduled sync was removed; only its @reboot hook survives',
    '@reboot sleep 60 && /Users/x/app/scripts/sync.sh',
    '0 2 * * * /Users/x/app/scripts/rotate-logs.sh',
  ].join('\n');
  const registry = [
    { id: 'nightly-report', match: 'run_report.sh' },
    { id: 'sync', match: 'scripts/sync.sh' },
    { id: 'log-rotate', match: 'rotate-logs.sh' },
    { id: 'docker-prune', match: 'docker system prune' },
  ];
  const p = cronPresence(text, registry);                // registry injected: the test never depends on the owner's crontab entries
  assert.equal(p.get('nightly-report'), true);
  assert.equal(p.get('sync'), false, '@reboot alone is not the recurring schedule');
  assert.equal(p.get('log-rotate'), true);
  assert.equal(p.get('docker-prune'), false);
});

test('cronPresence on empty input marks everything absent', () => {
  for (const v of [cronPresence(''), cronPresence(null)]) {
    assert.ok(v.size > 0);
    assert.equal([...v.values()].some(Boolean), false);
  }
});
