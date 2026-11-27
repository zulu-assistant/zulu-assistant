/* Daily decision page (#788, ?decide=1): everything that waits on the owner in one list, ordered by
 * the cost of waiting (src/decide-page.mjs). Pure HTML builders (loaded before app.js, tested by
 * test/decide-page.test.mjs). Every button on a row is the strip's own button, built by the same
 * taskRow/gateRow code, so a decision here is the same PATCH with the same token and two clicks.
 * A question row has no reply box: the owner tells Mission Control (answers stay where they are made). */
(function (root) {
  const KIND = { gate: { glyph: '▲', text: 'gate (an agent is held)' }, decision: { glyph: '■', text: 'approval / plan' }, block: { glyph: '●', text: 'a question' } };
  const defEsc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const age = (h) => (h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
  const costText = (c) => (c >= 10 ? String(Math.round(c)) : String(Math.round(c * 10) / 10));

  /** The header line: `N waiting · oldest N h · p90 N h` (+ the snoozed count). */
  function headerText(view) {
    const parts = [`${view?.count || 0} waiting`];
    if (view?.oldestH != null) parts.push(`oldest ${age(view.oldestH)}`);
    parts.push(`p90 ${view?.waitP90H != null ? age(view.waitP90H) : '—'}`);
    if (view?.snoozedCount) parts.push(`⏾ ${view.snoozedCount} snoozed`);
    return parts.join(' · ');
  }

  /** The task as one row shows it: only that row's gate, or only its approval (the strip's rule). */
  function rowTask(t, r) {
    if (!t) return null;
    if (r.kind === 'gate') return { task: { ...t, gates: (t.gates || []).filter((g) => g.id === r.gate) }, hideAsk: true };
    return { task: { ...t, gates: [] }, hideAsk: false };
  }

  function questionHtml(r, o) {
    if (r.outside) return '<div class="dp-q dp-q-out">question not shown: outside source</div>';
    if (!r.question) return '<div class="dp-q dp-q-out">no question text on the task</div>';
    const open = o.openQuestions.has(r.id);
    // the push carries one line; the full text comes from GET /api/decide when the row is unfolded
    const full = o.fullText.get(r.id) ?? r.questionFull ?? (r.more ? null : r.question);
    const body = open
      ? `<span class="dp-q-full">${full == null ? '… loading the full question' : o.esc(full)}</span>`
      : `<span class="dp-q-line">“${o.esc(r.question)}”</span>`;
    return `<button class="dp-q" data-dp-q="${o.esc(r.id)}" aria-expanded="${open}">${open ? '▾' : '▸'} ${body}</button>
    <div class="dp-hint">answer it: tell Mission Control</div>`;
  }

  function rowHtml(r, o) {
    const k = KIND[r.kind] || KIND.block;
    const head = `<div class="dp-head">
      <span class="dp-cost" title="cost = weight × priority × hours"><span aria-hidden="true">${k.glyph}</span> ${o.esc(costText(r.cost))}</span>
      <span class="dp-age">${o.esc(age(r.hours))}</span>
      <span class="task-id">#${o.esc(r.task)}</span>
      <span class="dp-owner">${o.esc(r.owner || 'unowned')}</span>
      <span class="dp-ws">${o.workspaceHtml(r.workspace, r.owner, o)}</span>
      <span class="dp-title">${o.esc(r.title)}</span>
      ${r.priority !== 'normal' ? `<span class="chip dp-prio">${o.esc(r.priority)}</span>` : ''}
      ${r.back ? '<span class="chip att-back" title="a snooze ran out; this is waiting again"><span aria-hidden="true">↺</span>BACK</span>' : ''}
    </div>`;
    let body = '';
    if (r.kind === 'block') body = questionHtml(r, o);
    else {
      const v = rowTask(o.tasks.get(r.task), r);
      body = v ? o.taskRow(v.task, { hideAsk: v.hideAsk }) : '<div class="dp-q dp-q-out">the task is not in this page\'s reading yet: reload</div>';
    }
    return `<div class="dp-row dp-${o.esc(r.kind)}" data-dp-row="${o.esc(r.id)}">${head}<div class="dp-body">${body}</div></div>`;
  }

  /**
   * view = payload.decide; tasks = Map(id → summary brief); o.taskRow(t, { hideAsk }) → html;
   * o.workspaceHtml = BoardDecide.workspaceHtml. → { html, header, count }
   */
  function renderPage(view, tasks, opts = {}) {
    const o = { esc: defEsc, openQuestions: new Set(), fullText: new Map(), results: new Map(), phone: false, taskRow: () => '', workspaceHtml: () => '', ...opts, tasks };
    const rows = view?.rows || [];
    const legend = `<div class="dp-legend">${Object.values(KIND).map((k) => `<span><span aria-hidden="true">${k.glyph}</span> ${k.text}</span>`).join('')}<span>cost = weight × priority × hours</span></div>`;
    const html = rows.length ? rows.map((r) => rowHtml(r, o)).join('') + legend : '<div class="att-none">⛨ nothing waits on you</div>';
    return { html, header: headerText(view), count: rows.length };
  }

  const api = { renderPage, headerText, rowTask, KIND };
  root.BoardDecidePage = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
