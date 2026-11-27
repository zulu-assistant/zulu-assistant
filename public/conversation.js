/* Conversation view (?conversation=<session id>): the last turns of one agent session, from
 * GET /api/conversation. Read-only: nothing can be sent from this page, and it holds no decision
 * token. The text is untrusted (an agent wrote it): it is escaped and shown as plain text, links in
 * it are not made clickable. Rendering is pure (ConversationView.render), tested by
 * test/conversation.test.mjs. */
(function (root) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** "11-07 12:04Z": compact UTC. */
  function when(iso) {
    const d = new Date(iso);
    if (!iso || Number.isNaN(d.getTime())) return '';
    return `${d.toISOString().slice(5, 10)} ${d.toISOString().slice(11, 16)}Z`;
  }

  const WHO = {
    mesh: { cls: 'cv-user', label: '→ TO THE AGENT · MESH' },
    typed: { cls: 'cv-user', label: '→ TO THE AGENT' },
    agent: { cls: 'cv-agent', label: '← THE AGENT' },
  };

  /** Tool calls in a row fold into one line; the names and the agent's own descriptions only. */
  function toolRun(tools) {
    const line = (t) => `<li><span class="cv-tool">${esc(t.name)}</span>${t.note ? ` <span class="cv-note">${esc(t.note)}</span>` : ''}</li>`;
    if (tools.length <= 3) return `<ul class="cv-tools">${tools.map(line).join('')}</ul>`;
    return `<details class="cv-tools-fold"><summary>${tools.length} tool calls</summary><ul class="cv-tools">${tools.map(line).join('')}</ul></details>`;
  }

  function agentBody(parts) {
    let out = ''; let run = [];
    const flush = () => { if (run.length) { out += toolRun(run); run = []; } };
    for (const p of parts || []) {
      if (p.kind === 'tool') { run.push(p); continue; }
      flush();
      out += `<div class="cv-text">${esc(p.text)}</div>`;
    }
    flush();
    return out;
  }

  function entry(e) {
    if (e.role === 'note') return `<li class="cv-entry cv-notice">${esc(e.text)}</li>`;
    const w = e.role === 'agent' ? WHO.agent : WHO[e.via] || WHO.typed;
    const body = e.role === 'agent' ? agentBody(e.parts) : `<div class="cv-text">${esc(e.text)}</div>`;
    return `<li class="cv-entry ${w.cls}"><div class="cv-who">${w.label} <span class="cv-dim">${esc(when(e.at))}</span></div>${body}</li>`;
  }

  /** The whole list for one reading. */
  function render(r) {
    if (!r || !Array.isArray(r.entries)) return '<p class="cv-dim">no reading</p>';
    if (!r.entries.length) return '<p class="cv-dim">Nothing was said in the part of the session that was read.</p>';
    const older = r.cut || r.partial ? '<li class="cv-entry cv-notice">Earlier turns are not shown: this is the end of the session, not all of it.</li>' : '';
    return `<ol class="cv-list">${older}${r.entries.map(entry).join('')}</ol>`;
  }

  root.ConversationView = { render, entry, when };

  // ---- page wiring (browser only) ----
  if (typeof document === 'undefined' || !document.getElementById('cv-body')) return;
  const body = document.getElementById('cv-body');
  const meta = document.getElementById('cv-meta');
  const id = new URLSearchParams(location.search).get('conversation') || '';
  let last = '';
  async function load() {
    try {
      const res = await fetch(`/api/conversation?session=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { meta.textContent = r.msg || `HTTP ${res.status}`; body.innerHTML = ''; last = ''; return; }
      const html = render(r);
      if (html !== last) {
        // stay at the end only when the reader already was there
        const atEnd = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
        body.innerHTML = html; last = html;
        if (atEnd) window.scrollTo(0, document.body.scrollHeight);
      }
      meta.textContent = `read-only · last written ${when(r.at)} · checked ${when(new Date().toISOString())}`;
    } catch {
      meta.textContent = 'board unreachable';
    }
  }
  load();
  setInterval(load, 10000);
})(typeof globalThis !== 'undefined' ? globalThis : this);
