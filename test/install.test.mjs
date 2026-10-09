// node --test "test/*.test.mjs" — install.sh --brain hook merge + publish public-only mapping
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeHooks } from '../scripts/merge-hooks.mjs';
import { classify, publicPairs } from '../scripts/publish.mjs';
import { maybeRemediate } from '../src/remediate.mjs';

const TPL = { hooks: { PreToolUse: [{ matcher: 'Grep|Glob', hooks: [{ type: 'command', command: 'graphify hook-guard search' }] }] } };

test('mergeHooks adds missing hooks once and keeps everything the user had', () => {
  const mine = { model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard' }] }] } };
  const a = mergeHooks(mine, TPL);
  assert.equal(a.added, 1);
  assert.equal(a.settings.model, 'x');
  assert.equal(a.settings.hooks.PreToolUse.length, 2);
  const b = mergeHooks(a.settings, TPL);
  assert.equal(b.added, 0);                                               // idempotent
  assert.equal(mergeHooks(undefined, TPL).added, 1);
});

test('publicRoot files publish at the stripped path; shadowing a public file is a problem', () => {
  const m = { publicRoot: 'publish/public', public: ['server.mjs', 'docs/**'], private: ['README.md'] };
  const c = classify(['server.mjs', 'README.md', 'publish/public/README.md', 'publish/public/docs/A.md'], m);
  assert.deepEqual(publicPairs(c), [['server.mjs', 'server.mjs'], ['publish/public/README.md', 'README.md'], ['publish/public/docs/A.md', 'docs/A.md']]);
  assert.deepEqual(c.shadowed, []);
  const clash = classify(['docs/A.md', 'publish/public/docs/A.md'], m);    // a tracked public docs/A.md already exists
  assert.deepEqual(clash.shadowed, ['publish/public/docs/A.md']);
  assert.deepEqual(c.private, ['README.md']);
});

test('remediation with no blessed levers never runs', async () => {
  let called = false;
  await maybeRemediate('down', async () => { called = true; }, []);
  assert.equal(called, false);
});
