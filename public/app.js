/* Ops Board frontend — renders /api/status snapshots, live via SSE. */
// Card groups come from the registry (payload `domains`); this list is only the
// fallback for an older server. Accents = Homebrew ANSI brights (in-scheme).
const DOMAINS = [
  { id: 'app',   name: 'APP JOBS',          accent: '#9085e9' },
  { id: 'data',  name: 'DATA PIPELINE',     accent: '#3987e5' },
  { id: 'infra', name: 'INFRA / MISC',      accent: '#c98500' },
  { id: 'cloud', name: 'CLOUD / ENDPOINTS', accent: '#00e5e5' },
];
const LIFECYCLE = {
  running:    { cls: 'l-running', glyph: '◉', label: 'RUNNING' },
  idle:       { cls: 'l-idle',    glyph: '○', label: 'IDLE' },
  needsInput: { cls: 'l-input',   glyph: '▲', label: 'NEEDS INPUT' },
  unknown:    { cls: 'l-idle',    glyph: '·', label: '—' },
};
// status → glyph + label: identity is never color-alone
const STATUS = {
  ok:      { glyph: '●', label: 'OK' },
  due:     { glyph: '◐', label: 'DUE' },
  stale:   { glyph: '◐', label: 'STALE' },
  warn:    { glyph: '△', label: 'WARN' },
  failed:  { glyph: '▲', label: 'FAILED' },
  overdue: { glyph: '✕', label: 'OVERDUE' },
  down:    { glyph: '✕', label: 'DOWN' },
};
// warn: gauge amber tier (fresh reading in the warn band) — distinct from
// stale, which means a check's data went old / stopped reporting.
const SEVERITY = { down: 0, overdue: 1, failed: 2, stale: 3, warn: 4, due: 5, ok: 6 };

const $ = (id) => document.getElementById(id);
let lastData = null;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const tvMode = new URLSearchParams(location.search).has('tv');
if (tvMode) document.body.classList.add('tv');
// ?dock=1 — compact view for the cmux Dock (~360px column): cards collapse to
// name+status chips, WORK stacks, ticker stays; no boot sequence
const dockMode = new URLSearchParams(location.search).has('dock');
if (dockMode) document.body.classList.add('dock');

function chip(status) {
  const s = STATUS[status] || STATUS.ok;
  return `<span class="chip s-${status}"><span aria-hidden="true">${s.glyph}</span>${s.label}</span>`;
}

function strip(states) {
  const cells = (states || []).slice(-48).map((s) => `<i class="s-${s}" title="${s}"></i>`).join('');
  return `<div class="strip" aria-hidden="true">${cells}</div>`;
}

function actionButtons(job) {
  // the setup card is finished in a terminal, not by an agent
  if (job.label === 'setup:') return job.status === 'ok' ? '' : '<div class="card-actions"><span class="hint">run in a terminal: <kbd>zulu setup</kbd></span></div>';
  const btns = [];
  if (job.status !== 'ok') {
    if (job.label.startsWith('com.')) btns.push(`<button class="act" data-act="kickstart" data-label="${job.label}">⟳ KICKSTART</button>`);
    if (job.label.startsWith('docker:')) btns.push(`<button class="act" data-act="docker-restart" data-label="${job.label}">⟳ RESTART</button>`);
    if (job.label.startsWith('proc:')) btns.push(`<button class="act" data-act="proc-start" data-label="${job.label}">▶ START</button>`);
    btns.push(`<button class="act act-dispatch" data-act="dispatch" data-label="${job.label}">◉ DISPATCH CLAUDE</button>`);
  }
  btns.push(`<button class="act" data-act="ask-master" data-label="${job.label}">◈ ASK MASTER</button>`);
  return `<div class="card-actions">${btns.join('')}</div>`;
}

function card(job, strips) {
  const next = job.next ? ` · next ${job.next}` : '';
  return `<div class="card s-${job.status} ${job.logAvailable ? 'has-log' : ''}" data-label="${job.label}" data-name="${job.name}">
    <div class="card-top"><span class="card-name">${job.name}</span>${chip(job.status)}</div>
    <div class="card-detail">${job.detail || ''}</div>
    <div class="card-meta"><span class="card-sched">${job.schedule || ''}${next}</span>${strip(strips[job.label])}</div>
    ${actionButtons(job)}
  </div>`;
}

// Card actions confirm with a second click, like approvals (an
// embedded web view may cancel window.confirm without showing it).
let actionArmed = null;
async function fireAction(act, label, btn) {
  // ask-master just types a brief into the Mission Control session — no confirm needed
  if (act !== 'ask-master') {
    const r = BoardDecide.armClick(actionArmed, `${act} ${label}`, act, Date.now());
    actionArmed = r.armed;
    if (!r.fire) {
      btn.textContent = 'CLICK AGAIN';
      btn.classList.add('armed');
      return;
    }
  }
  btn.disabled = true; btn.textContent = '…';
  const r = await fetch('/api/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: act, label }),
  }).then((x) => x.json()).catch(() => ({ ok: false, msg: 'request failed: board unreachable' }));
  btn.disabled = false;
  btn.classList.remove('armed');
  btn.textContent = r.ok ? '✓ ' + (act === 'dispatch' ? 'DISPATCHED' : 'DONE') : '✕ FAILED';
  btn.title = r.msg || '';
  if (!r.ok) showNotice(`${act} ${label}: ${r.msg || 'failed'}`, 'bad');
}

function fleetSpark(points) {
  const svg = $('fleet-spark');
  if (!points || points.length < 2) { svg.innerHTML = ''; return; }
  const W = 240, H = 48, pad = 3;
  const xs = points.map((_, i) => pad + (i * (W - 2 * pad)) / (points.length - 1));
  const ys = points.map((p) => H - pad - p.okPct * (H - 2 * pad));
  const line = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join('');
  svg.innerHTML =
    `<path class="spark-area" d="${line} L${xs[xs.length - 1]},${H} L${xs[0]},${H} Z"/>` +
    `<path class="spark-line" d="${line}"/>` +
    `<circle class="spark-dot" cx="${xs[xs.length - 1]}" cy="${ys[ys.length - 1]}" r="3"/>`;
}

/* ---------- 24h ops timeline ---------- */
const TL_STATE = {
  ran:      { cls: 't-ran',      label: 'RAN' },
  missed:   { cls: 't-missed',   label: 'MISSED' },
  pending:  { cls: 't-pending',  label: 'PENDING' },
  upcoming: { cls: 't-upcoming', label: 'UPCOMING' },
};
function renderTimeline(slots) {
  const row = $('timeline-row');
  if (!slots || !slots.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  const now = Date.now(), from = now - 12 * 3600e3, span = 24 * 3600e3;
  const hours = [];
  const first = new Date(from); first.setMinutes(0, 0, 0);
  for (let t = +first; t <= from + span; t += 3600e3) {
    const d = new Date(t);
    if (d.getHours() % 3 !== 0 || t < from) continue;
    const pct = ((t - from) / span) * 100;
    hours.push(`<div class="tl-hour" style="left:${pct.toFixed(2)}%"></div>` +
      `<div class="tl-hour-label" style="left:${pct.toFixed(2)}%">${String(d.getHours()).padStart(2, '0')}:00</div>`);
  }
  const lanes = new Map(); // collision bucket -> stack depth
  const marks = slots.map((s) => {
    const pct = ((s.at - from) / span) * 100;
    const bucket = Math.round(pct / 1.6);
    const lane = Math.min(lanes.get(bucket) || 0, 3);
    lanes.set(bucket, lane + 1);
    const st = TL_STATE[s.state] || TL_STATE.upcoming;
    const when = new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<span class="tl-slot ${st.cls}" style="left:${pct.toFixed(2)}%;bottom:${16 + lane * 11}px"
      data-tip="${esc(when)} · ${esc(s.name)}" data-state="${st.label}">${s.state === 'missed' ? '✕' : '<b></b>'}</span>`;
  });
  $('timeline').innerHTML =
    hours.join('') +
    `<div class="tl-now"></div><div class="tl-now-label">NOW</div>` +
    `<div class="tl-legend"><i class="lg-ran">■ ran</i><i class="lg-missed">✕ missed</i><i class="lg-pending">◪ pending</i><i class="lg-upcoming">□ upcoming</i></div>` +
    marks.join('');
}
$('timeline').addEventListener('mouseover', (e) => {
  const slot = e.target.closest('.tl-slot');
  if (!slot) return $('tl-tip').classList.add('hidden');
  const tip = $('tl-tip');
  tip.textContent = slot.dataset.tip;
  const st = document.createElement('span');
  st.className = 'tip-state';
  st.textContent = slot.dataset.state;
  tip.appendChild(st);
  tip.classList.remove('hidden');
  const r = slot.getBoundingClientRect();
  tip.style.left = `${Math.min(r.left, window.innerWidth - 260)}px`;
  tip.style.top = `${r.top - 34}px`;
});
$('timeline').addEventListener('mouseleave', () => $('tl-tip').classList.add('hidden'));

/* ---------- event ticker ---------- */
let tickerSig = '';
function renderTicker(events) {
  const track = $('ticker-track');
  const sig = events && events.length ? `${events.length}:${events[events.length - 1].at}` : 'empty';
  if (sig === tickerSig) return; // don't restart the marquee on unchanged data
  tickerSig = sig;
  if (!events || !events.length) {
    track.style.animation = 'none';
    track.innerHTML = '<span class="tk tk-empty">no events recorded yet — status changes, actions and self-heals stream here</span>';
    return;
  }
  const items = events.map((e) => {
    const t = new Date(e.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `<span class="tk k-${e.kind}"><time>${t}</time>${esc(e.text)}</span>`;
  }).join('');
  // single copy first: if it fits in the bar, show it statically — a marquee
  // looping one short line reads as a stutter, not a stream
  track.innerHTML = `<span class="tk-copy">${items}</span>`;
  track.style.animation = 'none';
  requestAnimationFrame(() => {
    const clipW = track.parentElement.clientWidth;
    if (track.scrollWidth <= clipW) return;
    // overflow: duplicate into two identical halves so the -50% loop point
    // lands exactly on the seam, then animate
    track.innerHTML = `<span class="tk-copy">${items}</span><span class="tk-copy">${items}</span>`;
    track.style.animation = '';
    const secs = Math.max(30, Math.round(track.scrollWidth / 2 / 45));
    track.style.setProperty('--tk-dur', `${secs}s`);
  });
}

/* ---------- status-change glitch ---------- */
const prevCardStatus = new Map();
function applyGlitch(jobs) {
  const changed = [];
  for (const j of jobs) {
    const prev = prevCardStatus.get(j.label);
    if (prev && prev !== j.status) changed.push(j.label);
    prevCardStatus.set(j.label, j.status);
  }
  if (reducedMotion || !changed.length) return;
  for (const label of changed) {
    document.querySelectorAll(`.card[data-label="${CSS.escape(label)}"]`).forEach((el) => {
      el.classList.add('glitch');
      setTimeout(() => el.classList.remove('glitch'), 350);
    });
  }
}

function render(data) {
  lastData = data;
  const { jobs, counts, strips } = data;

  $('tile-ok').querySelector('.tile-num').textContent = `${counts.ok}/${counts.total}`;
  const att = $('tile-attention');
  att.querySelector('.tile-num').textContent = counts.attention;
  att.classList.toggle('hot', counts.attention > 0);
  const dockerJobs = jobs.filter((j) => j.label.startsWith('docker:'));
  const dockerOk = dockerJobs.every((j) => j.status === 'ok');
  $('tile-docker').querySelector('.tile-num').textContent =
    data.dockerReachable ? (dockerOk ? 'UP' : 'ISSUE') : 'N/A';
  $('tile-docker').querySelector('.tile-num').style.color =
    data.dockerReachable && dockerOk ? 'var(--status-ok)' : 'var(--status-warning)';
  fleetSpark(data.fleetHistory);

  const agentsTile = $('tile-agents').querySelector('.tile-num');
  agentsTile.textContent = counts.agentsNeedInput > 0
    ? `${counts.agents}·${counts.agentsNeedInput}⚠` : (counts.agents ?? 0);
  agentsTile.style.color = counts.agentsNeedInput > 0 ? 'var(--status-warning)' : 'var(--ink-bright)';

  const sessions = data.sessions || [];
  const dir = data.directory || {};
  $('agents-row').classList.toggle('hidden', sessions.length === 0
    || (dockMode && !sessions.some((s) => s.ctx && s.ctx.band !== 'ok')));   // Dock: only when some context is amber/red
  $('agents-grid').innerHTML = sessions.map((s) => {
    const lc = LIFECYCLE[s.lifecycle] || LIFECYCLE.unknown;
    const title = s.workspace || s.cwd || '~';
    const sub = s.workspace && s.cwd && s.workspace !== s.cwd ? s.cwd : '';
    const d = dir[s.workspaceId];
    // directory: mesh address + owned domains (hover; always shown in ?tv)
    const owns = d?.owns?.length ? d.owns.join(' · ') : (d ? '— needs ownership —' : '');
    const hover = d ? `@${d.name} (${d.kind})${owns ? '\n' + owns : ''}${d.nameOk === false ? `\nsession name "${d.liveName}" ≠ title` : ''}` : '';
    const quiet = !s.ctx || s.ctx.band === 'ok' ? 'ctx-quiet' : '';
    return `<div class="agent-tile ${lc.cls} ${s.active ? '' : 'a-closed'} ${quiet}" title="${esc(hover)}">
      <span class="agent-state"><span aria-hidden="true">${lc.glyph}</span>${s.active ? lc.label : 'RESTORABLE'}</span>
      <span class="agent-name">${esc(title)}</span>
      ${d ? `<span class="agent-addr">@${esc(d.name)}${d.nameOk === false ? ' <span class="drift" title="session name drifted from the workspace title">≠</span>' : ''}</span>` : ''}
      ${sub ? `<span class="agent-cwd">${esc(sub)}</span>` : ''}
      ${owns ? `<span class="agent-owns">${esc(owns)}</span>` : ''}
      ${s.note ? `<span class="agent-note">${esc(s.note)}</span>` : ''}
      ${ctxMeter(s.ctx)}
    </div>`;
  }).join('');
  renderWork(data.work);
  checkBoot(data.bootId);

  const attention = jobs.filter((j) => j.status !== 'ok')
    .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
  $('attention-row').classList.toggle('hidden', attention.length === 0);
  $('attention-grid').innerHTML = attention.map((j) => card(j, strips)).join('');

  $('demo-badge').classList.toggle('hidden', !data.demo);
  document.querySelectorAll('.share-sep, #share-btn').forEach((el) => el.classList.toggle('hidden', !data.repoUrl));
  maybeStarToast(data.starToast);
  const domains = data.domains?.length ? data.domains : DOMAINS;
  $('domains').innerHTML = domains.map((d) => {
    const list = jobs.filter((j) => j.domain === d.id)
      .sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
    if (!list.length) return '';
    const okN = list.filter((j) => j.status === 'ok').length;
    return `<section class="domain">
      <div class="domain-head">
        <span class="domain-accent" style="background:${d.accent};box-shadow:0 0 8px ${d.accent}"></span>
        <h2>${d.name}</h2><span class="domain-count">${okN}/${list.length} ok</span>
      </div>
      <div class="domain-grid">${list.map((j) => card(j, strips)).join('')}</div>
    </section>`;
  }).join('');

  $('updated').textContent = `updated ${new Date(data.at).toLocaleTimeString()}`;

  renderTimeline(data.timeline);
  renderTicker(data.events);
  applyGlitch(jobs);
  if (filterQuery) applyFilter(filterQuery);

  document.querySelectorAll('.card.has-log').forEach((el) =>
    el.addEventListener('click', () => openLog(el.dataset.label, el.dataset.name)));
  document.querySelectorAll('button.act[data-act]').forEach((el) =>
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      fireAction(el.dataset.act, el.dataset.label, el);
    }));
}

/* ---------- context meter (src/context.mjs gauge) ---------- */
// glyph + % + bar, never color alone: ● ok · △ amber (≥60) · ▲ red (≥80, compaction near)
const CTX_GLYPH = { ok: '●', amber: '△', red: '▲' };
function ctxMeter(ctx) {
  if (!ctx) return '';
  const tip = `context ${ctx.pct}% used — ${Math.round(ctx.ctxTokens / 1000)}k of ${Math.round(ctx.window / 1000)}k tokens${ctx.model ? ' (' + ctx.model + ')' : ''}`
    + (ctx.estimated ? ' — estimated after compaction, exact on the next turn' : '');
  return `<span class="ctx ctx-${ctx.band}" title="${esc(tip)}"><span class="ctx-label"><span aria-hidden="true">${CTX_GLYPH[ctx.band] || '●'}</span>ctx ${ctx.pct}%${ctx.estimated ? ' est' : ''}</span>`
    + `<span class="ctx-bar" aria-hidden="true"><i style="width:${Math.min(100, ctx.pct)}%"></i></span></span>`;
}

/* ---------- WORK panel (agent mesh ledger) ---------- */
const TASK_STATE = {
  needs_approval: { glyph: '⚑', label: 'APPROVAL', cls: 't-approval' },
  blocked:        { glyph: '✕', label: 'BLOCKED',  cls: 't-blocked' },
  open:           { glyph: '○', label: 'OPEN',     cls: 't-open' },
  claimed:        { glyph: '◐', label: 'CLAIMED',  cls: 't-open' },
  in_progress:    { glyph: '◉', label: 'WORKING',  cls: 't-working' },
};
const ageLabel = (h) => (h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

function taskRow(t) {
  const st = TASK_STATE[t.status] || TASK_STATE.open;
  const on = t.blocked_on?.length ? ` · on ${t.blocked_on.map((x) => (typeof x === 'number' ? '#' + x : x)).join(', ')}` : '';
  const dec = t.status === 'needs_approval' ? null : t.approval?.decision;
  const decLabel = { approve: '✓ approved', decline: '✕ declined', unrecorded: 'answer unrecorded', withdrawn: 'withdrawn' }[dec];
  const policy = t.approval?.policy_item
    ? `<span class="task-policy">${decLabel ? `${esc(decLabel)}${t.approval.via === 'pane' ? ' in pane' : ''} · ` : ''}${esc(t.approval.policy_item)}</span>` : '';
  const btn = (decision, label, cls) => {
    const res = decided.get(`${t.id}`);
    const armed = decideArmed && decideArmed.task === `${t.id}` && decideArmed.decision === decision && Date.now() < decideArmed.until;
    const text = res?.decision === decision ? res.text : armed ? `CLICK AGAIN TO ${decision.toUpperCase()} #${t.id}` : label;
    return `<button class="act ${cls}${armed ? ' armed' : ''}" data-task="${t.id}" data-decision="${decision}"${res?.pending ? ' disabled' : ''}>${esc(text)}</button>`;
  };
  // a plain approval request (POLICY.md item) — gates carry their own buttons below
  const asking = t.status === 'needs_approval' && t.approval && !t.approval.decision;
  const btns = asking
    ? `<div class="task-actions">${btn('approve', '✓ APPROVE', 'act-approve')}${btn('decline', '✕ DECLINE', 'act-decline')}</div>` : '';
  const gates = (t.gates || []).map((g) => gateRow(t, g)).join('');
  const go = t.program_go ? goRow(t) : '';
  return `<div class="task ${st.cls}">
    <div class="task-top"><span class="task-id">#${t.id}</span><span class="task-title">${esc(t.title)}</span>
      <span class="chip task-chip"><span aria-hidden="true">${st.glyph}</span>${st.label}</span></div>
    <div class="task-meta">${esc(t.owner || 'unowned')} · ${ageLabel(t.ageH)}${esc(on)}${t.priority !== 'normal' ? ' · ' + esc(t.priority) : ''}</div>
    ${policy}
    ${t.last ? `<div class="task-last">${esc(t.last)}</div>` : ''}
    ${btns}${go}${gates}
  </div>`;
}

// Guardrails: an active program go — standing approval for the task's merges/local loads, revocable here
function goRow(t) {
  const g = t.program_go;
  const key = `${t.id}:revoke`;
  const res = decided.get(key);
  const armed = decideArmed && decideArmed.task === key && Date.now() < decideArmed.until;
  const text = res ? res.text : armed ? `CLICK AGAIN TO REVOKE ${g.id}` : '⊘ REVOKE GO';
  return `<div class="gate-meta go-row"><span class="chip gate-chip"><span aria-hidden="true">✓</span>PROGRAM GO ${esc(g.id)}</span>
    standing: merges into private repos + local loads run without a tap (receipts kept) · since ${esc(String(g.granted_at).slice(11, 16))}Z${g.via === 'pane' ? ' (pane)' : ''}
    <button class="act act-decline${armed ? ' armed' : ''}" data-task="${t.id}" data-revoke="1" data-decision="revoke"${res?.pending ? ' disabled' : ''}>${esc(text)}</button></div>`;
}

// Guardrails: one row per pending gate. Approval is of the EXACT text, so the whole
// command, folder and agent are shown — wrapped, never cut (phone included).
function gateRow(t, g) {
  const key = `${t.id}:${g.id}`;
  const btn = (decision, label, cls) => {
    const res = decided.get(key);
    const armed = decideArmed && decideArmed.task === key && decideArmed.decision === decision && Date.now() < decideArmed.until;
    const text = res?.decision === decision ? res.text : armed ? `CLICK AGAIN TO ${decision.toUpperCase()} ${g.id}` : label;
    return `<button class="act ${cls}${armed ? ' armed' : ''}" data-task="${t.id}" data-gate="${esc(g.id)}" data-decision="${decision}"${res?.pending ? ' disabled' : ''}>${esc(text)}</button>`;
  };
  const age = ageLabel((Date.now() - Date.parse(g.requested_at)) / 36e5);
  const dry = g.dryRun?.required ? `<div class="gate-meta">dry run: ${g.dryRun.seen_at ? `completed ${esc(String(g.dryRun.seen_at).slice(11, 16))}Z` : 'missing'}</div>` : '';
  return `<div class="gate">
    <div class="gate-top"><span class="chip gate-chip"><span aria-hidden="true">⛨</span>GATE ${esc(g.id)}</span><span class="gate-label">${esc(g.label || g.cls)}</span></div>
    <pre class="gate-cmd">${esc(g.command)}</pre>
    <div class="gate-meta">${esc(g.agent)} · ${esc(g.cwd)} · ${esc(g.tool)} · ${age} ago${g.commandRedacted ? ' · command withheld (contains a secret)' : ''}</div>
    ${g.why ? `<div class="gate-meta">${esc(g.why)}</div>` : ''}
    ${g.previously ? `<div class="gate-meta gate-again">↻ you approved this exact call at ${esc(String(g.previously.at).slice(11, 16))}Z (${esc(g.previously.gate)}); it expired before it ran</div>` : ''}
    ${dry}
    <div class="task-actions">${btn('approve', '✓ RUN ONCE', 'act-approve')}${btn('decline', '✕ DECLINE', 'act-decline')}</div>
  </div>`;
}

function renderWork(work) {
  lastWork = work;
  const w = work || { counts: { open: 0, blocked: 0, needsApproval: 0, closed24h: 0 }, needsApproval: [], blocked: [], open: [] };
  const c = w.counts;
  const tile = $('tile-work');
  tile.querySelector('.tile-num').textContent = c.needsApproval ? `${c.open + c.blocked}·${c.needsApproval}⚑` : (c.open + c.blocked);
  tile.classList.toggle('hot', c.needsApproval > 0);
  $('work-counts').textContent = `${c.open} open · ${c.blocked} blocked · ${c.needsApproval} awaiting you · ${c.closed24h} closed 24h`;
  const col = (title, list, empty) => `<div class="work-col"><h3>${title} <span class="work-n">${list.length}</span></h3>
    ${list.length ? list.map(taskRow).join('') : `<div class="work-empty">${empty}</div>`}</div>`;
  $('work-cols').innerHTML = col(`AWAITING ${String(w.owner || 'owner').toUpperCase()}`, w.needsApproval, 'nothing needs your approval')
    + col('BLOCKED', w.blocked, 'nothing blocked')
    + col('OPEN / IN PROGRESS', w.open, 'no open cross-agent tasks');
  renderDecisions(w);
}

// Guardrails: the owner's decisions pinned at the top (same rows and buttons as WORK, oldest first),
// and a "(N) " title prefix so a background tab shows the count. Hidden when nothing waits.
const BASE_TITLE = document.title;
function renderDecisions(w) {
  const waiting = [...(w.needsApproval || [])].sort((a, b) => b.ageH - a.ageH);
  const n = waiting.reduce((k, t) => k + (t.gates?.length || 0) + (t.approval && !t.approval.decision ? 1 : 0), 0);
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
  $('decisions').classList.toggle('hidden', !waiting.length);
  $('decisions-title').textContent = `WAITING ON ${String(w.owner || 'you').toUpperCase()} · ${n}`;
  $('decisions-list').innerHTML = waiting.map(taskRow).join('');
}

// Approvals: one delegated listener, so a re-render between press and
// release can't swallow the click; confirmation is a second click (no
// window.confirm — embedded web views may cancel it without showing it); every
// outcome stays on screen across re-renders until the next decision.
let decideArmed = null;                 // { task, decision, until } after the first click
const decided = new Map();              // task id -> { decision, text, pending }
let lastWork = null;
function onDecideClick(e) {
  const b = e.target.closest('button.act-approve, button.act-decline');
  if (!b) return;
  const { task, decision, gate, revoke } = b.dataset;
  const key = revoke ? `${task}:revoke` : gate ? `${task}:${gate}` : task;
  const r = BoardDecide.armClick(decideArmed, key, decision, Date.now());
  decideArmed = r.armed;
  // where the owner decided (a receipt field, #350): the pinned WAITING ON YOU strip or the WORK panel
  if (r.fire) decideTask(task, decision, gate, !!revoke, e.currentTarget.id === 'decisions-list');
  else { renderWork(lastWork); setTimeout(() => renderWork(lastWork), BoardDecide.ARM_MS + 50); }
}
$('work-cols').addEventListener('click', onDecideClick);
$('decisions-list').addEventListener('click', onDecideClick);   // the pinned strip: same buttons, same two-click arm

async function decideTask(task, decision, gate = null, revoke = false, fromStrip = false) {
  const key = revoke ? `${task}:revoke` : gate ? `${task}:${gate}` : task;
  decided.set(key, { decision, text: '… SENDING', pending: true });
  renderWork(lastWork);
  const token = document.querySelector('meta[name="mesh-decision"]')?.content || '';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  let status = 0; let body = null;
  try {
    const res = await fetch(`/api/tasks/${task}`, {
      method: 'PATCH', signal: ctl.signal, cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-mesh-decision': token,
        'x-mesh-surface': [dockMode && 'dock', fromStrip && 'strip'].filter(Boolean).join(',') || 'panel' },
      body: JSON.stringify(revoke ? { op: 'revoke_go' } : gate ? { op: 'gate_decide', gate, decision } : { op: 'decide', decision }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* status 0 = never reached the board */ } finally { clearTimeout(timer); }
  const out = BoardDecide.decisionOutcome(status, body);
  decided.set(key, { decision, text: out.text, pending: false });
  renderWork(lastWork);
  showNotice(`#${task}${gate ? ` ${gate}` : ''} ${decision.toUpperCase()}: ${out.text}`, out.ok ? 'ok' : 'bad', out.reload);
  if (out.ok) fetch('/api/status').then((x) => x.json()).then(render).catch(() => {});
}

/** One-line banner under the header; `reload` adds a RELOAD button. */
function showNotice(text, kind = 'bad', reload = false) {
  const n = $('notice');
  n.className = `notice notice-${kind}`;
  n.innerHTML = `<span>${esc(text)}</span>${reload ? '<button class="act" data-reload>⟳ RELOAD</button>' : ''}<button class="act" data-dismiss aria-label="dismiss">✕</button>`;
}
$('notice').addEventListener('click', (e) => {
  if (e.target.closest('[data-reload]')) location.reload();
  if (e.target.closest('[data-dismiss]')) $('notice').className = 'notice hidden';
});

// a page served by an earlier board process (tab left open across a restart):
// its JS and token may be out of date, so say so before anyone clicks APPROVE
const pageBoot = document.querySelector('meta[name="board-boot"]')?.content || '';
let staleShown = false;
function checkBoot(serverBoot) {
  if (staleShown || !BoardDecide.staleBoot(pageBoot, serverBoot)) return;
  staleShown = true;
  showNotice('The board restarted since this page loaded. Reload before approving.', 'warn', true);
}

async function openLog(label, name) {
  $('drawer-title').textContent = name;
  $('drawer-log').textContent = 'loading…';
  $('drawer').classList.remove('hidden');
  const r = await fetch(`/api/log?job=${encodeURIComponent(label)}`).then((x) => x.json()).catch(() => null);
  if (!r) { $('drawer-log').textContent = 'log unavailable'; return; }
  const err = r.err ? `\n\n── stderr ──\n${r.err}` : '';
  $('drawer-log').textContent = (r.out || '(empty log)') + err;
  $('drawer-log').scrollTop = $('drawer-log').scrollHeight;
}
$('drawer-close').addEventListener('click', () => $('drawer').classList.add('hidden'));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('drawer').classList.add('hidden'); });

async function refreshFeed() {
  const items = await fetch('/api/feed').then((x) => x.json()).catch(() => []);
  $('feed').innerHTML = items.length
    ? items.map((i) => `<div class="feed-item">
        <span class="feed-time">${i.at ? new Date(i.at).toLocaleTimeString() : ''}</span>
        <div class="feed-title">${esc(i.title)}${i.subtitle ? ' · ' + esc(i.subtitle) : ''}</div>
        ${i.body ? `<div class="feed-body">${esc(i.body)}</div>` : ''}
      </div>`).join('')
    : '<div class="feed-empty">No agent events yet — activity from cmux sessions and Ops Board alerts appears here.</div>';
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// live updates: SSE with poll fallback
function connect() {
  const es = new EventSource('/events');
  es.onmessage = (e) => { $('live').classList.remove('stale'); render(JSON.parse(e.data)); };
  es.onerror = () => {
    $('live').classList.add('stale');
    es.close();
    setTimeout(connect, 5000);
  };
}
/* ---------- pointer tilt (hover-capable, motion-tolerant devices only) ---------- */
if (!reducedMotion && window.matchMedia('(hover: hover)').matches) {
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.card');
    document.querySelectorAll('.card.tilting').forEach((el) => { if (el !== card) { el.classList.remove('tilting'); el.style.removeProperty('--rx'); el.style.removeProperty('--ry'); } });
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;   // -0.5 .. 0.5
    const py = (e.clientY - r.top) / r.height - 0.5;
    card.classList.add('tilting');
    card.style.setProperty('--rx', `${(-py * 5).toFixed(2)}deg`);
    card.style.setProperty('--ry', `${(px * 6).toFixed(2)}deg`);
  }, { passive: true });
}

/* ---------- command palette ( / to filter ) ---------- */
let filterQuery = '';
function applyFilter(q) {
  filterQuery = q;
  const needle = q.trim().toLowerCase();
  let hits = 0;
  document.querySelectorAll('.card').forEach((el) => {
    const hay = `${el.dataset.name} ${el.dataset.label} ${el.textContent}`.toLowerCase();
    const hit = !needle || hay.includes(needle);
    el.classList.toggle('filter-hidden', !hit);
    el.classList.toggle('filter-hit', Boolean(needle) && hit);
    if (hit && needle) hits += 1;
  });
  document.querySelectorAll('.domain').forEach((sec) => {
    sec.classList.toggle('filter-hidden',
      Boolean(needle) && !sec.querySelector('.card:not(.filter-hidden)'));
  });
  $('attention-row').classList.toggle('filter-hidden',
    Boolean(needle) && !$('attention-grid').querySelector('.card:not(.filter-hidden)'));
  $('palette-count').textContent = needle ? `${hits} hit${hits === 1 ? '' : 's'}` : '';
}
function closePalette() {
  $('palette').classList.add('hidden');
  $('palette-input').value = '';
  applyFilter('');
}
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (e.key === '/' && !typing) {
    e.preventDefault();
    $('palette').classList.remove('hidden');
    $('palette-input').focus();
  } else if (e.key === 'Escape' && !$('palette').classList.contains('hidden')) {
    closePalette();
  }
});
$('palette-input').addEventListener('input', (e) => applyFilter(e.target.value));
$('palette-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const first = document.querySelector('.card.filter-hit') || document.querySelector('.card:not(.filter-hidden)');
  if (!first) return;
  first.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  if (!reducedMotion) { first.classList.add('glitch'); setTimeout(() => first.classList.remove('glitch'), 350); }
});

/* ---------- kiosk spotlight: cycle attention cards on the big screen ---------- */
if (tvMode) {
  let spotIdx = 0;
  setInterval(() => {
    const cards = document.querySelectorAll('#attention-grid .card');
    document.querySelectorAll('.card.spotlight').forEach((el) => el.classList.remove('spotlight'));
    if (!cards.length) return;
    spotIdx = (spotIdx + 1) % cards.length;
    cards[spotIdx].classList.add('spotlight');
  }, 7000);
}

/* ---------- boot sequence (once per browser session; skipped for reduced motion) ---------- */
function bootSequence() {
  if (reducedMotion || dockMode || sessionStorage.getItem('mc-boot')) { $('boot').classList.add('boot-done'); return; }
  sessionStorage.setItem('mc-boot', '1');
  const el = $('boot-text');
  const lines = [
    `${($('brand-name')?.textContent || 'Zulu Assistant').toUpperCase()} — phosphor link established`,
    'POLLING FLEET ............... <ok>OK</ok>',
    'CMUX BRIDGE ................. <ok>OK</ok>',
    'ESCALATION LADDER ........... <ok>ARMED</ok>',
    'RENDERING',
  ];
  let i = 0;
  const done = () => $('boot').classList.add('boot-done');
  const next = () => {
    if (i >= lines.length) return setTimeout(done, 180);
    el.innerHTML += (i ? '\n' : '') + lines[i].replace(/<ok>(.*?)<\/ok>/g, '<span class="ok">$1</span>');
    i += 1;
    setTimeout(next, 150);
  };
  $('boot').addEventListener('click', done, { once: true });
  next();
}
bootSequence();

setInterval(() => { $('clock').textContent = new Date().toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', second: '2-digit' }); }, 1000);
setInterval(refreshFeed, 30000);
fetch('/api/status').then((x) => x.json()).then(render).catch(() => {});
refreshFeed();
connect();

/* ---------- one-time star toast (src/star.mjs; consent rules there) ---------- */
// Shown once, at the first success moment, never in ?tv / ?dock. STAR only opens
// the repo page — the user stars it on GitHub, or doesn't. Nothing is automated.
let starShown = false;
function maybeStarToast(t) {
  if (!t || starShown || tvMode || dockMode) return;
  starShown = true;
  $('star-text').textContent = `Zulu just caught ${t.reason}. If it earned it, star the repo.`;
  $('star-toast').classList.remove('hidden');
  const report = (event) => fetch('/api/star', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }) }).catch(() => {});
  report('shown');
  $('star-yes').onclick = () => { report('star'); window.open(t.repoUrl, '_blank', 'noopener'); $('star-toast').classList.add('hidden'); };
  $('star-never').onclick = () => { report('never'); $('star-toast').classList.add('hidden'); };
}

/* ---------- share your setup: redacted PNG, download only ---------- */
// Every job, group and agent label is replaced by a generic name; only shapes,
// counts and status survive. Rendered locally to a canvas — nothing is uploaded.
const SHARE_COLOR = { ok: '#00d900', due: '#e5e500', stale: '#e5e500', warn: '#e5e500', failed: '#ff8c3c', overdue: '#ff4444', down: '#ff4444' };
function shareSvg(data) {
  const W = 1200, pad = 32, cw = 178, ch = 44, gap = 10, perRow = 6;
  const x = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const out = [];
  let y = pad + 70, n = 0;
  const domains = data.domains?.length ? data.domains : DOMAINS;
  domains.forEach((d, gi) => {
    const list = data.jobs.filter((j) => j.domain === d.id).sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status]);
    if (!list.length) return;
    out.push(`<rect x="${pad}" y="${y - 12}" width="8" height="8" fill="${x(d.accent)}"/><text x="${pad + 16}" y="${y - 4}" class="h">GROUP ${gi + 1}  ·  ${list.filter((j) => j.status === 'ok').length}/${list.length} ok</text>`);
    y += 6;
    list.forEach((j, i) => {
      const cx = pad + (i % perRow) * (cw + gap), cy = y + Math.floor(i / perRow) * (ch + gap);
      const st = STATUS[j.status] || STATUS.ok;
      n += 1;
      out.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="3" class="c" stroke="${j.status === 'ok' ? '#0d5f0d' : SHARE_COLOR[j.status]}"/>`
        + `<text x="${cx + 10}" y="${cy + 27}" class="t">job ${String(n).padStart(2, '0')}</text>`
        + `<text x="${cx + cw - 10}" y="${cy + 27}" text-anchor="end" fill="${SHARE_COLOR[j.status] || '#00d900'}" class="s">${st.glyph} ${st.label}</text>`);
    });
    y += Math.ceil(list.length / perRow) * (ch + gap) + 28;
  });
  const agents = (data.sessions || []).filter((s) => s.active);
  if (agents.length) {
    out.push(`<text x="${pad}" y="${y}" class="h">AGENTS  ·  ${agents.length} live</text>`);
    y += 12;
    agents.forEach((s, i) => {
      const lc = LIFECYCLE[s.lifecycle] || LIFECYCLE.unknown;
      const cx = pad + (i % perRow) * (cw + gap), cy = y + Math.floor(i / perRow) * (ch + gap);
      out.push(`<rect x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="3" class="c" stroke="#0d5f0d"/><text x="${cx + 10}" y="${cy + 27}" class="t">${lc.glyph} agent ${i + 1} · ${lc.label}</text>`);
    });
    y += Math.ceil(agents.length / perRow) * (ch + gap) + 20;
  }
  const H = y + 50;
  const c = data.counts;
  const link = String(data.repoUrl || '').replace(/^https?:\/\//, '');
  return { W, H, svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>text{font-family:ui-monospace,Menlo,monospace;fill:#00ee00}.b{font-size:26px;font-weight:700;fill:#d8ffd8;letter-spacing:4px}.h{font-size:13px;fill:#00a600;letter-spacing:2px}.t{font-size:13px}.s{font-size:12px;font-weight:700}.c{fill:#030903}.f{font-size:13px;fill:#157a15}</style>
<rect width="100%" height="100%" fill="#000"/>
<text x="${pad}" y="${pad + 22}" class="b">${x((data.brand || 'Zulu Assistant').toUpperCase())}</text>
<text x="${W - pad}" y="${pad + 22}" text-anchor="end" class="h">${c.ok}/${c.total} healthy · ${c.attention} need attention · ${c.agents || 0} agents</text>
${out.join('\n')}
<text x="${pad}" y="${H - 22}" class="f">my setup, redacted — ${x(link)}</text>
</svg>` };
}
$('share-btn').addEventListener('click', () => {
  if (!lastData) return;
  const { W, H, svg } = shareSvg(lastData);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  img.onload = () => {
    const cv = document.createElement('canvas');
    cv.width = W * 2; cv.height = H * 2;
    const g = cv.getContext('2d'); g.scale(2, 2); g.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    cv.toBlob((png) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(png); a.download = 'zulu-setup.png'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, 'image/png');
  };
  img.src = url;
});
