// Workspace listings across EVERY cmux window. Dependency-free so collect.mjs,
// chrome.mjs, heal-restore.mjs, server.mjs and the CLI can all share it.
// `cmux workspace list` defaults to the caller's window; a process outside cmux
// (the launchd board) gets the CURRENT one, so with a second window in front a
// listing would miss the whole fleet and the reconciler would mark it closed.
// Every listing goes through acrossWindows (task #152). Any per-window failure
// fails the whole listing: a partial list must never look like "closed".

/** Window UUIDs from `cmux list-windows` ("* 0: <uuid> selected_workspace=…"). Pure. */
export function parseWindows(out) {
  const ids = [];
  for (const line of String(out || '').split('\n')) {
    const m = line.match(/^\s*\*?\s*\d+:\s+([0-9A-Fa-f-]{36})\b/);
    if (m) ids.push(m[1]);
  }
  return ids;
}

/** Run a listing in every window: text outputs joined, `--json` workspaces merged. */
export async function acrossWindows(run, args) {
  const w = await run(['list-windows']);
  const wins = w.err ? [] : parseWindows(w.out);
  if (wins.length <= 1) return run(args);              // one window: exactly the old call
  const json = args.includes('--json');
  const outs = [];
  for (const id of wins) {
    const r = await run([...args, '--window', id]);
    if (r.err) return r;
    outs.push(r.out);
  }
  if (!json) return { err: null, out: outs.join('\n') };
  try {
    return { err: null, out: JSON.stringify({ workspaces: outs.flatMap((o) => JSON.parse(o).workspaces || []) }) };
  } catch (e) { return { err: `list across windows: ${e.message}`, out: '' }; }
}

