// Release drift: public-eligible code that sits committed here but unshipped.
//
// SETTINGS.releaseDrift = { repo: 'owner/name', everyHours: 6, amberDays: 3, owner: '<agent>',
//   minViewsPerDay, unposted: [...], queued: [...] } turns it on (null = off). Every `everyHours`
// the board compares the publish set of this repo's committed HEAD (the same classify/publicPairs
// that scripts/publish.mjs copies) with the git tree of the public repo's newest release, by blob
// sha (files are published verbatim, so equal content = equal sha). Result: changed / added /
// removed public paths and the oldest private commit since that release that touches them.
//
// It shows as one `release:drift` card (cloud; amber once drift is older than `amberDays`, never
// red, never on the alert ladder), one line in the digest's GITHUB section, and one ledger task per
// drift episode (owner = cfg.owner, blocked on the owner of the board) that lists the unshipped
// files, the newest private commits and `queued` (small changes waiting for any release). It is
// commented on only when the file set changes; the release closes it, and when drift returns to
// zero the board cancels it as its requester ("shipped in <tag>") as a backstop.
// Read-only: git in this repo + GETs through your gh login. Writes its state file and the ledger.
import { execFile } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, publicPairs } from '../scripts/publish.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = path.join(ROOT, 'data/release-drift-state.json');
const RETRY_MS = 3600e3;
const STALE_MS = 24 * 3600e3;
const DAY = 864e5;
const LIST_MAX = 40;

const sh = (run, cmd, args, opts = {}) => new Promise((resolve, reject) => {
  run(cmd, args, { timeout: 30000, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
    (err ? reject(new Error(String(stderr || err.message).trim().split('\n')[0].slice(0, 120))) : resolve(String(stdout || ''))));
});

/** `git ls-tree -r <ref>` output → Map(path → blob sha), regular files only (pure). */
export function parseLsTree(text) {
  const out = new Map();
  for (const line of String(text).split('\n')) {
    const m = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (m && m[1] !== '120000') out.set(m[3], m[2]);
  }
  return out;
}

/** Publish set of a private tree: Map(public path → { src, sha }) (pure). */
export function publishSet(privTree, manifest) {
  const c = classify([...privTree.keys()], manifest);
  return new Map(publicPairs(c).map(([src, dst]) => [dst, { src, sha: privTree.get(src) }]));
}

/** Diff the publish set against the public tree (Map path → sha) (pure). */
export function diffTrees(pub, remote) {
  const changed = []; const added = []; const removed = [];
  for (const [p, { sha }] of pub) {
    if (!remote.has(p)) added.push(p); else if (remote.get(p) !== sha) changed.push(p);
  }
  for (const p of remote.keys()) if (!pub.has(p)) removed.push(p);
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

export const driftFiles = (d) => [...d.changed, ...d.added, ...d.removed];

/** `git log --format=%ct%x09%s` lines (newest first) → [{at, subject}] (pure). */
export function parseLog(text) {
  return String(text).split('\n').map((l) => /^(\d+)\t(.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ at: Number(m[1]) * 1000, subject: m[2] }));
}

/** Group paths by their top directory for the ledger body (pure). */
export function groupFiles(files) {
  const g = new Map();
  for (const f of files) { const k = f.includes('/') ? `${f.split('/')[0]}/` : '(root)'; g.set(k, [...(g.get(k) || []), f]); }
  return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** True when every one of the last 7 full days had fewer than `min` views (pure). */
export function quietWeek(stats, repo, min, now = Date.now()) {
  if (!min) return false;
  const r = stats?.repos?.[repo];
  if (!r?.views || !r.since) return false;
  const first = now - 7 * DAY;
  if (Date.parse(`${r.since}T00:00:00Z`) > first - DAY) return false;     // need a full week of history
  for (let i = 1; i <= 7; i++) { const d = day(now - i * DAY); if ((r.views[d]?.count ?? 0) >= min) return false; }
  return true;
}

/** The board card (pure). */
export function driftCard(state, cfg, now = Date.now()) {
  if (!cfg?.repo) return null;
  const base = { label: 'release:drift', name: `Public edition vs ${cfg.repo.split('/').pop()}`, domain: 'cloud',
    schedule: `checked every ${cfg.everyHours || 6}h`, logAvailable: false };
  if (!state?.lastOk) return { ...base, status: 'due', detail: state?.lastError ? `no reading yet — ${state.lastError}` : 'no reading yet (gh api, your login)' };
  const n = state.files?.length || 0;
  const stale = now - state.lastOk > STALE_MS;
  const tail = stale ? ` · last reading ${Math.round((now - state.lastOk) / 36e5)}h ago${state.lastError ? ` — ${state.lastError}` : ''}` : '';
  if (!n) return { ...base, status: stale ? 'stale' : 'ok', detail: `public edition = ${state.tag} (identical)${tail}` };
  const ageDays = Math.floor((now - state.oldestAt) / DAY);
  const amber = now - state.oldestAt > (cfg.amberDays ?? 3) * DAY;
  return {
    ...base, status: stale ? 'stale' : amber ? 'warn' : 'ok',
    detail: `${plural(n, 'file')} behind ${state.tag}, oldest change ${day(state.oldestAt)} (${ageDays}d)` +
      (state.oldestSubject ? ` — ${state.oldestSubject.slice(0, 80)}` : '') +
      (state.episode?.task ? ` · ask #${state.episode.task}` : amber ? '' : ' · not amber yet') + tail,
  };
}

/** Digest lines for the GITHUB section (pure). `stats` = data/repo-stats.json. */
export function driftDigestLines(state, cfg, stats, now = Date.now()) {
  if (!cfg?.repo) return [];
  const out = [];
  if (!state?.lastOk) out.push('  public edition: no drift reading yet');
  else if (!state.files?.length) out.push(`  public edition: identical to ${state.tag}`);
  else out.push(`  public edition: ${plural(state.files.length, 'file')} behind ${state.tag}, oldest change ${day(state.oldestAt)}` +
    (state.episode?.task ? ` · task #${state.episode.task}` : ''));
  if (cfg.unposted?.length && quietWeek(stats, cfg.repo, cfg.minViewsPerDay, now)) {
    out.push(`  launch channels unposted: ${cfg.unposted.join(', ')} — repo views < ${cfg.minViewsPerDay}/day for 7 days` +
      (cfg.drafts ? ` (drafts: ${cfg.drafts})` : ''));
  }
  return out;
}

/** Ledger body for an episode (pure). */
export function episodeBody(state, cfg) {
  const files = state.files || [];
  const lines = [`Public-eligible changes are committed here but not in ${cfg.repo} ${state.tag}: ${plural(files.length, 'file')}, oldest change ${day(state.oldestAt)}.`, ''];
  let shown = 0;
  for (const [dir, fs] of groupFiles(files)) {
    if (shown >= LIST_MAX) break;
    const take = fs.slice(0, LIST_MAX - shown); shown += take.length;
    lines.push(`${dir} ${take.map((f) => f.replace(/^[^/]+\//, '')).join(', ')}${take.length < fs.length ? ` (+${fs.length - take.length})` : ''}`);
  }
  if (files.length > shown) lines.push(`… and ${files.length - shown} more`);
  if (state.commits?.length) lines.push('', 'Newest private commits since the release:', ...state.commits.slice(0, 10).map((c) => `- ${day(c.at)} ${c.subject}`));
  if (cfg.queued?.length) lines.push('', 'Also queued for the next release:', ...cfg.queued.map((q) => `- ${q}`));
  lines.push('', `To ship: say "release <next tag>" to ${cfg.owner}. It runs publish → gate + gitleaks → commit as the maintainers → tag → pre-release, and you type the public push.`);
  return lines.join('\n');
}

/**
 * Ledger actions for this reading (pure): create | comment | cancel. Only an episode the board
 * filed (requester 'board') is ever cancelled.
 */
export function planEpisode(prev, next, cfg, now = Date.now(), liveTask = null) {
  const ep = prev?.episode || null;
  const n = next.files?.length || 0;
  if (!n) {
    if (ep?.task && liveTask) return [{ kind: 'cancel', id: ep.task, text: `shipped in ${next.tag}: drift 0` }];
    return [];
  }
  const amber = now - next.oldestAt > (cfg.amberDays ?? 3) * DAY;
  if (ep?.task && liveTask) {
    const sig = next.files.join('\n');
    if (sig === ep.sig) return [];
    return [{ kind: 'comment', id: ep.task, text: `drift now ${plural(n, 'file')} behind ${next.tag} (was ${ep.count}).\n${episodeBody(next, cfg)}` }];
  }
  if (!amber) return [];
  return [{
    kind: 'create',
    input: {
      title: `Zulu public edition ${plural(n, 'file')} behind ${next.tag} since ${day(next.oldestAt)}: release?`,
      requester: 'board', owner: cfg.owner, priority: 'normal',
      source: { via: 'release-drift', key: `release-drift:${next.tag}:${day(next.oldestAt)}` },
      body: episodeBody(next, cfg),
    },
  }];
}

export function readStateSync(file = STATE_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }

/** One reading: { tag, publishedAt, files, diff, oldestAt, oldestSubject, commits } (run injectable). */
export async function readDrift({ cfg, root = ROOT, run = execFile }) {
  const gh = async (p) => JSON.parse(await sh(run, 'gh', ['api', p], { env: process.env }));
  const [rel] = await gh(`repos/${cfg.repo}/releases?per_page=1`);
  if (!rel?.tag_name) throw new Error('no release found');
  const tree = await gh(`repos/${cfg.repo}/git/trees/${encodeURIComponent(rel.tag_name)}?recursive=1`);
  if (tree.truncated) throw new Error('public tree listing truncated');
  const remote = new Map(tree.tree.filter((x) => x.type === 'blob' && x.mode !== '120000').map((x) => [x.path, x.sha]));
  const manifest = JSON.parse(await readFile(path.join(root, 'publish/manifest.json'), 'utf8'));
  const pub = publishSet(parseLsTree(await sh(run, 'git', ['-C', root, 'ls-tree', '-r', 'HEAD'])), manifest);
  const diff = diffTrees(pub, remote);
  const files = driftFiles(diff);
  const publishedAt = Date.parse(rel.published_at || rel.created_at);
  let commits = [];
  const srcs = [...diff.changed, ...diff.added].map((p) => pub.get(p).src);
  if (srcs.length) {
    commits = parseLog(await sh(run, 'git', ['-C', root, 'log', `--since=${new Date(publishedAt).toISOString()}`, '--no-merges', '--format=%ct%x09%s', 'HEAD', '--', ...srcs]));
  }
  const oldest = commits[commits.length - 1];
  return { tag: rel.tag_name, publishedAt, files, diff,
    oldestAt: files.length ? (oldest?.at ?? publishedAt) : null, oldestSubject: oldest?.subject || null, commits: commits.slice(0, 10) };
}

let busy = false;
/** Poll hook: read when due, keep the episode task in step. */
export async function maybeReleaseDrift({ cfg, ledger, now = Date.now(), file = STATE_FILE, root = ROOT, run = execFile,
  record = async () => {}, afterCreate = async () => {} } = {}) {
  if (!cfg?.repo || busy) return;
  const prev = readStateSync(file);
  if (now - (prev.lastOk || 0) < (cfg.everyHours || 6) * 3600e3 || now - (prev.lastAttempt || 0) < RETRY_MS) return;
  busy = true;
  try {
    const next = { ...prev, lastAttempt: now };
    try {
      const r = await readDrift({ cfg, root, run });
      Object.assign(next, { tag: r.tag, publishedAt: r.publishedAt, files: r.files, oldestAt: r.oldestAt, oldestSubject: r.oldestSubject, commits: r.commits, lastOk: now });
      delete next.lastError;
      if (ledger) {
        const ep = prev.episode;
        const live = ep?.task ? await ledger.get(ep.task).catch(() => null) : null;
        const liveTask = live && !['done', 'cancelled'].includes(live.status) ? live : null;
        if (ep?.task && !liveTask && next.files.length) delete next.episode;     // closed by the release: a new episode may start
        for (const a of planEpisode({ ...prev, episode: liveTask ? ep : null }, next, cfg, now, liveTask)) {
          try {
            if (a.kind === 'create') {
              const t = await ledger.create(a.input, now);
              if (!t.existing) {
                await ledger.update(t.id, { op: 'block', actor: cfg.owner, blocked_on: ['owner'], text: 'release-drift (board): waiting for the owner\'s release go' }, { now });
                await afterCreate(t);
                await record('sys', `release drift: ${next.files.length} public file(s) behind ${next.tag} → task #${t.id}`);
              }
              next.episode = { task: t.id, sig: next.files.join('\n'), count: next.files.length, since: next.oldestAt };
            } else if (a.kind === 'comment') {
              await ledger.update(a.id, { op: 'comment', actor: 'board', text: a.text }, { now });
              next.episode = { ...prev.episode, sig: next.files.join('\n'), count: next.files.length };
            } else if (a.kind === 'cancel') {
              await ledger.update(a.id, { op: 'cancel', actor: 'board', text: a.text }, { now });
              await record('good', `release drift: 0 — ${a.text} (#${a.id})`);
              delete next.episode;
            }
          } catch (e) { await record('sys', `release drift: ${a.kind} failed — ${e.message}`); }
        }
        if (!next.files.length && next.episode && !liveTask) delete next.episode;
      }
    } catch (e) {
      next.lastError = e.message;
      await record('sys', `release drift: ${e.message} (retry in 1h)`);
    }
    await writeFile(`${file}.tmp`, JSON.stringify(next, null, 1));
    await rename(`${file}.tmp`, file);
  } finally { busy = false; }
}
