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

  const api = { ARM_MS, armClick, decisionOutcome, staleBoot };
  root.BoardDecide = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
