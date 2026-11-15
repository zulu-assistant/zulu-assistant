import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, CHECKS, DEFAULT_POLICY } from '../src/gates.mjs';
import { readChecks, replay, FIXED } from '../scripts/gate-replay.mjs';

// Task #501: a program that runs its arguments, in front of a held call. Two parts.
//  - parser fixes, no switch: value flags of the wrappers the parser already strips, zsh's words, plain launchers;
//  - check `runners` (observe by default): a program no rule names, with a gated call among its words.
// Samples are classified, never run.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODES = ['off', 'observe', 'enforce'];
const policyAt = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), runners: mode } });
const ctx = { home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', git: () => null, ignoreCase: false };
const run = (command, mode = 'enforce', extra = {}) => classify({ tool: 'Bash', command, cwd: '/work/app' }, policyAt(mode), { ...ctx, ...extra });

const CALLS = [['gh pr merge 3', 'merge'], ['git push origin main', 'push'], ['vercel --prod', 'deploy']];
// held in every mode: the word in front only runs what follows
const WRAPPERS = ['exec -a x', 'timeout -s KILL 5', 'timeout -k 1 5', 'caffeinate -t 5', 'caffeinate -w 1', 'sudo -D /tmp', 'sudo -h host', 'sudo -C 3', 'sudo -T 5', 'sudo -p prompt', 'sudo -R /',
  'noglob', 'nocorrect', '-', 'repeat 1', 'env noglob', 'arch', 'arch -arm64', 'stdbuf -o0', 'stdbuf -o 0', 'setsid', 'doas', 'doas -u root', 'chronic', 'unbuffer', 'rlwrap', 'ionice -c 3',
  'taskpolicy -b', 'gtimeout 5', 'gnice', 'genv', 'genv X=1', 'gstdbuf -o0', 'nice -n 5', 'nohup caffeinate -t 5 noglob'];
// held by the check: a program no rule names
const RUNNERS = ['npx', 'npx -y', 'bunx', 'pnpm exec', 'pnpm dlx', 'pnpm', 'yarn', 'yarn dlx', 'npm exec --', 'uv run', 'uvx', 'pipx run', 'poetry run', 'pipenv run', 'bundle exec',
  'op run --', 'direnv exec .', 'mise exec --', 'mise x --', 'asdf exec', 'dotenv --', 'dotenvx run --', 'doppler run --', 'infisical run --', 'aws-vault exec p --',
  'script -q /dev/null', 'sandbox-exec -n no-network', 'chroot /', 'flock /tmp/l', 'lldb --', 'dtruss', 'strace', 'ltrace',
  'docker exec c', 'docker compose exec c', 'docker run --rm img', 'at now', 'launchctl submit -l x --', 'systemd-run'];
const QUOTED = ['nix-shell --run', 'tmux new -d', 'screen -dm sh -c', 'expect -c', 'trap'];
const FREE = ['npx vitest', 'npm run build', 'uv run pytest', 'docker exec c ls', 'npm install vercel', 'brew install gh', 'pip install shopify', 'pnpm add vercel', 'npm view vercel', 'yarn why vercel',
  'docker run --rm img echo hi', 'make test', 'npx tsc --noEmit', 'uv run python3 scripts/report.py', 'bundle exec rake test', 'op run -- npm test', 'direnv exec . ls', 'docker exec c git status',
  'scripts/task.sh comment 5 "then run gh pr merge 5 and git push origin main"', 'scripts/agent-send.sh helper "please do the gh pr merge 5 now" --task 5', 'mytool note "vercel --prod went out"',
  'mise exec -- node --version', 'docker exec c gh pr view 3', 'npx vercel env ls', 'timeout 5 ls', 'noglob ls *.md', 'caffeinate -t 5 npm test', 'trap "echo bye" EXIT', 'tmux new -d "npm test"', 'repeat 3 echo hi'];

test('parser fixes (no switch): a wrapper\'s value flag, a zsh word or a plain launcher in front never hides the call', () => {
  for (const w of WRAPPERS) for (const [call, cls] of CALLS) for (const m of MODES) {
    const r = run(`${w} ${call}`, m); assert.equal(r.verdict, 'gate', `${m}: ${w} ${call} → ${r.why}`); assert.equal(r.cls, cls, `${w} ${call}`); assert.equal(r.check, undefined);
  }
  // the old reading, kept only so the replay tool can count what the fix newly holds
  assert.equal(run('noglob gh pr merge 3', 'off', { legacyParser: true }).verdict, 'clear');
  assert.equal(run('caffeinate -t 5 gh pr merge 3', 'off', { legacyParser: true }).verdict, 'clear');
});

test('runners: a program no rule names, with a held call among its words, in every mode', () => {
  for (const w of RUNNERS) for (const [call, cls] of CALLS) {
    const c = `${w} ${call}`;
    const off = run(c, 'off'); assert.equal(off.verdict, 'clear', `off: ${c} → ${off.why}`); assert.equal(off.wouldHold, undefined);
    const obs = run(c, 'observe'); assert.equal(obs.verdict, 'clear', `observe: ${c}`); assert.equal(obs.wouldHold?.check, 'runners', `observe: ${c}`); assert.equal(obs.wouldHold.cls, cls, c);
    const enf = run(c); assert.equal(enf.verdict, 'gate', `${c} → ${enf.why}`); assert.equal(enf.cls, cls, c); assert.equal(enf.check, 'runners'); assert.match(enf.why, / runs: /);
  }
  for (const w of QUOTED) for (const [call, cls] of CALLS) { const c = `${w} "${call}"`; const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, cls, c); assert.equal(run(c, 'off').verdict, 'clear', c); }
  // scripts with a write flag behind a runner: the dry form is the same call without the flag
  for (const c of ['bunx tsx sync.ts --commit', 'poetry run python3 sync.py --apply', 'yarn node x.mjs --commit', 'docker exec c ./run.sh --apply', 'op run -- node x.mjs --commit']) {
    const r = run(c); assert.equal(r.cls, 'write', c); assert.equal(r.requireDryRun, true); assert.deepEqual(r.dryTokens, c.split(' ').filter((t) => !/^--(commit|apply)$/.test(t)), c);
  }
  assert.equal(DEFAULT_POLICY.checks.runners, 'observe');
});

test('what stays free: runners in front of ordinary work, and a package named like a gated program', () => {
  for (const m of MODES) for (const c of FREE) { const r = run(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.cls}: ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
  // what a rule held before, it holds the same way
  for (const m of MODES) { assert.equal(run('gh pr merge 3', m).cls, 'merge'); assert.equal(run('sudo -u x gh pr merge 3', m).cls, 'merge'); assert.equal(run('npx prettier --write src', m).cls, 'write'); }
});

// ── the real hook script with real hook JSON, board down ──
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
function hookCopy(mode) {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate runners-'))), 'Repo With Space');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(policyAt(mode)));
  return dir;
}
const hookOut = (dir, command) => spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: JSON.stringify({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } }), env, encoding: 'utf8' }).stdout;
const decisionOf = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass');

test('real hook JSON: the fast path sends these to the Node step; off and observe answer alike; enforce denies', () => {
  const dirs = Object.fromEntries(MODES.map((m) => [m, hookCopy(m)]));
  const byCheck = ['npx vercel --prod', 'op run -- gh pr merge 3', 'docker exec c git push origin main', 'nix-shell --run "gh pr merge 3"', 'uv run gh pr merge 3'];
  const byParser = ['noglob gh pr merge 3', 'caffeinate -t 5 gh pr merge 3', 'timeout -s KILL 5 vercel --prod', 'arch -arm64 git push origin main'];
  for (const c of byCheck) { const off = hookOut(dirs.off, c); assert.equal(hookOut(dirs.observe, c), off, c); assert.equal(off, '', c); assert.equal(decisionOf(hookOut(dirs.enforce, c)), 'deny', c); }
  for (const c of byParser) for (const m of MODES) assert.equal(decisionOf(hookOut(dirs[m], c)), 'deny', `${m}: ${c}`);
  for (const c of ['npx vitest', 'npm run build', 'uv run pytest', 'docker exec c ls', 'npm install vercel']) for (const m of MODES) assert.equal(hookOut(dirs[m], c), '', `${m}: ${c}`);
});

test('replay: past calls with a runner in front are counted, by check and by the word in front', () => {
  const line = (o) => JSON.stringify({ at: '2026-01-05T10:00:00.000Z', event: 'pre', agent: 'builder', tool: 'Bash', decision: 'pass', cwd: '/work/app', ...o });
  const log = [line({ command: 'npx vercel --prod' }), line({ at: '2026-01-05T11:00:00.000Z', command: 'npx vercel --prod', agent: 'helper' }), line({ at: '2026-01-05T12:00:00.000Z', command: 'noglob gh pr merge 3' }),
    line({ at: '2026-01-05T13:00:00.000Z', command: 'npx vitest' }), line({ at: '2026-01-05T14:00:00.000Z', command: 'gh pr merge 3', decision: 'deny' })].join('\n');
  const r = replay(readChecks(log), DEFAULT_POLICY, { home: '/home/u', root: '/work/board' });
  assert.deepEqual(r.byCheck, { runners: 2, [FIXED]: 1 }); assert.deepEqual(r.byAgent, { builder: 2, helper: 1 });
  assert.deepEqual(r.byForm, { npx: 2, noglob: 1 });
});

// ── the review of PR 124 ──
test('review 1: the words that run what follows them (eval, xargs, watch, ssh, parallel) are read like any runner', () => {
  const rows = ['eval "vercel --prod"', 'eval vercel --prod', 'echo x | xargs vercel --prod', 'echo x | xargs -I{} vercel --prod', 'watch vercel --prod', 'watch -n 5 vercel --prod', 'ssh build-host vercel --prod',
    'ssh -t build-host "cd app && vercel --prod"', 'parallel vercel --prod ::: 1'];
  for (const c of rows) {
    const off = run(c, 'off'); assert.equal(off.verdict, 'clear', `off: ${c} → ${off.why}`);
    const obs = run(c, 'observe'); assert.equal(obs.verdict, 'clear', `observe: ${c}`); assert.equal(obs.wouldHold?.check, 'runners', `observe: ${c}`);
    const enf = run(c); assert.equal(enf.verdict, 'gate', `${c} → ${enf.why}`); assert.equal(enf.cls, 'deploy', c); assert.equal(enf.check, 'runners');
  }
  // the same words in front of a call whose rule carries subcommand words were held before (as unreadable) and still are, in every mode
  for (const m of MODES) for (const c of ['eval "gh pr merge 5"', 'echo x | xargs gh pr merge 5', 'watch gh pr merge 5', 'ssh host gh pr merge 5', 'echo 5 | xargs shopify app deploy', 'watch "shopify theme push"']) assert.equal(run(c, m).verdict, 'gate', `${m}: ${c}`);
  for (const m of MODES) for (const c of ['echo x | xargs ls', 'watch gh pr checks 5', 'ssh host ls -la', 'eval "$(ssh-agent)"', 'find . -name "*.log" | xargs wc -l', 'echo a | xargs echo vercel --prod', 'parallel echo ::: vercel shopify',
    'ssh host "cd app && git status"', 'watch -n 2 "ls -la"', 'echo x | xargs grep -l vercel', 'watch grep -c vercel build.log']) { const r = run(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.cls}: ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
});

test('the re-read of PR 124: the stop at a text program applies to the runner\'s first word only, never to a flag\'s value or a name', () => {
  // each ran the deploy and read clear on the head before: the text word is a flag's value, or a name the runner takes
  for (const c of ['npx -p echo vercel --prod', 'npx --package jq vercel --prod', 'uv run --with jq vercel --prod', 'bunx -p cat vercel --prod', 'docker exec -w grep c vercel --prod', 'docker exec -e sed c vercel --prod',
    'op run --env-file head -- vercel --prod', 'docker exec echo vercel --prod', 'docker run --rm --name cat img vercel --prod', 'pnpm --filter ls exec vercel --prod', 'echo a | xargs -I jq vercel --prod', 'ssh grep vercel --prod']) {
    const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'deploy', c); assert.equal(r.check, 'runners');
    assert.equal(run(c, 'off').verdict, 'clear', `off: ${c}`); assert.equal(run(c, 'observe').wouldHold?.check, 'runners', `observe: ${c}`);
  }
  // the price, on the asking side: a text program further on, with a gated program's name as its argument, is read as a call
  for (const c of ['docker exec c grep -r vercel .', 'echo a | xargs -n1 echo vercel']) assert.equal(run(c).check, 'runners', c);
});

test('review 2: what find runs on what it finds is read, up to the ; or +', () => {
  // (the samples carry the backslash the shell needs in front of the semicolon)
  for (const c of ['find . -name x -exec vercel --prod \\;', 'find . -name x -execdir vercel --prod +', 'find . -name x -ok vercel --prod \\;', 'find . -name x -okdir vercel --prod \\;', "find . -name x -exec vercel --prod ';'"]) {
    assert.equal(run(c, 'off').verdict, 'clear', `off: ${c}`); assert.equal(run(c, 'observe').wouldHold?.check, 'runners', `observe: ${c}`);
    const enf = run(c); assert.equal(enf.verdict, 'gate', `${c} → ${enf.why}`); assert.equal(enf.check, 'runners', c); assert.notEqual(enf.cls, 'delete', c);
  }
  for (const m of MODES) for (const c of ['find . -name x -exec wc -l {} \\;', 'find . -name "*.md" -exec grep -l vercel {} +', 'find . -name vercel', 'find . -name "vercel*" -print', 'find . -name x -exec ls -la {} \\;',
    'find . -name x -exec echo vercel --prod \\;'])
    assert.equal(run(c, m).verdict, 'clear', `${m}: ${c}`);
  // a call whose rule carries a gated word was held before (as unreadable) and still is, in every mode
  for (const m of MODES) for (const c of ['find src -type f -exec shopify theme push \\;', 'find . -maxdepth 0 -exec gh pr merge 5 \\;', 'find . -type f -name "*.json" -exec vercel deploy --prod {} +']) assert.equal(run(c, m).verdict, 'gate', `${m}: ${c}`);
});

test('review 3 (parser, no switch): value flags the tables missed', () => {
  for (const m of MODES) for (const c of ['arch -arch arm64 gh pr merge 5', 'env -P /usr/bin gh pr merge 5', 'sudo --user root gh pr merge 5', 'sudo --chdir /tmp gh pr merge 5', 'sudo --group wheel --user root gh pr merge 5',
    'time -o out.txt gh pr merge 5', 'time -f %e gh pr merge 5', 'env --chdir /tmp gh pr merge 5', 'env --unset X gh pr merge 5', 'sudo --user=root gh pr merge 5', 'arch -arch x86_64 -e X=1 vercel --prod']) {
    const r = run(c, m); assert.equal(r.verdict, 'gate', `${m}: ${c} → ${r.why}`); assert.equal(r.check, undefined, c);
  }
  for (const c of ['arch -arch arm64 npm test', 'sudo --user root ls', 'time -o out.txt npm test', 'env -P /usr/bin node --version']) assert.equal(run(c).verdict, 'clear', c);
});

test('the question: a program that takes a whole command line as one word', () => {
  for (const c of ['hyperfine "vercel --prod"', 'entr -s "vercel --prod"', 'watchexec "vercel --prod"']) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.check, 'runners'); assert.equal(run(c, 'off').verdict, 'clear', c); }
  for (const c of ['hyperfine "npm test"', 'entr -s "make test"', 'mytool "vercel --prod"']) assert.equal(run(c).verdict, 'clear', c);   // a program nobody listed stays unread, and the doc says so
});
