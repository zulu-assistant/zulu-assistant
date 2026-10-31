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
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'osascript', 'deno', 'bun', 'php', 'tsx', 'ts-node']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'exec', 'nice', 'timeout', 'caffeinate', 'builtin']);
const INDIRECT = new Set(['eval', 'source', '.', 'xargs', 'ssh', 'parallel', 'watch']);
const VALUE_FLAGS = { git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace'], gh: ['-R', '--repo'], sudo: ['-u', '-g'], nice: ['-n'], env: ['-u', '-S', '-C'] };
const SCRIPT_EXT = /\.(py|mjs|cjs|js|ts|sh|bash|zsh|rb|pl|php)$/;
const MAX_DEPTH = 6;
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
  return String(text ?? '').replace(/\\[nt]/g, ' ').replace(/["'\\`]/g, '');
}

/** ERE trigger lines for a policy: rule triggers + keyword triggers (condition B). */
export function triggerLines(policy) {
  const out = new Set();
  const word = (w) => `${B}${String(w).split(/\s+/).map(ereEsc).join(`${SP}+`)}${E}`;
  for (const c of policy?.classes || []) {
    for (const r of c.rules || []) {
      if (r.bin) {
        // E consumes the separator after a word, so later words start with an optional "…<sep>"
        let re = `${B}${ereEsc(r.bin)}${E}`;
        for (const a of r.args || []) re += `${NEXT}${ereEsc(a)}${E}`;
        if (r.argsAny?.length) re += `${NEXT}(${r.argsAny.map(ereEsc).join('|')})${E}`;
        if (r.flagsAny?.length) re += `(.*[[:space:]])?${flagsEre(r.flagsAny, true)}`;
        if (r.urlAny?.length) re += `.*(${r.urlAny.map(ereEsc).join('|')})`;
        out.add(re);
      } else if (r.flagsAny?.length) out.add(flagsEre(r.flagsAny));
      if (r.scriptIn) {
        // a listed script's name (plus its first argument when the rule names one)
        for (const g of listOr(r.scriptIn, policy)) {
          const base = path.basename(String(g));
          if (!base || base.includes('*')) continue;
          out.add(`${ereEsc(base)}${E}${r.args?.[0] ? `${NEXT}${ereEsc(r.args[0])}${E}` : ''}`);
        }
      }
      if (r.tool) out.add(`tool_name:${SP}*${toolEre(r.tool)}`);
      for (const p of r.pathAny || []) for (const f of pathFragments(p, policy)) out.add(ereEsc(f));
      if (r.pathWrite) for (const f of pathFragments(r.pathWrite, policy)) out.add(ereEsc(f));
      for (const t of r.textAny || []) out.add(ereEsc(t));
      if (r.sql) out.add(`(drop|truncate)${SP}+(table|schema|database)|delete${SP}+from`);
    }
  }
  for (const k of [...DEFAULT_KEYWORDS, ...(policy?.keywords || [])]) out.add(word(k));
  return [...out];
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
const toolEre = (re) => String(re).replace(/^\^/, '').replace(/\$$/, E);
/** Literal fragments of a path glob (longest literal run), with list refs expanded. */
function pathFragments(p, policy) {
  const items = String(p).startsWith('@') ? policy?.lists?.[String(p).slice(1)] || [] : [p];
  return items.map((g) => String(g).replace(/^<repo>\/|^~\//, '').split('*').sort((a, b) => b.length - a.length)[0]).filter((f) => f.length >= 6);
}
/** ERE → JS RegExp (only the constructs triggerLines emits). */
export function ereToJs(ere) {
  const src = ere.replace(/\[\[:space:\]\]/g, '\\s').replace(/\[\^\[:alnum:\]_\.-\]/g, '[^A-Za-z0-9_.-]')
    .replace(/\[\^\[:alnum:\]_-\]/g, '[^A-Za-z0-9_-]').replace(/\[\[:space:\]=\]/g, '[\\s=]')
    .replace(/\[\[:alnum:\]\]/g, '[A-Za-z0-9]');
  return new RegExp(src, 'i');
}
export function compileTriggers(policy) { return triggerLines(policy).map((ere) => ({ ere, re: ereToJs(ere) })); }
/** The text the fast path greps, rebuilt from a parsed hook input. */
export function triggerText({ tool, command, filePath }) {
  return normalizeForTriggers(`tool_name:${tool || ''} ${command || ''} ${filePath || ''}`);
}

// ── shell lexer/parser ──────────────────────────────────────────────────────
// Splits a command line into simple commands. $(…), backticks, <(…), bash -c strings
// and heredocs fed to a shell are parsed recursively (they execute). Heredocs fed to
// anything else are data; fed to an interpreter they are opaque when they hold a keyword.
export function parseCommand(src, depth = 0) {
  if (depth > MAX_DEPTH) return { cmds: [], data: [], opaque: ['nesting too deep'] };
  const cmds = []; const data = []; const opaque = [];
  let cur = newCmd(''); let tok = null; let i = 0; const s = String(src ?? '');
  const pendingDocs = [];
  const endTok = () => { if (tok != null) { cur.raw.push(tok); tok = null; } };
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
  const sub = (inner) => { const p = parseCommand(inner, depth + 1); subCmds.push(...p.cmds.map((c) => ({ ...c, fromSub: true }))); data.push(...p.data); opaque.push(...p.opaque); };
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
    if (ch === ' ' || ch === '\t') { endTok(); i++; continue; }
    if (ch === '#' && tok == null) { const nl = s.indexOf('\n', i); data.push(s.slice(i + 1, nl < 0 ? s.length : nl)); i = nl < 0 ? s.length : nl; continue; }
    if (ch === '\\') { if (s[i + 1] === '\n') { i += 2; continue; } tok = (tok ?? '') + (s[i + 1] ?? ''); i += 2; continue; }
    if (ch === "'") { const k = s.indexOf("'", i + 1); if (k < 0) { opaque.push('unterminated quote'); tok = (tok ?? '') + s.slice(i + 1); i = s.length; continue; } tok = (tok ?? '') + s.slice(i + 1, k); i = k + 1; continue; }
    if (ch === '"') {
      let j = i + 1; let buf = '';
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
        if (s[j] === '$' && s[j + 1] === '(') { const e = balanced('(', ')', j + 2); if (e < 0) { opaque.push('unbalanced $('); j = s.length; break; } sub(s.slice(j + 2, e - 1)); buf += s.slice(j, e); j = e; continue; }
        if (s[j] === '`') { const e = s.indexOf('`', j + 1); if (e < 0) { opaque.push('unbalanced `'); j = s.length; break; } sub(s.slice(j + 1, e)); buf += s.slice(j, e + 1); j = e + 1; continue; }
        buf += s[j]; j++;
      }
      if (j >= s.length) opaque.push('unterminated quote');
      tok = (tok ?? '') + buf; i = j + 1; continue;
    }
    if ((ch === '$' || ch === '<' || ch === '>') && s[i + 1] === '(') {
      if (ch !== '$' && tok != null) { /* a>(…) is unusual; treat like a substitution */ }
      const e = balanced('(', ')', i + 2); if (e < 0) { opaque.push('unbalanced ('); i = s.length; continue; }
      sub(s.slice(i + 2, e - 1)); tok = (tok ?? '') + s.slice(i, e); i = e; continue;
    }
    if (ch === '$' && s[i + 1] === '{') { const e = balanced('{', '}', i + 2); if (e < 0) { opaque.push('unbalanced ${'); i = s.length; continue; } tok = (tok ?? '') + s.slice(i, e); i = e; continue; }
    if (ch === '`') { const e = s.indexOf('`', i + 1); if (e < 0) { opaque.push('unbalanced `'); i = s.length; continue; } sub(s.slice(i + 1, e)); tok = (tok ?? '') + s.slice(i, e + 1); i = e + 1; continue; }
    if (ch === ';' || ch === '&' || ch === '|') {
      const two = s.slice(i, i + 2);
      if (ch === '&' && s[i + 1] === '>') { endTok(); i += s[i + 2] === '>' ? 3 : 2; cur.redirNext = true; continue; }
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
      i += s[i + 1] === '>' || s[i + 1] === '&' ? 2 : 1;
      if (s[i - 1] === '&') { while (/\d|-/.test(s[i] ?? '')) i++; continue; }   // 2>&1
      cur.redirNext = true; continue;
    }
    if (tok == null && cur.redirNext) { cur.redirNext = false; cur.redirTarget = true; }
    tok = (tok ?? '') + ch; i++;
    if (cur.redirTarget && (i >= s.length || /[\s;&|<>()]/.test(s[i]))) { cur.redirects.push(tok); tok = null; cur.redirTarget = false; }
    else if (cur.herestringNext && (i >= s.length || /[\s;&|<>()]/.test(s[i]))) { cur.herestrings.push(tok); tok = null; cur.herestringNext = false; }
  }
  endCmd('');
  if (pendingDocs.length) opaque.push(`unterminated heredoc ${pendingDocs[0].word}`);
  // second pass: words, heredoc bodies, shells with -c, indirect commands
  const out = [...subCmds];
  const vars = {};                                   // NAME=literal assigned in this command (no expansion inside)
  // the folder each simple command runs in: literal `cd` targets so far (subshells scoped); unknown after
  // a cd the gate can't resolve — path- and repo-dependent rules then decide conservatively
  let cd = { targets: [], unknown: false };
  const cdStack = [];
  for (const c of cmds) {
    for (let k = 0; k < (c.closes || 0); k++) if (cdStack.length) cd = cdStack.pop();
    for (let k = 0; k < (c.opens || 0); k++) cdStack.push({ targets: [...cd.targets], unknown: cd.unknown });
    for (const t of c.raw) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(t);
      if (!m) break;
      if (!/[$`]/.test(m[2])) vars[m[1]] = m[2]; else delete vars[m[1]];
    }
    const w = words(c.raw);
    const cmd = { tokens: w.tokens, bin: w.bin, assignOnly: !w.bin, redirects: c.redirects, sepBefore: c.sepBefore, fromSub: !!c.fromSub, dynamicBin: w.dynamic, text: c.raw.join(' '),
      cdTargets: [...cd.targets], cdUnknown: cd.unknown };
    out.push(cmd);
    if (cmd.bin === 'cd' || cmd.bin === 'pushd') {
      let t = cmd.tokens.slice(1).find((x) => !/^-[LPe@]+$/.test(x)) ?? '~';
      const v = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(t);
      if (v && vars[v[1]] != null) t = vars[v[1]];
      if (t === '-' || /[$`*?]/.test(t)) cd = { targets: cd.targets, unknown: true };
      else cd = { targets: [...cd.targets, t], unknown: cd.unknown };
    }
    for (const body of c.heredocs) {
      if (SHELLS.has(cmd.bin)) { const p = parseCommand(body, depth + 1); out.push(...p.cmds); data.push(...p.data); opaque.push(...p.opaque); }
      else if (INTERPRETERS.has(cmd.bin)) out.push({ tokens: [], bin: null, interpretedBody: body, by: cmd.bin, text: body });
      else data.push(body);
    }
    for (const h of c.herestrings) {
      if (SHELLS.has(cmd.bin)) { const p = parseCommand(h, depth + 1); out.push(...p.cmds); data.push(...p.data); opaque.push(...p.opaque); }
      else if (INTERPRETERS.has(cmd.bin)) out.push({ tokens: [], bin: null, interpretedBody: h, by: cmd.bin, text: h });
      else data.push(h);
    }
    if (SHELLS.has(cmd.bin)) {
      const ci = cmd.tokens.findIndex((t) => /^-[a-z]*c[a-z]*$/.test(t));
      if (ci > 0 && cmd.tokens[ci + 1] != null) { const p = parseCommand(cmd.tokens[ci + 1], depth + 1); out.push(...p.cmds); data.push(...p.data); opaque.push(...p.opaque); cmd.inlinedC = true; }
      else if (cmd.tokens.length === 1 || (cmd.tokens[1] || '').startsWith('-')) cmd.readsStdin = c.sepBefore === '|' || c.sepBefore === '|&';
    }
  }
  return { cmds: out, data, opaque, vars };
}
function newCmd(sep) { return { raw: [], redirects: [], heredocs: [], herestrings: [], sepBefore: sep, opens: sep === '(' ? 1 : 0, closes: sep === ')' ? 1 : 0 }; }
function skipDq(s, j) { while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; return j + 1; }

/** Strip assignments and wrappers; tokens[0] is then the program. */
function words(raw) {
  const t = [...raw]; let k = 0;
  for (;;) {
    while (k < t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[k])) k++;
    const b = path.basename(t[k] || '');
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
  return { tokens, bin: first == null ? null : dynamic ? null : path.basename(first), dynamic };
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
  const tool = input.tool || 'Bash';
  const triggers = ctx.triggers || compileTriggers(policy);
  const hits = triggers.filter((t) => t.re.test(triggerText(input)));
  if (!hits.length) return { verdict: 'clear', why: 'no trigger' };
  const classes = policy?.classes || [];
  const gate = (cls, rule, why, extra = {}) => ({
    verdict: 'gate', cls: cls.id, label: cls.label, rule, why,
    requireDryRun: !!(rule?.requireDryRun ?? cls.requireDryRun ?? policy?.defaults?.requireDryRun),
    ttlMinutes: Number(rule?.ttlMinutes ?? cls.ttlMinutes ?? policy?.defaults?.ttlMinutes ?? 120),
    approver: cls.approver || policy?.defaults?.approver || 'owner', ...extra,
  });
  const opaque = (why) => gate(OPAQUE, null, why);

  // non-shell tools: MCP names and file paths
  if (tool !== 'Bash') {
    for (const cls of classes) for (const r of cls.rules || []) {
      if (r.tool && new RegExp(r.tool).test(tool)) return gate(cls, r, `tool ${tool}`);
      if (input.filePath && (r.pathAny || (r.pathWrite && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)))) {
        const globs = [...(r.pathAny || []).flatMap((p) => listOr(p, policy)), ...(r.pathWrite ? listOr(r.pathWrite, policy) : [])];
        if (globs.some((g) => globMatch(expandPath(g, ctx), absPath(input.filePath, input.cwd, ctx)))) return gate(cls, r, `${tool} ${input.filePath}`);
      }
    }
    return { verdict: 'clear', why: 'tool not gated' };
  }

  let parsed;
  try { parsed = parseCommand(input.command); } catch (e) { return opaque(`unparseable: ${e.message}`); }
  const norm = normalizeForTriggers(input.command);
  const keyword = keywordHit(norm, policy);
  if (parsed.opaque.length && keyword) return opaque(parsed.opaque[0]);

  const runnable = parsed.cmds.filter((c) => !c.assignOnly || c.interpretedBody);
  for (const c of runnable) {
    if (c.interpretedBody != null) {
      if (keywordHit(normalizeForTriggers(c.interpretedBody), policy) || hits.some((h) => h.re.test(normalizeForTriggers(c.interpretedBody)))) return opaque(`${c.by} program from a heredoc mentions a gated action`);
      continue;
    }
    if (c.dynamicBin && keyword) return opaque(`variable or expansion in command position: ${c.tokens[0]}`);
    if (INDIRECT.has(c.bin) && keyword) return opaque(`${c.bin} runs a command the gate cannot read`);
    if (c.bin === 'find' && keyword && c.tokens.some((t) => ['-exec', '-execdir', '-ok', '-okdir'].includes(t))) return opaque('find -exec runs a command the gate cannot read');
    if (c.readsStdin && keyword) return opaque(`${c.bin} reads commands from a pipe`);
  }
  const rctx = { ...ctx, vars: parsed.vars || {} };
  for (const c of runnable) {
    if (!c.bin) continue;
    // judge each command in the folder it actually runs in: `cd X && …`, `git -C X …`
    const where = commandCwd(c, input.cwd, ctx);
    c.cwd = where.cwd;
    const cin = { ...input, cwd: where.cwd, cwdUnknown: where.unknown };
    for (const cls of classes) for (const r of cls.rules || []) {
      const why = ruleMatch(r, c, cin, policy, rctx);
      if (why) return gate(cls, r, why, { cmd: c, dryTokens: cls.requireDryRun || r.requireDryRun ? dryTokens(c, r) : null });
    }
  }
  // invariant: every trigger hit must be explained by recognised commands or data
  const explained = [
    `tool_name:${tool}`,
    ...runnable.filter((c) => c.bin || c.dynamicBin).map((c) => normalizeForTriggers(c.tokens.join(' ') + ' ' + c.redirects.join(' '))),
    ...parsed.data.map(normalizeForTriggers),
  ].join('\n');
  const unexplained = hits.filter((h) => !h.re.test(explained));
  if (unexplained.length) return opaque(`a gated pattern the parser could not attribute (${unexplained[0].ere.slice(0, 60)})`);
  return { verdict: 'clear', why: 'recognised, not gated', scripts: runnable.filter((c) => isScript(c)).map((c) => c) };
}

/** The folder a simple command runs in: the hook's cwd, then each literal `cd`, then `git -C`. */
export function commandCwd(c, base, ctx = {}) {
  let cwd = base || '/';
  for (const t of c.cdTargets || []) cwd = absPath(t, cwd, ctx);
  if (c.bin === 'git') {
    const toks = c.tokens;
    for (let k = 1; k < toks.length; k++) {
      if (toks[k] === '-C' && toks[k + 1] != null) {
        if (/[$`*?]/.test(toks[k + 1])) return { cwd, unknown: true };
        cwd = absPath(toks[k + 1], cwd, ctx); k++;
      } else if (!toks[k].startsWith('-')) break;      // global options end at the subcommand
    }
  }
  return { cwd, unknown: !!c.cdUnknown };
}

function keywordHit(norm, policy) {
  return [...DEFAULT_KEYWORDS, ...(policy?.keywords || [])].some((k) => new RegExp(`(^|[^A-Za-z0-9_.-])${String(k).split(/\s+/).map(jsEsc).join('\\s+')}([^A-Za-z0-9_-]|$)`, 'i').test(norm))
    || /(^|[^A-Za-z0-9_-])--(commit|apply|execute|write|confirm|activate|live|send|go)([^A-Za-z0-9_-]|$)/.test(norm);
}
const jsEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listOr = (p, policy) => (String(p).startsWith('@') ? policy?.lists?.[String(p).slice(1)] || [] : [p]);

export function isScript(c) {
  if (!c.bin) return false;
  if (INTERPRETERS.has(c.bin) || SHELLS.has(c.bin)) return positionals(c).some((p) => SCRIPT_EXT.test(p) || p.includes('/'));
  if (c.bin === 'npx' || c.bin === 'uv' || c.bin === 'pnpm' || c.bin === 'npm') return c.tokens.length > 1;
  return c.tokens[0].includes('/') || SCRIPT_EXT.test(c.tokens[0]);
}
/** The script a command runs (its path token), for dry-run bookkeeping. */
export function scriptPath(c) {
  if (INTERPRETERS.has(c.bin) || SHELLS.has(c.bin)) return positionals(c).find((p) => SCRIPT_EXT.test(p) || p.includes('/')) || null;
  return c.tokens[0];
}

// usage/help never changes anything: `gh pr merge --help` is not a merge (bin rules only — never scripts)
const HELP_BINS = new Set(['gh', 'git', 'vercel', 'launchctl', 'shopify', 'crontab']);
const HELP_FLAGS = new Set(['--help', '-h', '--version', 'help']);

function ruleMatch(r, c, input, policy, ctx) {
  if (r.scriptIn) {
    // a script on a named list (e.g. @guardedScripts): gated on every run, whatever its flags
    if (!isScript(c)) return null;
    const sp = scriptPath(c);
    const abs = sp ? absPath(sp, input.cwd, ctx) : null;
    if (!abs || !listOr(r.scriptIn, policy).some((g) => globMatch(expandPath(g, ctx), abs) || globMatch(g, path.basename(abs)))) return null;
  } else if (r.script) {
    if (!isScript(c)) return null;
  } else if (r.bin) {
    if (c.bin !== r.bin) return null;
    if (HELP_BINS.has(c.bin) && c.tokens.slice(1).some((t) => HELP_FLAGS.has(t) && t !== 'help')) return null;
    if (HELP_BINS.has(c.bin) && positionals(c)[0] === 'help') return null;
  } else if (r.sql) {
    const sqlBins = ['psql', 'sqlite3', 'mysql', 'supabase', 'duckdb'];
    if (!(sqlBins.includes(c.bin) || /sql/i.test(path.basename(scriptPath(c) || '')))) return null;
    return new RegExp(r.sql, 'i').test(c.tokens.join(' ')) ? `SQL: ${c.tokens.join(' ').match(new RegExp(r.sql, 'i'))[0]}` : null;
  } else if (!r.pathAny && !r.pathWrite && !r.textAny) return null;

  // for a script rule, args are the script's own arguments (after `node x.mjs` / `bash x.sh`)
  let pos = positionals(c);
  if (r.scriptIn && (INTERPRETERS.has(c.bin) || SHELLS.has(c.bin))) pos = pos.slice(pos.indexOf(scriptPath(c)) + 1);
  if (r.args && !r.args.every((a, k) => pos[k] === a)) return null;
  if (r.argsAny && !r.argsAny.some((a) => pos.includes(a) || c.tokens.includes(a))) return null;
  if (r.notArgs && r.notArgs.some((pre) => pre.every((a, k) => pos[k] === a))) return null;
  if (r.flagsAny && !r.flagsAny.some((f) => hasFlag(c, f))) return null;
  if (r.unlessFlags && (Array.isArray(r.unlessFlags) ? r.unlessFlags : listOr(r.unlessFlags, policy)).some((f) => hasFlag(c, f))) return null;
  if (r.method === 'POST' && !isPost(c)) return null;
  if (r.urlAny && !c.tokens.some((t) => r.urlAny.some((u) => t.includes(u)))) return null;
  if (r.labels && !labelsOf(pos).some((l) => listOr(r.labels, policy).includes(l))) return null;
  if (r.unlessLabels && labelsOf(pos).some((l) => listOr(r.unlessLabels, policy).includes(l))) return null;
  // textAny (e.g. gate_decide): only commands that can send it somewhere — never readers such as grep/cat/sed
  if (r.textAny && (!TEXT_SENDERS.has(c.bin) || !r.textAny.some((t) => c.tokens.join(' ').includes(t)))) return null;
  if (r.pathAny || r.pathWrite) {
    const globs = [...(r.pathAny || []).flatMap((p) => listOr(p, policy)), ...(r.pathWrite ? listOr(r.pathWrite, policy) : [])];
    // pathAny: any mention (read or write). pathWrite: a redirect target, or an argument of a non-reader.
    // folder unknown (after an unresolvable cd): a relative path whose name matches a guarded name counts
    const sameName = (t, g) => !t.startsWith('/') && !t.startsWith('~') && path.basename(t) === path.basename(String(g)) && !String(g).endsWith('*');
    const matches = (t) => !t.startsWith('-') && globs.some((g) => globMatch(expandPath(g, ctx), absPath(t, input.cwd, ctx)) || (input.cwdUnknown && sameName(t, g)));
    const hit = c.redirects.find(matches) || ((r.pathAny || !isReader(c)) ? c.tokens.slice(1).find(matches) : null);
    if (!hit) return null;
    return `${c.bin} touches ${hit}`;
  }
  if (r.when === 'pushProtected') return pushProtected(r, c, input, policy, ctx);
  if (r.when === 'outsideRepo') return rmOutside(c, input, ctx);
  if (r.flagsAny) return `${r.flagsAny.find((f) => hasFlag(c, f))} on ${scriptPath(c) || c.bin}`;
  if (r.scriptIn) return `runs ${scriptPath(c)}${r.args || r.argsAny ? ` ${pos.slice(1, 3).join(' ')}` : ''}`;
  return `${c.bin} ${pos.slice(0, 2).join(' ')}`.trim();
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
  if (input.cwdUnknown) return 'git push from a folder the gate cannot resolve';
  const pos = positionals(c).slice(1);               // after "push"
  const flags = flagSet(c);
  const forced = ['--force', '-f', '--force-with-lease', '--force-if-includes', '--mirror', '--delete', '-d', '--tags', '--all', '--prune'].find((f) => flags.has(f))
    || c.tokens.find((t) => /^--force-with-lease=/.test(t) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) && !t.startsWith('--'));
  const remote = pos[0] || 'origin';
  const url = ctx.git?.(input.cwd, ['remote', 'get-url', remote]) || remote;
  const slug = repoSlug(url);
  const lists = (n) => listOr(`@${n}`, policy);
  if (slug && lists('publicRemotes').some((g) => globMatch(g.toLowerCase(), slug.toLowerCase()))) return `push to public remote ${slug}`;
  if (slug && lists('deployOnPush').some((g) => globMatch(g.toLowerCase(), slug.toLowerCase()))) return `push to ${slug}, which deploys on push`;
  if (forced) return `git push ${forced}`;
  const allow = r.allowRefs || [];
  const prot = r.protectedRefs || ['main', 'master'];
  let specs = pos.slice(1);
  if (!specs.length || specs.includes('HEAD')) {
    const head = ctx.git?.(input.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!head) return 'git push with an unknown current branch';
    specs = specs.length ? specs.map((s) => (s === 'HEAD' ? head : s)) : [head];
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
  return String(g).replace(/^~(?=\/|$)/, ctx.home || process.env.HOME || '~').replace(/^<repo>(?=\/|$)/, ctx.boardRoot || '<repo>');
}
function absPath(p, cwd, ctx = {}) {
  const e = expandPath(String(p), ctx);
  return path.resolve(cwd || '/', e);
}
export function globMatch(glob, s) {
  if (String(glob).endsWith('/**') && String(s) === String(glob).slice(0, -3)) return true;   // dir/** covers dir itself
  const re = '^' + String(glob).split('**').map((part) => part.split('*').map(jsEsc).join('[^/]*')).join('.*') + '$';
  return new RegExp(re).test(String(s));
}

/**
 * Is this agent enforced (vs observed)? '*' = every REGISTERED agent; sessions with no
 * mesh identity are enforced only when the list names 'unregistered' explicitly.
 */
export function isEnforced(policy, agent, { registered = true } = {}) {
  const list = policy?.enforceFor || ['*'];
  if (!registered) return list.includes('unregistered');
  return list.includes('*') || list.includes(agent);
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
        { sql: '\\b(drop|truncate)\\s+(table|schema|database)\\b' }, { bin: 'gh', args: ['repo', 'delete'] }] },
    { id: 'schedule', label: 'Change scheduled jobs',
      rules: [{ bin: 'crontab', unlessFlags: ['-l'] }, { pathWrite: '~/Library/LaunchAgents/**' }] },
    { id: 'self', label: 'Change or read the gate itself',
      rules: [{ pathAny: ['@guardSecrets'] }, { pathWrite: '@guardConfig' }, { textAny: ['gate_decide', 'x-mesh-decision'] },
        // the owner's CLI decision (task.sh gate N gK approve) — an agent running it would approve its own gate
        { scriptIn: ['**/task.sh'], args: ['gate'] }, { scriptIn: ['**/mesh-cli.mjs'], args: ['task', 'gate'] }] },
  ],
  lists: {
    paidOrOutbound: [], publicRemotes: [], deployOnPush: [],
    guardedScripts: [],                       // scripts that write without any flag: gated on every run
    dryFlags: ['--dry-run', '-n', '--check', '--plan'],   // …except these runs, which change nothing
    guardSecrets: ['<repo>/data/guardrails/**', '<repo>/data/mesh-decision-token'],
    guardConfig: ['<repo>/overlay/policy.json', '<repo>/policy.json', '<repo>/examples/policy.json', '~/.claude/settings.json', '~/.codex/hooks.json'],
  },
};
