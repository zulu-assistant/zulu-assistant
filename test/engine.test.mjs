// node --test "test/*.test.mjs" — engine choice per role (scripts/engine.mjs)
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { engineFor, launchSpec, commandLine, codexInteractive } from '../scripts/engine.mjs';

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

test('codex interactive approvals and extra folders come from models.json; the default line is unchanged', () => {
  const base = ['codex', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
  assert.deepEqual(launchSpec('resident', { models: { engine: { resident: 'codex' } } }).argv, [...base, '-a', 'on-request']);
  const models = { engine: { resident: 'codex' }, codex: { approval: 'never', addDirs: ['~/.npm', '/opt/cache', '~/.npm'] } };
  const home = os.homedir();
  assert.deepEqual(launchSpec('resident', { models }).argv,
    [...base, '-a', 'never', '--add-dir', path.join(home, '.npm'), '--add-dir', '/opt/cache']);
  assert.equal(codexInteractive({ codex: { approval: 'untrusted' } }).approval, 'on-request');   // only the two known values
  assert.equal(codexInteractive({ codex: { approval: 'yolo' } }).approval, 'on-request');
});

test('codex addDirs never opens the home, the root, a relative path or a .. path', () => {
  const home = '/h/user';
  const r = codexInteractive({ codex: { addDirs: ['~', '~/', '/', 'rel/dir', '~/../other', '/a/../b', '/h/user', 7, null, '~/.cache'] } }, home);
  assert.deepEqual(r.addDirs, ['/h/user/.cache']);
  assert.deepEqual(codexInteractive({ codex: { addDirs: 'not-a-list' } }, home).addDirs, []);
});

test('codex addDirs skips a folder above the home and a link that leads to the home or above it', () => {
  const home = '/h/user';
  const links = { '/opt/link-home': '/h/user', '/opt/link-up': '/h', '/opt/link-cache': '/h/user/.cache' };
  const real = (p) => links[p] || p;
  const r = codexInteractive({ codex: { addDirs: ['/h', '/h/', '/opt/link-home', '/opt/link-up', '/opt/link-cache', '/h/username'] } }, home, real);
  assert.deepEqual(r.addDirs, ['/opt/link-cache', '/h/username']);   // a sibling whose name starts like the home is fine
});

test('an engine named for one launch wins over the role, and only a known engine', () => {
  const codexFleet = { engine: { resident: 'codex' } };
  assert.equal(launchSpec('resident', { engine: 'codex' }).engine, 'codex');
  assert.equal(launchSpec('resident', { models: codexFleet, engine: 'claude', name: 'r', model: 'm' }).argv.join(' '),
    'claude --name r --permission-mode acceptEdits --model m');
  assert.equal(launchSpec('resident', { engine: 'gpt' }).engine, 'claude');
  assert.equal(launchSpec('resident', { models: codexFleet, engine: '' }).engine, 'codex');
});

// #812: Gemini as a resident engine, approval mode always default
test('gemini runs a resident only, always with --approval-mode default; any other role reads as claude', () => {
  assert.equal(engineFor('resident', { engine: { resident: 'gemini' } }), 'gemini');
  for (const role of ['master', 'worker', 'triage']) assert.equal(engineFor(role, { engine: { [role]: 'gemini' } }), 'claude', role);
  // a resident does not inherit gemini from the worker setting (a worker cannot run it)
  assert.equal(engineFor('resident', { engine: { worker: 'gemini' } }), 'claude');
  assert.equal(commandLine(launchSpec('resident', { engine: 'gemini', name: 'r' })), 'gemini --approval-mode default');
  assert.equal(commandLine(launchSpec('resident', { models: { engine: { resident: 'gemini' }, gemini: { model: 'gemini-x' } } })), 'gemini --approval-mode default -m gemini-x');
  assert.equal(commandLine(launchSpec('resident', { engine: 'gemini', model: 'gemini-y' })), 'gemini --approval-mode default -m gemini-y');
  // models.json asking for another mode changes nothing
  const asks = { engine: { resident: 'gemini' }, gemini: { approval: 'yolo', approvalMode: 'auto_edit', yolo: true } };
  assert.equal(commandLine(launchSpec('resident', { models: asks })), 'gemini --approval-mode default');
  // --engine gemini for another role is the role's own engine
  assert.equal(launchSpec('worker', { engine: 'gemini' }).engine, 'claude');
  assert.equal(launchSpec('triage', { engine: 'gemini' }).engine, 'claude');
  // the Claude and Codex lines are unchanged by the third engine
  assert.equal(commandLine(launchSpec('resident', { name: 'resident-app', model: 'claude-opus-5-5' })),
    'claude --name resident-app --permission-mode acceptEdits --model claude-opus-5-5');
});

test('commandLine quotes anything unsafe', () => {
  assert.equal(commandLine({ argv: ['x', "it's", 'a b', 'ok-1'] }), "x 'it'\\''s' 'a b' ok-1");
});
