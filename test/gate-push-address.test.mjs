import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, DEFAULT_POLICY, CHECKS } from '../src/gates.mjs';
import { createGateService, namesGhRepo } from '../src/gate-service.mjs';
import { createLedger } from '../src/tasks.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';
import { OWNER } from '../src/config.mjs';

// #552 (Mission Control's review of PR 148): the remote of a push can be told another way than its name, and the gate
// read the old one. A: the push address, settings for the one call, GIT_CONFIG_* variables, a remote added or re-pointed
// earlier in the same call, --repo. B: a github address inside a flag's value counted as naming the repository (Codex).
// C: the row of a Codex gh call whose repository is named. Real hook input; real scratch repositories for A.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUB = 'https://github.com/acme/public-app.git'; const PRIV = 'https://github.com/acme/private-app.git';
const claudeInput = (command, cwd) => ({ session_id: 's', transcript_path: '/t/x.jsonl', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'd' } });
const codexInput = (command, cwd) => ({ session_id: 's1', transcript_path: '/t/r.jsonl', cwd, hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default', turn_id: 't', tool_name: 'Bash', tool_use_id: 'c', tool_input: { command } });
const policy = { ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, 'off'])) };
policy.lists = { ...(policy.lists || {}), publicRemotes: ['acme/public-app'] };

async function repo(name = 'priv') {
  const dir = path.join(realpathSync(await mkdtemp(path.join(os.tmpdir(), 'push-addr-'))), name);
  const g = (...a) => execFileSync('git', ['-C', path.dirname(dir), ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'feature', name);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', PRIV], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { stdio: 'ignore' });
  return dir;
}
const git = (cwd, a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; } };
const read = (command, cwd) => {
  const i = hookInput(claudeInput(command, cwd), {});
  return classify({ tool: i.tool, command: i.command, cwd: i.cwd }, policy, { home: '/home/u', boardRoot: ROOT, git, repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']) });
};

test('A: the remote told another way in the call (real folder private, the push goes to the public repository)', async () => {
  const P = await repo();
  for (const text of [`git -c remote.origin.url=${PUB} push origin feature`, `git -c remote.origin.pushurl=${PUB} push origin feature`,
    `git remote add up ${PUB} && git push up feature`, `git remote set-url origin ${PUB}; git push origin feature`, `git push --repo=${PUB}`, `git push ${PUB} feature`]) {
    const v = read(text, P);
    assert.equal(v.verdict, 'gate', text); assert.match(v.why, /push to public remote acme\/public-app/, text);
  }
  // not literal, or a rule that rewrites addresses: asked
  for (const [text, why] of [[`git -c url.${PUB}.insteadOf=${PRIV} push origin feature`, /url\.\S+ set for the call/],
    [`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=${PUB} git push origin feature`, /GIT_CONFIG_\* variables/],
    ['git remote add up "$U" && git push up feature', /remote the same call changes \(git remote add\)/], [`git remote rename origin old; git push old feature`, /remote the same call changes \(git remote rename\)/],
    [`git config remote.origin.url ${PUB}; git push origin feature`, /git config changes a remote/], [`git --config-env=remote.origin.url=U push origin feature`, /--config-env/],
    // git takes the repository word over --repo (builtin/push.c): both, and different, is asked
    [`git push --repo=${PUB} feature`, /both --repo=\S+ and the repository feature/]]) {
    const v = read(text, P);
    assert.equal(v.verdict, 'gate', text); assert.match(v.why, why, text);
  }
  // what an honest agent writes with a private address, and the plain forms: read and free
  for (const text of [`git remote add up ${PRIV} && git push up feature`, 'git push origin feature', `git -c remote.origin.url=${PRIV} push origin feature`, `git push --repo=${PRIV}`])
    assert.equal(read(text, P).verdict, 'clear', text);
});

test('A: the repository\'s own push address and push rewrite rule are read', async () => {
  const P = await repo();
  execFileSync('git', ['-C', P, 'config', 'remote.origin.pushurl', PUB]);
  assert.match(read('git push origin feature', P).why, /push to public remote acme\/public-app/);
  const Q = await repo('q');
  execFileSync('git', ['-C', Q, 'config', `url.${PUB}.pushInsteadOf`, PRIV]);
  assert.match(read('git push origin feature', Q).why, /push to public remote acme\/public-app/);
});

test('A (MC review of PR 149, 1): a push with no repository word goes where git sends it; every push address is read', async () => {
  const withUp = async (name, ...settings) => {
    const R = await repo(name);
    execFileSync('git', ['-C', R, 'remote', 'add', 'upstream', PUB]);
    for (const [k, v] of settings) execFileSync('git', ['-C', R, 'config', k, v]);
    return R;
  };
  // origin private, upstream public: git picks branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote, then origin
  for (const settings of [[['branch.feature.remote', 'upstream'], ['branch.feature.merge', 'refs/heads/feature']], [['branch.feature.pushRemote', 'upstream']], [['remote.pushDefault', 'upstream']]]) {
    const R = await withUp('u', ...settings);
    assert.match(read('git push', R).why, /push to public remote acme\/public-app/, JSON.stringify(settings));
  }
  assert.equal(read('git push', await withUp('o')).verdict, 'clear');          // nothing set: origin, private
  // a second push address on the public list: git sends to both
  const two = await repo('two');
  execFileSync('git', ['-C', two, 'remote', 'set-url', '--add', '--push', 'origin', PRIV]);
  execFileSync('git', ['-C', two, 'remote', 'set-url', '--add', '--push', 'origin', PUB]);
  assert.match(read('git push origin feature', two).why, /push to public remote acme\/public-app/);
  // a set-url of the fetch address keeps an existing push address
  const kept = await repo('kept');
  execFileSync('git', ['-C', kept, 'config', 'remote.origin.pushurl', PUB]);
  assert.match(read(`git remote set-url origin ${PRIV} && git push origin feature`, kept).why, /push to public remote acme\/public-app/);
  // settings for the call, or commands of the call, that change which remote a push without a word uses: asked
  const P = await repo('p');
  for (const text of ['git -c branch.feature.pushRemote=upstream push', 'git -c remote.pushDefault=upstream push', 'git -c push.default=matching push origin',
    'git config branch.feature.remote upstream && git push', 'git switch other && git push', 'git branch -u upstream/feature && git push'])
    assert.equal(read(text, P).verdict, 'gate', text);
});

test('A (MC review of PR 149, 2): a substitution or a variable as the repository word is asked', async () => {
  const P = await repo();
  for (const text of [`git push "$(echo ${PUB})" feature`, `git push $(echo up) feature`, 'git push `echo up` feature', 'U=x; git push $U feature', 'git push --repo="$(echo u)"']) {
    const v = read(text, P);
    assert.equal(v.verdict, 'gate', text); assert.match(v.why, /cannot read/, text);
  }
});

// ── B and C: through the board ──
async function service(prHead = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'push-addr-svc-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  const prCalls = [];
  const svc = createGateService({
    root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', isPrivateRepo: async () => true, now: () => Date.parse('2026-01-05T10:00:00Z'),
    prInfo: async (cmd, cwd, opts) => { prCalls.push(opts || {}); return prHead ? { number: 5, title: 'T', head: 'f', base: 'main', headOid: prHead, repo: 'acme/app' } : null; },
    git: () => null,
  });
  const task = await ledger.create({ title: 'ship', requester: 'helper', owner: 'builder' });
  await ledger.update(task.id, { op: 'start', actor: 'builder' });
  const codex = (command) => svc.check({ ...hookInput(codexInput(command, '/work/session'), {}), workspaceId: 'W1' });
  return { codex, prCalls, gates: async () => (await ledger.get(task.id)).gates || [] };
}

test('B: an address inside a flag\'s value does not name the repository; a landing is filed only when its PR was read', async () => {
  const tok = (s) => ({ tokens: s.split(' ') });
  assert.equal(namesGhRepo({ tokens: ['gh', 'pr', 'merge', '5', '--squash', '--body', 'Closes https://github.com/acme/app/issues/3'] }), false);
  assert.equal(namesGhRepo({ tokens: ['gh', 'pr', 'merge', '5', '--squash', '-t', 'see github.com/acme/app'] }), false);
  assert.equal(namesGhRepo(tok('gh pr merge https://github.com/acme/app/pull/5 --squash')), true);
  assert.equal(namesGhRepo(tok('gh pr merge 5 -R acme/app')), true);
  const s = await service();
  for (const c of ['gh pr merge 5 --squash --body "Closes https://github.com/acme/app/issues/3"', 'gh pr merge 5 --squash -t "see github.com/acme/app"']) {
    const d = await s.codex(c);
    assert.equal(d.unfiled, true, c); assert.match(d.reason, /no repo named/, c);
  }
  assert.deepEqual(await s.gates(), []); assert.equal(s.prCalls.length, 0);
  const named = await s.codex('gh pr merge https://github.com/acme/app/pull/5 --squash');
  assert.equal(named.unfiled, undefined);
  const [g] = await s.gates();
  assert.match(g.why, /PR #5 "T"/); assert.equal(s.prCalls.length, 1);                     // read once; the row shows the PR it lands (1.2 records no head)
  // named, but the PR cannot be read: refused, never a row bound to nothing
  const t = await service(null);
  const d = await t.codex('gh pr merge 5 --squash -R acme/app');
  assert.equal(d.unfiled, true); assert.match(d.reason, /pull request could not be read/);
  assert.deepEqual(await t.gates(), []);
});

test('C: a Codex gh row whose repository is named says so', async () => {
  const s = await service();
  await s.codex('gh pr merge 5 --squash -R acme/app');
  const [g] = await s.gates();
  assert.equal(g.folderUnread, true); assert.equal(g.repoNamed, true);
  const ctx = {}; vm.runInNewContext(await readFile(path.join(ROOT, 'public', 'decide.js'), 'utf8'), { globalThis: ctx });
  const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = ctx.BoardDecide.gateRowHtml(g, { key: '1:g1', esc, age: '1m', open: false, actions: '' });
  assert.match(html, /folder not told by Codex \(session in \/work\/session\): the repository is named in the command/);
  assert.doesNotMatch(html, /repository not read/);
});
