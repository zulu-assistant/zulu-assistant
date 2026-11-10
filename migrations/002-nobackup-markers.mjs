// 002: the .nobackup marker (1.3). A folder that holds another program's credential files (the phone
// relay's server folder, a TLS key folder) is never backed up and never restored into. Installs that
// set such a folder up before the marker existed get it here. Nothing else changes; a folder that
// does not exist is left alone.
import { MARKER, MARKED_DIRS, MARKER_TEXT } from '../scripts/backup.mjs';

export const id = '002-nobackup-markers';
export const description = 'mark the relay and TLS folders as never backed up';
export async function up(ctx) {
  for (const d of MARKED_DIRS) if (ctx.exists(d)) await ctx.addFile(`${d}/${MARKER}`, MARKER_TEXT);
}
