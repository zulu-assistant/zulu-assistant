#!/usr/bin/env node
// The anchor (docs/GUARDRAILS.md): the gate hook registered in Claude Code's MANAGED settings.
// Run by scripts/guardrails-anchor.sh, which renders the installer's own hook template first.
//
//   node scripts/guardrails-anchor.mjs <rendered template.json> [--check] [--remove] [--root <dir>] [--stage <file>]
//
// Why: the hook is registered in the user's settings file. A project file can switch every such
// hook off, and a session started with the user settings left out has no gate hook at all. Managed
// settings are read by every session and cannot be switched off from user or project settings.
//
// What this does: nothing with administrator rights. It writes the file to a staging place in
// data/, shows it, and prints ONE line for the owner to type. That line copies the staged file into
// the managed settings folder as a drop-in, after checking the staged file's hash, and moves it into
// place whole: a managed file that is not valid JSON makes Claude Code refuse to start.
//   --check    is it anchored? exit 0 = yes, 3 = no (absent, not what this checkout would write, or in a folder
//              that can be written without administrator rights)
//   --remove   print the line that takes it out again
//   --root     (tests) a folder that stands in for the filesystem root
//   --stage    (tests) where the staged copy goes instead of data/anchor/
//   --user-settings  (tests) the user's settings file to compare with instead of ~/.claude/settings.json
//   --anyway   print the line although the user's own settings register another checkout's hook
import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The drop-in's name. A number in front so it sorts among other parts of a policy; Claude Code reads every *.json there. */
export const ANCHOR_FILE = '50-zulu-guardrails.json';
/** Where Claude Code reads managed settings from, per platform (its documentation, 2026-11). */
export function managedDir(platform = process.platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'linux') return '/etc/claude-code';
  return null;
}
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The gate's own hook entries out of a rendered template: only entries that run one of its two scripts. */
export function anchorHooks(rendered) {
  const out = {};
  for (const [event, groups] of Object.entries(rendered?.hooks || {})) {
    const keep = (Array.isArray(groups) ? groups : []).map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => /\/scripts\/gate-(config-)?hook\.sh'$/.test(String(h.command || ''))) })).filter((g) => g.hooks.length);
    if (keep.length) out[event] = keep;
  }
  return out;
}
const anchorHooksOf = (settings) => anchorHooks(settings);
/** The managed file's text: the hook entries and nothing else. Byte for byte what the staging file holds. */
export function anchorText(rendered) {
  const hooks = anchorHooks(rendered);
  if (!Object.keys(hooks).length) throw new Error('the rendered template holds no gate hook entry');
  const text = `${JSON.stringify({ hooks }, null, 2)}\n`;
  JSON.parse(text);                                            // what is written must parse: Claude Code refuses to start otherwise
  return text;
}
/** absent | anchored | differs | unreadable — the managed drop-in against what this checkout would write. */
export function anchorState(want, read) {
  let have;
  try { have = read(); } catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'unreadable'; }
  if (have === want) return 'anchored';
  try { return JSON.stringify(JSON.parse(have)) === JSON.stringify(JSON.parse(want)) ? 'anchored' : 'differs'; } catch { return 'differs'; }
}
/**
 * Which checkout's gate hook the user's own settings file registers, when it is not this one (else null).
 * The anchor must name the same script the installer registered: anchoring a worktree by mistake
 * would point every session at a folder that is later removed.
 */
export function registeredElsewhere(userSettings, root) {
  const cmds = Object.values(userSettings?.hooks || {}).flatMap((groups) => (Array.isArray(groups) ? groups : []).flatMap((g) => (g.hooks || []).map((h) => String(h.command || ''))));
  const paths = [...new Set(cmds.map((c) => /'([^']+)\/scripts\/gate-hook\.sh'$/.exec(c)?.[1]).filter(Boolean))];
  if (!paths.length || paths.includes(root)) return null;
  return paths[0];
}
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/**
 * The line the owner types. Every program by its full path. The staged file is copied under a
 * hidden name (Claude Code ignores those); the hash of what was shown is in the line itself and is
 * checked on that copy, so a file swapped after it was shown never goes live; then the copy is
 * renamed into place, so no session ever reads half a file.
 *
 * The copy is readable by an administrator ONLY (mode 600) until its hash has matched. The staged
 * path is in data/, which any agent can write, and `install` follows a link: a staged path swapped
 * for a link to a file only root can read would otherwise sit in the managed folder, readable by
 * everyone, for as long as the hash takes (Mission Control's probe read it in 4 of 5 runs). So the
 * hash is read with administrator rights, and the file is opened to readers only after it matched.
 */
export function installLine({ staged, sha, dir, group = 'wheel', sum = '/usr/bin/shasum -a 256' }) {
  const d = path.join(dir, 'managed-settings.d'); const tmp = path.join(d, `.${ANCHOR_FILE}.new`); const dst = path.join(d, ANCHOR_FILE);
  // the hash is checked on the COPY, which only an administrator can change or (until it matched) read
  // both folders are made 755 by name: `-p` alone would give the outer one whatever the administrator's umask says
  return `sudo /bin/mkdir -p -m 755 ${q(dir)} ${q(d)} && sudo /usr/bin/install -m 600 -o root -g ${group} ${q(staged)} ${q(tmp)} && [ "$(sudo ${sum} ${q(tmp)} | /usr/bin/cut -d' ' -f1)" = ${sha} ] && sudo /bin/chmod 644 ${q(tmp)} && sudo /bin/mv -f ${q(tmp)} ${q(dst)} && echo anchored || { sudo /bin/rm -f ${q(tmp)}; echo 'NOT anchored: the staged file is not the one that was shown, or a step failed'; }`;
}
/**
 * "Anchored" promises a folder only an administrator can write. The file's text alone cannot say
 * that: a managed folder somebody made by hand, or a tool created under the user's name, can be
 * rewritten by any agent. → the paths (the managed folder, its drop-in folder, the file) that are
 * not owned by `uid` (0, the administrator) or that group or others can write.
 *   stat(path) → { uid, mode } | null
 */
export function writableWithoutAdmin(paths, stat, uid = 0) {
  return paths.filter((p) => { const st = stat(p); return !st || st.uid !== uid || (st.mode & 0o022) !== 0; });
}
export const removeLine = ({ dir }) => `sudo /bin/rm -f ${q(path.join(dir, 'managed-settings.d', ANCHOR_FILE))} && echo 'anchor removed'`;

function main() {
  const args = process.argv.slice(2);
  const flag = (n) => args.includes(n);
  const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
  const tmpl = args.find((a) => !a.startsWith('--') && ![val('--root'), val('--stage'), val('--user-settings')].includes(a));
  if (!tmpl) { console.error('usage: guardrails-anchor.mjs <rendered template.json> [--check] [--remove] [--root <dir>]'); process.exit(2); }
  const base = managedDir();
  if (!base) { console.error(`no managed settings folder is known for ${process.platform}`); process.exit(2); }
  const dir = path.join(val('--root') || '/', base);
  const target = path.join(dir, 'managed-settings.d', ANCHOR_FILE);
  const want = anchorText(JSON.parse(readFileSync(tmpl, 'utf8')));
  const state = anchorState(want, () => readFileSync(target, 'utf8'));
  // a stand-in root (tests) belongs to whoever runs the test; the real one must be the administrator's
  const loose = state === 'anchored' ? writableWithoutAdmin([dir, path.dirname(target), target], (p) => { try { return statSync(p); } catch { return null; } }, val('--root') ? process.getuid() : 0) : [];
  if (loose.length && !flag('--remove')) {
    console.log(`NOT anchored in effect: the managed file holds this checkout's hook entries, but ${loose.join(', ')} can be written without administrator rights, so the entries can be changed by anyone (${target})\n\nAn administrator's folder is owned by root and not writable by group or others. Take the anchor out (scripts/guardrails-anchor.sh --remove), remove the folder that is not root's, and anchor again.`);
    process.exit(3);
  }
  const says = { anchored: 'anchored: the managed settings hold this checkout\'s hook entries', absent: 'not anchored: no managed file', differs: 'NOT anchored: a managed file is there, and it is not what this checkout would write', unreadable: 'not known: the managed file is there and cannot be read' }[state];
  if (flag('--check')) { console.log(`${says} (${target})`); process.exit(state === 'anchored' ? 0 : 3); }
  if (flag('--remove')) {
    console.log(`${says} (${target})\n\nTo take the anchor out, type this yourself:\n\n  ${removeLine({ dir })}\n\nThe hook stays registered in your own settings file (scripts/guardrails-install.sh --remove takes that out).`);
    return;
  }
  // the anchor names this checkout's script: it must be the one the owner's own settings register
  let user = null;
  try { user = JSON.parse(readFileSync(val('--user-settings') || path.join(os.homedir(), '.claude', 'settings.json'), 'utf8')); } catch { /* none: said below */ }
  const other = registeredElsewhere(user, ROOT);
  if (other && !flag('--anyway')) {
    console.log(`${says} (${target})\n\nYour own settings register the gate hook of another checkout:\n  ${other}\nThis script runs from:\n  ${ROOT}\nRun it from that checkout, so the anchor names the script that is installed. (--anyway prints the line all the same.)`);
    process.exit(3);
  }
  const staged = val('--stage') || path.join(ROOT, 'data', 'anchor', ANCHOR_FILE);
  mkdirSync(path.dirname(staged), { recursive: true });
  writeFileSync(staged, want);
  console.log([
    `${says} (${target})`, '',
    'The file (the same hook entries scripts/guardrails-install.sh writes into your own settings):', '',
    want.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'), '',
    `Staged at ${staged}`,
    `sha256   ${sha256(want)}`, '',
    state === 'anchored' ? 'Nothing to do. To write it again, type this yourself, in your own terminal:' : 'To anchor it, read the file above, then type this yourself, in your own terminal (not in an agent\'s pane):', '',
    `  ${installLine({ staged, sha: sha256(want), dir, ...(process.platform === 'darwin' ? {} : { group: 'root', sum: '/usr/bin/sha256sum' }) })}`, '',
    'It asks for your password. Running sessions pick the file up by themselves; /status in a session then lists "Enterprise managed settings (drop-ins)".',
    ...(user && Object.keys(anchorHooksOf(user)).length ? [] : ['Note: your own settings file does not register the gate hook (scripts/guardrails-install.sh --apply). The anchor works without it.']),
    'Before you move or delete this checkout, take the anchor out first: scripts/guardrails-anchor.sh --remove',
    'After a Node change (a new version folder) the entries name a Node program that is gone: every held call is then denied until you anchor again. --check says "NOT anchored" when that has happened.',
  ].join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
