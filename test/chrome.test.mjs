// node --test "test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { desiredChrome, chromePlan, ownerPill, groupPlan, clip, domainTable, DEFAULT_DOMAIN_COLORS } from '../src/chrome.mjs';

const MC = { name: 'mission-control-main', kind: 'mission-control', vendor: 'claude', domain: 'ops', workspaceId: 'W-MC', owns: ['routing'], status: 'active' };
const DOCS = { name: 'web-docs', kind: 'resident', vendor: 'claude', domain: 'web', workspaceId: 'W-DOCS', owns: ['docs site: articles'], status: 'active' };
const CODEX = { name: 'app-ui-codex', kind: 'resident', vendor: 'codex', domain: 'app', workspaceId: 'W-UI', owns: ['frontend UI'], status: 'active' };
const NEW = { name: 'hand-made', kind: 'unassigned', vendor: 'claude', workspaceId: 'W-NEW', owns: [], needsOwnership: true, status: 'active' };

test('desiredChrome: domain color, codex hue, MC gets color but no description', () => {
  assert.deepEqual(desiredChrome(DOCS), { color: DEFAULT_DOMAIN_COLORS.web, description: 'WEB · docs site: articles' });
  assert.equal(desiredChrome(CODEX).color, DEFAULT_DOMAIN_COLORS.codex);
  assert.equal(desiredChrome(CODEX).description, 'APP · codex · frontend UI');
  assert.deepEqual(desiredChrome(MC), { color: '#28FE14', description: null });
  assert.deepEqual(desiredChrome(NEW), { color: null, description: 'needs ownership' });
  assert.equal(desiredChrome(DOCS, { domainColors: { web: '#123456' } }).color, '#123456');
});

test('clip cuts long descriptions at a word boundary', () => {
  const c = clip('APP · web templates/sections + data writers (release date, status badge)');
  assert.ok(c.length <= 64 && c.endsWith('…') && !c.includes('(…'));
});

test('chromePlan: fills empty, repairs our own drift, never overwrites a hand-set value', () => {
  const live = [
    { id: 'W-DOCS', custom_color: null, description: null },
    { id: 'W-UI', custom_color: '#E500E5', description: 'APP · codex · frontend UI' },   // old color WE set
    { id: 'W-MC', custom_color: '#FF0000', description: 'Owner typed this' },                  // hand-set
  ];
  const state = { 'W-UI': { color: '#E500E5' } };
  const { actions, manual } = chromePlan([DOCS, CODEX, MC], live, state);
  assert.deepEqual(actions.map((a) => `${a.name}:${a.action}`), ['web-docs:set-color', 'web-docs:set-description', 'app-ui-codex:set-color']);
  assert.deepEqual(manual.map((m) => `${m.name}:${m.field}`), ['mission-control-main:color'], 'MC description is never managed');
  const again = chromePlan([DOCS], [{ id: 'W-DOCS', custom_color: '#4a7cff', description: 'WEB · docs site: articles' }], {});
  assert.equal(again.actions.length, 0, 'idempotent, case-insensitive colors');
  assert.equal(chromePlan([{ ...DOCS, status: 'closed' }], live, {}).actions.length, 0);
});

const task = (id, status, checklist = {}) => ({ id, status, checklist: { docs_updated: false, vault_synced: false, graphify_updated: false, report_written: false, ...checklist } });

test('ownerPill: single task shows state + checklist progress', () => {
  assert.deepEqual(ownerPill([task(4, 'open')]).pill, { key: 'task', value: '#4 OPEN', icon: 'circle', color: '#157A15' });
  assert.deepEqual(ownerPill([task(4, 'open')]).progress, { value: 0, label: '#4 OPEN · 0/4' }, 'progress label carries the state for custom sidebars');
  const p = ownerPill([task(4, 'in_progress', { docs_updated: true, vault_synced: true })]);
  assert.equal(p.pill.value, '#4 WORKING');
  assert.deepEqual(p.progress, { value: 0.5, label: '#4 WORKING · 2/4' });
  assert.equal(ownerPill([task(4, 'needs_approval')]).pill.value, '#4 APPROVAL');
  assert.deepEqual(ownerPill([]), { pill: null, progress: null });
  assert.deepEqual(ownerPill([task(4, 'done')]), { pill: null, progress: null }, 'closed tasks clear the pill');
});

test('ownerPill: resident with several tasks shows the count, colored by the most urgent', () => {
  const p = ownerPill([task(1, 'open'), task(2, 'blocked'), task(3, 'in_progress')]);
  assert.equal(p.pill.value, '3 tasks · #2 BLOCKED');
  assert.equal(p.pill.color, '#FF8C3C');
  assert.deepEqual(p.progress, { value: 0, label: '3 tasks · #2 BLOCKED' });
  assert.equal(ownerPill([task(1, 'open'), task(3, 'in_progress')]).pill.value, '2 tasks');
});

test('groupPlan: one group per domain with ≥2 members, MC/resident anchors, codex joins its domain', () => {
  const worker = { name: 'agent-mesh', kind: 'worker', vendor: 'claude', domain: 'ops', workspaceId: 'W-AM', status: 'active' };
  const bot = { name: 'infra-bot', kind: 'resident', vendor: 'claude', domain: 'infra', workspaceId: 'W-K', status: 'active' };
  const app = { name: 'app-ops', kind: 'resident', vendor: 'claude', domain: 'app', workspaceId: 'W-SS', status: 'active' };
  const g = groupPlan([worker, CODEX, MC, DOCS, bot, app, { ...NEW, domain: 'ops', status: 'closed' }]);
  assert.deepEqual(g.map((x) => [x.name, x.anchor.name, x.members.length]), [['APP', 'app-ops', 2]],
    'MC is never grouped (a header hides its title), so OPS has one member and stays ungrouped');
});

test('domainTable: a config domain list replaces the defaults; groupPlan follows its order', () => {
  const t = domainTable({ domains: [{ id: 'x', label: 'X', color: '#111111', icon: 'i' }] });
  assert.equal(t.labels.x, 'X');
  assert.deepEqual(t.order, ['x']);
  assert.equal(t.colors.x, '#111111');
  assert.ok(t.colors.codex, 'codex hue is always present');
  assert.equal(t.labels.ops, undefined, 'defaults are replaced, not merged');
  const cfg = { domains: [{ id: 'b', label: 'BEE', color: '#222222' }, { id: 'a', label: 'AY', color: '#333333' }] };
  const e = (name, domain) => ({ name, kind: 'resident', vendor: 'claude', domain, workspaceId: `W-${name}`, status: 'active' });
  const g = groupPlan([e('a1', 'a'), e('a2', 'a'), e('b1', 'b'), e('b2', 'b')], cfg);
  assert.deepEqual(g.map((x) => x.name), ['BEE', 'AY']);
});

test('cmux.json patch sets only the chrome keys and keeps everything else (socket password)', async () => {
  const { patchConfig } = await import('../scripts/cmux-chrome-config.mjs');
  const cur = { automation: { socketPassword: 'x', socketControlMode: 'password' }, notifications: { sound: 'default' }, sidebar: { showAgentActivity: true } };
  const next = patchConfig(cur, { '~/platform-repo': 'platform', '~/tools-*': 'ops', '~/x': 'no-such-domain' });
  assert.deepEqual(next.automation, cur.automation);
  assert.deepEqual(next.sidebar, cur.sidebar);
  assert.equal(next.notifications.sound, 'default');
  assert.equal(next.notifications.paneFlashColor, '#28FE14');
  assert.equal(next.activePaneBorderColor, '#28FE14');
  assert.equal(next.paneBorderColor, '#0D5F0D');
  assert.equal(next.app.minimalMode, undefined, 'Tier 3 keys untouched');
  assert.equal(next.workspaceGroups.byCwd['~/platform-repo'].color, '#00E5E5');
  assert.equal(next.workspaceGroups.byCwd['~/x'], undefined, 'unknown domains are skipped');
  assert.deepEqual(patchConfig(next, { '~/platform-repo': 'platform', '~/tools-*': 'ops' }), next, 'idempotent');
});

// ---- sync-groups repair (2026-09-27: create always generates a placeholder anchor) ----
import { groupRepairPlan, isDisposablePlaceholder } from '../src/chrome.mjs';

const RWS = [{ id: 'W-MC', ref: 'workspace:1' }, { id: 'W-AM', ref: 'workspace:4' }, { id: 'W-GEN', ref: 'workspace:22' },
  { id: 'W-SS', ref: 'workspace:8' }, { id: 'W-UI', ref: 'workspace:21' }];
const OPS_PLAN = { domain: 'ops', name: 'OPS', anchor: { workspaceId: 'W-MC' }, members: [{ workspaceId: 'W-MC' }, { workspaceId: 'W-AM' }] };
const APP_PLAN = { domain: 'app', name: 'APP', anchor: { workspaceId: 'W-SS' }, members: [{ workspaceId: 'W-SS' }, { workspaceId: 'W-UI' }] };

test('groupRepairPlan repairs a generated-anchor group in place — no create, placeholder removed', () => {
  const groups = { groups: [{ name: 'OPS', ref: 'workspace_group:1', anchor_workspace_ref: 'workspace:22', anchor_workspace_is_generated: true,
    anchor_workspace_provenance: 'generated', member_workspace_refs: ['workspace:22', 'workspace:4', 'workspace:1'], custom_color: null, icon_symbol: null }] };
  const r = groupRepairPlan([OPS_PLAN], groups, RWS);
  assert.deepEqual(r.creates, []);
  assert.deepEqual(r.steps.map((s) => s.args.slice(1, 2)[0]), ['set-anchor', 'remove', 'set-color', 'set-icon']);
  assert.deepEqual(r.steps[0].args, ['workspace-group', 'set-anchor', '--group', 'workspace_group:1', '--workspace', 'W-MC']);
  assert.deepEqual(r.steps[1].args, ['workspace-group', 'remove', '--workspace', 'W-GEN']);
  assert.deepEqual(r.placeholders, ['W-GEN']);
});

test('groupRepairPlan: a correct group needs nothing; a missing one is created then re-anchored', () => {
  const ok = { groups: [{ name: 'OPS', ref: 'workspace_group:6', anchor_workspace_ref: 'workspace:1', anchor_workspace_is_generated: false,
    anchor_workspace_provenance: 'user', member_workspace_refs: ['workspace:1', 'workspace:4'], custom_color: '#28fe14', icon_symbol: 'terminal.fill' }] };
  assert.deepEqual(groupRepairPlan([OPS_PLAN], ok, RWS), { steps: [], creates: [], placeholders: [] });
  const r = groupRepairPlan([APP_PLAN], ok, RWS);
  assert.equal(r.creates.length, 1);
  assert.ok(r.creates[0].args.includes('--from') && r.creates[0].args.includes('W-SS,W-UI'));
  assert.deepEqual(r.steps.map((s) => s.args[1]), ['set-anchor', 'remove', 'set-color', 'set-icon']);
  assert.ok(r.steps[1].args.includes('<generated>') && r.steps[0].args.includes('<ref>'));
});

test('groupRepairPlan adds missing members to an existing group', () => {
  const g = { groups: [{ name: 'OPS', ref: 'workspace_group:6', anchor_workspace_ref: 'workspace:1', anchor_workspace_provenance: 'user',
    member_workspace_refs: ['workspace:1'], custom_color: '#28FE14', icon_symbol: 'terminal.fill' }] };
  assert.deepEqual(groupRepairPlan([OPS_PLAN], g, RWS).steps.map((s) => s.args), [['workspace-group', 'add', '--group', 'workspace_group:6', '--workspace', 'W-AM']]);
});

test('isDisposablePlaceholder: only known-generated, ungrouped, session-less, never-used workspaces', () => {
  const ctx = { knownPlaceholders: new Set(['W-GEN']), groupedIds: new Set(), sessionWorkspaces: new Set() };
  assert.ok(isDisposablePlaceholder({ id: 'W-GEN' }, ctx));
  assert.ok(!isDisposablePlaceholder({ id: 'W-MC' }, ctx), 'not known as generated');
  assert.ok(!isDisposablePlaceholder({ id: 'W-GEN' }, { ...ctx, groupedIds: new Set(['W-GEN']) }), 'still in a group');
  assert.ok(!isDisposablePlaceholder({ id: 'W-GEN' }, { ...ctx, sessionWorkspaces: new Set(['W-GEN']) }), 'a session ran there');
  assert.ok(!isDisposablePlaceholder({ id: 'W-GEN', latest_submitted_message: 'ls' }, ctx), 'someone used it');
});

// ---- verified input prompts → progress label (sidebars can't trust cmux needs_input) ----
import { withInput, inputPrompts } from '../src/chrome.mjs';

test('withInput prefixes the progress label; keeps the task pill', () => {
  const t = ownerPill([task(4, 'in_progress', { docs_updated: true })]);
  const w = withInput(t, 'permission');
  assert.equal(w.pill.value, '#4 WORKING');
  assert.deepEqual(w.progress, { value: 0.25, label: '▲ INPUT · #4 WORKING · 1/4' });
  assert.deepEqual(withInput(ownerPill([]), 'permission'), { pill: null, progress: { value: 0, label: '▲ INPUT · permission' } });
  assert.equal(withInput(t, null), t);
});

test('inputPrompts: Claude from the hook lifecycle, Codex from an on-screen dialog', async () => {
  const entries = [
    { name: 'docs', vendor: 'claude', workspaceId: 'W1', status: 'active' },
    { name: 'idle', vendor: 'claude', workspaceId: 'W2', status: 'active' },
    { name: 'cx', vendor: 'codex', workspaceId: 'W3', status: 'active' },
    { name: 'cx2', vendor: 'codex', workspaceId: 'W4', status: 'active' },
  ];
  const map = { activeSessionsByWorkspace: { W1: { sessionId: 's1' }, W2: { sessionId: 's2' } },
    sessions: { s1: { agentLifecycle: 'needsInput', lastSubtitle: 'Permission' }, s2: { agentLifecycle: 'running' } } };
  const run = async (args) => ({ err: null, out: args.includes('W3') ? 'DIALOG' : 'READY' });
  const classify = (out) => ({ state: out === 'DIALOG' ? 'dialog' : 'ready' });
  const p = await inputPrompts(entries, map, { run, classify });
  assert.deepEqual([...p], [['W1', 'permission'], ['W3', 'approval']]);
});
