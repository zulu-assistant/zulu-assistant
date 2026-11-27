// Dock reload after a cold start (#705).
//
// cmux restores each window's Dock from its session snapshot. After a reboot cmux came up before the
// board was listening, so the Dock's chromeless board page loaded a closed port and showed nothing,
// with no address bar or reload button to recover it. So once per board start, and only when the cmux
// app started a short while before (a cold start), the board reloads each Dock browser that shows its
// OWN compact board or evidence page, once.
//
// It never adds, removes or switches a surface, never touches the sidebar, and never retries a failed
// reload: one ticker line says what happened. Only two cmux calls are made: `tree --all` (a read) and
// `browser <surface> reload`.

export const COLD_START_MS = 2 * 3600_000;   // cmux started less than this before the board = a cold start
export const TREE_RETRY_MS = 20_000;         // one more tree read, when the first failed or showed no board page
                                             // (cmux may still be restoring its Dock when the board starts)

// The exact addresses the board serves its Dock pages at: origin and path exact, query exact.
// A look-alike host, another port, a longer path or any other query never matches.
export function ownDockUrls(port) {
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  const pages = ['/?dock=1', '/?evidence=1'];
  return new Set(origins.flatMap((o) => pages.map((p) => o + p)));
}

// Browser surfaces in the GLOBAL Dock, from `cmux tree --all` text: [{ ref, url }], one per surface ref.
// A row: `surface surface:N [browser] [dock:global] "<title>" [selected] <url>`. Any other Dock scope
// (e.g. `[dock:workspace]`) is not read.
export function dockBrowsers(treeText) {
  const seen = new Map();
  for (const line of String(treeText || '').split('\n')) {
    const m = line.match(/\bsurface\s+(surface:\d+)\s+\[browser\]\s+(.*)$/);
    if (!m) continue;
    const rest = m[2];
    if (!/^(?:\[[^\]]*\]\s+)*?\[dock:global\]/.test(rest)) continue;
    const url = (rest.match(/\s(\S+)\s*$/) || [])[1] || '';
    if (!seen.has(m[1])) seen.set(m[1], { ref: m[1], url });
  }
  return [...seen.values()];
}

// Which Dock surfaces to reload: only those whose address is exactly one of the board's own.
export function surfacesToReload(treeText, port) {
  const own = ownDockUrls(port);
  return dockBrowsers(treeText).filter((s) => own.has(s.url));
}

export function isColdStart(appStartMs, nowMs, windowMs = COLD_START_MS) {
  return appStartMs > 0 && nowMs >= appStartMs && nowMs - appStartMs < windowMs;
}

// Run once. run(args) => Promise<{ err, out }> is the board's cmux runner (password in its env).
// Returns { ran, reason?, reloaded: [refs], failed: [refs] } and writes at most one ticker line.
export async function reloadDockOnce({
  port,
  run,
  appStart,
  now = () => Date.now(),
  log = async () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const started = await appStart().catch(() => 0);
  if (!isColdStart(started, now())) return { ran: false, reason: started ? 'cmux not a cold start' : 'cmux start not read', reloaded: [], failed: [] };
  let tree = await run(['tree', '--all']);
  let targets = tree.err ? [] : surfacesToReload(tree.out, port);
  if (!targets.length) {
    await sleep(TREE_RETRY_MS);
    const again = await run(['tree', '--all']);
    if (!again.err) { tree = again; targets = surfacesToReload(again.out, port); }
  }
  if (tree.err) {
    await log('dock reload: the cmux tree could not be read after a cold start; nothing reloaded');
    return { ran: false, reason: 'tree unread', reloaded: [], failed: [] };
  }
  if (!targets.length) return { ran: true, reloaded: [], failed: [] };
  const reloaded = []; const failed = [];
  for (const s of targets) {
    const r = await run(['browser', s.ref, 'reload']);
    (r.err ? failed : reloaded).push(s.ref);
  }
  await log(failed.length
    ? `dock reload after a cold start: ${reloaded.length} reloaded, ${failed.length} failed (${failed.join(', ')}); not retried`
    : `dock reload after a cold start: ${reloaded.length} board page${reloaded.length === 1 ? '' : 's'} in the Dock reloaded`);
  return { ran: true, reloaded, failed };
}
