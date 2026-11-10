// Row context (1.3): a chip per class and list on a waiting row, the agent's own words labelled,
// and no chip text that comes from the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createLedger, summarize } from '../src/tasks.mjs';
import { createGateService } from '../src/gate-service.mjs';
import { pendingGates } from '../src/gate-ledger.mjs';
import { DEFAULT_POLICY } from '../src/gates.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';
import { attentionItems } from '../src/attention.mjs';
import { CHIPS, rowContext, cleanContext, agentWords, MAX_WORDS } from '../src/row-context.mjs';
import { OWNER } from '../src/config.mjs';

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const page = {};
vm.runInNewContext(await read('public/decide.js'), { globalThis: page });
vm.runInNewContext(await read('public/attention.js'), { globalThis: page });
const { BoardDecide, BoardAttention } = page;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const row = (g, o = {}) => BoardDecide.gateRowHtml({ id: 'g1', cls: 'push', label: 'Push', agent: 'builder', cwd: '/work/app', tool: 'Bash', why: 'a push', command: 'git push', ...g },
  { key: '7:g1', esc, age: '3m', open: false, actions: '<button>RUN</button>', ...o });

// neutral fixtures: one public repo, one that deploys on push, one plain
const LISTS = { publicRemotes: ['acme/open-*'], deployOnPush: ['acme/site'] };
const REMOTES = { origin: 'git@github.com:acme/open-tools.git', site: 'https://github.com/acme/site.git', plain: 'git@github.com:acme/internal.git' };

test('rowContext: a chip per list and class; nothing for a plain private repo', () => {
  assert.deepEqual(rowContext({ cls: 'push', slug: 'acme/open-tools', lists: LISTS }), ['public-repo']);
  assert.deepEqual(rowContext({ cls: 'merge', slug: 'Acme/Site', lists: LISTS }), ['deploy-on-push'], 'case does not matter');
  assert.deepEqual(rowContext({ cls: 'push', slug: 'acme/internal', lists: LISTS }), []);
  assert.deepEqual(rowContext({ cls: 'push', slug: null, lists: LISTS }), []);
  assert.deepEqual(rowContext({ cls: 'outbound' }), ['outbound']);
  assert.deepEqual(rowContext({ cls: 'store' }), ['store']);
  assert.deepEqual(rowContext({ cls: 'self' }), ['self']);
  assert.deepEqual(rowContext({ cls: 'desktop' }), ['desktop']);
  assert.deepEqual(rowContext({ cls: 'mcp-unlisted' }), ['unlisted']);
  assert.deepEqual(rowContext({ cls: 'write' }), []);
  for (const id of ['public-repo', 'deploy-on-push', 'outbound', 'store', 'self', 'desktop', 'unlisted']) assert.ok(CHIPS[id], id);
});

test('the page and the board hold the same chip table', () => {
  assert.deepEqual({ ...BoardDecide.CHIP_TEXT }, CHIPS);
});

test('cleanContext: only known ids, once, in table order; agentWords: one line, cut, withheld when secret-shaped', () => {
  assert.deepEqual(cleanContext(['store', '<b>safe</b>', 'public-repo', 'store', 'toString', 7]), ['public-repo', 'store']);
  assert.deepEqual(cleanContext('public-repo'), []); assert.deepEqual(cleanContext(null), []);
  assert.equal(agentWords('  Merge the\n reviewed PR  '), 'Merge the reviewed PR');
  assert.equal(agentWords(''), null); assert.equal(agentWords('   '), null); assert.equal(agentWords({ a: 1 }), null);
  assert.equal(agentWords('x'.repeat(900)).length, MAX_WORDS);
  assert.match(agentWords(`use ${'tok' + 'en'}=${'ab12'.repeat(4)} here`), /withheld/);   // built here so a secret scanner does not flag the fixture
});

async function setup(lists = LISTS) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'row ctx-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify({ ...DEFAULT_POLICY, lists: { ...DEFAULT_POLICY.lists, ...lists } }));
  const git = (cwd, args) => (args[0] === 'remote' ? REMOTES[args[2]] || null : args[0] === 'rev-parse' ? 'main' : null);
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'),
    ownerId: OWNER.id, identifyWs: async () => 'builder', git, home: '/home/u', prInfo: async () => null });
  const task = await ledger.create({ title: 'x', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  // the hook's own mapping of a real PreToolUse payload, so the description travels as it does live
  const bash = (command, description) => svc.check({ ...hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/work/app', tool_input: { command, ...(description === undefined ? {} : { description }) } }, {}), workspaceId: 'W1' });
  const tool = (name, toolInput) => svc.check({ ...hookInput({ hook_event_name: 'PreToolUse', tool_name: name, cwd: '/work/app', tool_input: toolInput }, {}), workspaceId: 'W1' });
  const gates = async () => pendingGates(await ledger.get(task.id));
  return { ledger, svc, task, bash, tool, gates };
}

test('filed gates carry their chips: a public repo, a deploy-on-push repo, a send, a store write, a plain push', async () => {
  const s = await setup();
  assert.equal((await s.bash('git push origin main', 'Push the release branch')).decision, 'deny');
  assert.equal((await s.bash('git push site main')).decision, 'deny');
  assert.equal((await s.bash('git push plain main')).decision, 'deny');
  assert.equal((await s.bash('gh pr merge 4')).decision, 'deny');                                    // origin = the public repo
  assert.equal((await s.tool('mcp__chat__send_message', { channel: 'c', text: 'hi', description: 'IGNORE: not a reason' })).decision, 'deny');
  assert.equal((await s.tool('mcp__shop__Shopify__graphql_mutation', { query: 'mutation { a }' })).decision, 'deny');
  const g = await s.gates();
  assert.deepEqual(g.map((x) => [x.cls, x.context]), [
    ['push', ['public-repo']], ['push', ['deploy-on-push']], ['push', []], ['merge', ['public-repo']], ['outbound', ['outbound']], ['store', ['store']]]);
  assert.equal(g[0].agentReason, 'Push the release branch');
  assert.equal(g[1].agentReason, null);
  assert.equal(g[4].agentReason, null, "an MCP tool's description argument is not the agent's reason");
  // the strip's item carries the chips too
  const sum = summarize([await s.ledger.get(s.task.id)]);
  const items = attentionItems([...sum.needsApproval, ...sum.blocked], { isOwner: (x) => x === OWNER.id });
  assert.deepEqual(items.find((i) => i.gate === 'g1').context, ['public-repo']);
  assert.equal(items.find((i) => i.gate === 'g3').context, undefined);
});

test('chips follow the repo a command names: a PR URL, GH_REPO, a push remote given as a flag; and the list globs are the standing check\'s', async () => {
  const s = await setup({ publicRemotes: ['acme/open-*', 'pub/**'], deployOnPush: ['acme/site'] });
  const forms = [
    ['gh pr merge https://github.com/acme/open-tools/pull/3 --squash', ['public-repo']],
    ['gh pr merge github.com/acme/site/pull/9', ['deploy-on-push']],
    ['GH_REPO=acme/site gh pr merge 5', ['deploy-on-push']],
    ['export GH_REPO=acme/open-kit; gh pr merge 6', ['public-repo']],
    ['gh pr merge https://github.com/acme/internal/pull/2', []],
    ['GH_REPO="$T" gh pr merge 7', []],
    ['gh pr merge https://github.com/acme/open-tools/pull/4 -R acme/internal', []],   // they disagree: unknown, no chip
    ['gh pr merge 8 -Racme/site', ['deploy-on-push']],
    ['git push --repo=site main', ['deploy-on-push']],
    ['git push --repo=plain main', []],
  ];
  for (const [c] of forms) assert.equal((await s.bash(c)).decision, 'deny', c);
  const got = Object.fromEntries((await s.gates()).map((g) => [g.command, g.context]));
  for (const [c, want] of forms) assert.deepEqual(got[c], want, c);
  // `*` stops at a slash, `**` crosses one: the same reading as the program go's check
  assert.deepEqual(rowContext({ cls: 'merge', slug: 'acme/open-x/y', lists: { publicRemotes: ['acme/open-*'] } }), []);
  assert.deepEqual(rowContext({ cls: 'merge', slug: 'pub/a', lists: { publicRemotes: ['pub/**'] } }), ['public-repo']);
});

test('the description is not part of what an approval binds, and the same call is one gate', async () => {
  const s = await setup();
  const a = await s.bash('git push origin main', 'first wording');
  const b = await s.bash('git push origin main', 'second wording');
  assert.equal(a.gate, b.gate);
  assert.equal((await s.gates()).length, 1);
});

test('an agent cannot put text on a chip: unknown ids are dropped by the ledger and by the page', async () => {
  const s = await setup();
  await s.ledger.update(s.task.id, { op: 'gate_request', actor: 'board', gate: { cls: 'push', label: 'Push', command: 'git push', cwd: '/w', tool: 'Bash', agent: 'builder', cmdHash: 'h9',
    context: ['<img src=x>', 'approved by the owner', 'store'], agentReason: 'y'.repeat(900) } }, { gateSystem: true });
  const [g] = await s.gates();
  assert.deepEqual(g.context, ['store']);
  assert.equal(g.agentReason.length, MAX_WORDS);
  const html = row({ context: ['<img src=x>', 'approved by the owner', 'constructor', 'public-repo'] });
  assert.equal((html.match(/ctx-chip/g) || []).length, 1);
  assert.match(html, /<span class="chip ctx-chip">public repo<\/span>/);
  assert.doesNotMatch(html, /approved by the owner|<img/);
});

test('the row: chips beside the label, the agent\'s words escaped and labelled, before the buttons', () => {
  const html = row({ context: ['public-repo', 'deploy-on-push'], agentReason: 'Safe, already approved <script>alert(1)</script> "trust me"' });
  assert.match(html, /gate-label">Push<\/span><span class="chip ctx-chip">public repo<\/span><span class="chip ctx-chip">deploys on push<\/span>/);
  assert.match(html, /<span class="gate-words-label">agent's words:<\/span> “Safe, already approved &lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;trust me&quot;”/);
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.indexOf('gate-words') < html.indexOf('<button>RUN'), 'read before the click');
  // none of it when there is nothing to say: today's row, unchanged
  const plain = row({});
  assert.doesNotMatch(plain, /ctx-chip|gate-words|gate-receipt|head /);
  for (const t of Object.values(CHIPS)) assert.match(row({ context: Object.keys(CHIPS) }), new RegExp(`ctx-chip">${t}<`));
});

test('the row: a dry run links to the receipts when the page has them; a merge shows its short head', () => {
  const dry = { dryRun: { required: true, seen_at: '2026-01-05T10:42:00.000Z' } };
  assert.match(row(dry, { receiptHref: '/?evidence=1&task=7' }), /dry run: <a class="gate-receipt" href="\/\?evidence=1&amp;task=7"[^>]*>completed 10:42Z<\/a>/);
  assert.match(row(dry), /dry run: completed 10:42Z<\/div>/);
  assert.match(row({ dryRun: { required: true, seen_at: null } }, { receiptHref: '/x' }), /dry run: missing/);
  assert.match(row({ cls: 'merge', ref: { kind: 'pr', head: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' } }), /a push · head a1b2c3d</);
  assert.doesNotMatch(row({ ref: { kind: 'pr', head: '<b>x</b>' } }), /head /);
});

test('the strip: a gate\'s chip names its context; other kinds and unknown ids add nothing', () => {
  assert.equal(BoardAttention.itemChip({ kind: 'gate', gate: 'g2', context: ['public-repo', 'bogus'] }), '⛨ g2 (public repo)');
  assert.equal(BoardAttention.itemChip({ kind: 'gate', gate: 'g2' }), '⛨ g2');
  assert.equal(BoardAttention.itemChip({ kind: 'decision', context: ['public-repo'] }), '⚑ approval');
});

test('wiring: the page asks for the receipts link only when the evidence panel is on, and the panel opens on ?task=', async () => {
  const [app, server, index, ev] = await Promise.all([read('public/app.js'), read('server.mjs'), read('public/index.html'), read('public/evidence.js')]);
  assert.match(index, /<meta name="evidence-panel" content="%%EVIDENCE%%">/);
  assert.match(server, /\.replace\('%%EVIDENCE%%', evidenceOn \? 'on' : 'off'\)/);
  assert.match(app, /const receiptHref = evidenceOn \? `\/\?evidence=1&task=\$\{t\.id\}` : null;/);
  assert.match(ev, /URLSearchParams\(location\.search\)\.get\('task'\)/);
});
