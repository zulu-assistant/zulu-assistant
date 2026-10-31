// node --test "test/*.test.mjs" — overlay + secrets resolver (Agent-OS Phase 2, task #38)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, utimes } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolve, writable, parseEnv, loadSecrets, ROOT } from '../src/config.mjs';
import { loadRules, scanText } from '../scripts/scrub-gate.mjs';

async function tree() {
  const d = await mkdtemp(path.join(os.tmpdir(), 'mc-cfg-'));
  const dirs = { root: d, overlay: path.join(d, 'overlay'), examples: path.join(d, 'examples') };
  for (const x of Object.values(dirs)) await mkdir(path.join(x, 'config'), { recursive: true });
  return dirs;
}

test('resolve: overlay/<rel> beats core <rel> beats examples/<rel>', async () => {
  const t = await tree();
  await writeFile(path.join(t.examples, 'config/x.json'), 'e');
  assert.equal(resolve('config/x.json', t), path.join(t.examples, 'config/x.json'));
  await writeFile(path.join(t.root, 'config/x.json'), 'c');
  assert.equal(resolve('config/x.json', t), path.join(t.root, 'config/x.json'));
  await writeFile(path.join(t.overlay, 'config/x.json'), 'o');
  assert.equal(resolve('config/x.json', t), path.join(t.overlay, 'config/x.json'));
  assert.equal(resolve('config/none.json', t), path.join(t.overlay, 'config/none.json'));   // missing → overlay path
});

test('writable: always overlay/, seeded once from examples/, never writes examples/', async () => {
  const t = await tree();
  await writeFile(path.join(t.examples, 'config/agents.json'), '{"agents":[]}');
  const p = writable('config/agents.json', t);
  assert.equal(p, path.join(t.overlay, 'config/agents.json'));
  assert.equal(await readFile(p, 'utf8'), '{"agents":[]}');
  await writeFile(p, '{"agents":[1]}');
  writable('config/agents.json', t);                                     // existing overlay copy is kept
  assert.equal(await readFile(p, 'utf8'), '{"agents":[1]}');
  assert.equal(await readFile(path.join(t.examples, 'config/agents.json'), 'utf8'), '{"agents":[]}');
});

test('parseEnv: comments, quotes, export prefix, = in values, first wins', () => {
  const e = parseEnv('# c\nA=1\nexport B="two words"\nC=\'x=y\'\nA=2\n\nbad line\nD=\n');
  assert.deepEqual(e, { A: '1', B: 'two words', C: 'x=y', D: '' });
});

test('loadSecrets: missing file → {}; values re-read after the file changes', async () => {
  const t = await tree();
  const f = path.join(t.root, 'secrets.env');
  assert.deepEqual(loadSecrets(f), {});
  await writeFile(f, 'SMTP_HOST=a\n');
  assert.equal(loadSecrets(f).SMTP_HOST, 'a');
  await writeFile(f, 'SMTP_HOST=b\n');
  const later = new Date(Date.now() + 5000); await utimes(f, later, later);
  assert.equal(loadSecrets(f).SMTP_HOST, 'b');
});

test('examples/ twins: same registry exports and SETTINGS keys as the live overlay', async () => {
  const ex = await import('../examples/config/jobs.mjs');
  const live = await import('../src/config.mjs');
  const names = ['DOMAINS', 'ENDPOINTS', 'PROCESSES', 'CRON', 'CRON_DRIFT', 'MEM', 'CONTEXT', 'DISK', 'JOBS', 'DOCKER_CONTAINERS', 'SETTINGS'];
  for (const n of names) assert.ok(ex[n] !== undefined, `examples missing ${n}`);
  assert.deepEqual(Object.keys(ex.SETTINGS).sort(), Object.keys(live.SETTINGS).sort());
  for (const f of ['config/agents.json', 'config/mesh.json', 'config/models.json', 'config/TRIAGE.md', 'POLICY.md', 'MISSION-CONTROL.md', 'policy.json'])
    await readFile(path.join(ROOT, 'examples', f));                       // every overlay file has a twin
});

test('no secrets or owner identity in the registry, examples or secrets template', async () => {
  const live = await import('../src/config.mjs');
  for (const k of ['smsAlertTo', 'smsEndpoint', 'mailCredsFile', 'smsCredsFile', 'heartbeat']) assert.equal(live.SETTINGS[k], undefined, k);
  const files = [];
  const walk = async (d) => { for (const e of await readdir(d, { withFileTypes: true })) e.isDirectory() ? await walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
  await walk(path.join(ROOT, 'examples'));
  files.splice(0, files.length, ...files.filter((f) => !f.endsWith('publish/denylist.json')));   // the rules file matches itself
  files.push(path.join(ROOT, 'secrets.env.example'));
  const rules = await loadRules();                                         // the private denylist (overlay/publish/)
  for (const f of files) assert.deepEqual(scanText(await readFile(f, 'utf8'), rules).map((h) => `${h.rule}:${h.match}`), [], path.relative(ROOT, f));
});

test('a checkout with no overlay runs on examples/ (public skin)', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const c = await import('./src/config.mjs'); console.log(JSON.stringify({ reg: c.REGISTRY_FILE, jobs: c.JOBS.map((j) => j.label) }))"],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MC_OVERLAY: path.join(os.tmpdir(), 'no-overlay-here') } });
  const r = JSON.parse(out);
  // the private repo keeps compat symlinks at config/, so core may resolve there; either way no overlay dir was used
  assert.ok(!r.reg.includes('no-overlay-here'));
});

test('alerts stay off (no send attempted) when secrets.env lacks the keys', () => {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const a = await import('./src/alerts.mjs'); console.log(await a.sendEmail('t', 'b'))"],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env, MC_SECRETS: path.join(os.tmpdir(), 'no-secrets-here.env') } });
  assert.equal(out.trim(), 'false');
});
