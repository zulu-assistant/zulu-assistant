// What the guided setup's data steps DO, as functions that take the answers as data.
//
// The terminal wizard (scripts/setup.mjs) asks the questions and calls these; a page can call the
// same functions with answers from a form, so the two cannot drift apart. Nothing here prompts,
// prints, restarts the board or starts a login: a caller does that around the call.
//
// What each one writes, and nothing else:
//   applyOwner    overlay/config/local.json (owner), and the <OWNER>/<UID> placeholders in
//                 overlay/POLICY.md, MISSION-CONTROL.md, config/TRIAGE.md where they still stand
//                 (with { files: false }: local.json only; the three text files are not opened)
//   applyWatch    overlay/config/local.json (domains, jobs, docker, cron, endpoints, dropExamples)
//   applyEngines  overlay/config/models.json (engine), data/setup-state.json (answers.enginesChosen)
//   upsertSecrets data/secrets.env (owner-only), only the keys it is handed
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, STATE_FILE, readState, writeState, readJson } from './setup.mjs';
import { writePrivate } from './private-file.mjs';

const overlayDir = (o) => o || process.env.MC_OVERLAY || path.join(ROOT, 'overlay');
const json = async (f, d = {}) => readJson(f) || d;
const save = async (f, doc) => { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(doc, null, 2) + '\n'); };

/** The files that carry the owner's name as a placeholder until setup fills it, relative to overlay/. */
export const OWNER_FILES = ['POLICY.md', 'MISSION-CONTROL.md', 'config/TRIAGE.md'];
/** The roles an engine is chosen for. */
export const ENGINE_ROLES = ['master', 'worker', 'triage'];
export const ENGINES = ['claude', 'codex'];

/** "Sam Lee" → "sam-lee": the owner's id on the board. */
export const ownerId = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'owner';

/**
 * The owner step. An empty name writes nothing → null.
 *   files  false = write local.json only and never open the three text files (the setup page; the
 *          terminal wizard fills the placeholders)
 * → { owner: { id, name }, filled: [<file relative to overlay/>, …] }
 */
export async function applyOwner(name, { overlay, uid = process.getuid(), files = true } = {}) {
  if (!name) return null;
  const dir = overlayDir(overlay);
  const file = path.join(dir, 'config', 'local.json');
  const local = await json(file);
  local.owner = { id: ownerId(name), name };
  await save(file, local);
  const filled = [];
  if (!files) return { owner: local.owner, filled };
  for (const rel of OWNER_FILES) {
    const f = path.join(dir, rel);
    const t = await readFile(f, 'utf8').catch(() => null);
    if (t && t.includes('<OWNER>')) { await writeFile(f, t.replaceAll('<OWNER>', name).replaceAll('<UID>', String(uid))); filled.push(rel); }
  }
  return { owner: local.owner, filled };
}

/**
 * The watch step: what this board watches, from the scan results the owner ticked.
 *   jobs   [{ label, name }]        docker [{ name }]
 *   cron   [{ id, match, schedule }] urls  ['https://…']
 * → { jobs, docker, cron, endpoints } (counts)
 */
export async function applyWatch({ jobs = [], docker = [], cron = [], urls = [] } = {}, { overlay } = {}) {
  const file = path.join(overlayDir(overlay), 'config', 'local.json');
  const local = await json(file);
  local.domains = [{ id: 'mine', name: 'My Jobs', accent: '#00e5e5' }];
  local.jobs = jobs.map((j) => ({ label: j.label, name: j.name, domain: 'mine' }));
  local.docker = docker.map((c) => ({ name: c.name, display: `Docker: ${c.name}`, domain: 'mine' }));
  local.cron = cron.map((c) => ({ id: c.id, name: c.match, domain: 'mine', schedule: c.schedule, match: c.match, quietOk: true }));
  local.endpoints = urls.map((u, i) => ({ id: `ep${i + 1}`, name: u.replace(/^https?:\/\//, ''), url: u, everyPolls: 5 }));
  local.dropExamples = true;
  await save(file, local);
  return { jobs: local.jobs.length, docker: local.docker.length, cron: local.cron.length, endpoints: local.endpoints.length };
}

/**
 * The engines step, the choice only (logins are each tool's own flow, started by the caller).
 *   engine { master, worker, triage } each 'claude' | 'codex'; anything else is refused, nothing written.
 * → the engine object as written
 */
export async function applyEngines(engine, { overlay, root = ROOT, stateFile = STATE_FILE } = {}) {
  const chosen = {};
  for (const role of ENGINE_ROLES) {
    if (!ENGINES.includes(engine?.[role])) throw new Error(`engine for ${role} must be one of: ${ENGINES.join(', ')}`);
    chosen[role] = engine[role];
  }
  const file = path.join(overlayDir(overlay), 'config', 'models.json');
  const models = await json(file, await json(path.join(root, 'examples/config/models.json')));
  await save(file, { ...models, engine: chosen });
  const st = (await readState(stateFile)) || { steps: {}, answers: {} };
  st.answers = { ...(st.answers || {}), enginesChosen: true };
  await writeState(st, stateFile);
  return chosen;
}

/** A character that would end a line or hide in one: never part of a value in the secrets file. */
export const ONE_LINE = /[\x00-\x1f\x7f\x85]|\p{Zl}|\p{Zp}/u;

/**
 * Set keys in the secrets file (owner-only). A key with an empty or missing value is left as it is; a file that
 * does not exist yet starts from the template. → the keys that were written
 *
 * A value is written between double quotes exactly as it is, with nothing escaped: the board's reader
 * (src/config.mjs parseEnv) and scripts/bootstrap.sh take one quote off each end and nothing else, so this is
 * the form that reads back as the same value. (It was JSON text before: a password holding a quote or a
 * backslash came back with backslashes added.) A value that cannot be one line, or a name that is not a
 * setting's name, is refused before anything is written.
 */
export async function upsertSecrets(pairs, { secretsFile = path.join(ROOT, 'data', 'secrets.env'), root = ROOT } = {}) {
  const set = Object.entries(pairs || {}).filter(([, v]) => v !== undefined && v !== '');
  for (const [k, v] of set) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error('a secrets key is capital letters, digits and _');
    if (typeof v !== 'string' || ONE_LINE.test(v)) throw new Error(`the value for ${k} must be one line of text`);
  }
  const text = await readFile(secretsFile, 'utf8').catch(async () => readFile(path.join(root, 'secrets.env.example'), 'utf8'));
  const lines = text.split('\n');
  const written = [];
  for (const [k, v] of set) {
    const i = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${k}=`));
    const line = `${k}="${v}"`;
    if (i >= 0) lines[i] = line; else lines.push(line);
    written.push(k);
  }
  await mkdir(path.dirname(secretsFile), { recursive: true });
  await writePrivate(secretsFile, lines.join('\n'));
  return written;
}
