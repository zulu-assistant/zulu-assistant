// node --test "test/*.test.mjs" — engine choice per role (scripts/engine.mjs)
import test from 'node:test';
import assert from 'node:assert/strict';
import { engineFor, launchSpec, commandLine } from '../scripts/engine.mjs';

test('engineFor: default claude; resident follows worker; unknown values fall back to claude', () => {
  assert.equal(engineFor('master', {}), 'claude');
  assert.equal(engineFor('resident', { engine: { worker: 'codex' } }), 'codex');
  assert.equal(engineFor('resident', { engine: { worker: 'codex', resident: 'claude' } }), 'claude');
  assert.equal(engineFor('triage', { engine: { triage: 'gpt' } }), 'claude');
});

test('claude launch lines are exactly what the fleet ran before the engine layer', () => {
  assert.equal(commandLine(launchSpec('worker', { name: 'fix-x', model: 'claude-opus-5-5' })),
    'claude --name fix-x --permission-mode auto --model claude-opus-5-5');
  assert.equal(commandLine(launchSpec('resident', { name: 'resident-app', model: 'claude-opus-5-5' })),
    'claude --name resident-app --permission-mode acceptEdits --model claude-opus-5-5');
  const t = launchSpec('triage', { model: 'm', allowed: 'Read,Bash(curl:*)', promptFile: '/x/TRIAGE.md' });
  assert.deepEqual(t.argv, ['claude', '-p', '--model', 'm', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Bash(curl:*)']);
  assert.equal(t.stdin, '/x/TRIAGE.md');
});

test('codex roles: workspace-write sandbox (network on), on-request approvals, optional model pins', () => {
  const models = { engine: { worker: 'codex', triage: 'codex' }, codex: { model: 'big', workerModel: 'small' } };
  const w = launchSpec('worker', { models, name: 'fix-x' });
  assert.deepEqual(w.argv, ['codex', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-a', 'on-request', '-m', 'small']);
  const t = launchSpec('triage', { models, promptFile: '/x/T.md' });
  assert.deepEqual(t.argv.slice(0, 2), ['codex', 'exec']);
  assert.ok(t.argv.includes('--skip-git-repo-check') && t.argv.at(-1) === '-' && !t.argv.includes('-a'));
  assert.ok(!launchSpec('worker', { models: { engine: { worker: 'codex' } } }).argv.includes('-m'));   // no pin → Codex default
});

test('commandLine quotes anything unsafe', () => {
  assert.equal(commandLine({ argv: ['x', "it's", 'a b', 'ok-1'] }), "x 'it'\\''s' 'a b' ok-1");
});
