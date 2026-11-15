// Sessions without cmux (1.3, a lighter first hour): the board's first screen shows your own Claude
// Code sessions, read-only, on a Mac that has no cmux at all.
//
// With cmux, session tiles come from cmux's hook file. Without it, Claude Code's own per-process
// registry (~/.claude/sessions/<pid>.json) says which sessions are alive, where, under what name and
// whether each is busy or idle; the transcript tail gives the context gauge. Nothing is written and
// no session is touched: these tiles cannot be messaged, dispatched to or healed.
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const REGISTRY_DIR = path.join(os.homedir(), '.claude', 'sessions');
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Claude Code's status word → the lifecycle the tiles draw. */
export function lifecycleOf(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'busy' || s === 'running' || s === 'working') return 'running';
  if (s === 'idle') return 'idle';
  if (/wait|input|permission|blocked/.test(s)) return 'needsInput';
  return 'unknown';
}

/** Where Claude Code keeps a session's transcript: ~/.claude/projects/<cwd, every non-alphanumeric as "-">/<session id>.jsonl */
export const transcriptFor = (home, cwd, sessionId) => path.join(home, '.claude', 'projects', String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`);

/**
 * Live sessions from the registry, in the shape the session tiles use.
 * `gaugeFor(transcriptPath)` (optional) adds the context gauge. Pure apart from the reads; tests
 * pass a fixture folder and their own `alive`.
 */
export async function plainSessions({ dir = REGISTRY_DIR, home = os.homedir(), alive = pidAlive, gaugeFor = null, limit = 24 } = {}) {
  let files = [];
  try { files = await readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d = null;
    try { d = JSON.parse(await readFile(path.join(dir, f), 'utf8')); } catch { continue; }   // half-written: next poll
    if (!d || !d.sessionId || !d.pid || !alive(d.pid)) continue;
    const cwd = String(d.cwd || '');
    const s = {
      id: String(d.sessionId),
      lifecycle: lifecycleOf(d.status),
      cwd: home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
      workspace: String(d.name || path.basename(cwd) || 'session').slice(0, 80),
      workspaceId: '',                       // no cmux workspace: nothing can be sent to this tile
      note: '',
      active: true,
      updatedAt: Number(d.statusUpdatedAt || d.updatedAt || d.startedAt || 0),
      source: 'claude-registry',
    };
    if (gaugeFor) { try { const g = await gaugeFor(transcriptFor(home, cwd, s.id)); if (g) s.ctx = g; } catch { /* no transcript yet */ } }
    out.push(s);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
