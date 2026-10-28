// Overlay + secrets resolver (Agent-OS Phase 2).
//
// One engine, two skins: everything owner-specific lives in overlay/ (tracked in
// the private repo, gitignored in the public one); generic twins live in
// examples/. A config path resolves overlay/<rel> → <rel> (core) → examples/<rel>.
// Files the board WRITES (the mesh directory) always live in overlay/, seeded
// from examples/ on first use — a public checkout never writes into examples/.
//
// Secrets never live in config: data/secrets.env (gitignored, mode 600;
// template secrets.env.example). loadSecrets() re-reads it when it changes.
//
// Env: MC_OVERLAY=<dir> points the overlay elsewhere (tests; a public checkout
// with no overlay resolves straight to examples/). MC_SECRETS=<file> likewise.
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const OVERLAY = process.env.MC_OVERLAY || path.join(ROOT, 'overlay');
export const EXAMPLES = path.join(ROOT, 'examples');
export const SECRETS_FILE = process.env.MC_SECRETS || path.join(ROOT, 'data', 'secrets.env');

/** Where a config file comes from: overlay/<rel>, else <rel>, else examples/<rel>. */
export function resolve(rel, { root = ROOT, overlay = OVERLAY, examples = EXAMPLES } = {}) {
  for (const p of [path.join(overlay, rel), path.join(root, rel), path.join(examples, rel)]) if (existsSync(p)) return p;
  return path.join(overlay, rel);
}

/** A config file the board writes: always overlay/<rel>, seeded from examples/<rel> if absent. */
export function writable(rel, { overlay = OVERLAY, examples = EXAMPLES } = {}) {
  const p = path.join(overlay, rel);
  if (!existsSync(p)) {
    const seed = path.join(examples, rel);
    if (existsSync(seed)) { mkdirSync(path.dirname(p), { recursive: true }); copyFileSync(seed, p); }
  }
  return p;
}

/** KEY=value lines (# comments, optional quotes); first occurrence wins. */
export function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [k, ...rest] = line.split('=');
    const key = k.trim().replace(/^export\s+/, '');
    if (!(key in out)) out[key] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

let secretsCache = { mtimeMs: -1, values: {} };
/** data/secrets.env as an object ({} when absent); cached until the file changes. */
export function loadSecrets(file = SECRETS_FILE) {
  let st;
  try { st = statSync(file); } catch { return {}; }
  if (file === SECRETS_FILE && st.mtimeMs === secretsCache.mtimeMs) return secretsCache.values;
  const values = parseEnv(readFileSync(file, 'utf8'));
  if (file === SECRETS_FILE) secretsCache = { mtimeMs: st.mtimeMs, values };
  return values;
}

// The fleet registry (what the board watches + its settings). Re-exported so the
// import sites read `from './config.mjs'` and never care which skin is active.
export const REGISTRY_FILE = resolve('config/jobs.mjs');
const registryModule = await import(pathToFileURL(REGISTRY_FILE).href);

// `zulu setup` (scripts/setup.mjs) never edits jobs.mjs: what it learns — the
// owner, the jobs/containers/cron lines/endpoints picked from a scan of this Mac —
// goes to overlay/config/local.json and is merged here. `dropExamples` removes
// the registry's `example: true` placeholder entries once real ones exist.
export const LOCAL_FILE = path.join(OVERLAY, 'config', 'local.json');
export function mergeLocal(reg, local) {
  if (!local || typeof local !== 'object') return reg;
  const keep = (list = []) => (local.dropExamples ? list.filter((x) => !x.example) : list);
  const add = (list, extra, key) => {
    const out = keep(list);
    const seen = new Set(out.map((x) => x[key]));
    for (const x of extra || []) if (x && x[key] && !seen.has(x[key])) { out.push(x); seen.add(x[key]); }
    return out;
  };
  return {
    ...reg,
    DOMAINS: add(reg.DOMAINS, local.domains, 'id'),
    JOBS: add(reg.JOBS, local.jobs, 'label'),
    DOCKER_CONTAINERS: add(reg.DOCKER_CONTAINERS, local.docker, 'name'),
    CRON: add(reg.CRON, local.cron, 'id'),
    ENDPOINTS: add(reg.ENDPOINTS, local.endpoints, 'id'),
    PROCESSES: keep(reg.PROCESSES),
    SETTINGS: { ...reg.SETTINGS, ...(local.settings || {}), ...(local.owner ? { owner: local.owner } : {}) },
  };
}
let localDoc = null;
try { localDoc = JSON.parse(readFileSync(LOCAL_FILE, 'utf8')); } catch { /* no setup answers yet */ }
const registry = mergeLocal(registryModule, localDoc);
export const { DOMAINS, ENDPOINTS, PROCESSES, CRON, CRON_DRIFT, MEM, CONTEXT, DISK, JOBS, DOCKER_CONTAINERS, SETTINGS } = registry;
// optional in older registries: no levers = remediation never runs
export const REMEDIATION_LEVERS = registry.REMEDIATION_LEVERS || [];

// The human principal: approves on the board, can be blocked on, is never woken.
// `owner` is always accepted as an alias for OWNER.id (scripts/docs say `--on owner`).
export const OWNER = { id: 'owner', name: 'Owner', ...(SETTINGS.owner || {}) };
export const isOwner = (x) => x === OWNER.id || x === 'owner';

// Other humans (chat intake, task #223): config/principals.json lists people who
// may file requests from a team chat and can be blocked on (`--on <id>`). They are
// never agents and never approve — approvals stay OWNER's, on the board.
// [{ id, name, slack: ['<member id>'] }]; the owner's entry (if any) carries its chat ids.
export function principalsFrom(list, owner = OWNER) {
  const out = new Map([[owner.id, { id: owner.id, name: owner.name, slack: [], approver: true }]]);
  for (const p of Array.isArray(list) ? list : []) {
    const id = String(p?.id || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id)) continue;
    const key = id === 'owner' ? owner.id : id;
    const prev = out.get(key);
    out.set(key, {
      id: key, name: String(p.name || prev?.name || id), approver: key === owner.id,
      slack: (Array.isArray(p.slack) ? p.slack : []).map(String).filter((s) => /^[UW][A-Z0-9]{2,}$/.test(s)),
      // planFirst: this person's chat requests are PLANNING ONLY until the owner reviews the plan
      planFirst: key !== owner.id && p.planFirst === true,
    });
  }
  return out;
}
let principalsDoc = [];
try { principalsDoc = JSON.parse(readFileSync(resolve('config/principals.json'), 'utf8')); } catch { /* owner only */ }
export const PRINCIPALS = principalsFrom(principalsDoc);
/** A human the ledger knows: the owner (or its alias) or a listed principal. */
export const isPrincipal = (x) => isOwner(x) || PRINCIPALS.has(String(x || '').toLowerCase());
