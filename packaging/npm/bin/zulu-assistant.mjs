#!/usr/bin/env node
// npx zulu-assistant [install.sh args] — clone on first use (default ~/zulu-assistant,
// override with ZULU_HOME), then hand over to ./install.sh. Zero dependencies.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const home = process.env.ZULU_HOME || path.join(os.homedir(), 'zulu-assistant');
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (process.platform !== 'darwin') console.error('note: Zulu Assistant targets macOS; only --demo works elsewhere.');
if (!existsSync(path.join(home, '.git'))) run('git', ['clone', '--depth', '1', 'https://github.com/zulu-assistant/zulu-assistant.git', home]);
run(path.join(home, 'install.sh'), process.argv.slice(2), { cwd: home });
