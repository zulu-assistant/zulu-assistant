import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, triggerLines, normalizeForTriggers, DEFAULT_POLICY } from '../src/gates.mjs';

// #429: a script rule's argument is its SUBCOMMAND. "gate" written in a comment's text, or in a later
// command's text on the same line, is not "task.sh gate" — 3 such calls on one task were held as opaque.
const run = (command) => classify({ tool: 'Bash', command, cwd: '/work/app' }, DEFAULT_POLICY, { home: '/home/u' });
const triggered = (command) => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'trig-')), 'triggers');
  writeFileSync(file, triggerLines(DEFAULT_POLICY).join('\n') + '\n');
  return spawnSync('/usr/bin/grep', ['-iEq', '-f', file], { input: normalizeForTriggers(command) }).status === 0;
};

test('comment text that mentions a merge gate is not a gated call, alone or chained (#429)', () => {
  for (const c of [
    `scripts/task.sh comment 427 "merge gate filed: g1 on #427"`,
    // the live shape: the word sat in the SECOND command's text, which the parser judges separately
    `cd /work/app && scripts/task.sh comment 426 "card verified" && scripts/agent-send.sh --task 427 coordinator "the #427 merge gate is waiting"`,
    `scripts/task.sh comment 9 "the owner approves with: task.sh gate 9 g1 approve"`,
  ]) {
    assert.equal(run(c).verdict, 'clear', c);
  }
  assert.equal(triggered(`scripts/task.sh comment 427 "the merge gate"`), false, 'the fast path no longer fires on comment text');
});

test('the real subcommand still gates, through the fast path and the classifier', () => {
  for (const c of [`scripts/task.sh gate 1 g1 approve`, `cd /work/app && sh scripts/task.sh  gate 1 g1 decline`, `scripts/task.sh "gate" 1 g1 approve`]) {
    assert.equal(triggered(c), true, `fast path: ${c}`);
    const r = run(c);
    assert.equal(r.verdict, 'gate', c);
    assert.equal(r.cls, 'self', c);
  }
  assert.equal(triggered(`node scripts/mesh-cli.mjs task gate 1 g1 approve`), true);
  assert.equal(run(`node scripts/mesh-cli.mjs task gate 1 g1 approve`).verdict, 'gate');
});
