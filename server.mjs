// Ops Board — zero-dependency local dashboard for the background-automation
// fleet and the agent workforce. Read-only against every system it watches.
// MC_DEMO=1 swaps every collector for synthetic data (src/demo.mjs).
import http from 'node:http';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS, DOCKER_CONTAINERS, PROCESSES, CRON, SETTINGS, DOMAINS, OWNER, isOwner, resolve as resolveConfig, loadSecrets, REGISTRY_FILE } from './src/config.mjs';
import { snapshot, logPathsFor } from './src/status.mjs';
import { tailFile, getAgentFeed } from './src/collect.mjs';
import { processAlerts, sendDigest, notify as realNotify, cmuxPassword } from './src/alerts.mjs';
import { maybeRemediate } from './src/remediate.mjs';
import { maybeHealCmuxBridge } from './src/heal-cmux.mjs';
import { maybeHealFailedRestores } from './src/heal-restore.mjs';
import { syncDemoCmux } from './src/demo-cmux.mjs';
import { recordEvent, getEvents } from './src/events.mjs';
import { maybeCiCostWatch } from './src/ci-cost-watch.mjs';
import { maybeRepoStats } from './src/repo-stats.mjs';
import { allowedSource, localOnly } from './src/guard.mjs';
import { createLedger, MeshError, summarize, wakeMessage } from './src/tasks.mjs';
import {
  liveDirectory, resolveTarget, deliverNow, enqueue, drainOutbox, readOutbox, formatWake, validateMessage,
  reconcile, mutateAgents, listWorkspaces, readSessionMap, readRegistry, nameDrift, ensureSessionName,
  slugTitle, kickSession, classifyScreen, listGroups, generatedAnchorIds, writeJsonAtomic, OUTBOX_FILE,
  acrossWindows, isDemoWorkspace, demoWorkspaceIds,
} from './src/mesh.mjs';
import { applyChrome, applyPills, inputPrompts } from './src/chrome.mjs';
import { collectContext } from './src/context.mjs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  DEMO, DEMO_POLL_SECONDS, DEMO_DOMAINS, demoSnapshot, demoContext, demoDirectory, demoHistory, demoBeats,
  demoFeed, demoLog, seedDemoLedger,
} from './src/demo.mjs';
import { readStar, successMoment, toastFor, recordToast } from './src/star.mjs';

// demo mode never notifies anyone (no cmux, no osascript, no email)
const notify = DEMO ? async () => true : realNotify;

// dead-man's switch: push a heartbeat off-Mac; a GitHub Action alerts if it stops.
// HEARTBEAT_URL (PostgREST row) + HEARTBEAT_KEY from data/secrets.env; absent = off.
async function heartbeat() {
  try {
    const { HEARTBEAT_URL: url, HEARTBEAT_KEY: hbKey, HEARTBEAT_HOST: host } = loadSecrets();
    if (!url || !hbKey) return;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    await fetch(url, {
      method: 'PATCH', signal: ctl.signal,
      headers: { apikey: hbKey, authorization: `Bearer ${hbKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ beat_at: new Date().toISOString(), host: host || os.hostname().split('.')[0] }),
    }).finally(() => clearTimeout(t));
  } catch { /* transient network loss is fine; the dead-man fires only on sustained silence */ }
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HISTORY_FILE = path.join(ROOT, 'data', 'history.json');

// ---- Agent Mesh: task ledger + directory + delivery ----
// demo mode gets its own throwaway ledger, re-seeded on every start
const ledger = DEMO
  ? await seedDemoLedger(path.join(ROOT, 'data', 'demo-tasks'), createLedger)
  : createLedger(path.join(ROOT, 'data', 'tasks'));
let workCache = summarize([]);
let dirCache = [];
let contextCache = new Map();      // workspaceId → context gauge (src/context.mjs)
const refreshWork = async () => { workCache = await ledger.summary(); };
const refreshDir = async () => {
  dirCache = DEMO ? demoDirectory() : await liveDirectory().catch(() => dirCache);
  return dirCache;
};
const meshConfig = async () => JSON.parse(await readFile(resolveConfig('config/mesh.json'), 'utf8').catch(() => '{}'));

/** Who is acting? Resolve a self-declared name to its directory entry. */
async function identify(who) {
  const n = String(who || '').trim().toLowerCase();
  if (!n) throw new MeshError(400, 'actor/requester is required (your agent name: --as or $MESH_AGENT)');
  if (isOwner(n) || n === 'board') return { name: isOwner(n) ? OWNER.id : n, ws: null, mc: false };
  if (['me', 'self'].includes(n)) throw new MeshError(400, `"${n}" is not an agent name — give your own name (--as <name>), or omit --as inside a cmux pane`);
  const r = resolveTarget(n, dirCache.length ? dirCache : await refreshDir(), { exact: true });
  if (!r.agent) throw new MeshError(400, `unknown agent "${n}" — see GET /api/agents`, { candidates: r.candidates });
  if (r.agent.status === 'closed') throw new MeshError(400, `agent "${r.agent.name}" is closed — an identity must be a live agent`);
  return { name: r.agent.name, ws: r.agent.workspaceId || null, mc: r.agent.kind === 'mission-control' };
}

// Reconciler (every poll): workspace list ⇄ directory. New workspaces join the
// mesh (needsOwnership + one task for Mission Control), closed ones become
// status=closed, renamed ones adopt the new title-derived name everywhere.
const renameAttempts = new Map();
const PLACEHOLDERS_FILE = path.join(ROOT, 'data', 'mesh-placeholder-workspaces.json');

// cmux chrome (Tier 2): domain colors/descriptions + per-owner task pills.
// Writes only set-color/set-description/set-status/set-progress; never
// overwrites a hand-set color or description (src/chrome.mjs).
async function syncChrome(cfg) {
  if (cfg.chrome === false) return;
  const r = await applyChrome(dirCache, { cfg, max: cfg.chromeMaxPerPass || 6 });
  if (r.applied?.length) recordEvent('sys', `mesh chrome: ${r.applied.map((a) => `${a.name} ${a.action.replace('set-', '')}`).join(', ')}`.slice(0, 160)).catch(() => {});
  await syncPills(cfg);
}
async function syncPills(cfg) {
  if (DEMO) return;
  if ((cfg || await meshConfig()).chrome === false) return;
  const tasks = await ledger.list({ status: 'live' });
  const prompts = await inputPrompts(dirCache, await readSessionMap(), { classify: classifyScreen });
  contextCache = await collectContext(dirCache).catch(() => contextCache);
  const changed = await applyPills(dirCache, tasks, { prompts, ctx: contextCache });
  if (changed.length) console.log('[mesh pills]', changed.map((c) => `${c.name}=${c.pill}`).join(', '));
}
async function reconcileMesh() {
  const [workspaces, sessionMap, registry, groups] = await Promise.all([
    listWorkspaces(), readSessionMap(), readRegistry(), listGroups()]);
  if (!workspaces.length) return;          // socket down — never mark the fleet closed
  if (!groups) return;                     // can't tell placeholders from agents — skip this pass
  // remember every workspace ever seen as a cmux-generated anchor: after an
  // ungroup/set-anchor it is no longer an anchor but is still a placeholder
  const seen = new Set(JSON.parse(await readFile(PLACEHOLDERS_FILE, 'utf8').catch(() => '[]')));
  const demoIds = await demoWorkspaceIds();
  const ignoreIds = new Set([...seen, ...generatedAnchorIds(groups, workspaces),
    ...workspaces.filter((w) => isDemoWorkspace(w, demoIds)).map((w) => w.id)]);   // the cmux demo never joins the mesh
  const liveIds = new Set(workspaces.map((w) => w.id));
  const keep = [...ignoreIds].filter((id) => liveIds.has(id));       // forget closed ones
  if (keep.length !== seen.size || keep.some((id) => !seen.has(id))) await writeJsonAtomic(PLACEHOLDERS_FILE, keep);
  let changes = null;
  await mutateAgents((doc) => {
    const r = reconcile(doc, { workspaces, sessionMap, registry, ignoreIds });
    changes = r.changes;
    return r.doc;
  });
  await refreshDir();
  for (const a of changes.added) {
    recordEvent('sys', `mesh: new workspace joined — ${a.name} (${a.vendor}); needs ownership`).catch(() => {});
    const task = await ledger.create({
      title: `Fill in ownership for new workspace "${a.title}" (${a.name})`,
      requester: 'board', owner: resolveTarget('mission-control', dirCache).agent?.name || null,
      owner_ws: resolveTarget('mission-control', dirCache).agent?.workspaceId || null,
      body: `Auto-registered in config/agents.json (workspaceId ${a.workspaceId}, vendor ${a.vendor}, cwd ${a.cwd || '?'}). Set owns/repo/kind and clear needsOwnership.`,
    }).catch(() => null);
    if (task?.owner) await afterTaskChange(task, { wake: [task.owner] }, 'board');
  }
  for (const a of changes.purged) recordEvent('sys', `mesh: dropped placeholder ${a.name} (cmux-generated group anchor, not an agent)`).catch(() => {});
  for (const a of changes.closed) recordEvent('sys', `mesh: workspace closed — ${a.name} (kept in directory as closed)`).catch(() => {});
  for (const r of changes.renamed) recordEvent('sys', `mesh: renamed ${r.from} → ${r.to} ("${r.title}")`).catch(() => {});
  const nameByWs = new Map(dirCache.filter((a) => a.workspaceId).map((a) => [a.workspaceId, a.name]));
  const synced = await ledger.syncNames(nameByWs);
  if (synced.length) await refreshWork();

  const cfg = await meshConfig();
  await syncChrome(cfg).catch((e) => console.error('[mesh chrome]', e.message));
  if (!cfg.autoRename) return;
  let n = 0;
  for (const a of nameDrift(dirCache)) {
    if (n >= (cfg.renameMaxPerPass || 3)) break;
    if (Date.now() - (renameAttempts.get(a.workspaceId) || 0) < (cfg.renameCooldownMin || 10) * 60e3) continue;
    renameAttempts.set(a.workspaceId, Date.now());
    n += 1;
    const r = await ensureSessionName(a).catch((e) => ({ ok: false, reason: e.message }));
    if (r.ok) recordEvent('sys', `mesh: session /rename ${r.from} → ${r.to}`).catch(() => {});
  }
}

// Approvals are the owner's: the board page carries a per-install token (read
// from data/, injected into index.html). Agents are told never to use it; this
// is a speed bump + audit trail, not a boundary against same-user processes.
const DECISION_TOKEN_FILE = path.join(ROOT, 'data', 'mesh-decision-token');
// demo mode: an ephemeral token, never read from or written to data/
let decisionToken = DEMO ? randomBytes(24).toString('hex') : (await readFile(DECISION_TOKEN_FILE, 'utf8').catch(() => '')).trim();
if (!decisionToken) {
  decisionToken = randomBytes(24).toString('hex');
  await writeFile(DECISION_TOKEN_FILE, decisionToken, { mode: 0o600 });
}
// One id per board process: injected into the page and sent with every snapshot,
// so a tab left open across a restart can tell it is stale.
const BOOT_ID = randomBytes(6).toString('hex');
const isDecider = (req) => {
  const got = Buffer.from(String(req.headers['x-mesh-decision'] || ''));
  const want = Buffer.from(decisionToken);
  return got.length === want.length && timingSafeEqual(got, want);
};

/** Wake/notify one agent: type it now if its pane is ready, else queue. */
async function meshDeliver(to, text, { from = 'board', taskId = null, wake = false, kind = 'message' } = {}) {
  const dir = await refreshDir();
  const r = resolveTarget(to, dir);
  if (!r.agent) return { ok: false, msg: r.error, candidates: r.candidates };
  const agent = r.agent;
  if (agent.name === from) return { ok: true, msg: 'not delivering to self', skipped: true };
  if (DEMO) {
    recordEvent('sys', `demo: would type into ${agent.name}: ${String(text).slice(0, 80)}`).catch(() => {});
    return { ok: true, demo: true, to: agent.name };
  }
  const line = formatWake({ from, text, taskId });
  const res = await deliverNow(agent, line, { wake }).catch((e) => ({ queued: e.message }));
  if (res.delivered) {
    recordEvent('sys', `mesh: ${from} → ${agent.name}${taskId ? ` (#${taskId})` : ''}: ${String(text).slice(0, 80)}`).catch(() => {});
    return { ok: true, delivered: true, to: agent.name };
  }
  const taskStatus = taskId ? (await ledger.get(taskId))?.status || null : null;   // status when queued (staleness check)
  await enqueue({ to: agent.name, line, wake, from, taskId, kind, taskStatus, queuedAt: Date.now(), attempts: 0, lastReason: res.queued });
  recordEvent('sys', `mesh: queued for ${agent.name} (${res.queued})`).catch(() => {});
  return { ok: true, queued: true, reason: res.queued, to: agent.name };
}

async function afterTaskChange(task, { events = [], wake = [], notifyMC = [], wakeKind = 'assigned', note = null }, actor) {
  for (const e of events) recordEvent(e.includes('BLOCKED') || e.includes('DECLINED') ? 'bad' : 'sys', e).catch(() => {});
  const deliveries = [];
  // never wake the actor itself — also when it acted under an alias
  // (e.g. the "mission-control" role alias → its real directory name)
  const me = resolveTarget(actor, dirCache).agent?.name || actor;
  for (const who of wake) {
    if ((resolveTarget(who, dirCache).agent?.name || who) === me) continue;
    const kind = wakeKind || 'assigned';
    deliveries.push(await meshDeliver(who, wakeMessage(task, kind, { note }), {
      from: actor, taskId: task.id, kind: kind === 'comment' ? 'message' : kind }));
  }
  // Mission Control is cc'd only on approvals, blocks and cross-domain conflicts
  for (const why of notifyMC) {
    const mc = resolveTarget('mission-control', dirCache).agent;
    if (mc && (task.owner === mc.name || actor === mc.name)) continue;
    deliveries.push(await meshDeliver('mission-control', `cc: task #${task.id} ${why === 'approval' ? `needs ${OWNER.name}'s approval` : 'is blocked'} (${task.owner}): ${task.title}`, { from: actor, taskId: task.id, kind: why === 'approval' ? 'approval' : 'cc' }));
  }
  if (notifyMC.includes('approval')) {
    notify('Ops Board · approval needed', `task #${task.id}`, `${task.owner}: ${task.title} — ${task.approval?.policy_item}`).catch(() => {});
  }
  await refreshWork();
  syncPills().catch((e) => console.error('[mesh pills]', e.message));
  return deliveries;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 64 * 1024) { reject(new MeshError(413, 'body too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { reject(new MeshError(400, 'invalid JSON')); } });
});
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

let current = { at: 0, jobs: [], counts: { ok: 0, attention: 0, total: 0 } };
let history = { fleet: [], perJob: {} };            // fleet: [{at, okPct}], perJob: {label: [status,...]}
const sseClients = new Set();

if (DEMO) history = demoHistory();
else try { history = JSON.parse(await readFile(HISTORY_FILE, 'utf8')); } catch { /* fresh start */ }

function recordHistory(snap) {
  history.fleet.push({ at: snap.at, okPct: snap.counts.total ? snap.counts.ok / snap.counts.total : 1 });
  history.fleet = history.fleet.slice(-SETTINGS.fleetHistorySamples);
  for (const j of snap.jobs) {
    const arr = history.perJob[j.label] || [];
    arr.push(j.status);
    history.perJob[j.label] = arr.slice(-SETTINGS.historySamples);
  }
}

let lastDigestDay = new Date().getHours() >= SETTINGS.escalation.digestHour
  ? new Date().toDateString() : '';

// self-heal/remediation messages land in the ticker as well as the cmux Feed
const notifyLog = (title, subtitle, body) => {
  recordEvent('sys', `${subtitle ? subtitle + ': ' : ''}${body}`).catch(() => {});
  return notify(title, subtitle, body);
};

const prevStatus = new Map();
let eventsCache = [];
let starDoc = await readStar();

// the first success moment queues the one-time star toast (src/star.mjs)
const celebrate = (reason) => successMoment(reason)
  .then(async (queued) => { if (queued) starDoc = await readStar(); })
  .catch((e) => console.error('[star]', e.message));

// demo: one tick of the scripted story — status changes come from the snapshot,
// the beats add the self-heal, the needs-input moment and a closed task
let demoLastTick = Date.now();
async function demoTick(snap) {
  contextCache = demoContext(snap.at);
  const beats = demoBeats(demoLastTick, snap.at);
  demoLastTick = snap.at;                  // advance first: a failing beat must never replay every tick
  for (const beat of beats) {
    try {
      await recordEvent(beat.kind, beat.text);
      if (beat.success) await celebrate(beat.success);
      if (beat.closeTask) {
        const t = await ledger.create({ title: `Triage pass ${new Date(snap.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, requester: 'board', owner: 'mission-control' });
        await ledger.update(t.id, { op: 'close', actor: 'mission-control', checklist: 'all', links: { handoff: 'data/handoffs/triage.report.md' }, text: 'clean pass' });
        await recordEvent('good', `task #${t.id} DONE by mission-control: ${t.title}`);
      }
    } catch (e) { console.error('[demo beat]', e.message); }
  }
}

async function poll() {
  try {
    const snap = DEMO ? demoSnapshot() : await snapshot();
    current = snap;
    recordHistory(snap);
    if (!DEMO) await writeFile(HISTORY_FILE, JSON.stringify(history)).catch(() => {});
    for (const j of snap.jobs) {
      const prev = prevStatus.get(j.label);
      if (prev && prev !== j.status) {
        recordEvent(j.status === 'ok' ? 'good' : 'bad',
          `${j.name} ${prev.toUpperCase()} → ${j.status.toUpperCase()}`).catch(() => {});
      }
      prevStatus.set(j.label, j.status);
    }
    if (DEMO) {
      await demoTick(snap);
      // `--demo --cmux`: drive the ZULU DEMO panes' chrome (no-op without one)
      await syncDemoCmux({ ledger }).catch((e) => console.error('[demo cmux]', e.message));
      await refreshDir();
      await refreshWork();
      eventsCache = await getEvents(30);
      const payload = JSON.stringify(payloadFor());
      for (const res of sseClients) res.write(`data: ${payload}\n\n`);
      return;
    }
    await reconcileMesh().catch((e) => console.error('[mesh reconcile]', e.message));
    drainOutbox({
      resolve: async (name) => resolveTarget(name, dirCache).agent || null,
      taskStatus: async (id) => (await ledger.get(id))?.status || null,
    })
      .then(async ({ delivered, expired, dropped }) => {
        for (const m of dropped) await recordEvent('sys', `mesh: dropped stale wake for ${m.to} — ${m.dropReason}`);
        for (const m of delivered) await recordEvent('sys', `mesh: delivered queued message to ${m.to}${m.taskId ? ` (#${m.taskId})` : ''}`);
        for (const m of expired) {
          await recordEvent('bad', `mesh: gave up delivering to ${m.to} after 24h (${m.lastReason || 'never ready'})`);
          if (m.taskId) await ledger.update(m.taskId, { op: 'comment', actor: 'mission-control', text: `undelivered after 24h to ${m.to}: ${m.lastReason || ''}` }).catch(() => {});
        }
      })
      .catch((e) => console.error('[mesh outbox]', e.message));
    await refreshWork();
    eventsCache = await getEvents(30);
    await processAlerts(snap);
    await heartbeat();
    const diskJob = snap.jobs.find((j) => j.label === 'disk:/');
    if (diskJob) maybeRemediate(diskJob.status, notifyLog).catch((e) => console.error('[remediate]', e.message));
    // password heal first; the restore retry gates itself on a healthy socket,
    // so chaining keeps both halves of a post-reboot recovery in one tick
    maybeHealCmuxBridge(snap.jobs.find((j) => j.label === 'cmux:bridge'), notifyLog)
      .catch((e) => console.error('[heal-cmux]', e.message))
      .then(() => maybeHealFailedRestores({
        log: (text) => recordEvent('sys', text),   // one ticker line per repaired workspace
        notify,                                    // one Feed summary per pass
        // a resumed session re-adopts its title-derived mesh name
        onRepaired: async (ws) => {
          await celebrate(`a dead session restore in "${ws.title || ws.id}" and brought it back`);
          await refreshDir();
          const a = dirCache.find((x) => x.workspaceId === ws.id);
          if (a && (await meshConfig()).autoRename) await ensureSessionName(a).catch(() => {});
        },
      }))
      .catch((e) => console.error('[heal-restore]', e.message));
    const now = new Date();
    if (now.getHours() >= SETTINGS.escalation.digestHour && lastDigestDay !== now.toDateString()) {
      lastDigestDay = now.toDateString();
      sendDigest(snap, Object.fromEntries(snap.jobs.map((j) => [j.label, history.perJob[j.label] || []])), workCache)
        .then((ok) => console.log('[digest]', ok ? 'sent' : 'failed'));
    }
    maybeCiCostWatch({ root: ROOT, cfg: SETTINGS.ciCostWatch, now, record: (k, t) => recordEvent(k, t).catch(() => {}) })
      .catch((e) => console.error('[ci-cost]', e.message));
    maybeRepoStats({ cfg: SETTINGS.repoStats, now, record: (k, t) => recordEvent(k, t).catch(() => {}) })
      .catch((e) => console.error('[repo-stats]', e.message));
    const payload = JSON.stringify(payloadFor());
    for (const res of sseClients) res.write(`data: ${payload}\n\n`);
  } catch (err) {
    console.error('[poll]', err.message);
  } finally {
    setTimeout(poll, (DEMO ? DEMO_POLL_SECONDS : SETTINGS.pollSeconds) * 1000);
  }
}

function payloadFor() {
  return {
    ...current,
    bootId: BOOT_ID,
    brand: SETTINGS.brand || 'Zulu Assistant',
    repoUrl: SETTINGS.repoUrl || '',
    domains: DEMO ? DEMO_DOMAINS : DOMAINS,
    starToast: toastFor(starDoc, SETTINGS.repoUrl),
    fleetHistory: history.fleet.slice(-240),
    strips: Object.fromEntries(current.jobs.map((j) => [j.label, history.perJob[j.label] || []])),
    events: eventsCache,
    work: workCache,
    sessions: (current.sessions || []).map((s) => ({ ...s, ctx: contextCache.get(s.workspaceId) || null })),
    directory: Object.fromEntries(dirCache.filter((a) => a.workspaceId).map((a) => [a.workspaceId, {
      name: a.name, kind: a.kind, vendor: a.vendor, owns: a.owns || [], status: a.status,
      liveName: a.live?.liveName || null, nameOk: a.live ? a.live.nameOk : null,
      ctx: contextCache.get(a.workspaceId) || null,
    }])),
  };
}

// ---- guarded actions (POST /api/action) — labels validated against the registry ----
function sh(cmd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000, killSignal: 'SIGKILL', env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ err, out: String(stdout) + String(stderr) }));
  });
}

async function runAction(action, label) {
  if (DEMO) return { ok: true, msg: `demo: would ${action} ${label} (nothing was run)` };
  const job = JOBS.find((j) => j.label === label);
  const container = DOCKER_CONTAINERS.find((c) => `docker:${c.name}` === label);

  if (action === 'kickstart') {
    if (!job) return { ok: false, msg: 'unknown launchd label' };
    const { err } = await sh('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`]);
    return { ok: !err, msg: err ? 'kickstart failed' : `kickstarted ${label}` };
  }

  if (action === 'docker-restart') {
    if (!container) return { ok: false, msg: 'unknown container' };
    const r = await sh('/usr/local/bin/docker', ['restart', container.name]);
    if (r.err) { const r2 = await sh('docker', ['restart', container.name]); if (r2.err) return { ok: false, msg: 'docker restart failed' }; }
    return { ok: true, msg: `restarted ${container.name}` };
  }

  if (action === 'proc-start') {
    const proc = PROCESSES.find((p) => `proc:${p.id}` === label);
    if (!proc?.startCmd) return { ok: false, msg: 'unknown process or no startCmd' };
    const cwd = proc.repo.replace('~', process.env.HOME);
    const { err } = await new Promise((resolve) => {
      execFile('/bin/bash', ['-c', proc.startCmd], { cwd, timeout: 15000 },
        (e, stdout, stderr) => resolve({ err: e, out: String(stdout) + String(stderr) }));
    });
    return { ok: !err, msg: err ? 'start failed' : `started ${proc.name}` };
  }

  if (action === 'ask-master') {
    // type a one-line brief into the Mission Control workspace
    const j = current.jobs.find((x) => x.label === label);
    if (!j) return { ok: false, msg: 'unknown label' };
    const pw = await cmuxPassword();
    const env = { CMUX_SOCKET_PASSWORD: pw, CMUX_QUIET: '1' };
    const { out } = await acrossWindows((a) => sh(SETTINGS.cmuxBin, a, env), ['workspace', 'list']);
    const line = out.split('\n').find((l) => l.includes('MISSION CONTROL'));
    const ref = line && (line.match(/workspace:\d+/) || [])[0];
    if (!ref) return { ok: false, msg: 'Mission Control workspace not found — launch it first' };
    const brief = `Board brief: "${j.name}" is ${String(j.status).toUpperCase()} — ${j.detail || 'no detail'} (label ${label}, schedule ${j.schedule || 'n/a'}). Please handle.`;
    await sh(SETTINGS.cmuxBin, ['send', '--workspace', ref, brief], env);
    const r = await sh(SETTINGS.cmuxBin, ['send-key', '--workspace', ref, 'enter'], env);
    return { ok: !r.err, msg: r.err ? 'send to Mission Control failed' : `Brief sent to Mission Control (${ref})` };
  }

  if (action === 'dispatch') {
    // spawn a Claude session in a fresh cmux workspace, targeted at the job's repo
    const proc = PROCESSES.find((p) => `proc:${p.id}` === label);
    // cron entries get DISPATCH (diagnosis) but never a run-now action — there
    // is no safe generic "fire this crontab line", and the board is read-only
    // against the crontab
    const cron = CRON.find((c) => `cron:${c.id}` === label);
    const known = job || container || proc || cron || ['disk:/', 'mem:'].includes(label) || label.startsWith('endpoint:');
    if (!known) return { ok: false, msg: 'unknown label' };
    const j = current.jobs.find((x) => x.label === label) || {};
    const repo = (job?.repo || proc?.repo || cron?.repo || '~').replace('~', process.env.HOME);
    const name = j.name || label;
    const prompt = `My Ops Board (localhost:3210) shows "${name}" in status ${String(j.status || 'unknown').toUpperCase()}: ` +
      `${j.detail || 'no detail'}. Label: ${label}. Schedule: ${j.schedule || 'n/a'}. ` +
      `Diagnose the root cause and fix it if safe; explain what you changed. ` +
      `The Ops Board registry lives in ${REGISTRY_FILE} if the check itself seems wrong.`;
    const promptFile = path.join(ROOT, 'data', `dispatch-${Date.now()}.txt`);
    await writeFile(promptFile, prompt);
    const pw = await cmuxPassword();
    const wsName = `fix: ${name}`;
    const meshName = slugTitle(wsName);
    const { err, out } = await sh(SETTINGS.cmuxBin, [
      'new-workspace', '--name', wsName, '--cwd', repo,
      '--command', `claude --name ${JSON.stringify(meshName)} --permission-mode acceptEdits`,
    ], { CMUX_SOCKET_PASSWORD: pw });
    if (err) return { ok: false, msg: `dispatch failed: ${out.slice(0, 120)}` };
    // submit the brief once the TUI is ready (a CLI-argument prompt can sit
    // unsubmitted on 2.1.280); runs in the background, result → ticker
    const ref = (out.match(/workspace:\d+/) || [])[0];
    (async () => {
      const ws = (await listWorkspaces()).find((w) => w.ref === ref);
      if (!ws) return recordEvent('bad', `dispatch ${meshName}: new workspace not found for kick`);
      const k = await kickSession({ workspace: ws.id, name: meshName,
        line: `Read the brief at "${promptFile}" and execute it (Ops Board dispatch).` });
      await recordEvent(k.ok ? 'sys' : 'bad', `dispatch ${meshName}: ${k.ok ? 'brief submitted' : `KICK FAILED — ${k.reason}`}`);
    })().catch((e) => console.error('[dispatch kick]', e.message));
    return { ok: true, msg: `Claude dispatched in cmux workspace "${wsName}" (${meshName})` };
  }

  return { ok: false, msg: 'unknown action' };
}

const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  if (!allowedSource(req)) { res.writeHead(403); return res.end('forbidden'); }
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payloadFor()));
    }
    if (url.pathname === '/api/feed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(DEMO ? demoFeed() : await getAgentFeed()));
    }
    if (url.pathname === '/api/log' && DEMO) return sendJson(res, 200, demoLog(url.searchParams.get('job') || ''));
    if (url.pathname === '/api/log') {
      const paths = await logPathsFor(url.searchParams.get('job') || '');
      const out = paths ? await tailFile(paths.out, 80) : '';
      const errT = paths ? await tailFile(paths.err, 20) : '';
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ out, err: errT }));
    }
    // ---- Agent Mesh API ----
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      const dir = (await refreshDir()).map((a) => ({ ...a, ctx: contextCache.get(a.workspaceId) || null }));
      // Mission Control hook (report only): who is in the red band and idle —
      // candidates for "checkpoint your state file, then /compact"
      const contextRed = dir.filter((a) => a.ctx?.band === 'red').map((a) => ({
        name: a.name, pct: a.ctx.pct, source: a.ctx.source, idle: a.live ? a.live.status !== 'busy' : null }));
      return sendJson(res, 200, { agents: dir, outbox: await readOutbox(), contextRed });
    }
    if (url.pathname === '/api/mesh/send' && req.method === 'POST') {
      // shell/Codex → any agent. Localhost only (it types into panes).
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'localhost only' });
      const b = await readBody(req);
      const err = validateMessage(b.text);
      if (err) return sendJson(res, 400, { ok: false, msg: err });
      const me = await identify(b.from);
      const from = me.name;
      const dir = await refreshDir();
      const target = resolveTarget(b.to, dir);
      if (!target.agent) return sendJson(res, 404, { ok: false, msg: target.error, candidates: target.candidates });
      let taskId = b.task ? Number(String(b.task).replace(/^#/, '')) : null;
      if (target.agent.vendor === 'claude' && !taskId) {
        return sendJson(res, 400, { ok: false, msg: 'messages to Claude agents must reference a task (--task N); create one first: scripts/task.sh create ...' });
      }
      if (taskId) {
        const r = await ledger.update(taskId, { op: 'comment', actor: from, text: `→ ${target.agent.name}: ${b.text}` });
        await refreshWork();
        taskId = r.task.id;
      }
      const d = await meshDeliver(target.agent.name, b.text, { from, taskId, wake: Boolean(b.wake) });
      return sendJson(res, 200, d);
    }
    if (url.pathname === '/api/mesh/outbox/drop' && req.method === 'POST') {
      // cancel queued (undelivered) messages for one target — localhost only
      if (!localOnly(req)) return sendJson(res, 403, { ok: false, msg: 'localhost only' });
      const b = await readBody(req);
      const box = await readOutbox();
      const keep = box.filter((m) => m.to !== b.to);
      await writeJsonAtomic(OUTBOX_FILE, keep);
      recordEvent('sys', `mesh: dropped ${box.length - keep.length} queued message(s) for ${b.to}`).catch(() => {});
      return sendJson(res, 200, { ok: true, dropped: box.length - keep.length });
    }
    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      return sendJson(res, 200, { tasks: await ledger.list(q) });
    }
    if (url.pathname === '/api/tasks/summary' && req.method === 'GET') {
      return sendJson(res, 200, await ledger.summary());
    }
    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      const me = await identify(b.requester);
      b.requester = me.name; b.requester_ws = me.ws;
      if (b.owner) {
        const t = resolveTarget(b.owner, await refreshDir());
        if (!t.agent && !isOwner(b.owner)) return sendJson(res, 400, { ok: false, msg: `owner: ${t.error}`, candidates: t.candidates });
        if (t.agent) { b.owner = t.agent.name; b.owner_ws = t.agent.workspaceId || null; }
      }
      const task = await ledger.create(b);
      recordEvent('sys', `task #${task.id} created by ${task.requester}${task.owner ? ` → ${task.owner}` : ''}: ${task.title}`).catch(() => {});
      const deliveries = await afterTaskChange(task, { wake: task.owner && task.owner !== task.requester && !isOwner(task.owner) ? [task.owner] : [] }, task.requester);
      return sendJson(res, 201, { ok: true, task, deliveries });
    }
    const tm = url.pathname.match(/^\/api\/tasks\/(\d+)$/);
    if (tm && req.method === 'GET') {
      const t = await ledger.get(tm[1]);
      return t ? sendJson(res, 200, t) : sendJson(res, 404, { ok: false, msg: `no task #${tm[1]}` });
    }
    if (tm && req.method === 'PATCH') {
      const b = await readBody(req);
      const decider = b.op === 'decide' && isDecider(req);
      if (b.op === 'decide') {
        // every panel decision attempt leaves a trace (two clicks left none)
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        console.log(`[decide] #${tm[1]} ${b.decision} from ${ip} token=${decider ? 'ok' : 'REJECTED'}`);
        if (!decider) {
          recordEvent('sys', `approval for #${tm[1]} REJECTED (decision token) from ${ip}`).catch(() => {});
          throw new MeshError(403, 'decision token rejected: reload the board page and click again');
        }
      }
      const me = decider ? { name: OWNER.id, ws: null, mc: false } : await identify(b.actor);
      b.actor = me.name;
      if (b.op === 'assign' && b.owner) {
        const t = resolveTarget(b.owner, await refreshDir());
        if (!t.agent) throw new MeshError(400, `owner: ${t.error}`, { candidates: t.candidates });
        b.owner = t.agent.name; b.owner_ws = t.agent.workspaceId || null;
      }
      if (b.op === 'set_requester' && b.requester) {
        const who = await identify(b.requester);   // exact, live agent (or the owner)
        b.requester = who.name; b.requester_ws = who.ws;
      }
      const r = await ledger.update(tm[1], b, { decider, mc: me.mc, actorWs: me.ws });
      if (decider) {
        const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        recordEvent('sys', `approval #${tm[1]} ${b.decision} decided from ${ip} (${String(req.headers['user-agent'] || '').slice(0, 40)})`).catch(() => {});
      }
      const deliveries = await afterTaskChange(r.task, r, b.actor);
      if (b.op === 'close' && r.task.status === 'done') celebrate(`task #${r.task.id} through to done`);
      return sendJson(res, 200, { ok: true, task: r.task, deliveries });
    }

    if (req.method === 'POST' && url.pathname === '/api/star') {
      // the board's one-time star toast reports shown / star / never (src/star.mjs)
      const b = await readBody(req);
      const ok = await recordToast(b.event);
      starDoc = await readStar();
      return sendJson(res, ok ? 200 : 400, { ok });
    }
    if (req.method === 'POST' && url.pathname === '/api/event') {
      // Mission Control / scripts log actions into the ticker. Localhost only —
      // stricter than the tailnet-wide source guard.
      if (!localOnly(req)) { res.writeHead(403); return res.end('forbidden'); }
      const body = await new Promise((resolve) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b));
      });
      const { kind, text } = JSON.parse(body || '{}');
      if (!text) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end('{"ok":false}'); }
      await recordEvent(['good', 'bad', 'sys'].includes(kind) ? kind : 'sys', text);
      eventsCache = await getEvents(30);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ok":true}');
    }
    if (req.method === 'POST' && url.pathname === '/api/action') {
      const body = await new Promise((resolve) => {
        let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b));
      });
      const { action, label } = JSON.parse(body || '{}');
      const result = await runAction(action, label);
      recordEvent(result.ok ? 'sys' : 'bad', `${action} ${label}: ${result.msg}`).catch(() => {});
      res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(payloadFor())}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    // static
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const safe = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
    const full = path.join(PUBLIC, safe);
    if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    let body = await readFile(full).catch(() => null);
    if (!body) { res.writeHead(404); return res.end('not found'); }
    if (safe === 'index.html') {
      body = String(body).replace('%%MESH_DECISION%%', decisionToken).replace('%%BOOT_ID%%', BOOT_ID)
        .replaceAll('%%BRAND%%', esc(SETTINGS.brand || 'Zulu Assistant'));
    }
    // no-cache: a reload always revalidates, so a fixed app.js can't hide behind a stale copy
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    return res.end(body);
  } catch (err) {
    if (err instanceof MeshError) return sendJson(res, err.status, { ok: false, msg: err.message, ...err.extra });
    res.writeHead(500); res.end(err.message);
  }
});

server.listen(SETTINGS.port, '0.0.0.0', () => {
  console.log(`[ops-board] http://localhost:${SETTINGS.port} (+ tailnet, source-guarded)${DEMO ? ' — DEMO MODE (synthetic data)' : ''}`);
  recordEvent('sys', DEMO ? 'Ops Board started in demo mode — synthetic fleet, nothing real is touched' : 'Ops Board started').catch(() => {});
  poll();
});
