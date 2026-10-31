import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enqueue, NEVER_SUPERSEDED } from '../src/mesh.mjs';
import { ownerPill } from '../src/chrome.mjs';

// #343 item 7: g8 was approved, but its wake sat in the outbox while the agent was busy and the next
// message about the same task SUPERSEDED it — the approval expired unused. Gate decisions must arrive.
test('a queued gate decision is never superseded by a later message about the same task', async () => {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'outbox-')), 'outbox.json');
  await enqueue({ to: 'builder', taskId: 7, kind: 'gate', line: 'GATE g8 on #7 APPROVED — run exactly: x', queuedAt: 1 }, file);
  await enqueue({ to: 'builder', taskId: 7, kind: 'message', line: 'comment on #7: later note', queuedAt: 2 }, file);
  await enqueue({ to: 'builder', taskId: 7, kind: 'gate', line: 'GATE g10 on #7 DECLINED', queuedAt: 3 }, file);
  await enqueue({ to: 'builder', taskId: 7, kind: 'message', line: 'comment on #7: newest note', queuedAt: 4 }, file);
  const box = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(box.map((m) => m.line), ['GATE g8 on #7 APPROVED — run exactly: x', 'GATE g10 on #7 DECLINED', 'comment on #7: newest note']);
  assert.ok(['approval', 'done', 'decision', 'gate'].every((k) => NEVER_SUPERSEDED.has(k)));
});

test('an approved, unexpired, unrun gate leads the sidebar label until it runs or expires', () => {
  const now = Date.parse('2026-01-01T10:00:00Z');
  const t = (gates) => ({ id: 7, status: 'in_progress', checklist: { a: false }, gates });
  const approved = { id: 'g8', status: 'approved', expires_at: '2026-01-01T11:00:00Z' };
  assert.match(ownerPill([t([approved])], now).progress.label, /^⛨ g8 APPROVED — run it · #7 /);
  assert.match(ownerPill([t([approved, { id: 'g9', status: 'pending' }])], now).progress.label, /^⛨ g8 APPROVED — run it · ⛨ 1 GATE · /);
  assert.doesNotMatch(ownerPill([t([{ ...approved, status: 'executed' }])], now).progress.label, /APPROVED/);
  assert.doesNotMatch(ownerPill([t([{ ...approved, expires_at: '2026-01-01T09:00:00Z' }])], now).progress.label, /APPROVED/);
});
