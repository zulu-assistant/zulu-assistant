// Imported FIRST by every test file (test/temp-root.test.mjs checks it): one temp folder per test process,
// removed when the process ends. Setting TMPDIR here points os.tmpdir() at it, and every child the test
// starts (demo boards, installers, git, the hook) inherits it, so the suite's mkdtemp calls need no change
// and nothing is left behind in the system temp folder (#665: ~231,000 folders, ~31 GB, in five weeks).
// KEEP_TEST_TMP=1 keeps the folder and prints where it is.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), 'zulu-test-'));
process.env.TMPDIR = TEMP_ROOT;

let done = false;
function removeRoot() {
  if (done) return;
  done = true;
  if (process.env.KEEP_TEST_TMP === '1') { process.stderr.write(`test temp kept: ${TEMP_ROOT}\n`); return; }
  try { rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 3 }); }
  catch (e) { process.stderr.write(`test temp not removed: ${TEMP_ROOT} (${e.code || e.message})\n`); }
}
process.on('exit', removeRoot);
// The runner ends a file that runs past its timeout with a signal; clean up, then end the same way.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.once(sig, () => { removeRoot(); process.kill(process.pid, sig); });
}
