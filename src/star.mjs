// Growth & consent surface: the ONE in-product ask to star the repo.
//
// GitHub has no ratings; a star from the user's own account is the only signal,
// and GitHub's rules forbid automated/inauthentic engagement. So:
//   - install.sh asks once ("Star zulu-assistant on GitHub? [y/N]"), default No,
//     and only on an explicit y stars under the user's OWN gh login;
//   - the board shows ONE toast at the first success moment (first self-heal
//     repair or first ledger task closed). Star just opens the repo page (the
//     user stars it there, or not); Never ask again records that. Once shown it
//     is never shown again, whatever the user clicked;
//   - no pre-checked or silent starring, no OAuth app, no repeats, no gating.
// Both surfaces share data/star-prompt.json:
//   { installer: { answer: 'y'|'n', at }, board: { pending: {reason, at}, shownAt, decision: 'star'|'never', at } }
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO } from './demo.mjs';

// demo mode keeps its own toast state (a demo run never touches the real board's)
export const STAR_FILE = fileURLToPath(new URL(DEMO ? '../data/demo-star-prompt.json' : '../data/star-prompt.json', import.meta.url));

export async function readStar(file = STAR_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}

async function writeStar(doc, file) {
  const tmp = path.join(path.dirname(file), `.star-prompt.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(doc, null, 1));
  await rename(tmp, file);
}

/** Done asking on the board: already shown once, decided, or starred at install. */
export const boardDone = (doc) => Boolean(doc.board?.shownAt || doc.board?.decision || doc.installer?.answer === 'y');

/** First success moment → queue the toast (a no-op after the first one). */
export async function successMoment(reason, { file = STAR_FILE, now = Date.now() } = {}) {
  const doc = await readStar(file);
  if (boardDone(doc) || doc.board?.pending) return false;
  doc.board = { ...(doc.board || {}), pending: { reason: String(reason).slice(0, 120), at: now } };
  await writeStar(doc, file);
  return true;
}

/** What the page should show: the pending toast, or nothing. */
export function toastFor(doc, repoUrl) {
  if (!repoUrl || boardDone(doc) || !doc.board?.pending) return null;
  return { reason: doc.board.pending.reason, repoUrl };
}

/** The page reports: 'shown' (rendered once), 'star' (opened the repo page), 'never'. */
export async function recordToast(event, { file = STAR_FILE, now = Date.now() } = {}) {
  if (!['shown', 'star', 'never'].includes(event)) return false;
  const doc = await readStar(file);
  const board = { ...(doc.board || {}) };
  if (event === 'shown') board.shownAt = board.shownAt || now;
  else { board.decision = event; board.at = now; board.shownAt = board.shownAt || now; }
  doc.board = board;
  await writeStar(doc, file);
  return true;
}
