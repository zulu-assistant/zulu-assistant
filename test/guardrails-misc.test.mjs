import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { renderPolicy, blockOf, withBlock } from '../scripts/policy-render.mjs';
import { mergeHooks, removeHooks } from '../scripts/merge-hooks.mjs';
import { demoBeats, GATE_AT, GATE_APPROVE_AT, T0 } from '../src/demo.mjs';
import { gateCard } from '../src/status.mjs';
import { policyProblems } from '../src/gate-service.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

test('POLICY.md\'s gates block is exactly what policy.json renders (both skins: examples always, overlay when present)', () => {
  for (const dir of ['examples', 'overlay']) {
    if (!existsSync(path.join(ROOT, dir, 'policy.json'))) continue;
    const policy = JSON.parse(read(`${dir}/policy.json`));
    assert.deepEqual(policyProblems(policy), [], `${dir}/policy.json`);
    assert.equal(blockOf(read(`${dir}/POLICY.md`)), renderPolicy(policy), `${dir}/POLICY.md is stale: node scripts/policy-render.mjs --write ${dir}/POLICY.md ${dir}/policy.json`);
  }
  const md = withBlock('# P\n\nprose\n', renderPolicy(JSON.parse(read('examples/policy.json'))));
  assert.ok(md.startsWith('# P\n\nprose\n') && blockOf(md));
  assert.equal(withBlock(md, 'X'.repeat(0) + renderPolicy(JSON.parse(read('examples/policy.json')))), md);   // idempotent
});

test('installing and removing the gate hook is idempotent and leaves other hooks alone', () => {
  const tpl = JSON.parse(read('examples/claude/guardrails-hooks.json.tmpl').replace(/__REPO__/g, '/r').replace(/__NODE_BIN_DIR__/g, '/n'));
  const mine = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-guard' }] }] } };
  const once = mergeHooks(mine, tpl); const twice = mergeHooks(once.settings, tpl);
  assert.equal(once.added, 2); assert.equal(twice.added, 0);
  const gone = removeHooks(once.settings, 'scripts/gate-hook.sh');
  assert.equal(gone.removed, 2);
  assert.deepEqual(gone.settings, mine);
  const codex = JSON.parse(read('examples/codex/guardrails-hooks.json.tmpl'));
  assert.ok(codex.hooks.PreToolUse[0].hooks[0].timeout >= 1000, 'codex timeouts are milliseconds');
});

test('demo mode scripts a gate: filed, then approved and run once', () => {
  const base = T0;   // the demo cycle starts when the module loads
  const beats = (a, b) => demoBeats(base + a * 1000, base + b * 1000);
  assert.ok(beats(GATE_AT - 1, GATE_AT + 1).some((x) => x.gate === 'file'));
  assert.ok(beats(GATE_APPROVE_AT - 1, GATE_APPROVE_AT + 1).some((x) => x.gate === 'approve'));
});

test('guardrails card: amber while waiting or the hook is missing, red only for a broken policy, stale when old', () => {
  const now = 1e12;
  assert.equal(gateCard(null), null);
  assert.equal(gateCard({ status: 'ok', detail: 'enforce', at: now }, now).status, 'ok');
  assert.equal(gateCard({ status: 'warn', detail: '1 waiting', at: now }, now).status, 'warn');
  assert.equal(gateCard({ status: 'failed', detail: 'hook: claude MISSING', at: now }, now).status, 'warn');
  assert.equal(gateCard({ status: 'failed', detail: 'policy invalid (x)', at: now }, now).status, 'failed');
  assert.equal(gateCard({ status: 'ok', detail: '', at: now - 11 * 60e3 }, now).status, 'stale');
});
