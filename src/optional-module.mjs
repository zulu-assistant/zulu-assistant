// A module the board loads only when its file is present (#797). Some lanes are kept out of the public edition by the
// publish manifest's `withheld` list; the board must start without them, and must not hide a fault in one that is
// there. So: no file = null (the lane does not exist on this install); a file that is there is imported, and any error
// it raises (a syntax error, a missing import of its own) is thrown to the caller as usual.
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** file: a path or a file: URL. */
export async function loadOptional(file) {
  if (!existsSync(file)) return null;
  return import(file instanceof URL ? file.href : pathToFileURL(file).href);
}
