// Shared by the tests that start a real demo board (server.mjs with MC_DEMO=1) from the checkout.
// Not a test file itself.
//
// Every such board gets a ledger folder of its own. A demo board re-seeds its ledger folder at
// startup, the test runner starts test files side by side, and two demo boards sharing
// data/demo-tasks removed each other's files mid-write: the loser died at once (ENOENT, exit 1)
// and its test then waited 15 s for a board that was already gone ("demo board answered").
// test/demo.test.mjs fails with the file and line when a test starts a demo board without this.
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** The environment for a demo board: demo mode, a 1 s poll, its own ledger folder, then `extra` (the port, switches). */
export function demoEnv(extra = {}) {
  return { ...process.env, MC_DEMO: '1', MC_DEMO_POLL: '1', MC_DEMO_TASKS: mkdtempSync(path.join(os.tmpdir(), 'zulu-demo-tasks-')), ...extra };
}

/**
 * A port the system hands out, for a board a test starts. A port picked at random from a fixed
 * range of 40 to 90 collided when two suites ran at once on one machine (a lane's own run beside
 * a reviewer's): the second board could not listen, and its test talked to the other suite's board
 * or waited 15 s for nothing. The port is free at the moment it is returned; the board binds it a
 * moment later, which is as close as a test can get without the board choosing its own port.
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}
