// Push approvals (#415, Zulu 1.2 prototype): when a gate or a decision waits on the owner, their
// phone buzzes, and one tap opens that item on the board. The relay is a DOORBELL, NOT A KEY:
//   - the payload carries ids and labels only, never a command, diff or comment (an allow-list
//     builder, not a filter); in fallback mode (the public ntfy.sh topic) not even the task title;
//   - the tap opens `<boardUrl>/?dock=1&item=<task>[:<gate>]`, which highlights the row and never
//     arms or clicks anything: the decision is still two clicks with the board's decision token;
//   - the cmux "gate waiting" ping on the desk always fires as well: the relay never
//     replaces it.
// Transport: ntfy (self-hosted on this Mac, tailnet-only, Bearer token in data/secrets.env
// RELAY_TOKEN), or the opt-in public fallback (url https://ntfy.sh + a long random topic, no title).
// Rings: once on arrival, re-rings at reRingMinutes (30, 90) while still pending, then stop.
// Quiet hours (default 22:00–07:00 local): gates still ring, at default priority; everything else,
// re-rings included, is held and sent once when quiet hours end (if still pending).
// State: data/relay-state.json (what rang, when, how often; a restart never rings twice).
// Every network call is injectable; the tests never POST.
import { readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATE_FILE = path.join(ROOT, 'data', 'relay-state.json');
const PRUNE_MS = 7 * 86400e3;
const FAIL_AMBER = 3;

/** SETTINGS.relay + secrets → the working config (pure). */
export function relayConfig(cfg, secrets = {}) {
  if (!cfg || !['observe', 'on'].includes(cfg.mode)) return { mode: 'off' };
  const url = String(cfg.url || '').replace(/\/+$/, '');
  const topic = String(cfg.topic || '');
  const fallback = /^https:\/\/ntfy\.sh$/i.test(url);
  const token = secrets.RELAY_TOKEN || '';
  const base = {
    url, topic, fallback, token,
    boardUrl: String(cfg.boardUrl || '').replace(/\/+$/, ''),
    quiet: { from: '22:00', to: '07:00', ...(cfg.quiet || {}) },
    reRingMinutes: Array.isArray(cfg.reRingMinutes) ? cfg.reRingMinutes : [30, 90],
  };
  if (!url || !topic) return { ...base, mode: 'observe', warn: 'SETTINGS.relay needs url and topic' };
  if (fallback && topic.length < 32) return { ...base, mode: 'observe', warn: 'a public ntfy.sh topic must be 32+ random characters' };
  if (cfg.mode === 'on' && !fallback && !token) return { ...base, mode: 'observe', warn: 'RELAY_TOKEN missing in data/secrets.env' };
  return { ...base, mode: cfg.mode };
}

const cut = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** What waits on the owner in these live tasks → [{ key, kind, task, gate?, label, agent, title, since }] (pure). */
export function waitingItems(tasks) {
  const out = [];
  for (const t of tasks || []) {
    for (const g of t.gates || []) {
      if (g.status !== 'pending') continue;
      out.push({ key: `t${t.id}${g.id}`, kind: 'gate', task: t.id, gate: g.id, label: g.label || g.cls || 'gated action', agent: g.agent || t.owner || '', title: t.title || '', since: Date.parse(g.requested_at) || null });
    }
    if (t.status === 'needs_approval' && t.approval && !t.approval.decision) {
      const kind = t.approval.kind === 'plan' ? 'plan' : 'approval';
      out.push({ key: `t${t.id}${kind === 'plan' ? 'p' : 'a'}`, kind, task: t.id, label: kind === 'plan' ? `${t.requester || 'a'}'s request plan` : t.approval.kind === 'program' ? 'program go' : 'approval',
        detail: kind === 'approval' ? t.approval.policy_item || '' : '', agent: t.owner || '', title: t.title || '', since: Date.parse(t.approval.requested_at) || null });
    }
  }
  return out;
}

/** The push, built from an allow-list of fields (pure). Fallback mode drops every free-text field. */
export function payloadFor(item, cfg, { quiet = false, ring = 1 } = {}) {
  const head = item.kind === 'gate' ? `GATE ${item.gate} · #${item.task}` : item.kind === 'plan' ? `PLAN REVIEW · #${item.task}` : `APPROVAL · #${item.task}`;
  const label = item.kind === 'approval' ? 'approval' : cut(item.label, 60);    // gate labels are policy class names
  const parts = cfg.fallback
    ? [label, item.agent]                                                      // ids + class labels only
    : [label, item.agent, cut(item.title, 80), item.kind === 'approval' ? cut(item.detail, 60) : ''];
  const link = cfg.boardUrl ? `${cfg.boardUrl}/?dock=1&item=${item.task}${item.gate ? `:${item.gate}` : ''}` : '';
  const headers = {
    Title: ring > 1 ? `${head} · still waiting` : head,
    Priority: item.kind === 'gate' && !quiet && ring === 1 ? 'high' : 'default',
    Tags: `zulu,${item.kind},${item.key}`,
    Cache: 'no',
  };
  if (link) { headers.Click = link; headers.Actions = `view, Open, ${link}`; }
  return { headers, body: parts.filter(Boolean).join(' · ') };
}

/** Is `now` inside quiet hours? from/to are local "HH:MM"; a window may cross midnight (pure). */
export function inQuiet(now, quiet) {
  if (!quiet?.from || !quiet?.to) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const hm = (s) => { const [h, mm] = String(s).split(':').map(Number); return h * 60 + (mm || 0); };
  const a = hm(quiet.from); const b = hm(quiet.to);
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

/**
 * What to ring now (pure). state.sent[key] = { at, n, held? }.
 *
 * Snoozes (#412's attention ring, `snoozed` = attention item ids): a snoozed item gets no re-ring while
 * the snooze lasts. When it ends (↺ BACK or expiry) and the item still waits, it rings ONCE ("still
 * waiting") and the re-ring clock restarts from that ring (s.clock; n counts rings since the clock, total
 * all rings). A first ring is never held back: a re-asked gK is a new item, never snoozed (#412).
 * → { send: [{ item, ring, rel, wake, quiet }], hold: [keys], done: [keys], asleep: [keys] }
 */
export function planRings(items, state, cfg, now, { snoozed = new Set() } = {}) {
  const sent = state.sent || {};
  const quiet = inQuiet(now, cfg.quiet);
  const allow = cfg.quiet?.allow || ['gate'];
  const send = []; const hold = []; const asleep = [];
  for (const item of items) {
    const s = sent[item.key];
    let ring = 0; let rel = 0; let wake = false;
    if (!s || s.n === 0) { ring = 1; rel = 1; }
    else if (snoozed.has(attentionId(item))) { if (!s.snoozed) asleep.push(item.key); continue; }
    else if (s.snoozed) { wake = true; rel = 1; ring = (s.total || s.n) + 1; }
    else {
      // how many re-ring times have passed since the clock started (filed, or a snooze's end); one late
      // ring covers every one it missed (a held 30-min re-ring sent at 07:00 also stands for the 90-min one)
      const elapsed = now - (s.clock || item.since || s.first || s.at);
      const passed = cfg.reRingMinutes.filter((m) => elapsed >= m * 60e3).length;
      if (passed >= s.n) { rel = passed + 1; ring = (s.total || s.n) - s.n + rel; }
    }
    if (!ring) continue;
    // in quiet hours only the allowed kinds ring, and only their FIRST ring; the rest wait for the morning
    if (quiet && !(ring === 1 && allow.includes(item.kind))) { if (!s?.held) hold.push(item.key); continue; }
    send.push({ item, ring, rel, wake, quiet });
  }
  const live = new Set(items.map((i) => i.key));
  const done = Object.keys(sent).filter((k) => !live.has(k) && !sent[k].done);
  return { send, hold, done, asleep };
}

/** The attention ring's id for a relay item (#412 ids: gate:<task>:<gK>, decision:<task>) (pure). */
export const attentionId = (item) => (item.kind === 'gate' ? `gate:${item.task}:${item.gate}` : `decision:${item.task}`);

/** The rung-state entry after a ring (pure): a wake ring restarts the clock and clears the snooze mark. */
const rungEntry = (prev, { ring, rel, wake }, now) => ({
  first: prev.first || now, at: now, n: rel, total: ring,
  ...(wake ? { clock: now } : prev.clock ? { clock: prev.clock } : {}),
});

/** POST one push to ntfy. → { ok, status, error } (never throws). */
export async function postPush(payload, cfg, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  try {
    const headers = { ...payload.headers };
    if (cfg.token && !cfg.fallback) headers.Authorization = `Bearer ${cfg.token}`;
    const r = await fetchImpl(`${cfg.url}/${encodeURIComponent(cfg.topic)}`, { method: 'POST', headers, body: payload.body, signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, status: r.status, error: r.ok ? null : `HTTP ${r.status}` };
  } catch (e) { return { ok: false, status: 0, error: String(e.message || e).slice(0, 120) }; }
}

export function readStateSync(file = STATE_FILE) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }
async function writeState(state, file) { await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2)); await rename(`${file}.tmp`, file); }

let running = null;
/**
 * One relay pass over the live tasks (called after a task change and on every poll). Serialised:
 * a pass already running is awaited, never doubled. → { sent, held, failed, observed }
 */
export function relayPass(args) {
  if (running) return running.then(() => relayPass(args));
  running = doPass(args).finally(() => { running = null; });
  return running;
}

async function doPass({ cfg: raw, secrets = {}, tasks, snoozed = new Set(), now = Date.now(), file = STATE_FILE, fetchImpl = globalThis.fetch, record = () => {} }) {
  const cfg = relayConfig(raw, secrets);
  const out = { sent: [], held: [], failed: [], observed: [], snoozed: [] };
  if (cfg.mode === 'off') return out;
  const state = readStateSync(file);
  state.sent ||= {};
  if (cfg.warn && state.warned !== cfg.warn) { record('bad', `relay: ${cfg.warn}, observing only`); state.warned = cfg.warn; }
  const items = waitingItems(tasks);
  const plan = planRings(items, state, cfg, now, { snoozed });
  for (const k of plan.asleep) { state.sent[k] = { ...state.sent[k], snoozed: true }; out.snoozed.push(k); }
  for (const s of plan.send) {
    const { item, ring, quiet } = s;
    const p = payloadFor(item, cfg, { quiet, ring });
    const prev = state.sent[item.key] || {};
    if (cfg.mode === 'observe') {
      record('sys', `relay (observe): would push ${p.headers.Title} · ${p.body}`.slice(0, 160));
      state.sent[item.key] = rungEntry(prev, s, now);
      out.observed.push(item.key);
      continue;
    }
    const r = await postPush(p, cfg, { fetchImpl });
    if (r.ok) {
      state.sent[item.key] = rungEntry(prev, s, now);
      state.failures = 0; state.lastOkAt = now;
      out.sent.push(item.key);
    } else {
      state.failures = (state.failures || 0) + 1; state.lastError = r.error;
      if (state.failures === 1 || state.failures === FAIL_AMBER) record('bad', `relay: push failed (${r.error}) for ${p.headers.Title}`);
      out.failed.push(item.key);
    }
  }
  for (const k of plan.hold) { state.sent[k] = { ...(state.sent[k] || { n: 0 }), held: true }; out.held.push(k); }
  for (const k of plan.done) state.sent[k] = { ...state.sent[k], done: now };
  for (const [k, v] of Object.entries(state.sent)) if (v.done && now - v.done > PRUNE_MS) delete state.sent[k];
  // held items ring once the quiet window ends: clear the flag so the next pass (outside quiet) sends them
  if (!inQuiet(now, cfg.quiet)) for (const v of Object.values(state.sent)) if (v.held) delete v.held;
  state.mode = cfg.mode; state.checkedAt = now;
  await writeState(state, file);
  return out;
}

/** The board card (pure): amber after repeated failures, never red. Off → no card. */
export function relayCard(state, rawCfg, secrets = {}) {
  const cfg = relayConfig(rawCfg, secrets);
  if (cfg.mode === 'off') return null;
  const base = { label: 'relay', name: 'Phone relay (push approvals)', domain: 'cloud', schedule: cfg.fallback ? 'ntfy.sh public topic (fallback)' : 'self-hosted ntfy', logAvailable: false };
  if (cfg.warn) return { ...base, status: 'warn', detail: `observing only: ${cfg.warn}` };
  if ((state?.failures || 0) >= FAIL_AMBER) return { ...base, status: 'warn', detail: `${state.failures} pushes failed in a row (${state.lastError}); the desk ping still fires` };
  const n = Object.values(state?.sent || {}).filter((v) => !v.done).length;
  return { ...base, status: 'ok', detail: `${cfg.mode === 'observe' ? 'observe (no pushes sent)' : 'on'} · ${n} item(s) rung and still waiting${state?.lastOkAt ? ` · last push ${new Date(state.lastOkAt).toISOString().slice(11, 16)}Z` : ''}` };
}
