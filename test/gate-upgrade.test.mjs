import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { classify, DEFAULT_POLICY } from '../src/gates.mjs';

// #435: the one-click upgrade (#346) and a rollback run by an agent are a gated class of their own;
// the check form changes nothing and stays clear.
const run = (command, policy = DEFAULT_POLICY) => classify({ tool: 'Bash', command, cwd: '/work/app' }, policy, { home: '/home/u' });

test('upgrade and rollback gate as class upgrade; --check, doctor, tests and reads stay clear', () => {
  for (const c of ['zulu upgrade', 'zulu upgrade --to v1.1.0', 'bin/zulu upgrade', 'zulu rollback',
    'node scripts/upgrade.mjs --to v1.1.0', 'node scripts/upgrade.mjs rollback', 'node scripts/upgrade.mjs --from-request',
    './install.sh upgrade', './install.sh rollback', 'cd /work/app && ./install.sh upgrade --to v1.1.0']) {
    const r = run(c);
    assert.equal(r.verdict, 'gate', c);
    assert.equal(r.cls, 'upgrade', c);
  }
  for (const c of ['zulu upgrade --check', 'node scripts/upgrade.mjs --check', 'zulu doctor', './install.sh check',
    'node --test test/upgrade.test.mjs', 'cat scripts/upgrade.mjs', 'grep -n rollback scripts/upgrade.mjs']) {
    assert.equal(run(c).verdict, 'clear', c);
  }
});

test('upgrade is not standing (a program go never covers it), and the shipped policies carry it', () => {
  const cls = DEFAULT_POLICY.classes.find((c) => c.id === 'upgrade');
  assert.ok(cls && !cls.standing);
  const ROOT = new URL('..', import.meta.url).pathname;
  const tracked = (f) => { try { return !!execFileSync('git', ['-C', ROOT, 'ls-files', f], { encoding: 'utf8' }).trim(); } catch { return false; } };
  for (const f of ['examples/policy.json', 'overlay/policy.json']) {
    if (f.startsWith('overlay/') && !tracked(f)) continue;                   // an install's own rules can be from an older release (INSTALL 7b)
    let p;
    try { p = JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')); } catch { continue; }   // overlay/ is absent in the public edition
    const c = p.classes.find((x) => x.id === 'upgrade');
    assert.ok(c, `${f} carries the upgrade class`);
    assert.deepEqual(c.rules, cls.rules, `${f} matches the shipped default`);
    assert.equal(run('zulu upgrade', p).cls, 'upgrade', f);
  }
});
