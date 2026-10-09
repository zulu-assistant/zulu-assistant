// Rolling event log for the bottom ticker: status transitions, actions,
// self-heals, remediation. Ring-buffered to data/events.json so the ticker
// survives server restarts (and reboots — standing self-healing rule).
import { readFile, writeFile } from 'node:fs/promises';
import { DEMO } from './demo.mjs';

// demo mode keeps its own ticker so a demo run never mixes into a real board's history
const FILE = new URL(DEMO ? '../data/demo-events.json' : '../data/events.json', import.meta.url);
const MAX = 200;
let events = null;

async function load() {
  if (!events) {
    try { events = JSON.parse(await readFile(FILE, 'utf8')); } catch { events = []; }
  }
  return events;
}

export async function recordEvent(kind, text) {
  await load();
  events.push({ at: Date.now(), kind, text: String(text).slice(0, 160) });
  if (events.length > MAX) events = events.slice(-MAX);
  writeFile(FILE, JSON.stringify(events)).catch(() => {});
}

export async function getEvents(limit = 40) {
  await load();
  return events.slice(-limit);
}
