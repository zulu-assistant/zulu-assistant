/* Evidence panel (Zulu 1.2, ?evidence=1): one expandable row per task — the
 * completion packet and the gate receipts — from GET /api/evidence. Read-only:
 * this page never writes. Rendering is pure (EvidenceView.renderRows), tested by
 * test/evidence.test.mjs; the server has already withheld secret-looking text. */
(function (root) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (sha) => (sha ? String(sha).slice(0, 7) : '?');

  /** "11-07 12:04Z" — compact UTC, the column is narrow. */
  function when(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '—';
    return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}Z`;
  }

  /** The one-line badge for a row's packet: ✓ ok, ⚠ STALE, ✗ missing, or "no packet yet" while live. */
  function badge(r) {
    if (r.packet?.stale) return { cls: 'warn', text: '⚠ STALE' };
    if (r.packet) return { cls: 'ok', text: '✓ PACKET' };
    if (r.missing) return { cls: 'bad', text: '✗ EVIDENCE MISSING' };
    return { cls: 'dim', text: r.live ? '· live' : '· no packet' };
  }

  function testsLine(p) {
    if (!p.tests.length) return '<div class="ev-dim">tests: none recorded</div>';
    return `<ul class="ev-tests">${p.tests.map((s) => `<li class="${s.exit === 0 ? 'ok' : 'bad'}">`
      + `${s.exit === 0 ? '✓' : '✗'} <code>${esc(s.command)}</code> exit ${esc(s.exit)} @${esc(short(s.rev))}`
      + `${s.dirty ? ' <span class="warn">dirty</span>' : ''}${s.stale ? ` <span class="warn">stale: ${esc(s.stale)}</span>` : ''}`
      + ` <span class="ev-dim">${esc(when(s.at))}</span></li>`).join('')}</ul>`;
  }

  function prLine(p, r) {
    if (p?.pr?.unavailable) return `PR unavailable (${esc(p.pr.unavailable)})`;
    if (p?.pr) return `PR #${esc(p.pr.number ?? '?')} @${esc(short(p.pr.head))} ${esc(String(p.pr.state || '').toLowerCase())}`;
    return r.pr ? `PR ${esc(r.pr)}` : 'PR: none linked';
  }

  function packetBlock(r) {
    const p = r.packet;
    if (!p) {
      return r.missing
        ? '<div class="ev-sec"><div class="bad">✗ closed without a completion packet</div></div>'
        : '<div class="ev-sec ev-dim">no completion packet yet (recorded at close)</div>';
    }
    return `<div class="ev-sec"><div class="ev-h">COMPLETION PACKET <span class="ev-dim">${esc(when(p.at))}</span>`
      + `${p.stale ? ` <span class="warn">⚠ STALE (${esc(p.stale)})</span>` : ''}</div>`
      + (p.requested ? `<div class="ev-req">${esc(p.requested)}</div>` : '')
      + `<div>${prLine(p, r)}</div>`
      + testsLine(p)
      + (p.unrun.length ? `<div class="warn">not run: ${p.unrun.map(esc).join('; ')}</div>` : '')
      + (p.gates.length ? `<div>gates: ${p.gates.map((g) => `${esc(g.id)} ${esc(g.status)}`).join(', ')}</div>` : '')
      + (p.summary?.text ? `<div class="ev-sum"><span class="ev-dim">summary (generated):</span> ${esc(p.summary.text)}</div>` : '')
      + (p.trimmed ? '<div class="ev-dim">(trimmed to fit)</div>' : '')
      + '</div>';
  }

  function gateRow(g) {
    const who = g.auto ? `auto-approved under program go ${esc(g.auto.go || '?')}`
      : g.decided_by ? `${esc(g.decision === 'decline' ? 'declined' : 'approved')} by ${esc(g.decided_by)}${g.via ? ` via ${esc(g.via)}` : ''}` : 'undecided';
    return `<li><span class="ev-gid">${esc(g.id)}</span> <span class="ev-cls">${esc(g.cls || '?')}</span> ${esc(g.status || '?')}`
      + `<div class="ev-dim">${esc(g.label || '')}</div>`
      + `<div class="ev-times">asked ${esc(when(g.requested_at))} · ${who}${g.decided_at ? ` ${esc(when(g.decided_at))}` : ''}`
      + ` · ${g.executed_at ? `ran ${esc(when(g.executed_at))}` : 'not run'}</div>`
      + (g.reason && !g.auto ? `<div class="ev-dim">reason: ${esc(g.reason)}</div>` : '')
      + '</li>';
  }

  function gatesBlock(r) {
    if (!r.gates.length) return '<div class="ev-sec ev-dim">gate receipts: none</div>';
    return `<div class="ev-sec"><div class="ev-h">GATE RECEIPTS (${r.gates.length})</div><ul class="ev-gates">${r.gates.map(gateRow).join('')}</ul></div>`;
  }

  /** One <details> row per task. open = a set of ids to keep expanded across refreshes. */
  function renderRow(r, open) {
    const b = badge(r);
    return `<details class="ev-row${r.live ? ' ev-live' : ''}" data-id="${esc(r.id)}"${open && open.has(String(r.id)) ? ' open' : ''}>`
      + `<summary><span class="ev-id">#${esc(r.id)}</span> <span class="ev-badge ${b.cls}">${esc(b.text)}</span>`
      + `${r.gates.length ? ` <span class="ev-dim">⛨${r.gates.length}</span>` : ''}`
      + `<div class="ev-title">${esc(r.title)}</div>`
      + `<div class="ev-dim">${esc(r.status)} · ${esc(r.owner || '—')} · ${esc(when(r.closed_at || r.updated_at))}</div></summary>`
      + packetBlock(r) + gatesBlock(r) + '</details>';
  }

  function renderRows(rows, open) {
    if (!rows.length) return '<div class="ev-empty">no tasks match</div>';
    const live = rows.filter((r) => r.live), closed = rows.filter((r) => !r.live);
    return (live.length ? `<div class="ev-group">LIVE · ${live.length}</div>${live.map((r) => renderRow(r, open)).join('')}` : '')
      + (closed.length ? `<div class="ev-group">CLOSED · ${closed.length}</div>${closed.map((r) => renderRow(r, open)).join('')}` : '');
  }

  const api = { esc, when, badge, renderRow, renderRows };
  root.EvidenceView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ---- page wiring (browser only) ----
  if (typeof document === 'undefined' || !document.getElementById('ev-list')) return;
  const list = document.getElementById('ev-list');
  const meta = document.getElementById('ev-meta');
  const filter = document.getElementById('ev-filter');
  // ?task=N (the receipts link on a waiting row) starts the panel on that task
  const asked = new URLSearchParams(location.search).get('task');
  if (/^\d+$/.test(asked || '')) filter.value = `#${asked}`;
  const open = new Set();
  let rows = [];
  let timer = null;
  list.addEventListener('toggle', (e) => {
    const id = e.target?.dataset?.id;
    if (id) e.target.open ? open.add(id) : open.delete(id);
  }, true);
  async function load() {
    const q = filter.value.trim();
    const qs = new URLSearchParams({ limit: '100' });
    if (/^#?\d+$/.test(q)) qs.set('task', q.replace('#', '')); else if (q) qs.set('q', q);
    try {
      const res = await fetch(`/api/evidence?${qs}`, { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { meta.textContent = body.msg || `HTTP ${res.status}`; list.innerHTML = ''; return; }
      rows = body.rows || [];
      list.innerHTML = renderRows(rows, open);
      const missing = rows.filter((r) => r.missing).length;
      meta.textContent = `${rows.length}${body.total > rows.length ? ` of ${body.total}` : ''} tasks · live + closed ${body.days}d${missing ? ` · ${missing} missing evidence` : ''} · ${when(new Date().toISOString())}`;
    } catch {
      meta.textContent = 'board unreachable';
    }
  }
  filter.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  load();
  setInterval(load, 60000);
})(typeof globalThis !== 'undefined' ? globalThis : this);
