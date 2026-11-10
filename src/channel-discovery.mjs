// Channel discovery (#365): the chat intake writes the channels it can see but no
// route covers into data/chat-intake/status.json (`unmapped`); the board files ONE
// ledger task per channel id (source key slack-channel:<id>, deduped by the ledger
// for good, closed tasks included) and one ticker line when it does. Ignoring a
// channel = list it in channels.json ignoreChannels (the intake then stops
// reporting it). Read-only against chat: the board never holds chat tokens.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoveryTask } from './intake.mjs';

const handled = new Set();   // channel ids already sent to the ledger this boot

/** status.json → the unmapped list ([] when the intake isn't installed or hasn't reported). */
export async function readUnmapped(stateDir) {
  try {
    const st = JSON.parse(await readFile(path.join(stateDir, 'status.json'), 'utf8'));
    return Array.isArray(st.unmapped) ? st.unmapped.filter((u) => u && u.id && u.name) : [];
  } catch { return []; }
}

/** One pass: file what's new. → the tasks created (existing ones are skipped silently). */
export async function maybeChannelDiscovery({ stateDir, ledger, owner, record = () => {}, afterCreate = async () => {}, seen = handled }) {
  const created = [];
  for (const ch of await readUnmapped(stateDir)) {
    if (seen.has(ch.id)) continue;
    const task = await ledger.create(discoveryTask(ch, { owner }));
    seen.add(ch.id);
    if (task.existing) continue;
    record('bad',`chat intake: #${ch.name} is not routed${ch.member ? '' : ' (bot not invited)'}: its requests are not filed; task #${task.id}`);
    await afterCreate(task);
    created.push(task);
  }
  return created;
}
