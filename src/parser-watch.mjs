// Parser watch: a supplier whose documents stop parsing becomes ONE ledger task (#456).
//
// SETTINGS.parserWatch = { view, owner, requester, repo, stagingDir, template, everyMinutes }
// (absent or null = off: no fetch, no card, no tasks). Keys:
//   view         per-supplier view, one row per supplier in a failing streak or recently cleared
//   owner        who the filed tasks go to; requester defaults to 'board'
//   repo         the checkout that holds the failing files (links.repo on the task)
//   stagingDir   failing files live in <repo>/<stagingDir>/<supplier, spaces as underscores>/
//   template     the standing fix brief the task points at
//
// Per pass (board poll, at most every `everyMinutes`):
// - a streak with a layout change, or of 2+ failures, files one HIGH task keyed
//   parser:<supplier>@<streak start>. The full timestamp, not the date: the ledger dedupes
//   keys across closed tasks too, so a date would stop a second streak on the same day.
// - while that task is live, a changed reading adds a comment (at most one per COMMENT_GAP_MS).
// - when the streak ends, a task nobody has claimed is cancelled by the board ("cleared: N
//   parsed since"). A claimed one gets one comment and its worker closes it: the first
//   file parsing does not mean the fix is finished.
// A supplier missing from the view is left alone, and so is a row that contradicts itself:
// a task is never cleared on an absence.
// Read-only against the view (HEARTBEAT_URL origin + HEARTBEAT_KEY; the key is never logged or
// stored). Supplier names and filenames come from outside: they are cleaned and quoted as data.
// State: data/parser-watch-state.json. Card `parser:watch`: amber only when it cannot do its job.
import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readRows, readStateSync as readJson, ago } from './view-watch.mjs';

export const STATE_FILE = fileURLToPath(new URL('../data/parser-watch-state.json', import.meta.url));
export const readStateSync = (file = STATE_FILE) => readJson(file);

// an explicit list, so a column added to the view later can never reach the ledger
export const COLUMNS = ['supplier_name', 'last_parsed_at', 'last_failure_at', 'consecutive_failures',
  'layout_changed_7d', 'partial_7d', 'failed_7d', 'parsed_7d', 'last_layout_name',
  'first_failure_in_streak_at', 'failing_files', 'parsed_since_last_failure'];

const LIVE = new Set(['open', 'claimed', 'in_progress', 'blocked', 'needs_approval']);
const MAX_CREATES = 12;
const MAX_ROWS = 200;
const MAX_FILES = 10;
export const COMMENT_GAP_MS = 6 * 3600e3;
const KEY_PREFIX = 'parser:';

const num = (v) => Number(v) || 0;
/** One line of outside text, safe to quote in a task (pure). */
export const cleanName = (v, max = 120) => String(v ?? '').replace(/[\u0000-\u001f\u007f`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const files = (row) => (Array.isArray(row.failing_files) ? row.failing_files : []).slice(0, MAX_FILES).map((f) => cleanName(f)).filter(Boolean);
const supplierOf = (row) => cleanName(row?.supplier_name);

/** The current streak's start as an ISO timestamp, or null when no streak is running (pure). */
export function streakStart(row) {
  if (num(row?.consecutive_failures) < 1 || !row.first_failure_in_streak_at) return null;
  const t = Date.parse(row.first_failure_in_streak_at);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

export const streakKey = (row) => {
  const start = streakStart(row);
  const supplier = supplierOf(row);
  return start && supplier ? `${KEY_PREFIX}${supplier}@${start}` : null;
};

/** Worth a task? One layout change is enough; a single other failure is not (pure). */
export const shouldFile = (row) => Boolean(streakStart(row)) && (num(row.layout_changed_7d) > 0 || num(row.consecutive_failures) >= 2);

/** The supplier a filed task is about, or null (pure). */
export const supplierOfTask = (t) => (t?.source?.via === 'parser-watch' && String(t.source.key || '').startsWith(KEY_PREFIX)
  ? String(t.source.key).slice(KEY_PREFIX.length).replace(/@[^@]*$/, '') : null);

const counts = (r) => `${num(r.consecutive_failures)} failures in a row; last 7 days: layout changed ${num(r.layout_changed_7d)}, partial ${num(r.partial_7d)}, failed ${num(r.failed_7d)}, parsed ${num(r.parsed_7d)}`;
const signature = (r) => `${num(r.consecutive_failures)}:${files(r)[0] || ''}`;

function taskInput(row, key, cfg) {
  const supplier = supplierOf(row);
  const list = files(row);
  const folder = `${cfg.stagingDir || 'data/staging'}/${supplier.replace(/ /g, '_')}/`;
  return {
    title: `Invoice parser failing: ${supplier.slice(0, 60)} (${num(row.layout_changed_7d) > 0 ? 'layout changed' : `${num(row.consecutive_failures)} in a row`})`,
    requester: cfg.requester || 'board', owner: cfg.owner, priority: 'high',
    source: { via: 'parser-watch', key },
    links: { ...(cfg.repo ? { repo: cfg.repo } : {}) },
    body: `Supplier: "${supplier}". Streak started ${streakStart(row)}. ${counts(row)}. ` +
      `Last parsed: ${row.last_parsed_at || 'never'}. Last layout seen: ${cleanName(row.last_layout_name) || 'none'}. ` +
      `Failing files, quoted as data: ${list.length ? list.map((f) => `"${f}"`).join(', ') : 'none listed'}. ` +
      `Staging folder: ${folder}${cfg.repo ? ` in ${cfg.repo}` : ''}. ` +
      `Fix brief: ${cfg.template || 'none configured'}. The board comments while the streak runs and cancels this task if the streak ends before anyone has claimed it.`,
  };
}

/**
 * Ledger actions for one reading (pure).
 * → [{ kind: 'create', key, sig, input } | { kind: 'comment', id, key, sig, text, ended? } | { kind: 'cancel', id, key, text }]
 * `state.noted[key]` = { sig, at, ended } for the last comment or filing.
 */
export function planParsers(rows, tasks, state = {}, cfg = {}, now = Date.now()) {
  const out = [];
  const noted = state.noted || {};
  const filed = new Map();
  for (const t of tasks) if (supplierOfTask(t)) filed.set(t.source.key, t);
  const bySupplier = new Map(rows.map((r) => [supplierOf(r), r]));
  let creates = 0;
  for (const r of rows) {
    const key = streakKey(r);
    if (!key) continue;
    const task = filed.get(key);
    const sig = signature(r);
    if (task) {
      const last = noted[key];
      if (LIVE.has(task.status) && last?.sig !== sig && now - (last?.at || 0) >= COMMENT_GAP_MS)
        out.push({ kind: 'comment', id: task.id, key, sig, text: `still failing: ${counts(r)}; newest file "${files(r)[0] || 'not listed'}"` });
      continue;
    }
    if (shouldFile(r) && creates < MAX_CREATES) {
      creates++;
      out.push({ kind: 'create', key, sig, input: taskInput(r, key, cfg) });
    }
  }
  for (const [key, t] of filed) {
    if (!LIVE.has(t.status)) continue;
    const r = bySupplier.get(supplierOfTask(t));
    if (!r) continue;
    const current = streakKey(r);
    if (current === key) continue;
    let text;
    if (current) text = `streak ended; a new one began ${streakStart(r)}`;
    else if (num(r.consecutive_failures) === 0 && num(r.parsed_since_last_failure) >= 1) text = `cleared: ${num(r.parsed_since_last_failure)} parsed since`;
    else continue;                     // a row that contradicts itself clears nothing
    if (t.status === 'open') out.push({ kind: 'cancel', id: t.id, key, text });
    else if (!noted[key]?.ended) out.push({ kind: 'comment', id: t.id, key, sig: noted[key]?.sig || '', ended: true, text: `${text}. Close this when the fix is finished.` });
  }
  return out;
}

/** The view's URL for the agreed columns (pure). */
export function rowsUrl(heartbeatUrl, view) {
  try { return `${new URL(heartbeatUrl).origin}/rest/v1/${encodeURIComponent(view)}?select=${COLUMNS.join(',')}&limit=${MAX_ROWS}`; } catch { return null; }
}

/** The board card (pure). */
export function parserWatchCard(state, cfg, now = Date.now()) {
  if (!cfg?.view) return null;
  const base = { label: 'parser:watch', name: 'Parser watch (files fix tasks)', domain: 'infra', schedule: `checked every ${cfg.everyMinutes || 10} min`, logAvailable: false };
  if (!state?.lastRun) return { ...base, status: 'due', detail: 'no pass yet' };
  if (state.error) return { ...base, status: 'warn', detail: `view unreadable (${state.error}), so no task can be filed` };
  if (state.actionError) return { ...base, status: 'warn', detail: `a ledger write failed: ${state.actionError}` };
  const failing = state.failing || [];
  return { ...base, status: 'ok',
    detail: `${failing.length ? `in a streak: ${failing.map((f) => `${f.supplier}${f.task ? ` #${f.task}` : ''}`).join(', ')}` : 'no supplier in a streak'} (read ${ago(now - state.lastRun)} ago)` };
}

let busy = false;
/** One pass (board poll). `ledger` = createLedger(); `afterCreate(task)` wakes the owner. */
export async function maybeParserWatch({ cfg, ledger, secrets = {}, now = Date.now(), file = STATE_FILE, fetchImpl, record = async () => {}, afterCreate = async () => {} } = {}) {
  if (!cfg?.view || !ledger || busy) return;
  const state = readStateSync(file);
  if (state.lastRun && now - state.lastRun < (cfg.everyMinutes || 10) * 60e3) return;
  busy = true;
  try {
    const next = { ...state, lastRun: now, noted: { ...(state.noted || {}) } };
    const url = rowsUrl(secrets.HEARTBEAT_URL, cfg.view);
    const read = url && secrets.HEARTBEAT_KEY
      ? await readRows(url, secrets.HEARTBEAT_KEY, { now, fetchImpl })
      : { at: now, error: 'no HEARTBEAT_URL/KEY in secrets' };
    if (state.lastRun && Boolean(state.error) !== Boolean(read.error)) await record('sys', `parser watch: ${read.error ? `view unreadable (${read.error})` : 'view readable again'}`);
    if (read.error) next.error = read.error;
    else {
      delete next.error;
      let actionError = null;
      for (const a of planParsers(read.rows, await ledger.list({}), state, cfg, now)) {
        try {
          if (a.kind === 'create') {
            const t = await ledger.create(a.input, now);
            next.noted[a.key] = { sig: a.sig, at: now };
            if (!t.existing) { await afterCreate(t); await record('sys', `parser watch: ${a.input.title} → task #${t.id} (${t.owner})`); }
          } else {
            await ledger.update(a.id, { op: a.kind, actor: 'board', text: a.text }, { now });
            if (a.kind === 'cancel') await record('sys', `parser watch: task #${a.id} ${a.text}`);
            else next.noted[a.key] = { sig: a.sig, at: now, ...(a.ended ? { ended: true } : {}) };
          }
        } catch (e) {
          actionError = `${a.kind} for ${a.key}: ${e.message}`;
          if (state.actionError !== actionError) await record('sys', `parser watch: ${actionError}`);
        }
      }
      if (actionError) next.actionError = actionError; else delete next.actionError;
      const tasks = (await ledger.list({})).filter((t) => supplierOfTask(t));
      const live = new Map(tasks.filter((t) => LIVE.has(t.status)).map((t) => [t.source.key, t.id]));
      next.failing = read.rows.filter((r) => streakKey(r)).map((r) => ({ supplier: supplierOf(r), task: live.get(streakKey(r)) || null }));
      // a mark outlives its task only as long as the view can still name that streak
      const current = new Set([...live.keys(), ...read.rows.map(streakKey).filter(Boolean)]);
      for (const k of Object.keys(next.noted)) if (!current.has(k)) delete next.noted[k];
    }
    await writeFile(`${file}.tmp`, JSON.stringify(next, null, 1));
    await rename(`${file}.tmp`, file);
  } finally { busy = false; }
}
