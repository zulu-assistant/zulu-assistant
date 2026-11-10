// Completion packet (Zulu 1.1): a structured evidence block recorded when a task
// closes — what was asked, the PR and its head, the test runs the ledger CLI
// observed (`task.sh test N -- <command>`), checks the closer did not run, how
// each gate ended, and the closer's own summary, labelled as generated. Pure:
// the board reads the PR and passes it in. It is information, never a close gate.

export const MAX_STAMPS = 20;
export const MAX_PACKET_BYTES = 4096;
const REQUEST_CHARS = 600;
const COMMAND_CHARS = 300;
const SHA = /^[0-9a-f]{7,40}$/i;

const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const short = (sha) => (sha ? String(sha).slice(0, 7) : '?');

/** Validate one test stamp from the CLI → a clean stamp, or throws a message string. */
export function cleanStamp(s, now = Date.now()) {
  if (!s || typeof s !== 'object') throw 'stamp must be an object';
  const command = String(s.command ?? '').trim();
  if (!command) throw 'stamp needs the command';
  if (command.length > COMMAND_CHARS) throw `stamp command too long (${command.length} > ${COMMAND_CHARS})`;
  const exit = Number(s.exit);
  if (!Number.isInteger(exit) || exit < -1 || exit > 255) throw 'stamp exit must be an exit code (-1 = could not start)';
  const rev = s.rev == null || s.rev === '' ? null : String(s.rev).trim();
  if (rev && !SHA.test(rev)) throw 'stamp rev must be a git sha';
  const at = s.at && !Number.isNaN(Date.parse(s.at)) ? new Date(s.at).toISOString() : new Date(now).toISOString();
  return {
    command, exit, rev, at,
    branch: s.branch ? cut(s.branch, 120) : null,
    dirty: s.dirty === true,
    cwd: s.cwd ? cut(s.cwd, 200) : null,
    ms: Number.isFinite(Number(s.ms)) ? Math.max(0, Math.round(Number(s.ms))) : null,
  };
}

/** Append a stamp, keeping the newest MAX_STAMPS. */
export const addStamp = (stamps, stamp) => [...(stamps || []), stamp].slice(-MAX_STAMPS);

/** The request as filed: the title plus the body (its own field; on older tasks the first comment), cut. */
function requestedOf(t) {
  const first = (t.comments || [])[0];
  const body = t.request?.text || (first && first.who === t.requester ? first.text : '');
  return cut(body ? `${t.title} — ${body}` : t.title, REQUEST_CHARS);
}

/** A stamp is stale when it ran on a dirty tree or not on the PR's head commit. */
export function stampStale(stamp, prHead) {
  if (stamp.dirty) return 'dirty tree';
  if (prHead && stamp.rev && !prHead.startsWith(stamp.rev) && !stamp.rev.startsWith(prHead)) return `ran at ${short(stamp.rev)}, PR head ${short(prHead)}`;
  if (prHead && !stamp.rev) return 'no revision recorded';
  return null;
}

/**
 * Build the packet (pure). pr: { url, number, state, head, merge } | { url, unavailable } | null.
 * Stale = the newest stamp ran on a dirty tree or not on the PR head (close-time only).
 */
export function buildPacket(t, { pr = null, unrun = [], summary = '', now = Date.now() } = {}) {
  const head = pr && !pr.unavailable ? pr.head || null : null;
  const tests = (t.test_stamps || []).map((s) => ({ ...s, stale: stampStale(s, head) }));
  const last = tests[tests.length - 1] || null;
  const gates = (t.gates || []).map((g) => ({ id: g.id, cls: g.cls || null, status: g.status }));
  const p = {
    at: new Date(now).toISOString(),
    requested: requestedOf(t),
    pr: pr ? (pr.unavailable ? { url: pr.url, unavailable: cut(pr.unavailable, 80) }
      : { url: pr.url, number: pr.number ?? null, state: pr.state || null, head, merge: pr.merge || null }) : null,
    tests,
    unrun: (unrun || []).map((u) => cut(u, 160)).filter(Boolean).slice(0, 10),
    gates,
    summary: { text: cut(summary, 400), generated: true },
    stale: last ? last.stale : null,
  };
  return fit(p);
}

/** Keep the packet under MAX_PACKET_BYTES: drop the oldest stamps first, then trim text. */
function fit(p) {
  const size = () => Buffer.byteLength(JSON.stringify(p));
  while (size() > MAX_PACKET_BYTES && p.tests.length > 1) { p.tests.shift(); p.trimmed = true; }
  if (size() > MAX_PACKET_BYTES) { p.requested = cut(p.requested, 200); p.summary.text = cut(p.summary.text, 200); p.gates = p.gates.slice(-10); p.trimmed = true; }
  return p;
}

/** One-line test tally: "tests ✓2 ✗1 at abc1234". */
function testsBit(p) {
  if (!p.tests.length) return 'tests: none recorded';
  const pass = p.tests.filter((s) => s.exit === 0).length;
  const last = p.tests[p.tests.length - 1];
  return `tests ✓${pass} ✗${p.tests.length - pass} · last \`${cut(last.command, 60)}\` exit ${last.exit} at ${short(last.rev)}${last.dirty ? ' (dirty)' : ''}`;
}

function prBit(p) {
  if (!p.pr) return 'PR: none linked';
  if (p.pr.unavailable) return `PR: unavailable (${p.pr.unavailable})`;
  return `PR #${p.pr.number ?? '?'} @${short(p.pr.head)} ${String(p.pr.state || '').toLowerCase()}`.trim();
}

/** The block appended to the close comment. */
export function packetText(p) {
  const lines = [
    `EVIDENCE${p.stale ? ` · ⚠ STALE (${p.stale})` : ''}`,
    `${prBit(p)} · ${testsBit(p)}`,
    ...(p.unrun.length ? [`not run: ${p.unrun.join('; ')}`] : []),
    ...(p.gates.length ? [`gates: ${p.gates.map((g) => `${g.id} ${g.status}`).join(', ')}`] : []),
    ...(p.summary.text ? [`summary (generated): ${p.summary.text}`] : []),
  ];
  return lines.join('\n');
}

/** What the WORK panel shows for a closed task: one line + the stale reason (the board payload). */
export const packetBrief = (p) => (p ? { line: `${prBit(p)} · ${testsBit(p)}${p.unrun.length ? ` · ${p.unrun.length} not run` : ''}`, stale: p.stale || null, generated: p.summary?.text || '' } : null);

/** The ticker line in observe mode. */
export const packetLine = (id, p) => `packet #${id}: ${prBit(p)} · ${testsBit(p)}${p.unrun.length ? ` · ${p.unrun.length} not run` : ''}${p.stale ? ` · STALE (${p.stale})` : ''}`;

/**
 * Read a linked PR with gh (board side). Fails soft: gh missing, a timeout or an
 * unreadable answer gives { url, unavailable } — never an error, never a blocked close.
 */
export async function readPr(url, { run = ghRun, timeoutMs = 5000 } = {}) {
  if (!url) return null;
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(url)) return { url, unavailable: 'not a GitHub PR link' };
  try {
    const out = await run(['pr', 'view', url, '--json', 'number,state,headRefOid,mergeCommit'], timeoutMs);
    const j = JSON.parse(out);
    return { url, number: j.number ?? null, state: j.state || null, head: j.headRefOid || null, merge: j.mergeCommit?.oid || null };
  } catch (e) {
    return { url, unavailable: e?.code === 'ENOENT' ? 'gh not installed' : e?.killed ? 'gh timed out' : 'gh could not read it' };
  }
}

async function ghRun(args, timeoutMs) {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: timeoutMs }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** SETTINGS.completionPacket → 'off' | 'observe' | 'on' for this task's owner. */
export function packetMode(cfg, owner) {
  const mode = cfg?.mode || 'off';
  if (mode === 'off') return 'off';
  if (Array.isArray(cfg.only) && cfg.only.length && !cfg.only.includes(owner)) return 'off';
  return mode === 'on' ? 'on' : 'observe';
}
