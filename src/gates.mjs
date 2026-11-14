// Guardrails: which agent tool calls are gated (pure — no board, no config, no I/O
// except what the caller injects through ctx). Used by the hook (scripts/gate-hook.mjs)
// and the board (server.mjs, src/gate-ledger.mjs). docs/GUARDRAILS.md has the model.
//
// Invariant (tested): every trigger hit in a command is either attributed to a simple
// command the parser recognised — which is then classified, gated or cleared — or the
// whole call is gated as `opaque`. A hit is never dropped.
import { createHash } from 'node:crypto';
import path from 'node:path';

export const OPAQUE = { id: 'opaque', label: 'A command the gate cannot read with certainty' };
/** The tool names a shell call arrives under (Claude Code's Bash; Codex's shell tools). The one list (#548). */
export const SHELL_TOOL_NAMES = ['Bash', 'shell', 'exec_command', 'local_shell', 'container.exec', 'unified_exec'];
export const isShellTool = (t) => SHELL_TOOL_NAMES.some((n) => n.toLowerCase() === String(t || '').toLowerCase());
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'osascript', 'deno', 'bun', 'php', 'tsx', 'ts-node']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'timeout', 'caffeinate', 'builtin']);
// shells read as shells that are not on SHELLS: csh and tcsh ship with macOS. Reading their text with the sh
// grammar only adds holds.
const FURTHER_SHELLS = new Set(['csh', 'tcsh', 'ash', 'mksh', 'rbash']);
/**
 * The plain name of an interpreter or a shell named with its version or a packager's name (#612): `python3.13`,
 * `python3.13t`, `python3-intel64`, `pythonw`, `pypy3`, `ipython3` → python3; `python2.7` → python; `node22`, `nodejs`
 * → node; `ruby3.3`, `perl5.36`, `php8.3`, `bash5`, `bash-5.2`, `zsh-5.9`, `ksh93` → the name without the number. Any
 * other name comes back as it is (`python3-config`, `node-gyp`, `php-fpm`). Every place that asks whether a program is
 * an interpreter or a shell, or looks one up in a table, reads it through this.
 */
export function progName(bin) {
  if (bin == null) return bin;
  const b = String(bin);
  if (SHELLS.has(b) || INTERPRETERS.has(b) || FURTHER_SHELLS.has(b)) return b;
  if (b === 'nodejs') return 'node';
  // version (with or without a dash), build letters (t, d, m, u) and macOS's -intel64 build
  const py = /^(python|pythonw|pypy|ipython)(?:-?([0-9][0-9.]*)[dmtu]*)?(?:-intel64)?$/.exec(b);
  if (py) return py[2]?.startsWith('2') || (!py[2] && b === 'pypy') ? 'python' : 'python3';
  const m = /^(node|ruby|perl|php|bash|zsh|ksh|fish)-?[0-9][0-9.]*$/.exec(b);
  return m ? m[1] : b;
}
const isShell = (bin) => SHELLS.has(progName(bin)) || FURTHER_SHELLS.has(bin);
const isInterpreter = (bin) => INTERPRETERS.has(progName(bin));
const INDIRECT = new Set(['eval', 'source', '.', 'xargs', 'ssh', 'parallel', 'watch']);
const VALUE_FLAGS = { git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix'], gh: ['-R', '--repo'], sudo: ['-u', '-g'], nice: ['-n'], env: ['-u', '-S', '-C'] };
const SCRIPT_EXT = /\.(py|mjs|cjs|js|ts|sh|bash|zsh|rb|pl|php)$/;
const MAX_DEPTH = 6;
// shell words that only introduce the command after them (`if x; then y`, `while x; do y`, `! x`): the
// program is the next word. Without this a gated command after `then` or `do` was read as arguments.
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'coproc']);
// 1.3 checks: each has a switch in policy.checks (off | observe | enforce; absent = observe). In off and
// observe the verdict is exactly what it was without the check; observe adds `wouldHold` to a clear verdict.
export const CHECKS = ['inlineBodies', 'renamedBins', 'selfProtect'];
export const CHECK_MODES = ['off', 'observe', 'enforce'];
export function checkMode(policy, name) {
  const m = policy?.checks?.[name];
  return CHECK_MODES.includes(m) ? m : 'observe';
}
// code passed on the command line: `node -e`, `python3 -c`, `perl -ne`, `osascript -e`, `deno eval` …
const INLINE = [
  { bin: /^(node[0-9.]*|nodejs|bun|tsx|ts-node)$/, flag: /^(-[a-z]*[ep]|--eval|--print)$/, eq: /^--(eval|print)=/ },
  { bin: /^(python|pypy)[0-9.]*$/, flag: /^-[A-Za-z]*c$/ },
  { bin: /^perl[0-9.]*$/, flag: /^-[A-Za-z0-9]*[eE]$/ },
  { bin: /^ruby[0-9.]*$/, flag: /^-[A-Za-z]*e$/ },
  { bin: /^php[0-9.]*$/, flag: /^-r$/ },
  { bin: /^(osascript|lua[0-9.]*|rscript)$/i, flag: /^-e$/ },
  { bin: /^deno$/, sub: 'eval' },
];
/** The code bodies an interpreter was handed as arguments ([] for anything else). */
export function inlineBodies(bin, tokens) {
  const spec = bin && INLINE.find((x) => x.bin.test(bin) || x.bin.test(progName(bin)));   // `pythonw -c`, `python3.13t -c` (#612)
  if (!spec) return [];
  const out = [];
  if (spec.sub) {
    const k = tokens.indexOf(spec.sub);
    const body = k > 0 ? tokens.slice(k + 1).find((t) => !t.startsWith('-')) : null;
    return body == null ? out : [body];
  }
  for (let k = 1; k < tokens.length; k++) {
    if (spec.eq?.test(tokens[k])) out.push(tokens[k].slice(tokens[k].indexOf('=') + 1));
    else if (spec.flag.test(tokens[k]) && tokens[k + 1] != null) { out.push(tokens[k + 1]); k++; }
  }
  return out;
}
// programs that take their arguments as names or text, never as a subcommand: `cd deploy`, `echo push`
const PLAIN_BINS = new Set(['cd', 'chdir', 'pushd', 'popd', 'echo', 'printf', 'mkdir', 'rmdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'chmod', 'chown', 'open',
  'which', 'type', 'export', 'set', 'unset', 'local', 'declare', 'readonly', 'true', 'false', ':', 'sleep', 'basename', 'dirname', 'realpath',
  'readlink', 'tee', 'date', 'pwd', 'read', 'return', 'exit', 'alias', 'hash', 'trap', 'wait', 'man', 'for', 'case', 'select', 'function', '[[',
  'fi', 'done', 'esac', 'in', 'zip', 'unzip', 'tar', 'gzip', 'gunzip', 'find', 'sed', 'xargs', 'kill', 'pkill', 'killall', 'pgrep', 'ps', 'lsof']);
const USUAL_BIN_DIR = /^(\/opt\/homebrew\/bin|\/usr\/local\/bin|\/usr\/bin|\/bin|\/usr\/sbin|\/sbin)\/[^/]+$/;
// programs that can write a file without naming it (a folder, a pattern, an archive, a download): in the live checkout they go to the board
const LIVE_WRITERS = ['rm', 'mv', 'rmdir', 'cp', 'rsync', 'ditto', 'tar', 'unzip', 'patch', 'exec', 'install', 'ln', 'tee', 'sed', 'dd', 'truncate', 'touch', 'curl', 'wget',
  'gunzip', 'gzip', 'bunzip2', 'bzip2', 'unxz', 'xz', 'zstd', 'unzstd', 'uncompress', 'cpio', 'pax', '7z', '7za', '7zz', '7zr', 'bsdtar', 'gtar', 'unrar', 'unar', 'ex', 'ed', 'vi', 'vim', 'nvim'];
const TEXT_SENDERS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie', 'nc', 'node', 'python', 'python3', 'deno', 'bun', 'ruby', 'perl', 'osascript', 'php']);

// ── fast-path triggers ──────────────────────────────────────────────────────
// One ERE per line in data/guardrails/triggers, matched (grep -iE) against the hook
// JSON after quotes/backslashes are stripped and \n/\t escapes turned into spaces —
// normalizeForTriggers() does the same here, so the shell and Node agree.
const B = '(^|[^[:alnum:]_.-])';
const E = '([^[:alnum:]_-]|$)';
const SP = '[[:space:]]';
const NEXT = '(.*[^[:alnum:]_.-])?';
const ereEsc = (s) => String(s).replace(/[.[\]()*+?{}|^$\\]/g, '\\$&');
export const DEFAULT_KEYWORDS = ['pr merge', 'push', 'deploy', 'bootstrap', 'bootout', 'kickstart', 'gate_decide', 'graphql_mutation'];

export function normalizeForTriggers(text) {
  // …then `/./` and a doubled slash inside a path are dropped (never the `//` after a scheme), so a path reads the same however it is spelled
  return String(text ?? '').replace(/\\[nt]/g, ' ').replace(/["'\\`]/g, '').replace(/\/(\.\/)+/g, '/').replace(/([^:/])\/{2,}/g, '$1/');
}

/** ERE trigger lines for a policy: rule triggers + keyword triggers (condition B). */
export function triggerLines(policy, opts = {}) { return triggerSpecs(policy, opts).map((t) => t.ere); }
/** The lines with what the board needs to know about each: `live` lines are also matched against the call's folder. */
function triggerSpecs(policy, opts = {}) {
  const lines = new Set(); const liveLines = new Set(); const plain = new Set(); const routeLines = new Set();   // route lines send the call to the rules and never decide a hold by themselves
  // lines that come from a rule of a 1.3 check are matched against the command on ONE line, as the shell
  // sees it in the hook JSON (a real line break reads as a space). Older lines keep their reading.
  // A line that only a check's rules add belongs to that check: while the check is not enforced it routes
  // the call to the rules and never decides a hold by itself.
  let fromCheck = false;
  const checkOf = new Map(); const pathInfo = new Map();
  const out = { add: (l) => { lines.add(l); if (!fromCheck) plain.add(l); else if (!checkOf.has(l)) checkOf.set(l, fromCheck); } };
  // a guarded path's line: a single file's is its bare name at a path boundary, a folder's its path. `old` is
  // folder and name side by side, the only text that by itself says the guarded place is meant.
  const pathLine = (g) => {
    const f = pathFragments(g, policy)[0];
    if (!f) return;
    const single = !String(g).replace(/^<repo>\/|^<live>\/|^~\//, '').includes('*');
    const ere = single ? `${B}${ereEsc(f)}${E}` : ereEsc(String(g).startsWith('**/') ? f.replace(/^\//, '') : f);
    out.add(ere);
    pathInfo.set(ere, [...(pathInfo.get(ere) || []), { glob: String(g), old: sideBySide(g) }]);
  };
  const word = (w) => `${B}${String(w).split(/\s+/).map(ereEsc).join(`${SP}+`)}${E}`;
  // a rule about the live checkout only fires when the call also names that checkout (its folder is in the
  // hook JSON as `cwd`, or in the command). Unknown checkout (the shipped fallback file): the bare line.
  const needle = liveNeedle(opts);
  const live = (ere) => { if (!needle) return ere; const l = `${needle}.*(${ere})|(${ere}).*${needle}`; liveLines.add(l); return l; };
  // program … words, with the checkout named before, between or after them (git -C <checkout> reset …)
  const liveBin = (bin, words) => {
    const G = `${B}${ereEsc(bin)}`; const S = `[^[:alnum:]_.-](${words.map(ereEsc).join('|')})${E}`;
    if (!needle) return `${G}.*${S}`;
    const l = `${needle}.*${G}.*${S}|${G}.*${needle}.*${S}|${G}.*${S}.*${needle}`; liveLines.add(l); return l;
  };
  const liveFragments = new Set(); let liveCheck = false;
  for (const c of policy?.classes || []) {
    for (const r of c.rules || []) {
      if (r.check && checkMode(policy, r.check) === 'off') continue;      // a check that is off adds no line
      fromCheck = r.check || false;
      if (r.bin) {
        // E consumes the separator after a word, so later words start with an optional "…<sep>"
        let re = `${B}${ereEsc(r.bin)}${E}`;
        for (const a of r.args || []) re += `${NEXT}${ereEsc(a)}${E}`;
        if (r.argsAny?.length) re += `${NEXT}(${r.argsAny.map(ereEsc).join('|')})${E}`;
        if (r.flagsAny?.length) re += `(.*[[:space:]])?${flagsEre(r.flagsAny, true)}`;
        if (r.urlAny?.length) re += `.*(${r.urlAny.map(ereEsc).join('|')})`;
        if (r.mentions?.length) re += `.*(${r.mentions.map(ereEsc).join('|')})`;
        out.add(r.when === 'liveCheckout' && r.argsAny?.length && !r.args ? liveBin(r.bin, r.argsAny) : re);
      } else if (r.flagsAny?.length) out.add(flagsEre(r.flagsAny));
      // a script rule that needs a flag: the flag line above already sends the call to the board, and
      // naming the script too would send EVERY run of it there
      if (r.scriptIn && !(r.flagsAny?.length && !r.bin && !r.args)) {
        // a listed script's name (plus its first argument when the rule names one). The argument is the
        // script's SUBCOMMAND, so it must follow the name directly: "task.sh gate", never "task.sh comment
        // N '…merge gate…'" or a later command's text on the same line (#429: 3 opaque gates on #427).
        for (const g of listOr(r.scriptIn, policy)) {
          const base = path.basename(String(g));
          if (!base || base.includes('*')) continue;
          out.add(`${ereEsc(base)}${r.args?.[0] ? `${SP}+${ereEsc(r.args[0])}${E}` : E}`);
          // …and the script handed over on the input, where the subcommand does not follow the name
          // (`sh -s -- gate 5 g1 approve < task.sh`, `cat task.sh | sh -s -- gate …`) (#532)
          if (r.args?.[0]) for (const l of [`<${SP}*[^[:space:]]*${ereEsc(base)}${E}`, `cat${SP}[^|;&]*${ereEsc(base)}[^|;&]*[|]`, `cat${SP}+[^[:space:]]*${ereEsc(base)}${SP}*[)]`]) { out.add(l); routeLines.add(l); }
        }
      }
      if (r.tool) out.add(`tool_name:${SP}*${toolEre(r.tool)}`);
      // a guarded path: also matched against the folder the call is made from (a call from inside the folder names nothing)
      for (const p of [...(r.pathAny || []), ...(r.pathWrite ? [r.pathWrite] : [])]) for (const g of listOr(p, policy)) pathLine(g);
      for (const p of [].concat(r.pathGuard || [])) for (const g of listOr(p, policy)) {
        if (String(g).startsWith('<live>/') && needle) {
          // with the checkout named, the file's own name is enough: `cp /tmp/gates.mjs src/` names no full path
          const name = path.basename(String(g).replace(/\/\*\*$/, ''));
          if (name.length >= 4 && !name.includes('*')) { liveFragments.add(ereEsc(name)); liveCheck = r.check || liveCheck; }
          continue;
        }
        pathLine(g);
      }
      // taking away a folder above a guarded file names none of them
      // …and neither does a recursive copy, a sync, an extract or a patch into one
      if (r.pathGuard && needle) {
        out.add(live(`${B}(${LIVE_WRITERS.join('|')})${E}`));
        // a redirect whose target is spelled with a variable, a glob or braces names no file either
        out.add(live('>[^|;&]*[$*?{[]'));
      }
      for (const t of r.textAny || []) out.add(ereEsc(t));
      if (r.sql) out.add(`(drop|truncate)${SP}+(table|schema|database)|delete${SP}+from`);
    }
  }
  fromCheck = liveCheck || 'selfProtect';
  if (liveFragments.size) out.add(live([...liveFragments].join('|')));
  fromCheck = false;
  for (const k of [...DEFAULT_KEYWORDS, ...(policy?.keywords || [])]) out.add(word(k));
  fromCheck = 'renamedBins';
  // renamed programs (1.3): a gated rule's leading words with no program name in front. One-word prefixes
  // are keywords already; these are the rest (secret set, repo delete …).
  if (checkMode(policy, 'renamedBins') !== 'off') {
    for (const p of gatedPrefixes(policy)) if (p.words.length > 1) out.add(word(p.words.join(' ')));
  }
  fromCheck = false;
  return [...lines].map((ere) => ({ ere, live: liveLines.has(ere), flat: liveLines.has(ere) || !plain.has(ere),
    ...(!plain.has(ere) && checkOf.has(ere) ? { check: checkOf.get(ere) } : {}), ...(pathInfo.has(ere) ? { path: pathInfo.get(ere) } : {}),
    ...(routeLines.has(ere) ? { route: true } : {}) }));
}
// long flags exactly (--commit, --commit=x); one-letter flags also inside clusters (-rf).
// A flag may end the command, so in the hook's JSON it is followed by `",` → after quote-stripping a
// comma: the flag ends at ANY non-word character (E), never only at a space (#343 pilot failure b).
function flagsEre(flags, afterSep = false) {
  const long = flags.filter((f) => !/^-[A-Za-z]$/.test(f)).map(ereEsc);
  const short = flags.filter((f) => /^-[A-Za-z]$/.test(f)).map((f) => f[1]);
  const parts = [];
  if (long.length) parts.push(`(${long.join('|')})${E}`);
  if (short.length) parts.push(`-[[:alnum:]]*[${short.join('')}][[:alnum:]]*${E}`);
  return afterSep ? `(${parts.join('|')})` : `(^|[^[:alnum:]_-])(${parts.join('|')})`;
}
/**
 * The leading words of every program rule that names a gated action: two or more words (pr merge,
 * secret set), or one word that is also a keyword (push, deploy). A lone ordinary word (load, enable,
 * upgrade) is left out: it is the first argument of too many unrelated programs.
 */
export function gatedPrefixes(policy) {
  const kw = new Set([...DEFAULT_KEYWORDS, ...(policy?.keywords || [])].map((k) => String(k).toLowerCase()));
  const seen = new Set(); const out = [];
  for (const c of policy?.classes || []) for (const r of c.rules || []) {
    if (!r.bin || r.check) continue;                 // a 1.3 check's own rules are not "gated actions" to mimic
    const base = r.args || [];
    for (const words of r.argsAny?.length ? r.argsAny.map((a) => [...base, a]) : [base]) {
      if (!words.length || !(words.length > 1 || kw.has(words[0].toLowerCase()))) continue;
      const key = `${r.bin} ${words.join(' ')}`;
      if (!seen.has(key)) { seen.add(key); out.push({ bin: r.bin, words, cls: c.id }); }
    }
  }
  return out;
}
/** How the live checkout shows up in a call's text: its path below the home folder, else the whole path. */
function liveNeedle({ boardRoot, home } = {}) {
  if (!boardRoot) return null;
  const root = String(boardRoot).replace(/\/+$/, '');
  const h = String(home || '').replace(/\/+$/, '');
  const rel = h && root.startsWith(h + '/') ? root.slice(h.length + 1) : root;
  return rel.length >= 3 ? ereEsc(normalizeForTriggers(rel)) : null;
}
const toolEre = (re) => String(re).replace(/^\^/, '').replace(/\$$/, E);
/** Folder and name side by side: the longest literal run of a guarded path (what the line was before a single file's became its bare name). */
const sideBySide = (g) => String(g).replace(/^<repo>\/|^<live>\/|^~\//, '').split('*').sort((a, b) => b.length - a.length)[0];
/** Literal fragments of a path glob (longest literal run), with list refs expanded. */
function pathFragments(p, policy) {
  const items = String(p).startsWith('@') ? policy?.lists?.[String(p).slice(1)] || [] : [p];
  return items.map((g) => {
    const rest = String(g).replace(/^<repo>\/|^<live>\/|^~\//, '');
    // one file: its bare name. The folder and the name need not stand side by side in a call that reaches
    // it (`cd data && cat NAME`, `data/./NAME`, `data//NAME`, a call made from inside the folder).
    if (!rest.includes('*')) { const name = path.basename(rest); if (name.length >= 6) return name; }
    // a folder: its path without the closing slash, so `cd <folder> && …` is seen too
    return rest.split('*').sort((a, b) => b.length - a.length)[0].replace(/\/+$/, '');
  }).filter((f) => f.length >= 6);
}
/** ERE → JS RegExp (only the constructs triggerLines emits). */
export function ereToJs(ere) {
  const src = ere.replace(/\[\[:space:\]\]/g, '\\s').replace(/\[\^\[:alnum:\]_\.-\]/g, '[^A-Za-z0-9_.-]')
    .replace(/\[\^\[:alnum:\]_-\]/g, '[^A-Za-z0-9_-]').replace(/\[\[:space:\]=\]/g, '[\\s=]')
    .replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]').replace(/\[\^\[:space:\]\]/g, '\\S');
  return new RegExp(src, 'i');
}
export function compileTriggers(policy, opts) { return triggerSpecs(policy, opts).map((t) => ({ ...t, re: ereToJs(t.ere) })); }
/** The text the fast path greps, rebuilt from a parsed hook input. */
export function triggerText({ tool, command, filePath }) {
  return normalizeForTriggers(`tool_name:${tool || ''} ${command || ''} ${filePath || ''}`);
}

// ── shell lexer/parser ──────────────────────────────────────────────────────
// Splits a command line into simple commands. $(…), backticks, <(…), bash -c strings
// and heredocs fed to a shell are parsed recursively (they execute). Heredocs fed to
// anything else are data; fed to an interpreter they are opaque when they hold a keyword.
export function parseCommand(src, depth = 0, opts = {}) {
  // opts.nocaseBin: the disk ignores letter case, so `GH` runs gh: program names are read in lower case
  if (depth > MAX_DEPTH) return { cmds: [], data: [], opaque: ['nesting too deep'] };
  const cmds = []; const data = []; const opaque = [];
  let cur = newCmd(''); let tok = null; let i = 0; const s = String(src ?? '');
  const pendingDocs = [];
  const endTok = () => { if (tok != null) { cur.raw.push(tok); tok = null; } };
  // a word that follows `>` or `<<<` is that operator's target however it is written: bare, quoted or
  // a substitution. (Only a bare word was taken before: `bash <<< "…"` was read as an argument of bash,
  // and a quoted redirect target as an argument of the command.)
  const boundary = () => i >= s.length || /[\s;&|<>()]/.test(s[i]);
  const startTok = () => { if (!opts.legacyQuoted && tok == null && cur.redirNext) { cur.redirNext = false; cur.redirTarget = true; } };
  const settle = () => {
    if (opts.legacyQuoted || tok == null || !boundary()) return;
    if (cur.redirTarget) { cur.redirects.push(tok); if (cur.redirIn) cur.reads.push(tok); tok = null; cur.redirTarget = false; }
    else if (cur.herestringNext) { cur.herestrings.push(tok); tok = null; cur.herestringNext = false; }
  };
  // subshell parentheses are counted on the next real command (an empty command between `)` and `&&`
  // must not lose them), so a `cd` inside `( … )` stays scoped to it
  const endCmd = (sep) => {
    endTok();
    if (cur.raw.length || cur.redirects.length) { cur.sepBefore = cur.sepBefore ?? ''; cmds.push(cur); cur = newCmd(sep); return; }
    const next = newCmd(sep);
    next.opens += cur.opens; next.closes += cur.closes;
    if (!['(', ')'].includes(sep)) next.sepBefore = sep;
    cur = next;
  };
  const subCmds = [];                                 // already parsed (second-pass shape)
  const sub = (inner) => { const p = parseCommand(inner, depth + 1, opts); subCmds.push(...p.cmds.map((c) => ({ ...c, fromSub: true }))); data.push(...p.data); opaque.push(...p.opaque); };
  const balanced = (open, close, from) => {          // index just after the matching close
    let d = 1; let j = from;
    while (j < s.length && d > 0) {
      const ch = s[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === "'") { const k = s.indexOf("'", j + 1); j = k < 0 ? s.length : k + 1; continue; }
      if (ch === '"') { j = skipDq(s, j + 1); continue; }
      if (ch === open) d++; else if (ch === close) d--;
      j++;
    }
    return d === 0 ? j : -1;
  };
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\n') {
      endCmd(';'); i++;
      while (pendingDocs.length) {
        const doc = pendingDocs.shift();
        const lines = []; let found = false;
        while (i < s.length) {
          const nl = s.indexOf('\n', i); const line = s.slice(i, nl < 0 ? s.length : nl); i = nl < 0 ? s.length : nl + 1;
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.word) { found = true; break; }
          lines.push(line);
        }
        if (!found) opaque.push(`unterminated heredoc ${doc.word}`);
        doc.cmd.heredocs.push(lines.join('\n'));
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { endTok(); i++; continue; }
    if (ch === '#' && tok == null) { const nl = s.indexOf('\n', i); data.push(s.slice(i + 1, nl < 0 ? s.length : nl)); i = nl < 0 ? s.length : nl; continue; }
    if (ch === '\\') { if (s[i + 1] === '\n') { i += 2; continue; } startTok(); tok = (tok ?? '') + (s[i + 1] ?? ''); i += 2; settle(); continue; }
    if (ch === "'") { startTok(); const k = s.indexOf("'", i + 1); if (k < 0) { opaque.push('unterminated quote'); tok = (tok ?? '') + s.slice(i + 1); i = s.length; continue; } tok = (tok ?? '') + s.slice(i + 1, k); i = k + 1; settle(); continue; }
    if (ch === '"') {
      startTok();
      let j = i + 1; let buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { const e = balanced('(', ')', j + 2); if (e < 0) { opaque.push('unbalanced $('); j = s.length; break; } sub(s.slice(j + 2, e - 1)); buf += s.slice(j, e); j = e; continue; }
        if (s[j] === '`') { const e = s.indexOf('`', j + 1); if (e < 0) { opaque.push('unbalanced `'); j = s.length; break; } sub(s.slice(j + 1, e)); buf += s.slice(j, e + 1); j = e + 1; continue; }
        buf += s[j]; j++;
      }
      if (j >= s.length) opaque.push('unterminated quote');
      tok = (tok ?? '') + buf; i = j + 1; settle(); continue;
    }
    if ((ch === '$' || ch === '<' || ch === '>') && s[i + 1] === '(') {
      if (ch !== '$' && tok != null) { /* a>(…) is unusual; treat like a substitution */ }
      const e = balanced('(', ')', i + 2); if (e < 0) { opaque.push('unbalanced ('); i = s.length; continue; }
      if (ch === '$') startTok();
      sub(s.slice(i + 2, e - 1)); tok = (tok ?? '') + s.slice(i, e); i = e; if (ch === '$') settle(); continue;
    }
    if (ch === '$' && s[i + 1] === '{') { const e = balanced('{', '}', i + 2); if (e < 0) { opaque.push('unbalanced ${'); i = s.length; continue; } startTok(); tok = (tok ?? '') + s.slice(i, e); i = e; settle(); continue; }
    if (ch === '`') { const e = s.indexOf('`', i + 1); if (e < 0) { opaque.push('unbalanced `'); i = s.length; continue; } startTok(); sub(s.slice(i + 1, e)); tok = (tok ?? '') + s.slice(i, e + 1); i = e + 1; settle(); continue; }
    if (ch === ';' || ch === '&' || ch === '|') {
      const two = s.slice(i, i + 2);
      if (ch === '&' && s[i + 1] === '>') { endTok(); i += s[i + 2] === '>' ? 3 : 2; cur.redirNext = true; cur.redirIn = false; continue; }
      const sep = ['&&', '||', '|&', ';;'].includes(two) ? two : ch;
      endCmd(sep); i += sep.length; continue;
    }
    if (ch === '(' || ch === ')') { endCmd(ch); i++; continue; }
    if ((ch === '{' || ch === '}') && tok == null && /[\s;]|$/.test(s[i + 1] ?? '')) { endCmd(ch); i++; continue; }
    if (ch === '<' || ch === '>') {
      if (s.startsWith('<<<', i)) { endTok(); i += 3; cur.herestringNext = true; continue; }
      if (s.startsWith('<<', i)) {
        endTok(); i += 2; const strip = s[i] === '-'; if (strip) i++;
        while (s[i] === ' ' || s[i] === '\t') i++;
        const m = /^(['"]?)([A-Za-z0-9_.-]+)\1/.exec(s.slice(i));
        if (!m) { opaque.push('heredoc without a word'); continue; }
        pendingDocs.push({ word: m[2], strip, cmd: cur }); i += m[0].length; continue;
      }
      // fd numbers glued to the operator (2>, 1>>) belong to it, not to the command
      if (tok != null && /^\d+$/.test(tok)) tok = null; else endTok();
      i += s[i + 1] === '>' || s[i + 1] === '&' || (ch === '>' && s[i + 1] === '|') ? 2 : 1;   // >> >& >| (and <& <>)
      if (s[i - 1] === '&') { while (/\d|-/.test(s[i] ?? '')) i++; continue; }   // 2>&1
      cur.redirNext = true; cur.redirIn = ch === '<' && s[i - 1] !== '>'; continue;
    }
    if (tok == null && cur.redirNext) { cur.redirNext = false; cur.redirTarget = true; }
    tok = (tok ?? '') + ch; i++;
    if (cur.redirTarget && (i >= s.length || /[\s;&|<>()]/.test(s[i]))) { cur.redirects.push(tok); if (cur.redirIn) cur.reads.push(tok); tok = null; cur.redirTarget = false; }
    else if (cur.herestringNext && (i >= s.length || /[\s;&|<>()]/.test(s[i]))) { cur.herestrings.push(tok); tok = null; cur.herestringNext = false; }
  }
  endCmd('');
  if (pendingDocs.length) opaque.push(`unterminated heredoc ${pendingDocs[0].word}`);
  // second pass: words, heredoc bodies, shells with -c, indirect commands
  const out = [...subCmds];
  const vars = {};                                   // NAME=literal assigned in this command (no expansion inside)
  // the folder each simple command runs in: literal `cd` targets so far (subshells scoped); unknown after
  // a cd the gate can't resolve — path- and repo-dependent rules then decide conservatively
  // `sure`: the folder change certainly applied before this command runs: every link from the cd to here is `&&`
  // (a failed cd then stops the command), and the cd itself was not the right side of `||`, part of a pipeline or
  // negated. A `;`, `||`, `|`, `&`, a condition, or a `popd` after it leaves the change unsure (#548, MC's review).
  let cd = { targets: [], unknown: false, sure: true };
  const cdStack = [];
  // #584: the branch changes before each command (`git switch`, `git checkout <branch>`, `git branch -u` …), also
  // those read inside a command string or a script body the call hands to a shell. They only ever add to what a push
  // through the current branch is judged by. A body handed to a shell starts with the switches that stand before that
  // shell command (`git switch main && bash -c "git push origin"`): `opts.switchesIn`.
  let sw = [...(opts.switchesIn || [])];
  const innerSwitches = (inner) => { for (const ic of inner) { const t = branchSwitch(ic); if (t) sw = [...sw, t]; } };
  const bodyOpts = () => ({ ...opts, switchesIn: sw });
  for (const c of cmds) {
    for (let k = 0; k < (c.closes || 0); k++) if (cdStack.length) cd = cdStack.pop();
    if (c.sepBefore !== '&&' && cd.targets.length) cd = { ...cd, sure: false };
    for (let k = 0; k < (c.opens || 0); k++) cdStack.push({ targets: [...cd.targets], unknown: cd.unknown, sure: cd.sure });
    for (const t of c.raw) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t);
      if (!m) break;
      if (!/[$`]/.test(m[2])) vars[m[1]] = m[2]; else delete vars[m[1]];
    }
    const w = words(c.raw, opts);
    const cmd = { tokens: w.tokens, bin: w.bin, assignOnly: !w.bin, redirects: c.redirects, reads: c.reads, hereFiles: (c.herestrings || []).map(hereFile).filter(Boolean), sepBefore: c.sepBefore, fromSub: !!c.fromSub, dynamicBin: w.dynamic, text: c.raw.join(' '),
      cdTargets: [...cd.targets], cdUnknown: cd.unknown, ...(cd.targets.length && !cd.sure ? { cdUnsure: true } : {}) };
    const inline = inlineBodies(cmd.bin, cmd.tokens);
    if (inline.length) cmd.inlineBodies = inline;
    if (sw.length && cmd.bin === 'git') cmd.switchesBefore = sw;
    const turn = branchSwitch(cmd);
    if (turn) sw = [...sw, turn];
    out.push(cmd);
    if (cmd.bin === 'cd' || cmd.bin === 'pushd' || cmd.bin === 'chdir') {     // chdir: zsh's other name for cd (#551)
      const args = cmd.tokens.slice(1); let k = 0;
      while (k < args.length && /^-[LPe@n]+$/.test(args[k])) k++;
      if (args[k] === '--') k++;                     // `cd -- /x`: the folder is the word after it (#551)
      const pos = args.slice(k);
      let t = pos[0] ?? (cmd.bin === 'pushd' ? null : '~');
      const v = t != null && /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(t);
      if (v && vars[v[1]] != null) t = vars[v[1]];
      const sure = !['||', '|', '|&'].includes(c.sepBefore) && c.raw[0] !== '!';
      // an absolute target stands alone; a relative one also needs every change before it
      const fixedT = t != null && /^(\/|~(\/|$))/.test(t);
      if (cmd.bin === 'pushd' && args.slice(0, k).some((f) => f.includes('n'))) { /* pushd -n: onto the stack only, the folder stays */ }
      // unknown: `cd -`, an expansion, a stack rotation or swap (pushd +N, bare pushd), and extra words
      // (bash refuses `cd a b`, zsh reads it as a substitution: either way not the folder named)
      else if (t == null || t === '-' || /^[+-]\d+$/.test(t) || /[$`*?]/.test(t) || pos.length > 1) cd = { targets: cd.targets, unknown: true, sure: false };
      else cd = { targets: [...cd.targets, t], unknown: cd.unknown, sure: sure && (fixedT || cd.sure) };
    } else if (cmd.bin === 'popd') cd = { ...cd, sure: false };     // back to a folder the parser does not track
    for (const body of c.heredocs) {
      if (isShell(cmd.bin)) { const p = parseCommand(body, depth + 1, bodyOpts()); out.push(...p.cmds); data.push(...p.data); opaque.push(...p.opaque); innerSwitches(p.cmds); }
      else if (isInterpreter(cmd.bin)) out.push({ tokens: [], bin: null, interpretedBody: body, by: cmd.bin, text: body });
      else data.push(body);
    }
    for (const h of c.herestrings) {
      if (isShell(cmd.bin)) { const p = parseCommand(h, depth + 1, bodyOpts()); out.push(...p.cmds); data.push(...p.data); opaque.push(...p.opaque); innerSwitches(p.cmds); }
      else if (isInterpreter(cmd.bin)) out.push({ tokens: [], bin: null, interpretedBody: h, by: cmd.bin, text: h });
      else data.push(h);
    }
    if (isShell(cmd.bin)) {
      const ci = cmd.tokens.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
      if (ci > 0 && cmd.tokens[ci + 1] != null) { const p = parseCommand(cmd.tokens[ci + 1], depth + 1, bodyOpts()); out.push(...p.cmds); data.push(...p.data); opaque.push(...p.opaque); cmd.inlinedC = true; innerSwitches(p.cmds); }
      else if (cmd.tokens.length === 1 || (cmd.tokens[1] || '').startsWith('-')) cmd.readsStdin = c.sepBefore === '|' || c.sepBefore === '|&';
    }
  }
  // a substitution (`$(…)`, backticks) is parsed on its own, out of order with the list above: adds only,
  // a switch inside one counts for every git and gh command of the call, and a command inside one gets every switch
  const subSw = subCmds.map(branchSwitch).filter(Boolean);
  const all = [...sw, ...subSw];
  if (all.length) for (const c of out) {
    if (c.bin !== 'git' && c.bin !== 'gh') continue;
    const add = c.fromSub ? all : subSw;
    if (add.length) c.switchesBefore = [...(c.switchesBefore || []), ...add];
  }
  return { cmds: out, data, opaque, vars };
}
// a here-string that is one file's content (`<<< "$(cat x.sh)"`, `<<< "$(< x.sh)"`): the file
const hereFile = (h) => (String(h).trim().replace(/^["']|["']$/g, '').match(/^\$\(\s*(?:cat\s+|<\s*)([^\s|;&$`()<>]+)\s*\)$/) || [])[1] || null;
function newCmd(sep) { return { raw: [], redirects: [], reads: [], heredocs: [], herestrings: [], sepBefore: sep, opens: sep === '(' ? 1 : 0, closes: sep === ')' ? 1 : 0 }; }
function skipDq(s, j) { while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; return j + 1; }

/** Index of the first wrapped word when t[k…] is `[sh|bash|zsh] task.sh test N … -- <cmd>` or `[node] mesh-cli.mjs task test …`; else -1. */
function testWrapperEnd(t, k, opts = {}) {
  const base = (i) => { const b = path.basename(t[i] || ''); return opts.nocaseBin ? b.toLowerCase() : b; };
  let j = k;
  if (['sh', 'bash', 'zsh', 'node'].includes(progName(base(j)))) j++;
  if (base(j) === 'task.sh') j += 1;
  else if (base(j) === 'mesh-cli.mjs' && t[j + 1] === 'task') j += 2;
  else return -1;
  if (t[j] !== 'test') return -1;
  const d = t.indexOf('--', j);
  return d > 0 && d + 1 < t.length ? d + 1 : -1;
}

/** Strip assignments and wrappers; tokens[0] is then the program. */
function words(raw, opts = {}) {
  const t = [...raw]; let k = 0;
  for (;;) {
    while (k < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[k])) k++;
    if (!opts.legacyShellKeywords && SHELL_KEYWORDS.has(t[k]) && k + 1 < t.length) { k++; continue; }
    // the ledger CLI's test stamp (task.sh test N -- <command…>, #400) runs the words after `--`:
    // read those, never the wrapper, so it can't carry a gated action past the classifier
    const after = testWrapperEnd(t, k, opts);
    if (after > 0) { k = after; continue; }
    // (where the disk ignores case, ENV and SUDO are env and sudo)
    const b = opts.nocaseBin ? path.basename(t[k] || '').toLowerCase() : path.basename(t[k] || '');
    if (!WRAPPERS.has(b)) break;
    k++;
    const vf = VALUE_FLAGS[b] || [];
    while (k < t.length && t[k].startsWith('-')) { k += vf.includes(t[k]) ? 2 : 1; }
    if (b === 'timeout' && /^\d/.test(t[k] || '')) k++;
    if (b === 'env') while (k < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[k])) k++;
  }
  const tokens = t.slice(k);
  const first = tokens[0];
  const dynamic = first != null && /[$`]/.test(first);
  const base = first == null || dynamic ? null : path.basename(first);
  return { tokens, bin: base && opts.nocaseBin ? base.toLowerCase() : base, dynamic };
}

/** Positional words after the program, skipping global option values (git -C x). */
export function positionals(cmd) {
  const vf = VALUE_FLAGS[cmd.bin] || [];
  const out = [];
  for (let k = 1; k < cmd.tokens.length; k++) {
    const t = cmd.tokens[k];
    if (vf.includes(t)) { k++; continue; }
    if (vf.some((f) => t.startsWith(f + '='))) continue;
    if (t.startsWith('-')) continue;
    out.push(t);
  }
  return out;
}
const flagSet = (cmd) => new Set(cmd.tokens.slice(1).filter((t) => t.startsWith('-')).map((t) => t.split('=')[0]));
/** A rule flag is present: long flags exactly, one-letter flags also inside a cluster (-rfv). */
function hasFlag(cmd, f) {
  if (/^-[A-Za-z]$/.test(f)) return cmd.tokens.slice(1).some((t) => /^-[A-Za-z]+$/.test(t) && t.includes(f[1]));
  return flagSet(cmd).has(f);
}

// ── classification ──────────────────────────────────────────────────────────
/**
 * classify({ tool, command, filePath, cwd }, policy, ctx) →
 *   { verdict: 'clear' } | { verdict: 'gate', cls, rule, why, requireDryRun, ttlMinutes, cmd? }
 * ctx (all optional, injected): { home, repoRoot(cwd), git(cwd, args) → string|null, boardRoot }
 */
export function classify(input, policy, ctx = {}) {
  // ctx.checks (the replay tool) overrides the policy's switches
  const mode = (n) => (CHECK_MODES.includes(ctx.checks?.[n]) ? ctx.checks[n] : checkMode(policy, n));
  const enforced = CHECKS.filter((n) => mode(n) === 'enforce');
  const observed = CHECKS.filter((n) => mode(n) === 'observe');
  const r = classifyWith(input, policy, ctx, new Set(enforced));
  if (r.verdict !== 'clear' || !observed.length) return r;
  // observe: the verdict above stands; say which check would have held the call
  const all = classifyWith(input, policy, ctx, new Set([...enforced, ...observed]));
  if (all.verdict === 'gate' && all.check) r.wouldHold = { check: all.check, cls: all.cls, label: all.label, why: all.why };
  return r;
}

function classifyWith(input, policy, ctx, on) {
  const tool = input.tool || 'Bash';
  // a Codex shell call: the folder it runs in was not told to the hook (#548); commandCwd reads only what the command names
  if (input.folderUnread && !ctx.baseUnread) ctx = { ...ctx, baseUnread: true };
  // the whole call, for what an earlier command of it sets (`export GIT_DIR=…; git push`)
  if (ctx.line == null) ctx = { ...ctx, line: String(Array.isArray(input.command) ? input.command.join(' ') : input.command ?? '') };
  const triggers = ctx.triggers || compileTriggers(policy, { boardRoot: ctx.boardRoot, home: ctx.home });
  // the shell greps the whole hook JSON, folder included; here the folder counts only for the lines about
  // the live checkout, so a folder that happens to be called "deploy" never reads as a gated word
  const text = triggerText(input); const flat = text.replace(/[\n\r\t]+/g, ' ');
  const cwdText = normalizeForTriggers(input.cwd || '');
  const withCwd = `${flat} ${cwdText}`;
  const hits = triggers.filter((t) => t.re.test(t.live ? withCwd : t.path ? `${t.flat ? flat : text} ${cwdText}` : t.flat ? flat : text));
  if (!hits.length) return { verdict: 'clear', why: 'no trigger' };
  const classes = policy?.classes || [];
  const gate = (cls, rule, why, extra = {}) => ({
    verdict: 'gate', cls: cls.id, label: cls.label, rule, why,
    requireDryRun: !!(rule?.requireDryRun ?? cls.requireDryRun ?? policy?.defaults?.requireDryRun),
    ttlMinutes: Number(rule?.ttlMinutes ?? cls.ttlMinutes ?? policy?.defaults?.ttlMinutes ?? 120),
    approver: cls.approver || policy?.defaults?.approver || 'owner', ...(rule?.check ? { check: rule.check } : {}), ...extra,
  });
  const active = (r) => !r.check || on.has(r.check);   // a rule that belongs to a check runs only when that check is on
  const opaque = (why, extra) => gate(OPAQUE, null, why, extra);

  // non-shell tools: MCP names and file paths
  if (tool !== 'Bash') {
    for (const cls of classes) for (const r of cls.rules || []) {
      if (!active(r)) continue;
      if (r.pathGuard && input.filePath && WRITE_TOOLS.test(tool) && guardGlobs(r, policy).some((g) => rootedMatch(g, absPath(input.filePath, input.cwd, ctx), ctx, nocaseOf(ctx)))) return gate(cls, r, `${tool} ${input.filePath}`);
      if (r.tool && new RegExp(r.tool).test(tool)) return gate(cls, r, `tool ${tool}`);
      if (input.filePath && (r.pathAny || (r.pathWrite && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)))) {
        const globs = [...(r.pathAny || []).flatMap((p) => listOr(p, policy)), ...(r.pathWrite ? listOr(r.pathWrite, policy) : [])];
        if (globs.some((g) => rootedMatch(g, absPath(input.filePath, input.cwd, ctx), ctx))) return gate(cls, r, `${tool} ${input.filePath}`);
      }
    }
    return { verdict: 'clear', why: 'tool not gated' };
  }

  let parsed;
  try { parsed = parseCommand(input.command, 0, { legacyShellKeywords: !!ctx.legacyParser, legacyQuoted: !!ctx.legacyParser, nocaseBin: nocaseOf(ctx).nocase && !ctx.legacyParser }); } catch (e) { return opaque(`unparseable: ${e.message}`); }
  const norm = normalizeForTriggers(input.command);
  const keyword = keywordHit(norm, policy);
  if (parsed.opaque.length && keyword) return opaque(parsed.opaque[0]);

  const runnable = parsed.cmds.filter((c) => !c.assignOnly || c.interpretedBody);
  // Which hit may decide a hold by itself (a body the rules cannot read, text no command explains)?
  //  - a line of a check that is not on: never. It routed the call here; the check's reading is made in its own pass.
  //  - a guarded path's line: only when the text has folder and name side by side, or the call runs in the
  //    guarded place (its folder, or a `cd` in the call). A bare `settings.json` in another repo is somebody else's file.
  const folders = [...new Set([input.cwd, ...parsed.cmds.map((c) => commandCwd(c, input.cwd, ctx).cwd)].filter(Boolean))];
  const inPlace = (pi) => {
    const single = !pi.glob.replace(/^<repo>\/|^<live>\/|^~\//, '').includes('*');
    const place = single ? (pi.glob.includes('/') ? pi.glob.slice(0, pi.glob.lastIndexOf('/')) : null) : pi.glob;
    return !!place && folders.some((f) => rootedMatch(place, f, ctx));
  };
  const decides = (h, body) => {
    if (h.check && !on.has(h.check)) return false;
    if (h.route) return false;                       // it only routed the call here; the rules above read the command
    if (!h.re.test(body)) return false;
    if (!h.path) return true;
    return h.path.some((pi) => (pi.old.length >= 6 && body.toLowerCase().includes(normalizeForTriggers(pi.old).toLowerCase())) || inPlace(pi));
  };
  const decider = (body) => hits.filter((h) => decides(h, body)).sort((a, b) => (a.check ? 1 : 0) - (b.check ? 1 : 0))[0];
  const viaCheck = (h) => (h?.check ? { check: h.check } : {});
  // an interpreter's program run from inside a guarded folder: the rules cannot read what it opens there
  const guardedFolders = classes.flatMap((cls) => (cls.rules || []).filter((r) => active(r)).flatMap((r) => [...(r.pathAny || []), ...(r.pathWrite ? [r.pathWrite] : []), ...[].concat(r.pathGuard || [])]
    .flatMap((x) => listOr(x, policy)).filter((g) => String(g).endsWith('/**')).map((g) => ({ g, check: r.check }))));
  const insideGuarded = (c) => { const f = commandCwd(c, input.cwd, ctx).cwd; return guardedFolders.find((x) => rootedMatch(x.g, f, ctx)); };
  for (const c of runnable) {
    if (c.interpretedBody != null) {
      const body = normalizeForTriggers(c.interpretedBody);
      if (keywordHit(body, policy)) return opaque(`${c.by} program from a heredoc mentions a gated action`);
      const d = decider(body);
      if (d) return opaque(`${c.by} program from a heredoc mentions a gated action`, viaCheck(d));
      const g = insideGuarded(c);
      if (g) return opaque(`${c.by} program from a heredoc runs inside a guarded folder`, g.check ? { check: g.check } : {});
      continue;
    }
    if (c.dynamicBin && keyword) return opaque(`variable or expansion in command position: ${c.tokens[0]}`);
    if (INDIRECT.has(c.bin) && keyword) return opaque(`${c.bin} runs a command the gate cannot read`);
    if (c.bin === 'find' && keyword && c.tokens.some((t) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t))) return opaque('find -exec runs a command the gate cannot read');
    if (c.readsStdin && keyword) return opaque(`${c.bin} reads commands from a pipe`);
  }
  const rctx = { ...ctx, vars: parsed.vars || {} };
  // a redirect with no program in front of it (`exec > file`, `> file`) still writes the file
  for (const c of parsed.cmds) {
    if (c.bin || c.interpretedBody != null || !(c.redirects || []).length) continue;
    const where = commandCwd(c, input.cwd, ctx);
    for (const cls of classes) for (const r of cls.rules || []) {
      if (!r.pathGuard || !active(r)) continue;
      const hit = guardedWrite(r, { ...c, bin: 'a redirect', tokens: ['>'] }, { ...input, cwd: where.cwd, cwdUnknown: where.unknown, cwdUnread: !!where.unread }, policy, rctx);
      if (hit) return gate(cls, r, `a redirect writes ${hit}`, { cmd: c });
    }
  }
  // a script handed to an interpreter or a shell on its input (`bash < install.sh`, `cat x.mjs | node - --commit`)
  // is a run of that script: the script rules read it as `bash install.sh` / `node x.mjs --commit` (#532)
  const fromInput = parsed.cmds.flatMap((c, k) => stdinScriptRuns(c, parsed.cmds[k - 1]));
  // a ruled program that is itself a script, handed to an interpreter or a shell by its file (`node /opt/homebrew/bin/vercel
  // deploy --prod`, `bash bin/zulu upgrade`, `. bin/zulu upgrade`) is also read as that program, by the `bin` rules (#612, adds holds)
  const byFile = programsByFile([...runnable, ...fromInput], classes, nocaseOf(ctx).nocase);
  for (const c of [...runnable, ...fromInput, ...byFile]) {
    if (!c.bin) continue;
    // judge each command in the folder it actually runs in: `cd X && …`, `git -C X …`
    const where = commandCwd(c, input.cwd, ctx);
    c.cwd = where.cwd;
    if (where.unread) c.folderUnread = true;           // the board then reads no repository for it (row, binding, program go)
    // a folder change that may not have applied (#551): the board reads no repository for it either, and the row names every folder
    if (where.alts) c.folderUnsure = [...new Set([where.cwd, ...where.alts.map((a) => a.cwd)])];
    if (where.repo) c.repoCwd = where.repo;            // git told its repository: remotes and branches are read there
    const cin = { ...input, cwd: where.cwd, ...(where.repo ? { repoCwd: where.repo } : {}), cwdUnknown: where.unknown, cwdUnread: !!where.unread, baseCwd: input.cwd };
    for (const cls of classes) for (const r of cls.rules || []) {
      if (!active(r)) continue;
      let why = ruleMatch(r, c, cin, policy, rctx);
      // …and in each folder the command may run in instead: held when any of them holds it
      for (const alt of why ? [] : where.alts || []) {
        const { repoCwd: _r, ...rest } = cin;
        const aw = ruleMatch(r, c, { ...rest, cwd: alt.cwd, ...(alt.repo ? { repoCwd: alt.repo } : {}) }, policy, rctx);
        if (aw) { why = `${aw} (if a folder change in the call did not apply, it runs in ${alt.cwd})`; break; }
      }
      if (why) return gate(cls, r, why, { cmd: c, dryTokens: cls.requireDryRun || r.requireDryRun ? dryTokens(c, r) : null });
    }
  }
  // 1.3 checks, after the rules so a call a rule already holds keeps its class
  if (on.has('inlineBodies')) {
    for (const c of runnable) for (const body of c.inlineBodies || []) {
      const nb = normalizeForTriggers(body);
      if (keywordHit(nb, policy) || decider(nb)) return opaque(`${c.bin} program passed on the command line mentions a gated action`, { check: 'inlineBodies', cmd: c });
      if (insideGuarded(c)) return opaque(`${c.bin} program passed on the command line runs inside a guarded folder`, { check: 'inlineBodies', cmd: c });
    }
  }
  if (on.has('renamedBins')) {
    const why = renamedProgram(runnable, policy, nocaseOf(ctx).nocase);
    if (why) return opaque(why.text, { check: 'renamedBins', cmd: why.cmd });
  }
  // invariant: every trigger hit must be explained by recognised commands or data
  const explained = [
    `tool_name:${tool}`,
    ...runnable.filter((c) => c.bin || c.dynamicBin).map((c) => normalizeForTriggers(c.tokens.join(' ') + ' ' + c.redirects.join(' '))),
    ...parsed.data.map(normalizeForTriggers),
  ].join('\n');
  // (a path line that matched only the call's folder is the same: the rules read each command against that folder)
  // (a guarded path's line counts only as `decides` says: side by side in the text, or the call runs in the guarded place)
  const unexplained = hits.filter((h) => !h.live && decides(h, h.flat ? flat : text) && !h.re.test(explained));   // a live line only routes the call here; its rules were asked above
  // the fast path reads the whole line, so words from separate commands can line up into a trigger
  // ("gh pr view 5 && git merge x" reads as gh…pr…merge, #438). Every word came from a recognised
  // command and no single command matched a rule above, so nothing gated runs. Anything else stays opaque.
  const oneLine = explained.replace(/\n/g, ' ');
  const unattributed = unexplained.filter((h) => !h.re.test(oneLine));
  if (unattributed.length) { const u = unattributed.sort((a, b) => (a.check ? 1 : 0) - (b.check ? 1 : 0))[0]; return opaque(`a gated pattern the parser could not attribute (${u.ere.slice(0, 60)})`, viaCheck(u)); }
  if (unexplained.length) return { verdict: 'clear', why: `words from separate commands lined up into a trigger; no single command matched (${unexplained[0].ere.slice(0, 40)})`, scripts: runnable.filter((c) => isScript(c)).map((c) => c) };
  return { verdict: 'clear', why: 'recognised, not gated', scripts: runnable.filter((c) => isScript(c)).map((c) => c) };
}

/**
 * A program the rules do not know, or one run by path, whose first words are a gated action: `./mygh pr
 * merge 5`, `mygit push origin main`, `wrangler deploy`. The match is on the leading words only, so
 * `git commit -m "push the fix"` and `kubectl -n deploy get pods` are left alone.
 */
function renamedProgram(cmds, policy, nocase = false) {
  const prefixes = gatedPrefixes(policy);
  const low = (b) => (nocase ? String(b).toLowerCase() : b);      // a rule's program name is read the way the call's was
  const ruled = new Set((policy?.classes || []).flatMap((c) => (c.rules || []).map((r) => r.bin).filter(Boolean).map(low)));
  const globals = new Set([...VALUE_FLAGS.git, ...VALUE_FLAGS.gh]);
  for (const c of cmds) {
    if (!c.bin || SHELLS.has(c.bin) || INTERPRETERS.has(c.bin) || INDIRECT.has(c.bin)) continue;    // only names literally on the lists skip this: a versioned name keeps it
    // a path into a usual PATH folder runs the same file the bare name would: judged like the bare name
    const byPath = c.tokens[0].includes('/') && !USUAL_BIN_DIR.test(c.tokens[0]);
    if ((PLAIN_BINS.has(c.bin) || READERS.has(c.bin)) && !byPath) continue;
    if (ruled.has(c.bin) && !byPath) continue;
    // leading words: what follows the program, past git/gh-style global options and their values
    let k = 1;
    while (k < c.tokens.length && globals.has(c.tokens[k])) k += 2;
    // a known program run by path (/usr/bin/git push …) was judged by its own rules above: only another program's words count
    const own = new Set(prefixes.filter((x) => low(x.bin) === c.bin).map((x) => x.words.join(' ')));
    const p = prefixes.find((x) => !own.has(x.words.join(' ')) && x.words.every((w, j) => c.tokens[k + j] === w));
    if (p) return { cmd: c, text: `${c.tokens[0]} is ${byPath ? 'run by path' : 'not a program the gate knows'} and its first words are a gated action (${p.words.join(' ')})` };
  }
  return null;
}

/**
 * The folder a simple command runs in: the hook's cwd, then each literal `cd`, then `git -C`, then the repository
 * git is told to use (`--git-dir`, `GIT_DIR`). `alts` (#551): when a folder change may not have applied to the
 * command (c.cdUnsure), the other folders it may run in, one per change it may have stopped before; the rules
 * read the command in each of them.
 */
export function commandCwd(c, base, ctx = {}) {
  const fixed = (t) => /^(\/|~(\/|$))/.test(String(t));
  const targets = c.cdTargets || [];
  const after = (n) => {
    let cwd = base || '/';
    // ctx.baseUnread (#548): the call's own folder was never told to the hook (a Codex shell call). Only a folder the
    // command names from the root (`cd /x`, `cd ~/x`, `git -C /x`) is known then; a relative one hangs off the unknown.
    let anchored = !ctx.baseUnread;
    // a cd anchors only when it certainly applied to this command (c.cdUnsure: a `;`, `||`, `|`, `&` or popd since)
    for (const t of targets.slice(0, n)) { cwd = absPath(t, cwd, ctx); if (fixed(t) && !c.cdUnsure) anchored = true; }
    if (c.bin === 'git') {
      const toks = c.tokens;
      for (let k = 1; k < toks.length; k++) {
        if (toks[k] === '-C' && toks[k + 1] != null) {
          if (/[$`*?]/.test(toks[k + 1])) return { cwd, unknown: true };
          if (fixed(toks[k + 1])) anchored = true;
          cwd = absPath(toks[k + 1], cwd, ctx); k++;
        } else if (!toks[k].startsWith('-')) break;      // global options end at the subcommand
      }
      // git told its repository (#551): its remotes, branches and HEAD are that repository's (`repo`), while its work
      // tree stays the folder the shell stands in (`cwd`, what the live-checkout rules read). Set on the command, or
      // exported earlier in the call (ctx.line). It never anchors an unread folder.
      const gd = flagValues(c.tokens, '--git-dir')[0] ?? envValue('GIT_DIR', `${c.text || ''} ${ctx.line || ''}`, ctx);
      if (gd != null) {
        if (!gd || /[$`*?]/.test(gd)) return { cwd, unknown: true };
        return { cwd, repo: absPath(gd, cwd, ctx), unknown: !!c.cdUnknown || !anchored, ...(anchored ? {} : { unread: true }) };
      }
    }
    return { cwd, unknown: !!c.cdUnknown || !anchored, ...(anchored ? {} : { unread: true }) };
  };
  const main = after(targets.length);
  if (c.cdUnsure && !ctx.baseUnread && !main.unknown) {
    const seen = new Set([`${main.cwd}\0${main.repo || ''}`]);
    const alts = Array.from({ length: targets.length }, (_, n) => after(n)).filter((w) => !w.unknown && !seen.has(`${w.cwd}\0${w.repo || ''}`) && seen.add(`${w.cwd}\0${w.repo || ''}`));
    if (alts.length) main.alts = alts;
  }
  return main;
}

function keywordHit(norm, policy) {
  return [...DEFAULT_KEYWORDS, ...(policy?.keywords || [])].some((k) => new RegExp(`(^|[^A-Za-z0-9_.-])${String(k).split(/\s+/).map(jsEsc).join('\\s+')}([^A-Za-z0-9_-]|$)`, 'i').test(norm))
    || /(^|[^A-Za-z0-9_-])--(commit|apply|execute|write|confirm|activate|live|send|go)([^A-Za-z0-9_-]|$)/.test(norm);
}
const jsEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listOr = (p, policy) => (String(p).startsWith('@') ? policy?.lists?.[String(p).slice(1)] || [] : [p]);

// a script handed to an interpreter or a shell
const runsAScript = (bin) => isInterpreter(bin) || isShell(bin);
// Flags of the interpreters and shells whose next word is the flag's value, not the script (#530):
// `node --import ./pre.mjs scripts/x.mjs`, `bash --rcfile ./rc.sh x.sh`. The list only picks which word is
// called "the script"; a rule that names a script is tried on every script-looking word (scriptWords).
const NODE_VALUE_FLAGS = ['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--env-file-if-exists',
  '--cpu-prof-dir', '--heap-prof-dir', '--diagnostic-dir', '--report-dir', '--report-directory', '--snapshot-blob', '--build-snapshot-config',
  '--experimental-config-file', '--openssl-config', '--icu-data-dir', '--redirect-warnings', '--watch-path', '-C', '--conditions',
  '--preload', '--tsconfig', '--project', '-P', '--config', '--cwd'];
const SHELL_VALUE_FLAGS = ['--rcfile', '--init-file', '-O', '+O', '-o', '+o'];
const SCRIPT_VALUE_FLAGS = { python: ['-W', '-X', '-Q'], python3: ['-W', '-X'], ruby: ['-I', '-r', '-C', '-E', '-K', '-F', '-T'], perl: ['-I', '-M', '-m', '-C'], php: ['-c', '-d', '-z', '-F'] };
const scriptValueFlag = (bin, t) => (isShell(bin) ? SHELL_VALUE_FLAGS : SCRIPT_VALUE_FLAGS[progName(bin)] || NODE_VALUE_FLAGS).includes(t);
const scriptLike = (p) => SCRIPT_EXT.test(p) || p.includes('/');
/** Every word of an interpreter or shell call that looks like a script, with whether it sits where a flag's value sits. */
function scriptCands(c) {
  const out = [];
  for (let k = 1; k < c.tokens.length; k++) {
    const t = c.tokens[k];
    if (t.startsWith('-') || !scriptLike(t)) continue;
    out.push({ word: t, value: scriptValueFlag(c.bin, c.tokens[k - 1]) });
  }
  return out;
}
/** The script-looking words of an interpreter or shell call, in order (a flag's value included). */
export function scriptWords(c) {
  if (!c?.bin || !runsAScript(c.bin)) return [];
  return scriptCands(c).map((x) => x.word);
}
export function isScript(c) {
  if (!c.bin) return false;
  if (runsAScript(c.bin)) return scriptCands(c).length > 0;
  if (c.bin === 'npx' || c.bin === 'uv' || c.bin === 'pnpm' || c.bin === 'npm') return c.tokens.length > 1;
  return c.tokens[0].includes('/') || SCRIPT_EXT.test(c.tokens[0]);
}
/** The script a command runs (its path token), for dry-run bookkeeping. */
export function scriptPath(c) {
  if (runsAScript(c.bin)) { const cs = scriptCands(c); return (cs.find((x) => !x.value) || cs[0])?.word || null; }
  return c.tokens[0];
}

// usage/help never changes anything: `gh pr merge --help` is not a merge (bin rules only — never scripts)
const HELP_BINS = new Set(['gh', 'git', 'vercel', 'launchctl', 'shopify', 'crontab']);
const HELP_FLAGS = new Set(['--help', '-h', '--version', 'help']);

/**
 * gh takes a subcommand's flags anywhere ("gh --subject x pr merge 5", "gh pr --subject x merge 5"), and
 * the gate can't know every flag's value, so a value can read as a positional (#438). The rule's words
 * must appear in order; before and between them only flags and a word right after a flag (it may be that
 * flag's value) are skipped. Any other word stops the match: "gh pr view merge" and "gh pr list --search
 * merge" are not merges, and gh itself refuses "gh pr x merge".
 */
export function ghWordsMatch(tokens, words) {
  const walk = (from, k) => {
    if (k === words.length) return true;
    for (let j = from; j < tokens.length; j++) {
      if (tokens[j].startsWith('-')) continue;
      if (tokens[j] === words[k] && walk(j + 1, k + 1)) return true;
      if (!tokens[j - 1].startsWith('-')) return false;
    }
    return false;
  };
  return walk(1, 0);
}

/**
 * The runs of a script that reaches an interpreter or a shell on its input, each written as the plain form
 * (`<program> [its own options] <file> [the script's words]`), for the rules on a script to read. The input is the
 * program only when the call names no script itself: no word at all (`bash < x.sh`, `node --input-type=module < x.mjs`),
 * or the words follow `-s`, `-` or `--` (`bash -s -- --yes < install.sh`, `node - --commit < x.mjs`). With a script on
 * the line (`node x.mjs < data.json`) or a program in a word (`bash -c …`, `node -e …`) the input is data.
 * The file comes from an input redirect, from `cat <files>` piped in, or from a here-string that is one file's content.
 */
function stdinScriptRuns(c, prev) {
  if (!c?.bin || c.viaStdin || !(isInterpreter(c.bin) || isShell(c.bin))) return [];
  const piped = (c.sepBefore === '|' || c.sepBefore === '|&') && prev?.bin === 'cat' ? prev.tokens.slice(1).filter((t) => !t.startsWith('-')) : [];
  const files = [...(c.reads || []), ...(c.hereFiles || []), ...piped].filter((t) => t && !/[$`*?]/.test(t) && !t.startsWith('/dev/'));
  if (!files.length) return [];
  const rest = c.tokens.slice(1);
  const lead = []; let args = null;
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (t === '--' || t === '-' || (isShell(c.bin) && /^-[a-zA-Z]*s[a-zA-Z]*$/.test(t))) { if (t !== '--' && t !== '-') lead.push(t); args = rest.slice(k + 1).filter((x, j) => !(j === 0 && x === '--')); break; }
    if (!t.startsWith('-') && !t.startsWith('+')) {
      if (scriptValueFlag(c.bin, rest[k - 1])) { lead.push(t); continue; }       // a flag's value (`-r ./pre.cjs`), not a script of its own
      return [];                                                                 // a word of its own: the call names its program, the input is data
    }
    if (/^-[a-zA-Z]*[cep]$/.test(t) || ['--eval', '--print', '--command'].includes(t)) return [];   // a program in a word
    lead.push(t);
  }
  return files.map((file) => ({ ...c, tokens: [c.tokens[0], ...lead, file.includes('/') ? file : `./${file}`, ...(args || [])], reads: [], redirects: (c.redirects || []).filter((t) => t !== file), viaStdin: file }));
}

/**
 * The commands an interpreter or shell call also is when one of its script words names a ruled program (#612):
 * `bash [flags] <path>/zulu upgrade` → `zulu upgrade`, with the words after the script. Read by the `bin` rules only.
 */
/** The first word an interpreter or shell takes as its script, past its flags (`bash -x zulu upgrade`, `bash -- zulu`: a shell
 * looks a name without a slash up on PATH too). None after a command string, python's `-m`, or code on the command line. */
function firstOperand(c) {
  if (inlineBodies(c.bin, c.tokens).length) return null;
  for (let k = 1; k < c.tokens.length; k++) {
    const t = c.tokens[k];
    if (t === '--') return c.tokens[k + 1] ?? null;
    if (!/^[-+]./.test(t)) return t;
    if (isShell(c.bin) && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t)) return null;
    if (t === '-m' || t === '-') return null;
    if (scriptValueFlag(c.bin, t)) k++;
  }
  return null;
}
function programsByFile(cmds, classes, nocase) {
  const low = (b) => (nocase ? String(b).toLowerCase() : String(b));
  const ruled = new Set(classes.flatMap((cl) => (cl.rules || []).map((r) => r.bin).filter(Boolean).map(low)));
  const out = [];
  for (const c of cmds) {
    // `.` and `source` run the file in the calling shell: read here too (`. bin/zulu upgrade`), for the `bin` rules only
    const sourced = c?.bin === '.' || c?.bin === 'source';
    if (!c?.bin || c.byFile || !(runsAScript(c.bin) || sourced)) continue;
    for (const w of new Set([...scriptWords(c), sourced ? c.tokens[1] : firstOperand(c)].filter(Boolean))) {
      const name = low(path.basename(w));
      const k = c.tokens.indexOf(w);
      // (no exemption for a shell's syntax check, `bash -n bin/zulu`: a flag's value and `-n +n` defeated every reading of
      // it; a held syntax check is the cheaper error)
      if (!ruled.has(name) || k < 0) continue;
      out.push({ ...c, tokens: [name, ...c.tokens.slice(k + 1)], bin: name, byFile: w, viaStdin: undefined });
    }
  }
  return out;
}

function ruleMatch(r, c, input, policy, ctx, only) {
  if (c.viaStdin && !(r.scriptIn || r.script)) return null;       // the rewritten form exists for the script rules only
  if (c.byFile && !r.bin) return null;                             // a script read as the ruled program it is: its `bin` rules only
  // A rule that names a script is tried on every script-looking word of an interpreter or shell call, not only
  // the first: the first may be a flag's value (`node --import ./pre.mjs scripts/upgrade.mjs`), and no list of
  // value flags is ever complete. It can only add a hold (#530).
  if (r.scriptIn && only == null && runsAScript(c.bin)) {
    for (const w of new Set(scriptWords(c))) { const hit = ruleMatch(r, c, input, policy, ctx, w); if (hit) return hit; }
    return null;
  }
  const theScript = only ?? scriptPath(c);
  if (r.scriptIn) {
    // a script on a named list (e.g. @guardedScripts): gated on every run, whatever its flags
    if (!isScript(c)) return null;
    const sp = theScript;
    const abs = sp ? absPath(sp, input.cwd, ctx) : null;
    const nc = nocaseOf(ctx);                          // the script's name in another letter case is the same script there
    if (!abs || !listOr(r.scriptIn, policy).some((g) => globMatch(expandPath(g, ctx), abs, nc) || globMatch(g, path.basename(abs), nc))) return null;
  } else if (r.script) {
    if (!isScript(c)) return null;
  } else if (r.bin) {
    if (!sameBin(c.bin, r.bin, ctx)) return null;
    if (HELP_BINS.has(c.bin) && c.tokens.slice(1).some((t) => HELP_FLAGS.has(t) && t !== 'help')) return null;
    if (HELP_BINS.has(c.bin) && positionals(c)[0] === 'help') return null;
  } else if (r.sql) {
    const sqlBins = ['psql', 'sqlite3', 'mysql', 'supabase', 'duckdb'];
    if (!(sqlBins.includes(c.bin) || [scriptPath(c), ...scriptWords(c)].some((w) => /sql/i.test(path.basename(w || ''))))) return null;
    return new RegExp(r.sql, 'i').test(c.tokens.join(' ')) ? `SQL: ${c.tokens.join(' ').match(new RegExp(r.sql, 'i'))[0]}` : null;
  } else if (!r.pathAny && !r.pathWrite && !r.pathGuard && !r.textAny) return null;

  // for a script rule, args are the script's own arguments (after `node x.mjs` / `bash x.sh`)
  let pos = positionals(c);
  if (r.scriptIn && runsAScript(c.bin)) pos = c.tokens.slice(c.tokens.indexOf(theScript) + 1).filter((t) => !t.startsWith('-'));
  if (r.args && !r.args.every((a, k) => pos[k] === a) && !(c.bin === 'gh' && ghWordsMatch(c.tokens, r.args))) return null;
  if (r.argsAny && !r.argsAny.some((a) => pos.includes(a) || c.tokens.includes(a))) return null;
  if (r.notArgs && r.notArgs.some((pre) => pre.every((a, k) => pos[k] === a))) return null;
  if (r.flagsAny && !r.flagsAny.some((f) => hasFlag(c, f))) return null;
  if (r.unlessFlags && (Array.isArray(r.unlessFlags) ? r.unlessFlags : listOr(r.unlessFlags, policy)).some((f) => hasFlag(c, f))) return null;
  if (r.method === 'POST' && !isPost(c)) return null;
  if (r.urlAny && !c.tokens.some((t) => r.urlAny.some((u) => t.includes(u)))) return null;
  if (r.labels && !labelsOf(pos).some((l) => listOr(r.labels, policy).includes(l))) return null;
  if (r.unlessLabels && labelsOf(pos).some((l) => listOr(r.unlessLabels, policy).includes(l))) return null;
  if (r.mentions && !c.tokens.some((t) => r.mentions.some((m) => t.toLowerCase().includes(String(m).toLowerCase())))) return null;
  if (r.pathGuard) { const hit = guardedWrite(r, c, input, policy, ctx); return hit ? `${c.bin} writes ${hit}` : null; }
  // textAny (e.g. gate_decide): only commands that can send it somewhere — never readers such as grep/cat/sed
  // (without regard to case: a header name such as the decision header is the same in any case)
  if (r.textAny && (!TEXT_SENDERS.has(progName(c.bin)) || !r.textAny.some((t) => c.tokens.join(' ').toLowerCase().includes(String(t).toLowerCase())))) return null;
  if (r.pathAny || r.pathWrite) {
    const globs = [...(r.pathAny || []).flatMap((p) => listOr(p, policy)), ...(r.pathWrite ? listOr(r.pathWrite, policy) : [])];
    // pathAny: any mention (read or write). pathWrite: a redirect target, or an argument of a non-reader.
    // folder unknown (after an unresolvable cd): a relative path whose name matches a guarded name counts
    const sameName = (t, g) => !t.startsWith('/') && !t.startsWith('~') && samePath(path.basename(t), path.basename(String(g)), ctx) && !String(g).endsWith('*');
    const matches = (t) => !t.startsWith('-') && globs.some((g) => rootedMatch(g, absPath(t, input.cwd, ctx), ctx) || (input.cwdUnknown && sameName(t, g)));
    // (going into a write-guarded folder is not a write: what is then written relative to it is read against that folder)
    const hit = c.redirects.find(matches) || ((r.pathAny || !(isReader(c) || NO_TOUCH.has(c.bin))) ? c.tokens.slice(1).find(matches) : null);
    if (!hit) return null;
    return `${c.bin} touches ${hit}`;
  }
  if (r.when === 'pushProtected') return pushProtected(r, c, input, policy, ctx);
  if (r.when === 'outsideRepo') return rmOutside(c, input, ctx);
  if (r.when === 'gitConfigWrite') return gitConfigWrite(c, input, policy, ctx);
  if (r.when === 'gitDashC') return gitDashC(c);
  if (r.when === 'gitRefWrite') return gitRefWrite(c);
  if (r.when === 'liveCheckout') return liveGit(c, input, policy, ctx);
  if (r.when === 'boardProcess') return killsBoard(c, input, ctx);
  if (r.flagsAny) return `${r.flagsAny.find((f) => hasFlag(c, f))} on ${scriptPath(c) || c.bin}`;
  if (r.scriptIn) return `runs ${theScript}${r.args || r.argsAny ? ` ${pos.slice(1, 3).join(' ')}` : ''}`;
  return `${c.bin} ${pos.slice(0, 2).join(' ')}`.trim();
}

// ── gate self-protection (1.3, check `selfProtect`) ─────────────────────────
const WRITE_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
// going into a folder, and the shell's own words (`for f in *.plist`), write nothing
const NO_TOUCH = new Set(['cd', 'chdir', 'pushd', 'popd', 'for', 'case', 'select', 'in', 'do', 'done', 'esac', 'fi', '[[']);
const guardGlobs = (r, policy) => [].concat(r.pathGuard || []).flatMap((p) => listOr(p, policy));
const flagValues = (args, ...names) => {
  const out = [];
  args.forEach((t, k) => {
    if (names.includes(t) && args[k + 1] != null) out.push(args[k + 1]);
    for (const n of names) if (n.startsWith('--') && t.startsWith(n + '=')) out.push(t.slice(n.length + 1));
  });
  return out;
};
/** The paths a command writes, for the programs whose write position is known (a redirect is handled apart). */
export function writeTargets(c) {
  const args = c.tokens.slice(1);
  const pos = args.filter((t) => !t.startsWith('-'));
  const intoDir = (dest, srcs) => [dest, ...srcs.map((s) => path.join(dest, path.basename(s)))];
  switch (progName(c.bin)) {
    case 'cp': case 'ln': case 'install': case 'rsync': case 'scp': case 'ditto': {
      if (pos.length < 2) return flagValues(args, '-t', '--target-directory');
      return intoDir(pos[pos.length - 1], pos.slice(0, -1));
    }
    case 'mv': return pos.length < 2 ? pos : [...pos.slice(0, -1), ...intoDir(pos[pos.length - 1], pos.slice(0, -1))];
    case 'tee': case 'rm': case 'unlink': case 'truncate': case 'touch': case 'chmod': case 'chown': case 'rmdir': case 'patch': case 'shred': return pos;
    case 'sed': return isReader(c) ? [] : args.filter((t, k) => !t.startsWith('-') && !['-e', '-f', '--expression', '--file'].includes(args[k - 1]));   // an -e expression is not a file
    case 'perl': case 'ruby': return args.some((t) => /^-[A-Za-z0-9]*i/.test(t) && !t.startsWith('--')) ? pos : [];
    case 'dd': return args.filter((t) => t.startsWith('of=')).map((t) => t.slice(3));
    case 'curl': return flagValues(args, '-o', '--output');
    case 'wget': return flagValues(args, '-O', '--output-document');
    case 'sort': return flagValues(args, '-o', '--output');
    // (de)compressors replace the file they are given: the name with and without its suffix
    case 'gunzip': case 'gzip': case 'bunzip2': case 'bzip2': case 'unxz': case 'xz': case 'zstd': case 'unzstd': case 'uncompress':
      if (args.some((t) => /^-[A-Za-z]*[clt]/.test(t) && !t.startsWith('--')) || args.some((t) => ['--stdout', '--to-stdout', '--list', '--test'].includes(t))) return [];
      return pos.flatMap((f) => [f, f.replace(/\.(gz|tgz|bz2|xz|zst|Z)$/, '')]);
    // line editors write the files they are given
    case 'ex': case 'ed': case 'vi': case 'vim': case 'nvim': return pos;
    // npm pkg set|delete rewrites the package file of the folder it runs in
    case 'npm': return pos[0] === 'pkg' && ['set', 'delete', 'fix'].includes(pos[1]) ? [path.join(flagValues(args, '--prefix')[0] || '.', 'package.json')] : [];
    default: return [];
  }
}
/** A guarded path this command writes: a redirect target, a writer's target, or a folder above one that rm/mv takes away. */
function guardedWrite(r, c, input, policy, ctx) {
  const globs = guardGlobs(r, policy);
  const nc = nocaseOf(ctx);
  // $HOME and $PWD are known: read them as the folders they are
  const homeDir = ctx.home || process.env.HOME || '~';
  // …and so are $(pwd), `pwd` and ~name (the folder next to the caller's own home)
  const known = (t) => String(t).replace(/^\$\{?HOME\}?(?=\/|$)/, homeDir).replace(/^(\$\{?PWD\}?|\$\(\s*pwd\s*\)|`\s*pwd\s*`)(?=\/|$)/, input.cwd || '.')
    .replace(/^~([A-Za-z_][A-Za-z0-9_.-]*)(?=\/|$)/, (m, u) => (homeDir.startsWith('/') ? path.join(path.dirname(homeDir), u) : m));
  const fixed = (t) => !t.startsWith('-') && !/[$`*?]/.test(t) && !/\[[^\]/]+\]/.test(t);
  const sameName = (t, g) => !t.startsWith('/') && !t.startsWith('~') && path.basename(t) === path.basename(String(g)) && !String(g).endsWith('*');
  // any other variable in front: the gate cannot know the folder, so a tail that ends like a guarded file asks
  const tailOf = (t) => { const m = /^(?:\$\{[^}]+\}|\$[A-Za-z_][A-Za-z0-9_]*)(\/[^$`*?]+)$/.exec(t); return m ? m[1] : null; };
  const ends = (a, b) => (nc.nocase ? a.toLowerCase().endsWith(b.toLowerCase()) : a.endsWith(b));
  const endsGuarded = (tail) => globs.some((g) => {
    const e = expandPath(g, ctx);
    if (e.startsWith('**/') && !e.slice(3).includes('*')) return ends(tail, e.slice(2));      // **/.claude/settings.json
    return !e.includes('*') && ends(e, tail);
  });
  // a target spelled with a variable, a substitution or a pattern: its fixed part says which folder it reaches
  const spelled = (t) => {
    const cut = t.search(/[$`*?[]/);
    const head = t.slice(0, cut);
    if (!head) return false;                                         // starts with a variable: the tail rule above
    const pattern = !/[$`]/.test(t);
    const dir = head.includes('/') ? head.slice(0, head.lastIndexOf('/') + 1) : '.';
    const folder = absPath(dir, input.cwd, ctx).replace(/\/+$/, '');
    if (folder.length < 2) return false;                              // the root: a pattern or an expression, not a place
    return globs.some((g) => {
      const e = expandPath(g, ctx);
      if (!e.startsWith('/')) return false;
      if (pattern && !e.includes('*')) return shellGlob(absPath(t, input.cwd, ctx), e, nc);   // src/gate?.mjs against the file itself
      const lit = e.split('*')[0];
      return startsPath(lit, folder + '/', ctx) || startsPath(folder + '/', lit, ctx);         // a guarded file below that folder, or the folder inside a guarded one
    });
  };
  const covers = (raw) => {
    const t = known(raw);
    if (t.startsWith('-')) return false;
    if (/\{[^{}]*,[^{}]*\}/.test(t)) return braces(t).some(covers);  // src/gates.{mjs,bak}
    if (!fixed(t)) { const tail = tailOf(t); return (!!tail && endsGuarded(tail)) || spelled(t); }
    return globs.some((g) => rootedMatch(g, absPath(t, input.cwd, ctx), ctx, nc) || (input.cwdUnknown && sameName(t, g)));
  };
  const above = (raw) => {
    const t = known(raw);
    if (!fixed(t)) return false;
    const a = absPath(t, input.cwd, ctx).replace(/\/+$/, '');
    return globs.some((g) => { const lit = expandPath(g, ctx).split('*')[0]; return lit.startsWith('/') && startsPath(lit, a + '/', ctx); });
  };
  const args = c.tokens.slice(1);
  // `< file` is in redirects too (it always was); only what the command writes counts here
  const direct = c.redirects.filter((t) => !(c.reads || []).includes(t)).find(covers) || writeTargets(c).find(covers);
  if (direct) return direct;
  if (['rm', 'mv', 'rmdir'].includes(c.bin)) return args.find(above) || null;
  const pos = args.filter((t) => !t.startsWith('-'));
  // a pattern or a variable as the source: the names that land in the folder are not in the text
  if (['cp', 'ln', 'install', 'scp'].includes(c.bin) && pos.length >= 2 && pos.slice(0, -1).some((t) => !fixed(known(t))) && above(pos[pos.length - 1])) return pos[pos.length - 1];
  // a download that takes its name from the address lands in the folder it runs in (or the one it is given)
  if (c.bin === 'curl' && args.some((t) => (/^-[A-Za-z]*[OJ]/.test(t) && !t.startsWith('--')) || t === '--remote-name' || t === '--remote-name-all' || t === '--remote-header-name')) {
    const dest = flagValues(args, '--output-dir')[0] || '.'; return above(dest) ? `${dest} (a download named by its address)` : null;
  }
  if (c.bin === 'wget' && !flagValues(args, '-O', '--output-document').length && !args.some((t) => /^-O./.test(t) || t === '--spider')) {
    const dest = flagValues(args, '-P', '--directory-prefix')[0] || '.'; return above(dest) ? `${dest} (a download named by its address)` : null;
  }
  // unpackers that name no file: what is in the archive lands in the folder
  if (c.bin === 'cpio' && args.some((t) => (/^-[A-Za-z]*[ip]/.test(t) && !t.startsWith('--')) || t === '--extract' || t === '--pass-through')) {
    const dest = flagValues(args, '-D', '--directory')[0] || (args.some((t) => /^-[A-Za-z]*p/.test(t) || t === '--pass-through') && pos[pos.length - 1]) || '.';
    return above(dest) ? `${dest} (cpio names its own files)` : null;
  }
  if (c.bin === 'pax' && args.some((t) => /^-[A-Za-z]*r/.test(t))) { const dest = (args.some((t) => /^-[A-Za-z]*w/.test(t)) && pos[pos.length - 1]) || '.'; return above(dest) ? `${dest} (pax names its own files)` : null; }
  if (['7z', '7za', '7zz', '7zr'].includes(c.bin) && ['x', 'e'].includes(pos[0])) { const o = args.find((t) => /^-o./.test(t)); const dest = o ? o.slice(2) : '.'; return above(dest) ? `${dest} (an archive names its own files)` : null; }
  if (c.bin === 'unrar' && ['x', 'e'].includes(pos[0])) { const dest = pos.length >= 3 ? pos[pos.length - 1] : '.'; return above(dest) ? `${dest} (an archive names its own files)` : null; }
  if (c.bin === 'unar') { const dest = flagValues(args, '-o', '-output-directory')[0] || '.'; return above(dest) ? `${dest} (an archive names its own files)` : null; }
  // git checkout-index --prefix=<folder>/ writes the index of whatever repo it runs in into that folder
  if (c.bin === 'git' && args.includes('checkout-index')) { const pre = flagValues(args, '--prefix')[0]; if (pre && above(pre)) return `${pre} (git checkout-index --prefix)`; }
  // a recursive copy, a sync or an extract into a folder that holds a guarded file names none of them
  const recursive = c.bin === 'rsync' || c.bin === 'ditto' || (c.bin === 'cp' && args.some((t) => /^-[A-Za-z]*[RrAa]/.test(t) || t === '--recursive' || t === '--archive'));
  if (recursive) return writeTargets(c).find(above) || null;
  if (['tar', 'bsdtar', 'gtar', 'gnutar'].includes(c.bin) && args.some((t) => (/^-?[A-Za-z]*x/.test(t) && !t.startsWith('--') && t === args[0]) || /^-[A-Za-z]*x/.test(t) || t === '--extract' || t === '--get')) {
    const dest = flagValues(args, '-C', '--directory')[0] || '.';
    return above(dest) ? dest : null;
  }
  if (c.bin === 'unzip' && !args.some((t) => /^-[A-Za-z]*[lptvZz]/.test(t))) { const dest = flagValues(args, '-d')[0] || '.'; return above(dest) ? dest : null; }
  // patch with no file named takes the names from the diff
  if (c.bin === 'patch' && args.filter((t) => !t.startsWith('-')).length === 0) { const dest = flagValues(args, '-d', '--directory')[0] || '.'; return above(dest) ? `${dest} (patch names its own files)` : null; }
  return null;
}
/** Is this folder inside the board's live checkout (never one of its worktrees)? */
function inLive(cwd, ctx) {
  if (!ctx.boardRoot || !cwd) return false;
  const top = ctx.repoRoot ? ctx.repoRoot(cwd) : null;
  if (top) return samePath(path.resolve(top), path.resolve(ctx.boardRoot), ctx);
  return samePath(cwd, ctx.boardRoot, ctx) || startsPath(cwd, ctx.boardRoot + path.sep, ctx);
}
/** The folder a git command acts on when it says so itself: --work-tree / --git-dir, or GIT_WORK_TREE / GIT_DIR set in front of it. */
function gitTarget(c, cwd, ctx, line = '') {
  const named = [...flagValues(c.tokens, '--work-tree'), ...flagValues(c.tokens, '--git-dir').map((d) => d.replace(/\/?\.git\/?$/, '') || d)];
  const root = ctx.boardRoot;
  // set in front of the command, or exported by an earlier command of the same call
  if (root) for (const n of ['GIT_WORK_TREE', 'GIT_DIR']) { const v = envValue(n, `${c.text || ''} ${line}`, ctx); if (v != null && startsPath(expandPath(v, ctx), root, ctx)) named.push(root); }
  return named.length ? absPath(named[0], cwd, ctx) : null;
}
/** The value NAME=… is given anywhere in this text (quotes dropped), or null. A value that starts with the board's folder is read as that folder, spaces and all. */
function envValue(name, text, ctx = {}) {
  const root = ctx.boardRoot;
  let first = null;
  for (const m of String(text).matchAll(new RegExp(`(?:^|[^A-Za-z0-9_])${name}=("[^"]*"|'[^']*'|[^\\s;&|)]*)`, 'g'))) {
    const rest = expandPath(String(text).slice(m.index + m[0].length - m[1].length).replace(/^["']/, ''), ctx);
    if (root && startsPath(rest, root, ctx)) return startsPath(rest, path.join(root, '.git'), ctx) ? path.join(root, '.git') : root;
    first ??= m[1].replace(/^["']|["']$/g, '');
  }
  return first;
}
// git subcommands that write nothing into a work tree
const GIT_READS = new Set(['status', 'diff', 'log', 'show', 'ls-files', 'ls-tree', 'rev-parse', 'grep', 'blame', 'describe', 'cat-file', 'for-each-ref', 'shortlog', 'rev-list',
  'name-rev', 'merge-base', 'ls-remote', 'help', 'version', 'diff-tree', 'diff-index', 'diff-files', 'show-ref', 'var', 'count-objects', 'fsck', 'check-ignore', 'check-attr', 'reflog']);
/** The live checkout as the work tree of a call whose index belongs to another repo: any write puts that index's content there. */
function splitTree(c, input, ctx) {
  const line = `${c.text || ''} ${input.command || ''}`;
  const wt = flagValues(c.tokens, '--work-tree')[0] ?? envValue('GIT_WORK_TREE', line, ctx);
  const gd = flagValues(c.tokens, '--git-dir')[0] ?? envValue('GIT_DIR', line, ctx);
  if (wt == null && gd == null) return null;
  if (!ctx.boardRoot || !inLive(absPath(wt ?? '.', input.cwd, ctx), ctx)) return null;      // --git-dir alone: the work tree is the folder the call runs in
  const split = gd != null ? !samePath(absPath(gd, input.cwd, ctx).replace(/\/+$/, ''), path.join(ctx.boardRoot, '.git'), ctx) : !inLive(input.cwd, ctx);
  return split ? 'git with the live checkout as its work tree and another repo as its index' : null;
}
/** Is this folder in the board's repo: its live checkout or one of its worktrees (they share refs and settings)? */
function inBoardRepo(cwd, ctx) {
  if (inLive(cwd, ctx)) return true;
  if (!ctx.boardRoot || !ctx.git || !cwd) return false;
  ctx.worktrees ??= String(ctx.git(ctx.boardRoot, ['worktree', 'list', '--porcelain']) || '').split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  const top = ctx.repoRoot ? ctx.repoRoot(cwd) : cwd;
  return !!top && ctx.worktrees.some((root) => samePath(path.resolve(root), path.resolve(top), ctx));
}
// the commands that bring content into a work tree: free only with no setting made for the one call
const ONE_CALL_SUBS = new Set(['pull', 'fetch', 'merge', 'checkout', 'switch', 'restore', 'stash', 'reset', 'read-tree', 'checkout-index', 'submodule', 'rebase', 'cherry-pick']);
// a name that reads like a remote branch or one of git's own heads: `origin/main` as a local branch or tag is what a later merge would take
const SHADOW_REF = /^(origin\/|refs\/|remotes\/|heads\/|tags\/)|^(HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD)$/;
const GIT_SETTERS = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit', '-e']);
/** `git config` that changes something: where git finds its hooks, an alias, or the user/system file. Reads are free. */
function gitConfigWrite(c, input = {}, policy = {}, ctx = {}) {
  const args = c.tokens.slice(c.tokens.indexOf('config') + 1);
  const valued = ['-f', '--file', '--blob', '--type', '--default', '--comment'];
  const pos = args.filter((t, k) => !t.startsWith('-') && !valued.includes(args[k - 1]));
  const verb = ['set', 'unset', 'edit', 'rename-section', 'remove-section', 'get', 'list', 'get-regexp'].includes(pos[0]) ? pos[0] : null;
  const rest = verb ? pos.slice(1) : pos;
  if (['get', 'list', 'get-regexp'].includes(verb) || args.some((t) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope'].includes(t))) return null;
  const writes = (verb && !['get', 'list', 'get-regexp'].includes(verb)) || args.some((t) => GIT_SETTERS.has(t)) || rest.length >= 2;
  if (!writes) return null;
  const hk = rest.find((t) => /^core\.hookspath$/i.test(t) || /^alias\./i.test(t));
  if (hk) return `git config sets ${hk}`;
  const scope = args.find((t) => t === '--global' || t === '--system');
  if (scope) return `git config ${scope} write`;
  // a named config file that is itself guarded (~/.gitconfig, a checkout's .git/config)
  const file = [...flagValues(args, '-f', '--file')][0];
  if (file && listOr('@guardGate', policy).some((g) => rootedMatch(g, absPath(file, input.cwd, ctx), ctx, nocaseOf(ctx)))) return `git config writes ${file}`;
  // which repo a gh call with no repo named acts on (gh reads this key before the origin): anywhere
  const resolved = rest.find((t) => /^remote\..+\.gh-resolved$/i.test(t));
  if (resolved) return `git config sets ${resolved} (the repo gh acts on)`;
  // in the live checkout: where the remote is, what a pull brings, what git runs
  // in the board's repo (the live checkout and its worktrees share one settings file): everything but who the committer is.
  // Where the remote is, what a pull brings, and every key that names a program git runs (filter, diff, pager, editor, credential …).
  const here = input.cwdUnread ? null : input.cwdUnknown ? input.baseCwd : input.cwd;
  const where = gitTarget(c, here, ctx, input.command) || here;
  const key = rest[0];
  if (key && /^user\./i.test(key)) return null;
  if (!where) return `git config ${key ? `sets ${key}` : 'write'} ${unreadWhere()}`;
  if (!inBoardRepo(where, ctx)) return null;
  return `git config ${key ? `sets ${key}` : 'write'} in the board's repo`;
}
/** `git -c core.hooksPath=…` or `-c alias.x=…`: a hooks folder or an alias for this one call. */
function gitDashC(c) {
  const v = flagValues(c.tokens, '-c').find((t) => /^core\.hookspath=/i.test(t) || /^alias\./i.test(t));
  return v ? `git -c ${v.split('=')[0]} for this call` : null;
}
/** Moving the local copy of a remote branch: the checks trust what the remote's default branch holds. */
function gitRefWrite(c) {
  const sub = positionals(c)[0];
  const args = c.tokens.slice(c.tokens.indexOf(sub) + 1);
  const pos = args.filter((t) => !t.startsWith('-'));
  if (sub === 'fetch' || sub === 'push') {
    // a refspec whose destination is a remote-tracking ref writes it from wherever the source says
    const spec = pos.find((t) => t.includes(':') && t.split(':').slice(1).join(':').includes('refs/remotes/'));
    return spec ? `git ${sub} writes ${spec.split(':').slice(1).join(':')}` : null;
  }
  // …and so is moving the default branch itself, or planting a branch or tag whose name reads like the remote's
  const ref = pos.find((t) => t.includes('refs/remotes/')) || (sub === 'update-ref' && pos.find((t) => /^refs\/heads\/(main|master)$/.test(t) || /^refs\/(heads|tags)\/origin\//.test(t) || t.startsWith('refs/replace/')));
  if (!ref) return null;
  if (sub === 'symbolic-ref' && !(pos.length >= 2 || args.some((t) => t === '-d' || t === '--delete'))) return null;   // reading it
  return `git ${sub} moves ${ref}`;
}
/**
 * git in the live checkout: held when the command can leave a hook, classifier or page file holding
 * something other than landed content. A fast-forward of the default branch from origin, a stash, a
 * restore from the index and everything that only reads stay free (docs/GUARDRAILS.md has the table).
 */
function liveGit(c, input, policy, ctx) {
  const pos = positionals(c); const sub = pos[0]; const rest = pos.slice(1);
  if (!GIT_READS.has(sub)) { const split = splitTree(c, input, ctx); if (split) return split; }
  const said = gitTarget(c, input.cwd, ctx, input.command);          // --work-tree / --git-dir / GIT_WORK_TREE / GIT_DIR
  const here = said || (input.cwdUnread ? null : input.cwdUnknown ? input.baseCwd : input.cwd);
  if (here && !inLive(here, ctx)) return null;
  const cwd = said || (input.cwdUnread ? null : input.cwd);
  const valueFlags = [...VALUE_FLAGS.git, '--source', '-s'];
  // a setting for this one call (-c, --config-env, any GIT_* variable) can change where a pull comes from or what git runs
  const front = c.tokens.slice(1, Math.max(1, c.tokens.indexOf(sub)));
  const oneCall = front.find((t) => t === '-c' || t.startsWith('--config-env')) || (/(^|[^A-Za-z0-9_])(GIT_[A-Z_]+)=/.exec(`${c.text || ''} ${input.command || ''}`) || [])[2];
  if (oneCall && ONE_CALL_SUBS.has(sub)) return `git ${sub} with ${oneCall} set for the call in the live checkout`;
  const args = c.tokens.slice(c.tokens.indexOf(sub) + 1);
  const has = (...f) => args.some((t) => f.includes(t.split('=')[0]));
  const def = String(ctx.git?.(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) || 'origin/main').replace(/^origin\//, '');
  const gateCode = listOr('@gateCode', policy);
  const top = (ctx.repoRoot && ctx.repoRoot(cwd)) || ctx.boardRoot;
  const nc = nocaseOf(ctx);
  // a path, a folder above a gate file, a pattern, or git's own pathspec forms (:/ and :(top) start at the repo's top)
  const touches = (raw) => {
    let p = String(raw); let base = cwd;
    const magic = /^:(\/|\([^)]*\))/.exec(p);
    if (magic) { p = p.slice(magic[0].length) || '.'; base = top; }
    const a = absPath(p, base, ctx).replace(/\/+$/, '');
    if (/[*?[]/.test(p)) return gateCode.some((g) => { const e = expandPath(g, ctx); return globMatch(a, e.replace(/\/\*\*$/, ''), nc) || globMatch(a.replace(/\*/g, '**'), e.replace(/\/\*\*$/, '/x'), nc); });
    return gateCode.some((g) => rootedMatch(g, a, ctx, nc) || startsPath(expandPath(g, ctx).split('*')[0], a + '/', ctx));
  };
  const paths = () => args.filter((t, k) => !t.startsWith('-') && !valueFlags.includes(args[k - 1]));
  const where = 'in the live checkout';
  if (has('--abort', '--quit')) return null;                                  // gives the files back as they were
  switch (sub) {
    case 'pull': {
      if (!has('--ff-only') || has('--rebase', '-r')) return `git pull without --ff-only ${where}`;
      if (rest[0] && rest[0] !== 'origin') return `git pull from ${rest[0]} ${where}`;
      if (rest[1] && rest[1] !== def) return `git pull of ${rest[1]} ${where} (the default branch is ${def})`;
      if (rest[2]) return `git pull of more than one branch ${where}`;
      if (has('--upload-pack', '--refmap')) return `git pull with ${has('--refmap') ? '--refmap' : '--upload-pack'} ${where}`;
      if (rest[0] && rest[1]) return null;
      // nothing named: git pulls the branch's upstream, which a free command could have re-pointed
      const up = ctx.git?.(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
      return up === `origin/${def}` ? null : `git pull of ${up || 'an upstream the gate cannot read'} ${where} (only origin/${def} is free)`;
    }
    case 'branch':
      if (has('-u', '--set-upstream-to', '--unset-upstream')) return `git branch changes the upstream ${where}`;
      if (has('-f', '--force', '-M', '-m', '-C', '--move') || args.some((t) => /^-[A-Za-z]*[fMC]/.test(t) && !t.startsWith('--'))) return `git branch moves or renames a branch ${where}`;
      return rest[0] && SHADOW_REF.test(rest[0]) ? `git branch ${rest[0]}: a local name that reads like the remote's ${where}` : null;
    case 'tag': return rest[0] && SHADOW_REF.test(rest[0]) && !has('-l', '--list', '-d', '--delete', '-v', '--verify') ? `git tag ${rest[0]}: a name that reads like the remote's ${where}` : null;
    // the index and HEAD are what a free stash or restore writes out: moving them is the write
    case 'update-index': return has('--cacheinfo', '--index-info') ? `git update-index writes an index entry ${where}` : null;
    case 'update-ref': return `git update-ref ${where}`;
    // a replacement makes git read one commit as another: what HEAD holds is then something else
    case 'replace': return rest.length && !has('-l', '--list') ? `git replace ${where}` : null;
    case 'symbolic-ref': return rest.length >= 2 || has('-d', '--delete') ? `git symbolic-ref moves ${rest[0] || 'a ref'} ${where}` : null;
    case 'fetch': {
      const flag = ['--refmap', '-u', '--update-head-ok', '--upload-pack'].find((f) => has(f));
      if (flag) return `git fetch ${flag} ${where}`;
      // into the default branch, or a local name that reads like the remote's (another local branch is only a new name)
      const dstOf = (t) => t.split(':').slice(1).join(':');
      const spec = rest.slice(1).find((t) => { if (!t.includes(':')) return false; const d = dstOf(t).replace(/^refs\/heads\//, ''); return d === def || d === 'HEAD' || SHADOW_REF.test(d); });
      return spec ? `git fetch writes ${dstOf(spec)} ${where}` : null;
    }
    case 'rm': case 'mv': { const hit = paths().find(touches); return hit ? `git ${sub} ${hit} ${where}` : null; }
    case 'read-tree': return rest.length && rest.every((t) => t === 'HEAD' || t === '@') && !has('-u', '--reset', '-m', '--prefix') ? null : `git read-tree ${where}`;
    case 'bisect': return rest[0] && !['log', 'view', 'visualize', 'terms', 'help'].includes(rest[0]) ? `git bisect ${rest[0]} ${where}` : null;
    case 'merge':
      if (!has('--ff-only')) return `a merge that is not --ff-only ${where}`;
      if (rest[0] !== `origin/${def}` || rest[1]) return `git merge of ${rest[1] ? 'more than one commit' : rest[0] || 'an unnamed commit'} ${where} (only origin/${def} is free)`;
      // a local branch or tag of that very name is what git would take instead of the remote's
      for (const kind of ['heads', 'tags']) if (ctx.git?.(cwd, ['rev-parse', '--verify', '--quiet', `refs/${kind}/origin/${def}`]) != null) return `git merge of origin/${def} ${where}, and a local ${kind === 'heads' ? 'branch' : 'tag'} has that name`;
      return null;
    case 'rebase': case 'cherry-pick': case 'revert': case 'am': return `git ${sub} ${where}`;
    case 'apply': return has('--check', '--stat', '--numstat', '--summary') ? null : `git apply ${where}`;
    case 'switch': return rest.length || has('-c', '-C', '--detach', '--orphan', '-') ? `git switch ${where}` : null;
    case 'reset': {
      const m = ['--hard', '--merge', '--keep'].find((f) => has(f));
      if (m) return `git reset ${m} ${where}`;
      // to another commit, whole or for some paths: the index (and HEAD) then hold that commit's content
      const dd = args.indexOf('--');
      const tgt = (dd >= 0 ? args.slice(0, dd) : args).filter((t) => !t.startsWith('-'))[0];
      if (!tgt || tgt === 'HEAD' || tgt === '@') return null;
      if (dd < 0 && ctx.git && ctx.git(cwd, ['rev-parse', '--verify', '--quiet', `${tgt}^{commit}`]) == null) return null;   // a path: unstaging it
      return `git reset to ${tgt} ${where}`;
    }
    case 'checkout': {
      const dd = args.indexOf('--');
      if (dd >= 0) {
        const from = args.slice(0, dd).filter((t) => !t.startsWith('-'));
        if (!from.length) return null;                                         // from the index: back to committed content
        const hit = args.slice(dd + 1).find(touches);
        return hit ? `git checkout ${from[0]} -- ${hit} ${where}` : null;
      }
      if (has('-b', '-B', '--detach', '--orphan') || args.includes('-')) return `git checkout to another branch ${where}`;
      if (!rest.length) return null;
      // a bare word is a branch or commit when git can resolve it as one; otherwise it is a path from the index
      if (ctx.git && ctx.git(cwd, ['rev-parse', '--verify', '--quiet', `${rest[0]}^{commit}`]) == null) {
        // no local name, but a remote has a branch called that: git makes the branch and switches to it
        const remote = !has('--no-guess') && rest.length === 1 && ctx.git(cwd, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${rest[0]}`]);
        return remote ? `git checkout ${rest[0]} ${where} (a remote branch of that name)` : null;
      }
      return `git checkout ${rest[0]} ${where}`;
    }
    case 'restore': {
      const src = flagValues(args, '--source', '-s')[0];
      if (!src) return null;                                                   // from the index or HEAD
      const hit = paths().filter((t) => t !== src).find(touches);
      return hit ? `git restore --source ${src} ${hit} ${where}` : null;
    }
    case 'stash': {
      if (rest[0] === 'branch') return `git stash branch ${where}`;
      if (rest[0] !== 'pop' && rest[0] !== 'apply') return null;
      const entry = rest[1] || 'stash@{0}';
      const names = ctx.git?.(cwd, ['stash', 'show', '--name-only', '--include-untracked', entry]) ?? ctx.git?.(cwd, ['stash', 'show', '--name-only', entry]);
      if (names == null) return `git stash ${rest[0]} of an entry the gate cannot read ${where}`;
      const hit = String(names).split('\n').map((n) => n.trim()).filter(Boolean).find((n) => gateCode.some((g) => rootedMatch(g, path.resolve(top, n), ctx, nc)));
      return hit ? `git stash ${rest[0]} would rewrite ${hit} ${where}` : null;
    }
    default: return null;
  }
}
/** kill, pkill, killall or launchctl kill/stop aimed at the board: KeepAlive restarts it on whatever code is on disk. */
function killsBoard(c, input, ctx) {
  const b = ctx.board || {};
  const names = ['server.mjs', b.label].filter(Boolean);
  const cmdline = b.cmdline || `node ${ctx.boardRoot || ''}/server.mjs`;
  const procName = path.basename(String(cmdline).split(' ')[0] || 'node') || 'node';
  const args = c.tokens.slice(1);
  const line = String(input.command || '');
  // signal 0 only asks whether the process is there
  if (['kill', 'pkill', 'killall'].includes(c.bin) && args.some((t, k) => t === '-0' || ((t === '-s' || t === '-signal') && args[k + 1] === '0'))) return null;
  const matches = (pat, full, nocase) => { try { return new RegExp(pat, nocase ? 'i' : '').test(full ? cmdline : procName); } catch { return (full ? cmdline : procName).includes(pat); } };
  // the pid is looked up on the same line: by the board's port, by its name, or by a pgrep whose pattern matches the board
  // pgrep / pidof: flags that take a value are skipped; no pattern but a user, group or terminal means every process of it
  const pgrepHit = (text) => [...String(text).matchAll(/\b(pgrep|pidof)\b([^)`|;&]*)/g)].some((m) => {
    const w = (m[2].match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
    const valued = ['-u', '-U', '-g', '-G', '-P', '-t', '-F', '-s', '-d', '-o'];
    const flags = w.filter((t) => t.startsWith('-')).join(' ');
    const pat = w.find((t, k) => !t.startsWith('-') && !valued.includes(w[k - 1]));
    if (!pat) return w.some((t) => ['-u', '-U', '-g', '-G', '-t'].includes(t));
    return matches(pat, m[1] === 'pgrep' && /-[A-Za-z]*f/.test(flags), /-[A-Za-z]*i/.test(flags));
  });
  // ps … | grep … | awk …: every filter that can be read is tried against the board's command line; none at all means every process
  const psHit = (text) => {
    if (!/\bps\b/.test(text)) return false;
    const pats = [];
    for (const m of String(text).matchAll(/\b(?:e|f)?grep\b((?:\s+-[A-Za-z]+)*)\s+("[^"]*"|'[^']*'|[^\s)`|;&]+)/g)) if (!/v/.test(m[1])) pats.push(m[2].replace(/^["']|["']$/g, ''));
    for (const m of String(text).matchAll(/\bawk\b[^|;&]*?["']([^"']*)["']/g)) for (const r of m[1].matchAll(/\/((?:[^/\\]|\\.)+)\//g)) pats.push(r[1]);
    return !pats.length || pats.some((p) => matches(p.replace(/^\[(.)\]/, '$1'), true, true));
  };
  const lookedUp = (text) => (/\b(lsof|fuser)\b/.test(text) && b.port && new RegExp(`(^|[^0-9])${b.port}([^0-9]|$)`).test(text)) || (/\b(pgrep|ps|launchctl)\b/.test(text) && names.some((n) => text.includes(n))) || pgrepHit(text) || psHit(text);
  if (['reboot', 'shutdown', 'halt', 'poweroff'].includes(c.bin)) return `${c.bin} stops the machine the board runs on`;
  if (c.bin === 'osascript') return /\b(restart|shut ?down|log ?out)\b/i.test(c.tokens.join(' ')) && /system events|finder|loginwindow/i.test(c.tokens.join(' ')) ? 'a restart or shutdown asked of the system' : null;
  if (c.bin === 'fuser' || c.bin === 'kill-port') return b.port && args.some((t) => new RegExp(`^${b.port}(/tcp)?$`).test(t)) && (c.bin === 'kill-port' || args.some((t) => /^-[A-Za-z]*k/.test(t))) ? `${c.bin} of the board's port` : null;
  if (c.bin === 'launchctl' && positionals(c)[0] === 'reboot') return 'launchctl reboot stops the machine the board runs on';
  if (c.bin === 'launchctl') return b.label && labelsOf(positionals(c)).includes(b.label) ? `launchctl ${positionals(c)[0]} of the board` : null;
  if (c.bin === 'xargs') return lookedUp(line) ? 'kill of the process found by the board\'s port or name' : null;
  if (c.bin === 'kill') {
    for (const raw of args) {
      // a pid in a variable set on the same line, in $(( )), or with a minus in front (the whole process group)
      const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
      const a = String(v && ctx.vars?.[v[1]] != null ? ctx.vars[v[1]] : raw).replace(/^\$\(\(\s*(\d+)\s*\)\)$/, '$1');
      const group = /^-\d+$/.test(a) && args.indexOf('--') >= 0 && args.indexOf(raw) > args.indexOf('--');
      const pid = /^\d+$/.test(a) ? Number(a) : group ? Number(a.slice(1)) : null;
      if (pid != null && [...(b.pids || []), ...(group && b.pgid ? [b.pgid] : [])].includes(pid)) return `kill of the board (${group ? 'process group' : 'pid'} ${pid})`;
      if (/[$`]/.test(a) && lookedUp(a)) return 'kill of the process found by the board\'s port or name';
    }
    return null;
  }
  // pkill / killall: the pattern is matched against the process name, or with -f the whole command line
  const pat = args.filter((t, k) => !t.startsWith('-') && !['-u', '-U', '-g', '-G', '-P', '-t', '-s', '-signal'].includes(args[k - 1]))[0];
  // no pattern, only a user, group or terminal: every process of it, the board among them
  if (!pat && c.bin === 'pkill') { const all = args.find((t) => ['-u', '-U', '-g', '-G', '-t'].includes(t)); return all ? `pkill ${all} with no pattern would stop the board` : null; }
  if (!pat || /[$`]/.test(pat)) return null;
  const full = c.bin === 'pkill' && args.some((t) => /^-[A-Za-z]*f/.test(t));
  const hit = c.bin === 'killall' && !args.includes('-m') ? pat === procName : matches(pat, full, args.some((t) => /^-[A-Za-z]*i/.test(t)));
  return hit ? `${c.bin} ${pat} would stop the board` : null;
}

// Programs that only read the files they're given (for pathWrite rules: reading a guarded config is fine).
// sed and find count only in their read-only forms.
const READERS = new Set(['ls', 'stat', 'test', '[', 'file', 'plutil', 'cat', 'less', 'head', 'tail', 'grep', 'rg', 'jq', 'wc', 'diff', 'cmp',
  'shasum', 'md5', 'bat', 'awk', 'cut', 'sort', 'uniq', 'tr', 'nl', 'column', 'strings', 'od', 'xxd', 'du']);
export function isReader(c) {
  if (READERS.has(c.bin)) return !(c.bin === 'sort' && c.tokens.some((t) => t === '-o' || t.startsWith('--output')));
  if (c.bin === 'sed') return !c.tokens.slice(1).some((t) => /^-[A-Za-z]*i/.test(t) || t.startsWith('--in-place'));
  if (c.bin === 'find') return !c.tokens.some((t) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(t));
  return false;
}

/** launchd labels named by launchctl arguments (gui/501/com.x, ~/Library/LaunchAgents/com.x.plist). */
export function labelsOf(pos) {
  return pos.filter((p) => p.includes('/') || p.includes('.')).map((p) => p.split('/').pop().replace(/\.plist$/, '')).filter(Boolean);
}

function isPost(c) {
  const t = c.tokens;
  for (let k = 0; k < t.length; k++) {
    if ((t[k] === '-X' || t[k] === '--request') && /^post$/i.test(t[k + 1] || '')) return true;
    if (/^-X(POST)$/i.test(t[k])) return true;
    if (/^(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|--json)(=|$)/.test(t[k])) return true;
  }
  return false;
}

function pushProtected(r, c, input, policy, ctx) {
  // which repo is being pushed is unknowable after an unresolvable cd: ask
  if (input.cwdUnread) return `git push ${unreadWhere('git -C /abs/path push …')}`;
  if (input.cwdUnknown) return 'git push from a folder the gate cannot resolve';
  const pos = positionals(c).slice(1);               // after "push"
  const flags = flagSet(c);
  const forced = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--tags', '--all', '--prune'].find((f) => flags.has(f))
    || c.tokens.find((t) => /^--force-with-lease=/.test(t) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) && !t.startsWith('--'));
  const repoAt = input.repoCwd || input.cwd;            // --git-dir / GIT_DIR (#551): that repository's remotes and branches
  const addr = pushAddress(c, input, ctx);
  if (addr.ask) return addr.ask;
  const lists = (n) => listOr(`@${n}`, policy);
  // every address the push goes to (a remote can have several push addresses; git sends to each)
  for (const slug of addr.urls.map(repoSlug).filter(Boolean)) {
    if (lists('publicRemotes').some((g) => globMatch(g.toLowerCase(), slug.toLowerCase()))) return `push to public remote ${slug}`;
    if (lists('deployOnPush').some((g) => globMatch(g.toLowerCase(), slug.toLowerCase()))) return `push to ${slug}, which deploys on push`;
  }
  if (forced) return `git push ${forced}`;
  const allow = r.allowRefs || [];
  const prot = r.protectedRefs || ['main', 'master'];
  let specs = pos.slice(1);
  const viaHead = (s) => s === 'HEAD' || s === '@';
  if (!specs.length || specs.some(viaHead)) {
    const cur = currentBranches(c, ctx.git?.(repoAt, ['rev-parse', '--abbrev-ref', 'HEAD']), ctx, repoAt);
    if (cur.ask) return cur.ask;
    // a bare push under push.default upstream (or its old name tracking) sends the branch to its upstream's name;
    // under matching, or with a push refspec configured for the remote, it sends more than the current branch: asked
    const pushDefault = specs.length ? '' : String(ctx.git?.(repoAt, ['config', '--get', 'push.default']) || '').trim().toLowerCase();
    if (pushDefault === 'matching') return 'git push with push.default matching (it sends every branch that has a match on the remote)';
    if (!specs.length && addr.remote && ctx.git?.(repoAt, ['config', '--get-all', `remote.${addr.remote}.push`])) return `git push with remote.${addr.remote}.push set (it sends the refs configured there)`;
    const upstream = /^(upstream|tracking)$/.test(pushDefault);
    // …and the upstream is read before the call: a switch, a branch made (branch.autoSetupMerge) or `branch -u` in the
    // call may set another one
    if (upstream && c.switchesBefore?.length) return `git push under push.default ${pushDefault} after a branch change in the same call (the upstream it sends to may be set by the call)`;
    const dests = (b) => [b, ...(upstream ? [String(ctx.git?.(repoAt, ['config', '--get', `branch.${b}.merge`]) || '').trim().replace(/^refs\/heads\//, '')].filter(Boolean) : [])];
    specs = specs.length ? specs.flatMap((s) => (viaHead(s) ? cur.names : [s])) : cur.names.flatMap(dests);
  }
  for (const spec of specs) {
    if (spec.startsWith(':')) return `deletes remote ref ${spec.slice(1)}`;
    if (spec.startsWith('+')) return `force refspec ${spec}`;
    const dst = (spec.includes(':') ? spec.split(':')[1] : spec).replace(/^refs\/heads\//, '');
    if (/^refs\/tags\//.test(dst) || /^v\d/.test(dst) && !dst.includes('/')) return `pushes tag ${dst}`;
    if (allow.some((g) => globMatch(g, dst))) continue;
    if (prot.includes(dst)) return `push to protected branch ${dst}`;
  }
  return null;
}
// #584: a branch name the gate reads as written: no expansion, glob or brace, not `-`, `@`/`@{…}`, a revision
// expression or a commit id
const literalBranch = (s) => typeof s === 'string' && /^[A-Za-z0-9._/-]+$/.test(s) && !s.startsWith('-') && !s.includes('..') && !/^[0-9a-f]{7,40}$/i.test(s) && s !== 'HEAD';
/**
 * What one command does to the current branch of its repository (#584). → null (no change) | { branch, made } (a
 * literal branch; made = the call creates or resets it) | { upstream: '<what>' } (the branch's upstream is set) |
 * { unknown: '<what>' } (a change the gate cannot read). "No change" only for a form read to the end as one (a
 * wrong "no change" is the gap, a wrong "unknown" is one row).
 */
export function branchSwitch(c) {
  if (c.bin === 'gh') {
    if (ghWordsMatch(c.tokens, ['pr', 'checkout']) || ghWordsMatch(c.tokens, ['pr', 'co']) || ghWordsMatch(c.tokens, ['co'])) return { unknown: 'gh pr checkout' };
    const first = positionals(c)[0];
    return first && !GH_COMMANDS.has(first) ? { unknown: `gh ${first} (a command the gate does not know: an alias may switch the branch)` } : null;
  }
  if (c.bin !== 'git') return null;
  const { sub, args } = gitWords(c);
  if (!sub) return null;
  const named = (b, made, what) => (literalBranch(b) ? { branch: b, made } : { unknown: what });
  const words = (valueFlags) => { const out = []; for (let j = 0; j < args.length; j++) { if (args[j] === '--') break; if (valueFlags.includes(args[j])) { j++; continue; } if (!args[j].startsWith('-') || args[j] === '-') out.push(args[j]); } return out; };
  if (sub === 'switch') {
    const r = readOpts(args, SWITCH_OPTS);
    if (r.odd) return { unknown: `git switch ${r.odd}` };
    if (r.has('-d', '--detach') || r.vals['--orphan'] != null) return { unknown: 'git switch --detach/--orphan' };
    const made = r.vals['-c'] ?? r.vals['-C'] ?? r.vals['--create'] ?? r.vals['--force-create'];
    if (r.paths) return { unknown: 'git switch with --' };
    if (made != null) return r.words.length <= 1 ? named(made, true, 'git switch -c with a name the gate cannot read') : { unknown: 'git switch -c' };
    if (r.has('-t', '--track')) return { unknown: 'git switch --track' };   // the local name comes from the remote one
    return r.words.length === 1 ? named(r.words[0], false, `git switch ${r.words[0]}`) : { unknown: 'git switch' };
  }
  if (sub === 'checkout') {
    const r = readOpts(args, CHECKOUT_OPTS);
    if (r.odd) return { unknown: `git checkout ${r.odd}` };
    if (r.has('-p', '--patch', '--ours', '--theirs') || r.vals['--pathspec-from-file'] != null) return null;      // files
    if (r.has('--detach') || r.vals['--orphan'] != null) return { unknown: 'git checkout --detach/--orphan' };
    const made = r.vals['-b'] ?? r.vals['-B'];
    if (made != null) return !r.paths?.length && r.words.length <= 1 ? named(made, true, 'git checkout -b with a name the gate cannot read') : { unknown: 'git checkout -b' };
    if (r.has('-t', '--track')) return { unknown: 'git checkout --track' };
    if (r.paths?.length) return null;                                         // `checkout [<tree-ish>] -- <files>`
    if (r.words.length === 0) return null;                                    // a bare `git checkout` (or `git checkout --`)
    if (r.words.length === 1) return named(r.words[0], false, `git checkout ${r.words[0]}`);   // `<branch>` or `<branch> --`
    return r.paths ? { unknown: 'git checkout' } : null;                      // a tree-ish and files
  }
  if (sub === 'branch') {
    // a listing, a creation, a copy, a deletion: no change; a move, or an option not read to the end (git takes any
    // unambiguous shortening, `--mov`): asked; an upstream set: read by a push under push.default upstream
    const r = readOpts(args, BRANCH_OPTS);
    if (r.odd) return { unknown: `git branch ${r.odd}` };
    if (r.has('-m', '-M', '--move')) return { unknown: 'git branch -m' };
    return r.vals['-u'] != null || r.has('--set-upstream-to', '-t', '--track') ? { upstream: 'git branch -u' } : null;
  }
  // pull and fetch set the current branch's upstream with --set-upstream (or a shortening git accepts, `--set-up`)
  if ((sub === 'pull' || sub === 'fetch') && args.some((a) => { const f = a.split('=')[0]; return f.length >= 5 && '--set-upstream'.startsWith(f); })) return { upstream: `git ${sub} --set-upstream` };
  if (sub === 'symbolic-ref') return words(['-m']).length >= 2 && !args.some((a) => a === '-d' || a === '--delete') ? { unknown: 'git symbolic-ref' } : null;
  if (sub === 'bisect') return ['log', 'view', 'visualize', 'terms', undefined].includes(args[0]) ? null : { unknown: 'git bisect' };
  if (sub === 'stash' && args[0] === 'branch') return named(args[1], true, 'git stash branch');
  if (sub === 'rebase') { const w = words(['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec']); return w.length >= 2 ? named(w[1], false, 'git rebase <upstream> <branch>') : null; }
  if (!GIT_COMMANDS.has(sub)) return { unknown: `git ${sub} (a command the gate does not know: an alias may switch the branch)` };
  return null;
}
/** A git command's subcommand and its words, after git's own options. */
function gitWords(c) {
  const t = c.tokens; let k = 1;
  while (k < t.length && t[k].startsWith('-')) { if (VALUE_FLAGS.git.includes(t[k])) k++; k++; }
  return { sub: t[k], args: t.slice(k + 1) };
}
// the subcommands git and gh know; another word may be an alias (`git co`, `gh co`) or an extension
const GIT_COMMANDS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout '
  + 'checkout-index cherry cherry-pick clean clone commit commit-graph commit-tree config count-objects credential describe diff diff-files diff-index diff-tree '
  + 'difftool fetch fetch-pack for-each-ref for-each-repo format-patch fsck gc grep hash-object help init interpret-trailers lfs log ls-files ls-remote ls-tree '
  + 'maintenance merge merge-base merge-file merge-tree mergetool mktag mktree mv name-rev notes prune pull push range-diff read-tree rebase reflog remote repack '
  + 'replace request-pull rerere reset restore rev-list rev-parse revert rm shortlog show show-branch show-ref sparse-checkout stash status submodule switch '
  + 'symbolic-ref tag update-index update-ref var verify-commit verify-pack verify-tag version whatchanged worktree write-tree '
  + 'stage pack-refs hook replay refs diagnose bugreport column stripspace send-email fast-export fast-import filter-branch').split(' '));
const BRANCH_OPTS = { flags: ['--list', '--all', '--remotes', '--verbose', '--quiet', '--ignore-case', '--omit-empty', '--show-current', '--format', '--sort', '--contains',
  '--no-contains', '--merged', '--no-merged', '--points-at', '--column', '--no-column', '--color', '--no-color', '--abbrev', '--no-abbrev', '--force', '--track', '--no-track',
  '--create-reflog', '--recurse-submodules', '--copy', '--delete', '--unset-upstream', '--edit-description', '--move', '--set-upstream-to'],
values: [], letters: 'larviqftcCdDmM', valueLetters: 'u' };
const GH_COMMANDS = new Set(('alias api attestation auth browse cache codespace completion config extension gist gpg-key help issue label org pr project release '
  + 'repo ruleset run search secret ssh-key status variable workflow').split(' '));
const SWITCH_OPTS = { flags: ['--quiet', '--force', '--discard-changes', '--merge', '--progress', '--no-progress', '--guess', '--no-guess', '--ignore-other-worktrees',
  '--recurse-submodules', '--no-recurse-submodules', '--detach', '--track', '--no-track'], values: ['--create', '--force-create', '--orphan', '--conflict'], letters: 'qfmdt', valueLetters: 'cC' };
const CHECKOUT_OPTS = { flags: ['--quiet', '--force', '--merge', '--progress', '--no-progress', '--guess', '--no-guess', '--ignore-skip-worktree-bits', '--ignore-other-worktrees',
  '--overwrite-ignore', '--no-overwrite-ignore', '--recurse-submodules', '--no-recurse-submodules', '--overlay', '--no-overlay', '--patch', '--ours', '--theirs',
  '--detach', '--track', '--no-track', '--pathspec-file-nul'], values: ['--orphan', '--conflict', '--pathspec-from-file'], letters: 'qfmplt', valueLetters: 'bB' };
/**
 * One reading of a subcommand's options to the end: long options (a value after `=` or as the next word), clusters of
 * one-letter options (a value letter takes the rest of the word, `-Bmain`, or the next one), the words, and what
 * follows `--` (`paths`: null without `--`). `odd`: the first option the table does not know.
 */
function readOpts(args, { flags, values, letters, valueLetters }) {
  const r = { opts: new Set(), vals: {}, words: [], paths: null, odd: null };
  for (let j = 0; j < args.length; j++) {
    const a = args[j];
    if (r.paths) { r.paths.push(a); continue; }
    if (a === '--') { r.paths = []; continue; }
    if (a === '-' || !a.startsWith('-')) { r.words.push(a); continue; }
    if (a.startsWith('--')) {
      const [f, v] = a.split(/=(.*)/s);
      if (values.includes(f)) r.vals[f] = v ?? args[++j] ?? '';
      else if (flags.includes(f)) r.opts.add(f);
      else r.odd ??= f;
      continue;
    }
    for (let i = 1; i < a.length; i++) {
      if (valueLetters.includes(a[i])) { r.vals[`-${a[i]}`] = a.slice(i + 1) || args[++j] || ''; break; }
      if (letters.includes(a[i])) { r.opts.add(`-${a[i]}`); continue; }
      r.odd ??= a; break;
    }
  }
  r.has = (...names) => names.some((n) => r.opts.has(n));
  return r;
}
/**
 * The branches a push that goes through the current branch may send (#584): the folder's branch AND every branch a
 * switch in the same call names. Nothing is ever removed from that set. → { names } | { ask }
 */
function currentBranches(c, head, ctx, at) {
  const sw = c.switchesBefore || [];
  const unknown = sw.find((s) => s.unknown);
  if (unknown) return { ask: `git push of the current branch after ${unknown.unknown} in the same call (which branch it sends cannot be read)` };
  for (const s of sw.filter((x) => x.branch && !x.made)) {
    // a tag or a commit by that name (not a local branch): the switch detaches HEAD, which the gate does not read
    if (!ctx.git?.(at, ['rev-parse', '--verify', '--quiet', `refs/heads/${s.branch}`]) && ctx.git?.(at, ['rev-parse', '--verify', '--quiet', `${s.branch}^{commit}`]))
      return { ask: `git push of the current branch after a checkout of ${s.branch}, which is not a local branch` };
  }
  if (!head) return { ask: 'git push with an unknown current branch' };
  return { names: [...new Set([head, ...sw.map((s) => s.branch).filter(Boolean)])] };
}
/** #548: what a deny says when a Codex call's folder was not told to the hook, with the form that names it. */
export const UNREAD_MARK = 'in a folder Codex did not name';
export function unreadWhere(form = 'cd /abs/path && …') {
  return `${UNREAD_MARK}: repository not read (name it: ${form})`;
}
/**
 * Where a git push sends (#552): the remote's PUSH address (`remote get-url --push`, which also applies the
 * repository's rewrite rules), or the address the call itself gives the remote. A call can tell the remote
 * another way: a setting for this one call (`-c remote.<r>.url|pushurl=…`, `-c url.…`), GIT_CONFIG_* variables,
 * `--config-env`, an earlier `git remote add|set-url|rename|remove` or `git config remote.…|url.…` in the same
 * call, or `--repo=…`. A literal address there is used; anything else is asked.
 * → { url, remote } | { ask }
 */
export function pushAddress(c, input = {}, ctx = {}) {
  const pos = positionals(c).slice(1);
  const urlLike = (s) => /[:/]/.test(String(s));
  const dynamic = (s) => /[$`*?]/.test(String(s));          // a variable, a substitution or a glob: not readable
  const at = input.repoCwd || input.cwd;
  const repoFlag = flagValues(c.tokens, '--repo')[0];   // `--repo=X` (a spaced value parses as the positional)
  if ((pos[0] != null && dynamic(pos[0])) || (repoFlag != null && dynamic(repoFlag))) return { ask: 'git push to a repository the gate cannot read (a variable or a substitution)' };
  // git takes a repository word over --repo (builtin/push.c: `repo = argv[0]`); both, and different: asked, and the
  // row's chips follow the --repo address, the one an agent meant
  if (repoFlag && pos[0] && pos[0] !== repoFlag) {
    const named = urlLike(repoFlag) ? repoFlag : ctx.git?.(at, ['remote', 'get-url', '--push', repoFlag]) || repoFlag;
    return { ask: `git push with both --repo=${repoFlag} and the repository ${pos[0]}`, url: named, urls: [named] };
  }
  const word = pos[0] || repoFlag || null;
  const line = String(Array.isArray(input.command) ? input.command.join(' ') : input.command ?? ctx.line ?? '');
  // settings for this one call that change where a push goes
  const oneCall = flagValues(c.tokens, '-c');
  const remoteOf = (r) => oneCall.map((v) => /^remote\.(.+)\.(url|pushurl)=(.*)$/i.exec(v)).filter((m) => m && m[1] === r);
  for (const v of oneCall) {
    if (/^remote\.(.+)\.(url|pushurl)=/i.test(v)) continue;          // read below, for the remote it names
    if (/^(url|remote|push)\./i.test(v) || /^branch\..+\.(pushremote|remote)=/i.test(v)) return { ask: `git push with ${v.split('=')[0]} set for the call (it can change where the push goes)` };
  }
  if (c.tokens.some((t) => t === '--config-env' || t.startsWith('--config-env='))) return { ask: 'git push with --config-env (a setting for the call the gate cannot read)' };
  if (/(^|[^A-Za-z0-9_])GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)=/.test(line)) return { ask: 'git push with git settings in GIT_CONFIG_* variables (they can change where the push goes)' };
  // which remote: the word, else the one git picks for the current branch (branch.<b>.pushRemote, remote.pushDefault,
  // branch.<b>.remote, origin: remote.c pushremote_for_branch)
  let remote = word;
  if (!remote) {
    const branch = ctx.git?.(at, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const conf = (k) => ctx.git?.(at, ['config', '--get', k]) || null;
    remote = (branch && branch !== 'HEAD' && conf(`branch.${branch}.pushRemote`)) || conf('remote.pushDefault') || (branch && branch !== 'HEAD' && conf(`branch.${branch}.remote`)) || 'origin';
    if (dynamic(remote)) return { ask: 'git push to a remote the gate cannot read' };
  }
  // other commands of the same call that change a remote, the branch's remote or which branch is current
  let literal = null; let literalKeepsPush = false;
  for (const m of remoteOf(remote)) if (m[2].toLowerCase() === 'pushurl' || literal == null) literal = m[3];
  let others = []; try { others = parseCommand(line).cmds; } catch { /* the push's own words still decide */ }
  for (const o of others) {
    if (o.bin !== 'git') continue;
    const p = positionals(o);
    if (p[0] === 'remote' && ['add', 'set-url', 'rename', 'remove', 'rm'].includes(p[1])) {
      const args = p.slice(2);
      const plain = (p[1] === 'add' || p[1] === 'set-url') && args.length === 2 && args[0] === remote && !o.tokens.some((t) => ['--add', '--delete', '-t', '-m', '--mirror'].includes(t) || t.startsWith('--mirror='));
      if (plain && !dynamic(args[1])) { literal = args[1]; literalKeepsPush = p[1] === 'set-url' && !o.tokens.includes('--push'); continue; }
      if (args.includes(remote) || p[1] === 'rename') return { ask: `git push to a remote the same call changes (git remote ${p[1]})` };
    }
    if (p[0] === 'config' && p.slice(1).some((t) => /^(remote|url|push)\./i.test(t) || /^branch\..+\.(pushremote|remote)$/i.test(t))) return { ask: 'git push in a call whose git config changes a remote, a rewrite rule or where a branch pushes' };
    if (!word && ((p[0] === 'branch' && o.tokens.some((t) => t === '-u' || t.startsWith('--set-upstream-to'))) || p[0] === 'checkout' || p[0] === 'switch'))
      return { ask: `git push with no repository named, after git ${p[0]} in the same call (the remote it uses may change)` };
  }
  // every push address of the remote: git sends to each of them
  const pushUrls = (r) => String(ctx.git?.(at, ['remote', 'get-url', '--push', '--all', r]) || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if (literal != null) {
    if (!literal || dynamic(literal)) return { ask: 'git push to an address the gate cannot read' };
    // `git remote set-url <r> <addr>` changes the fetch address; a push address already set still receives the push
    const urls = [literal, ...(literalKeepsPush ? pushUrls(remote).filter((u) => u !== literal) : [])];
    return { url: literal, urls, remote };
  }
  if (urlLike(remote)) return { url: remote, urls: [remote], remote };
  const urls = pushUrls(remote);
  return { url: urls[0] || remote, urls: urls.length ? urls : [remote], remote };
}
/** The slug a push address list is about for the row: the first one on a list, else the first. */
export function pushSlug(addr, lists = {}) {
  const slugs = (addr?.urls || (addr?.url ? [addr.url] : [])).map(repoSlug).filter(Boolean);
  const listed = (sl) => ['publicRemotes', 'deployOnPush'].some((n) => (lists[n] || []).some((g) => globMatch(String(g).toLowerCase(), sl.toLowerCase())));
  return slugs.find(listed) ?? slugs[0] ?? null;
}
export function repoSlug(url) {
  const m = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? m[1] : null;
}

function rmOutside(c, input, ctx) {
  // the working tree is the git repo the command runs in; outside any repo there is none, so only the
  // caller's own scratch space is free (a cwd that isn't a repo — e.g. the home folder — is not "inside")
  const root = ctx.repoRoot ? ctx.repoRoot(input.cwd) : input.cwd;
  const what = c.bin === 'find' ? 'find -delete/-exec' : 'rm -r';
  // find: only its start folders are paths (everything from the first expression on is a pattern); none = "."
  const targets = c.bin === 'find' ? findRoots(c) : positionals(c);
  for (const raw of targets) {
    // "$W" / "${W}" where W was assigned a literal earlier in this same command
    const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
    const t = v && ctx.vars && ctx.vars[v[1]] != null ? ctx.vars[v[1]] : raw;
    if (/[$`*?]/.test(t) || t.startsWith('~')) return `${what} on ${raw} (not a fixed path inside the repo)`;
    if (input.cwdUnread && !t.startsWith('/')) return `${what} on ${raw} ${unreadWhere()}`;
    if (input.cwdUnknown && !t.startsWith('/')) return `${what} on ${raw} after a cd the gate cannot resolve`;
    const abs = absPath(t, input.cwd, ctx);
    if (isScratch(abs, ctx)) continue;                       // the caller's own temp/scratch tree
    if (!root) return `${what} outside any git working tree: ${raw}`;
    if (abs === root || !abs.startsWith(root + path.sep)) {
      // `find . -name x -delete` from the repo root is ordinary cleanup — but only with a filter
      // (`find . -delete` alone would empty the whole tree, like `rm -r .`)
      if (c.bin === 'find' && abs === root && c.tokens.some((x) => ['-name', '-iname', '-path', '-ipath', '-regex', '-type', '-newer', '-mtime', '-mmin', '-size'].includes(x))) continue;
      return `${what} outside the repo: ${raw}`;
    }
  }
  return null;
}
function findRoots(c) {
  const roots = [];
  for (const t of c.tokens.slice(1)) { if (/^[-(!]/.test(t)) break; roots.push(t); }
  return roots.length ? roots : ['.'];
}

/** An agent's own scratch space: /tmp/claude-*, /private/tmp/claude-*, $TMPDIR/claude-* (never the root itself). */
export function isScratch(abs, ctx = {}) {
  const tmp = String(ctx.tmpdir ?? process.env.TMPDIR ?? '').replace(/\/+$/, '');
  const roots = [/^\/(private\/)?tmp\/claude-[^/]+\/.+/];
  if (tmp) roots.push(new RegExp(`^${jsEsc(tmp)}/claude-[^/]+/.+`));
  return roots.some((re) => re.test(abs));
}

export function expandPath(g, ctx = {}) {
  return String(g).replace(/^~(?=\/|$)/, ctx.home || process.env.HOME || '~').replace(/^<(repo|live)>(?=\/|$)/, (m) => ctx.boardRoot || m);
}
function absPath(p, cwd, ctx = {}) {
  const e = expandPath(String(p), ctx);
  // macOS has a second name for every place on the data volume: /System/Volumes/Data/<path> is <path>
  return path.resolve(cwd || '/', e).replace(/^\/System\/Volumes\/Data(?=\/)/i, '');
}
/**
 * Does a guarded path cover `abs`? A `<repo>/…` path means the board's repo in ALL its checkouts: the
 * live one and every git worktree of it (#436: a policy file edited in a worktree skipped the self class).
 * git is only asked when the path already looks like the guarded one outside the live checkout.
 */
export function rootedMatch(g, abs, ctx = {}, opts = nocaseOf(ctx)) {
  // where the disk ignores letter case, another spelling of a guarded path is the same file
  if (globMatch(expandPath(g, ctx), abs, opts)) return true;
  const s = String(g);
  if (!s.startsWith('<repo>/') || !ctx.boardRoot || !ctx.git) return false;
  const rel = s.slice('<repo>'.length);
  const lit = rel.split('*')[0];
  if (!(opts.nocase ? abs.toLowerCase().includes(lit.toLowerCase()) : abs.includes(lit))) return false;
  ctx.worktrees ??= String(ctx.git(ctx.boardRoot, ['worktree', 'list', '--porcelain']) || '').split('\n')
    .filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length));
  return ctx.worktrees.some((root) => globMatch(root + rel, abs, opts));
}
/** A shell pattern (`*`, `?`, `[…]`, none crossing a slash) against one path. */
function shellGlob(pattern, s, { nocase = false } = {}) {
  let re = '';
  for (let k = 0; k < pattern.length; k++) {
    const ch = pattern[k];
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') { const end = pattern.indexOf(']', k + 2); if (end < 0) { re += '\\['; continue; } re += `[${pattern.slice(k + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`; k = end; }
    else re += jsEsc(ch);
  }
  try { return new RegExp(`^${re}$`, nocase ? 'i' : '').test(s); } catch { return true; }
}
/** `a.{b,c}` → `a.b`, `a.c` (the first group, then again; capped). */
function braces(t, depth = 0) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(t);
  if (!m || depth > 4) return [t];
  return m[1].split(',').slice(0, 16).flatMap((alt) => braces(t.slice(0, m.index) + alt + t.slice(m.index + m[0].length), depth + 1));
}
export function globMatch(glob, s, { nocase = false } = {}) {
  if (nocase) { glob = String(glob).toLowerCase(); s = String(s).toLowerCase(); }
  if (String(glob).endsWith('/**') && String(s) === String(glob).slice(0, -3)) return true;   // dir/** covers dir itself
  const re = '^' + String(glob).split('**').map((part) => part.split('*').map(jsEsc).join('[^/]*')).join('.*') + '$';
  return new RegExp(re).test(String(s));
}
/** A rule's program name against a call's: the call's is in lower case where the disk ignores case, so the rule's is read that way too. */
const sameBin = (bin, ruleBin, ctx) => bin === ruleBin || (nocaseOf(ctx).nocase && String(bin).toLowerCase() === String(ruleBin).toLowerCase());
/** Do file names differ by letter case alone here? macOS and Windows volumes ignore case by default (ctx.ignoreCase overrides). */
const nocaseOf = (ctx) => ({ nocase: ctx?.ignoreCase ?? (process.platform === 'darwin' || process.platform === 'win32') });
const samePath = (a, b, ctx) => (nocaseOf(ctx).nocase ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const startsPath = (a, prefix, ctx) => (nocaseOf(ctx).nocase ? String(a).toLowerCase().startsWith(String(prefix).toLowerCase()) : String(a).startsWith(prefix));

/** Sessions the board itself starts without a workspace (triage, dispatched fix sessions…) resolve as `headless:<role>`. */
export const HEADLESS_ROLES = ['triage', 'digest', 'dispatch'];
export const headlessName = (role, policy) => {
  const r = String(role || '').toLowerCase();
  const known = Array.isArray(policy?.headlessRoles) ? policy.headlessRoles : HEADLESS_ROLES;
  return /^[a-z][a-z0-9-]{0,30}$/.test(r) && known.includes(r) ? `headless:${r}` : null;
};
export const isHeadless = (agent) => String(agent || '').startsWith('headless:');
const isUnregistered = (agent) => String(agent || '').startsWith('unregistered:');

/**
 * Is this session enforced (vs observed)?
 *
 * defaultMode 'observe' (the shipped default, and what an absent key means) is opt-in:
 *   a registered agent      enforceFor has '*' or its name
 *   an unregistered session only when enforceFor names 'unregistered'
 *   a headless board run    only when enforceFor names it (`headless:triage`); '*' does not cover it
 *
 * defaultMode 'enforce' turns it around: EVERY session is enforced — registered or not, headless
 * or not, newly registered included — except the names in observeFor ('unregistered' there covers
 * every session with no identity). enforceFor is then not consulted.
 */
export function isEnforced(policy, agent, { registered = !isUnregistered(agent) } = {}) {
  if (policy?.defaultMode === 'enforce') {
    const observe = Array.isArray(policy.observeFor) ? policy.observeFor : [];
    if (!registered || isUnregistered(agent)) return !observe.includes('unregistered');
    return !observe.includes(agent);
  }
  const list = policy?.enforceFor || ['*'];
  if (!registered) return list.includes('unregistered');
  if (isHeadless(agent)) return list.includes(agent);
  return list.includes('*') || list.includes(agent);
}

/**
 * Would the enforce-by-default setting have held this call, where today's setting only observes it?
 * (The reading taken before the flip: one line per such call.)
 */
export function wouldEnforce(policy, agent, opts = {}) {
  if (isEnforced(policy, agent, opts)) return false;
  return isEnforced({ ...policy, defaultMode: 'enforce', observeFor: Array.isArray(policy?.observeFor) ? policy.observeFor : [] }, agent, opts);
}

// ── fingerprints ────────────────────────────────────────────────────────────
const sha = (s) => createHash('sha256').update(s).digest('hex');
export const HASH_VERSION = 'gate-v2';     // v2 binds non-shell tool input; v1 grants can never match

/** JSON with object keys sorted at every level (strings as-is), so equal inputs hash equally. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Binds the exact call: engine, folder, tool, and — for a shell — the command text; for any
 * other tool its whole input (an MCP call's arguments, an edit's file + old/new text).
 */
export function cmdHash({ engine = 'claude', cwd = '', tool = 'Bash', command = '', filePath = '', toolInput = null }) {
  const what = tool === 'Bash' || toolInput == null ? String(command).trim() : canonicalJson(toolInput);
  return sha([HASH_VERSION, engine, cwd, tool, what, filePath].join('\u0000'));
}

/**
 * The script files a shell command runs, each with the folder it runs in: [{ path, cwd }] (path as written).
 * `unread: true` (ctx.baseUnread, #548): a relative path in a folder nobody told the hook; which file it is is not known.
 */
export function scriptsRun(command, cwd, ctx = {}) {
  let parsed; try { parsed = parseCommand(command); } catch { return []; }
  const out = [];
  const entry = (p, c) => { const w = commandCwd(c, cwd, ctx); return { path: p, cwd: w.cwd, ...(w.unread && !/^(\/|~(\/|$))/.test(p) ? { unread: true } : {}) }; };
  parsed.cmds.forEach((c, k) => {
    for (const v of stdinScriptRuns(c, parsed.cmds[k - 1])) if (!/[$`*?]/.test(v.viaStdin)) out.push(entry(v.viaStdin, c));
  });
  for (const c of parsed.cmds) {
    if (!c.bin || !isScript(c) || ['npx', 'uv', 'pnpm', 'npm'].includes(c.bin)) continue;
    const sp = scriptPath(c);
    if (sp && !/[$`*?]/.test(sp)) out.push(entry(sp, c));
  }
  return out;
}

/** What the owner sees for a non-shell call: the tool and its input, readable. */
export function describeToolCall(tool, input = {}) {
  const i = input || {};
  if (/^(Edit|MultiEdit)$/.test(tool)) {
    const edits = tool === 'MultiEdit' ? i.edits || [] : [{ old_string: i.old_string, new_string: i.new_string }];
    return [`${tool} ${i.file_path || ''}${i.replace_all ? ' (replace all)' : ''}`,
      ...edits.flatMap((e) => [`--- old`, String(e.old_string ?? ''), `+++ new`, String(e.new_string ?? '')])].join('\n');
  }
  if (tool === 'Write') return `Write ${i.file_path || ''} (${String(i.content ?? '').length} chars)\n${String(i.content ?? '')}`;
  if (tool === 'NotebookEdit') return `NotebookEdit ${i.notebook_path || ''} ${i.cell_id || ''} (${i.edit_mode || 'replace'})\n${String(i.new_source ?? '')}`;
  return `${tool} ${JSON.stringify(i, null, 1)}`;
}
/** The dry form of a write command: the same tokens without the rule's write flags. */
export function dryTokens(c, r) {
  const drop = new Set(r.flagsAny || []);
  return c.tokens.filter((t) => !drop.has(t.split('=')[0]));
}
export function dryHash(cwd, tokens) { return sha(['dry', cwd, ...tokens].join('\u0001')); }
export const shellQuote = (t) => (/^[A-Za-z0-9_./:=@%+,-]+$/.test(t) ? t : `'${String(t).replace(/'/g, `'\\''`)}'`);

/** The shipped default policy: the hook's fallback when policy.json is unreadable. */
export const DEFAULT_POLICY = {
  version: 1, mode: 'enforce', enforceFor: ['*'],
  defaults: { ttlMinutes: 120, approver: 'owner', requireDryRun: false },   // 120: an approval survives a long agent turn (#343 item 7)
  // 1.3 checks, each off | observe | enforce. observe: the call passes and the reading says "would hold".
  checks: { inlineBodies: 'observe', renamedBins: 'observe', selfProtect: 'observe' },
  classes: [
    { id: 'merge', label: 'Merge a pull request', standing: true, rules: [{ bin: 'gh', args: ['pr', 'merge'] }] },
    { id: 'push', label: 'Push to a protected branch or public remote, force-push, push tags or delete a ref',
      rules: [{ bin: 'git', args: ['push'], when: 'pushProtected', protectedRefs: ['main', 'master'], allowRefs: ['checkpoint/*'] }] },
    { id: 'deploy', label: 'Deploy to production, or touch a paid/outbound job',
      rules: [{ bin: 'vercel', notArgs: [['env', 'ls'], ['ls'], ['whoami'], ['logs'], ['inspect'], ['list']] },
        { bin: 'launchctl', argsAny: ['bootstrap', 'bootout', 'load', 'unload', 'enable', 'disable', 'kickstart'], labels: '@paidOrOutbound' },
        { bin: 'shopify', argsAny: ['deploy', 'push', 'publish'] }] },
    { id: 'deploy-local', label: 'Load or unload a service on this machine', standing: true,
      rules: [{ bin: 'launchctl', argsAny: ['bootstrap', 'bootout', 'load', 'unload', 'enable', 'disable'], unlessLabels: '@paidOrOutbound' }] },
    // #435 (deferred from #346): an agent on a release install runs the one-click upgrade or a rollback
    // as a gated action; the check form changes nothing. Not standing: a program go never covers it.
    { id: 'upgrade', label: 'Upgrade or roll back this install',
      rules: [{ bin: 'zulu', args: ['upgrade'], unlessFlags: ['--check'] }, { bin: 'zulu', args: ['rollback'] },
        { scriptIn: ['**/upgrade.mjs'], unlessFlags: ['--check'] },
        { scriptIn: ['**/install.sh'], args: ['upgrade'], unlessFlags: ['--check'] }, { scriptIn: ['**/install.sh'], args: ['rollback'] }] },
    { id: 'env', label: 'Change production configuration or secrets',
      rules: [{ bin: 'gh', args: ['secret'], argsAny: ['set', 'delete'] }, { bin: 'gh', args: ['variable'], argsAny: ['set', 'delete'] }] },
    { id: 'guarded', label: 'Run a script on the guarded list (it writes without a flag)',
      rules: [{ scriptIn: '@guardedScripts', unlessFlags: '@dryFlags' }] },
    { id: 'write', label: "A guarded script's write form", requireDryRun: true,
      rules: [{ script: true, flagsAny: ['--commit', '--apply', '--write', '--execute', '--confirm', '--activate', '--live', '--send', '--go'] }] },
    { id: 'outbound', label: 'Send a message or post outside the system',
      rules: [{ bin: 'curl', method: 'POST', urlAny: ['slack.com/api/chat.', 'slack.com/api/files.', 'api.twilio.com', 'a.klaviyo.com/api/campaign-send'] },
        { tool: '^mcp__.*__(send_message|reply|forward)$' }] },
    { id: 'store', label: 'Write to the store through an MCP tool',
      rules: [{ tool: '^mcp__.*Shopify__(graphql_mutation|create-.*|update-.*|set-inventory|bulk-.*|add-to-collection|publish-.*|upload-.*)$' }] },
    { id: 'delete', label: 'Delete outside the working tree, drop data, delete repos',
      rules: [{ bin: 'rm', flagsAny: ['-r', '-R', '--recursive'], when: 'outsideRepo' },
        // find that deletes or runs something on what it finds is a delete too (it names files by pattern)
        { bin: 'find', flagsAny: ['-delete', '-exec', '-execdir', '-ok', '-okdir'], when: 'outsideRepo' },
        { sql: '\\b(drop|truncate)\\s+(table|schema|database)\\b' }, { bin: 'gh', args: ['repo', 'delete'] },
        // removes ignored files too: in a checkout that keeps its state in an ignored folder, that is the state
        { bin: 'git', args: ['clean'], flagsAny: ['-x', '-X'], unlessFlags: ['-n', '--dry-run'], check: 'selfProtect' }] },
    { id: 'schedule', label: 'Change scheduled jobs',
      rules: [{ bin: 'crontab', unlessFlags: ['-l'] }, { pathWrite: '~/Library/LaunchAgents/**' }] },
    { id: 'self', label: 'Change or read the gate itself',
      rules: [{ pathAny: ['@guardSecrets'] }, { pathWrite: '@guardConfig' }, { textAny: ['gate_decide', 'x-mesh-decision'] },
        // the owner's CLI decision (task.sh gate N gK approve) — an agent running it would approve its own gate
        { scriptIn: ['**/task.sh'], args: ['gate'] }, { scriptIn: ['**/mesh-cli.mjs'], args: ['task', 'gate'] },
        // the owner's signed form (the ledger and mesh CLIs with the signed flag attach the decision token):
        // an agent running it would speak, and revoke, as the owner. The owner's own typed lines are never
        // held — hooks fire only on model tool calls.
        // (one script per rule: a rule's scriptIn names one glob or one @list)
        { scriptIn: ['**/task.sh'], flagsAny: ['--signed'] }, { scriptIn: ['**/agent-send.sh'], flagsAny: ['--signed'] },
        { scriptIn: ['**/mesh-cli.mjs'], flagsAny: ['--signed'] },
        // the Guardrails-only installer: it sets the profile, writes the default mode into the rules file,
        // restarts the board and installs the hook. The dry run changes nothing and is free.
        { scriptIn: ['**/install.sh'], flagsAny: ['--guardrails'], unlessFlags: ['--dry-run'] },
        { scriptIn: ['**/install.sh'], args: ['guardrails'], unlessFlags: ['--dry-run'] },
        // the wrapper in bin/ runs the installer with the same words from anywhere
        { bin: 'zulu', flagsAny: ['--guardrails'], unlessFlags: ['--dry-run'] },
        { bin: 'zulu', args: ['guardrails'], unlessFlags: ['--dry-run'] },
        // 1.3 self-protection (check `selfProtect`): writes to the files the gate rests on, git that can change
        // them in the live checkout or move what "landed" means, and stopping the board
        { pathGuard: ['@gateCode', '@guardGate'], check: 'selfProtect' },
        { bin: 'git', args: ['config'], mentions: ['core.', 'alias.', '--global', '--system', '--file', '-f', '--edit', '-e', 'remote.', 'url.', 'branch.', 'include', 'filter.', 'diff.', 'merge.', 'pager.', 'credential.', 'http.', 'protocol.', 'submodule.', 'gpg.', 'sequence.', 'interactive.', 'uploadpack.', 'receive.', 'fetch.', 'pull.', 'init.', 'safe.', 'extensions.'], when: 'gitConfigWrite', check: 'selfProtect' },
        { bin: 'git', mentions: ['core.hookspath=', 'alias.'], when: 'gitDashC', check: 'selfProtect' },
        { bin: 'git', argsAny: ['update-ref', 'symbolic-ref', 'fetch', 'push'], mentions: ['refs/remotes/', 'refs/heads/main', 'refs/heads/master', 'refs/heads/origin/', 'refs/tags/origin/', 'refs/replace/'], when: 'gitRefWrite', check: 'selfProtect' },
        { bin: 'git', args: ['remote'], argsAny: ['set-url', 'add', 'rename', 'remove', 'rm', 'set-head', 'set-branches'], check: 'selfProtect' },
        { bin: 'git', argsAny: ['pull', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am', 'checkout', 'switch', 'reset', 'stash', 'restore', 'branch', 'rm', 'mv', 'read-tree', 'bisect', 'fetch', 'tag', 'update-ref', 'symbolic-ref', 'update-index', 'checkout-index', 'clean', 'submodule', 'replace'], when: 'liveCheckout', check: 'selfProtect' },
        { bin: 'kill', when: 'boardProcess', check: 'selfProtect' }, { bin: 'pkill', when: 'boardProcess', check: 'selfProtect' },
        { bin: 'killall', when: 'boardProcess', check: 'selfProtect' }, { bin: 'xargs', argsAny: ['kill'], when: 'boardProcess', check: 'selfProtect' },
        { bin: 'launchctl', argsAny: ['kill', 'stop', 'remove', 'reboot'], when: 'boardProcess', check: 'selfProtect' },
        { bin: 'fuser', when: 'boardProcess', check: 'selfProtect' }, { bin: 'kill-port', when: 'boardProcess', check: 'selfProtect' },
        { bin: 'reboot', when: 'boardProcess', check: 'selfProtect' }, { bin: 'shutdown', when: 'boardProcess', check: 'selfProtect' },
        { bin: 'halt', when: 'boardProcess', check: 'selfProtect' }, { bin: 'poweroff', when: 'boardProcess', check: 'selfProtect' },
        { bin: 'osascript', mentions: ['restart', 'shut down', 'shutdown', 'log out', 'logout'], when: 'boardProcess', check: 'selfProtect' }] },
  ],
  lists: {
    paidOrOutbound: [], publicRemotes: [], deployOnPush: [],
    guardedScripts: [],                       // scripts that write without any flag: gated on every run
    dryFlags: ['--dry-run', '-n', '--check', '--plan'],   // …except these runs, which change nothing
    guardSecrets: ['<repo>/data/guardrails/**', '<repo>/data/mesh-decision-token'],
    guardConfig: ['<repo>/overlay/policy.json', '<repo>/policy.json', '<repo>/examples/policy.json', '~/.claude/settings.json', '~/.codex/hooks.json'],
    // <live>/… is the board's own checkout only, never a git worktree of it: work happens in a worktree and
    // reaches the live checkout through a held merge.
    // gateCode: the hook, the classifier and service, the page that shows the row (also what the integrity card compares)
    gateCode: ['<live>/scripts/gate-hook.sh', '<live>/scripts/gate-hook.mjs', '<live>/scripts/gate-triggers.default', '<live>/scripts/guardrails-install.sh',
      '<live>/scripts/merge-hooks.mjs', '<live>/scripts/env.sh', '<live>/src/gates.mjs', '<live>/src/gate-service.mjs', '<live>/src/gate-ledger.mjs',
      '<live>/src/request-guard.mjs', '<live>/src/guard.mjs', '<live>/src/caller.mjs', '<live>/src/tasks.mjs', '<live>/src/config.mjs', '<live>/server.mjs',
      '<live>/public/**', '<live>/src/gate-integrity.mjs', '<live>/scripts/gate-config-hook.sh', '<live>/scripts/gate-config-hook.mjs'],
    // guardGate: identity, where the hook finds the board, the records, hook settings anywhere, shell and git start files, session maps
    guardGate: ['<live>/overlay/config/agents.json', '<live>/config/agents.json', '<live>/data/local.env', '<live>/data/tasks/**',
      '**/.claude/settings.json', '**/.claude/settings.local.json', '~/.claude.json', '~/.codex/config.toml', '**/.codex/hooks.json',
      '/Library/Application Support/ClaudeCode/**', '/etc/codex/**',
      '~/.zshrc', '~/.zshenv', '~/.zprofile', '~/.zlogin', '~/.bashrc', '~/.bash_profile', '~/.profile', '~/.gitconfig',
      '**/.git/hooks/**', '**/.git/config', '<live>/.git/HEAD', '<live>/.git/index', '<live>/.git/refs/**', '<live>/.git/packed-refs', '<live>/.git/info/**', '<live>/.gitattributes',
      '~/.config/cmux/**', '~/.cmuxterm/claude-hook-sessions.json', '~/.cmuxterm/codex-hook-sessions.json'],
  },
};

/**
 * The shipped rules this policy does not have (the guardrails card, #398). An upgrade never touches the
 * owner's policy file, so new classes and rules do not reach an older one. Compares class ids and rule
 * identity only: the owner's lists, added rules and added classes never count. → { count, classes: [ids] }
 */
export function shippedRulesMissing(policy, shipped = DEFAULT_POLICY) {
  const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
  const mine = new Map((Array.isArray(policy?.classes) ? policy.classes : []).map((c) => [c.id, new Set((c.rules || []).map(canon))]));
  let count = 0; const classes = [];
  for (const c of shipped.classes) {
    const have = mine.get(c.id);
    const gone = (c.rules || []).filter((r) => !have?.has(canon(r))).length;
    if (gone || !have) { count += gone; classes.push(c.id); }
  }
  return { count, classes };
}
