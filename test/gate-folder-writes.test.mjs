import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';

// Task #508 (left over from the second read of PR 117): inside a write-guarded folder, after a cd or with
// the call made from it. (1) the words of echo and printf are text, only their redirect writes; (2) the
// in-place sed form is held there as it is with the full path; (3) plutil's writing options are held in
// both forms, its print and lint options stay free. Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
const HOME = '/home/u'; const LA = `${HOME}/Library/LaunchAgents`; const APP = '/work/app';
const ctx = () => ({ home: HOME, boardRoot: '/home/u/Board Dir', ignoreCase: false, repoRoot: () => null, git: () => null });
const run = (command, cwd = APP) => classify({ tool: 'Bash', command, cwd }, policy, ctx());
const CD = 'cd ~/Library/LaunchAgents && ';

// [command, folder the call is made from]
const HELD = [
  // the in-place sed form: after the cd, from inside, with the full path, BSD and GNU spellings
  [`${CD}sed -i "" s/a/b/ com.x.plist`, APP], ['sed -i "" s/a/b/ com.x.plist', LA], ["sed -i '' -e s/a/b/ com.x.plist", LA], ['sed -i.bak s/a/b/ com.x.plist', LA], ['sed -i s/a/b/ com.x.plist', LA],
  ['sed -i "" s/a/b/ ~/Library/LaunchAgents/com.x.plist', APP], ['sed --in-place -e s/a/b/ -e s/c/d/ com.x.plist', LA],
  // plutil's writing options, in both forms
  [`${CD}plutil -replace Label -string x com.x.plist`, APP], ['plutil -replace Label -string x com.x.plist', LA], ['plutil -replace Label -string x ~/Library/LaunchAgents/com.x.plist', APP],
  ['plutil -insert Key -bool true com.x.plist', LA], ['plutil -insert Key -bool true ~/Library/LaunchAgents/com.x.plist', APP], ['plutil -remove Key com.x.plist', LA], [`plutil -remove Key ${LA}/com.x.plist`, APP],
  ['plutil -convert xml1 com.x.plist', LA],
  // -extract rewrites its input with the extracted value unless the output is the dash
  ['plutil -extract ProgramArguments xml1 com.x.plist', LA], [`${CD}plutil -extract Label raw com.x.plist`, APP], ['plutil -extract Label json ~/Library/LaunchAgents/com.x.plist', APP], ['plutil -extract Label xml1 -o ~/Library/LaunchAgents/new.plist /tmp/x.plist', APP], ['plutil -convert binary1 ~/Library/LaunchAgents/com.x.plist', APP], ['plutil -convert xml1 -o ~/Library/LaunchAgents/new.plist /tmp/x.plist', APP],
  // the writes that were held before still are
  ['echo x > com.x.plist', LA], [`${CD}printf '%s' x > com.x.plist`, APP], ['echo x >> ~/Library/LaunchAgents/com.x.plist', APP], [`${CD}cp /tmp/x.plist .`, APP], ['rm com.x.plist', LA], ['touch new.plist', LA],
];
const FREE = [
  // words of echo and printf are text
  [`${CD}echo hello`, APP], ['echo hello', LA], ['printf done', LA], [`${CD}printf '%s\\n' one two`, APP], ['echo com.x.plist', LA], [`${CD}echo "wrote com.x.plist"`, APP], ['echo ~/Library/LaunchAgents/com.x.plist', APP],
  // sed that only reads, plutil that only reads
  ['sed -n 1,5p com.x.plist', LA], [`${CD}sed -n /Label/p com.x.plist`, APP], ['sed s/a/b/ com.x.plist', LA],
  ['plutil -p com.x.plist', LA], [`${CD}plutil -p com.x.plist`, APP], ['plutil -lint com.x.plist', LA], ['plutil -lint ~/Library/LaunchAgents/com.x.plist', APP], ['plutil -convert json -o - com.x.plist', LA], ['plutil -extract Label raw -o - com.x.plist', LA], [`${CD}plutil -extract ProgramArguments json -o - com.x.plist`, APP], ['plutil -extract Label raw -o - ~/Library/LaunchAgents/com.x.plist', APP],
  ['plutil -extract Label xml1 -o /tmp/claude-x/label.plist com.x.plist', LA], ['plutil -type Label com.x.plist', LA],
  // the same writers elsewhere
  ['sed -i "" s/a/b/ notes.md', APP], ['plutil -replace K -string v Info.plist', APP], ['plutil -convert xml1 -o /tmp/claude-x/new.plist com.x.plist', LA], ['echo hello', APP], ['ls', LA], [`${CD}ls -la`, APP],
];

test('inside a write-guarded folder: echo and printf words are text, the in-place sed form and plutil\'s writing options are held', () => {
  for (const [c, cwd] of HELD) { const r = run(c, cwd); assert.equal(r.verdict, 'gate', `${c} (from ${cwd}) → ${r.why}`); assert.equal(r.cls, 'schedule', c); }
  for (const [c, cwd] of FREE) { const r = run(c, cwd); assert.equal(r.verdict, 'clear', `${c} (from ${cwd}) → ${r.cls}: ${r.why}`); }
  // the hold names the file, not the sed expression or a plutil key
  assert.match(run('sed -i "" s/a/b/ com.x.plist', LA).why, /com\.x\.plist/); assert.match(run('plutil -replace Label -string x com.x.plist', LA).why, /com\.x\.plist/);
});

test('a mention is still a mention for the read-guarded paths: echo of the token file\'s path is not the exemption', () => {
  // pathAny (any mention) keeps its reading; only the write rule treats echo's words as text
  const r = run('echo data/mesh-decision-token', '/home/u/Board Dir'); assert.equal(r.verdict, 'gate'); assert.equal(r.cls, 'self');
});

test('the same forms under selfProtect: a gate file in the live checkout', () => {
  const L = '/home/u/Board Dir';
  const p = { ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), selfProtect: 'enforce' } };
  const sp = (command) => classify({ tool: 'Bash', command, cwd: L }, p, { home: HOME, boardRoot: L, ignoreCase: false, repoRoot: () => L, git: () => null });
  for (const c of ['sed -i "" s/a/b/ src/gates.mjs', "sed -i '' -e s/a/b/ server.mjs", 'cd src && sed -i.bak s/a/b/ gates.mjs']) { const r = sp(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.check, 'selfProtect'); }
  for (const c of ['sed -n 1,5p src/gates.mjs', 'sed -i "" s/gates.mjs/x/ docs/notes.md', 'echo src/gates.mjs', 'plutil -p src/gates.mjs']) assert.equal(sp(c).verdict, 'clear', c);
});

// ── the real hook script with real hook JSON, board down, both sides ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
test('real hook JSON, board down: held forms are denied, free forms pass, after a cd and from inside the folder', () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate fold-')));
  const dir = path.join(base, 'Board Dir'); const home = path.join(base, 'home'); const la = path.join(home, 'Library', 'LaunchAgents'); const app = path.join(base, 'app');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policy)); mkdirSync(la, { recursive: true }); mkdirSync(app, { recursive: true });
  const env = { ...process.env, HOME: home, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const hook = (command, cwd) => { const out = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
    return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass'; };
  const held = [[`${CD}sed -i "" s/a/b/ com.x.plist`, app], ['sed -i "" s/a/b/ com.x.plist', la], [`${CD}plutil -replace Label -string x com.x.plist`, app], ['plutil -insert Key -bool true com.x.plist', la],
    ['plutil -remove Key ~/Library/LaunchAgents/com.x.plist', app], ['plutil -convert xml1 com.x.plist', la], ['plutil -extract Label raw com.x.plist', la], [`${CD}plutil -extract Label xml1 com.x.plist`, app], ['echo x > com.x.plist', la]];
  const free = [[`${CD}echo hello`, app], ['echo hello', la], ['printf done', la], [`${CD}plutil -p com.x.plist`, app], ['plutil -lint com.x.plist', la], ['plutil -extract Label raw -o - com.x.plist', la], ['sed -n 1,5p com.x.plist', la], ['plutil -replace K -string v Info.plist', app], ['sed -i "" s/a/b/ notes.md', app]];
  for (const [c, cwd] of held) assert.equal(hook(c, cwd), 'deny', `${c} (from ${cwd})`);
  for (const [c, cwd] of free) assert.equal(hook(c, cwd), 'pass', `${c} (from ${cwd})`);
});
