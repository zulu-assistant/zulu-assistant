// Guardrails gate service (board side). The hook (scripts/gate-hook.mjs) sends each
// tool call that hit a trigger here; the board re-classifies it with ITS policy, files
// or finds the gate on the ledger, redeems single-use grants, and answers
// pass | allow | deny. docs/GUARDRAILS.md.
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { classify, parseCommand, commandCwd, shippedRulesMissing, isEnforced, wouldEnforce, headlessName, isHeadless, compileTriggers, triggerLines, cmdHash, describeToolCall, dryHash, scriptPath, shellQuote, repoSlug, globMatch, positionals, pushAddress, pushSlug, isShellTool, UNREAD_MARK, scriptsRun, HASH_VERSION, DEFAULT_POLICY, OPAQUE, CHECKS, CHECK_MODES } from './gates.mjs';
import { hookIdentity } from './caller.mjs';
import { createGateStore, auditRows, focusOf } from './gate-ledger.mjs';
import { containsSecret, LIVE_STATUSES, activeProgramGo } from './tasks.mjs';
import { createReceiptChain, chainMode } from './receipt-chain.mjs';
import { rowContext, agentWords } from './row-context.mjs';
import { SETTINGS } from './config.mjs';
import { labelPrefix } from './upgrade.mjs';

// Which repo does a PR landing act on? gh takes it from a pull request URL, the repo flag, GH_REPO and
// GH_HOST, with its own precedence. The board does not model that precedence: it COLLECTS every repo
// the command names and accepts the answer only when they all agree.
//   one distinct readable owner/name on github.com → that repo
//   more than one, a name it cannot read, another host, or a GH_HOST assignment → unknown (ask the owner)
//   nothing named → undefined (the caller uses the checkout's origin)
const SLUG = /^[\w.-]+\/[\w.-]+$/;
/**
 * Under a program go a landing runs by itself only when the gh call is the WHOLE command: the board can
 * then be sure nothing earlier in the same text changed which repo gh resolves (a variable set without
 * the literal assignment, a remote added, the resolved key rewritten). Allowed around the call: a leading
 * `cd <literal folder> &&`, and a readable `GH_REPO=<name>` prefix or `env GH_REPO=<name>` on the call
 * itself (namedRepos collects it). Anything else in the text, or any other mention of GH_REPO or
 * GH_HOST, asks the owner. Over-asking is fine: a quoted argument with a `;` in it asks too.
 */
const WORD = String.raw`(?:[\w./~@%+:,=-]+|"[^"$\`\\]*"|'[^']*')`;
// spaces and tabs only between words: a newline is a second command
const ALONE = new RegExp(String.raw`^(?:cd[ \t]+${WORD}[ \t]*&&[ \t]*)?(?:env[ \t]+)?((?:GH_REPO=[\w./:@-]+[ \t]+)*)gh((?:[ \t]+${WORD})*)$`);
export function landingAlone(command = '') {
  const m = ALONE.exec(String(command).trim());
  if (!m) return false;
  return !/GH_REPO|GH_HOST/.test(m[2]);                 // the only mentions allowed are the readable prefix assignments
}
export const NOT_ALONE = 'the landing is not the whole command (something else runs in the same text, or GH_REPO or GH_HOST is mentioned outside a plain GH_REPO=<owner/name> prefix)';
export const ALONE_HINT = 'A program go runs a landing by itself only when it is the whole command: run the gh call as its own command (a leading "cd <folder> &&" is fine).';

/** One named value → 'owner/name', or null when it cannot be read as a github.com repo. */
export function readRepoName(value) {
  let v = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (!v || /[$`*?\\\s]/.test(v)) return null;
  const url = /^(?:https?:\/\/|git@|ssh:\/\/git@)([^/:]+)[/:](.+)$/i.exec(v);
  let host = null;
  if (url) { host = url[1]; v = url[2]; }
  v = v.replace(/\.git$/i, '').replace(/\/+$/, '');
  const parts = v.split('/');
  if (!url && parts.length === 3) { host = parts[0]; v = parts.slice(1).join('/'); }
  if (host && !/^(www\.)?github\.com$/i.test(host)) return null;
  return SLUG.test(v) ? v : null;
}
// gh's own flags for `pr merge` (gh 2.102). The walk below reads the words the way gh does: a flag that
// takes a value takes the NEXT word whatever it looks like (`-t -Racme/app` is a subject, not a repo), and
// in a group of short flags the first letter that takes a value takes the rest of the group
// (`-tRacme/app` is the subject "Racme/app"). Read-only checks on the real gh:
//   gh pr list --search --repo=<other> …   answers for THIS repo: the repo flag was the search text
//   gh pr list -L -R<other>                invalid argument "-R<other>" for "-L, --limit"
//   gh pr list -LR<other>                  invalid argument "R<other>" for "-L, --limit"
// A flag this list does not know, or `--`, makes the target unknown: a new gh flag fails toward asking.
const LAND_VALUE_LONG = new Set(['--author-email', '--body', '--body-file', '--subject', '--match-head-commit']);
const LAND_BOOL_LONG = new Set(['--admin', '--auto', '--delete-branch', '--disable-auto', '--merge', '--rebase', '--squash']);
const LAND_VALUE_SHORT = 'AbFt';
const LAND_BOOL_SHORT = 'dmrs';
/**
 * Every repo a landing command names. → { names: [distinct], unknown: bool, any: bool, admin: bool }
 * A pull request address counts only where gh reads it: as the one positional after `pr merge`.
 */
export function namedRepos(tokens = [], command = '') {
  const names = new Set(); let unknown = false; let any = false; let admin = false;
  const add = (v) => { any = true; const n = readRepoName(v); if (n) names.add(n.toLowerCase()); else unknown = true; };
  const lost = () => { any = true; unknown = true; };
  const toks = tokens.slice(1);
  const pos = [];
  for (let i = 0; i < toks.length; i++) {
    const t = String(toks[i]);
    if (t === '--' || t === '-') { lost(); break; }
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t : t.slice(0, eq);
      const attached = eq < 0 ? undefined : t.slice(eq + 1);
      if (name === '--repo') { if (attached !== undefined) add(attached); else { add(toks[i + 1]); i += 1; } }
      else if (LAND_VALUE_LONG.has(name)) { if (attached === undefined) i += 1; }         // the next word is its value, whatever it looks like
      else if (LAND_BOOL_LONG.has(name)) { if (name === '--admin') admin = true; }
      else lost();
      continue;
    }
    if (t.startsWith('-')) {
      const letters = t.slice(1);
      for (let k = 0; k < letters.length; k++) {
        const c = letters[k];
        const rest = letters.slice(k + 1);
        if (c === 'R') { if (rest) add(rest.replace(/^=/, '')); else { add(toks[i + 1]); i += 1; } break; }
        if (LAND_VALUE_SHORT.includes(c)) { if (!rest) i += 1; break; }                   // the rest of the group, or the next word, is its value
        if (!LAND_BOOL_SHORT.includes(c)) { lost(); break; }
      }
      continue;
    }
    pos.push(t);
  }
  // positionals: `pr`, `merge`, then at most one selector (a number, a branch, or an address)
  if (pos[0] !== 'pr' || pos[1] !== 'merge' || pos.length > 3) lost();
  else if (pos.length === 3) {
    const sel = pos[2];
    const m = /^(?:https?:\/\/)?((?:www\.)?[\w.-]+\.[a-z]{2,})\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/pull\/\d+(?:[/?#].*)?$/i.exec(sel);
    if (m) add(`${m[1]}/${m[2]}/${m[3]}`);
    else if (/:\/\/|\/pull\/\d+/.test(sel)) lost();                                        // address-shaped, not one this can read
  }
  // assignments anywhere in the text, comments and later commands included: the board cannot tell which
  // one reaches the gh call, so each one counts as a name
  for (const m of String(command).matchAll(/(?:^|[^\w])GH_REPO=("[^"]*"|'[^']*'|[^\s;&|)]*)/g)) add(m[1]);
  if (/(?:^|[^\w])GH_HOST=/.test(String(command))) lost();
  return { names: [...names], unknown, any, admin };
}

/** The startup reconcile's receipt note: the board can't tell "died before the allow" from "after". */
export const RESTART_NOTE = 'recorded after restart; outcome unknown';

const MODES = ['enforce', 'observe', 'off'];
const WHENS = ['pushProtected', 'outsideRepo', 'gitConfigWrite', 'gitRefWrite', 'liveCheckout', 'boardProcess', 'gitDashC'];

/** Validate a policy object; returns a list of problems (empty = ok). */
export function policyProblems(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['policy is not an object'];
  if (p.version !== 1) out.push('version must be 1');
  if (p.mode && !MODES.includes(p.mode)) out.push(`mode must be ${MODES.join('|')}`);
  if (!Array.isArray(p.classes) || !p.classes.length) out.push('classes must be a non-empty list');
  if (p.checks != null) {
    if (typeof p.checks !== 'object' || Array.isArray(p.checks)) out.push('checks must be an object');
    else for (const [k, v] of Object.entries(p.checks)) {
      if (!CHECKS.includes(k)) out.push(`checks: "${k}" is not a known check (${CHECKS.join(', ')})`);
      else if (!CHECK_MODES.includes(v)) out.push(`checks.${k} must be ${CHECK_MODES.join('|')}`);
    }
  }
  const ids = new Set();
  for (const c of p.classes || []) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(c.id || '')) out.push(`class id "${c.id}" must be a short slug`);
    if (ids.has(c.id)) out.push(`class id "${c.id}" is listed twice`); ids.add(c.id);
    if (!Array.isArray(c.rules) || !c.rules.length) out.push(`class ${c.id}: rules must be a non-empty list`);
    for (const r of c.rules || []) {
      if (!(r.bin || r.script || r.scriptIn || r.tool || r.sql || r.pathAny || r.pathWrite || r.pathGuard || r.textAny)) out.push(`class ${c.id}: a rule needs bin, script, scriptIn, tool, sql, pathAny, pathWrite, pathGuard or textAny`);
      if (r.check && !CHECKS.includes(r.check)) out.push(`class ${c.id}: rule check "${r.check}" is not a known check`);
      if (r.when && !WHENS.includes(r.when)) out.push(`class ${c.id}: when "${r.when}" is not known`);
      for (const k of ['tool', 'sql']) if (r[k]) { try { new RegExp(r[k]); } catch { out.push(`class ${c.id}: ${k} is not a valid regex`); } }
      // every @list a rule names must exist
      for (const v of [r.labels, r.unlessLabels, r.pathWrite, r.scriptIn, r.unlessFlags, ...(r.pathAny || []), ...[].concat(r.pathGuard || [])]) {
        if (typeof v === 'string' && v.startsWith('@') && !Array.isArray(p.lists?.[v.slice(1)])) out.push(`class ${c.id}: list ${v} is not defined`);
      }
    }
  }
  return out;
}

const LATE = Symbol('the caller lookup did not answer in time');

/** The gate decision text an agent sees (one line, no secrets). */
// `noWake`: a session the board cannot type into (not registered in the mesh: started outside cmux,
// a headless run, every session of a Guardrails-only install). Nobody wakes it after the decision,
// so the text tells it to run the same command again. A registered agent's text is unchanged.
export const cannotWake = (agent) => /^(unregistered|headless):/.test(String(agent || ''));
export const denyText = {
  pending: (t, g, { noWake = false } = {}) => `GATE: ${g.label} — not run. Waiting on the owner, task #${t} (gate ${g.id})${g.previously ? `; it was approved before (${String(g.previously.at).slice(11, 16)}Z, ${g.previously.gate}) but expired unused, so the owner is asked again` : ''}. ${noWake
    ? `This session cannot be woken: run the same command again after the owner approves (an approval lasts ${Number(g.ttlMinutes) || 120} minutes). Do not change it or work around it.`
    : "You'll be woken when they decide; do not retry it or work around it."}`,
  waiting: (t, g, { noWake = false } = {}) => (noWake
    ? `GATE: still waiting on the owner — task #${t} gate ${g.id}. Not approved yet: run the same command again once the owner has approved. Do not change it or work around it.`
    : `GATE: still waiting on the owner — task #${t} gate ${g.id}. Do not retry; you'll be woken.`),
  disputed: (t, g) => `GATE: not run. The approval for task #${t} gate ${g} is not in the board's receipt chain, so the grant was refused and the owner has been told. Run the same command again to ask afresh.`,
  declined: (t, g) => `GATE: declined by the owner ${String(g.decided_at || '').slice(0, 16).replace('T', ' ')}Z${g.reason ? ` (${g.reason})` : ''}. Do not retry; ask on task #${t}.`,
  dry: (t, cmd) => `GATE: run the dry form first, in this task (#${t}): ${cmd} — then try the write form again.`,
  focus: (n) => `GATE: you have ${n} live tasks and no focus, so this gate would land on the wrong one. Set it first: task.sh focus <N> — then retry.`,
  down: () => 'GATE: board unreachable — gated command not run (fail closed). Retry when the board is up.',
  // #548: nothing filed. A row the owner could approve here would be bound to nothing (no commit, no PR head, no script)
  restate: (why) => `GATE: not run and not filed — ${why}. Codex does not tell the gate which folder a command runs in, so this call cannot be read. Run it again with the folder or repo in the command itself (git -C /abs/path …, cd /abs/path && …, gh … --repo owner/name, an absolute script path); that call is read and, if it needs the owner, asked as usual.`,
};

export function createGateService({ root, ledger, policyFile, identifyWs, headlessWs = () => null, mcName = async () => 'mission-control', isPrivateRepo = ghIsPrivate, prInfo = ghPrInfo, recordEvent = async () => {}, afterTaskChange = async () => {}, ownerId = 'owner', home = os.homedir(), git = defaultGit, now = () => Date.now(), stateDir, board, receiptChain = 'on' }) {
  const store = createGateStore(stateDir || path.join(root, 'data', 'guardrails'));
  // Hash-chained receipts (src/receipt-chain.mjs): one line per gate change, learned from the ledger's
  // own writes; a grant runs only when the chain holds its approval. A ledger that cannot tell us
  // about its writes (a test double) means no chain.
  const chain = createReceiptChain({ file: path.join(store.dir, 'receipts.jsonl'), now, mode: typeof ledger.subscribe === 'function' ? chainMode(receiptChain) : 'off' });
  let chainLoaded = null;
  const chainReady = () => (chainLoaded ??= ledger.list().then((ts) => chain.load(ts)).catch((e) => { console.error(`[guardrails] receipt chain: ${e.message}`); }));
  if (chain.mode !== 'off') ledger.subscribe(async (task, write) => { await chainReady(); await chain.record(task, write); });
  let chainCheck = null; let chainCheckAt = 0;
  const CHAIN_CHECK_MS = 6 * 3600e3;
  // what "the board" is, for the rules that protect it: this process, its port and its launchd label
  const boardInfo = board || { pids: [process.pid], port: Number(SETTINGS?.port) || null, label: `${labelPrefix(root)}.master-console`, cmdline: [process.execPath, ...process.argv.slice(1)].join(' ') };
  const trigOpts = { boardRoot: root, home };
  let policy = null; let policyMtime = 0; let policyError = null; let triggersFor = null;

  async function loadPolicy() {
    const file = typeof policyFile === 'function' ? policyFile() : policyFile;
    const st = await stat(file).catch(() => null);
    if (!st) {
      if (!policy) { policy = DEFAULT_POLICY; policyError = 'policy file missing — using the shipped default'; policyMtime = 'default'; await syncTriggers(); }
      return policy;
    }
    const key = `${file}@${st.mtimeMs}`;
    if (key === policyMtime && policy) return policy;
    policyMtime = key;
    try {
      const p = JSON.parse(await readFile(file, 'utf8'));
      const probs = policyProblems(p);
      if (probs.length) throw new Error(probs.join('; '));
      policy = p; policyError = null;
    } catch (e) {
      policyError = `policy invalid (${e.message}) — ${policy ? 'keeping the last good policy' : 'using the shipped default'}`;
      policy = policy || DEFAULT_POLICY;
      recordEvent('bad', `guardrails: ${policyError}`).catch(() => {});
    }
    await syncTriggers();
    return policy;
  }
  /** The lines of the generated triggers file: what the policy generates, plus the watched scripts' names. */
  const triggerFileLines = (watched) => [...triggerLines(policy, trigOpts), ...watched.map((w) => path.basename(w).replace(/[.[\]()*+?{}|^$\\]/g, '\\$&'))];
  /**
   * Is the generated triggers file still what the policy generates? The hook's fast path greps that
   * file before anything else: a line taken out of it lets a whole kind of call pass without the
   * board ever being asked. The board is the file's only writer, so a difference means it was
   * changed outside the board. It is put right at once, and the caller is told.
   * → { ok: true } | { ok: false, rewritten: true, missing }
   */
  async function verifyTriggers() {
    await loadPolicy();
    const want = `${triggerFileLines(await store.watched()).join('\n')}\n`;
    const have = await store.readTriggers();
    if (have === want) return { ok: true };
    triggersFor = null;
    await syncTriggers();
    return { ok: false, rewritten: true, missing: have === null };
  }
  async function syncTriggers() {
    const watched = await store.watched();
    const key = JSON.stringify([policyMtime, watched]);
    if (key === triggersFor) return;
    await store.writeTriggers(triggerFileLines(watched));
    triggersFor = key;
    // the server classifies with the same lines the hook greps (watched scripts included)
    compiled = [...compileTriggers(policy, trigOpts), ...watched.map((w) => ({ ere: path.basename(w), re: new RegExp(path.basename(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }))];
  }
  let compiled = null;
  const ctxFor = (cwd) => ({
    home, boardRoot: root, board: boardInfo, triggers: compiled || compileTriggers(policy, trigOpts),
    repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']),   // null outside a repo: no working tree there
    git,
  });
  const redact = (s) => (containsSecret(s) ? null : s);
  // #548: cwd null (a Codex call whose folder was not told): gh would read the PR of whatever folder it runs in, so
  // only a PR whose repo the command names is read
  const readPr = (cmd, cwd) => (!cwd && !namesPrRepo(cmd) ? Promise.resolve(null) : Promise.resolve(prInfo(cmd, cwd || root)).catch(() => null));
  // One rule (#551, MC's second read of PR 147): every held Codex shell call whose folder is unread is refused, unless it
  // is a gh call that names its repository. Then the folder on a Codex row is always where the call runs.
  async function unreadRefusal(r, input, command, cwd) {
    if (!input.folderUnread) return null;
    const marked = String(r.why || '').includes(UNREAD_MARK);
    let cmds = []; try { cmds = parseCommand(command).cmds; } catch { /* unreadable: judged by the reason */ }
    const unread = marked || (r.cmd ? !!r.cmd.folderUnread : cmds.some((c) => c.bin && commandCwd(c, cwd, { home, baseUnread: true }).unread))
      || scriptsRun(command, cwd, { home, baseUnread: true }).some((s) => s.unread);
    if (!unread) return null;
    if (r.cmd?.bin === 'gh' && !marked && namesGhRepo(r.cmd)) {
      // a landing is filed only when its PR was read: the row the owner approves shows the PR it lands (#552)
      if (r.cls !== 'merge') return null;
      r.prRead = await readPr(r.cmd, null);              // kept for the row below: one read
      if (r.prRead?.headOid) return null;
      return 'gh pr merge whose pull request could not be read (name it: --repo owner/name, or its github.com URL)';
    }
    if (marked) return r.why;
    if (r.cmd?.bin === 'gh') return `${r.label.toLowerCase()} with no repo named (name it: --repo owner/name)`;
    return `${r.label.toLowerCase()}, in a folder Codex did not name (name it: cd /abs/path && …, git -C /abs/path …, or an absolute script path)`;
  }
  /** The folder a held command's repository is read from: none when a Codex call's folder was not told to the hook (#548). */
  // …and none when a folder change in the call may not have applied (#551): which repository it acts on is not known
  const folderOf = (r, cwd) => (r.cmd?.folderUnread || r.cmd?.folderUnsure ? null : r.cmd?.repoCwd || r.cmd?.cwd || cwd);

  async function liveTasksOf(agent) { return (await ledger.list({ owner: agent, status: 'live' })) || []; }
  async function findByHash(agent, hash) {
    for (const t of await ledger.list({ status: 'live' })) {
      const gs = (t.gates || []).filter((g) => g.cmdHash === hash && g.agent === agent);
      if (gs.length) return { t, g: gs[gs.length - 1] };
    }
    return null;
  }
  async function resolveTask(agent, label, short) {
    const focus = focusOf(await store.focus(), agent)?.task;
    const live = await liveTasksOf(agent);
    if (focus && live.some((t) => t.id === focus)) return { id: focus };
    // Mission Control acts across owners: its focus counts on any live task (the focus endpoint allows it too).
    if (focus && agent === await mcName()) {
      const t = await ledger.get(focus);
      if (t && LIVE_STATUSES.includes(t.status)) return { id: focus };
    }
    if (live.length === 1) return { id: live[0].id };
    if (live.length > 1) return { needsFocus: live.length };
    // zero live tasks: a new one for this gate (owner = the agent; unregistered or headless → mission control)
    const owner = agent.startsWith('unregistered:') || agent.startsWith('headless:') ? await mcName() : agent;
    const t = await ledger.create({ title: `GATE: ${label} — ${short}`.slice(0, 200), requester: 'board', owner, priority: 'normal' });
    return { id: t.id, created: true };
  }

  /**
   * Who is asking? A registered workspace first; else a headless run the board itself started
   * (the launcher exports the role, the hook passes it on); else unregistered:<folder>.
   */
  async function whoIs(input, policy, cwd) {
    const byWs = input.workspaceId ? await identifyWs(input.workspaceId) : null;
    return byWs || headlessName(input.identity, policy) || `unregistered:${path.basename(cwd)}`;
  }

  /**
   * Caller evidence, observe mode (src/caller.mjs): next to the identity the hook DECLARED (its
   * workspace variable), the one the board worked out from the process that holds the connection.
   * Looked up only for a call that was held, allowed or observed, or that a 1.3 check in observe
   * would hold — never for a plain pass, so the common path pays nothing. In observe it changes no
   * answer; with names enforced (mode 'on') the answer was already made for the session it names.
   * → { caller, callerMismatch? } for the check log. `declared` = the identity the hook sent.
   */
  // One overall limit for the note: the hold was filed BEFORE this wait, and the hook stops waiting
  // after a few seconds. A slow lookup must cost the log line its caller, never the hook its answer.
  const NOTE_BUDGET_MS = 2500;
  // a reading for Mission Control (GET /api/status → caller): the hook declared a registered agent
  // and the board saw no agent behind the call — the sign of a session the lookup cannot name here
  const readings = { noAgentSeen: 0, lastNoAgentSeen: null, notRead: 0 };
  const isRegisteredName = (n) => Boolean(n) && !String(n).startsWith('unregistered:') && !String(n).startsWith('headless:');
  /** The evidence, or LATE when it did not come within `ms`. A lookup that throws is null. */
  const within = async (evidence, ms) => {
    let timer;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(LATE), ms); });
    try { return await Promise.race([Promise.resolve().then(evidence).catch(() => null), late]); } finally { clearTimeout(timer); }
  };
  async function callerNote(declared, r, evidence, { names = false, budgetMs = NOTE_BUDGET_MS } = {}) {
    if (typeof evidence !== 'function' || (r.decision === 'pass' && !r.observed && !r.wouldHold)) return {};
    const ev = await within(evidence, budgetMs);
    if (ev === LATE) { readings.notRead += 1; return { callerNotRead: `the lookup took longer than ${budgetMs} ms` }; }
    if (!ev || ev.kind === 'remote') return {};
    const caller = ev.kind === 'agent' ? (ev.name || `unregistered:${String(ev.workspaceId).slice(0, 8)}`) : ev.kind === 'job' ? ev.name : ev.kind;
    // a mismatch = the process belongs to one registered agent and the hook named another
    const mismatch = ev.kind === 'agent' && Boolean(ev.name) && ev.name !== declared;
    if (mismatch) recordEvent(names ? 'bad' : 'sys', `[caller mismatch] gate check: the hook declared ${declared}, but the call came from ${caller}'s session${names ? ` — judged as ${caller}` : ''}`).catch(() => {});
    if (isRegisteredName(declared) && !['agent', 'job', 'board'].includes(ev.kind)) {
      readings.noAgentSeen += 1;
      readings.lastNoAgentSeen = { at: new Date(now()).toISOString(), declared, kind: ev.kind, why: String(ev.why || '').slice(0, 160) };
    }
    return { caller, ...(ev.basis ? { callerBasis: ev.basis } : {}), ...(mismatch ? { callerMismatch: true } : {}) };
  }

  /** The hook's question, logged: every answer leaves one line in data/guardrails/checks.jsonl. */
  /**
   * `names` (SETTINGS.callerEvidence mode 'on'): the identity the answer is made for comes from the
   * evidence, not from the fields the hook sent. Then `agent` in the log is that identity, and
   * `declared` is kept beside it whenever the two differ.
   */
  async function check(input, { evidence = null, names = false, noteBudgetMs = undefined } = {}) {
    const budgetMs = noteBudgetMs || NOTE_BUDGET_MS;
    const who = { agent: null, declared: null, force: false, late: false };
    const r = await decide(input, { evidence, names, who, budgetMs });
    const raw = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? input.filePath ?? '');
    // decide() fills `who`; a request it turned away before it looked (a stale one) is named as declared
    const declared = who.declared || await whoIs(input, await loadPolicy().catch(() => null), input.cwd || root).catch(() => `unregistered:${path.basename(input.cwd || root)}`);
    const agent = who.agent || declared;
    // the identity lookup already ran out of time: the note does not wait for the same lookup again
    const note = who.late ? { callerNotRead: `the lookup took longer than ${budgetMs} ms` }
      : await callerNote(declared, r, evidence, { names, budgetMs }).catch(() => ({}));
    await store.logCheck({
      at: new Date(now()).toISOString(), event: input.event || 'pre', agent, ...(agent !== declared ? { declared } : {}), ...(who.force ? { enforcedUnknown: true } : {}), ...note, tool: input.tool, decision: r.decision,
      ...(r.observed ? { observed: true } : {}), ...(r.wouldHold ? { wouldHold: r.wouldHold } : {}), ...(r.stale ? { stale: true } : {}), ...(r.task ? { task: r.task, gate: r.gate } : {}),
      reason: r.reason ? String(r.reason).slice(0, 120) : undefined,
      command: containsSecret(raw) ? '[withheld: contains a secret]' : raw.replace(/\s+/g, ' ').slice(0, 160), cwd: input.cwd,
      // the replay tool (scripts/gate-replay.mjs) needs the text as it was: a long or multi-line command
      // is also kept whole (to 4000 chars) on its pre line
      ...((input.event || 'pre') === 'pre' && !containsSecret(raw) && (raw.length > 160 || /\s\s|[\n\t]/.test(raw)) ? { full: raw.slice(0, 4000) } : {}),
    }).catch(() => {});
    // the hook's answer is what it was before the 1.3 checks: the reading stays on the board
    const { wouldHold, ...answer } = r;
    return answer;
  }

  /** → { decision: 'pass'|'allow'|'deny', reason?, task?, gate? } */
  async function decide(input, { evidence = null, names = false, who = null, budgetMs = NOTE_BUDGET_MS } = {}) {
    // the hook stops waiting at its deadline and denies on its own; a request served later (a frozen or
    // slow board) must not file a gate the agent was never told about
    if (Number(input.deadline) > 0 && now() > Number(input.deadline)) return { decision: 'deny', reason: 'stale request (the hook already gave up)', stale: true };
    const p = await loadPolicy();
    const tool = normTool(input.tool);
    const engine = input.engine === 'codex' ? 'codex' : 'claude';
    const cwd = input.cwd || root;
    const command = Array.isArray(input.command) ? input.command.map(shellQuote).join(' ') : String(input.command ?? '');
    const call = { tool, command, filePath: input.filePath || null, cwd, ...(input.folderUnread === true ? { folderUnread: true } : {}) };
    const declared = await whoIs(input, p, cwd);
    // Names enforced (callerEvidence mode 'on'): the identity is the SESSION behind the hook call,
    // worked out from the process that holds the connection (src/caller.mjs hookIdentity) — not the
    // workspace id or the role the hook's environment carries, which a child session can be started
    // with. Looked up the first time the identity matters, so a plain pass still pays nothing.
    // A lookup that fails keeps the declared name and is ENFORCED whatever that name is.
    let agent = declared; let force = false; let settled = !names;
    if (who) { who.declared = declared; who.agent = declared; }
    const settle = async () => {
      if (settled) return;
      settled = true;
      // the same time limit as the caller note: the hook waits a few seconds, and a lookup that
      // does not answer in time is no evidence — the call is enforced as declared
      let ev = typeof evidence === 'function' ? await within(evidence, budgetMs) : null;
      if (ev === LATE) { ev = null; readings.notRead += 1; if (who) who.late = true; }
      const id = hookIdentity(ev, { declared, folder: path.basename(cwd),
        headlessWs: (ws) => headlessName(headlessWs(ws), p),
        okJob: (n) => isHeadless(n) && headlessName(String(n).slice('headless:'.length), p) === n });
      agent = id.agent; force = id.force;
      if (who) { who.agent = agent; who.force = force; }
    };
    const ctx = ctxFor(cwd);
    const r = classify(call, p, ctx);

    // dry-run bookkeeping: watched scripts run without their write flags
    if (r.verdict === 'clear' && tool === 'Bash' && r.scripts?.length) {
      const watched = await store.watched();
      for (const c of r.scripts) {
        const sp = scriptPath(c); if (!sp) continue;
        const abs = path.resolve(cwd, sp.replace(/^~(?=\/)/, home));
        if (!watched.includes(abs)) continue;
        await settle();
        const dh = dryHash(cwd, c.tokens);
        const focus = focusOf(await store.focus(), agent)?.task ?? null;
        await store.recordDry({ agent, cwd, dryHash: dh, script: abs, task: focus, phase: input.event === 'post' ? 'completed' : 'started', now: now() });
      }
    }
    const mode = MODES.includes(p.mode) ? p.mode : 'enforce';
    // a 1.3 check in observe: the call passes exactly as before, and the reading says what would hold it
    if (input.event !== 'post' && r.verdict === 'clear' && r.wouldHold && mode !== 'off') {
      await settle();
      const w = r.wouldHold;
      const text = redact(command) ?? '[withheld: the command contains a secret]';
      await store.observe({ at: new Date(now()).toISOString(), agent, engine, cls: w.cls, why: redact(w.why) ?? '[withheld]', command: text, cwd, tool, wouldHold: w.check }).catch(() => {});
      console.log(`${new Date(now()).toISOString()} [guardrails] would hold: ${agent} ${w.check}`);
      recordEvent('sys', `guardrails (observe): ${w.check} would hold ${agent} — ${String(text).replace(/\s+/g, ' ').slice(0, 80)}`).catch(() => {});
      return { decision: 'pass', wouldHold: w.check };
    }
    if (input.event === 'post' || r.verdict === 'clear') return { decision: 'pass' };
    if (mode === 'off') return { decision: 'pass' };

    await settle();
    const enforced = mode === 'enforce' && (force || isEnforced(p, agent, { registered: !agent.startsWith('unregistered:') }));
    // what the owner sees: the shell command, or for any other tool the tool + its full input
    const toolInput = tool !== 'Bash' && input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : null;
    const text = toolInput ? describeToolCall(tool, toolInput) : command;
    const shown = redact(text) ?? `[withheld: the ${toolInput ? 'tool input' : 'command'} contains a secret] ${r.cmd?.bin || tool}${call.filePath ? ` ${call.filePath}` : ''}`;
    if (!enforced) {
      // observe: ticker + observed.jsonl only, never the task (condition G)
      // the reading before an enforce-by-default flip: would that setting have held this call?
      const would = mode === 'enforce' && wouldEnforce(p, agent, { registered: !agent.startsWith('unregistered:') });
      await store.observe({ at: new Date(now()).toISOString(), agent, engine, cls: r.cls, why: redact(r.why) ?? '[withheld]', command: shown, cwd, tool, ...(would ? { wouldEnforce: true } : {}) });
      if (would) console.log(`${new Date(now()).toISOString()} [guardrails] would enforce: ${agent} ${r.cls} (observed today; held under defaultMode enforce)`);
      recordEvent('sys', `guardrails (observe): ${agent} would wait on the owner — ${r.cls}: ${String(shown).slice(0, 80)}${would ? ' [would enforce by default]' : ''}`).catch(() => {});
      return { decision: 'pass', observed: true };
    }

    // a Codex call whose repository or script the board cannot read is refused, not filed: the owner sees only rows that are read
    const unbound = await unreadRefusal(r, input, command, cwd);
    if (unbound) {
      recordEvent('sys', `guardrails: ${agent} ${r.cls} refused unfiled (folder not named by Codex): ${String(shown).slice(0, 80)}`).catch(() => {});
      return { decision: 'deny', reason: denyText.restate(redact(unbound) ?? 'its folder was not named'), unfiled: true };
    }
    const hash = cmdHash({ engine, cwd, tool, command, filePath: call.filePath || '', toolInput });
    // 1. an approved grant for exactly this call: consume it, let it run once
    const grant = await store.redeem({ cmdHash: hash, agent, now: now() });
    if (grant && !grant.expired && chain.mode !== 'off') {
      // the grant counts only when the chain holds the approval this board recorded for it
      await chainReady();
      if (!chain.approvalFor(grant.task, grant.gate)) {
        const line = `gate ${grant.gate} on #${grant.task}: a grant was presented by ${agent} with no approval in the receipt chain`;
        if (chain.mode === 'on') {
          chain.noteDispute();
          console.error(`${new Date(now()).toISOString()} [guardrails] DISPUTED ${line} — not run`);
          recordEvent('bad', `guardrails: DISPUTED ${line} — not run`).catch(() => {});
          const u = await ledger.update(grant.task, { op: 'gate_event', actor: 'board', gate: grant.gate, event: 'disputed' }, { gateSystem: true }).catch(() => null);
          if (u) await afterTaskChange(u.task, u, 'board');
          chainCheckAt = 0;                                          // the card re-checks on its next pass
          return { decision: 'deny', reason: denyText.disputed(grant.task, grant.gate), task: grant.task, gate: grant.gate };
        }
        console.log(`${new Date(now()).toISOString()} [guardrails] would dispute: ${line} (receiptChain observe)`);
        recordEvent('sys', `guardrails (observe): would dispute ${line}`).catch(() => {});
      }
    }
    if (grant && !grant.expired) {
      const u = await ledger.update(grant.task, { op: 'gate_event', actor: 'board', gate: grant.gate, event: 'executed' }, { gateSystem: true });
      recordEvent('sys', `guardrails: gate ${grant.gate} on #${grant.task} released to ${agent} to run once`).catch(() => {});
      await afterTaskChange(u.task, u, 'board');
      return { decision: 'allow', reason: `approved by the owner (task #${grant.task} gate ${grant.gate}) — runs once`, task: grant.task, gate: grant.gate };
    }
    if (grant?.expired) await ledger.update(grant.task, { op: 'gate_event', actor: 'board', gate: grant.gate, event: 'expired' }, { gateSystem: true }).catch(() => {});

    // 2. the same call is already waiting, or was declined
    const prior = await findByHash(agent, hash);
    // the owner already approved exactly this call once, but it expired unused: ask again (an approval
    // is of the call at that time — never re-armed), and say so on the row and in the notices
    let earlier = null;
    if (prior && (prior.g.status === 'expired' || (prior.g.status === 'approved' && prior.g.expires_at && Date.parse(prior.g.expires_at) <= now()))) {
      if (prior.g.status === 'approved') await ledger.update(prior.t.id, { op: 'gate_event', actor: 'board', gate: prior.g.id, event: 'expired' }, { gateSystem: true }).catch(() => {});
      earlier = { gate: prior.g.id, task: prior.t.id, at: prior.g.decided_at };
    }
    if (prior?.g.status === 'pending') {
      await ledger.update(prior.t.id, { op: 'gate_event', actor: 'board', gate: prior.g.id, event: 'attempt' }, { gateSystem: true });
      return { decision: 'deny', reason: denyText.waiting(prior.t.id, prior.g, { noWake: cannotWake(agent) }), task: prior.t.id, gate: prior.g.id };
    }
    if (prior?.g.status === 'declined') {
      const u = await ledger.update(prior.t.id, { op: 'gate_event', actor: 'board', gate: prior.g.id, event: 'rerun_declined' }, { gateSystem: true });
      await afterTaskChange(u.task, u, 'board');
      return { decision: 'deny', reason: denyText.declined(prior.t.id, prior.g), task: prior.t.id, gate: prior.g.id };
    }

    // 3. which task the receipt lands on (condition C)
    const short = String(shown).replace(/\s+/g, ' ').slice(0, 80);
    const where = await resolveTask(agent, r.label, short);
    if (where.needsFocus) return { decision: 'deny', reason: denyText.focus(where.needsFocus) };

    const base = { cls: r.cls, label: r.label, ...(r.check ? { check: r.check } : {}), why: redact(r.why) ?? '[withheld]', command: shown, commandRedacted: shown !== text, bin: r.cmd?.bin || null,
      cwd, ...(r.cmd?.folderUnread ? { folderUnread: true, ...(r.cmd.bin === 'gh' && (namesGhRepo(r.cmd) || input.ghRepo) ? { repoNamed: true } : {}) } : {}), ...(r.cmd?.folderUnsure ? { folderUnsure: r.cmd.folderUnsure } : {}), tool, engine, agent, session: input.session || null, cmdHash: hash, hashVersion: HASH_VERSION, ttlMinutes: r.ttlMinutes,
      // row context: chips from the class and the policy's lists (never from the agent), and the agent's own words, labelled
      context: rowContext({ cls: r.cls, slug: r.cmd?.cdUnknown ? null : targetSlug(r, folderOf(r, cwd), command, p.lists), lists: p.lists }),
      agentReason: agentWords(input.description) };   // a shell call's description only: an MCP tool's `description` is an argument, not a reason
    if (earlier) {
      base.previously = earlier;
      base.why = `${base.why} · previously approved ${String(earlier.at).slice(11, 16)}Z (#${earlier.task} ${earlier.gate}), expired unused`;
    }
    // a merge row says which PR: title, branches and repo, looked up when the gate is filed
    if (r.cls === 'merge' && r.cmd) {
      const s = r.prRead !== undefined ? r.prRead : await readPr(r.cmd, folderOf(r, cwd));
      if (!s && (r.cmd.folderUnread || r.cmd.folderUnsure)) base.why = `${base.why} · PR not read (${r.cmd.folderUnsure ? 'folder unsure' : 'folder not named'})`;
      if (s) base.why = redact(`${base.why} · PR #${s.number} "${s.title}" (${s.head} → ${s.base})${s.repo ? ` · ${s.repo}` : ''}`) ?? base.why;
    }

    // 4. dry run first (from the task's own history)
    if (r.requireDryRun && r.dryTokens) {
      const dh = dryHash(cwd, r.dryTokens);
      const sp = scriptPath(r.cmd);
      if (sp && await store.watch(path.resolve(cwd, sp.replace(/^~(?=\/)/, home)))) await syncTriggers();
      const t = await ledger.get(where.id);
      const lastUse = Math.max(0, ...(t.gates || []).filter((g) => g.dryRun?.dryHash === dh && g.executed_at).map((g) => Date.parse(g.executed_at)));
      const seen = [...(await store.dryRecords())].reverse().find((d) => d.agent === agent && d.dryHash === dh && d.completed_at && Date.parse(d.completed_at) > lastUse);
      const dryCmd = redact(r.dryTokens.map(shellQuote).join(' ')) ?? '[the same command without its write flag]';
      if (!seen) {
        const u = await ledger.update(where.id, { op: 'gate_request', actor: 'board', gate: { ...base, status: 'dry_required', dryRun: { required: true, dryHash: dh, command: dryCmd } } }, { gateSystem: true });
        await afterTaskChange(u.task, u, 'board');
        return { decision: 'deny', reason: denyText.dry(where.id, dryCmd), task: where.id };
      }
      base.dryRun = { required: true, seen_at: seen.completed_at, dryHash: dh, command: dryCmd };
    }

    // 5. standing approval: a program go on this task approves the standing classes (merge into private repos, local loads)
    const cls = (p.classes || []).find((c) => c.id === r.cls);
    if (cls?.standing) {
      const t = await ledger.get(where.id);
      const go = activeProgramGo(t);
      // the repo is the one the command runs in (cd / git -C), not the hook's session folder
      const why = !go ? 'no program go' : r.cmd?.cdUnknown ? 'the command runs in a folder the gate cannot resolve' : await standingBlocker(r, folderOf(r, cwd), p, command);
      if (go && !why) {
        const a = await ledger.update(where.id, { op: 'gate_request', actor: 'board', gate: { ...base, auto: { go: go.id, owner: ownerId } } }, { gateSystem: true });
        const g = a.task.gates[a.task.gates.length - 1];
        const u = await ledger.update(where.id, { op: 'gate_event', actor: 'board', gate: g.id, event: 'executed' }, { gateSystem: true });
        recordEvent('sys', `guardrails: ${agent} ${r.cls} on #${where.id} auto-approved under program go ${go.id} (gate ${g.id})`).catch(() => {});
        await afterTaskChange(u.task, { ...u, events: [...(a.events || []), ...(u.events || [])] }, 'board');
        return { decision: 'allow', reason: `auto-approved under program go ${go.id} on task #${where.id} (gate ${g.id}) — runs once`, task: where.id, gate: g.id };
      }
      if (go) base.why = `${base.why} · not under the program go: ${why}`;
    }

    // 6. file the gate and wait on the owner
    const u = await ledger.update(where.id, { op: 'gate_request', actor: 'board', gate: base }, { gateSystem: true });
    const g = u.task.gates[u.task.gates.length - 1];
    await afterTaskChange(u.task, u, 'board');
    // held only because the landing shares its command text with something else: say how to get the auto-run
    const hint = /not under the program go: the landing is not the whole command/.test(base.why || '') ? ` ${ALONE_HINT}` : '';
    return { decision: 'deny', reason: denyText.pending(where.id, g, { noWake: cannotWake(agent) }) + hint, task: where.id, gate: g.id };
  }

  /**
   * The repo a plain `gh pr …` in this checkout acts on, or null when that is not certain. gh resolves the
   * base repo from EVERY remote and from the `gh-resolved` key (a remote named upstream wins; a resolved
   * key can name a repo that is no remote at all). So: every remote, and every resolved key, must be the
   * one repo the origin names. Anything else is unknown.
   */
  function checkoutRepo(cwd) {
    if (!cwd) return null;                                  // a folder nobody told the hook (#548): no checkout to read
    const origin = repoSlug(git(cwd, ['remote', 'get-url', 'origin']));
    if (!origin) return null;
    const same = (s) => !!s && s.toLowerCase() === origin.toLowerCase();
    for (const name of String(git(cwd, ['remote']) || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (!same(repoSlug(git(cwd, ['remote', 'get-url', name])))) return null;
    }
    for (const line of String(git(cwd, ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$']) || '').split('\n').map((x) => x.trim()).filter(Boolean)) {
      const [key, ...rest] = line.split(/\s+/);
      const value = rest.join(' ');
      if (value === 'base') continue;                       // "this remote is the base": every remote is already the origin's repo
      if (!same(readRepoName(value))) return null;
      void key;
    }
    return origin;
  }

  /** Why a standing-class call still needs a tap ('' = it may run under the go). Fails toward asking. */
  /** owner/name of the repo a merge or push targets (the -R flag, else the remote's URL), or null. */
  function targetSlug(r, cwd, command = '', lists = null) {
    const toks = r.cmd?.tokens || [];
    if (r.cls === 'merge') {
      // every repo the command names must agree (namedRepos); disagreement or an unreadable name = unknown,
      // never the checkout's own repo: the standing check then asks the owner
      const named = namedRepos(toks, command);
      if (named.unknown || named.names.length > 1) return null;
      if (named.names.length === 1) return named.names[0];
      return checkoutRepo(cwd);
    }
    if (r.cls === 'push' && r.cmd) {
      // the push address, or the one the call gives the remote (#552); no folder: only an address in the call is known
      const a = pushAddress(r.cmd, { command, cwd }, { git: cwd ? git : () => null });
      return pushSlug(a, lists || {});
    }
    return null;
  }

  async function standingBlocker(r, cwd, p, command = '') {
    if (r.cls !== 'merge') return '';
    if (!landingAlone(command)) return NOT_ALONE;
    // the admin flag lands a pull request that does not meet the repo's requirements: never by itself
    if (namedRepos(r.cmd?.tokens || [], command).admin) return 'the admin flag is set (it lands a pull request that does not meet the repo\'s requirements)';
    const slug = targetSlug(r, cwd, command);
    if (!slug) return 'the target repo is unknown';
    const inList = (n) => (p.lists?.[n] || []).some((g) => globMatch(String(g).toLowerCase(), slug.toLowerCase()));
    if (inList('publicRemotes')) return `${slug} is public`;
    if (inList('deployOnPush')) return `${slug} deploys on push`;
    if ((await isPrivateRepo(slug)) !== true) return `${slug} is not confirmed private`;
    return '';
  }

  /** After an approval is recorded on the ledger: mint the grant (before the agent is woken). */
  async function afterDecision(task, gateId) {
    const g = (task.gates || []).find((x) => x.id === gateId);
    if (!g || g.status !== 'approved') return null;
    // filed under an older fingerprint version (before an upgrade)? A shell gate whose full, unredacted
    // text is on record is re-fingerprinted, so the owner's tap still lets exactly that command run.
    let hash = g.cmdHash;
    if ((g.hashVersion || 'gate-v1') !== HASH_VERSION && g.tool === 'Bash' && !g.commandRedacted && !/\n… \[cut at /.test(g.command))
      hash = cmdHash({ engine: g.engine, cwd: g.cwd, tool: 'Bash', command: g.command });
    return store.mint({ task: task.id, gate: g.id, agent: g.agent, cmdHash: hash, expiresAt: g.expires_at });
  }

  /** Focus from claim/start: never replaces one the agent set itself on a task that is still live. */
  async function autoFocus(agent, taskId) {
    const cur = focusOf(await store.focus(), agent);
    if (cur?.explicit && cur.task !== Number(taskId)) {
      const t = await ledger.get(cur.task);
      if (t && LIVE_STATUSES.includes(t.status) && t.owner === agent) return false;
    }
    await store.setFocus(agent, taskId, { explicit: false });
    return true;
  }

  /** Board card: pending gates, hooks installed, policy health. */
  async function card(tasks) {
    await loadPolicy();
    const pending = tasks.flatMap((t) => (t.gates || []).filter((g) => g.status === 'pending').map((g) => ({ t: t.id, g })));
    const oldest = pending.length ? Math.min(...pending.map((x) => Date.parse(x.g.requested_at))) : null;
    const hooks = await hooksInstalled(home);
    const mode = policy?.mode || 'enforce';
    let status = 'ok';
    const who = policy?.defaultMode === 'enforce' ? ` for every session${policy.observeFor?.length ? ` except ${policy.observeFor.join(', ')}` : ''}`
      : policy?.enforceFor && !policy.enforceFor.includes('*') ? ` for ${policy.enforceFor.join(', ')}` : '';
    const bits = [`${mode}${who}`];
    if (pending.length) bits.push(`${pending.length} waiting on the owner (oldest ${Math.round((now() - oldest) / 60e3)}m)`);
    if (pending.length && now() - oldest > 30 * 60e3) status = 'warn';
    bits.push(`hook: claude ${hooks.claude ? 'on' : 'MISSING'}${hooks.codex == null ? '' : ` · codex ${hooks.codex ? 'on' : 'MISSING'}`}`);
    // Said on the card, not coloured: taking new rules is the owner's step, and an owner can be behind on purpose.
    const behind = shippedRulesMissing(policy);
    if (behind.count) bits.push(`${behind.count} shipped rule${behind.count === 1 ? ' is' : 's are'} not in yours (${behind.classes.join(', ')}; INSTALL 7b)`);
    if (!hooks.claude && mode !== 'off') status = 'failed';
    if (policyError) { bits.push(policyError); status = 'failed'; }
    // receipt chain: amber when a line could not be written, red when the chain and the ledger differ
    // (checked at start and every six hours) or a live task holds a disputed gate
    if (chain.mode !== 'off') {
      await chainReady();
      if (!chainCheck || now() - chainCheckAt > CHAIN_CHECK_MS) { chainCheck = await chain.verify(await ledger.list()).catch((e) => ({ ok: false, problems: [{ why: e.message }] })); chainCheckAt = now(); }
      const cs = chain.status();
      const disputed = tasks.flatMap((t) => (t.gates || []).filter((g) => g.status === 'disputed').map((g) => `#${t.id} ${g.id}`));
      if (cs.error) { bits.push(`receipts: ${cs.unwritten} line(s) not on disk (${cs.error.message})`); if (status === 'ok') status = 'warn'; }
      if (cs.unreadable) { bits.push(`receipts: cannot read the chain (${cs.unreadable}); approved calls are refused until it can be read`); status = 'failed'; }
      else if (!chainCheck.ok) { bits.push(`receipts: ${chainCheck.problems.length} difference(s) between the chain and the ledger — task.sh audit N --verify`); status = 'failed'; }
      const live = new Set(tasks.map((t) => t.id));
      const outside = chain.flagged().filter((f) => live.has(f.task)).map((f) => `#${f.task} ${f.gate}`);
      if (outside.length) { bits.push(`receipts: ${outside.slice(0, 3).join(', ')} read approved without a decision by this board (the task record was changed outside it)`); status = 'failed'; }
      if (disputed.length) { bits.push(`DISPUTED ${disputed.slice(0, 3).join(', ')}: a grant with no approval in the chain`); status = 'failed'; }
      if (!cs.error && !cs.unreadable && chainCheck.ok && !disputed.length && !outside.length) bits.push(`receipts: ${cs.lines} chained${chain.mode === 'observe' ? ' (observe)' : ''}`);
    }
    return { status, detail: bits.join(' · '), pending: pending.length };
  }

  /**
   * Startup reconcile (#369): a board that died after spending a grant but before writing the receipt
   * leaves the gate `approved`. Record it from grants.json. Must run before anything can mint (mint
   * drops spent grants). Idempotent: a gate no longer `approved` is skipped. Never wakes anyone.
   */
  async function reconcile() {
    const spent = await store.spentGrants();
    let repaired = 0;
    for (const s of spent) {
      const t = await ledger.get(s.task).catch(() => null);
      const g = (t?.gates || []).find((x) => x.id === s.gate);
      if (!g || g.status !== 'approved') continue;
      const expired = s.used_at === 'expired';
      try {
        await ledger.update(s.task, { op: 'gate_event', actor: 'board', gate: s.gate, event: expired ? 'expired' : 'executed', ...(expired ? {} : { at: s.used_at }), note: RESTART_NOTE }, { gateSystem: true });
        repaired += 1;
        recordEvent('sys', `guardrails: gate ${s.gate} on #${s.task} ${expired ? 'expired' : 'released to run once'} — receipt ${RESTART_NOTE}`).catch(() => {});
      } catch (e) { console.error(`[guardrails] reconcile #${s.task} ${s.gate}: ${e.message}`); }
    }
    if (!repaired) console.log(`[guardrails] reconcile: ${spent.length} spent grant(s) checked, nothing to repair`);
    return { checked: spent.length, repaired };
  }

  async function audit(taskId) {
    const t = await ledger.get(taskId);
    return t ? auditRows(t) : null;
  }
  /** audit --verify: recompute the chain and compare it with gates[] (one task, or every task). */
  async function verifyChain(taskId = null) {
    await chainReady();
    return chain.verify(await ledger.list(), { only: taskId });
  }

  return { check, callerReadings: () => ({ ...readings }), verifyTriggers, afterDecision, card, audit, verifyChain, chain, reconcile, loadPolicy, store, autoFocus, setFocus: (a, id) => store.setFocus(a, id, { explicit: true }), policy: () => policy, policyError: () => policyError };
}

/** Claude: Bash/Read/Edit/Write/mcp__*; Codex shells arrive as shell/exec_command/local_shell. */
export function normTool(t) {
  const s = String(t || 'Bash');
  return isShellTool(s) ? 'Bash' : s;
}

// Which PR a merge gate is about (gh pr view in the call's folder; -R honored). null when gh can't tell.
/** Does a `gh pr merge` name its repo itself (-R / --repo, or the PR's URL)? */
export function namesPrRepo(cmd) {
  const toks = cmd?.tokens || [];
  return toks.some((x) => x === '-R' || x === '--repo' || x.startsWith('--repo=') || /github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/.test(x));
}
/** Does a gh call name the repository it acts on (-R / --repo, a github.com URL, `gh api repos/<owner>/<name>/…`, `gh repo <verb> <owner>/<name>`)? */
export function namesGhRepo(cmd) {
  const toks = cmd?.tokens || [];
  if (toks.some((x) => x === '-R' || x === '--repo' || x.startsWith('--repo='))) return true;
  const pos = positionals(cmd);
  // an address counts only as a positional word (the PR or repo argument), never inside a flag's value such as a body or a title (#552)
  if (pos.some((x) => /^(https?:\/\/)?(www\.)?github\.com\/[^/\s]+\/[^/\s]+/.test(x))) return true;
  if (pos[0] === 'api') return /^\/?repos\/[^/\s]+\/[^/\s]+/.test(pos[1] || '');
  return pos[0] === 'repo' && /^[^/\s-][^/\s]*\/[^/\s]+$/.test(pos[2] || '');
}
async function ghPrInfo(cmd, cwd) {
  const toks = cmd.tokens || [];
  const ri = toks.findIndex((x) => x === '-R' || x === '--repo');
  const repo = ri >= 0 ? toks[ri + 1] : (toks.find((x) => x.startsWith('--repo=')) || '').slice(7) || null;
  const pos = positionals(cmd);
  const target = pos[pos.indexOf('merge') + 1];        // number, URL or branch; none = the current branch's PR
  const args = ['pr', 'view', ...(target ? [target] : []), ...(repo ? ['-R', repo] : []), '--json', 'number,title,headRefName,baseRefName,url'];
  const out = execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out);
  return { number: j.number, title: String(j.title || '').slice(0, 120), head: j.headRefName, base: j.baseRefName, repo: repoSlug(j.url?.replace(/\/pull\/\d+$/, '')) };
}

// GitHub says whether a repo is private (gh, the owner's login); cached 6h; any failure → not confirmed
const privCache = new Map();
async function ghIsPrivate(slug) {
  const hit = privCache.get(slug);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  let v = null;
  try { v = execFileSync('gh', ['api', `repos/${slug}`, '--jq', '.private'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch { v = null; }
  privCache.set(slug, { v, at: Date.now() });
  return v;
}

function defaultGit(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/** Is the gate hook in the agents' settings? (claude: required; codex: only if ~/.codex exists) */
export async function hooksInstalled(home) {
  const has = async (f) => { try { return (await readFile(f, 'utf8')).includes('gate-hook.sh'); } catch { return null; } };
  const claude = await has(path.join(home, '.claude', 'settings.json'));
  const codexDir = await stat(path.join(home, '.codex')).catch(() => null);
  const codex = codexDir ? (await has(path.join(home, '.codex', 'hooks.json'))) ?? false : null;
  return { claude: !!claude, codex };
}
export { LIVE_STATUSES, OPAQUE };
