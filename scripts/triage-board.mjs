#!/usr/bin/env node
// The scheduled triage pass's only way to the board (#588). Its allow list names this script and no curl,
// so the pass cannot call another address, send another method or post a file of its choosing.
//   read            GET /api/triage
//   event <file>    POST /api/event with {kind:'sys', text} from data/handoffs/triage-<stamp>.event.json
//   mark <label>    record "acted on now" for a card label in data/triage-state.json (the 12 h cooldown)
//   state           print data/triage-state.json ({} when absent)
//   stamp           the report name's time, UTC: YYYY-MM-DD-HHMM
//   ask <label> <file>  ask Mission Control for a worker (SETTINGS.triage.dispatch 'ask'): POST /api/triage/ask with
//                   a card label and data/handoffs/triage-fix-<label>.md; one per label per UTC day and two per
//                   30 minutes, kept here in data/triage-ask-state.json and checked again by the board
// Anything else exits 2. The board's address comes from this checkout's data/local.env (else the default
// port), never from the call or the environment: a settings file's env block reaches the pass's shell.
import { readFileSync, writeFileSync, renameSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ASK_FILE, ASK_PER_WINDOW, ASK_WINDOW_MIN, LABEL, askFile } from '../src/triage-ask.mjs';

export const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
export const EVENT_MAX = 1024;
export const EVENT_NAME = /^triage-\d{4}-\d{2}-\d{2}-\d{4}\.event\.json$/;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;   // control characters and the two Unicode line breaks
const USAGE = 'usage: triage-board.sh read | event <data/handoffs/triage-YYYY-MM-DD-HHMM.event.json> | mark <card label> | state | stamp | ask <card label> <data/handoffs/triage-fix-<label>.md>';

export class Refused extends Error {}

/** The board's port from <root>/data/local.env (MC_PORT=digits), else 3210. */
export function boardPort(root = ROOT) {
  try {
    const m = readFileSync(path.join(root, 'data', 'local.env'), 'utf8').match(/^\s*(?:export\s+)?MC_PORT=["']?(\d{2,5})["']?\s*$/m);
    if (m) return Number(m[1]);
  } catch { /* no file: the default */ }
  return 3210;
}

export function stamp(now = new Date()) {
  return now.toISOString().replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}).*$/, '$1-$2$3');
}

/** The event file, checked: inside <root>/data/handoffs, named triage-<stamp>.event.json, a plain file under 1 KB,
 *  exactly { kind: 'sys', text } with text one line of printable characters. Returns the body to send. */
export function eventBody(arg, { root = ROOT, cwd = process.cwd() } = {}) {
  const real = (x) => { try { return realpathSync(x); } catch { return null; } };
  const dir = real(path.join(root, 'data', 'handoffs'));
  const p = path.resolve(cwd, String(arg || ''));
  if (!dir || real(path.dirname(p)) !== dir || !EVENT_NAME.test(path.basename(p))) throw new Refused('the event file must be data/handoffs/triage-YYYY-MM-DD-HHMM.event.json');
  let st; try { st = lstatSync(p); } catch { throw new Refused('the event file does not exist'); }
  if (!st.isFile()) throw new Refused('the event file is not a plain file');
  if (real(p) !== path.join(dir, path.basename(p))) throw new Refused('the event file is not where it is named');
  if (st.size > EVENT_MAX) throw new Refused(`the event file is over ${EVENT_MAX} bytes`);
  let j; try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { throw new Refused('the event file is not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j) || Object.keys(j).sort().join() !== 'kind,text') throw new Refused('the event must be exactly {"kind":"sys","text":"…"}');
  if (j.kind !== 'sys') throw new Refused('the event kind must be "sys"');
  if (typeof j.text !== 'string' || !j.text.trim()) throw new Refused('the event text is empty');
  if (CONTROL.test(j.text)) throw new Refused('the event text holds a control character');
  return JSON.stringify({ kind: 'sys', text: j.text });
}

/** data/triage-state.json as an object of label → epoch seconds ({} when absent; refused when not that shape). */
export function readState(root = ROOT) {
  const f = path.join(root, 'data', 'triage-state.json');
  if (!existsSync(f)) return {};
  let j; try { j = JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Refused('data/triage-state.json is not JSON'); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Refused('data/triage-state.json is not an object');
  return j;
}

export function markState(label, labels, { root = ROOT, now = Date.now() } = {}) {
  if (!labels.includes(label)) throw new Refused(`"${label}" is not the label of a card in the board's reading`);
  const s = readState(root);
  s[label] = Math.floor(now / 1000);
  const f = path.join(root, 'data', 'triage-state.json');
  const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
  renameSync(tmp, f);
  return s;
}

async function board(port, pathname, init = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`board answered ${r.status} for ${pathname}`);
  return text;
}
export const readBoard = (port) => board(port, '/api/triage');
export const postEvent = (port, body) => board(port, '/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
export async function cardLabels(port) {
  const r = JSON.parse(await readBoard(port));
  return (r.cards || []).map((c) => c.label).filter((l) => typeof l === 'string');
}

// this script's own count of asks, the first of the two checks (the board's is the other):
// data/triage-ask-state.json = { labels: { <label>: 'YYYY-MM-DD' }, at: [ms, …] }
const ASK_STATE = (root) => path.join(root, 'data', 'triage-ask-state.json');
function readAskState(root) {
  try { const j = JSON.parse(readFileSync(ASK_STATE(root), 'utf8')); return { labels: j.labels && typeof j.labels === 'object' ? j.labels : {}, at: Array.isArray(j.at) ? j.at.filter(Number.isFinite) : [] }; } catch { return { labels: {}, at: [] }; }
}
/** Refused unless this label has no ask today and fewer than two asks lie in the last 30 minutes; → the state. */
export function askAllowed(label, file, { root = ROOT, now = Date.now() } = {}) {
  if (!LABEL.test(String(label))) throw new Refused('no card label');
  if (!ASK_FILE.test(path.basename(String(file)))) throw new Refused('the prompt file must be data/handoffs/triage-fix-<label>.md');
  try { askFile(file, root); } catch (e) { throw new Refused(e.message); }
  const s = readAskState(root);
  const today = new Date(now).toISOString().slice(0, 10);
  if (s.labels[label] === today) throw new Refused(`already asked for ${label} today`);
  const recent = s.at.filter((t) => now - t < ASK_WINDOW_MIN * 60e3);
  if (recent.length >= ASK_PER_WINDOW) throw new Refused(`${ASK_PER_WINDOW} asks in the last ${ASK_WINDOW_MIN} minutes`);
  return { ...s, at: recent };
}
export function noteAsk(label, s, { root = ROOT, now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const labels = Object.fromEntries(Object.entries(s.labels).filter(([, d]) => d === today));
  labels[label] = today;
  const f = ASK_STATE(root); const tmp = `${f}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ labels, at: [...s.at, now] }, null, 2)}\n`);
  renameSync(tmp, f);
}
export async function postAsk(port, label, file) {
  const r = await fetch(`http://127.0.0.1:${port}/api/triage/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label, file }), signal: AbortSignal.timeout(10_000) });
  let j = {}; try { j = JSON.parse(await r.text()); } catch { /* not JSON */ }
  if (r.status === 409) throw new Refused(`the board refused the ask: ${j.refused || 'no reason given'}`);
  if (!r.ok || !j.ok) throw new Error(`board answered ${r.status} for /api/triage/ask`);
  return j;
}

export async function main(argv, { root = ROOT, port = boardPort(root), out = process.stdout, now = Date.now() } = {}) {
  const [cmd, ...rest] = argv;
  const arity = { read: 0, event: 1, mark: 1, state: 0, stamp: 0, ask: 2 };
  if (!Object.hasOwn(arity, cmd || '') || rest.length !== arity[cmd]) throw new Refused(USAGE);
  if (cmd === 'stamp') return out.write(`${stamp()}\n`);
  if (cmd === 'state') return out.write(`${JSON.stringify(readState(root), null, 2)}\n`);
  if (cmd === 'read') return out.write(`${await readBoard(port)}\n`);
  if (cmd === 'event') { const body = eventBody(rest[0], { root }); await postEvent(port, body); return out.write('event posted\n'); }
  if (cmd === 'ask') {
    const [label, file] = rest;
    const s = askAllowed(label, file, { root, now });
    const j = await postAsk(port, label, `data/handoffs/${path.basename(file)}`);
    noteAsk(label, s, { root, now });
    return out.write(`asked Mission Control: task #${j.id}\n`);
  }
  const s = markState(rest[0], await cardLabels(port), { root });
  return out.write(`marked ${rest[0]} at ${s[rest[0]]}\n`);
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`triage-board: ${e.message}\n`);
    process.exit(e instanceof Refused ? 2 : 1);
  });
}
