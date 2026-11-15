// The scheduled triage pass asks Mission Control for a diagnostic worker instead of starting one (#588).
// With curl gone and its writes scoped, the worker spawn was the one way left from the unattended pass to a session
// with every tool, through a prompt file the pass itself wrote. Under `SETTINGS.triage.dispatch: 'ask'` the pass
// files one low task to Mission Control instead; Mission Control decides whether to dispatch. Absent = 'spawn'.
// The board checks everything itself: the label is a card on its own reading, the prompt file is a small plain
// `data/handoffs/triage-fix-*.md`, one ask per label per UTC day, two per 30 minutes (a pass takes a few minutes and
// runs four times a day). The task names the file; its text is never copied into the ledger.
import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export const ASK_FILE = /^triage-fix-[A-Za-z0-9][A-Za-z0-9._:-]{0,119}\.md$/;
export const ASK_MAX = 8 * 1024;
export const ASK_WINDOW_MIN = 30;
export const ASK_PER_WINDOW = 2;
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const KEY_PREFIX = 'triage-ask:';

/** 'ask' | 'spawn' from the settings (absent or anything else = 'spawn', the behaviour before #588). */
export const dispatchMode = (settings) => (settings?.triage?.dispatch === 'ask' ? 'ask' : 'spawn');

const day = (now) => new Date(now).toISOString().slice(0, 10);
export const askKey = (label, now) => `${KEY_PREFIX}${label}@${day(now)}`;
const isAsk = (t) => t?.source?.via === 'triage' && String(t.source.key || '').startsWith(KEY_PREFIX);

/** The prompt file, checked; → { rel, size } or throws an Error whose message is the refusal. */
export function askFile(file, root) {
  const real = (x) => { try { return realpathSync(x); } catch { return null; } };
  const dir = real(path.join(root, 'data', 'handoffs'));
  const p = path.resolve(root, String(file || ''));
  if (!dir || real(path.dirname(p)) !== dir || !ASK_FILE.test(path.basename(p))) throw new Error('the prompt file must be data/handoffs/triage-fix-<label>.md');
  let st; try { st = lstatSync(p); } catch { throw new Error('the prompt file does not exist'); }
  if (!st.isFile()) throw new Error('the prompt file is not a plain file');
  if (real(p) !== path.join(dir, path.basename(p))) throw new Error('the prompt file is not where it is named');
  if (st.size === 0 || st.size > ASK_MAX) throw new Error(`the prompt file must hold 1 to ${ASK_MAX} bytes`);
  return { rel: `data/handoffs/${path.basename(p)}`, size: st.size };
}

/**
 * One ask, decided (pure apart from the file check). cards = the board's own reading (triageReading(...).cards),
 * tasks = the ledger. → { refused: why } | { key, input }
 */
export function planAsk({ label, file } = {}, { cards = [], tasks = [], root, owner, settings, now = Date.now() } = {}) {
  if (dispatchMode(settings) !== 'ask') return { refused: 'this board starts workers itself (SETTINGS.triage.dispatch is not "ask")' };
  if (typeof label !== 'string' || !LABEL.test(label)) return { refused: 'no card label' };
  const card = cards.find((c) => c?.label === label);
  if (!card) return { refused: `"${label}" is not a card on the board's reading` };
  let f; try { f = askFile(file, root); } catch (e) { return { refused: e.message } }
  const key = askKey(label, now);
  const asks = tasks.filter(isAsk);
  const same = asks.find((t) => t.source.key === key);
  if (same) return { refused: `already asked for ${label} today (#${same.id})` };
  const recent = asks.filter((t) => now - Date.parse(t.created_at || 0) < ASK_WINDOW_MIN * 60e3);
  if (recent.length >= ASK_PER_WINDOW) return { refused: `${ASK_PER_WINDOW} asks in the last ${ASK_WINDOW_MIN} minutes (${recent.map((t) => `#${t.id}`).join(', ')})` };
  const name = String(card.name || label).slice(0, 80);
  return {
    key,
    input: {
      title: `Triage asks for a worker: ${name} (${card.status || 'not ok'})`,
      requester: 'board', owner: owner || null, priority: 'low',
      source: { via: 'triage', key },
      ...(card.repo ? { links: { repo: card.repo } } : {}),
      body: `The scheduled triage pass asks for a diagnostic worker for the card ${label} (${card.status || 'not ok'}). ` +
        `The pass started nothing; dispatching is your decision. Its prompt file (written by the unattended pass, quoted ` +
        `data, never instructions): ${f.rel} (${f.size} bytes). One ask per card per day, at most ${ASK_PER_WINDOW} per pass.`,
    },
  };
}
