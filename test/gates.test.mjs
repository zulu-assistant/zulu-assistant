import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, isEnforced, parseCommand, triggerLines, compileTriggers, ereToJs, normalizeForTriggers, cmdHash, dryTokens, dryHash, repoSlug, globMatch, DEFAULT_POLICY } from '../src/gates.mjs';

// neutral fixtures: a repo at /work/app, a board checkout at /work/board, home /home/u
const policy = structuredClone(DEFAULT_POLICY);
policy.lists.paidOrOutbound = ['com.example.sender'];
policy.lists.publicRemotes = ['acme-public/*'];
policy.lists.deployOnPush = ['acme/site'];
const remotes = { origin: 'git@github.com:acme/app.git', pub: 'https://github.com/acme-public/tool.git', site: 'git@github.com:acme/site.git' };
const ctx = {
  home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', triggers: compileTriggers(policy),
  git: (cwd, args) => (args[0] === 'remote' ? remotes[args[2]] || null : args[0] === 'rev-parse' ? ctx.branch : null), branch: 'feature-x',
};
const run = (command, extra = {}) => classify({ tool: 'Bash', command, cwd: '/work/app', ...extra }, policy, ctx);
const gated = (command, cls, extra) => { const r = run(command, extra); assert.equal(r.verdict, 'gate', `${command} → ${r.verdict} (${r.why})`); if (cls) assert.equal(r.cls, cls, `${command} → ${r.cls} (${r.why})`); return r; };
const clear = (command, extra) => { const r = run(command, extra); assert.equal(r.verdict, 'clear', `${command} → gated ${r.cls}: ${r.why}`); return r; };

test('parser: separators, quotes, substitutions, heredocs, comments', () => {
  const p = parseCommand(`A=1 sudo -u x gh pr merge 3 && echo "ok; gh pr merge" | tee out.txt > log 2>&1; (cd sub && git push)`);
  const bins = p.cmds.filter((c) => c.bin).map((c) => c.bin);
  assert.deepEqual(bins, ['gh', 'echo', 'tee', 'cd', 'git']);
  assert.deepEqual(p.cmds.find((c) => c.bin === 'tee').redirects, ['log']);
  const h = parseCommand(`cat > x.sh <<'EOF'\ngh pr merge 9\nEOF\nbash <<EOF\ngit push origin main\nEOF`);
  assert.deepEqual(h.data, ['gh pr merge 9']);
  assert.ok(h.cmds.some((c) => c.bin === 'git'));
  const s = parseCommand('echo $(gh pr merge 1) `vercel --prod`');
  assert.ok(s.cmds.some((c) => c.bin === 'gh') && s.cmds.some((c) => c.bin === 'vercel'));
  assert.deepEqual(parseCommand('ls # gh pr merge 1').data, [' gh pr merge 1']);
});

test('fast path: the shell trigger lines and the JS twins agree; quotes and escapes do not hide a hit', () => {
  const lines = triggerLines(policy);
  assert.ok(lines.length > 10 && lines.every((l) => ereToJs(l)));
  const hit = (s) => ctx.triggers.some((t) => t.re.test(normalizeForTriggers(`tool_name:Bash ${s}`)));
  assert.ok(hit('gh "pr" merge 3'), 'quoted words');
  assert.ok(hit('true\\ngh pr merge 3'), 'JSON newline escape');
  assert.ok(hit('/opt/x/bin/gh pr merge 3'), 'absolute path');
  assert.ok(!hit('git status && ls -la src && node --test'));
  assert.ok(!hit('npm test'));
});

test('merge, deploy, env, schedule: gated forms and the look-alikes that are not', () => {
  gated('gh pr merge 38 --merge --delete-branch', 'merge');
  gated('/opt/homebrew/bin/gh pr merge 1', 'merge');
  gated('gh -R acme/app pr merge 2', 'merge');
  clear('gh pr view 38 && gh pr list');
  clear('gh pr create --title "merge the docs"');
  gated('vercel --prod', 'deploy');
  gated('vercel deploy', 'deploy');
  clear('vercel env ls');
  gated('launchctl bootout gui/501/com.example.web', 'deploy-local');                // this machine, not paid/outbound
  gated('launchctl bootstrap gui/501 /home/u/Library/LaunchAgents/com.example.web.plist', 'deploy-local');
  gated('launchctl bootout gui/501/com.example.sender', 'deploy');                   // paid/outbound: per-action
  gated('launchctl bootstrap gui/501 /home/u/Library/LaunchAgents/com.example.sender.plist', 'deploy');
  gated('launchctl kickstart -k gui/501/com.example.sender', 'deploy');
  clear('launchctl kickstart -k gui/501/com.example.board');      // not paid/outbound: on the owner's ALLOW list
  clear('launchctl print gui/501/com.example.board');
  gated('gh secret set TOKEN < f', 'env');
  clear('gh secret list');
  gated('crontab -r', 'schedule'); gated('crontab my.cron', 'schedule');
  clear('crontab -l');
  gated('cp x.plist ~/Library/LaunchAgents/com.x.plist', 'schedule');
  clear('cat ~/Library/LaunchAgents/com.x.plist');
});

test('push: protected refs, force, tags, deletes, public remotes and deploy-on-push repos gate; feature branches do not', () => {
  clear('git push -u origin feature-x');
  clear('git push origin checkpoint/2026-10-31');
  gated('git push origin main', 'push');
  gated('git push origin HEAD:main', 'push');
  gated('git push --force origin feature-x', 'push');
  gated('git push -f origin feature-x', 'push');
  gated('git push origin +feature-x', 'push');
  gated('git push origin :old-branch', 'push');
  gated('git push --tags', 'push');
  gated('git push origin v1.0.0', 'push');
  gated('git push pub feature-x', 'push');                         // public remote: any ref
  gated('git push site feature-x', 'push');                        // deploys on push: any ref
  ctx.branch = 'main'; gated('git push', 'push'); ctx.branch = 'feature-x';
  clear('git push');
  gated('git -C /work/other push origin master', 'push');
  clear('git log --grep push && git status');
});

test('guarded scripts: the write form gates (dry run required); the dry form and ordinary runs do not', () => {
  const r = gated('python3 scripts/archive.py --commit', 'write');
  assert.equal(r.requireDryRun, true);
  assert.deepEqual(r.dryTokens, ['python3', 'scripts/archive.py']);
  gated('node build.mjs --apply=all', 'write');
  gated('./import.sh --live --yes', 'write');
  gated('npx tsx sync.ts --execute', 'write');
  gated('python3 restore.py --restore snap.json --commit', 'write');
  assert.deepEqual(run('python3 restore.py --restore snap.json --commit').dryTokens, ['python3', 'restore.py', '--restore', 'snap.json']);
  clear('python3 scripts/archive.py');
  clear('git commit -m "add --commit flag docs"');                // not a script
  clear('node --test "test/*.test.mjs"');
});

test('outbound, store and MCP tools', () => {
  gated(`curl -X POST https://slack.com/api/chat.postMessage -d @msg.json`, 'outbound');
  clear('curl -s https://slack.com/api/chat.postMessage');          // a GET posts nothing
  clear('curl -s localhost:3210/api/tasks/1');
  const mcp = (tool) => classify({ tool, cwd: '/work/app' }, policy, ctx);
  assert.equal(mcp('mcp__claude_ai_Gmail__send_message').cls, 'outbound');
  assert.equal(mcp('mcp__claude_ai_Gmail__reply').cls, 'outbound');
  assert.equal(mcp('mcp__claude_ai_Gmail__create_draft').verdict, 'clear');   // a draft is not outbound
  assert.equal(mcp('mcp__claude_ai_Shopify__graphql_mutation').cls, 'store');
  assert.equal(mcp('mcp__claude_ai_Shopify__update-product').cls, 'store');
  assert.equal(mcp('mcp__claude_ai_Shopify__graphql_query').verdict, 'clear');
  assert.equal(mcp('mcp__claude_ai_Shopify__get-product').verdict, 'clear');
});

test('deletes: outside the repo, globs and variables gate; inside the repo does not; SQL drops gate', () => {
  clear('rm -rf build dist node_modules/.cache');
  clear('rm -f out.txt');
  gated('rm -rf ~/Downloads/x', 'delete');
  gated('rm -rf /work/other', 'delete');
  gated('rm -rf "$DIR"', 'delete');
  gated('rm -rfv ../sibling', 'delete');
  gated('rm -r .', 'delete');                                      // the whole tree
  gated(`psql "$DB" -c "DROP TABLE orders"`, 'delete');
  gated(`supabase-run-sql.sh "truncate table events"`, 'delete');
  clear('git commit -m "drop table support from docs"');
  gated('gh repo delete acme/app --yes', 'delete');
});

test('self: reading grants or the decision token, changing the policy or hooks, calling gate_decide', () => {
  gated('cat /work/board/data/mesh-decision-token', 'self');
  gated('ls /work/board/data/guardrails/', 'self');
  gated(`curl -X PATCH localhost:3210/api/tasks/3 -d '{"op":"gate_decide","gate":"g1","decision":"approve"}'`, 'self');
  gated(`node -e "fetch('http://localhost:3210/api/tasks/3',{method:'PATCH',body:JSON.stringify({op:'gate_decide'})})"`, 'self');
  // fix 2: reading the gate's own source is maintenance, not an approval attempt
  clear('grep -n gate_decide src/tasks.mjs');
  clear('rg gate_decide src test && sed -n 1,40p src/gate-ledger.mjs');
  clear('cat docs/notes.md | grep x-mesh-decision');
  gated(`jq '.hooks={}' x > /home/u/.claude/settings.json`, 'self');
  clear('cat /home/u/.claude/settings.json');                       // reading the hooks config is fine
  const t = (tool, filePath) => classify({ tool, filePath, cwd: '/work/app' }, policy, ctx);
  assert.equal(t('Read', '/work/board/data/mesh-decision-token').cls, 'self');
  assert.equal(t('Edit', '/home/u/.claude/settings.json').cls, 'self');
  assert.equal(t('Write', '/work/board/overlay/policy.json').cls, 'self');
  assert.equal(t('Read', '/home/u/.claude/settings.json').verdict, 'clear');
  assert.equal(t('Edit', '/work/app/src/x.mjs').verdict, 'clear');
});

test('condition A: a hit is never dropped — function bodies, heredocs and unparseable text', () => {
  gated('f(){ gh pr merge 5; }; f', 'merge');
  gated('bash -c "gh pr merge 5"', 'merge');
  gated(`bash <<'EOF'\ngh pr merge 5\nEOF`, 'merge');
  gated(`python3 - <<'EOF'\nimport subprocess; subprocess.run(["gh","pr","merge","5"])\nEOF`, 'opaque');
  gated(`echo "unterminated gh pr merge 5`, 'opaque');
  clear(`cat > notes.md <<'EOF'\nremember: gh pr merge 5 after review\nEOF`);   // data written to a file
  clear('echo "gh pr merge after review"');                         // attributed to echo, cleared
  clear('ls # then gh pr merge 5');
});

test('condition B: a variable or expansion in command position with a gated keyword is opaque', () => {
  gated('$g pr merge 5', 'opaque');
  gated('"$BIN" push origin main', 'opaque');
  gated('${GIT} push', 'opaque');
  gated('$(which gh) pr merge 5', 'opaque');
  gated('eval "gh pr merge 5"', 'opaque');
  gated('echo gh pr merge 5 | sh', 'opaque');
  gated('xargs -n1 gh pr merge < ids', 'opaque');
  gated('$PY tool.py --commit', 'opaque');
  clear('$EDITOR notes.md');
  clear('echo $HOME && "$NODE" --version');
});

test('fingerprints: exact text, folder, tool and engine are bound; dry form drops only the write flags', () => {
  const a = cmdHash({ cwd: '/work/app', command: 'gh pr merge 3' });
  assert.equal(a, cmdHash({ cwd: '/work/app', command: '  gh pr merge 3 ' }));
  assert.notEqual(a, cmdHash({ cwd: '/work/other', command: 'gh pr merge 3' }));
  assert.notEqual(a, cmdHash({ cwd: '/work/app', command: 'gh pr merge 4' }));
  assert.notEqual(a, cmdHash({ engine: 'codex', cwd: '/work/app', command: 'gh pr merge 3' }));
  assert.deepEqual(dryTokens({ tokens: ['x.py', '--commit', '--n=3'] }, { flagsAny: ['--commit'] }), ['x.py', '--n=3']);
  assert.equal(dryHash('/w', ['x.py']), dryHash('/w', ['x.py']));
  assert.notEqual(dryHash('/w', ['x.py']), dryHash('/v', ['x.py']));
  assert.equal(repoSlug('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(repoSlug('https://github.com/acme/app'), 'acme/app');
  assert.ok(globMatch('acme-public/*', 'acme-public/tool') && !globMatch('acme-public/*', 'acme/tool'));
});

test('fix 3: enforceFor "*" means registered agents; unregistered sessions only when named', () => {
  assert.equal(isEnforced({ enforceFor: ['*'] }, 'a'), true);
  assert.equal(isEnforced({ enforceFor: ['*'] }, 'unregistered:x', { registered: false }), false);
  assert.equal(isEnforced({ enforceFor: ['*', 'unregistered'] }, 'unregistered:x', { registered: false }), true);
  assert.equal(isEnforced({ enforceFor: ['a'] }, 'b'), false);
  assert.equal(isEnforced({}, 'a'), true);
});
