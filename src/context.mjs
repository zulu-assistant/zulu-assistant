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
import { open, stat, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT, resolve as resolveConfig } from './config.mjs';

const CLAUDE_MAP = path.join(os.homedir(), '.cmuxterm', 'claude-hook-sessions.json');
const CODEX_MAP = path.join(os.homedir(), '.cmuxterm', 'codex-hook-sessions.json');
const CODEX_SESSIONS = path.join(os.homedir(), '.codex', 'sessions');

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

/** Context window for a Claude model id (prefix match in the config map). */
export function windowFor(model, windows = {}) {
  const m = String(model || '');
  if (/\[1m\]/i.test(m)) return 1_000_000;
  const keys = Object.keys(windows).filter((k) => k !== 'default' && m.startsWith(k)).sort((a, b) => b.length - a.length);
  return keys.length ? windows[keys[0]] : (windows.default || 1_000_000);
}

export function band(pct, { amberPct = CONTEXT.amberPct, redPct = CONTEXT.redPct } = {}) {
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
 * Gauge per workspace for every Claude/Codex agent in the directory.
 * Returns Map(workspaceId → gauge). Time-bounded by the caller's poll.
 */
export async function collectContext(entries) {
  const [claudeMap, codexMap, models] = await Promise.all([
    readJson(CLAUDE_MAP), readJson(CODEX_MAP), readJson(resolveConfig('config/models.json'))]);
  const windows = models.contextWindows || {};
  const out = new Map();
  const codexCwds = new Map();
  for (const a of entries) if (a.vendor === 'codex' && a.status !== 'closed') codexCwds.set(a.cwd, (codexCwds.get(a.cwd) || 0) + 1);

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
      }
    } catch { /* transcript rotated/missing — no gauge this poll */ }
  }));
  return out;
}
