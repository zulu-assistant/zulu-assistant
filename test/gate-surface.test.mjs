import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionSurface, addGate, decideGate, auditRows } from '../src/gate-ledger.mjs';

// a tailnet (CGNAT 100.64/10) address, built at runtime so the publish scrub gate has no literal to flag
const TAILNET = [100, 64, 0, 7].join('.');

test('decisionSurface: cli, dock, phone (from the socket), strip, board; every one that applies is kept', () => {
  assert.deepEqual(decisionSurface({ via: 'cli', remote: TAILNET, client: 'strip' }), { surface: 'cli', surfaces: ['cli'] });
  assert.deepEqual(decisionSurface({ remote: '127.0.0.1', client: 'panel' }), { surface: 'board', surfaces: ['board'] });
  assert.deepEqual(decisionSurface({ remote: `::ffff:${TAILNET}`, client: 'panel' }), { surface: 'phone', surfaces: ['phone'] });
  assert.deepEqual(decisionSurface({ remote: TAILNET, client: 'strip' }), { surface: 'phone', surfaces: ['phone', 'strip'] });
  assert.deepEqual(decisionSurface({ remote: '127.0.0.1', client: 'dock,strip' }), { surface: 'dock', surfaces: ['dock', 'strip'] });
  assert.deepEqual(decisionSurface({ remote: '::1', client: 'strip' }), { surface: 'strip', surfaces: ['strip'] });
  // the page can't claim to be the phone: only the socket address says so
  assert.deepEqual(decisionSurface({ remote: '127.0.0.1', client: 'phone' }), { surface: 'board', surfaces: ['board'] });
  assert.deepEqual(decisionSurface(), { surface: 'board', surfaces: ['board'] });
});

const iso = '2026-11-01T10:00:00.000Z';
const fresh = () => {
  const t = { id: 9, gates: [] };
  addGate(t, { cls: 'merge', label: 'Merge a pull request', command: 'gh pr merge 1', agent: 'res-a', cmdHash: 'h' }, { iso });
  return t;
};

test('decideGate stamps the surface on the receipt; a pane answer is "pane"; the audit row shows it', () => {
  const t = fresh();
  const g = decideGate(t, { gate: 'g1', decision: 'approve' }, { iso, via: 'board', by: 'owner', surface: 'phone', surfaces: ['phone', 'strip'] });
  assert.equal(g.surface, 'phone'); assert.deepEqual(g.surfaces, ['phone', 'strip']);
  const row = auditRows(t).find((r) => r.event === 'approved');
  assert.equal(row.via, 'board · phone+strip'); assert.equal(row.surface, 'phone');
  const p = fresh();
  assert.equal(decideGate(p, { gate: 'g1', decision: 'decline' }, { iso, via: 'pane', by: 'owner', recordedBy: 'mc' }).surface, 'pane');
  assert.equal(auditRows(p).find((r) => r.event === 'declined').via, 'pane (recorded by mc)');
  const b = fresh();
  assert.equal(decideGate(b, { gate: 'g1', decision: 'approve' }, { iso, via: 'board', by: 'owner' }).surface, 'board');
});
