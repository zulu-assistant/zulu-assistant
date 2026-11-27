// Setup page (graphical mode, level 1): the guided setup's checklist as a board page.
//
// READ-ONLY. This module and its route (GET /api/setup, page /?setup=1) never write: not the setup
// state file, not the overlay, not the secrets file. The terminal wizard (scripts/setup.mjs) records
// a step whose live check passes; this page only shows it as done.
//
// The steps and their live checks are the wizard's own (src/setup.mjs). The checks start child
// processes (gh, claude, codex, pmset), so they never run inside a request: a request is answered
// from the last reading, or from the state file alone with `checking: true`, and the page asks again.
//
// What leaves this module is short status text: step titles, "logged in" / "not logged in", which
// alert tiers are on (their names, never a value), a folder with the home shortened. Every detail
// still goes through the evidence panel's secret check before it is sent.
//
// Switch: SETTINGS.setupPage { mode: 'on' | 'write' | 'off' } (absent = off: no page, no route).
// 'write' is this same read-only page and reader plus the forms of src/setup-write.mjs; nothing in
// this module changes with it.
import { STEPS, NEXT_STEPS, checkStep, readState } from './setup.mjs';
import { safeText } from './evidence.mjs';

export const setupPageMode = (cfg) => (cfg?.mode === 'on' || cfg?.mode === 'write' ? cfg.mode : 'off');
export const CACHE_MS = 60000;
/** residents and verify are actions, not states: nothing to check live, the state file is all there is. */
export const NO_LIVE_CHECK = ['residents', 'verify'];
/** What does this step today: the one terminal command. */
export const commandFor = (id) => `zulu setup --step ${id}`;

/**
 * The page's payload, from the state file and the live checks. Pure.
 *   state    data/setup-state.json or null (a board set up by hand has none)
 *   checks   { <step id>: { ok, detail } } or null while the checks have not answered yet
 * A step is `done` when its live check passes or the wizard recorded it, `skipped` when the owner
 * skipped it, `check` when it was recorded done and its live check now fails, else `todo`.
 */
export function setupReading({ state = null, checks = null, profile = 'full', now = Date.now() } = {}) {
  const steps = STEPS.map((s) => {
    const recorded = state?.steps?.[s.id]?.status || 'todo';
    const c = checks && !NO_LIVE_CHECK.includes(s.id) ? checks[s.id] || null : null;
    const live = c ? { ok: Boolean(c.ok), detail: safeText(c.detail || '', 200) } : null;
    const status = live?.ok ? 'done'
      : recorded === 'done' ? (live ? 'check' : 'done')
        : recorded === 'skipped' ? 'skipped' : 'todo';
    return { id: s.id, title: s.title, required: Boolean(s.required), recorded, live, status, command: commandFor(s.id) };
  });
  const handled = steps.filter((s) => s.status === 'done' || s.status === 'skipped');
  const requiredOpen = steps.filter((s) => s.required && s.status !== 'done').map((s) => s.title);
  // a light install that has not started the guided setup, and a Guardrails-only board, owe nothing:
  // the page leads with the opt-in next steps, as the board's card does (setupCard)
  const light = state?.mode === 'light' && !Object.keys(state.steps || {}).length;
  return {
    at: new Date(now).toISOString(),
    installed: Boolean(state),
    mode: state ? (state.mode === 'light' ? 'light' : 'full') : null,
    profile: profile === 'guardrails' ? 'guardrails' : 'full',
    lead: light || profile === 'guardrails' ? 'next' : 'checklist',
    checking: !checks,
    steps,
    summary: { handled: handled.length, total: steps.length, requiredOpen, complete: handled.length === steps.length },
    nextSteps: NEXT_STEPS.map((n) => ({ id: n.id, what: n.what, run: n.run })),
  };
}

/**
 * The reader behind the route. `peek()` answers at once and never waits for a child process:
 *   a reading younger than ttlMs                → that reading
 *   an older one                                → that reading with checking: true, and a refresh starts
 *   none yet                                    → the state file alone with checking: true, and a refresh starts
 * One refresh at a time. `refresh()` is the same work, awaited (tests, and the page's second ask).
 * A check that throws is a failed check for that step, never a failed reading.
 */
export function createSetupReader({ check = checkStep, state = readState, secrets = () => ({}), profile = 'full', ttlMs = CACHE_MS, now = () => Date.now() } = {}) {
  let cached = null; let at = 0; let flight = null;
  const live = STEPS.filter((s) => !NO_LIVE_CHECK.includes(s.id));
  function refresh() {
    if (flight) return flight;
    flight = (async () => {
      const doc = await state();
      const sec = (await secrets()) || {};
      const checks = {};
      await Promise.all(live.map(async (s) => {
        try { checks[s.id] = await check(s.id, { state: doc || undefined, secrets: sec }); }
        catch { checks[s.id] = { ok: false, detail: 'this check could not run' }; }
      }));
      cached = setupReading({ state: doc, checks, profile, now: now() });
      at = now();
      return cached;
    })().finally(() => { flight = null; });
    return flight;
  }
  async function peek() {
    if (cached && now() - at < ttlMs) return cached;
    refresh().catch(() => {});
    if (cached) return { ...cached, checking: true };
    return setupReading({ state: await state(), checks: null, profile, now: now() });
  }
  return { peek, refresh };
}

// ── demo mode ────────────────────────────────────────────────────────────────
// A demo board reads nothing of this machine's setup: a fixed state and fixed check answers.
export const DEMO_STATE = {
  installedAt: 0,
  steps: { github: { status: 'done', at: 0 }, engines: { status: 'done', at: 0 }, owner: { status: 'done', at: 0 }, alerts: { status: 'skipped', at: 0 } },
  answers: { enginesChosen: true },
};
const DEMO_CHECKS = {
  github: { ok: true, detail: 'gh is logged in' },
  engines: { ok: true, detail: 'engines: master=claude · worker=claude · triage=claude' },
  owner: { ok: true, detail: 'owner: Demo Owner' },
  watch: { ok: false, detail: 'still showing the example placeholders' },
  alerts: { ok: false, detail: 'no alert channel (cmux notifications only)' },
  vault: { ok: false, detail: 'no vault at ~/Vault' },
  brain: { ok: false, detail: 'graphify MISSING · 0/2 skills' },
  macos: { ok: false, detail: 'autorestart off' },
};
export const demoSetupReader = (opts = {}) => createSetupReader({
  ...opts, state: async () => DEMO_STATE, secrets: () => ({}), check: async (id) => DEMO_CHECKS[id] || { ok: false, detail: '' },
});
