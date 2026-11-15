import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, compileTriggers, mcpParts, mcpIsRead, mcpAllowKey, namesBoard, CHECKS, DEFAULT_POLICY, MCP_UNLISTED } from '../src/gates.mjs';
import { createGateService, policyProblems } from '../src/gate-service.mjs';
import { createLedger, outsideTask } from '../src/tasks.mjs';
import { hookInput } from '../scripts/gate-hook.mjs';
import { review, render } from '../scripts/mcp-review.mjs';
import { OWNER } from '../src/config.mjs';

// Zulu 1.3 slice 7: MCP default-deny with a read list (`mcpDefault`), gh and SQL write forms
// (`remoteWrite`), tools and commands that drive the desktop or a browser (`desktop`).
// Tool names are the public names of common connectors. Nothing here is called.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODES = ['off', 'observe', 'enforce'];
const NEW = ['mcpDefault', 'remoteWrite', 'desktop'];
const policyAt = (modes, extra = {}) => ({ ...structuredClone(DEFAULT_POLICY), checks: { ...Object.fromEntries(CHECKS.map((n) => [n, 'off'])), ...modes }, ...extra });
const all = (mode) => policyAt(Object.fromEntries(NEW.map((n) => [n, mode])));
const BOARD = { pids: [4242], port: 3999, label: 'com.example.board' };
const ctxFor = (p) => ({ home: '/home/u', boardRoot: '/work/board', board: BOARD, repoRoot: () => '/work/app', git: () => null, triggers: compileTriggers(p, { boardRoot: '/work/board', home: '/home/u' }) });
const tool = (name, mode = 'enforce', extra = {}) => { const p = extra.policy || all(mode); return classify({ tool: name, command: '', filePath: null, cwd: '/work/app', ...extra.input }, p, { ...ctxFor(p), ...extra.ctx }); };
const bash = (command, mode = 'enforce') => { const p = all(mode); return classify({ tool: 'Bash', command, cwd: '/work/app' }, p, ctxFor(p)); };

// [tool name, what the shipped default says with every check on]
const TOOLS = [
  // sends and posts
  ['mcp__claude_ai_Slack__slack_send_message', 'outbound'], ['mcp__claude_ai_Slack__slack_schedule_message', 'outbound'], ['mcp__claude_ai_Slack__slack_send_message_draft', 'outbound'],
  ['mcp__claude_ai_Slack__slack_add_reaction', 'outbound'], ['mcp__claude_ai_Slack__slack_create_canvas', 'outbound'], ['mcp__claude_ai_Slack__slack_update_list_record', 'outbound'],
  ['mcp__claude_ai_Gmail__send_message', 'outbound'], ['mcp__claude_ai_Gmail__reply', 'outbound'], ['mcp__claude_ai_Gmail__forward', 'outbound'],
  ['mcp__claude_ai_Ahrefs__social-media-post-create', 'outbound'], ['mcp__claude_ai_Ahrefs__social-media-post-update', 'outbound'],
  // the store
  ['mcp__claude_ai_Shopify__graphql_mutation', 'store'], ['mcp__claude_ai_Shopify__create-product', 'store'], ['mcp__claude_ai_Shopify__set-inventory', 'store'],
  ['mcp__claude_ai_Shopify__switch-shop', 'store'], ['mcp__claude_ai_Shopify__upload_file', 'store'], ['mcp__claude_ai_Shopify__import-mock-shop-catalog', 'store'],
  // desktop and browser
  ['mcp__computer-use__left_click', 'desktop'], ['mcp__computer-use__type', 'desktop'], ['mcp__computer-use__key', 'desktop'], ['mcp__computer-use__open_application', 'desktop'],
  ['mcp__computer-use__write_clipboard', 'desktop'], ['mcp__cmux-cua__click', 'desktop'], ['mcp__cmux-cua__type_text', 'desktop'], ['mcp__cmux-cua__launch_app', 'desktop'],
  ['mcp__cmux-cua__perform_actions', 'desktop'], ['mcp__claude-in-chrome__computer', 'desktop'], ['mcp__claude-in-chrome__navigate', 'desktop'],
  ['mcp__claude-in-chrome__javascript_tool', 'desktop'], ['mcp__claude-in-chrome__form_input', 'desktop'], ['mcp__claude-in-chrome__file_upload', 'desktop'],
  // other writes to a remote account
  ['mcp__claude_ai_Google_Drive__share_file', 'remote-write'], ['mcp__claude_ai_Google_Drive__trash_file', 'remote-write'], ['mcp__claude_ai_Google_Drive__create_file', 'remote-write'],
  ['mcp__claude_ai_Google_Drive__copy_file', 'remote-write'], ['mcp__claude_ai_Gmail__trash_thread', 'remote-write'], ['mcp__claude_ai_Gmail__mark_message_spam', 'remote-write'],
  ['mcp__claude_ai_Gmail__delete_label', 'remote-write'], ['mcp__claude_ai_Gmail__create_draft', 'remote-write'], ['mcp__claude_ai_Gmail__label_thread', 'remote-write'],
  ['mcp__claude_ai_Gmail__apply_sensitive_message_label', 'remote-write'], ['mcp__claude_ai_Atlassian_Rovo__createJiraIssue', 'remote-write'],
  ['mcp__claude_ai_Atlassian_Rovo__editJiraIssue', 'remote-write'], ['mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue', 'remote-write'],
  ['mcp__claude_ai_Atlassian_Rovo__updateConfluencePage', 'remote-write'], ['mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue', 'remote-write'],
  ['mcp__claude_ai_Ahrefs__management-projects-create', 'remote-write'], ['mcp__claude_ai_Ahrefs__management-keyword-lists-delete', 'remote-write'],
  ['mcp__claude_ai_Ahrefs__management-update-project', 'remote-write'], ['mcp__claude_ai_Claude_Docs__batch', 'remote-write'], ['mcp__claude_ai_Claude_Docs__update', 'remote-write'],
  ['mcp__claude_ai_Claude_Docs__create', 'remote-write'], ['mcp__claude_ai_Claude_Docs__delete', 'remote-write'],
  // reads by the default pattern
  ['mcp__claude_ai_Gmail__get_thread', 'read'], ['mcp__claude_ai_Gmail__list_labels', 'read'], ['mcp__claude_ai_Gmail__search_threads', 'read'],
  ['mcp__claude_ai_Google_Drive__get_file_metadata', 'read'], ['mcp__claude_ai_Google_Drive__list_recent_files', 'read'], ['mcp__claude_ai_Google_Drive__read_file_content', 'read'],
  ['mcp__claude_ai_Google_Drive__search_files', 'read'], ['mcp__claude_ai_Shopify__get-product', 'read'], ['mcp__claude_ai_Shopify__list-orders', 'read'],
  ['mcp__claude_ai_Shopify__search_products', 'read'], ['mcp__claude_ai_Atlassian_Rovo__getJiraIssue', 'read'], ['mcp__claude_ai_Atlassian_Rovo__search', 'read'],
  ['mcp__claude_ai_Atlassian_Rovo__fetch', 'read'], ['mcp__claude_ai_Atlassian_Rovo__lookupJiraAccountId', 'read'], ['mcp__claude_ai_Claude_Docs__read', 'read'],
  ['mcp__claude_ai_Claude_Docs__query', 'read'], ['mcp__cmux-cua__get_window_state', 'read'], ['mcp__cmux-cua__list_apps', 'read'], ['mcp__cmux-cua__check_permissions', 'read'],
  ['mcp__claude-in-chrome__find', 'read'], ['mcp__claude-in-chrome__read_page', 'read'], ['mcp__claude-in-chrome__get_page_text', 'read'],
  // desktop tools that only look
  ['mcp__computer-use__screenshot', 'unlisted'], ['mcp__computer-use__zoom', 'unlisted'], ['mcp__computer-use__cursor_position', 'unlisted'],
  ['mcp__computer-use__list_granted_applications', 'read'], ['mcp__computer-use__read_clipboard', 'read'],
  // nobody has classified these: held as unlisted until the owner's read list or a rule names them
  ['mcp__claude_ai_Slack__slack_read_channel', 'unlisted'], ['mcp__claude_ai_Slack__slack_search_public', 'unlisted'], ['mcp__claude_ai_Shopify__run-analytics-query', 'unlisted'],
  ['mcp__claude_ai_Shopify__graphql_query', 'unlisted'], ['mcp__claude_ai_Google_Drive__download_file_content', 'unlisted'], ['mcp__claude_ai_Ahrefs__site-explorer-metrics', 'unlisted'],
  ['mcp__claude_ai_Ahrefs__batch-analysis', 'unlisted'], ['mcp__cmux-cua__start_session', 'unlisted'], ['mcp__claude-in-chrome__tabs_context_mcp', 'unlisted'], ['mcp__vendor__frobnicate', 'unlisted'],
];
const HELD_TODAY = ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward', 'mcp__claude_ai_Shopify__graphql_mutation',
  'mcp__claude_ai_Shopify__create-product', 'mcp__claude_ai_Shopify__set-inventory'];
const clsOf = (expect) => (expect === 'unlisted' ? MCP_UNLISTED.id : expect);

test('names: server and tool are split at the first double underscore; the read list takes exact names, globs and a pattern', () => {
  assert.deepEqual(mcpParts('mcp__claude_ai_Slack__slack_send_message'), { server: 'claude_ai_Slack', name: 'slack_send_message' });
  assert.equal(mcpParts('Bash'), null); assert.equal(mcpParts('mcp__x'), null);
  assert.equal(mcpIsRead('mcp__s__get_thing', DEFAULT_POLICY), true); assert.equal(mcpIsRead('mcp__s__getThing', DEFAULT_POLICY), true);
  assert.equal(mcpIsRead('mcp__s__getaway', DEFAULT_POLICY), false); assert.equal(mcpIsRead('mcp__s__slack_read_channel', DEFAULT_POLICY), false);
  const p = { ...DEFAULT_POLICY, lists: { ...DEFAULT_POLICY.lists, mcpRead: ['mcp__s__slack_read_*', 'mcp__s__exact'] } };
  assert.equal(mcpIsRead('mcp__s__slack_read_channel', p), true); assert.equal(mcpIsRead('mcp__s__exact', p), true); assert.equal(mcpIsRead('mcp__other__slack_read_channel', p), false);
  assert.equal(mcpIsRead('mcp__s__get_thing', { ...p, mcpReadPattern: '' }), false, 'an empty pattern turns the generic read pattern off');
  assert.deepEqual(policyProblems(DEFAULT_POLICY), []);
  assert.ok(policyProblems({ ...DEFAULT_POLICY, mcpReadPattern: '(' }).some((x) => /mcpReadPattern/.test(x)));
  const { _doc, ...twin } = JSON.parse(readFileSync(path.join(ROOT, 'examples', 'policy.json'), 'utf8'));
  assert.deepEqual(twin, JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  for (const n of NEW) assert.equal(DEFAULT_POLICY.checks[n], 'observe');
});

test('every real tool name: a rule\'s class, a read, or held as unlisted; the Slack send is no longer missed', () => {
  for (const [name, expect] of TOOLS) {
    const r = tool(name);
    if (expect === 'read') { assert.equal(r.verdict, 'clear', `${name} → ${r.cls}: ${r.why}`); continue; }
    assert.equal(r.verdict, 'gate', `${name} → clear (${r.why})`); assert.equal(r.cls, clsOf(expect), `${name} → ${r.cls}`);
    if (!HELD_TODAY.includes(name)) assert.ok(NEW.includes(r.check), `${name}: check ${r.check}`);
  }
  assert.equal(tool('mcp__claude_ai_Slack__slack_send_message', 'off').verdict, 'clear', 'the old rule expects __send_message: passes while the check is off');
  assert.equal(DEFAULT_POLICY.classes.find((c) => c.id === 'desktop').standing, true);
});

test('off and observe: today\'s verdict for every tool; observe names the check and the class it would be held under', () => {
  for (const [name, expect] of TOOLS) {
    const off = tool(name, 'off'); const obs = tool(name, 'observe');
    const today = HELD_TODAY.includes(name) ? 'gate' : 'clear';
    assert.equal(off.verdict, today, `off: ${name}`); assert.equal(obs.verdict, today, `observe: ${name}`); assert.equal(off.wouldHold, undefined);
    if (today === 'gate' || expect === 'read') { assert.equal(obs.wouldHold, undefined, name); continue; }
    assert.ok(NEW.includes(obs.wouldHold?.check), `observe: ${name}`); assert.equal(obs.wouldHold.cls, clsOf(expect), name);
  }
});

test('each check alone: mcpDefault does not hold a desktop tool, desktop does not hold an unlisted one', () => {
  const only = (n) => policyAt({ [n]: 'enforce' });
  assert.equal(tool('mcp__vendor__frobnicate', 'x', { policy: only('mcpDefault') }).cls, MCP_UNLISTED.id);
  assert.equal(tool('mcp__vendor__frobnicate', 'x', { policy: only('desktop') }).verdict, 'clear');
  assert.equal(tool('mcp__cmux-cua__click', 'x', { policy: only('desktop') }).cls, 'desktop');
  assert.equal(tool('mcp__cmux-cua__click', 'x', { policy: only('mcpDefault') }).cls, MCP_UNLISTED.id, 'not a read, and its rule is off: unlisted');
  assert.equal(tool('mcp__claude_ai_Gmail__get_thread', 'x', { policy: only('mcpDefault') }).verdict, 'clear');
  assert.equal(tool('Read', 'x', { policy: only('mcpDefault'), input: { filePath: '/work/app/README.md' } }).verdict, 'clear');
});

test('a changed source: a known tool arriving from another place is unlisted; the policy can pin a server\'s source', () => {
  const t = 'mcp__claude_ai_Gmail__get_thread';
  const seen = { [t]: { server: 'claude_ai_Gmail', source: 'claudeai' } };
  assert.equal(tool(t, 'enforce', { ctx: { mcpSeen: seen }, input: { mcpServer: { name: 'claude_ai_Gmail', source: 'claudeai' } } }).verdict, 'clear');
  const moved = tool(t, 'enforce', { ctx: { mcpSeen: seen }, input: { mcpServer: { name: 'claude_ai_Gmail', source: 'project' } } });
  assert.equal(moved.cls, MCP_UNLISTED.id); assert.match(moved.why, /source changed \(claudeai → project\)/);
  assert.equal(tool(t, 'observe', { ctx: { mcpSeen: seen }, input: { mcpServer: { name: 'claude_ai_Gmail', source: 'project' } } }).wouldHold.check, 'mcpDefault');
  const pinned = { ...all('enforce'), mcpSources: { claude_ai_Gmail: 'project' } };
  assert.equal(tool(t, 'x', { policy: pinned, ctx: { mcpSeen: seen }, input: { mcpServer: { name: 'claude_ai_Gmail', source: 'project' } } }).verdict, 'clear');
  assert.equal(tool(t, 'enforce', { ctx: { mcpSeen: seen } }).verdict, 'clear', 'no source in the hook input: names alone');
  assert.deepEqual(hookInput({ hook_event_name: 'PreToolUse', tool_name: t, tool_input: {}, cwd: '/w', mcp_server: { name: 'claude_ai_Gmail', source: 'claudeai' } }, {}).mcpServer, { name: 'claude_ai_Gmail', source: 'claudeai' });
  assert.equal('mcpServer' in hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/w' }, {}), false);
});

// ── gh, SQL, and shell commands that drive a browser or the desktop ──
const REMOTE_HELD = ['gh api -X POST repos/acme/app/issues -f title=x', 'gh api --method DELETE repos/acme/app/git/refs/heads/x', 'gh api repos/acme/app/issues -f title=x',
  'gh api -XPATCH repos/acme/app', 'gh api repos/acme/app/dispatches --input body.json', "gh api graphql -f query='mutation { addStar(input:{}) { clientMutationId } }'",
  'gh api -X PUT repos/acme/app/pulls/3/merge', 'gh api --method PUT repos/acme/app/pulls/3/merge -f merge_method=squash', "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}) { clientMutationId } }'",
  'curl -s -X PUT https://api.github.com/repos/acme/app/pulls/3/merge -H "authorization: bearer x"', 'curl -s https://api.github.com/repos/acme/app/issues -d @body.json',
  'gh workflow run ci.yml', 'gh workflow disable ci.yml', 'gh release create v9.9.9', 'gh release delete v9.9.9', 'gh release edit v9.9.9 --draft=false',
  'gh pr close 5', 'gh pr ready 5', 'gh issue close 5', 'gh issue delete 5', 'gh repo edit --visibility public', 'gh repo archive acme/app', 'gh repo rename new-name',
  'gh -R acme/app pr close 5', `psql "$DB" -c "UPDATE orders SET status = 'x' WHERE id = 1"`, `psql -c "DELETE FROM orders WHERE id = 1"`,
  `sqlite3 app.db "INSERT INTO t VALUES (1)"`, `psql -c "ALTER TABLE t ADD COLUMN c int"`, `supabase db query "update t set a = 1"`];
const REMOTE_FREE = ['gh api repos/acme/app/pulls/5', 'gh api -X GET repos/acme/app/issues -f state=open', "gh api graphql -f query='query { viewer { login } }'", 'gh api user --jq .login',
  'curl -s https://api.github.com/repos/acme/app/pulls/3', 'gh api repos/acme/app/pulls/3/merge', 'gh alias list', 'gh repo set-default --view',
  'gh workflow list', 'gh workflow view ci.yml', 'gh run view 5', 'gh release list', 'gh release view v1', 'gh pr view 5', 'gh pr list', 'gh pr checks 5', 'gh pr create --title "close the gap"',
  'gh issue list', 'gh issue view 5', 'gh repo view', `psql -c "SELECT * FROM orders"`, `sqlite3 app.db "select count(*) from t"`, 'echo "update the docs and set the flag"', 'graphify update .',
  'git commit -m "insert into the readme; alter table of contents"'];
const DESKTOP_HELD = ['cmux browser surface:3 click "#approve"', 'cmux browser --surface surface:3 eval "document.title"', 'cmux browser surface:3 type "#q" hello', 'cmux browser surface:3 fill "#q" hello',
  'cmux browser surface:3 press Enter', 'cmux browser surface:3 key Enter', 'cmux browser surface:3 keydown a', 'cmux browser surface:3 check "#x"', 'cmux browser surface:3 uncheck "#x"',
  'cmux browser surface:3 dblclick "#x"', 'cmux browser surface:3 set-input-files --selector "#f" --file a.txt', 'cmux browser surface:3 addscript "x()"', 'cmux browser click "#x"',
  'cmux browser surface:3 goto http://localhost:3999/', 'cmux browser surface:3 navigate http://127.0.0.1:3999/?dock=1', 'cmux browser open http://localhost:3999/',
  `osascript -e 'tell application "System Events" to click at {10, 10}'`, `osascript -e 'tell application "System Events" to keystroke "y"'`, `osascript -e 'tell application "System Events" to key code 36'`,
  `osascript -e 'tell application "Safari" to do JavaScript "x()" in document 1'`, `osascript -e 'tell application "Google Chrome" to execute front window\\'s active tab javascript "x()"'`,
  'osascript <<EOF\ntell application "System Events" to keystroke "y"\nEOF', 'cliclick c:10,10', 'open -a "Google Chrome" --args --remote-debugging-port=9222'];
const DESKTOP_FREE = ['cmux browser surface:3 snapshot', 'cmux browser surface:3 url', 'cmux browser surface:3 get-url', 'cmux browser status', 'cmux browser surface:3 wait --selector "#x"',
  'cmux browser identify', 'cmux browser surface:3 get text "#x"', 'cmux browser surface:3 screenshot --out /tmp/a.png', 'cmux browser surface:3 goto https://example.com/',
  'cmux browser open https://example.com/', 'cmux tree', 'cmux notify --title x --body y', `osascript -e 'display notification "done" with title "x"'`, `osascript -e 'tell application "Finder" to get name of every disk'`,
  'open -a Safari https://example.com', 'open .'];

for (const [check, held, free, cls] of [['remoteWrite', REMOTE_HELD, REMOTE_FREE, 'remote-write'], ['desktop', DESKTOP_HELD, DESKTOP_FREE, 'desktop']]) {
  test(`${check} in the shell: held forms under class ${cls}, free forms, and every mode`, () => {
    for (const c of held) {
      const r = bash(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, cls, c); assert.equal(r.check, check, c);
      assert.equal(bash(c, 'off').verdict, 'clear', `off: ${c}`); assert.equal(bash(c, 'off').wouldHold, undefined);
      const obs = bash(c, 'observe'); assert.equal(obs.verdict, 'clear', `observe: ${c}`); assert.equal(obs.wouldHold?.check, check, `observe: ${c}`);
    }
    for (const m of MODES) for (const c of free) { const r = bash(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
    for (const m of MODES) { assert.equal(bash('gh pr merge 5', m).cls, 'merge'); assert.equal(bash('gh repo delete acme/app', m).cls, 'delete'); assert.equal(bash('psql -c "DROP TABLE t"', m).cls, 'delete'); }
  });
}

test('what gh words mean and which repo gh acts on: alias set and repo set-default are selfProtect readings; an API landing says what it is', () => {
  const sp = (command, mode) => { const p = policyAt({ selfProtect: mode }); return classify({ tool: 'Bash', command, cwd: '/work/app' }, p, ctxFor(p)); };
  for (const c of ["gh alias set land 'pr merge -R acme-public/tool'", 'gh alias import aliases.yml', 'gh repo set-default acme-public/tool', 'gh repo set-default']) {
    const r = sp(c, 'enforce'); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'self', c); assert.equal(r.check, 'selfProtect');
    assert.equal(sp(c, 'off').verdict, 'clear'); assert.equal(sp(c, 'observe').wouldHold?.check, 'selfProtect', c);
  }
  for (const c of ['gh alias list', 'gh repo set-default --view', 'gh repo view']) assert.equal(sp(c, 'enforce').verdict, 'clear', c);
  assert.match(bash('gh api -X PUT repos/acme/app/pulls/3/merge').why, /merges a pull request through the API/);
  assert.match(bash('curl -s -X PUT https://api.github.com/repos/acme/app/pulls/3/merge').why, /merges a pull request/);
});

test('this board\'s address: any host this machine answers on, with the board\'s port', () => {
  const ctx = { board: BOARD };
  for (const u of ['http://localhost:3999/', 'http://127.0.0.1:3999/?dock=1', `http://${['100', '64', '1', '2'].join('.')}:3999`, 'https://my-mac.tail1234.ts.net:3999/x', 'http://[::1]:3999/']) assert.equal(namesBoard(u, ctx), true, u);
  for (const u of ['http://localhost:39990/', 'http://localhost:3000/', 'https://example.com:3999/', 'http://localhost/']) assert.equal(namesBoard(u, ctx), false, u);
  assert.equal(namesBoard('http://localhost:3999/', {}), false);
});

// ── the real hook script: the allow file, real hook JSON, board down ──
// every file the hook needs to run from a copy (src/caller.mjs joins them with the caller-evidence slice)
const HOOK_FILES = ['scripts/gate-hook.sh', 'scripts/gate-hook.mjs', 'scripts/gate-triggers.default', 'src/gates.mjs', 'src/caller.mjs'].filter((f) => existsSync(new URL(`../${f}`, import.meta.url)));
const env = { ...process.env, GATE_NODE: process.execPath, MESH_BOARD: 'http://127.0.0.1:9', GATE_TIMEOUT_MS: '300', CMUX_WORKSPACE_ID: '', MESH_GATE_IDENTITY: '' };
function hookCopy(mode, allow) {
  const dir = path.join(realpathSync(mkdtempSync(path.join(os.tmpdir(), 'gate mcp-'))), 'Repo With Space');
  for (const f of HOOK_FILES) cpSync(path.join(ROOT, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'policy.json'), JSON.stringify(all(mode)));
  if (allow) { mkdirSync(path.join(dir, 'data', 'guardrails'), { recursive: true }); writeFileSync(path.join(dir, 'data', 'guardrails', 'mcp-allow'), allow.map((k) => `${k}\n`).join('')); }
  return dir;
}
const hookOut = (dir, obj, extra = {}) => spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: typeof obj === 'string' ? obj : JSON.stringify(obj), env: { ...env, ...extra }, encoding: 'utf8' }).stdout;
const decisionOf = (out) => (out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'pass');
const mcpJson = (name, source = 'claudeai', input = { q: 'x' }) => ({ session_id: 's', transcript_path: '/t.jsonl', cwd: '/work/app', permission_mode: 'auto', hook_event_name: 'PreToolUse',
  tool_name: name, tool_input: input, tool_use_id: 'toolu_1', mcp_server: { name: mcpParts(name).server, source } });
const bashJson = (command) => ({ session_id: 's', cwd: '/work/app', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command, description: 'x' } });
const READS = TOOLS.filter(([, e]) => e === 'read').map(([n]) => n);

test('real hook JSON, enforce: every tool is denied or passes as the table says; the shell commands too', () => {
  const dir = hookCopy('enforce', READS.map((n) => mcpAllowKey(n, 'claudeai')));      // the board's allow file: the reads it has seen, each with its source
  for (const [name, expect] of TOOLS) assert.equal(decisionOf(hookOut(dir, mcpJson(name))), expect === 'read' ? 'pass' : 'deny', name);
  // board down: a tool that reads as a read by its name but is not on the allow file with this source is held (the
  // board's seen list, which pins a tool to its source, cannot be asked); with a busy input the same read still passes
  const empty = hookCopy('enforce', []);
  assert.equal(decisionOf(hookOut(empty, mcpJson(READS[0]))), 'deny', 'a read the board has never listed, board down');
  assert.equal(decisionOf(hookOut(dir, mcpJson(READS[0], 'project'))), 'deny', 'a listed read from another source, board down');
  assert.equal(decisionOf(hookOut(dir, mcpJson(READS[0], 'claudeai', { fields: { tool_name: 'x' } }))), 'pass', 'a listed read that reaches the Node step is still on the file');
  // observe: nothing is held, with or without the file
  assert.equal(decisionOf(hookOut(hookCopy('observe', []), mcpJson(READS[0]))), 'pass');
  for (const c of [...REMOTE_HELD, ...DESKTOP_HELD.filter((x) => !/3999/.test(x))]) assert.equal(decisionOf(hookOut(dir, bashJson(c))), 'deny', c);
  for (const c of [...REMOTE_FREE, ...DESKTOP_FREE]) assert.equal(hookOut(dir, bashJson(c)), '', c);
  // JSON written with spaces after the colons is read the same way
  assert.equal(decisionOf(hookOut(dir, JSON.stringify(mcpJson('mcp__vendor__frobnicate'), null, 1).replace(/\n\s*/g, ' '))), 'deny');
});

test('real hook JSON, off and observe: the answer is byte for byte the same; no allow file means nothing changes at all', () => {
  const off = hookCopy('off'); const obs = hookCopy('observe', []); const obsNoFile = hookCopy('observe');
  for (const [name] of TOOLS) {
    const a = hookOut(off, mcpJson(name)); const b = hookOut(obs, mcpJson(name)); const c = hookOut(obsNoFile, mcpJson(name));
    assert.equal(b, a, name); assert.equal(c, a, name);
    assert.equal(decisionOf(a), HELD_TODAY.includes(name) ? 'deny' : 'pass', name);
  }
  for (const c of [...REMOTE_HELD, ...DESKTOP_HELD, ...REMOTE_FREE, ...DESKTOP_FREE]) { const a = hookOut(off, bashJson(c)); assert.equal(hookOut(obs, bashJson(c)), a, c); assert.equal(a, '', c); }
});

test('fast path: a tool on the allow file never starts Node; an unlisted tool, a ruled tool and a changed source do; timing holds', () => {
  const allow = READS.map((n) => mcpAllowKey(n, 'claudeai'));
  const dir = hookCopy('enforce', allow);
  const tdir = mkdtempSync(path.join(os.tmpdir(), 'mcp-shim-')); const shim = path.join(tdir, 'node'); const marker = path.join(tdir, 'ran');
  writeFileSync(shim, `#!/bin/sh\n: > "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  for (const n of READS) { assert.equal(hookOut(dir, mcpJson(n), { GATE_NODE: shim }), '', n); assert.equal(existsSync(marker), false, `the fast path started Node for ${n}`); }
  // a call that is not MCP at all, with or without the text "mcp__" in it, is untouched
  assert.equal(hookOut(dir, bashJson('git status && ls -la'), { GATE_NODE: shim }), ''); assert.equal(hookOut(dir, bashJson('echo "mcp__vendor__frobnicate"'), { GATE_NODE: shim }), '');
  assert.equal(hookOut(dir, { ...mcpJson(READS[0]), hook_event_name: 'PostToolUse' }, { GATE_NODE: shim }), '');
  assert.equal(existsSync(marker), false);
  for (const [obj, why] of [[mcpJson('mcp__vendor__frobnicate'), 'unlisted'], [mcpJson('mcp__claude_ai_Google_Drive__share_file'), 'ruled'], [mcpJson(READS[0], 'project'), 'changed source']]) {
    const before = readdirSync(tdir).includes('ran');
    hookOut(dir, obj, { GATE_NODE: shim });
    assert.equal(readdirSync(tdir).includes('ran'), true, `${why} should reach Node`);
    if (!before) { /* first hit: marker now exists for the rest */ }
  }
  // a path argument is still read: an allow-listed tool that names a guarded file goes to the Node step and is denied
  assert.equal(decisionOf(hookOut(dir, mcpJson(READS[0], 'claudeai', { path: path.join(dir, 'data', 'mesh-decision-token') }))), 'deny');
  const input = JSON.stringify(mcpJson(READS[0])); const times = [];
  for (let i = 0; i < 60; i++) {
    const t0 = process.hrtime.bigint();
    const r = spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input, env, encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
    assert.equal(r.status, 0); assert.equal(r.stdout, '');
  }
  times.sort((a, b) => a - b);
  // third-fastest of the 60 runs, not the median: a busy machine delays most runs but not the fastest few (test/gate-hook.test.mjs, #524)
  assert.ok(times[2] < (process.env.CI ? 150 : 45), `allow-listed MCP call: third-fastest of ${times.length} runs ${times[2].toFixed(1)} ms (median ${times[30].toFixed(1)} ms)`);
  const plain = JSON.stringify(bashJson('git status && ls -la src && node --version')); const t2 = [];
  for (let i = 0; i < 60; i++) { const t0 = process.hrtime.bigint(); spawnSync('sh', [path.join(dir, 'scripts', 'gate-hook.sh'), '--env-board'], { input: plain, env, encoding: 'utf8' }); t2.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  t2.sort((a, b) => a - b);
  assert.ok(t2[2] < (process.env.CI ? 150 : 35), `a call with no trigger: third-fastest of ${t2.length} runs ${t2[2].toFixed(1)} ms (median ${t2[30].toFixed(1)} ms)`);   // the same ceilings as test/gate-hook.test.mjs
});

// ── the board side ──
async function board(policy, over = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gate-mcp-'));
  const ledger = createLedger(path.join(dir, 'tasks'));
  await writeFile(path.join(dir, 'policy.json'), JSON.stringify(policy));
  let t = Date.parse('2026-01-05T10:00:00Z'); const events = [];
  const svc = createGateService({ root: dir, ledger, policyFile: path.join(dir, 'policy.json'), stateDir: path.join(dir, 'guardrails'), ownerId: OWNER.id,
    identifyWs: async (ws) => ({ W1: 'builder', W2: 'helper', WM: 'coordinator' }[ws] || null), home: '/home/u', mcName: async () => 'coordinator', git: () => null, isPrivateRepo: async () => null, prInfo: async () => null,
    now: () => t, board: BOARD, recordEvent: async (k, x) => { events.push(x); }, surfaceUrl: over.surfaceUrl });
  const call = (name, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: name, command: null, toolInput: extra.toolInput || { q: 'x' }, cwd: '/work/app', workspaceId: extra.ws || 'W1', mcpServer: { name: mcpParts(name).server, source: extra.source || 'claudeai' } });
  const sh = (command, extra = {}) => svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command, cwd: '/work/app', workspaceId: 'W1', ...extra });
  const state = async (f) => readFile(path.join(dir, 'guardrails', f), 'utf8').catch(() => null);
  const lines = async (f) => String((await state(f)) || '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, ledger, svc, call, sh, state, lines, events, tick: (ms) => { t += ms; }, at: () => t,
    setPolicy: async (p) => { t += 1000; await writeFile(path.join(dir, 'policy.json'), JSON.stringify(p)); const d = new Date(t); const { utimes } = await import('node:fs/promises'); await utimes(path.join(dir, 'policy.json'), d, d); } };
}

test('board, observe: every call passes; the seen file, the allow file and one review task per server and day', async () => {
  const b = await board(all('observe'));
  for (const n of ['mcp__claude_ai_Gmail__get_thread', 'mcp__vendor__frobnicate', 'mcp__vendor__spin_up', 'mcp__claude_ai_Google_Drive__share_file', 'mcp__other__do_thing', 'mcp__vendor__frobnicate'])
    assert.deepEqual(await b.call(n, { ws: n.includes('spin') ? 'W2' : 'W1' }), { decision: 'pass' }, n);
  const seen = JSON.parse(await b.state('mcp-seen.json'));
  assert.deepEqual(Object.keys(seen).sort(), ['mcp__claude_ai_Gmail__get_thread', 'mcp__claude_ai_Google_Drive__share_file', 'mcp__other__do_thing', 'mcp__vendor__frobnicate', 'mcp__vendor__spin_up']);
  assert.deepEqual(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.verdict])), { mcp__claude_ai_Gmail__get_thread: 'read', mcp__claude_ai_Google_Drive__share_file: 'rule:remote-write',
    mcp__other__do_thing: 'unlisted', mcp__vendor__frobnicate: 'unlisted', mcp__vendor__spin_up: 'unlisted' });
  const f = seen.mcp__vendor__frobnicate;
  assert.equal(f.count, 2); assert.equal(f.server, 'vendor'); assert.equal(f.source, 'claudeai'); assert.deepEqual(f.agents, ['builder']); assert.ok(f.firstSeen && f.lastSeen);
  assert.deepEqual(seen.mcp__vendor__spin_up.agents, ['helper']);
  assert.equal(await b.state('mcp-allow'), 'mcp__claude_ai_Gmail__get_thread claudeai\n');
  // readings: one would-hold line per call that would be held, none for the read
  const obs = await b.lines('observed.jsonl');
  assert.equal(obs.length, 5); assert.ok(obs.every((l) => l.wouldHold === 'mcpDefault'));
  // one low task per server per day, addressed to Mission Control, later names as comments; never a gate
  const tasks = await b.ledger.list({});
  assert.equal(tasks.length, 2);
  const vendor = tasks.find((x) => x.source.key === 'mcp:vendor@2026-01-05');
  assert.equal(vendor.priority, 'low'); assert.equal(vendor.owner, 'coordinator'); assert.equal(vendor.requester, 'board'); assert.equal(outsideTask(vendor), true);
  assert.ok((vendor.body || vendor.comments.map((c) => c.text).join(' ')).includes('mcp__vendor__frobnicate'));
  assert.equal(vendor.comments.filter((c) => /another unclassified tool.*mcp__vendor__spin_up/.test(c.text)).length, 1);
  assert.ok(tasks.every((x) => !(x.gates || []).length));
  // the next day, a new name on the same server opens a new task
  b.tick(86400e3); await b.call('mcp__vendor__third');
  assert.ok((await b.ledger.list({})).some((x) => x.source.key === 'mcp:vendor@2026-01-06'));
});

test('board: off writes nothing and removes the allow file; enforce holds; a policy edit that lists a tool lets it through and onto the allow file', async () => {
  const off = await board(all('off'));
  assert.deepEqual(await off.call('mcp__vendor__frobnicate'), { decision: 'pass' });
  assert.equal(await off.state('mcp-seen.json'), null); assert.equal(await off.state('mcp-allow'), null); assert.deepEqual(await off.ledger.list({}), []);

  const b = await board(all('enforce'));
  const r = await b.call('mcp__vendor__frobnicate');
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /waiting on the owner/i);
  const gate = (await b.ledger.get(r.task)).gates[0];
  assert.equal(gate.cls, 'mcp-unlisted'); assert.equal(gate.label, MCP_UNLISTED.label); assert.match(gate.command, /mcp__vendor__frobnicate/);
  assert.equal((await b.call('mcp__claude_ai_Google_Drive__share_file')).decision, 'deny');
  assert.deepEqual(await b.call('mcp__claude_ai_Gmail__get_thread'), { decision: 'pass' });
  // the owner's read list
  const p = all('enforce'); p.lists.mcpRead = ['mcp__vendor__frobnicate'];
  await b.setPolicy(p);
  assert.deepEqual(await b.call('mcp__vendor__frobnicate'), { decision: 'pass' });
  assert.match(await b.state('mcp-allow'), /^mcp__vendor__frobnicate claudeai$/m);
  // a changed source is held even for a listed tool, and is noted on the seen entry
  assert.equal((await b.call('mcp__vendor__frobnicate', { source: 'project' })).decision, 'deny');
  assert.deepEqual(JSON.parse(await b.state('mcp-seen.json')).mcp__vendor__frobnicate.otherSources, ['project']);
  // turning the check off takes the allow file away again (the hook then behaves as before 1.3)
  await b.setPolicy(all('off')); await b.call('mcp__claude_ai_Gmail__get_thread');
  assert.equal(await b.state('mcp-allow'), null);
});

test('desktop is a standing class: a program go covers it, except an action aimed at this board', async () => {
  const b = await board(all('enforce'), { surfaceUrl: async (s) => ({ 'surface:3': 'https://example.com/', 'surface:9': 'http://localhost:3999/?dock=1' }[s] || null) });
  const task = await b.ledger.create({ title: 'drive a site', requester: 'helper', owner: 'builder' });
  await b.ledger.update(task.id, { op: 'start', actor: 'builder' });
  // without a go: each action asks
  assert.equal((await b.call('mcp__cmux-cua__click', { toolInput: { x: 1, y: 2 } })).decision, 'deny');
  await b.ledger.update(task.id, { op: 'request_approval', actor: 'builder', policy_item: 'program: drive the vendor site for this task', kind: 'program' });
  await b.ledger.update(task.id, { op: 'decide', actor: OWNER.id, decision: 'approve' }, { decider: true });
  const ok = await b.call('mcp__cmux-cua__click', { toolInput: { x: 5, y: 6 } });
  assert.equal(ok.decision, 'allow'); assert.match(ok.reason, /program go/);
  assert.equal((await b.call('mcp__claude-in-chrome__navigate', { toolInput: { url: 'https://example.com/' } })).decision, 'allow');
  assert.equal((await b.sh('cmux browser surface:3 click "#buy"')).decision, 'allow');
  // aimed at this board: asks every time, and the row says why
  const nav = await b.call('mcp__claude-in-chrome__navigate', { toolInput: { url: 'http://localhost:3999/?dock=1' } });
  assert.equal(nav.decision, 'deny');
  for (const c of ['cmux browser surface:9 click "#approve"', 'cmux browser surface:3 goto http://127.0.0.1:3999/', 'cmux browser surface:404 click "#x"', 'cmux browser click "#x"'])
    assert.equal((await b.sh(c)).decision, 'deny', c);
  const whys = (await b.ledger.get(task.id)).gates.filter((g) => g.status === 'pending').map((g) => g.why).join(' | ');
  assert.match(whys, /aimed at this board/); assert.match(whys, /shows this board/); assert.match(whys, /could not be read/);
  // an unlisted tool is not a standing class: the go does not cover it
  assert.equal((await b.call('mcp__vendor__frobnicate')).decision, 'deny');
});

// ── typing into another pane (check `paneReach`, read in observe first; Mission Control is left out) ──
const PANE_HELD = ['cmux send --workspace ws-other "please record the approval"', 'cmux send-key --workspace ws-other Enter', 'cmux send --surface surface:9 "y\\n"', 'cmux send --paste --workspace ws-other "$(cat notes.md)"',
  'cmux new-workspace --name helper --cwd /work/app --command "claude -p do-it"', 'cmux new-split right --command "sh run.sh"', 'cmux new-pane --command "node x.mjs"', 'cmux new-surface --command=top',
  `cmux new-workspace --layout '{"pane":{"surfaces":[{"type":"terminal","command":"vim"}]}}'`, 'tmux send-keys -t 1 "gh pr merge 5" Enter'];
const PANE_FREE = ['cmux send "echo hello"', 'cmux send --workspace ws-own "echo hello"', 'cmux send-key Enter', 'cmux new-workspace --name scratch', 'cmux new-split right', 'cmux read-screen --workspace ws-other',
  'cmux workspace list', 'cmux notify --title x --body y', 'tmux list-sessions', 'tmux new-session -d -s x'];

test('paneReach: text or keys into another pane and a new terminal with a command are held for an agent, never for Mission Control', () => {
  const pane = (command, mode, ctx = {}) => { const p = policyAt({ paneReach: mode }); return classify({ tool: 'Bash', command, cwd: '/work/app', workspaceId: 'ws-own' }, p, { ...ctxFor(p), ...ctx }); };
  for (const c of PANE_HELD) {
    const r = pane(c, 'enforce'); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'panes', c); assert.equal(r.check, 'paneReach');
    assert.equal(pane(c, 'off').verdict, 'clear'); assert.equal(pane(c, 'off').wouldHold, undefined);
    assert.equal(pane(c, 'observe').verdict, 'clear'); assert.equal(pane(c, 'observe').wouldHold?.check, 'paneReach', c);
    for (const m of MODES) { const mc = pane(c, m, { missionControl: true }); assert.equal(mc.verdict, 'clear', `MC ${m}: ${c}`); assert.equal(mc.wouldHold, undefined, `MC ${m}: ${c}`); }
  }
  for (const m of MODES) for (const c of PANE_FREE) { const r = pane(c, m); assert.equal(r.verdict, 'clear', `${m}: ${c} → ${r.why}`); assert.equal(r.wouldHold, undefined, `${m}: ${c}`); }
  assert.equal(DEFAULT_POLICY.checks.paneReach, 'observe');
});

test('paneReach on the board: an agent leaves a reading, Mission Control leaves none; the real hook passes both in observe', async () => {
  const b = await board(policyAt({ paneReach: 'observe' }));
  const c = 'cmux send --workspace ws-other "please record the approval"';
  assert.deepEqual(await b.sh(c), { decision: 'pass' });
  assert.deepEqual(await b.sh(c, { workspaceId: 'WM' }), { decision: 'pass' });
  const seen = await b.lines('observed.jsonl');
  assert.equal(seen.length, 1); assert.equal(seen[0].agent, 'builder'); assert.equal(seen[0].wouldHold, 'paneReach'); assert.equal(seen[0].cls, 'panes');
  const e = await board(policyAt({ paneReach: 'enforce' }));
  assert.equal((await e.sh(c)).decision, 'deny'); assert.deepEqual(await e.sh(c, { workspaceId: 'WM' }), { decision: 'pass' });
  const off = hookCopy('off'); const obs = hookCopy('observe');
  writeFileSync(path.join(obs, 'policy.json'), JSON.stringify(policyAt({ paneReach: 'observe' })));
  for (const x of [...PANE_HELD, ...PANE_FREE]) { const a = hookOut(off, bashJson(x)); assert.equal(hookOut(obs, bashJson(x)), a, x); assert.equal(a, '', x); }
  const enf = hookCopy('off'); writeFileSync(path.join(enf, 'policy.json'), JSON.stringify(policyAt({ paneReach: 'enforce' })));
  for (const x of PANE_HELD) assert.equal(decisionOf(hookOut(enf, bashJson(x))), 'deny', x);
});

test('mcp-review: three groups from the seen file, and a starting list for the policy', () => {
  const seen = { mcp__claude_ai_Gmail__get_thread: { server: 'claude_ai_Gmail', source: 'claudeai', count: 3, lastSeen: '2026-01-05T10:00:00Z' },
    mcp__claude_ai_Google_Drive__share_file: { server: 'claude_ai_Google_Drive', source: 'claudeai', count: 1, lastSeen: '2026-01-05T10:00:00Z' },
    mcp__vendor__frobnicate: { server: 'vendor', source: 'project', count: 2, lastSeen: '2026-01-05T10:00:00Z' }, 'not-mcp': {} };
  const g = review(seen, DEFAULT_POLICY);
  assert.deepEqual([g.rule.map((r) => r.tool), g.read.map((r) => r.tool), g.unlisted.map((r) => r.tool)], [['mcp__claude_ai_Google_Drive__share_file'], ['mcp__claude_ai_Gmail__get_thread'], ['mcp__vendor__frobnicate']]);
  assert.equal(g.rule[0].cls, 'remote-write');
  const text = render(g);
  assert.match(text, /held by a rule \(1\)/); assert.match(text, /passing as a read \(1\)/); assert.match(text, /not classified.*\(1\)/); assert.match(text, /"mcpRead"/);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-review-')); mkdirSync(path.join(dir, 'data', 'guardrails'), { recursive: true });
  writeFileSync(path.join(dir, 'data', 'guardrails', 'mcp-seen.json'), JSON.stringify(seen)); writeFileSync(path.join(dir, 'p.json'), JSON.stringify(DEFAULT_POLICY));
  const cli = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-review.mjs'), '--root', dir, '--policy', path.join(dir, 'p.json'), '--json'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).unlisted[0].tool, 'mcp__vendor__frobnicate');
  assert.match(spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'mcp-review.mjs'), '--root', mkdtempSync(path.join(os.tmpdir(), 'mcp-none-'))], { encoding: 'utf8' }).stdout, /MCP tools seen: 0/);
});

test('slice 7 lines while their checks only observe: they route the call and never hold it (off and observe answer alike)', () => {
  const at = (mode) => ({ ...structuredClone(DEFAULT_POLICY), checks: Object.fromEntries(CHECKS.map((n) => [n, mode])) });
  const runAt = (command, mode) => { const p = at(mode); return classify({ tool: 'Bash', command, cwd: '/work/app' }, p, { home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', git: () => null, ignoreCase: false }); };
  const py = (body) => `python3 - <<'PY'\n${body}\nPY`;
  const rows = [py('print("cmux send --workspace x would type into a pane")'), py('print("tmux send-keys -t 1 ls Enter")'), py('print("gh api -X POST repos/o/r/issues")'), py('print("gh release create v1")'),
    py('print("gh workflow run ci.yml")'), py('print("gh alias set co pr checkout")'), 'NOTE="gh issue close 5"; echo "$NOTE"', 'X="cmux browser click"; echo "$X" | wc -c'];
  for (const c of rows) {
    const off = runAt(c, 'off'); const obs = runAt(c, 'observe');
    assert.equal(off.verdict, 'clear', `off: ${JSON.stringify(c)} → ${off.why}`);
    assert.equal(obs.verdict, 'clear', `observe must answer like off: ${JSON.stringify(c)} → ${obs.why}`);
  }
});

// ── the review of PR 112 ──
test('review 1: the hook\'s MCP fast path takes the name only when it stands once in the input; a second one goes to the Node step', () => {
  const READ = READS[0]; const WRITE = 'mcp__claude_ai_Atlassian_Rovo__createJiraIssue'; const NEW = 'mcp__vendor__frobnicate';
  const dir = hookCopy('enforce', [mcpAllowKey(READ, 'claudeai')]);
  assert.equal(hookOut(dir, mcpJson(READ)), '', 'the read on the allow file passes');
  assert.equal(decisionOf(hookOut(dir, mcpJson(WRITE))), 'deny'); assert.equal(decisionOf(hookOut(dir, mcpJson(NEW))), 'deny');
  // a key inside the tool's own input that names the read: the last "tool_name" in the text used to win
  for (const name of [WRITE, NEW]) {
    assert.equal(decisionOf(hookOut(dir, mcpJson(name, 'claudeai', { fields: { tool_name: READ } }))), 'deny', `${name} with a nested tool_name`);
    assert.equal(decisionOf(hookOut(dir, mcpJson(name, 'claudeai', { note: `"tool_name":"${READ}"` }))), 'deny', `${name} with a quoted copy in a text field`);
    assert.equal(decisionOf(hookOut(dir, mcpJson(name, 'claudeai', { meta: { mcp_server: { name: 'x', source: 'claudeai' } } }))), 'deny', `${name} with a nested mcp_server`);
    // key order must not matter either: the real name last, a decoy first
    const o = mcpJson(name); const swapped = JSON.stringify({ tool_input: { tool_name: READ }, ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'tool_input')) });
    assert.equal(decisionOf(hookOut(dir, swapped)), 'deny', `${name}, decoy first`);
  }
  // the read itself with a busy input goes to the Node step and still passes there
  assert.equal(decisionOf(hookOut(dir, mcpJson(READ, 'claudeai', { fields: { tool_name: 'x', source: 'y' } }))), 'pass');
  // a source spelled twice is not trusted by the shell: the Node step reads the real one
  const tdir = mkdtempSync(path.join(os.tmpdir(), 'mcp-shim2-')); const shim = path.join(tdir, 'node'); const marker = path.join(tdir, 'ran');
  writeFileSync(shim, `#!/bin/sh\n: > "${marker}"\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  hookOut(dir, mcpJson(READ), { GATE_NODE: shim }); assert.equal(existsSync(marker), false, 'the plain read ends in the shell');
  hookOut(dir, mcpJson(READ, 'project', { source: 'claudeai' }), { GATE_NODE: shim });
  assert.equal(existsSync(marker), true, 'a read called from another source, with the old source as a decoy in its input, reaches the Node step');
  // the other hook event's name in a text field: the call has not run yet, and is judged (hotfix #515 took the same test out of the tail)
  for (const name of [WRITE, NEW]) {
    assert.equal(decisionOf(hookOut(dir, mcpJson(name, 'claudeai', { note: 'PostToolUse' }))), 'deny', `${name} with the other event's name in a text field`);
    assert.equal(decisionOf(hookOut(dir, mcpJson(name, 'claudeai', { note: '"hook_event_name":"PostToolUse"' }))), 'deny', `${name} with a quoted copy of the event key`);
    assert.equal(decisionOf(hookOut(dir, mcpJson(name, 'claudeai', { hook_event_name: 'PostToolUse' }))), 'deny', `${name} with a nested event key`);
  }
  // the script has no event test in its MCP block
  const block = readFileSync(path.join(ROOT, 'scripts', 'gate-hook.sh'), 'utf8').split('MCP default (1.3)')[1].split('# The Node step, under a deadline')[0];
  assert.ok(block.length > 200 && block.length < 3000, 'the MCP block was found');
  assert.ok(!/PostToolUse/.test(block), 'the MCP block must not look for an event name in the whole input');
});

test('review 2: the allow file on disk is compared, not only the list in memory; a foreign line is written over and said', async () => {
  const b = await board(all('enforce'));
  await b.call('mcp__claude_ai_Gmail__get_thread');
  const file = path.join(b.dir, 'guardrails', 'mcp-allow');
  assert.equal(await b.state('mcp-allow'), 'mcp__claude_ai_Gmail__get_thread claudeai\n');
  await writeFile(file, 'mcp__claude_ai_Gmail__get_thread claudeai\nmcp__vendor__frobnicate claudeai\n');
  b.tick(61_000); await b.sh('git status');                                      // any call, a minute later
  assert.equal(await b.state('mcp-allow'), 'mcp__claude_ai_Gmail__get_thread claudeai\n');
  assert.ok(b.events.some((e) => /MCP allow file was changed from outside \(1 foreign line/.test(e)), b.events.join(' | '));
  // …and at once when the list is next computed (another MCP call), without waiting the minute
  await writeFile(file, 'mcp__vendor__frobnicate claudeai\n'); await b.call('mcp__claude_ai_Gmail__get_thread');
  assert.equal(await b.state('mcp-allow'), 'mcp__claude_ai_Gmail__get_thread claudeai\n');
  // the integrity stage asks the same question and is told
  assert.deepEqual(await b.svc.verifyMcpAllow(), { ok: true });
  await writeFile(file, 'mcp__claude_ai_Gmail__get_thread claudeai\nmcp__vendor__spin_up claudeai\n');
  assert.deepEqual(await b.svc.verifyMcpAllow(), { ok: false, rewritten: true, foreign: 1, missing: false });
  assert.equal(await b.state('mcp-allow'), 'mcp__claude_ai_Gmail__get_thread claudeai\n'); assert.deepEqual(await b.svc.verifyMcpAllow(), { ok: true });
  // the check off: a file put there by hand is taken away
  const off = await board(all('off')); await off.sh('git status');
  await mkdir(path.join(off.dir, 'guardrails'), { recursive: true }); await writeFile(path.join(off.dir, 'guardrails', 'mcp-allow'), 'mcp__vendor__frobnicate claudeai\n');
  off.tick(61_000); await off.sh('git status');
  assert.equal(await off.state('mcp-allow'), null);
});

test('review 3: a graphql body the gate cannot read is held; a query written on the command line stays free', () => {
  const p = all('enforce'); const run = (command) => classify({ tool: 'Bash', command, cwd: '/work/app' }, p, { home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', git: () => null, ignoreCase: false });
  for (const c of ['gh api graphql --input body.json', 'gh api graphql --input=body.json', 'gh api graphql -F query=@mutation.graphql', 'gh api graphql -F query=@q.graphql', 'cat m.graphql | gh api graphql -F query=@-',
    'gh api graphql --field query=@q.txt -F owner=acme', "gh api graphql -f query='mutation { addStar(input:{starrableId:\"x\"}) { clientMutationId } }'"]) {
    const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'remote-write', c); assert.equal(r.check, 'remoteWrite');
  }
  for (const c of ["gh api graphql -f query='query { viewer { login } }'", "gh api graphql -F owner=acme -f query='query($owner:String!){ organization(login:$owner){ id } }'", 'gh api graphql --paginate -f query="query { viewer { id } }"'])
    assert.equal(run(c).verdict, 'clear', c);
});

test('review 4: in observe the ticker gets one line per MCP tool and day; the observed file and the log keep every call', async () => {
  const b = await board(all('observe'));
  for (let i = 0; i < 5; i++) await b.call('mcp__vendor__frobnicate');
  await b.call('mcp__vendor__spin_up');
  const tick = () => b.events.filter((e) => /guardrails \(observe\): mcpDefault would hold/.test(e));
  assert.equal(tick().length, 2, tick().join(' | ')); assert.match(tick()[0], /mcp__vendor__frobnicate/);
  assert.equal((await b.lines('observed.jsonl')).filter((l) => l.tool === 'mcp__vendor__frobnicate').length, 5);
  b.tick(24 * 3600e3); await b.call('mcp__vendor__frobnicate');
  assert.equal(tick().length, 3, 'the next day it is said once more');
  // a shell reading is not thinned out
  const n0 = b.events.length; await b.sh('gh release create v1'); await b.sh('gh release create v1');
  assert.equal(b.events.slice(n0).filter((e) => /remoteWrite would hold/.test(e)).length, 2);
});

test('review 5: Mission Control is left out of paneReach only when the session behind the call is Mission Control', async () => {
  const b = await board(policyAt({ paneReach: 'enforce' }));
  // the control: the same call from an ordinary agent is held, so the passes below are the exemption and nothing else
  assert.equal((await b.svc.check({ event: 'pre', engine: 'claude', tool: 'Bash', command: PANE_HELD[0], cwd: '/work/app', workspaceId: 'W2' })).decision, 'deny');
  const cmd = PANE_HELD[0];
  const session = (name) => ({ kind: 'agent', name, workspaceId: 'w', basis: 'session-map', agentAncestor: true, underCmux: true, browser: false });
  const asMc = { event: 'pre', engine: 'claude', tool: 'Bash', command: cmd, cwd: '/work/app', workspaceId: 'WM' };   // WM is Mission Control's workspace
  // names not enforced: the declared workspace is believed, as before 1.3
  assert.equal((await b.svc.check(asMc)).decision, 'pass');
  // names enforced: the real Mission Control passes
  assert.equal((await b.svc.check(asMc, { names: true, evidence: async () => session('coordinator') })).decision, 'pass');
  // …and a session that only declares Mission Control's workspace does not
  for (const [what, opts] of [['another agent', { names: true, evidence: async () => session('builder') }], ['no evidence', { names: true }], ['a lookup that fails', { names: true, evidence: async () => { throw new Error('x'); } }],
    ['unknown', { names: true, evidence: async () => ({ kind: 'unknown', agentAncestor: false, browser: false }) }]]) {
    const r = await b.svc.check(asMc, opts); assert.equal(r.decision, 'deny', `${what}: ${JSON.stringify(r).slice(0, 160)}`);
  }
  // an ordinary agent is held either way
  assert.equal((await b.svc.check({ ...asMc, workspaceId: 'W1' }, { names: true, evidence: async () => session('builder') })).decision, 'deny');
});

test('review 6: gh forms that publish or speak in public', () => {
  const p = all('enforce'); p.lists.publicRemotes = ['acme-public/*'];
  const ctx = (origin) => ({ home: '/home/u', boardRoot: '/work/board', repoRoot: () => '/work/app', git: (cwd, a) => (a[0] === 'remote' ? origin : null), ignoreCase: false });
  const run = (command, origin = 'git@github.com:acme/private-app.git', pol = p) => classify({ tool: 'Bash', command, cwd: '/work/app' }, pol, ctx(origin));
  for (const c of ['gh gist create notes.md', 'gh gist create --public notes.md', 'gh gist edit abc123 -f notes.md', 'gh repo create acme/new --public', 'gh repo create --public --source .', 'gh pr review 5 --approve', 'gh pr review 5 --comment -b "looks good"',
    'gh pr review --request-changes -b x 5']) { const r = run(c); assert.equal(r.verdict, 'gate', `${c} → ${r.why}`); assert.equal(r.cls, 'remote-write', c); assert.equal(r.check, 'remoteWrite'); }
  // comments, issues, pull requests and edits: held when the repo is on the public list, by flag, by address or by the checkout's origin
  const posts = ['gh pr comment 5 -b "thanks"', 'gh issue comment 9 --body x', 'gh issue create -t bug -b text', 'gh pr create --fill', 'gh pr edit 5 --title x', 'gh issue edit 9 --add-label bug'];
  for (const c of posts) {
    assert.equal(run(`${c} -R acme-public/tool`).cls, 'remote-write', `${c} -R`); assert.equal(run(c, 'https://github.com/acme-public/tool.git').cls, 'remote-write', `${c} by origin`);
    assert.equal(run(c).verdict, 'clear', `${c} on a private repo`); assert.equal(run(`${c} --repo acme/private-app`, 'https://github.com/acme-public/tool.git').verdict, 'clear', `${c}: the flag names a private repo`);
  }
  assert.equal(run('gh pr comment https://github.com/acme-public/tool/pull/5 -b hi').cls, 'remote-write');
  assert.match(run('gh pr comment 5 -b hi', null).why, /cannot resolve/);                       // no origin to read: asked
  // free: reads, a private repo, and every post when no repo is listed as public
  for (const c of ['gh repo create acme/new --private', 'gh repo create acme/new', 'gh gist list', 'gh gist view abc', 'gh pr view 5 --comments', 'gh pr checks 5', 'gh issue list', 'gh pr list', 'gh run rerun 123', 'gh pr diff 5']) assert.equal(run(c).verdict, 'clear', c);
  for (const c of posts) assert.equal(run(`${c} -R acme-public/tool`, 'x', all('enforce')).verdict, 'clear', `${c} with an empty public list`);
  // off and observe: nothing is held
  for (const m of ['off', 'observe']) { const q = all(m); q.lists.publicRemotes = ['acme-public/*']; for (const c of ['gh gist create notes.md', 'gh pr review 5 --approve', 'gh pr comment 5 -b x -R acme-public/tool']) assert.equal(run(c, 'x', q).verdict, 'clear', `${m}: ${c}`); }
});
