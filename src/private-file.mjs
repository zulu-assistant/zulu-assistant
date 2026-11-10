// Owner-only files (mode 600): the ONE place core code creates them (re-exported by src/config.mjs).
//
// Why one place: a backup treats a file that gives nothing to group or other as a credential and
// leaves it out unless it sits in a state folder on the backup's keep list (scripts/backup.mjs).
// So "who writes owner-only files" is part of the backup rule, and test/hygiene.test.mjs fails on
// the mode literal anywhere else in server.mjs, src/ or scripts/.
//
// No imports from the rest of the board: the backup and restore tools load this without the registry.
import { writeFile, appendFile, chmod } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';

export const PRIVATE_MODE = 0o600;

/** True when a mode gives nothing to group or other (600, 400, 700): the backup's credential test. */
export const isOwnerOnly = (mode) => (Number(mode) & 0o077) === 0;

/**
 * Write (or with `append`, append to) a file only its owner can read. The mode option of the fs
 * calls applies only when the file is created, so the mode is set again afterwards: an existing
 * file with looser modes is tightened too.
 */
export async function writePrivate(file, data, { append = false } = {}) {
  if (append) await appendFile(file, data, { mode: PRIVATE_MODE });
  else await writeFile(file, data, { mode: PRIVATE_MODE });
  await chmod(file, PRIVATE_MODE);
}

/** Tighten an existing file (one that another program wrote, or a rename target) to owner-only. */
export const makePrivate = (file) => chmod(file, PRIVATE_MODE);

/** A write stream to an owner-only file (downloads). Call makePrivate after it closes when the file may have existed. */
export const privateWriteStream = (file) => createWriteStream(file, { mode: PRIVATE_MODE });
