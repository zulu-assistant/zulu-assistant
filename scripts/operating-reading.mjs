#!/usr/bin/env node
// The weekly operating reading, now (src/operating-reading.mjs).
//
//   node scripts/operating-reading.mjs [--days 7] [--end <iso>] [--json] [--dir <ledger dir>] [--comment <task-id>]
//
// Reads the ledger files read-only (data/tasks/*.json, or --dir) and prints the reading for the
// trailing --days (default 7) and the same span before it. --comment posts the text to that
// ledger task as the board's system actor (`board`), through the board's API.
// Exit 0 = printed (and posted), 2 = error.
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { computeReading, readingText, readingLine, readTasksDir } from '../src/operating-reading.mjs';
import { OWNER } from '../src/config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

async function postComment(taskId, text) {
  const port = process.env.MC_PORT || 3210;
  const r = await fetch(`http://127.0.0.1:${port}/api/tasks/${taskId}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...(process.env.MESH_BOARD_TOKEN ? { 'x-mesh-board': process.env.MESH_BOARD_TOKEN } : {}) }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ actor: 'board', op: 'comment', text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`comment on #${taskId} failed: ${j.msg || r.status}`);
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dir = opt('--dir') || path.join(ROOT, 'data', 'tasks');
  const end = opt('--end') ? Date.parse(opt('--end')) : Date.now();
  if (!Number.isFinite(end)) throw new Error('--end must be a date');
  const days = Number(opt('--days')) || 7;
  const r = computeReading(await readTasksDir(dir), { end, days, owner: OWNER.id });
  if (args.includes('--json')) console.log(JSON.stringify({ ...r, line: readingLine(r) }, null, 1));
  else console.log(readingText(r));
  if (opt('--comment')) await postComment(opt('--comment'), readingText(r));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => { console.error(`operating-reading: ${e.message}`); process.exit(2); });
}
