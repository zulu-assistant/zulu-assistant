/* WORK-panel approval logic (pure; loaded before app.js, tested by test/decide.test.mjs).
 * Task #85: two approvals clicked on the panel never reached the server. The old
 * flow hung on window.confirm(), which an embedded web view (the cmux Dock board)
 * may answer "cancel" without ever showing it, and then returned silently. Now:
 *  - confirmation is an in-panel second click (works in every web view);
 *  - every outcome (network error, 403 token, 409, OK) is spelled out on screen;
 *  - a page loaded before the last board restart says so (stale JS/token). */
(function (root) {
  const ARM_MS = 6000;

  /** Two-click confirm. Returns { fire, armed } — `armed` is the new state to keep. */
  function armClick(armed, task, decision, now) {
    if (armed && armed.task === String(task) && armed.decision === decision && now < armed.until) {
      return { fire: true, armed: null };
    }
    return { fire: false, armed: { task: String(task), decision, until: now + ARM_MS } };
  }

  /** What the panel says after a decide PATCH. `status` 0 = never reached the board. */
  function decisionOutcome(status, body) {
    if (!status) return { ok: false, text: 'NOT SENT: board unreachable', reload: false };
    if (status === 200 && body && body.ok) return { ok: true, text: '✓ RECORDED', reload: false };
    if (status === 403) return { ok: false, text: 'REJECTED: page is out of date, reload and click again', reload: true };
    const msg = (body && body.msg) || `HTTP ${status}`;
    return { ok: false, text: `NOT RECORDED: ${msg}`, reload: false };
  }

  /** True when the page was served by an earlier board process than the one now pushing data. */
  function staleBoot(pageBoot, serverBoot) {
    if (!pageBoot || !serverBoot || pageBoot.startsWith('%%')) return false;
    return pageBoot !== serverBoot;
  }

  /** The WAITING ON YOU section. Full board: hidden while nothing waits. Dock (#450): it holds only
   *  blocks + the snoozed fold (decisions live in NEEDS ATTENTION), so it shows only when it has those. */
  function decisionsState(waiting, dock, snoozed = 0, blocks = 0) {
    if (dock) return { hidden: !blocks && !snoozed, empty: false };
    // attention ring: with everything snoozed the strip stays, as one dim line + the snoozed fold
    return { hidden: !waiting && !snoozed, empty: !waiting };
  }

  /** Dock only (#450, reverses #376): header, NEEDS ATTENTION led by the one-click decisions, then
   *  WAITING ON YOU. The list moves whole, so its click listeners and the strip receipt go with it. */
  function dockLayout(doc) {
    const strip = doc.getElementById('decisions');
    const list = doc.getElementById('decisions-list');
    const row = doc.getElementById('attention-row');
    const grid = doc.getElementById('attention-grid');
    if (!strip || !list || !row || !grid) return;
    strip.parentNode.insertBefore(row, strip);
    row.insertBefore(list, grid);
  }

  // A gate command over this size starts folded (#444): a 25-line heredoc filled the strip and put
  // its buttons out of reach. The char limit is for one huge line, which wraps just as tall.
  const CMD_LINES = 6;
  const CMD_CHARS = 480;

  /** The first lines of a long command. `long` false = show it as it is. */
  function foldCommand(command) {
    const text = String(command ?? '').trimEnd();
    const all = text.split('\n');
    const long = all.length > CMD_LINES || text.length > CMD_CHARS;
    return { long, preview: long ? all.slice(0, CMD_LINES).join('\n').slice(0, CMD_CHARS) : text, lines: all.length, chars: text.length };
  }

  // Row context (1.3): chip id → text. The ids come from the board (src/row-context.mjs CHIPS, pinned
  // equal by a test); an id that is not in this table shows nothing, so no chip text is the agent's.
  const CHIP_TEXT = {
    'public-repo': 'public repo', 'deploy-on-push': 'deploys on push', outbound: 'sends outside', store: 'store write',
    self: 'the gate itself', desktop: 'desktop control', unlisted: 'unlisted tool',
  };
  const contextTexts = (ids) => (Array.isArray(ids) ? ids : []).filter((id) => Object.prototype.hasOwnProperty.call(CHIP_TEXT, id)).map((id) => CHIP_TEXT[id]);
  function contextChips(ids) {
    return contextTexts(ids).map((t) => `<span class="chip ctx-chip">${t}</span>`).join('');
  }

  /** A pane answer an agent recorded (SETTINGS.paneAnswers 'confirm'): a line that says who typed it
   *  and that it does not count until the owner confirms it here. '' when none is waiting.
   *  The words are the agent's record of what the owner said — always escaped, never markup. */
  function proposalHtml(p, esc) {
    if (!p || p.confirmed_at || p.overruled_at) return '';
    const at = esc(String(p.at).slice(11, 16));
    // typed in a terminal on this machine (the decision door, tripwire 'browser'): the board cannot
    // tell who typed it, so the row names nobody. The reason, when one was given, is quoted.
    if (p.kind === 'typed') {
      return `<div class="gate-meta gate-heard"><span aria-hidden="true">⚑</span> An approval was typed in a terminal on this machine at ${at}Z${p.text ? `: “${esc(p.text)}”` : ''}. The board cannot tell who typed it. It counts only when you confirm it here.</div>`;
    }
    return `<div class="gate-meta gate-heard"><span aria-hidden="true">⚑</span> ${esc(p.by)} recorded your answer in a pane at ${at}Z: “${esc(p.text)}”. It counts only when you confirm it here.</div>`;
  }

  /** The three buttons of a row that carries a recorded pane answer: confirm, decline, "not what I said". */
  const HEARD_LABELS = { approve: '✓ CONFIRM', decline: '✕ DECLINE', disown: '⚑ NOT WHAT I SAID' };
  /** The same three for a given record: a typed approval is rejected as "not typed by me". */
  const TYPED_DISOWN = '⚑ I DID NOT TYPE THIS';
  function heardLabels(p) {
    return p && p.kind === 'typed' ? { ...HEARD_LABELS, disown: TYPED_DISOWN } : HEARD_LABELS;
  }

  /** What a button says after the first click. `p` = the record the row carries, if any. */
  function armedLabel(decision, what, p) {
    if (decision === 'disown') return `CLICK AGAIN: ${p && p.kind === 'typed' ? 'I DID NOT TYPE THIS' : 'NOT WHAT I SAID'} (${what})`;
    return `CLICK AGAIN TO ${String(decision).toUpperCase()} ${what}`;
  }

  /** The request body for a decision click. `disown` rejects the recorded pane answer and decides nothing. */
  function decisionBody(decision, gate, revoke) {
    if (revoke) return { op: 'revoke_go' };
    if (decision === 'disown') return gate ? { op: 'proposal_reject', gate } : { op: 'proposal_reject' };
    return gate ? { op: 'gate_decide', gate, decision } : { op: 'decide', decision };
  }

  /** One pending gate: what it is, the buttons, then the command. Unfolded = the exact text, uncut.
   *  o = { key, esc, age, actions (the buttons' html), open (this command is unfolded) } */
  function gateRowHtml(g, o) {
    const { esc } = o;
    const f = foldCommand(g.command);
    const size = f.lines > CMD_LINES ? `${f.lines} lines` : `${f.chars} chars`;
    const toggle = f.long
      ? `<button class="gate-cmd-toggle" data-cmd-toggle="${esc(o.key)}" aria-expanded="${!!o.open}">${o.open ? '▾ fold command' : `▸ show full command (${size})`}</button>` : '';
    // the dry-run time links to the task's receipts when the page has somewhere to send it (o.receiptHref)
    const dryAt = g.dryRun?.seen_at ? `completed ${esc(String(g.dryRun.seen_at).slice(11, 16))}Z` : '';
    const dry = g.dryRun?.required ? `<div class="gate-meta">dry run: ${dryAt ? (o.receiptHref ? `<a class="gate-receipt" href="${esc(o.receiptHref)}" target="_blank" rel="noopener">${dryAt}</a>` : dryAt) : 'missing'}</div>` : '';
    const head = g.ref?.kind === 'pr' && /^[0-9a-f]{7,40}$/i.test(String(g.ref.head || '')) ? ` · head ${esc(String(g.ref.head).slice(0, 7))}` : '';
    const words = g.agentReason ? `<div class="gate-meta gate-words"><span class="gate-words-label">agent's words:</span> “${esc(g.agentReason)}”</div>` : '';
    return `<div class="gate">
    <div class="gate-top"><span class="chip gate-chip"><span aria-hidden="true">⛨</span>GATE ${esc(g.id)}</span><span class="gate-label">${esc(g.label || g.cls)}</span>${contextChips(g.context)}</div>
    ${g.why ? `<div class="gate-meta">${esc(g.why)}${head}</div>` : head ? `<div class="gate-meta">${head.slice(3)}</div>` : ''}
    ${words}
    <div class="gate-meta">${esc(g.agent)} · ${esc(g.cwd)} · ${esc(g.tool)} · ${o.age} ago${g.commandRedacted ? ' · command withheld (contains a secret)' : ''}</div>
    ${/^(unregistered|headless):/.test(String(g.agent || '')) ? '<div class="gate-meta gate-nowake">this session is not woken after you decide: it runs the same command again itself</div>' : ''}
    ${g.previously ? `<div class="gate-meta gate-again">↻ you approved this exact call at ${esc(String(g.previously.at).slice(11, 16))}Z (${esc(g.previously.gate)}); it expired before it ran</div>` : ''}
    ${dry}
    ${proposalHtml(g.proposal, esc)}
    <div class="task-actions">${o.actions}</div>
    <pre class="gate-cmd">${esc(f.long && !o.open ? `${f.preview} …` : g.command)}</pre>${toggle}
  </div>`;
  }

  const api = { ARM_MS, CMD_LINES, CMD_CHARS, armClick, decisionOutcome, staleBoot, decisionsState, dockLayout, foldCommand, gateRowHtml, proposalHtml, HEARD_LABELS, heardLabels, armedLabel, decisionBody, CHIP_TEXT, contextTexts, contextChips };
  root.BoardDecide = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
