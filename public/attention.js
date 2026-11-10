/* Attention ring (Zulu 1.2): the WAITING ON YOU strip grouped by task, with owner snoozes.
 * Pure HTML builders (loaded before app.js, tested by test/attention.test.mjs). Used only when the
 * board's payload carries `attention` (SETTINGS.attention.snooze 'on'); otherwise app.js renders
 * today's strip. One row per task with its N items, expanded on click; each row has a snooze
 * control (pick 15m / 1h / 4h / tomorrow 08:00, then a second click — never window.confirm);
 * snoozed items sit in a dim "snoozed (n)" fold at the bottom; an item whose snooze ran out
 * comes back with a ↺ BACK marker. A snooze decides nothing: gates stay pending. */
(function (root) {
  const CHOICES = [['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['tomorrow', 'tomorrow 08:00']];
  const KIND = { gate: '⛨', decision: '⚑', block: '✕' };
  const BOARD_NOTHING = '<div class="att-none">⛨ nothing to approve</div>';
  const defEsc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // a gate's context (public repo, deploys on push, …) rides on its chip: fixed texts from BoardDecide, never the agent's
  const ctxOf = (it) => { const t = it.kind === 'gate' && root.BoardDecide?.contextTexts ? root.BoardDecide.contextTexts(it.context) : []; return t.length ? ` (${t.join(', ')})` : ''; };
  const itemChip = (it) => `${KIND[it.kind] || '·'} ${it.kind === 'gate' ? it.gate : it.kind === 'decision' ? 'approval' : 'blocked'}${ctxOf(it)}`;
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const armedFor = (armed, key, decision, now) => !!(armed && armed.task === key && armed.decision === decision && now < armed.until);

  /** The task as the expanded row shows it: snoozed gates out, a snoozed approval without its buttons. */
  function visibleTask(t, group) {
    const ids = new Set(group.items.map((i) => i.id));
    return { task: { ...t, gates: (t.gates || []).filter((g) => ids.has(`gate:${t.id}:${g.id}`)) }, hideAsk: !ids.has(`decision:${t.id}`) };
  }

  // Shown only on an expanded row, or while a pick/result for it is on screen: a SNOOZE
  // button under every collapsed row would read as one more to-do per row.
  function snoozeControl(task, o) {
    const key = `snooze:${task}`;
    const res = o.results.get(key);
    if (res?.pending) return `<div class="att-snooze"><span class="att-note">${o.esc(res.text)}</span></div>`;
    if (!o.picking.has(String(task))) {
      return `<div class="att-snooze"><button class="act act-snooze" data-snooze-open="${task}" aria-label="snooze #${task}">⏾ SNOOZE</button>${res ? ` <span class="att-note">${o.esc(res.text)}</span>` : ''}</div>`;
    }
    const btns = CHOICES.map(([k, label]) => {
      const armed = armedFor(o.armed, key, k, o.now);
      return `<button class="act act-snooze${armed ? ' armed' : ''}" data-snooze="${task}" data-for="${k}">${o.esc(armed ? `CLICK AGAIN · ${label}` : label)}</button>`;
    }).join('');
    return `<div class="att-snooze"><span class="att-note">snooze #${task}:</span>${btns}<button class="act" data-snooze-close="${task}" aria-label="cancel">✕</button></div>`;
  }

  // Does this row hold something the owner decides with a click (a gate, an approval, a plan review)?
  const isDecision = (g) => g.items.some((i) => i.kind !== 'block');

  function groupRow(g, o) {
    // decisions start open so their one-click buttons show; a block opens on click (#437)
    const decision = isDecision(g);
    const open = decision ? !o.collapsed.has(String(g.task)) : o.expanded.has(String(g.task));
    const back = g.items.some((i) => i.back);
    const t = o.tasks.get(g.task);
    const chips = g.items.map(itemChip).join(' · ');
    const body = open && t ? (() => { const v = visibleTask(t, g); return o.taskRow(v.task, { hideAsk: v.hideAsk }); })() : '';
    return `<div class="att-row${open ? ' is-open' : ''}${back ? ' is-back' : ''}" data-att-task="${g.task}">
    <button class="att-head" data-att-toggle="${g.task}"${decision ? ' data-att-decision="1"' : ''} aria-expanded="${open}"><span class="att-caret" aria-hidden="true">${open ? '▾' : '▸'}</span><span class="task-id">#${g.task}</span><span class="task-title">${o.esc(g.title)}</span><span class="att-items">${o.esc(chips)}</span><span class="chip att-n">${g.items.length}</span>${back ? '<span class="chip att-back" title="a snooze ran out; this is waiting again"><span aria-hidden="true">↺</span>BACK</span>' : ''}</button>
    ${open || o.picking.has(String(g.task)) || o.results.has(`snooze:${g.task}`) ? snoozeControl(g.task, o) : ''}
    ${body}
  </div>`;
  }

  function foldRow(it, o) {
    const key = `wake:${it.id}`;
    const res = o.results.get(key);
    const armed = armedFor(o.armed, key, 'wake', o.now);
    const text = res ? res.text : armed ? 'CLICK AGAIN TO WAKE' : '◌ WAKE';
    return `<div class="att-snoozed-item"><span class="task-id">#${it.task}</span> ${o.esc(itemChip(it))} <span class="att-note">${o.esc(it.title || '')} · until ${hhmm(it.until)}</span>
      <button class="act act-wake${armed ? ' armed' : ''}" data-unsnooze="${o.esc(it.id)}"${res?.pending ? ' disabled' : ''}>${o.esc(text)}</button></div>`;
  }

  /**
   * view = payload.attention; tasks = Map(id → summary brief); taskRow(t, { hideAsk }) → html.
   * Decisions come first, open, with their buttons; rows that are only "blocked on you" wait in one
   * fold (so old blocks never push the one-click approvals below the fold).
   * The Dock always says "nothing to approve" when no decision waits (#450).
   * → { html, fold, count, snoozedCount, decisions, blocks, decisionItems }
   */
  function renderStrip(view, tasks, opts = {}) {
    const o = {
      esc: defEsc, expanded: new Set(), collapsed: new Set(), picking: new Set(), results: new Map(), armed: null,
      now: Date.now(), taskRow: () => '', ...opts, tasks,
    };
    const groups = view?.groups || [];
    const snoozed = view?.snoozed || [];
    const decisions = groups.filter(isDecision);
    const blocks = groups.filter((g) => !isDecision(g));
    const html = decisions.length ? decisions.map((g) => groupRow(g, o)).join('')
      : blocks.length || o.dock ? BOARD_NOTHING : '';
    const blockFold = blocks.length
      ? `<details class="att-fold att-blocks"${o.blocksOpen ? ' open' : ''}><summary>blocked on you (${blocks.length})</summary>${blocks.map((g) => groupRow(g, o)).join('')}</details>` : '';
    const sleepFold = snoozed.length
      ? `<details class="att-fold"${o.foldOpen ? ' open' : ''}><summary>⏾ snoozed (${snoozed.length})</summary>${snoozed.map((it) => foldRow(it, o)).join('')}</details>` : '';
    const decisionItems = decisions.reduce((n, g) => n + g.items.filter((i) => i.kind !== 'block').length, 0);
    return { html, fold: blockFold + sleepFold, count: view?.count || 0, snoozedCount: snoozed.length, decisions: decisions.length, blocks: blocks.length, decisionItems };
  }

  const api = { CHOICES, NOTHING: BOARD_NOTHING, renderStrip, itemChip, visibleTask };
  root.BoardAttention = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
