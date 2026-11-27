/* Setup page, mode 'write' (SETTINGS.setupPage): forms for the three steps that can be answered here
 * (owner, watch, engines). Served only in that mode, with the decision token in the page.
 * A save is POST /api/setup/step and needs a second click (never window.confirm: an embedded web view
 * may cancel it unseen). What may be written is decided by the board (src/setup-write.mjs), not here.
 * Everything shown from the scan is escaped. Rendering is pure (SetupWrite.*), tested by
 * test/setup-write.test.mjs. */
(function (root) {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ROLES = ['master', 'worker', 'triage'];
  const ENGINES = [['claude', 'Claude Code'], ['codex', 'Codex']];
  const save = (step) => `<div class="sw-row"><button type="button" class="sw-btn sw-save" data-step="${step}">SAVE</button></div><div class="sw-note" data-note="${step}" role="status"></div>`;

  function ownerForm() {
    return '<form class="sw-form" data-form="owner"><h3>YOU</h3>'
      + '<div class="sw-row"><label>your name <input type="text" name="name" maxlength="60" autocomplete="off"></label></div>'
      + '<div class="sw-note">Letters, digits, spaces and . \' - only. The policy text is not changed from this page.</div>'
      + save('owner') + '</form>';
  }

  function enginesForm() {
    const pick = (role) => `<label>${role} <select name="${role}">${ENGINES.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>`;
    return '<form class="sw-form" data-form="engines"><h3>AI ENGINES</h3>'
      + `<div class="sw-row">${ROLES.map(pick).join('')}</div>`
      + '<div class="sw-note">The choice only. Logging in is each tool\'s own step, in a terminal.</div>'
      + save('engines') + '</form>';
  }

  /** The watch step's tick lists from a scan ({ jobs, docker, cron }); every value escaped. */
  function scanLists(scan) {
    const list = (title, kind, rows, id, text) => (rows && rows.length
      ? `<div class="su-dim">${title}</div><ul class="sw-list">${rows.map((r) => `<li><label><input type="checkbox" name="${kind}" value="${esc(id(r))}"> ${esc(text(r))}</label></li>`).join('')}</ul>`
      : `<div class="sw-note">${title}: none found</div>`);
    return list('LaunchAgents', 'jobs', scan?.jobs, (j) => j.label, (j) => `${j.name} (${j.label})`)
      + list('Docker containers', 'docker', scan?.docker, (c) => c.name, (c) => `${c.name}${c.status ? ` · ${c.status}` : ''}`)
      + list('Crontab lines', 'cron', scan?.cron, (c) => c.id, (c) => `${c.schedule} ${c.command}`);
  }

  function watchForm() {
    return '<form class="sw-form" data-form="watch"><h3>WHAT TO WATCH ON THIS MAC</h3>'
      + '<div class="sw-row"><button type="button" class="sw-btn sw-scan">SCAN THIS MAC</button></div>'
      + '<div data-scan><div class="sw-note">Scan first, then tick what the board should watch. Saving replaces the watch list.</div></div>'
      + '<div class="sw-row"><label style="flex:1">addresses to check, one per line (http or https)<textarea name="urls" spellcheck="false"></textarea></label></div>'
      + save('watch') + '</form>';
  }

  /** The forms block for one reading. A hand-built board gets a sentence, no forms. */
  function render(r) {
    if (!r || !r.write) return '';
    if (!r.installed) return '<div class="sw-form"><h3>ANSWER A STEP HERE</h3><div class="sw-note">This board was set up by hand, so the page does not change its config. Use the terminal: <kbd>zulu setup</kbd></div></div>';
    return ownerForm() + enginesForm() + watchForm() + (r.write.steps?.includes('alerts') ? alertsForm() : '') + buttonsBlock(r.write.buttons);
  }

  // The buttons (only where the board offers them). The page sends a button's id and nothing else; what it
  // runs is the board's table. Each says in plain words what it does before the second click.
  function buttonsBlock(list) {
    if (!Array.isArray(list) || !list.length) return '';
    const one = (b) => `<div class="sw-row"><button type="button" class="sw-btn sw-run" data-button="${esc(b.id)}"${b.needsCheck ? ' data-needs-check="1" disabled' : ''}>${esc(b.title)}</button></div>`
      + `<div class="sw-note">${esc(b.says)}${b.needsCheck ? ' Run the check first.' : ''}</div>`
      + `<div class="sw-note" data-run-note="${esc(b.id)}" role="status"></div><pre class="sw-out" data-run-out="${esc(b.id)}" hidden></pre>`;
    return `<div class="sw-form" data-buttons><h3>RUN FROM HERE</h3>${list.map(one).join('')}</div>`;
  }

  /** What the note line says for an answer of the button route. */
  function buttonOutcome(status, r) {
    if (status === 403) return { bad: true, text: `${r.msg || 'refused'}` };
    if (status !== 200) return { bad: true, text: r.msg || `not run (HTTP ${status})` };
    if (r.started) return { bad: false, text: 'started: the board restarts now, the result shows here when it is back' };
    if (r.timedOut) return { bad: true, text: 'it ran out of time and was stopped' };
    return r.ok ? { bad: false, text: 'done' } : { bad: true, text: `it ended with an error (exit ${r.code})` };
  }

  // The alerts form (only where the board offers it). It starts empty every time: a stored value is never
  // sent to the page. An empty field leaves the stored value as it is.
  const ALERT_FIELDS = [
    ['EMAIL', [['SMTP_HOST', 'SMTP host', 'text'], ['SMTP_PORT', 'port', 'text'], ['SMTP_USER', 'user', 'text'], ['SMTP_PASS', 'password', 'password'], ['ALERT_EMAIL_TO', 'send alerts to', 'text']]],
    ['SMS THROUGH YOUR OWN WEBHOOK', [['SMS_WEBHOOK_URL', 'webhook address (https)', 'text'], ['SMS_WEBHOOK_KEY', 'webhook key', 'password'], ['SMS_ALERT_TO', 'phone number(s), as +15555550100', 'text']]],
    ['HEARTBEAT', [['HEARTBEAT_URL', 'heartbeat address (https)', 'text'], ['HEARTBEAT_KEY', 'heartbeat key', 'password']]],
  ];
  const ALERT_KEYS = ALERT_FIELDS.flatMap(([, f]) => f.map(([k]) => k));
  function alertsForm() {
    const field = ([key, label, type]) => `<label>${label} <input type="${type}" name="${key}" maxlength="500" autocomplete="${type === 'password' ? 'new-password' : 'off'}" spellcheck="false"></label>`;
    return '<form class="sw-form" data-form="alerts" autocomplete="off"><h3>ALERT CHANNELS</h3>'
      + '<div class="sw-note">Fill only the channel you want. An empty field keeps what is stored; stored values are never shown here. Nothing is sent as a test.</div>'
      + ALERT_FIELDS.map(([title, f]) => `<div class="su-dim">${title}</div><div class="sw-row">${f.map(field).join('')}</div>`).join('')
      + save('alerts') + '</form>';
  }

  /** A form's fields → the answers object the board takes. */
  function answersOf(step, get) {
    if (step === 'alerts') return Object.fromEntries(ALERT_KEYS.map((k) => [k, get.text(k)]).filter(([, v]) => v !== ''));
    if (step === 'owner') return { name: get.text('name') };
    if (step === 'engines') return Object.fromEntries(ROLES.map((role) => [role, get.text(role)]));
    return {
      jobs: get.ticked('jobs'), docker: get.ticked('docker'), cron: get.ticked('cron'),
      urls: get.text('urls').split('\n').map((l) => l.trim()).filter(Boolean),
    };
  }

  /** What the note line says for an answer of the save route. */
  function outcome(status, r) {
    if (status === 403) return { bad: true, text: `${r.msg || 'refused'} (reload)` };
    if (status !== 200 || !r.ok) return { bad: true, text: r.msg || `not saved (HTTP ${status})` };
    const check = r.check ? ` · ${r.check.ok ? 'check passed' : 'check'}: ${r.check.detail}` : '';
    const restart = r.restart === 'self' ? ' · the board restarts now to show it' : r.restart === 'manual' ? ' · it shows after the board restarts' : '';
    return { bad: false, text: `${r.saved}${check}${restart}` };
  }

  root.SetupWrite = { render, scanLists, answersOf, outcome, alertsForm, buttonsBlock, buttonOutcome };

  // ---- page wiring (browser only) ----
  if (typeof document === 'undefined' || !document.getElementById('su-write')) return;
  const box = document.getElementById('su-write');
  const token = document.querySelector('meta[name="mesh-decision"]')?.content || '';
  const note = (step, o) => { const n = box.querySelector(`[data-note="${step}"]`); if (n) { n.textContent = o.text; n.classList.toggle('sw-bad', o.bad); } };
  const fields = (form) => ({
    text: (name) => String(form.elements[name]?.value ?? ''),
    ticked: (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value),
  });
  let shown = null;
  async function draw() {
    try {
      const r = await (await fetch('/api/setup', { cache: 'no-store' })).json();
      const kind = !r.write ? 'none' : r.installed ? `forms:${(r.write.steps || []).join(',')}:${(r.write.buttons || []).map((b) => b.id).join(',')}` : 'hand';
      if (kind === shown) return;          // never redraw a form someone is typing into
      box.innerHTML = render(r); shown = kind;
    } catch { /* the page's own reader says the board is unreachable */ }
  }
  // After the Guardrails write the board restarts: ask for the run's output until the board answers and the run has ended.
  function waitForRun(id, runNote, show) {
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const res = await fetch('/api/setup/button', { cache: 'no-store', headers: { 'x-mesh-decision': token } });
        const r = await res.json().catch(() => ({}));
        if (res.status === 403) return runNote({ bad: false, text: 'the board is back: reload this page to read the result' });
        if (res.ok && !r.running && r.last) { show(r.last.text); runNote({ bad: false, text: 'finished: read the lines below. If they say the hook was installed, restart your Claude Code sessions so they load it' }); root.SetupView?.reload?.(); return; }
      } catch { /* the board is restarting */ }
      if (tries < 40) setTimeout(tick, 3000); else runNote({ bad: true, text: 'no result yet: reload this page in a minute' });
    };
    setTimeout(tick, 4000);
  }
  box.addEventListener('submit', (e) => e.preventDefault());
  box.addEventListener('click', async (e) => {
    const scan = e.target.closest?.('.sw-scan');
    if (scan) {
      const into = scan.closest('form').querySelector('[data-scan]');
      scan.disabled = true; scan.textContent = 'SCANNING…';
      try {
        const res = await fetch('/api/setup/scan', { cache: 'no-store', headers: { 'x-mesh-decision': token } });
        const r = await res.json().catch(() => ({}));
        into.innerHTML = res.ok ? scanLists(r.scan) : `<div class="sw-note sw-bad">${esc(r.msg || `HTTP ${res.status}`)}${res.status === 403 ? ' (reload)' : ''}</div>`;
      } catch { into.innerHTML = '<div class="sw-note sw-bad">board unreachable</div>'; }
      scan.disabled = false; scan.textContent = 'SCAN AGAIN';
      return;
    }
    const run = e.target.closest?.('.sw-run');
    if (run) {
      const id = run.dataset.button;
      const title = run.dataset.title || (run.dataset.title = run.textContent);
      const runNote = (o) => { const n = box.querySelector(`[data-run-note="${id}"]`); if (n) { n.textContent = o.text; n.classList.toggle('sw-bad', o.bad); } };
      const show = (text) => { const p = box.querySelector(`[data-run-out="${id}"]`); if (p) { p.textContent = text || ''; p.hidden = !text; } };
      if (!run.classList.contains('sw-armed')) {      // first click arms, the second runs
        run.classList.add('sw-armed'); run.textContent = 'CLICK AGAIN TO RUN';
        setTimeout(() => { if (run.classList.contains('sw-armed')) { run.classList.remove('sw-armed'); run.textContent = title; } }, 6000);
        return;
      }
      run.classList.remove('sw-armed'); run.disabled = true; run.textContent = 'RUNNING…';
      const gated = box.querySelector('[data-needs-check]');
      try {
        const res = await fetch('/api/setup/button', { method: 'POST', headers: { 'content-type': 'application/json', 'x-mesh-decision': token }, body: JSON.stringify({ id }) });
        const r = await res.json().catch(() => ({}));
        runNote(buttonOutcome(res.status, r)); show(r.output);
        // the write button opens only after a check that passed, and closes again once it was used or refused
        if (gated && r.checked) gated.disabled = false;
        if (gated && run === gated) gated.disabled = true;
        if (r.started) waitForRun(id, runNote, show);
      } catch { runNote({ bad: true, text: 'board unreachable' }); }
      if (run !== gated) setTimeout(() => { run.disabled = false; }, 1500);
      run.textContent = title;
      return;
    }
    const b = e.target.closest?.('.sw-save');
    if (!b) return;
    const step = b.dataset.step;
    if (!b.classList.contains('sw-armed')) {       // first click arms, the second saves
      b.classList.add('sw-armed'); b.textContent = 'CLICK AGAIN TO SAVE';
      setTimeout(() => { if (b.classList.contains('sw-armed')) { b.classList.remove('sw-armed'); b.textContent = 'SAVE'; } }, 6000);
      return;
    }
    b.classList.remove('sw-armed'); b.disabled = true; b.textContent = 'SAVING…';
    try {
      const body = JSON.stringify({ step, answers: answersOf(step, fields(b.closest('form'))) });
      // what was typed into the alerts form does not stay in the page, saved or not
      if (step === 'alerts') b.closest('form').reset();
      const res = await fetch('/api/setup/step', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mesh-decision': token },
        body,
      });
      const r = await res.json().catch(() => ({}));
      const o = outcome(res.status, r);
      note(step, o);
      b.textContent = o.bad ? 'NOT SAVED' : 'SAVED';
      if (!o.bad) setTimeout(() => root.SetupView?.reload?.(), r.restart === 'self' ? 4000 : 300);
    } catch { note(step, { bad: true, text: 'board unreachable' }); b.textContent = 'NOT SAVED'; }
    setTimeout(() => { b.disabled = false; b.textContent = 'SAVE'; }, 2500);
  });
  draw();
  setInterval(draw, 30000);
})(typeof globalThis !== 'undefined' ? globalThis : this);
