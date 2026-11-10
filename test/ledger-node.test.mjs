// Loads the optional cmux sidebar (system/cmux/sidebars/ledger-node.js, #416) with a stub runtime
// and checks that it reads the selected workspace's task from the label the board writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ownerPill, withContext, withInput } from '../src/chrome.mjs';

async function load(workspaces) {
  const src = await readFile(new URL('../system/cmux/sidebars/ledger-node.js', import.meta.url), 'utf8');
  const node = () => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : () => node()), apply: () => node() });
  const data = { workspaces: () => workspaces };
  const views = Object.fromEntries(['VStack', 'HStack', 'Text', 'Spacer', 'Divider'].map((n) => [n, () => node()]));
  const fn = new Function('data', 'sidebar', ...Object.keys(views), `${src}\nreturn { taskOf, task, slug, moreLine };`);
  return fn(data, () => {}, ...Object.values(views));
}

test('ledger-node reads id, status, checklist and title from the label the board writes', async () => {
  const t = { id: 411, status: 'in_progress', checklist: { a: true, b: false, c: false, d: false }, title: 'Example task: first pass' };
  const want = withContext(withInput(ownerPill([t]), 'permission'), { pct: 61, band: 'ok' });
  const ws = [{ id: 'W1', title: 'EXAMPLE TASK', selected: true, progress: want.progress }, { id: 'W2', title: 'other', selected: false }];
  const sb = await load(ws);
  assert.equal(want.progress.label, '▲ INPUT · ctx 61% · #411 WORKING · 1/4 · Example task: first pass');
  assert.deepEqual(sb.task(), { id: '411', status: 'WORKING', checklist: '1/4', title: 'Example task: first pass', count: 1, more: 0, also: '' });
  assert.equal(sb.moreLine(sb.task()), '', 'one task: no "and N more"');
  assert.equal(sb.slug('EXAMPLE TASK'), 'example-task');
  assert.equal(sb.taskOf({ progress: { label: '#9 BLOCKED · 0/4' } }).title, '', 'titleInLabel off: no title');
  assert.equal(sb.taskOf({ title: 'no label' }), null);
});

test('ledger-node on an N-task workspace: the headline task plus "and N more" (#416 live reading)', async () => {
  const sb = await load([]);
  const t = (id, status, extra = {}) => ({ id, status, checklist: { a: false, b: false, c: false, d: false }, title: `task ${id}`, ...extra });
  const many = [t(344, 'blocked', { blocked_on: ['owner'] }), ...Array.from({ length: 21 }, (_, i) => t(400 + i, 'open'))];
  // the urgent task is the headline: title + checklist, and the other 21 are counted
  const a = sb.taskOf({ progress: ownerPill(many).progress });
  assert.deepEqual(a, { id: '344', status: 'BLOCKED', checklist: '0/4', title: 'task 344', count: 22, more: 21, also: '' });
  assert.equal(sb.moreLine(a), 'and 21 more');
  // a focus elsewhere is the headline; the urgent one shows as "also"
  const b = sb.taskOf({ progress: withContext(ownerPill(many, Date.now(), { focus: 405 }), { pct: 14, band: 'ok' }).progress });
  assert.deepEqual([b.id, b.status, b.title, b.more, b.also], ['405', 'OPEN', 'task 405', 21, '#344 BLOCKED']);
  assert.equal(sb.moreLine(b), 'and 21 more · also #344 BLOCKED');
  // a pre-fix label with no task token still never reads "no ledger task" for a count above 0
  const c = sb.taskOf({ progress: { label: 'ctx 14% · 11 tasks' } });
  assert.deepEqual([c.id, c.count], ['', 11]);
  assert.equal(sb.moreLine(c), '11 tasks');
});
