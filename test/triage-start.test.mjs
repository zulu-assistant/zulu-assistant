import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 1.2.3: the scheduled triage pass is started with --tools, --strict-mcp-config and --disable-slash-commands
// when the installed Claude Code lists all three, and with the allow list alone (and a log line) when it does not.
// Run on a copy of scripts/triage.sh with stand-ins for everything it calls; nothing reaches a model or the board.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HELP_NEW = 'Options:\n  --disable-slash-commands              Disable all skills and commands\n  --strict-mcp-config                   Only use MCP servers from --mcp-config,\n  --tools <tools...>                    Specify the list of available tools from\n';
const HELP_OLD = 'Options:\n  --strict-mcp-config                               Only use MCP servers from --mcp-config\n  --allowedTools, --allowed-tools <tools...>  Comma or space-separated list\n';

function run(help) {
  const d = mkdtempSync(path.join(os.tmpdir(), 'triage-start-'));
  for (const sub of ['scripts', 'config', 'data', 'bin']) mkdirSync(path.join(d, sub));
  copyFileSync(path.join(ROOT, 'scripts/triage.sh'), path.join(d, 'scripts/triage.sh'));
  writeFileSync(path.join(d, 'scripts/env.sh'), 'mc_resolve() { printf "%s\\n" "$ROOT/$1"; }\n');
  writeFileSync(path.join(d, 'scripts/engine.mjs'), "console.log('claude');\n");
  writeFileSync(path.join(d, 'scripts/worker-model.sh'), '#!/bin/sh\necho test-model\n');
  writeFileSync(path.join(d, 'data/cmux-socket-password'), 'x\n');
  writeFileSync(path.join(d, 'config/TRIAGE.md'), 'the procedure\n');
  writeFileSync(path.join(d, 'help.txt'), help);
  writeFileSync(path.join(d, 'bin/claude'), `#!/bin/sh
case "$1" in --help) cat "${d}/help.txt"; exit 0 ;; --version) echo "9.9.9 (Claude Code)"; exit 0 ;; esac
for a in "$@"; do printf '%s\\n' "$a"; done > "${d}/args.txt"
cat > "${d}/stdin.txt"
`);
  for (const f of ['scripts/worker-model.sh', 'bin/claude']) chmodSync(path.join(d, f), 0o755);
  const r = spawnSync('/bin/zsh', [path.join(d, 'scripts/triage.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${path.join(d, 'bin')}:${process.env.PATH}` } });
  const args = existsSync(path.join(d, 'args.txt')) ? readFileSync(path.join(d, 'args.txt'), 'utf8').trim().split('\n') : null;
  const stdin = existsSync(path.join(d, 'stdin.txt')) ? readFileSync(path.join(d, 'stdin.txt'), 'utf8') : null;
  rmSync(d, { recursive: true, force: true });
  return { r, args, stdin };
}

test('a Claude Code that lists the three flags starts the pass with four tools, no MCP server and no skills', { skip: !existsSync('/bin/zsh') && 'no zsh' }, () => {
  const { r, args, stdin } = run(HELP_NEW);
  assert.equal(r.status, 0, r.stderr);
  const i = args.indexOf('--tools');
  assert.ok(i > 0, args.join(' '));
  assert.equal(args[i + 1], 'Bash,Read,Write,Edit');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--disable-slash-commands'));
  assert.equal(args[args.length - 2], '--allowedTools', 'the variadic list stays last');
  assert.equal(stdin, 'the procedure\n', 'the procedure arrives on stdin');
  assert.doesNotMatch(r.stderr, /allow list only/);
});

test('a Claude Code without them starts the pass as before and says so in the log', { skip: !existsSync('/bin/zsh') && 'no zsh' }, () => {
  const { r, args, stdin } = run(HELP_OLD);
  assert.equal(r.status, 0, r.stderr);
  for (const f of ['--tools', '--strict-mcp-config', '--disable-slash-commands']) assert.ok(!args.includes(f), f);
  assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'test-model', '--permission-mode', 'acceptEdits']);
  assert.equal(args[5], '--allowedTools');
  assert.equal(stdin, 'the procedure\n');
  assert.match(r.stderr, /triage: 9\.9\.9 \(Claude Code\) does not list --tools, --strict-mcp-config and --disable-slash-commands; the pass starts with the allow list only/);
});
