// Context-window gauge per agent session (Claude Code + Codex).
//
// Read-only against transcripts: we open each session's transcript, read only
// its TAIL (CONTEXT.tailBytes, default 256 KB — transcripts reach 150 MB), and
// take the last usage record. Results are cached per file by (size, mtime), so
// an idle session costs one stat() per poll.
//
// Claude: last main-thread `type:"assistant"` line's message.usage →
//   ctx = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//   window from config/models.json contextWindows (model id prefix match;
//   "[1m]" in the model string forces 1M). Current models (Opus 5.5 / 5,
//   Fable 5.1, Sonnet 5) are 1M; Haiku 4.5 is 200K. After /compact, until the
//   next turn: estimate from compact_boundary postTokens (`estimated: true`).
// Codex: last `token_count` event → info.last_token_usage.total_tokens vs
//   info.model_context_window (input_tokens already INCLUDES cached tokens —
//   don't add cached_input_tokens again). Codex writes a fresh token_count
//   right after its `compacted` event, so no estimate is needed there.
// Gemini CLI (#812): `~/.gemini/tmp/<dir>/chats/session-*.jsonl`, one JSON line per event; a `type:"gemini"` line
//   carries `tokens { input, cached, output, thoughts, tool, total }` and `model`. ctx = tokens.input (the prompt
//   sent, cached part included). A `$patch` line may remove earlier messages (`removeIds`): those never count.
//   `<dir>/.project_root` holds the folder, so a session is matched by the agent's folder (there is no cmux hook
//   map for Gemini); a session last written before the agent's `added_at` is not its own. The window comes ONLY from models.json `contextWindows` (a key the model id starts with,
//   never `default`): an unknown model shows no gauge. Two Gemini agents in one folder, or two session files there
//   written in the last 10 minutes, show no gauge rather than possibly the wrong one.
import { open, stat, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT, resolve as resolveConfig } from './config.mjs';

const CLAUDE_MAP = path.join(os.homedir(), '.cmuxterm', 'claude-hook-sessions.json');
const CODEX_MAP = path.join(os.homedir(), '.cmuxterm', 'codex-hook-sessions.json');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const GEMINI_TMP = path.join(os.homedir(), '.gemini', 'tmp');
export const GEMINI_BOTH_LIVE_MS = 10 * 60_000;   // two session files written this recently in one folder = no gauge

// ---- pure parsers (tested with fixture tails) ------------------------------------

/**
 * Last main-thread assistant usage in a Claude transcript tail — unless a
 * /compact (or auto-compaction) happened after it. A compaction writes a
 * `system`/`compact_boundary` line (compactMetadata.postTokens) plus the
 * isCompactSummary user message but NO assistant usage until the next turn,
 * so the last usage line is the pre-compaction size. In that case
 * return an estimate: postTokens, else the summary's chars/4, flagged
 * `estimated`/`compacted`; the next assistant turn replaces it with real usage.
 */
export function parseClaudeTail(text) {
  const lines = String(text).split('\n');
  let summaryChars = null;                                          // seen AFTER (below) any boundary we reach
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    const isUsage = l.includes('"assistant"') && l.includes('"usage"');
    const isCompact = l.includes('"compact_boundary"') || l.includes('"isCompactSummary"');
    if (!isUsage && !isCompact) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }       // first line of a tail is usually partial
    if (j.isSidechain) continue;
    if (j.type === 'user' && j.isCompactSummary) {
      const c = j.message?.content;
      summaryChars = typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
      continue;
    }
    if (j.type === 'system' && j.subtype === 'compact_boundary') {
      const post = j.compactMetadata?.postTokens;
      const tokens = post > 0 ? post : summaryChars != null ? Math.ceil(summaryChars / 4) : null;
      if (!tokens) continue;                                        // nothing to estimate from — fall back to older usage
      return { tokens, model: modelBefore(lines, i), at: j.timestamp ? Date.parse(j.timestamp) : null, estimated: true, compacted: true,
        preTokens: j.compactMetadata?.preTokens ?? null };
    }
    if (j.type !== 'assistant') continue;
    const u = j.message?.usage;
    if (!u) continue;
    const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!tokens) continue;                                          // synthetic/error turns carry zero usage
    return { tokens, model: j.message?.model || null, at: j.timestamp ? Date.parse(j.timestamp) : null };
  }
  return null;
}

// The compaction line carries no model; the window comes from the last assistant turn before it.
function modelBefore(lines, i) {
  for (let k = i - 1; k >= 0; k--) {
    if (!lines[k].includes('"assistant"') || !lines[k].includes('"model"')) continue;
    try { const j = JSON.parse(lines[k]); if (j.type === 'assistant' && !j.isSidechain && j.message?.model) return j.message.model; } catch { /* partial */ }
  }
  return null;
}

/** Last token_count event in a Codex rollout tail. */
export function parseCodexTail(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"token_count"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    const info = j.payload?.info || j.info || j.msg?.info;
    const last = info?.last_token_usage;
    if (!last || !info.model_context_window) continue;
    const tokens = last.total_tokens || ((last.input_tokens || 0) + (last.output_tokens || 0));
    return { tokens, window: info.model_context_window, at: j.timestamp ? Date.parse(j.timestamp) : null };
  }
  return null;
}

/** Last counted Gemini turn in a session tail: { tokens, model, at } or null. */
export function parseGeminiTail(text) {
  const lines = String(text).split('\n');
  const removed = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"removeIds"') && !(l.includes('"gemini"') && l.includes('"tokens"'))) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }      // a tail's first line is usually partial
    for (const id of j.$patch?.removeIds || []) removed.add(id);
    if (j.type !== 'gemini' || removed.has(j.id)) continue;
    const tokens = j.tokens?.input;
    if (!(tokens > 0)) continue;
    return { tokens, model: typeof j.model === 'string' ? j.model : null, at: j.timestamp ? Date.parse(j.timestamp) : null };
  }
  return null;
}

/** A Gemini model's window from the config map only: the longest key the id starts with; no default, no guess. */
export function geminiWindowFor(model, windows = {}) {
  const m = String(model || '');
  if (!m) return null;
  const keys = Object.keys(windows).filter((k) => k !== 'default' && m.startsWith(k)).sort((a, b) => b.length - a.length);
  const w = keys.length ? windows[keys[0]] : null;
  return Number.isFinite(w) && w > 0 ? w : null;
}

/** Context window for a Claude model id (prefix match in the config map). */
export function windowFor(model, windows = {}) {
  const m = String(model || '');
  if (/\[1m\]/i.test(m)) return 1_000_000;
  const keys = Object.keys(windows).filter((k) => k !== 'default' && m.startsWith(k)).sort((a, b) => b.length - a.length);
  return keys.length ? windows[keys[0]] : (windows.default || 1_000_000);
}

export function band(pct, { amberPct = CONTEXT.warnPct ?? CONTEXT.amberPct, redPct = CONTEXT.compactPct ?? CONTEXT.redPct } = {}) {
  return pct >= redPct ? 'red' : pct >= amberPct ? 'amber' : 'ok';
}

export function gauge({ tokens, window, model = null, source, at = null, estimated = false }) {
  const pct = Math.min(100, Math.round((tokens / window) * 100));
  const g = { ctxTokens: tokens, window, pct, band: band(pct), model, source, at };
  if (estimated) g.estimated = true;                                // post-compaction estimate (no turn yet)
  return g;
}

// ---- tail reader with (size, mtime) cache ------------------------------------------

const cache = new Map();   // path -> { size, mtimeMs, result }
export const readStats = { reads: 0, bytes: 0, statOnly: 0 };

async function tailOf(file, bytes = CONTEXT.tailBytes) {
  const st = await stat(file);
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { readStats.statOnly++; return { cached: true, result: hit.result }; }
  const fh = await open(file, 'r');
  try {
    const len = Math.min(bytes, st.size);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, st.size - len);
    readStats.reads++; readStats.bytes += len;
    return { cached: false, text: buf.toString('utf8'), st };
  } finally { await fh.close(); }
}

async function measure(file, parse) {
  const t = await tailOf(file);
  if (t.cached) return t.result;
  const result = parse(t.text);
  cache.set(file, { size: t.st.size, mtimeMs: t.st.mtimeMs, result });
  return result;
}

// ---- collectors ------------------------------------------------------------------------

/** The context gauge for one Claude transcript file (a session with no cmux workspace: src/sessions-plain.mjs). null when it cannot be read. */
export async function claudeGaugeForFile(file) {
  try {
    const r = await measure(file, parseClaudeTail);
    if (!r) return null;
    const models = await readJson(resolveConfig('config/models.json'));
    return gauge({ tokens: r.tokens, window: windowFor(r.model, models.contextWindows || {}), model: r.model, source: 'claude', at: r.at, estimated: !!r.estimated });
  } catch { return null; }
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; } }

/** Newest Codex rollout for a workspace: hook record first, else a unique cwd match. */
export function codexTranscriptFor(workspaceId, codexMap) {
  const recs = Object.values(codexMap.sessions || {})
    .filter((s) => s.workspaceId === workspaceId && s.transcriptPath)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return recs[0]?.transcriptPath || null;
}

async function codexByCwd(cwd, days = 3) {
  const out = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const dt = new Date(now - d * 86400e3);
    const dir = path.join(CODEX_SESSIONS, String(dt.getFullYear()), String(dt.getMonth() + 1).padStart(2, '0'), String(dt.getDate()).padStart(2, '0'));
    let files = [];
    try { files = await readdir(dir); } catch { continue; }
    for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
      const p = path.join(dir, f);
      try {
        const fh = await open(p, 'r');
        const buf = Buffer.alloc(4096);
        await fh.read(buf, 0, 4096, 0);
        await fh.close();
        const first = buf.toString('utf8').split('\n')[0];
        const meta = JSON.parse(first);
        if ((meta.payload?.cwd || meta.cwd) === cwd) out.push({ p, mtime: (await stat(p)).mtimeMs });
      } catch { /* not a rollout */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)[0]?.p || null;
}

/**
 * The newest Gemini session file for a folder, or null: no project for it, no session, or two session files
 * written within GEMINI_BOTH_LIVE_MS of now (two live sessions in one folder).
 */
export async function geminiSessionFor(folder, { tmp = GEMINI_TMP, now = Date.now(), since = 0 } = {}) {
  let dirs = [];
  try { dirs = await readdir(tmp); } catch { return null; }
  const want = path.resolve(folder);
  const files = [];
  for (const d of dirs) {
    let root;
    try { root = (await readFile(path.join(tmp, d, '.project_root'), 'utf8')).trim(); } catch { continue; }
    if (path.resolve(root) !== want) continue;
    const chats = path.join(tmp, d, 'chats');
    let names = [];
    try { names = await readdir(chats); } catch { continue; }
    for (const n of names.filter((x) => /^session-.*\.jsonl$/.test(x))) {
      try { files.push({ p: path.join(chats, n), mtime: (await stat(path.join(chats, n))).mtimeMs }); } catch { /* gone */ }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  if (!files.length) return null;
  if (files.length > 1 && now - files[1].mtime < GEMINI_BOTH_LIVE_MS) return null;
  // a session last written before the agent was registered is a previous session's
  if (files[0].mtime < since) return null;
  return files[0].p;
}

/**
 * Gauge per workspace for every Claude/Codex/Gemini agent in the directory.
 * Returns Map(workspaceId → gauge). Time-bounded by the caller's poll.
 */
export async function collectContext(entries, { geminiTmp = GEMINI_TMP, models: givenModels = null } = {}) {
  const [claudeMap, codexMap, models] = await Promise.all([
    readJson(CLAUDE_MAP), readJson(CODEX_MAP), givenModels || readJson(resolveConfig('config/models.json'))]);
  const windows = models.contextWindows || {};
  const out = new Map();
  const codexCwds = new Map();
  for (const a of entries) if (a.vendor === 'codex' && a.status !== 'closed') codexCwds.set(a.cwd, (codexCwds.get(a.cwd) || 0) + 1);
  const home = (p) => (p ? path.resolve(p.replace(/^~(?=\/|$)/, os.homedir())) : null);
  const geminiFolders = new Map();
  for (const a of entries) {
    const f = a.vendor === 'gemini' && a.status !== 'closed' ? home(a.cwd || a.repo) : null;
    if (f) geminiFolders.set(f, (geminiFolders.get(f) || 0) + 1);
  }

  await Promise.all(entries.map(async (a) => {
    if (!a.workspaceId || a.status === 'closed') return;
    try {
      if (a.vendor === 'claude') {
        const sid = claudeMap.activeSessionsByWorkspace?.[a.workspaceId]?.sessionId;
        const tp = sid && claudeMap.sessions?.[sid]?.transcriptPath;
        if (!tp) return;
        const r = await measure(tp, parseClaudeTail);
        if (r) out.set(a.workspaceId, gauge({ tokens: r.tokens, window: windowFor(r.model, windows), model: r.model, source: 'claude', at: r.at, estimated: !!r.estimated }));
      } else if (a.vendor === 'codex') {
        let tp = codexTranscriptFor(a.workspaceId, codexMap);
        const cwd = a.cwd ? a.cwd.replace(/^~/, os.homedir()) : null;
        if (!tp && cwd && codexCwds.get(a.cwd) === 1) tp = await codexByCwd(cwd);
        if (!tp) return;
        const r = await measure(tp, parseCodexTail);
        if (r) out.set(a.workspaceId, gauge({ tokens: r.tokens, window: r.window, source: 'codex', at: r.at }));
      } else if (a.vendor === 'gemini') {
        const f = home(a.cwd || a.repo);
        if (!f || geminiFolders.get(f) !== 1) return;              // two Gemini agents in one folder: no gauge
        const since = Date.parse(a.added_at || '') || 0;
        const tp = await geminiSessionFor(f, { tmp: geminiTmp, since });
        if (!tp) return;
        const r = await measure(tp, parseGeminiTail);
        const w = r && geminiWindowFor(r.model, windows);
        if (w) out.set(a.workspaceId, gauge({ tokens: r.tokens, window: w, model: r.model, source: 'gemini', at: r.at }));
      }
    } catch { /* transcript rotated/missing — no gauge this poll */ }
  }));
  return out;
}
