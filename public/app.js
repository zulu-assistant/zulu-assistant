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
if (dockMode) { document.body.classList.add('dock'); BoardDecide.dockLayout(document); }   // #450

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
  // the one-click upgrade (#346): only a release install's card carries `upgrade`; the owner's click is the approval
  if (job.label === 'update') {
    if (!job.upgrade) return '';
    const notes = job.upgrade.notesUrl ? `<a class="act" href="${job.upgrade.notesUrl}" target="_blank" rel="noopener">NOTES ↗</a>` : '';
    return `<div class="card-actions"><button class="act act-dispatch" data-act="upgrade" data-label="update" data-to="${job.upgrade.to}">⇧ UPDATE TO ${job.upgrade.to}</button>${notes}</div>`;
  }
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
  const r = act === 'upgrade'
    ? await fetch('/api/upgrade', {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-mesh-decision': document.querySelector('meta[name="mesh-decision"]')?.content || '' },
      body: JSON.stringify({ to: btn.dataset.to }),
    }).then((x) => (x.status === 403 ? { ok: false, msg: 'REJECTED: page is out of date, reload and click again' } : x.json()))
      .catch(() => ({ ok: false, msg: 'request failed: board unreachable' }))
    : await fetch('/api/action', {
      method: 'POST', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-mesh-decision': document.querySelector('meta[name="mesh-decision"]')?.content || '' },
      body: JSON.stringify({ action: act, label }),
    }).then((x) => (x.status === 403 ? x.json().catch(() => ({})).then((j) => ({ ok: false, msg: /token/.test(j.msg || '') ? 'REJECTED: page is out of date, reload and click again' : (j.msg || 'refused') })) : x.json()))
      .catch(() => ({ ok: false, msg: 'request failed: board unreachable' }));
  btn.disabled = false;
  btn.classList.remove('armed');
  btn.textContent = r.ok ? '✓ ' + (act === 'dispatch' ? 'DISPATCHED' : act === 'upgrade' ? 'UPGRADING' : 'DONE') : '✕ FAILED';
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
  // Dock: only when some context is amber/red, or (status taxonomy on) an agent is UNKNOWN or waiting on input
  const stateOf = (s) => dir[s.workspaceId]?.stateRaw?.state;
  $('agents-row').classList.toggle('hidden', sessions.length === 0
    || (dockMode && !sessions.some((s) => (s.ctx && s.ctx.band !== 'ok') || ['unknown', 'input'].includes(stateOf(s)))));
  $('agents-grid').innerHTML = sessions.map((s) => {
    const lc = LIFECYCLE[s.lifecycle] || LIFECYCLE.unknown;
    const title = s.workspace || s.cwd || '~';
    const sub = s.workspace && s.cwd && s.workspace !== s.cwd ? s.cwd : '';
    const d = dir[s.workspaceId];
    // directory: mesh address + owned domains (hover; always shown in ?tv)
    const owns = d?.owns?.length ? d.owns.join(' · ') : (d ? '— needs ownership —' : '');
    const hover = d ? `@${d.name} (${d.kind})${owns ? '\n' + owns : ''}${d.nameOk === false ? `\nsession name "${d.liveName}" ≠ title` : ''}` : '';
    const quiet = !s.ctx || s.ctx.band === 'ok' ? 'ctx-quiet' : '';
    // status taxonomy (on): state + source mark (◌ / "?" = low confidence, "screen" = inferred), why in the tooltip
    const sv = s.active && d?.state;
    const stCls = sv ? ` st-${d.stateRaw.state}${d.stateRaw.confidence !== 'high' ? ' st-unsure' : ''}` : '';
    const stateSpan = sv
      ? `<span class="agent-state" title="${esc(sv.tip)}"><span aria-hidden="true">${sv.glyph}</span>${esc(sv.label)}${sv.inferred ? ' <span class="st-src">screen</span>' : ''}</span>`
      : `<span class="agent-state"><span aria-hidden="true">${lc.glyph}</span>${s.active ? lc.label : 'RESTORABLE'}</span>`;
    return `<div class="agent-tile ${lc.cls}${stCls} ${s.active ? '' : 'a-closed'} ${quiet}" title="${esc(hover)}">
      ${stateSpan}
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
  $('attention-row').classList.toggle('hidden', attention.length === 0 && !dockMode);   // the Dock's decisions live here (#450)
  $('attention-grid').innerHTML = attention.map((j) => card(j, strips)).join('');

  $('demo-badge').classList.toggle('hidden', !data.demo);
  // Guardrails-only install (SETTINGS.profile): the waiting rows, the ledger and the board's own cards. No fleet, no agents.
  document.body.classList.toggle('profile-guardrails', data.profile === 'guardrails');
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
  done:           { glyph: '✓', label: 'DONE',     cls: 't-done' },
};

// completion packet (closed tasks): PR + tests line, STALE in amber, the summary labelled generated
function evidenceRow(ev) {
  if (!ev) return '';
  return `<div class="task-evidence${ev.stale ? ' is-stale' : ''}" title="${esc(ev.generated ? 'summary (generated by the agent): ' + ev.generated : '')}">`
    + `<span class="ev-label">EVIDENCE</span> ${esc(ev.line)}`
    + `${ev.stale ? ` <span class="chip ev-stale"><span aria-hidden="true">△</span>STALE · ${esc(ev.stale)}</span>` : ''}</div>`;
}
const ageLabel = (h) => (h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

function taskRow(t, opts = {}) {
  const st = TASK_STATE[t.status] || TASK_STATE.open;
  const on = t.blocked_on?.length ? ` · on ${t.blocked_on.map((x) => (typeof x === 'number' ? '#' + x : x)).join(', ')}` : '';
  const dec = t.status === 'needs_approval' ? null : t.approval?.decision;
  const decLabel = { approve: '✓ approved', decline: '✕ declined', unrecorded: 'answer unrecorded', withdrawn: 'withdrawn' }[dec];
  const policy = t.approval?.policy_item
    ? `<span class="task-policy">${decLabel ? `${esc(decLabel)}${t.approval.via === 'pane' ? ' in pane' : ''} · ` : ''}${esc(t.approval.policy_item)}</span>` : '';
  const btn = (decision, label, cls) => {
    const res = decided.get(`${t.id}`);
    const armed = decideArmed && decideArmed.task === `${t.id}` && decideArmed.decision === decision && Date.now() < decideArmed.until;
    const text = res?.decision === decision ? res.text : armed ? BoardDecide.armedLabel(decision, `#${t.id}`) : label;
    return `<button class="act ${cls}${armed ? ' armed' : ''}" data-task="${t.id}" data-decision="${decision}"${res?.pending ? ' disabled' : ''}>${esc(text)}</button>`;
  };
  // a plain approval request (POLICY.md item) — gates carry their own buttons below
  const asking = t.status === 'needs_approval' && t.approval && !t.approval.decision && !opts.hideAsk;   // hideAsk: a snoozed approval (attention strip)
  // a pane answer an agent recorded: it counts only when the owner confirms it here (or says it is not what was said)
  const heard = asking ? BoardDecide.proposalHtml(t.approval.proposal, esc) : '';
  const H = BoardDecide.HEARD_LABELS;
  const btns = asking
    ? `${heard}<div class="task-actions">${btn('approve', heard ? H.approve : '✓ APPROVE', 'act-approve')}${btn('decline', '✕ DECLINE', 'act-decline')}${heard ? btn('disown', H.disown, 'act-decline act-disown') : ''}</div>` : '';
  const gates = (t.gates || []).map((g) => gateRow(t, g)).join('');
  const go = t.program_go ? goRow(t) : '';
  return `<div class="task ${st.cls}">
    <div class="task-top"><span class="task-id">#${t.id}</span><span class="task-title">${esc(t.title)}</span>
      <span class="chip task-chip"><span aria-hidden="true">${st.glyph}</span>${st.label}</span></div>
    <div class="task-meta">${esc(t.owner || 'unowned')} · ${ageLabel(t.ageH)}${esc(on)}${t.priority !== 'normal' ? ' · ' + esc(t.priority) : ''}</div>
    ${policy}
    ${t.last ? `<div class="task-last">${esc(t.last)}</div>` : ''}
    ${evidenceRow(t.evidence)}
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

// Guardrails: one row per pending gate. Approval is of the EXACT text: a long command starts
// folded below the buttons (#444), and one click shows the whole of it, wrapped, never cut.
const evidenceOn = document.querySelector('meta[name="evidence-panel"]')?.content === 'on';   // row context: receipts link
const gateCmdOpen = new Set();            // gates ("task:gate") whose command was unfolded; kept while the page lives
function gateRow(t, g) {
  const key = `${t.id}:${g.id}`;
  const btn = (decision, label, cls) => {
    const res = decided.get(key);
    const armed = decideArmed && decideArmed.task === key && decideArmed.decision === decision && Date.now() < decideArmed.until;
    const text = res?.decision === decision ? res.text : armed ? BoardDecide.armedLabel(decision, g.id, g.proposal) : label;
    return `<button class="act ${cls}${armed ? ' armed' : ''}" data-task="${t.id}" data-gate="${esc(g.id)}" data-decision="${decision}"${res?.pending ? ' disabled' : ''}>${esc(text)}</button>`;
  };
  const age = ageLabel((Date.now() - Date.parse(g.requested_at)) / 36e5);
  // a recorded pane answer (or an approval typed in a terminal) waits on this gate: the approve
  // button confirms it, and a third button rejects the record
  const heard = !!BoardDecide.proposalHtml(g.proposal, esc);
  const H = BoardDecide.heardLabels(g.proposal);
  const actions = btn('approve', heard ? `${H.approve} · RUN ONCE` : '✓ RUN ONCE', 'act-approve') + btn('decline', '✕ DECLINE', 'act-decline')
    + (heard ? btn('disown', H.disown, 'act-decline act-disown') : '');
  const receiptHref = evidenceOn ? `/?evidence=1&task=${t.id}` : null;   // row context: a dry run's time links to the task's receipts
  return BoardDecide.gateRowHtml(g, { key, esc, age, receiptHref, open: gateCmdOpen.has(key), actions });
}
function onCommandToggle(e) {
  const b = e.target.closest('[data-cmd-toggle]');
  if (!b) return;
  const key = b.dataset.cmdToggle;
  if (!gateCmdOpen.delete(key)) gateCmdOpen.add(key);
  renderWork(lastWork);
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
    + col('OPEN / IN PROGRESS', w.open, 'no open cross-agent tasks')
    // closed in the last 24h — shown only when one carries a completion packet (the evidence is the point)
    + ((w.closed24h || []).some((t) => t.evidence) ? col('CLOSED 24H · EVIDENCE', w.closed24h.filter((t) => t.evidence), '') : '');
  renderDecisions(w);
}

// Guardrails: the owner's decisions pinned at the top (same rows and buttons as WORK, oldest first),
// and a "(N) " title prefix so a background tab shows the count. Hidden when nothing waits.
// In the Dock the decisions sit in NEEDS ATTENTION and count there; this section is the blocks (#450).
const BASE_TITLE = document.title;
const setDockCount = (n) => { if (dockMode) $('attention-title').textContent = `NEEDS ATTENTION · ${n}`; };
function renderDecisions(w) {
  if (lastData?.attention) return renderAttention(w, lastData.attention);
  $('decisions-fold').innerHTML = '';
  const waiting = [...(w.needsApproval || [])].sort((a, b) => b.ageH - a.ageH);
  const n = waiting.reduce((k, t) => k + (t.gates?.length || 0) + (t.approval && !t.approval.decision ? 1 : 0), 0);
  document.title = n ? `(${n}) ${BASE_TITLE}` : BASE_TITLE;
  const st = BoardDecide.decisionsState(waiting.length, dockMode);
  $('decisions').classList.toggle('hidden', st.hidden);
  $('decisions').classList.toggle('is-empty', st.empty);
  $('decisions-title').textContent = `WAITING ON ${String(w.owner || 'you').toUpperCase()} · ${n}`;
  $('decisions-list').innerHTML = waiting.length || !dockMode ? waiting.map(taskRow).join('') : BoardAttention.NOTHING;
  setDockCount(n);
  focusItem();
}

// ?item=<task>[:<gate>] (the phone relay's link, #415): highlight that row in the strip and scroll to it
// once. It NEVER arms or clicks anything: deciding is still the usual two clicks.
const ITEM = (/^(\d+)(?::(g\d+))?$/.exec(new URLSearchParams(location.search).get('item') || '') || []).slice(1);
let itemScrolled = false;
function focusItem() {
  if (!ITEM[0]) return;
  const sel = ITEM[1] ? `[data-task="${ITEM[0]}"][data-gate="${ITEM[1]}"]` : `[data-task="${ITEM[0]}"]`;
  const btn = $('decisions-list').querySelector(sel);
  const row = btn && (btn.closest('.gate') || btn.closest('.task'));
  if (!row) return;
  row.classList.add('item-focus');
  if (!itemScrolled) { itemScrolled = true; row.scrollIntoView({ block: 'center' }); }
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
$('work-cols').addEventListener('click', onCommandToggle);
$('decisions-list').addEventListener('click', onCommandToggle);

// Attention ring (SETTINGS.attention.snooze 'on', public/attention.js): one row per task, expand on
// click, a snooze control per row (pick a length, then click it again), snoozed items in a dim fold.
const attExpanded = new Set();            // block-only task ids opened in the strip (this tab only)
const attCollapsed = new Set();           // decision task ids closed by hand; decisions start open (#437)
const attPicking = new Set();             // task ids whose snooze choices are showing
const attResults = new Map();             // 'snooze:<task>' | 'wake:<item>' -> { text, pending }
let attArmed = null;
let attFoldOpen = false;
let attBlocksOpen = false;                // the "blocked on you (n)" fold
let itemOpened = false;
function renderAttention(w, view) {
  const tasks = new Map([...(w.needsApproval || []), ...(w.blocked || [])].map((t) => [t.id, t]));
  // the relay's ?item= link (#415) opens its task's row once, so focusItem can highlight the gate
  if (ITEM[0] && !itemOpened && (view.groups || []).some((g) => String(g.task) === ITEM[0])) { itemOpened = true; attExpanded.add(ITEM[0]); attCollapsed.delete(ITEM[0]); }
  const r = BoardAttention.renderStrip(view, tasks, {
    esc, taskRow, dock: dockMode, expanded: attExpanded, collapsed: attCollapsed, picking: attPicking, results: attResults,
    armed: attArmed, now: Date.now(), foldOpen: attFoldOpen, blocksOpen: attBlocksOpen,
  });
  const count = dockMode ? r.decisionItems : r.count;   // the Dock's title counts decisions only; its blocks have their own section
  document.title = count ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
  const st = BoardDecide.decisionsState(r.count, dockMode, r.snoozedCount, r.blocks);
  $('decisions').classList.toggle('hidden', st.hidden);
  $('decisions').classList.toggle('is-empty', st.empty);
  $('decisions-title').textContent = `WAITING ON ${String(w.owner || 'you').toUpperCase()} · ${dockMode ? r.blocks : r.count}${r.snoozedCount ? ` · ⏾ ${r.snoozedCount}` : ''}`;
  $('decisions-list').innerHTML = r.html;
  $('decisions-fold').innerHTML = r.fold;
  setDockCount(r.decisionItems);
  focusItem();
}
function onAttentionClick(e) {
  const el = e.target.closest('[data-att-toggle], [data-snooze-open], [data-snooze-close], [data-snooze], [data-unsnooze]');
  if (!el) return;
  const d = el.dataset;
  if (d.attToggle) { const set = d.attDecision ? attCollapsed : attExpanded; set.has(d.attToggle) ? set.delete(d.attToggle) : set.add(d.attToggle); }
  else if (d.snoozeOpen) { attPicking.add(d.snoozeOpen); attResults.delete(`snooze:${d.snoozeOpen}`); }
  else if (d.snoozeClose) { attPicking.delete(d.snoozeClose); attArmed = null; }
  else {
    const key = d.snooze ? `snooze:${d.snooze}` : `wake:${d.unsnooze}`;
    const r = BoardDecide.armClick(attArmed, key, d.snooze ? d.for : 'wake', Date.now());
    attArmed = r.armed;
    if (r.fire) {
      const group = (lastData?.attention?.groups || []).find((g) => String(g.task) === d.snooze);
      sendSnooze(key, d.snooze ? 'snooze' : 'unsnooze', d.snooze ? (group?.items || []).map((i) => i.id) : [d.unsnooze], d.for);
    } else setTimeout(() => renderWork(lastWork), BoardDecide.ARM_MS + 50);
  }
  renderWork(lastWork);
}
$('decisions-list').addEventListener('click', onAttentionClick);
$('decisions-fold').addEventListener('click', onAttentionClick);
$('decisions-fold').addEventListener('toggle', (e) => { if (e.target.classList.contains('att-blocks')) attBlocksOpen = e.target.open; else attFoldOpen = e.target.open; }, true);

async function sendSnooze(key, op, items, choice) {
  attResults.set(key, { text: '… SENDING', pending: true });
  renderWork(lastWork);
  const token = document.querySelector('meta[name="mesh-decision"]')?.content || '';
  let status = 0; let body = null;
  try {
    const res = await fetch(`/api/attention/${op}`, {
      method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json', 'x-mesh-decision': token },
      body: JSON.stringify({ items, for: choice }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* status 0 = never reached the board */ }
  const out = BoardDecide.decisionOutcome(status, body);
  attResults.set(key, { text: out.ok ? (op === 'snooze' ? '⏾ SNOOZED' : '✓ AWAKE') : out.text, pending: false });
  if (out.ok) {
    attPicking.delete(key.replace(/^snooze:/, ''));
    if (body?.attention && lastData) lastData.attention = body.attention;
  }
  renderWork(lastWork);
  showNotice(`${op === 'snooze' ? 'SNOOZE' : 'WAKE'} ${items.join(', ')}: ${out.ok ? (op === 'snooze' ? `snoozed until ${new Date(body.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — nothing decided` : 'back on the strip') : out.text}`, out.ok ? 'ok' : 'bad', out.reload);
  setTimeout(() => { attResults.delete(key); renderWork(lastWork); }, 4000);
}

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
      body: JSON.stringify(BoardDecide.decisionBody(decision, gate, revoke)),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch { /* status 0 = never reached the board */ } finally { clearTimeout(timer); }
  const out = BoardDecide.decisionOutcome(status, body);
  decided.set(key, { decision, text: out.text, pending: false });
  renderWork(lastWork);
  showNotice(`#${task}${gate ? ` ${gate}` : ''} ${decision === 'disown' ? 'NOT WHAT I SAID' : decision.toUpperCase()}: ${out.text}`, out.ok ? 'ok' : 'bad', out.reload);
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
