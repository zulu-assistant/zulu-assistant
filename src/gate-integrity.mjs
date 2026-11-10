// Gate integrity (Zulu 1.3, docs/GUARDRAILS.md): is the gate's own code, as it runs in THIS
// checkout, what has landed on the default branch?
//
// The gate decides what an agent may run. Its hook, classifier and page are files in the live
// checkout, and the same user can write them. Guarded writes (policy list `gateCode`) hold an
// agent's edit; this check is the second line: it SEES a change that got through anyway, whoever
// made it and however, within a poll.
//
//   current   every gate file equals what the newest landed commit holds          green
//   behind    a newer commit has landed and this checkout has not been             amber, red after
//             fast-forwarded yet; the files still equal the landed commit          `behindMinutes`
//             the checkout is on
//   changed   anything else: a file matches neither; the checkout is on a          red at once
//             commit that never landed; or it moved BACK to an older commit
//
// "Landed" is what the REMOTE said the default branch's head was, as the board itself asked and
// wrote down (the last 20 answers). The local remote-tracking ref is never trusted by itself, so
// moving it by hand hides nothing. A commit is landed when it is one of those heads, or an
// ancestor of one that is in the local repository.
//
// Everything here is pure except createGateIntegrity, which takes its readers as arguments.
import { createHash } from 'node:crypto';

export const MAX_HEADS = 20;
export const DEFAULT_BEHIND_MINUTES = 30;

/** The git blob id of a file's bytes: sha1("blob <size>\0" + bytes) — sha256 for a repo that uses it. */
export function blobId(buf, algo = 'sha1') {
  const h = createHash(algo);
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}
/** 40 hex = sha1, 64 = sha256 (what `git rev-parse` printed for this repository). */
export const algoOf = (sha) => (String(sha || '').length === 64 ? 'sha256' : 'sha1');

/** SETTINGS.gateIntegrity → { mode: 'off'|'on', behindMinutes, branch, remote, readEveryMinutes }. Absent = off.
 *  behindMinutes: after how long "behind" turns red (a landed gate change is not running here).
 *  0 or false = never: a checkout that simply has not been updated stays amber. */
export function integritySettings(cfg) {
  if (cfg === 'on' || cfg === true) cfg = { mode: 'on' };
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    mode: c.mode === 'on' ? 'on' : 'off',
    behindMinutes: c.behindMinutes === 0 || c.behindMinutes === false ? 0 : num(c.behindMinutes, DEFAULT_BEHIND_MINUTES, 1),
    readEveryMinutes: num(c.readEveryMinutes, 10, 1),
    branch: typeof c.branch === 'string' && c.branch ? c.branch : null,          // null = the remote's default branch
    remote: typeof c.remote === 'string' && c.remote ? c.remote : 'origin',
  };
}

// ── what the remote said ────────────────────────────────────────────────────
/**
 * Add a head the remote reported. Newest last, no repeats in a row, the last MAX_HEADS kept.
 * `state` = { heads: [{ sha, at }], passedAt: sha|null (K), behindSince: iso|null, behindOf: sha|null, readAt, readError }
 */
export function noteHead(state, sha, iso) {
  const s = { heads: [], passedAt: null, behindSince: null, behindOf: null, ...(state || {}) };
  const heads = Array.isArray(s.heads) ? s.heads.filter((h) => h && typeof h.sha === 'string') : [];
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(sha || ''))) return { ...s, heads };
  const last = heads[heads.length - 1];
  const next = last && last.sha === sha ? heads : [...heads.filter((h) => h.sha !== sha), { sha, at: iso }];
  return { ...s, heads: next.slice(-MAX_HEADS), readAt: iso, readError: null };
}
export const newestHead = (state) => (state?.heads?.length ? state.heads[state.heads.length - 1].sha : null);

// ── the judgment (pure) ─────────────────────────────────────────────────────
/**
 * One file's state.
 *   live      its blob id on disk (null = missing)
 *   atNewest  its blob id at the newest head the remote reported (undefined = that commit is not
 *             in the local repository yet; null = the file does not exist there)
 *   atHead    its blob id at the commit the checkout is on (null = not in that commit)
 *   headOk    the checkout's commit is landed, and is the last passed commit or a descendant of it
 * → 'current' | 'behind' | 'changed'
 */
export function fileState({ live, atNewest, atHead, headOk }) {
  if (atNewest !== undefined && live === atNewest) return 'current';   // (both null: gone here and gone there)
  if (headOk && live === atHead) return 'behind';
  return 'changed';
}

/**
 * The whole check.
 *   files      [{ path, live, atNewest, atHead }]
 *   head       the commit the live checkout is on (H)
 *   newest     the newest head the remote reported (N), null = the remote was never read
 *   newestHere N is in the local repository
 *   landed     H is one of the reported heads or an ancestor of one
 *   back       H is a strict ancestor of the last passed commit (the checkout moved back)
 *   forward    H is the last passed commit, a descendant of it, or nothing has passed yet
 *   state      the kept state (noteHead)
 *   now        ms
 * → { status: 'ok'|'warn'|'down'|'unknown', state: 'current'|'behind'|'changed'|'unread', detail, changed: [paths],
 *     behind: [paths], next: the state to keep }
 */
export function judge({ files = [], head, newest, newestHere, landed, back, forward, state = {}, now = Date.now(), behindMinutes = DEFAULT_BEHIND_MINUTES, commitsBehind = null }) {
  const iso = new Date(now).toISOString();
  const keep = { heads: [], passedAt: null, behindSince: null, behindOf: null, ...(state || {}) };
  if (!newest) {
    // the remote was never read (first start with no network): nothing is known to compare with.
    // Not red: the owner is told the check cannot run, and why.
    return { status: 'unknown', state: 'unread', detail: `gate files not checked: the remote head has not been read${keep.readError ? ` (${keep.readError})` : ''}`, changed: [], behind: [], next: keep };
  }
  const headOk = Boolean(landed) && !back && Boolean(forward);
  // A first start (nothing has passed yet) on a checkout that has not fetched the newest head: nothing
  // here can say whether the commit it is on has landed, so nothing can be called changed for that
  // reason. A file that equals its own commit is "behind, not fetched" (amber); one that does not is
  // an edit in the work tree, and that is changed whatever the remote says. No mark is set.
  const unproven = !keep.passedAt && !newestHere && !landed && !back;
  const rows = files.map((f) => ({ path: f.path, st: unproven ? (f.live != null && f.live === f.atHead ? 'behind' : 'changed')
    : fileState({ live: f.live, atNewest: newestHere ? f.atNewest : undefined, atHead: f.atHead, headOk }) }));
  const changed = rows.filter((r) => r.st === 'changed').map((r) => r.path);
  // which files are behind is known only when the newest head is in the local repository; until it
  // is fetched the board can say that a newer commit landed, not what it touches
  const isBehind = rows.some((r) => r.st === 'behind');
  const behind = newestHere ? rows.filter((r) => r.st === 'behind').map((r) => r.path) : [];
  if (changed.length) {
    const why = back ? 'the checkout moved back to an older commit'
      : unproven ? 'the files differ from the commit this checkout is on'
      : !landed && head !== newest ? 'the checkout is on a commit that has not landed' : 'the files differ from what landed';
    return { status: 'down', state: 'changed', detail: `gate files differ from ${shortRef(newest)}: ${listPaths(changed)} — ${why}`, changed, behind, next: { ...keep, behindSince: null, behindOf: null } };
  }
  if (isBehind) {
    // the clock starts when the remote head first differed from the commit this checkout is on
    const since = keep.behindOf === head && keep.behindSince ? keep.behindSince : iso;
    const mins = Math.max(0, Math.round((now - Date.parse(since)) / 60000));
    const late = behindMinutes > 0 && mins >= behindMinutes;
    const n = Number.isFinite(commitsBehind) && commitsBehind > 0 ? `${commitsBehind} commit${commitsBehind === 1 ? '' : 's'}` : 'a newer commit';
    const detail = !newestHere
      ? (late ? `a newer commit landed ${mins} min ago and is NOT running here (not fetched yet, so the board cannot say whether it touches the gate files) — fetch and fast-forward the live checkout`
        : `a newer commit has landed and is not fetched here yet (${mins} min): fetch and fast-forward the live checkout`)
      : (late ? `a gate change has landed and is NOT running here: behind by ${n} for ${mins} min (${listPaths(behind)}) — fast-forward the live checkout`
        : `gate files are behind by ${n} (${mins} min): fast-forward the live checkout`);
    return {
      status: late ? 'down' : 'warn', state: 'behind', changed, behind, detail,
      // still checked, against reviewed code: the commit the checkout is on passes
      next: { ...keep, behindSince: since, behindOf: head, passedAt: unproven ? keep.passedAt : head },
    };
  }
  // every file equals the newest landed content. The commit this checkout is on becomes the mark
  // only when it has itself landed (a local commit on top that leaves the gate files alone is not one).
  return { status: 'ok', state: 'current', detail: `gate files match ${shortRef(newest)} (${files.length} files)`, changed, behind, next: { ...keep, behindSince: null, behindOf: null, passedAt: landed && !back ? head : keep.passedAt } };
}
const shortRef = (sha) => String(sha || '?').slice(0, 7);
const listPaths = (paths, n = 4) => (paths.length > n ? `${paths.slice(0, n).join(', ')} and ${paths.length - n} more` : paths.join(', '));

// ── registration (pure): is the hook still registered, exactly, and are hooks on? ───────────
// What the installer writes (examples/claude/guardrails-hooks.json.tmpl):
//   PreToolUse   matcher Bash|Read|Edit|Write|MultiEdit|NotebookEdit|mcp__.*
//   PostToolUse  matcher Bash
//   command      GATE_NODE='<node dir>/node' '<this checkout>/scripts/gate-hook.sh'
// "The file mentions gate-hook.sh" is not that: a matcher narrowed to one tool, or a command that
// points at a copy somewhere else, is not the gate.
export const CLAUDE_MATCHER = 'Bash|Read|Edit|Write|MultiEdit|NotebookEdit|mcp__.*';
export const GATE_HOOK = 'scripts/gate-hook.sh';
export const CONFIG_HOOK = 'scripts/gate-config-hook.sh';
/** This check's own files and the settings-change hook: compared like the rest, whatever the policy's list says. */
export const OWN_FILES = ['src/gate-integrity.mjs', 'scripts/gate-config-hook.sh', 'scripts/gate-config-hook.mjs'];
/** The tools each event's matcher must cover (an MCP tool stands for all of them). */
export const MUST_COVER = { PreToolUse: ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'mcp__server__tool'], PostToolUse: ['Bash'] };

const reEsc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Is `command` the hook script of the checkout at `repo`, as the installer writes it? An absolute Node path in front is part of it (which one may change with a Node upgrade); the script path may not change. */
export function isHookCommand(command, repo, script = GATE_HOOK) {
  return new RegExp(`^GATE_NODE='/[^']+' '${reEsc(repo)}/${reEsc(script)}'$`).test(String(command || ''));
}
/** The same script registered WITHOUT an absolute Node path in front: the hook would then run whatever `node` the session's PATH names first. */
export function isBareHookCommand(command, repo, script = GATE_HOOK) {
  return !isHookCommand(command, repo, script) && new RegExp(`^(?:GATE_NODE='[^']*' )?'${reEsc(repo)}/${reEsc(script)}'$`).test(String(command || ''));
}
/** Does a hook matcher cover this tool, read as Claude Code reads it? (a plain word list is exact; anything else is a regex) */
export function matcherCovers(matcher, tool) {
  const m = String(matcher ?? '');
  if (m === '' || m === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(m)) return m.split(/[|,]/).map((x) => x.trim()).includes(tool);
  try { return new RegExp(m).test(tool); } catch { return false; }
}

/** Every hook command in a settings object, with its event and matcher. */
export function hookEntries(settings) {
  const out = [];
  const hooks = settings && typeof settings === 'object' && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (h && typeof h.command === 'string') out.push({ event, matcher: typeof g.matcher === 'string' ? g.matcher : '', command: h.command });
    }
  }
  return out;
}

/**
 * The user-level settings (Claude Code), or the hooks file (Codex, `codex: true`: no matchers there).
 *   repo        the live checkout whose hook must be the one that runs
 *   configHook  also expect the ConfigChange hook (scripts/gate-config-hook.sh)
 * → { ok, problems: [text] }
 */
export function registrationProblems(settings, { repo, codex = false, configHook = false } = {}) {
  if (!settings || typeof settings !== 'object') return { ok: false, problems: [`the ${codex ? 'Codex hooks' : 'user settings'} file is missing or unreadable`] };
  const problems = [];
  if (!codex && settings.disableAllHooks === true) problems.push('the user settings file sets disableAllHooks');
  if (!codex && hookEnvSet(settings).length) problems.push(`the user settings file sets ${hookEnvSet(settings).join(', ')} in env: ${ENV_WHY}`);
  const entries = hookEntries(settings);
  for (const [event, tools] of Object.entries(MUST_COVER)) {
    const mine = entries.filter((e) => e.event === event && isHookCommand(e.command, repo));
    if (!mine.length) {
      problems.push(entries.some((e) => e.event === event && isBareHookCommand(e.command, repo))
        ? `${event} runs the gate hook without its Node path (GATE_NODE='/…/node' in front): a settings file's PATH would then choose the program. Run the installer again`
        : `${event} does not run this checkout's gate hook`);
      continue;
    }
    if (codex) continue;
    const missed = tools.filter((t) => !mine.some((e) => matcherCovers(e.matcher, t)));
    if (missed.length) problems.push(`${event} runs the gate hook with a matcher ("${mine[0].matcher}") that leaves out ${missed.map((t) => (t.startsWith('mcp__') ? 'MCP tools' : t)).join(', ')}`);
  }
  if (configHook && !codex && !entries.some((e) => e.event === 'ConfigChange' && isHookCommand(e.command, repo, CONFIG_HOOK) && e.matcher === ''))
    problems.push('ConfigChange does not run this checkout\'s settings-change hook');
  return { ok: problems.length === 0, problems };
}

/** The two settings files of a repo that a session there reads on top of the user's own. */
export const PROJECT_SETTINGS = ['.claude/settings.json', '.claude/settings.local.json'];
/** A project or local settings file: the one key in it that silences a user-level hook. */
export const disablesHooks = (settings) => Boolean(settings && typeof settings === 'object' && settings.disableAllHooks === true);
/**
 * Environment variables no settings file has a reason to set. A settings file's `env` block
 * reaches every hook process of a session, a running one included (seen live on Claude Code 2.1.321),
 * and each of these changes whom the gate hook asks (MESH_BOARD, MC_PORT), how long it waits
 * (GATE_TIMEOUT_MS: a hook that answers past its time limit lets the call run), which program it
 * runs (GATE_NODE), who it says it is (MESH_GATE_IDENTITY, CMUX_WORKSPACE_ID, CMUX_AGENT_LAUNCH_KIND)
 * or where it and this check look for files (MC_OVERLAY, CLAUDE_PROJECT_DIR, HOME). PATH, NODE_OPTIONS
 * and the loader variables are not here: people do set them, and the hook scripts clear them instead.
 */
export const HOOK_ENV = ['MESH_BOARD', 'MC_PORT', 'GATE_TIMEOUT_MS', 'GATE_NODE', 'MESH_GATE_IDENTITY', 'CMUX_WORKSPACE_ID', 'CMUX_AGENT_LAUNCH_KIND', 'MC_OVERLAY', 'CLAUDE_PROJECT_DIR', 'HOME'];
const ENV_WHY = 'the gate hook reads that from its environment, so the file steers the hook';
/** Which of them a settings file sets. Names only: a value is never read into a message. */
export function hookEnvSet(settings) {
  const env = settings && typeof settings === 'object' && settings.env && typeof settings.env === 'object' && !Array.isArray(settings.env) ? settings.env : {};
  return HOOK_ENV.filter((k) => Object.prototype.hasOwnProperty.call(env, k));
}
/** Why a settings file of any level switches the gate off or steers it (a clause after the file's name), or null. */
export function settingsProblem(settings) {
  if (disablesHooks(settings)) return 'sets disableAllHooks, which switches the gate hook off';
  const env = hookEnvSet(settings);
  return env.length ? `sets ${env.join(', ')} in env: ${ENV_WHY}` : null;
}

/**
 * The ConfigChange hook's question (scripts/gate-config-hook.mjs) about ONE file: may this
 * settings change apply to the running session?
 *   source     'user_settings' | 'project_settings' | 'local_settings' | 'policy_settings' | 'skills'
 *   settings   the changed file, parsed (null = gone or unreadable)
 * A change that switches hooks off or steers the hook through `env`, or a user-settings change
 * that drops or narrows the gate hook, is blocked. Skills are not settings, and managed policy
 * cannot be blocked by a hook.
 * → { block, why }
 */
export function configChangeVerdict({ source, settings, repo }) {
  if (source === 'skills' || source === 'policy_settings') return { block: false, why: '' };
  const p = settingsProblem(settings);
  if (p) return { block: true, why: `the change ${p}` };
  if (source === 'user_settings') {
    // the file that registers the gate: gone, unreadable, or without the exact entry = the gate is dropped
    if (!settings) return { block: true, why: 'the user settings file is gone or cannot be read, so the gate hook would no longer be registered' };
    const r = registrationProblems(settings, { repo });
    if (!r.ok) return { block: true, why: r.problems.join('; ') };
  }
  return { block: false, why: '' };
}

/**
 * The same question over EVERYTHING the session reads. A change that is let through makes the
 * running session read all its settings files again: seen live, a blocked `disableAllHooks`
 * came in with the next harmless change to another file (Claude Code 2.1.321). So every event is
 * judged on the whole set, and while one file would switch the gate off, no change passes.
 *   changed  { source, settings, file }    the file the event names
 *   others   [{ source, settings, file }]  the user file, and the project and local files of the session's folder
 * A project or local file that does not exist is no settings at all. Managed policy cannot be blocked.
 * → { block, why, file }   file = the one that is the reason
 */
export function sessionVerdict({ changed, others = [], repo }) {
  const first = configChangeVerdict({ source: changed.source, settings: changed.settings, repo });
  if (first.block) return { ...first, file: changed.file || null };
  if (changed.source === 'policy_settings') return { block: false, why: '', file: null };
  for (const o of others) {
    if (o.file && o.file === changed.file) continue;
    if (!o.settings && o.source !== 'user_settings') continue;
    const v = configChangeVerdict({ source: o.source, settings: o.settings, repo });
    if (!v.block) continue;
    const what = v.why.startsWith('the change ') ? `${o.file} ${v.why.slice('the change '.length)}` : `${v.why} (${o.file})`;
    return { block: true, why: `${what}; letting this change through would make the session read that file again`, file: o.file };
  }
  return { block: false, why: '', file: null };
}

// ── the port (pure) ─────────────────────────────────────────────────────────
/** data/local.env tells the hook where the board is. A port there that is not this board's sends every check elsewhere. */
export function portProblem(localEnvText, listeningPort) {
  const m = /^MC_PORT=(\d+)\s*$/m.exec(String(localEnvText || ''));
  if (!m) return null;
  return Number(m[1]) === Number(listeningPort) ? null : `data/local.env says MC_PORT=${m[1]}, this board listens on ${listeningPort}: the hook would ask another port`;
}

// ── which files, and which remote ref ───────────────────────────────────────
/**
 * The policy's `gateCode` list → repo-relative paths. `<live>/x` is a file of the live checkout;
 * `<live>/dir/**` is every file under that folder in the commit the checkout is on (`lsTree(dir)`:
 * from the COMMIT, not the index or the disk, so removing a file locally does not shorten the list).
 * Anything outside the checkout is not this check's.
 */
export function gatePaths(list, { lsTree = () => [] } = {}) {
  const out = new Set();
  for (const g of Array.isArray(list) ? list : []) {
    const m = /^<(?:live|repo)>\/(.+)$/.exec(String(g));
    if (!m) continue;
    const rel = m[1];
    if (rel.endsWith('/**')) { for (const f of lsTree(rel.slice(0, -3))) out.add(f); } else if (!rel.includes('*')) out.add(rel);
  }
  return [...out].sort();
}

/**
 * Which ref to ask the remote about. A checkout on a branch, or detached anywhere else: the
 * remote's default branch. A release install (HEAD is exactly a tag, on no branch): that tag —
 * its commit is then the only landed one, and the check is never "behind".
 * → { ref: 'heads/<branch>' | 'tags/<tag>', name, release, url }
 */
export function remoteTarget({ git, settings = integritySettings('on') }) {
  const url = String(git(['config', '--get', `remote.${settings.remote}.url`]) || '').trim();
  const onBranch = git(['symbolic-ref', '-q', '--short', 'HEAD']);
  const tag = onBranch ? null : (String(git(['describe', '--exact-match', '--tags', 'HEAD']) || '').trim() || null);
  if (tag) return { ref: `tags/${tag}`, name: tag, release: true, url };
  const pointed = String(git(['symbolic-ref', '-q', '--short', `refs/remotes/${settings.remote}/HEAD`]) || '').trim();
  const name = settings.branch || (pointed.startsWith(`${settings.remote}/`) ? pointed.slice(settings.remote.length + 1) : '') || 'main';
  return { ref: `heads/${name}`, name, release: false, url };
}

/**
 * Ask the remote what that ref points at. `gh api` first when the remote is on GitHub (the board
 * already reads GitHub through gh), else `git ls-remote`. Both only read: nothing is written to
 * .git, so this can never collide with a pull.
 *   run(cmd, args) → { ok, out, err }
 */
export async function readRemoteRef({ target, slug = null, run, remote = 'origin', root = null }) {
  const isSha = (x) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(x || ''));
  if (slug) {
    const r = await run('gh', ['api', `repos/${slug}/commits/${target.name}`, '--jq', '.sha']);
    const sha = String(r?.out || '').trim();
    if (r?.ok && isSha(sha)) return sha;
  }
  const refs = target.release ? [`refs/${target.ref}^{}`, `refs/${target.ref}`] : [`refs/${target.ref}`];
  const r = await run('git', [...(root ? ['-C', root] : []), 'ls-remote', remote, ...refs]);
  if (!r?.ok) throw new Error(`the remote could not be read (${String(r?.err || 'git ls-remote failed').split('\n')[0].slice(0, 80)})`);
  const rows = String(r.out || '').split('\n').map((l) => l.split('\t')).filter((x) => isSha(x[0]));
  const row = rows.find((x) => String(x[1]).endsWith('^{}')) || rows[0];      // an annotated tag: the commit it names
  if (!row) throw new Error(`the remote has no ${target.ref}`);
  return row[0];
}

/**
 * The integrity part of the guardrails card: the files, the hook's registration and the port.
 * A registration or port problem is red whatever the files say: the gate is not being asked.
 * → { status: 'ok'|'warn'|'down'|'unknown', detail, state, changed, behind, problems }
 */
export function integrityCard({ files, registration = [], port = null, notes = [] }) {
  const problems = [...registration, ...(port ? [port] : [])];
  const base = { state: files?.state || 'unread', changed: files?.changed || [], behind: files?.behind || [], head: files?.head || null, newest: files?.newest || null, readAt: files?.readAt || null, problems, notes };
  // a note is said, never coloured: something the owner may want to do, not something wrong
  const said = (text) => [text, ...notes].filter(Boolean).join(' · ');
  if (problems.length) return { ...base, status: 'down', detail: said([problems.join(' · '), files?.status === 'down' ? files.detail : ''].filter(Boolean).join(' · ')) };
  return { ...base, status: files?.status || 'unknown', detail: said(files?.detail || 'gate files not checked') };
}

// ── the impure shell ────────────────────────────────────────────────────────
/**
 * createGateIntegrity({ root, files, git, readFile, readState, writeState, readRemoteHead, now, settings })
 *   root            the live checkout
 *   files           () → repo-relative paths of the gate's own files (the policy's gateCode list, expanded)
 *   git             (args) → stdout | null — runs git in `root` (read-only commands only)
 *   readRemoteHead  async () → sha — what the REMOTE says the default branch's head is (gh / ls-remote)
 * → { check() → the judgment + card fields, readRemote(force) }
 */
export function createGateIntegrity({ root, files, git, readFile, readState, writeState, readRemoteHead, now = () => Date.now(), settings = integritySettings(null) }) {
  const treeCache = new Map();           // commit → Map path → blob id (a commit never changes)
  const ancestorCache = new Map();       // `${a}..${b}` → boolean
  let state = null;
  let lastRead = 0;

  const load = async () => { state ||= { heads: [], passedAt: null, behindSince: null, behindOf: null, ...((await readState().catch(() => null)) || {}) }; return state; };
  // a commit that is in the repository stays there: only a "no" is asked again (it may be fetched later)
  const here = new Set();
  const has = (sha) => { if (here.has(sha)) return true; const yes = git(['cat-file', '-e', `${sha}^{commit}`]) !== null; if (yes) { if (here.size > 500) here.clear(); here.add(sha); } return yes; };
  const isAncestor = (a, b) => {
    if (!a || !b) return false;
    if (a === b) return true;
    const key = `${a}..${b}`;
    if (!ancestorCache.has(key)) { if (ancestorCache.size > 500) ancestorCache.clear(); ancestorCache.set(key, git(['merge-base', '--is-ancestor', a, b]) !== null); }
    return ancestorCache.get(key);
  };
  const treeOf = (commit, paths) => {
    if (!treeCache.has(commit)) {
      if (treeCache.size > 40) treeCache.clear();
      const out = git(['ls-tree', '-r', commit, '--', ...paths]);
      const m = new Map();
      for (const line of String(out || '').split('\n')) { const x = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line); if (x) m.set(x[2], x[1]); }
      treeCache.set(commit, m);
    }
    return treeCache.get(commit);
  };

  /** Ask the remote for its head: every `readEveryMinutes`, or now when `force` (a merge was just released). */
  async function readRemote(force = false) {
    const s = await load();
    if (!force && lastRead && now() - lastRead < settings.readEveryMinutes * 60e3) return s;
    lastRead = now();
    const iso = new Date(now()).toISOString();
    try {
      const sha = String(await readRemoteHead() || '').trim();
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) throw new Error('the remote gave no head');
      const next = noteHead(s, sha, iso);
      if (JSON.stringify(next.heads) !== JSON.stringify(s.heads) || s.readError) { state = next; await writeState(state).catch(() => {}); } else state = { ...next };
    } catch (e) { state = { ...s, readError: String(e.message || e).slice(0, 120), readErrorAt: iso }; }
    return state;
  }

  async function check() {
    const s = await readRemote(false);
    const head = String(git(['rev-parse', 'HEAD']) || '').trim();
    if (!head) return { status: 'unknown', state: 'unread', detail: 'gate files not checked: this is not a git checkout', changed: [], behind: [] };
    const paths = [...new Set(files())].sort();
    const algo = algoOf(head);
    const newest = newestHead(s);
    const newestHere = Boolean(newest) && has(newest);
    const known = (s.heads || []).map((h) => h.sha);
    const landed = known.includes(head) || known.some((h) => has(h) && isAncestor(head, h));
    const k = s.passedAt && has(s.passedAt) ? s.passedAt : null;
    const back = Boolean(k) && head !== k && isAncestor(head, k);
    const forward = !k || isAncestor(k, head);
    const atHead = treeOf(head, paths);
    const atNewest = newestHere ? treeOf(newest, paths) : null;
    const rows = [];
    for (const p of paths) {
      const buf = await readFile(p).catch(() => null);
      rows.push({ path: p, live: buf ? blobId(buf, algo) : null, atHead: atHead.get(p) ?? null, atNewest: atNewest ? (atNewest.get(p) ?? null) : undefined });
    }
    let commitsBehind = null;
    if (newestHere && newest !== head && isAncestor(head, newest)) commitsBehind = Number(String(git(['rev-list', '--count', `${head}..${newest}`]) || '').trim()) || null;
    const r = judge({ files: rows, head, newest, newestHere, landed, back, forward, state: s, now: now(), behindMinutes: settings.behindMinutes, commitsBehind });
    if (JSON.stringify(r.next) !== JSON.stringify(s)) { state = r.next; await writeState(state).catch(() => {}); }
    return { ...r, next: undefined, head, newest, readAt: s.readAt || null, readError: s.readError || null, files: paths.length };
  }
  return { check, readRemote, state: () => state };
}
