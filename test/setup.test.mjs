// node --test "test/*.test.mjs" — zulu setup: scan parsers, local.json merge, setup card, doctor redaction
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseSelection, nameFromLabel, skipLabel, cronEntries } from '../src/setup-scan.mjs';
import { mergeLocal } from '../src/config.mjs';
import { STEPS, summarize, setupCard } from '../src/setup.mjs';
import { redactor } from '../scripts/doctor.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('parseSelection: ranges, all/none, out-of-range ignored, junk rejected', () => {
  assert.deepEqual(parseSelection('1,3-5', 6), [0, 2, 3, 4]);
  assert.deepEqual(parseSelection('all', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('', 3), []);
  assert.deepEqual(parseSelection('none', 3), []);
  assert.deepEqual(parseSelection('2 9', 3), [1]);
  assert.deepEqual(parseSelection('5-3', 6), [2, 3, 4]);
  assert.throws(() => parseSelection('two', 3), /can't read/);
});

test('LaunchAgent labels: readable names; Apple, Homebrew and our own agents are never offered', () => {
  assert.equal(nameFromLabel('com.acme.billing-sync'), 'Billing sync');
  assert.equal(nameFromLabel('com.vendor.GC.Scheduler-1.0'), 'Scheduler');
  assert.equal(nameFromLabel('com.vendor.VendorUpdater.wake'), 'VendorUpdater wake');
  assert.ok(skipLabel('com.apple.foo', 'com.zulu-assistant'));
  assert.ok(skipLabel('homebrew.mxcl.redis', 'com.zulu-assistant'));
  assert.ok(skipLabel('com.zulu-assistant.master-console', 'com.zulu-assistant'));
  assert.ok(!skipLabel('com.acme.sync', 'com.zulu-assistant'));
});

test('cronEntries: real lines only, script-derived unique ids', () => {
  const text = [
    '# comment', 'MAILTO=""', 'SHELL=/bin/bash', '@reboot /x/start.sh',
    '30 2 * * * /Users/x/app/nightly-report.sh >> /tmp/n.log 2>&1',
    '*/5 * * * * cd ~/app && node sync.mjs',
    '0 3 * * 1 /opt/other/nightly-report.sh',
  ].join('\n');
  const e = cronEntries(text);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((x) => x.id), ['nightly-report', 'sync', 'nightly-report-2']);
  assert.equal(e[0].schedule, '30 2 * * *');
  assert.equal(e[0].match, 'nightly-report.sh');
});

const REG = {
  DOMAINS: [{ id: 'app' }], JOBS: [{ label: 'com.example.a', example: true }, { label: 'com.keep.b' }],
  DOCKER_CONTAINERS: [{ name: 'db', example: true }], CRON: [], ENDPOINTS: [{ id: 'site', example: true }], PROCESSES: [],
  SETTINGS: { port: 3210, owner: { id: 'owner', name: 'Owner' } },
};

test('mergeLocal: setup answers join the registry; examples drop only when asked; owner wins', () => {
  assert.equal(mergeLocal(REG, null), REG);
  const m = mergeLocal(REG, {
    dropExamples: true, owner: { id: 'sam', name: 'Sam' }, domains: [{ id: 'mine' }],
    jobs: [{ label: 'com.acme.sync' }, { label: 'com.keep.b' }], docker: [{ name: 'redis' }],
    endpoints: [{ id: 'ep1', url: 'https://x' }],
  });
  assert.deepEqual(m.JOBS.map((j) => j.label), ['com.keep.b', 'com.acme.sync']);      // example gone, no duplicate
  assert.deepEqual(m.DOCKER_CONTAINERS.map((c) => c.name), ['redis']);
  assert.deepEqual(m.ENDPOINTS.map((e) => e.id), ['ep1']);
  assert.deepEqual(m.DOMAINS.map((d) => d.id), ['app', 'mine']);
  assert.equal(m.SETTINGS.owner.name, 'Sam');
  assert.equal(m.SETTINGS.port, 3210);
  assert.equal(mergeLocal(REG, { jobs: [] }).JOBS.length, 2);                          // examples stay until dropExamples
});

test('setup card: none without a state file; due → warn (skipped required) → ok', () => {
  assert.equal(setupCard(null), null);
  const doc = { steps: {} };
  assert.equal(setupCard(doc).status, 'due');
  assert.match(setupCard(doc).detail, /^setup 0\/10 .*\(next: GitHub account\)$/);
  for (const s of STEPS) doc.steps[s.id] = { status: 'done' };
  doc.steps.vault = { status: 'skipped' };
  assert.equal(setupCard(doc).status, 'warn');
  assert.match(setupCard(doc).detail, /skipped: Obsidian vault/);
  doc.steps.vault = { status: 'done' };
  assert.equal(setupCard(doc).status, 'ok');
  assert.equal(summarize(doc).complete, true);
});

test('doctor redaction: secrets, tokens, emails, phones, IPs, uuids, home, user, host', () => {
  const R = redactor({ secrets: { SMTP_PASS: 'hunter2-super', EMPTY: '' }, home: '/Users/sam', user: 'sam', host: 'sams-mac.local' });
  const tok = ['sk', 'ant', 'api03', 'abcdefghijklmnop'].join('-');
  const out = R(`pass hunter2-super at /Users/sam/app by sam on sams-mac.local\n${tok} sam@example.com +14045550123 ` +
    `100.101.102.103 192.168.1.4 00000000-0000-4000-8000-000000000001 api_key=abc123`);
  for (const leak of ['hunter2', '/Users/sam', 'sams-mac', tok, 'sam@example.com', '+1404', '100.101', '192.168', '00000000-0000', 'abc123']) {
    assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`);
  }
  assert.match(out, /~\/app by <user>/);
});

test('installer scripts parse; prereqs dry run writes nothing', { skip: !existsSync('/bin/zsh') && 'macOS only' }, () => {
  for (const f of ['get.sh', 'install.sh', 'scripts/prereqs.sh']) execFileSync('bash', ['-n', f], { cwd: ROOT });
  const out = execFileSync('scripts/prereqs.sh', ['--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /already installed|dry run — nothing installed/);
});
