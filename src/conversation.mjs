// Conversation view (graphical mode, level 2 step 1): the last turns of one agent session, read-only.
//
// What it is: GET /api/conversation?session=<id> and the page /?conversation=<id>. The owner sees what was
// said to an agent and what it answered without switching to the terminal. Nothing can be sent from it.
//
// Where the text comes from: the END of the session's own Claude Code transcript (the file the context
// gauge already reads): one megabyte, widened to at most sixteen when that holds too few turns. Only two kinds of line are read, `user` and `assistant` on the main thread; every
// other kind (requests, attachments, snapshots, helper-agent lines) is ignored by an allow list.
//
// What is shown:
//   - text said to the agent, with the harness's own reminder blocks removed
//   - the agent's text
//   - one line per tool call: the tool's name and, when the call carries one, the agent's own short
//     description of it. NEVER the command, a file's contents, any other input, or a tool's result.
// Every paragraph and every description goes through the secret check (src/secret-text.mjs); a paragraph
// that looks like a credential is withheld, the rest of the message stays.
//
// The text is untrusted (an agent wrote it, or a web page it read did). This module only cuts and withholds;
// the page escapes it and shows it as plain text, on a page of its own that carries no decision token.
//
// The session id is the only input. The transcript's path comes from this machine's own session records and
// must lie inside the transcripts folder; a path is never taken from the request.
//
// Switch: SETTINGS.conversationView { mode: 'on' | 'off' } (absent = off: no page, no route).
import { open, stat, readFile, readdir, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containsSecret } from './secret-text.mjs';
import { transcriptFor, REGISTRY_DIR } from './sessions-plain.mjs';

export const conversationMode = (cfg) => (cfg?.mode === 'on' ? 'on' : 'off');
export const WITHHELD = '[withheld: looks like a secret]';
// How much of the end of the file is read. A session that works with tools writes large lines (results, request
// copies), so the last megabyte can hold a single answer and no question: the read is widened, in steps, until it
// holds enough turns and something said to the agent, or the whole file, or the last step.
export const TAIL_STEPS = [1, 4, 16].map((mb) => mb * 1024 * 1024);
export const ENOUGH_ENTRIES = 8;
export const MAX_ENTRIES = 40;
export const MAX_TEXT = 6000;         // characters of one message
export const MAX_NOTE = 160;          // characters of one tool description
export const COMPACTED = 'The session was compacted here: what came before is a summary the agent keeps.';

/** A session id as Claude Code writes it (a UUID), or a demo board's id. Nothing with a slash or a dot. */
export const validSessionId = (id) => /^[A-Za-z0-9][A-Za-z0-9-]{3,63}$/.test(String(id ?? ''));

// ---- pure: text ---------------------------------------------------------------------

/** One message as it may be shown: a secret-looking paragraph withheld, then cut to `max`. */
export function safeMessage(text, max = MAX_TEXT) {
  const paras = String(text ?? '').replace(/\r\n?/g, '\n').split(/\n{2,}/)
    .map((p) => p.replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((p) => (containsSecret(p) ? WITHHELD : p));
  const out = paras.join('\n\n');
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/** A tool call's one line: its name, and the agent's own description when the call has one. */
export function toolPart(block) {
  const raw = String(block?.name ?? '');
  const name = /^[\w:.-]{1,80}$/.test(raw) ? raw : 'a tool';
  const d = block?.input && typeof block.input.description === 'string' ? block.input.description.replace(/\s+/g, ' ').trim() : '';
  const note = !d ? '' : containsSecret(d) ? WITHHELD : d.length > MAX_NOTE ? `${d.slice(0, MAX_NOTE - 1)}…` : d;
  return { kind: 'tool', name, note };
}

/** What was said to the agent, without the harness's own blocks. '' = nothing a person or an agent said. */
export function cleanUserText(text) {
  let t = String(text ?? '');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  const cmd = t.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([\s\S]*?)<\/command-args>/);
    return `${cmd[1].trim()}${args && args[1].trim() ? ` ${args[1].trim()}` : ''}`;
  }
  // output of a local command, a background task's notice: the harness speaking, not a person
  if (/^\s*<(local-command-[a-z]+|task-notification|command-message)\b/.test(t)) return '';
  return t.trim();
}

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n\n') : '');

// ---- pure: the tail → entries ---------------------------------------------------------

/**
 * The entries of a transcript tail, oldest first, at most `limit` (the newest).
 *   { role: 'user', via: 'mesh' | 'typed', at, text }
 *   { role: 'agent', at, parts: [{ kind: 'text', text } | { kind: 'tool', name, note }] }
 *   { role: 'note', at, text }                      a compaction
 * Lines the agent wrote one after another are one entry. → { entries, cut }: cut = older entries were left out.
 */
export function parseConversation(text, { limit = MAX_ENTRIES } = {}) {
  const entries = [];
  let agent = null;
  const closeAgent = () => { agent = null; };
  for (const l of String(text ?? '').split('\n')) {
    // cheap test first: most lines of a transcript are neither kind
    if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"') && !l.includes('"type": "user"') && !l.includes('"type": "assistant"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }         // the first line of a tail is usually partial
    if (!j || j.isSidechain) continue;                             // a helper agent's own thread
    const at = typeof j.timestamp === 'string' && !Number.isNaN(Date.parse(j.timestamp)) ? j.timestamp : null;
    if (j.type === 'user') {
      if (j.isCompactSummary) { closeAgent(); entries.push({ role: 'note', at, text: COMPACTED }); continue; }
      if (j.isMeta) continue;
      const c = j.message?.content;
      if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) continue;     // a tool's result: never shown
      const said = safeMessage(cleanUserText(textOf(c)));
      if (!said) continue;
      closeAgent();
      entries.push({ role: 'user', via: /^\[mesh\]/.test(said) ? 'mesh' : 'typed', at, text: said });
    } else if (j.type === 'assistant') {
      const c = j.message?.content;
      if (!Array.isArray(c)) continue;
      const parts = [];
      for (const b of c) {
        if (b?.type === 'text' && typeof b.text === 'string') { const t = safeMessage(b.text); if (t) parts.push({ kind: 'text', text: t }); }
        else if (b?.type === 'tool_use') parts.push(toolPart(b));
        // thinking and every other block: not shown
      }
      if (!parts.length) continue;
      if (agent) { agent.parts.push(...parts); if (at) agent.at = at; }
      else { agent = { role: 'agent', at, parts }; entries.push(agent); }
    }
  }
  const cut = entries.length > limit;
  return { entries: cut ? entries.slice(-limit) : entries, cut };
}

// ---- where a session's transcript is ------------------------------------------------------

const readJson = async (file) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; } };

/**
 * The transcript file of a Claude session, from this machine's own records: the cmux session map when
 * there is one, else Claude Code's per-process registry. → path | null. The id is compared, never joined
 * into a path.
 */
export async function transcriptOf(id, { cmuxMap = null, registryDir = REGISTRY_DIR, home = os.homedir() } = {}) {
  if (!validSessionId(id)) return null;
  const map = cmuxMap ? await readJson(cmuxMap) : null;
  const viaMap = map?.sessions && Object.prototype.hasOwnProperty.call(map.sessions, id) ? map.sessions[id]?.transcriptPath : null;
  if (typeof viaMap === 'string' && viaMap) return viaMap;
  let files = [];
  try { files = await readdir(registryDir); } catch { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const d = await readJson(path.join(registryDir, f));
    if (d && String(d.sessionId) === String(id) && d.cwd) return transcriptFor(home, String(d.cwd), String(d.sessionId));
  }
  return null;
}

/** Is this file a transcript inside the transcripts folder (links resolved)? → its real path | null */
export async function insideTranscripts(file, root = path.join(os.homedir(), '.claude', 'projects')) {
  try {
    if (!String(file).endsWith('.jsonl')) return null;
    const [real, base] = await Promise.all([realpath(file), realpath(root)]);
    return real.startsWith(base + path.sep) && real.endsWith('.jsonl') ? real : null;
  } catch { return null; }
}

// ---- the reader -----------------------------------------------------------------------------

/**
 * createConversations({ cmuxMap, registryDir, home, root, steps }) → { read(id) }
 * read → { ok: true, session, entries, cut, partial, at } | { ok: false, why: 'bad-id' | 'not-found' | 'unreadable' }
 *   cut      older entries were left out (the limit)
 *   partial  the file is longer than the tail that was read
 *   at       the transcript's last write (ISO)
 * One parse per (size, mtime) of a file; a handful of sessions kept.
 */
export function createConversations({ cmuxMap = null, registryDir = REGISTRY_DIR, home = os.homedir(), root = path.join(home, '.claude', 'projects'), steps = TAIL_STEPS, limit = MAX_ENTRIES } = {}) {
  const cache = new Map();   // real path → { size, mtimeMs, result }
  async function read(id) {
    if (!validSessionId(id)) return { ok: false, why: 'bad-id' };
    const named = await transcriptOf(id, { cmuxMap, registryDir, home });
    const file = named ? await insideTranscripts(named, root) : null;
    if (!file) return { ok: false, why: 'not-found' };
    try {
      const st = await stat(file);
      const hit = cache.get(file);
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { ...hit.result, session: id };
      let entries = []; let cut = false; let len = 0;
      const fh = await open(file, 'r');
      try {
        for (const step of steps) {
          len = Math.min(step, st.size);
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, st.size - len);
          ({ entries, cut } = parseConversation(buf.toString('utf8'), { limit }));
          if (len === st.size || (entries.length >= ENOUGH_ENTRIES && entries.some((e) => e.role === 'user'))) break;
        }
      } finally { await fh.close(); }
      const result = { ok: true, entries, cut, partial: st.size > len, at: new Date(st.mtimeMs).toISOString() };
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, result });
      return { ...result, session: id };
    } catch { return { ok: false, why: 'unreadable' }; }
  }
  return { read };
}

export const WHY = {
  'bad-id': 'that is not a session id',
  'not-found': 'no transcript was found for that session (only Claude Code sessions on this Mac are shown)',
  unreadable: 'the transcript could not be read',
};

// ---- demo mode: a fixed conversation, nothing of this machine read ---------------------------
export function demoConversation(id, now = Date.now()) {
  const t = (min) => new Date(now - min * 60e3).toISOString();
  return {
    ok: true, session: String(id), cut: false, partial: false, at: t(1),
    entries: [
      { role: 'user', via: 'mesh', at: t(14), text: '[mesh] from coordinator (task #12): the nightly export failed twice. Find out why and fix it.' },
      { role: 'agent', at: t(12), parts: [
        { kind: 'text', text: 'Looking at the export job\'s last two runs.' },
        { kind: 'tool', name: 'Bash', note: 'Show the last lines of the export log' },
        { kind: 'tool', name: 'Read', note: '' },
        { kind: 'text', text: 'Both runs stopped at the same row: a date with no year. The parser takes it for an error and exits.' },
      ] },
      { role: 'user', via: 'typed', at: t(8), text: 'Skip such rows and count them, do not stop the run.' },
      { role: 'agent', at: t(2), parts: [
        { kind: 'tool', name: 'Edit', note: '' },
        { kind: 'tool', name: 'Bash', note: 'Run the export tests' },
        { kind: 'text', text: 'Done. Rows without a year are skipped and counted in the summary line. The tests pass (14 of 14). I have not re-run the export against production: that needs your approval.' },
      ] },
    ],
  };
}
