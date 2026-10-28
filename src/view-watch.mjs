// View watch: board cards that read one row of a database view over PostgREST.
//
// SETTINGS.viewWatch = [ { label, name, view, everyMinutes, max, maxAgeMinutes, show } ]
// (absent or [] = off: no fetch, no card). Each entry:
//   label / name    the card's label and title
//   view            the view (or table) name; GET <origin>/rest/v1/<view>?select=*&limit=1
//   everyMinutes    how often the poll reads it (default 5)
//   max             { column: n }   amber when the value is > n
//   maxAgeMinutes   { column: n }   amber when the timestamp is older than n minutes OR null
//   show            [column, …]     shown in the detail line only (never ambers)
// Endpoint + key: the origin of HEARTBEAT_URL and HEARTBEAT_KEY from data/secrets.env
// (the same anon-read project as the dead-man row). Read-only; the key is never logged
// or stored. Status is ok or warn only — never red, never on the alert ladder. A view
// that can't be read (HTTP error, network, no row) is warn too.
// State: data/view-watch-state.json, { [label]: { at, row | error } }.
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const STATE_FILE = fileURLToPath(new URL('../data/view-watch-state.json', import.meta.url));

export function readStateSync(file = STATE_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }

/** "12m" / "3h" / "2d" (pure). */
export function ago(ms) {
  const m = Math.max(0, Math.round(ms / 60e3));
  return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

const fmt = (v) => (v === null || v === undefined ? '—' : typeof v === 'number' ? String(Math.round(v * 10) / 10) : String(v));

/** One card from the last read (pure). */
export function viewCard(entry, read, now = Date.now()) {
  const base = { label: entry.label, name: entry.name || entry.label, domain: 'infra',
    schedule: `read every ${entry.everyMinutes || 5} min`, logAvailable: false };
  if (!read) return { ...base, status: 'due', detail: 'no read yet' };
  if (read.error || !read.row) return { ...base, status: 'warn', detail: `view unreadable (${read.error || 'no row'})` };
  const row = read.row;
  const breaches = [];
  const parts = [];
  for (const [col, limit] of Object.entries(entry.max || {})) {
    const v = row[col] === null || row[col] === undefined ? null : Number(row[col]);
    if (v !== null && v > limit) breaches.push(`${col} ${fmt(v)} > ${limit}`);
    parts.push(`${col} ${fmt(v)}`);
  }
  for (const [col, limit] of Object.entries(entry.maxAgeMinutes || {})) {
    const t = row[col] ? Date.parse(row[col]) : NaN;
    if (Number.isNaN(t)) { breaches.push(`${col} never`); parts.push(`${col} never`); continue; }
    if (now - t > limit * 60e3) breaches.push(`${col} ${ago(now - t)} ago > ${limit}m`);
    parts.push(`${col} ${ago(now - t)} ago`);
  }
  for (const col of entry.show || []) {
    const v = row[col];
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    parts.push(`${col} ${v === null || v === undefined ? 'never' : Number.isNaN(t) ? fmt(v) : `${ago(now - t)} ago`}`);
  }
  return { ...base, status: breaches.length ? 'warn' : 'ok',
    detail: (breaches.length ? `${breaches.join(' · ')} — ` : '') + parts.join(' · ') + ` (read ${ago(now - read.at)} ago)` };
}

/** All cards (pure). */
export function viewCards(state, entries, now = Date.now()) {
  return (entries || []).filter((e) => e && e.label && e.view).map((e) => viewCard(e, state[e.label], now));
}

/** The view's URL from the heartbeat row URL (pure): same origin, /rest/v1/<view>. */
export function viewUrl(heartbeatUrl, view) {
  try { return `${new URL(heartbeatUrl).origin}/rest/v1/${encodeURIComponent(view)}?select=*&limit=1`; } catch { return null; }
}

/** Read one view → { at, row } or { at, error } (never throws, never echoes the key). */
export async function readView(url, key, { now = Date.now(), fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: { apikey: key, authorization: `Bearer ${key}`, accept: 'application/json' } });
    if (!res.ok) return { at: now, error: `HTTP ${res.status}` };
    const rows = await res.json();
    return Array.isArray(rows) && rows[0] ? { at: now, row: rows[0] } : { at: now, error: 'no row' };
  } catch (e) {
    return { at: now, error: e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally { clearTimeout(t); }
}

let busy = false;
/** One pass (board poll): reads each entry that is due. `secrets` = loadSecrets(). */
export async function maybeViewWatch({ entries, secrets = {}, now = Date.now(), file = STATE_FILE, fetchImpl, record = async () => {} } = {}) {
  if (!entries?.length || busy) return;
  busy = true;
  try {
    const state = readStateSync(file);
    let changed = false;
    for (const e of entries) {
      if (!e?.label || !e.view) continue;
      const last = state[e.label];
      if (last && now - last.at < (e.everyMinutes || 5) * 60e3) continue;
      const url = viewUrl(secrets.HEARTBEAT_URL, e.view);
      const read = url && secrets.HEARTBEAT_KEY
        ? await readView(url, secrets.HEARTBEAT_KEY, { now, fetchImpl })
        : { at: now, error: 'no HEARTBEAT_URL/KEY in secrets' };
      if (Boolean(last?.error) !== Boolean(read.error) && last) await record('sys', `${e.label}: ${read.error ? `view unreadable (${read.error})` : 'view readable again'}`);
      state[e.label] = read;
      changed = true;
    }
    if (changed) { await writeFile(`${file}.tmp`, JSON.stringify(state, null, 1)); await rename(`${file}.tmp`, file); }
  } finally { busy = false; }
}
