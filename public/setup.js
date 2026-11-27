/* Setup page (?setup=1): the guided setup's checklist with live checks, from GET /api/setup.
 * Read-only: this page never writes and holds no decision token. Each open step shows the
 * terminal command that does it today. Rendering is pure (SetupView.render), tested by
 * test/setup-page.test.mjs. */
(function (root) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // glyph + word, never colour alone
  const MARK = {
    done: { cls: 'ok', glyph: '✔', word: 'DONE' },
    skipped: { cls: 'dim', glyph: '–', word: 'SKIPPED' },
    check: { cls: 'warn', glyph: '⚠', word: 'CHECK AGAIN' },
    todo: { cls: 'todo', glyph: '○', word: 'TO DO' },
  };

  function stepRow(s, checking) {
    const m = MARK[s.status] || MARK.todo;
    const detail = s.live ? s.live.detail : (checking && s.status !== 'skipped' ? 'checking…' : '');
    const was = s.status === 'check' ? 'was done; now: ' : '';
    const cmd = s.status === 'done' ? ''
      : `<div class="su-cmd"><span class="su-dim">in a terminal:</span> <kbd>${esc(s.command)}</kbd>`
        + ` <button type="button" class="su-copy" data-copy="${esc(s.command)}">COPY</button></div>`;
    return `<li class="su-step su-${esc(s.status)}" data-step="${esc(s.id)}">`
      + `<div class="su-line"><span class="su-mark ${m.cls}"><span aria-hidden="true">${m.glyph}</span> ${m.word}</span>`
      + ` <span class="su-title">${esc(s.title)}</span>`
      + `${s.required ? '' : ' <span class="su-dim">(optional)</span>'}</div>`
      + (detail ? `<div class="su-detail">${esc(was + detail)}</div>` : '')
      + cmd + '</li>';
  }

  function nextBlock(r) {
    return '<section class="su-sec"><h2>WHEN YOU WANT MORE</h2>'
      + '<p class="su-dim">Nothing is owed. Each of these is one command, and each is your choice.</p><ul class="su-next">'
      + r.nextSteps.map((n) => `<li><div>${esc(n.what)}</div><div class="su-cmd"><kbd>${esc(n.run)}</kbd>`
        + ` <button type="button" class="su-copy" data-copy="${esc(n.run)}">COPY</button></div></li>`).join('')
      + '</ul></section>';
  }

  function checklistBlock(r, heading) {
    return `<section class="su-sec"><h2>${esc(heading)}</h2><ol class="su-steps">`
      + r.steps.map((s) => stepRow(s, r.checking)).join('') + '</ol></section>';
  }

  /** The line under the header: where this install stands, in one sentence. */
  function headline(r) {
    if (r.profile === 'guardrails') return 'Guardrails-only install: the board, the ledger and the gate. The guided setup below belongs to the full install.';
    if (!r.installed) return 'This board was set up by hand, so no setup is recorded. The checks below are live.';
    if (r.lead === 'next') return 'The board is installed and nothing else. The guided setup below is part of the full install.';
    if (r.summary.complete) return r.summary.requiredOpen.length ? `Setup is finished, with required steps skipped: ${r.summary.requiredOpen.join(', ')}.` : 'Setup is complete.';
    return `Setup: ${r.summary.handled} of ${r.summary.total} steps handled.`;
  }

  /** The whole page body for one reading. */
  function render(r) {
    if (!r || !Array.isArray(r.steps)) return '<p class="su-dim">no reading</p>';
    const head = `<p class="su-head">${esc(headline(r))}</p>`
      + (r.write
        ? '<p class="su-dim">The owner, watch and engines steps can be answered above, on this Mac. Every other step is done in a terminal.</p>'
        : '<p class="su-dim">This page only shows where setup stands. It changes nothing.</p>');
    return r.lead === 'next'
      ? head + nextBlock(r) + checklistBlock(r, 'THE GUIDED SETUP (FULL INSTALL)')
      : head + checklistBlock(r, 'STEPS') + nextBlock(r);
  }

  root.SetupView = { render, headline, stepRow };

  // ---- page wiring (browser only) ----
  if (typeof document === 'undefined' || !document.getElementById('su-body')) return;
  const body = document.getElementById('su-body');
  const meta = document.getElementById('su-meta');
  let timer = null;
  body.addEventListener('click', (e) => {
    const b = e.target.closest?.('.su-copy');
    if (!b) return;
    const done = () => { b.textContent = 'COPIED'; setTimeout(() => { b.textContent = 'COPY'; }, 1500); };
    try { navigator.clipboard.writeText(b.dataset.copy).then(done, () => { b.textContent = 'SELECT IT'; }); } catch { b.textContent = 'SELECT IT'; }
  });
  async function load() {
    clearTimeout(timer);
    let wait = 60000;
    try {
      const res = await fetch('/api/setup', { cache: 'no-store' });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) { meta.textContent = r.msg || `HTTP ${res.status}`; body.innerHTML = ''; }
      else {
        body.innerHTML = render(r);
        meta.textContent = r.checking ? 'checking this Mac…' : `checked ${String(r.at).slice(11, 16)}Z`;
        if (r.checking) wait = 2000;
      }
    } catch {
      meta.textContent = 'board unreachable';
    }
    timer = setTimeout(load, wait);
  }
  root.SetupView.reload = load;   // a page script may ask for a fresh reading
  load();
})(typeof globalThis !== 'undefined' ? globalThis : this);
