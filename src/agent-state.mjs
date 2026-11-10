// Status taxonomy (Zulu 1.1): what each agent is doing, WHERE that came from, and how sure we are.
//   state:      working | input | idle | stopped | unknown
//   source:     reported:hook (the cmux hook sessions files) | inferred:screen (a read-screen classified
//               by classifyScreen) | none
//   confidence: high | low | none, plus age (seconds since the evidence) and why (one short line)
// Rules: a hook report counts only while its pid is alive and is the same process (start time
// matches); idle / needsInput are stable for the pid's life; running goes low after
// runningFreshMinutes. A recognised screen dialog beats a hook idle (prompts are urgent): one read
// is enough, low until a second read agrees. Neither fresh → unknown, with the reason. No agent
// state is ever "done" — only a ledger close is. Display + API only: delivery, the context
// autopilot and heal-restore keep their own classifiers. A dead pid is shown, never acted on.

export const STATES = ['working', 'input', 'idle', 'stopped', 'unknown'];
const SCREEN_TO_STATE = { busy: 'working', dialog: 'input', ready: 'idle', shell: 'stopped', draft: 'idle' };
const LIFECYCLE_TO_STATE = { running: 'working', idle: 'idle', needsInput: 'input' };
const mins = (s) => `${Math.max(1, Math.round(s / 60))}m`;

/** The newest hook entry for a workspace across both hook files → { lifecycle, updatedAt, pid, pidStart, sessionId } | null. */
export function hookFor(ws, { claude = {}, codex = {} } = {}) {
  const cands = [];
  const sid = claude.activeSessionsByWorkspace?.[ws]?.sessionId;
  const c = sid && claude.sessions?.[sid];
  if (c) cands.push(c);
  for (const s of Object.values(codex.sessions || {})) if (s.workspaceId === ws) cands.push(s);
  const best = cands.filter((s) => s.agentLifecycle).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  return best ? { lifecycle: best.agentLifecycle, updatedAt: best.updatedAt || null, pid: best.pid || null, pidStart: best.pidStartSeconds || null, sessionId: best.sessionId || null } : null;
}

/** Is the hook's pid the same live process? procs: Map pid → start (epoch seconds). → alive | dead | recycled | unknown */
export function pidCheck(hook, procs) {
  if (!hook?.pid || !procs) return 'unknown';
  const start = procs.get(Number(hook.pid));
  if (start == null) return 'dead';
  if (hook.pidStart && Math.abs(start - hook.pidStart) > 2) return 'recycled';
  return 'alive';
}

/** Does this agent's state need a screen read? (Claude with a fresh hook does not — its prompts are in the hook.) */
export function needsScreen(a, hook, pid, { now = Date.now(), runningFreshMinutes = 20 } = {}) {
  if (a.vendor === 'codex') return true;                       // codex approval dialogs are only on screen
  if (!hook || pid !== 'alive') return true;
  if (!LIFECYCLE_TO_STATE[hook.lifecycle]) return true;        // e.g. Codex "unknown" after a reboot: the hook can't answer
  return hook.lifecycle === 'running' && hook.updatedAt && now / 1000 - hook.updatedAt > runningFreshMinutes * 60;
}

function fromScreen(screen, now, extraWhy = '') {
  if (!screen || !SCREEN_TO_STATE[screen.state]) return null;
  const state = screen.state === 'draft' && screen.busy ? 'working' : SCREEN_TO_STATE[screen.state];
  const why = [screen.state === 'draft' ? 'draft in the input box' : `screen reads ${screen.state}`, screen.agree ? 'two reads agree' : 'one read', extraWhy].filter(Boolean).join(' · ');
  return { state, source: 'inferred:screen', confidence: screen.agree ? 'high' : 'low', age: Math.round((now - screen.at) / 1000), why };
}

/** The pure rule table. hook from hookFor, pid from pidCheck, screen = { state, busy?, at, agree } | null. */
export function agentState({ hook = null, pid = 'unknown', screen = null, now = Date.now(), runningFreshMinutes = 20 } = {}) {
  const dialog = screen?.state === 'dialog' ? fromScreen(screen, now) : null;
  if (hook && pid === 'alive') {
    const age = hook.updatedAt ? Math.round(now / 1000 - hook.updatedAt) : null;
    const state = LIFECYCLE_TO_STATE[hook.lifecycle];
    if (!state) {
      const hw = hook.lifecycle === 'unknown' ? 'hook reports lifecycle unknown' : `hook lifecycle "${hook.lifecycle}" not recognised`;
      return fromScreen(screen, now, hw) || { state: 'unknown', source: 'none', confidence: 'none', age, why: `${hw}, no screen read` };
    }
    if (dialog && state !== 'input') return { ...dialog, why: `${dialog.why} · hook says ${hook.lifecycle}` };
    if (state === 'working' && age != null && age > runningFreshMinutes * 60) {
      const s = fromScreen(screen, now, `hook said running ${mins(age)} ago`);
      if (s && s.state !== 'unknown') return s;
      return { state: 'working', source: 'reported:hook', confidence: 'low', age, why: `running? (reported ${mins(age)} ago)` };
    }
    return { state, source: 'reported:hook', confidence: 'high', age, why: `hook: ${hook.lifecycle}` };
  }
  const pidWhy = hook ? (pid === 'dead' ? `hook pid ${hook.pid} is gone` : pid === 'recycled' ? `hook pid ${hook.pid} is another process now` : 'hook pid not checked') : 'no hook entry';
  const s = fromScreen(screen, now, pidWhy);
  if (s) return s;
  if (hook && (pid === 'dead' || pid === 'recycled')) return { state: 'stopped', source: 'reported:hook', confidence: 'high', age: hook.updatedAt ? Math.round(now / 1000 - hook.updatedAt) : null, why: pidWhy };
  return { state: 'unknown', source: 'none', confidence: 'none', age: null, why: `${pidWhy}; ${screen ? `screen not recognised (${screen.state})` : 'no screen read'}` };
}

/**
 * Bounded screen reads: at most `cap` reads per pass, a result cached for `ttlMs`, the
 * stalest first. agree = this read matches the previous one. → { results: Map ws → screen, reads }.
 */
export function createScreenReader({ read, classify, cap = 8, ttlMs = 120000 }) {
  const cache = new Map();   // ws → { state, busy, at, agree }
  return {
    cache,
    async refresh(wants, now = Date.now()) {
      const due = wants.filter((ws) => !cache.has(ws) || now - cache.get(ws).at >= ttlMs)
        .sort((a, b) => (cache.get(a)?.at || 0) - (cache.get(b)?.at || 0)).slice(0, cap);
      let reads = 0;
      for (const ws of due) {
        reads++;
        const r = await read(ws).catch((e) => ({ err: e.message }));
        const c = r?.err ? { state: 'unreadable' } : classify(r.out);
        const prev = cache.get(ws);
        cache.set(ws, { state: c.state, busy: Boolean(c.busy), at: now, agree: Boolean(prev && prev.state === c.state && now - prev.at < ttlMs * 3) });
      }
      for (const ws of [...cache.keys()]) if (!wants.includes(ws)) cache.delete(ws);
      return { results: new Map(wants.filter((ws) => cache.has(ws)).map((ws) => [ws, cache.get(ws)])), reads };
    },
  };
}

/** Parse `ps -A -o pid=,lstart=` → Map pid → start epoch seconds (local time). */
export function parseProcStarts(text) {
  const m = new Map();
  for (const line of String(text || '').split('\n')) {
    const x = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!x) continue;
    const t = Date.parse(x[2]);
    if (!Number.isNaN(t)) m.set(Number(x[1]), Math.round(t / 1000));
  }
  return m;
}

/**
 * Observe-mode ticker lines: an agent whose SOURCE changed or that went unknown, at most one line per
 * agent per `everyMs`. last: Map name → { source, state, at }. Mutates `last`; returns the lines.
 */
export function observeLines(rows, last, { now = Date.now(), everyMs = 600000 } = {}) {
  const out = [];
  for (const r of rows) {
    const prev = last.get(r.name);
    const changed = !prev || prev.source !== r.state.source || (r.state.state === 'unknown' && prev.state !== 'unknown');
    if (!changed) continue;
    if (prev && now - prev.loggedAt < everyMs) { last.set(r.name, { ...prev, source: r.state.source, state: r.state.state }); continue; }
    const say = prev || r.state.state === 'unknown' || r.state.source === 'inferred:screen';
    if (say) out.push(`status (observe): ${r.name} ${r.state.state}${r.state.confidence === 'low' ? '?' : ''} · ${r.state.source} · ${r.state.why}`.slice(0, 200));
    // a quiet first sighting does not use up the agent's line budget
    last.set(r.name, { source: r.state.source, state: r.state.state, loggedAt: say ? now : (prev?.loggedAt ?? -Infinity) });
  }
  return out;
}

/** Glyph + label for display (identity never colour alone). Low confidence gets a "?". */
const VIEW = {
  working: { glyph: '◉', label: 'WORKING', color: '#00E5E5' },
  input:   { glyph: '▲', label: 'INPUT',   color: '#E5E500' },
  idle:    { glyph: '○', label: 'IDLE',    color: '#00A600' },
  stopped: { glyph: '■', label: 'STOPPED', color: '#7A7A7A' },
  unknown: { glyph: '?', label: 'UNKNOWN', color: '#B8A000' },
};
export function stateView(s) {
  if (!s) return null;
  const v = VIEW[s.state] || VIEW.unknown;
  const unsure = s.confidence === 'low' && s.state !== 'unknown';
  return { glyph: unsure ? '◌' : v.glyph, label: `${v.label}${unsure ? '?' : ''}`, color: v.color, inferred: s.source === 'inferred:screen', tip: `${s.source} · ${s.confidence}${s.age != null ? ` · ${mins(s.age)} old` : ''} · ${s.why}` };
}

/** SETTINGS.statusTaxonomy → off | observe | on for one agent. */
export function taxonomyMode(cfg, name) {
  const mode = cfg?.mode || 'off';
  if (mode === 'off') return 'off';
  if (Array.isArray(cfg.only) && cfg.only.length && !cfg.only.includes(name)) return 'off';
  return mode === 'on' ? 'on' : 'observe';
}
