// Brain autopilot: the knowledge vault + per-repo code graphs, checked by the board.
//
// SETTINGS.brain turns it on (absent = off: no card, no tasks, the close gate is
// the plain checklist). Keys (all paths may start with ~):
//   vault        the notes vault (links.vault = a note path in it, or a vault commit URL/sha)
//   staleness    JSON written by the weekly vault staleness check:
//                { at, date, rows: [{ project, note, synced, latest, latestDir, sources, stale, days }] }
//   reposTsv     the graph registry (<tag>\t<repo path> per line)
//   rebuildLog   the graph hook's rebuild log (lines carry no timestamps)
//   requester / fallbackOwner   ledger names for filed tasks (default 'mission-control')
//   everyMinutes how often the poll looks (default 10)
//
// What it does, per pass (board poll, at most every `everyMinutes`):
// - one LOW-priority ledger task per stale project, owned by the agent whose repo
//   is the project's most recently active source dir (fallback: fallbackOwner).
//   Keyed on the project: while that task is live a newer report adds ONE comment
//   per report date instead of a second task; a task closed after the report was
//   written is not re-filed from that same report. Fresh again → one comment.
// - "Rebuild failed" lines in the rebuild log, stamped when first seen (24h window).
// - registered repos whose graph is older than their last non-graph commit.
// One card `brain:autopilot`: amber (warn) when any count is > 0, never red.
// Its own state lives in data/brain-state.json; it writes nothing else but tasks.
import { execFile } from 'node:child_process';
import { open, readFile, stat, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = fileURLToPath(new URL('../data/brain-state.json', import.meta.url));
const DAY = 24 * 3600e3;
export const GRAPH_GRACE_MS = 30 * 60e3;     // the hook's detached rebuild may take up to 600 s
const MAX_CREATES = 15;
const MAX_LOG_READ = 4 * 1024 * 1024;

export const home = (p) => (p ? String(p).replace(/^~(?=$|\/)/, os.homedir()) : p);
const norm = (p) => path.resolve(home(p)).replace(/\/+$/, '');

// ---------------------------------------------------------------- staleness → tasks

/** Agent that owns a stale project (pure). Most recently active dir first, then the
 * other source dirs; exact repo match beats a repo nested inside / around the dir. */
export function routeStale(row, agents, fallback = 'mission-control') {
  const live = (agents || []).filter((a) => a.repo && a.status !== 'closed' && a.kind !== 'worker');
  const dirs = [row.latestDir, ...(row.sources || [])].filter(Boolean).map(norm);
  for (const d of [...new Set(dirs)]) {
    const exact = live.find((a) => norm(a.repo) === d);
    if (exact) return exact.name;
    const near = live.find((a) => norm(a.repo).startsWith(d + '/') || d.startsWith(norm(a.repo) + '/'));
    if (near) return near.name;
  }
  return fallback;
}

const keyPrefix = (project) => `stale:${project}@`;
export const projectOf = (t) => (t?.source?.via === 'brain' && String(t.source.key || '').startsWith('stale:')
  ? String(t.source.key).slice(6).replace(/@[^@]*$/, '') : null);

/**
 * Ledger actions for one staleness report (pure).
 * → [{ kind: 'create', input } | { kind: 'comment', id, text, project, mark }]
 * `state.noted[project]` = last report date a comment was made for (stale or fresh).
 */
export function planStale(report, tasks, state = {}, { agents = [], requester = 'mission-control', fallback = 'mission-control', vault = '' } = {}) {
  if (!report?.rows?.length || !report.date) return [];
  const out = [];
  const noted = state.noted || {};
  const reportAt = Date.parse(report.at || `${report.date}T00:00:00Z`);
  const byProject = new Map();
  for (const t of tasks) { const p = projectOf(t); if (p) (byProject.get(p) || byProject.set(p, []).get(p)).push(t); }
  const LIVE = new Set(['open', 'claimed', 'in_progress', 'blocked', 'needs_approval']);
  let creates = 0;
  for (const row of report.rows) {
    const mine = byProject.get(row.project) || [];
    const live = mine.find((t) => LIVE.has(t.status));
    if (row.stale) {
      if (live) {
        const created = Date.parse(live.created_at);
        if (noted[row.project] !== report.date && !(created >= reportAt))
          out.push({ kind: 'comment', id: live.id, project: row.project, mark: report.date,
            text: `still stale in the ${report.date} staleness report: last-synced ${row.synced}, source activity ${row.latest} (${row.days}d behind)` });
        continue;
      }
      // closed after this report was written = handled; wait for the next report
      if (mine.some((t) => t.closed_at && Date.parse(t.closed_at) >= reportAt)) continue;
      if (creates >= MAX_CREATES) continue;
      creates++;
      const owner = routeStale(row, agents, fallback);
      const note = row.note || `${row.project}/${row.project}.md`;
      out.push({ kind: 'create', project: row.project, mark: report.date, input: {
        title: `vault stale: ${row.project} (${row.days}d behind)`,
        requester, owner, priority: 'low',
        source: { via: 'brain', key: `${keyPrefix(row.project)}${report.date}` },
        links: { vault: note, ...(row.latestDir ? { repo: row.latestDir } : {}) },
        body: `The ${report.date} vault staleness report: ${row.project} has source activity on ${row.latest}` +
          `${row.latestDir ? ` (${row.latestDir})` : ''}, ${row.days}d newer than its overview's last-synced (${row.synced}). ` +
          `Mirror what changed into ${vault ? `${vault}/` : ''}${note} per the vault guide (a dated "## Update" section + bump last-synced), ` +
          `then close with --vault "${note}" (the close gate checks the note was edited after this task was filed).`,
      } });
    } else if (live && live.source && noted[row.project] !== report.date && !(Date.parse(live.created_at) >= reportAt)) {
      out.push({ kind: 'comment', id: live.id, project: row.project, mark: report.date,
        text: `fresh in the ${report.date} staleness report (last-synced ${row.synced}) — close this task once the sync is done` });
    }
  }
  return out;
}

// ---------------------------------------------------------------- rebuild log

/** Scan new bytes of the rebuild log (pure over the text). The first look only sets
 * the cursor, so old failures stay quiet; a shrunk file restarts from 0. */
export function scanRebuild(prev = {}, { size, text = '', now = Date.now() }) {
  const st = { cursor: prev.cursor, failures: [...(prev.failures || [])] };
  if (st.cursor == null) return { ...st, cursor: size, needRead: null };
  if (size < st.cursor) st.cursor = 0;
  for (const m of String(text).matchAll(/Rebuild failed:?\s*(.*)/g)) st.failures.push({ at: now, why: m[1].trim().slice(0, 160) });
  st.failures = st.failures.filter((f) => now - f.at < 7 * DAY);
  return st;
}
export const recentFailures = (st, now = Date.now()) => (st?.failures || []).filter((f) => now - f.at < DAY);

async function readRebuild(file, prev, now) {
  let size;
  try { size = (await stat(file)).size; } catch { return prev || {}; }
  if (prev?.cursor == null) return scanRebuild(prev, { size, now });
  let from = size < prev.cursor ? 0 : prev.cursor;
  if (size - from > MAX_LOG_READ) from = size - MAX_LOG_READ;
  let text = '';
  if (size > from) {
    const fh = await open(file, 'r');
    try { const buf = Buffer.alloc(size - from); await fh.read(buf, 0, buf.length, from); text = buf.toString('utf8'); }
    finally { await fh.close(); }
  }
  return { ...scanRebuild({ ...prev, cursor: from }, { size, text, now }), cursor: size };
}

// ---------------------------------------------------------------- graph freshness

/** Registry lines → [{ tag, dir }] (pure). */
export function parseReposTsv(text) {
  return String(text || '').split('\n').map((l) => l.split('\t')).filter(([t, d]) => t && d && !t.startsWith('#'))
    .map(([tag, dir]) => ({ tag: tag.trim(), dir: dir.trim() }));
}

/** Is a repo's graph behind? (pure) `graphAt` = newest of graph.json / manifest.json
 * (a same-topology rebuild re-stamps manifest.json only); `commitAt` = the last commit
 * that the hook rebuilds for: outside graphify-out/ and not docs-only (see DOC_EXCLUDES). */
export function graphBehind({ graphAt, commitAt, now = Date.now() }) {
  if (!commitAt) return false;
  if (!graphAt) return now - commitAt > GRAPH_GRACE_MS;
  return graphAt < commitAt && now - commitAt > GRAPH_GRACE_MS;
}

const git = (dir, args, run = execFile) => new Promise((resolve) => {
  run('git', ['-C', dir, ...args], { timeout: 10000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
});
const mtime = async (f) => { try { return (await stat(f)).mtimeMs; } catch { return 0; } };

/** graphify's post-commit hook re-extracts CODE files only, so a commit touching nothing but
 * docs (CLAUDE.md, POLICY.md…) never moves graph.json and must not count as "behind" (#286). */
export const DOC_EXCLUDES = [':(exclude)graphify-out',
  ...['md', 'markdown', 'txt', 'rst'].map((ext) => `:(exclude,glob)**/*.${ext}`)];

/** Facts about one repo's graph: { dir, graphAt, commitAt, hook, behind }. */
export async function graphFacts(dir, { now = Date.now(), run } = {}) {
  const d = home(dir);
  const graphAt = Math.max(await mtime(path.join(d, 'graphify-out', 'graph.json')), await mtime(path.join(d, 'graphify-out', 'manifest.json')));
  const ct = Number(await git(d, ['log', '-1', '--format=%ct', '--', '.', ...DOC_EXCLUDES], run)) * 1000;
  const common = await git(d, ['rev-parse', '--path-format=absolute', '--git-common-dir'], run);
  let hook = false;
  if (common) { try { hook = (await readFile(path.join(common, 'hooks', 'post-commit'), 'utf8')).includes('graphify-hook-start'); } catch { /* none */ } }
  const commitAt = ct || 0;
  return { dir, graphAt: graphAt || 0, commitAt, hook, behind: graphBehind({ graphAt, commitAt, now }) };
}

// ---------------------------------------------------------------- close gate

/** A vault COMMIT given as links.vault (a commit URL or a bare sha) → the sha, else null (pure). */
export function vaultCommitOf(link) {
  const v = String(link || '').trim();
  const m = v.match(/^https?:\/\/\S+\/commit\/([0-9a-f]{7,40})\b/i) || v.match(/^([0-9a-f]{7,40})$/i);
  return m ? m[1].toLowerCase() : null;
}

/** Candidate absolute paths for a links.vault value (pure). */
export function vaultCandidates(link, vault) {
  const v = String(link || '').trim();
  if (!v) return [];
  const base = path.isAbsolute(home(v)) ? home(v) : path.join(home(vault), v);
  return /\.md$/i.test(base) ? [base] : [base, `${base}.md`];
}

/**
 * Verify the two brain items of a close (pure over the facts).
 * facts: { vaultNoteAt (ms|0|null when no link), graph: graphFacts|null (no repo) }
 * → { vault_synced: { ok, why }, graphify_updated: { ok, why } }
 */
export function judgeClose(task, facts, now = Date.now()) {
  const created = Date.parse(task.created_at);
  const res = {};
  if (!task.links?.vault) res.vault_synced = { ok: false, why: 'link the vault note you updated (--vault "<note>") or pass --no-vault "<reason>"' };
  else if (!facts.vaultNoteAt) res.vault_synced = { ok: false, why: `vault note or commit "${task.links.vault}" not found in the vault` };
  else if (facts.vaultNoteAt < created) res.vault_synced = { ok: false, why: `vault note "${task.links.vault}" was not edited since the task was filed — add a dated "## Update" section, or --no-vault "<reason>"` };
  else res.vault_synced = { ok: true, why: 'vault note edited during the task' };
  const g = facts.graph;
  if (!g) res.graphify_updated = { ok: true, why: 'no repo on the task — nothing to graph' };
  else if (!g.graphAt) res.graphify_updated = { ok: true, why: `no graph in ${g.dir}` };
  else if (!g.behind) res.graphify_updated = { ok: true, why: 'graph is current' };
  else if (g.hook && now - g.commitAt <= GRAPH_GRACE_MS) res.graphify_updated = { ok: true, why: 'hook rebuild in flight' };
  else res.graphify_updated = { ok: false, why: `graph in ${g.dir} is older than its last commit — run \`graphify update .\` there, or --no-graph "<reason>"` };
  return res;
}

/** Gather facts and judge a close (I/O). `agents` = the mesh directory. */
export async function verifyClose(task, { cfg, agents = [], now = Date.now(), run } = {}) {
  let vaultNoteAt = null;
  if (task.links?.vault) {
    vaultNoteAt = 0;
    const sha = vaultCommitOf(task.links.vault);
    // a vault commit counts by its commit time (agents that link the commit, not the note)
    if (sha) vaultNoteAt = Number(await git(home(cfg.vault), ['show', '-s', '--format=%ct', `${sha}^{commit}`], run)) * 1000 || 0;
    else for (const f of vaultCandidates(task.links.vault, cfg.vault)) { const m = await mtime(f); if (m) { vaultNoteAt = m; break; } }
  }
  const repo = task.links?.repo || agents.find((a) => a.name === task.owner)?.repo || null;
  const graph = repo ? await graphFacts(repo, { now, run }) : null;
  return judgeClose(task, { vaultNoteAt, graph }, now);
}

// ---------------------------------------------------------------- card + pass

export function readStateSync(file = STATE_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }

/** The board card (pure). */
export function brainCard(state, cfg, now = Date.now()) {
  if (!cfg) return null;
  const base = { label: 'brain:autopilot', name: 'Brain autopilot (vault + graphs)', domain: 'infra', schedule: `checked every ${cfg.everyMinutes || 10} min`, logAvailable: false };
  if (!state.lastRun) return { ...base, status: 'due', detail: 'no pass yet' };
  const stale = state.stale || [];
  const fails = recentFailures(state.rebuild, now);
  const behind = state.behind || [];
  const parts = [`stale ${stale.length}`, `rebuild fails ${fails.length}/24h`, `graphs behind ${behind.length}`];
  const more = [];
  if (stale.length) more.push(`stale: ${stale.map((s) => `${s.project}${s.task ? ` #${s.task}` : ''}`).join(', ')}`);
  if (fails.length) more.push(`last failure: ${fails[fails.length - 1].why}`);
  if (behind.length) more.push(`behind: ${behind.join(', ')}`);
  if (state.report && !state.reportOk) more.push(`staleness data: ${state.report}`);
  return { ...base, status: stale.length || fails.length || behind.length ? 'warn' : 'ok',
    detail: parts.join(' · ') + (more.length ? ` — ${more.join(' · ')}` : '') };
}

let busy = false;
/** One pass (board poll). `ledger` = createLedger(); `afterCreate(task)` wakes the owner. */
export async function maybeBrain({ cfg, ledger, agents = [], now = Date.now(), file = STATE_FILE, record = async () => {}, afterCreate = async () => {}, run } = {}) {
  if (!cfg || busy) return;
  const state = readStateSync(file);
  if (state.lastRun && now - state.lastRun < (cfg.everyMinutes || 10) * 60e3) return;
  busy = true;
  try {
    const next = { ...state, lastRun: now };
    // 1. staleness → ledger
    let report = null;
    try { report = JSON.parse(await readFile(home(cfg.staleness), 'utf8')); next.reportOk = true; next.report = report.date; }
    catch { next.reportOk = false; next.report = 'not written yet (waits for the next weekly check)'; }
    if (report && ledger) {
      const tasks = await ledger.list({});
      const acts = planStale(report, tasks, state, { agents, requester: cfg.requester || 'mission-control', fallback: cfg.fallbackOwner || 'mission-control', vault: cfg.vault });
      next.noted = { ...(state.noted || {}) };
      for (const a of acts) {
        try {
          if (a.kind === 'create') {
            const t = await ledger.create(a.input, now);
            if (!t.existing) { await afterCreate(t); await record('sys', `brain: vault stale — ${a.project} → task #${t.id} (${t.owner})`); }
          } else {
            await ledger.update(a.id, { op: 'comment', actor: 'board', text: a.text }, { now });
          }
          next.noted[a.project] = a.mark;
        } catch (e) { await record('sys', `brain: ${a.kind} for ${a.project} failed — ${e.message}`); }
      }
      const live = new Map((await ledger.list({})).filter((t) => projectOf(t) && !['done', 'cancelled'].includes(t.status)).map((t) => [projectOf(t), t.id]));
      next.stale = report.rows.filter((r) => r.stale).map((r) => ({ project: r.project, task: live.get(r.project) || null }));
    }
    // 2. rebuild failures
    if (cfg.rebuildLog) {
      const before = recentFailures(state.rebuild, now).length;
      next.rebuild = await readRebuild(home(cfg.rebuildLog), state.rebuild, now);
      const after = recentFailures(next.rebuild, now);
      if (after.length > before) await record('sys', `brain: graph rebuild failed — ${after[after.length - 1].why}`);
    }
    // 3. graphs behind
    if (cfg.reposTsv) {
      let repos = [];
      try { repos = parseReposTsv(await readFile(home(cfg.reposTsv), 'utf8')); } catch { /* no registry */ }
      const behind = [];
      for (const r of repos) { const f = await graphFacts(r.dir, { now, run }); if (f.behind) behind.push(r.tag); }
      next.behind = behind;
    }
    await writeFile(`${file}.tmp`, JSON.stringify(next, null, 1));
    await rename(`${file}.tmp`, file);
  } finally { busy = false; }
}
