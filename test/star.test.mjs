// node --test "test/*.test.mjs" — one-time star toast state (src/star.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readStar, successMoment, toastFor, recordToast, boardDone } from '../src/star.mjs';

const REPO = 'https://github.com/example/zulu-assistant';
const tmp = async () => path.join(await mkdtemp(path.join(os.tmpdir(), 'zulu-star-')), 'star-prompt.json');

test('first success moment queues the toast; later ones never replace it', async () => {
  const file = await tmp();
  assert.equal(toastFor(await readStar(file), REPO), null);             // nothing yet
  assert.equal(await successMoment('a failed sync', { file }), true);
  assert.equal(await successMoment('a closed task', { file }), false);
  assert.deepEqual(toastFor(await readStar(file), REPO), { reason: 'a failed sync', repoUrl: REPO });
});

test('shown once = never again, whatever the user clicked (or not)', async () => {
  const file = await tmp();
  await successMoment('x', { file });
  await recordToast('shown', { file });
  assert.equal(toastFor(await readStar(file), REPO), null);
  assert.equal(await successMoment('y', { file }), false);
});

test('"never ask again" and "star" stick; unknown events are refused', async () => {
  for (const ev of ['never', 'star']) {
    const file = await tmp();
    await successMoment('x', { file });
    assert.equal(await recordToast(ev, { file }), true);
    const doc = await readStar(file);
    assert.equal(doc.board.decision, ev);
    assert.ok(boardDone(doc));
    assert.equal(toastFor(doc, REPO), null);
  }
  assert.equal(await recordToast('auto-star', { file: await tmp() }), false);
});

test('no toast without a public repo, or after starring at install', async () => {
  const file = await tmp();
  await successMoment('x', { file });
  assert.equal(toastFor(await readStar(file), ''), null);
  const f2 = await tmp();
  await writeFile(f2, JSON.stringify({ installer: { answer: 'y', at: 1 } }));
  assert.equal(await successMoment('x', { file: f2 }), false);
  const f3 = await tmp();                                                // said no at install: the board may still ask once
  await writeFile(f3, JSON.stringify({ installer: { answer: 'n', at: 1 } }));
  assert.equal(await successMoment('x', { file: f3 }), true);
});
