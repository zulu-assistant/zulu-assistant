// `zulu setup` state + live checks, shared by the wizard (scripts/setup.mjs),
// the board's setup card (src/status.mjs) and `zulu doctor`.
//
// The install (./install.sh) puts the whole agent OS in place without asking
// anything; setup then walks the person through what only they can provide:
// accounts, which engine runs Mission Control, what to watch, alert channels,
// the vault, macOS permissions, residents. Every step has a LIVE check, so the
// wizard is resumable and re-runnable, and a step a person skips stays visible
// as "skipped" instead of silently missing.
//
// State: data/setup-state.json { installedAt, steps: { <id>: { status: 'done'|'skipped', at, note } }, answers: {} }
// It exists only on an install made by ./install.sh, so an existing board that
// was set up by hand never shows a setup card.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STATE_FILE = path.join(ROOT, 'data', 'setup-state.json');
const HOME = process.env.HOME || '';

/**
 * The steps, in wizard order. Required (1.3): only what the agent workforce cannot start without:
 * your GitHub login, an engine, who you are, and the final check. Everything else is optional:
 * a skipped optional step never keeps the setup card amber.
 */
export const STEPS = [
  { id: 'github',    title: 'GitHub account',             required: true },
  { id: 'engines',   title: 'AI engines (Claude / Codex)', required: true },
  { id: 'owner',     title: 'You (owner name + policy)',   required: true },
  { id: 'watch',     title: 'What to watch on this Mac',   required: false },
  { id: 'alerts',    title: 'Alerts (email / SMS / dead-man)', required: false },
  { id: 'vault',     title: 'Obsidian vault (org memory)', required: false },
  { id: 'brain',     title: 'Graphify + agent memory',     required: false },
  { id: 'macos',     title: 'macOS permissions + power',   required: false },
  { id: 'residents', title: 'Resident agents for your repos', required: false },
  { id: 'verify',    title: 'Verify + start Mission Control', required: true },
];

/**
 * What a light install (the default `./install.sh`) can add, each with one command, each opt-in.
 * The board shows these on one info card in place of a setup checklist; install.sh prints the same.
 */
export const NEXT_STEPS = [
  { id: 'guardrails', what: 'Guardrails: hold agents\' irreversible commands for your click (5 minutes)', run: './install.sh --guardrails' },
  { id: 'full',       what: 'cmux, the agent mesh, Mission Control and scheduled triage (triage costs money)', run: './install.sh --full' },
  { id: 'brain',      what: 'the brain: skills, Graphify, your vault', run: './install.sh --brain' },
  { id: 'watch',      what: 'choose what this board watches', run: 'zulu setup --step watch' },
];

export async function readState(file = STATE_FILE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
export function readStateSync(file = STATE_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}
export async function writeState(doc, file = STATE_FILE) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(doc, null, 1));
  await rename(tmp, file);
}
/**
 * A light install on which Guardrails has been seen once (a registered hook, or a gate in the ledger) is marked,
 * so that a hook lost later is shown as missing and not taken for "never installed". Only a light install's state
 * file is touched, and only once. → true when the mark was written
 */
export async function noteGuardrailsSeen(file = STATE_FILE) {
  const doc = await readState(file);
  if (!doc || doc.mode !== 'light' || doc.guardrailsSeen) return false;
  doc.guardrailsSeen = Date.now();
  await writeState(doc, file);
  return true;
}
/**
 * The full install was run on what the light install made: the state file stops saying 'light' (install.sh writes
 * the file only when there is none, so without this a light install stayed light for good). → true when changed
 */
export async function leaveLight(file = STATE_FILE) {
  const doc = await readState(file);
  if (!doc || doc.mode !== 'light') return false;
  doc.mode = 'full'; doc.fullAt = Date.now();
  await writeState(doc, file);
  return true;
}
export async function markStep(id, status, note = '', file = STATE_FILE) {
  const doc = (await readState(file)) || { installedAt: Date.now(), steps: {}, answers: {} };
  doc.steps ||= {};
  doc.steps[id] = { status, at: Date.now(), ...(note ? { note } : {}) };
  await writeState(doc, file);
  return doc;
}

/** Board/doctor summary from the state file only (cheap, no subprocesses). */
export function summarize(doc) {
  if (!doc) return null;
  const steps = STEPS.map((s) => ({ ...s, status: doc.steps?.[s.id]?.status || 'todo' }));
  const handled = steps.filter((s) => s.status !== 'todo');
  const next = steps.find((s) => s.status === 'todo');
  const skippedRequired = steps.filter((s) => s.required && s.status === 'skipped');
  return {
    done: handled.length, total: steps.length, next: next ? next.title : null,
    complete: !next, skippedRequired: skippedRequired.map((s) => s.title), steps,
  };
}

/** The board's setup card, or null when this install wasn't made by install.sh. */
export function setupCard(doc) {
  const s = summarize(doc);
  if (!s) return null;
  // a light install that has not started the guided setup: next steps, info only (never amber: nothing is owed)
  if (doc.mode === 'light' && s.done === 0) {
    return { label: 'setup:', name: 'Next steps', domain: 'infra', schedule: 'opt-in', logAvailable: false, status: 'ok',
      detail: `nothing else is installed. When you want it: ${NEXT_STEPS.map((n) => `${n.what} → ${n.run}`).join(' · ')}` };
  }
  const status = !s.complete ? 'due' : s.skippedRequired.length ? 'warn' : 'ok';
  const detail = !s.complete ? `setup ${s.done}/${s.total} — run: zulu setup (next: ${s.next})`
    : s.skippedRequired.length ? `setup complete, skipped: ${s.skippedRequired.join(', ')} — zulu setup to finish`
      : `setup complete (${s.total}/${s.total})`;
  return { label: 'setup:', name: 'Zulu setup', domain: 'infra', schedule: 'zulu setup', logAvailable: false, status, detail };
}

// ---- live checks ---------------------------------------------------------------
export function run(cmd, args, { timeout = 10000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: { ...process.env, ...env } }, (err, stdout, stderr) =>
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, out: String(stdout || ''), err: String(stderr || '') }));
  });
}
const has = async (bin) => (await run('/bin/sh', ['-c', `command -v ${bin}`])).ok;

/** VAULT + label prefix exactly as the shell scripts resolve them (scripts/env.sh). */
export async function shellEnv() {
  const r = await run('/bin/bash', ['-c', `ROOT="${ROOT}"; . "${ROOT}/scripts/env.sh" >/dev/null 2>&1; printf '%s\\n%s' "$VAULT" "$MC_LABEL_PREFIX"`]);
  const [vault, prefix] = r.out.split('\n');
  return { vault: vault || path.join(HOME, 'Vault'), prefix: prefix || 'com.zulu-assistant' };
}

export async function engineStatus() {
  const out = {};
  if (await has('claude')) {
    const r = await run('claude', ['auth', 'status'], { timeout: 20000 });
    let j = null; try { j = JSON.parse(r.out); } catch { /* older CLI */ }
    out.claude = { installed: true, loggedIn: Boolean(j?.loggedIn), via: j?.authMethod || null };
  } else out.claude = { installed: false, loggedIn: false };
  if (await has('codex')) {
    const r = await run('codex', ['login', 'status'], { timeout: 15000 });
    out.codex = { installed: true, loggedIn: r.ok, via: r.ok ? (r.out + r.err).trim().replace(/^Logged in using /, '') : null };
  } else out.codex = { installed: false, loggedIn: false };
  return out;
}

export function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }

/**
 * The example values the secrets template carried in its keys until they were moved into comments. An
 * install made before that has them in data/secrets.env (the full install copies the template, and an
 * upgrade never touches data/), so a key that still holds one is not a channel the owner set up.
 */
export const TEMPLATE_EXAMPLES = {
  SMTP_HOST: 'smtp.example.com', SMTP_USER: 'alerts@example.com', ALERT_EMAIL_TO: 'you@example.com',
  SMS_WEBHOOK_URL: 'https://sms.example.com/api/sms', SMS_ALERT_TO: '+15555550100',
  HEARTBEAT_URL: 'https://<project-ref>.supabase.co/rest/v1/ops_heartbeat?id=eq.1',
};
/**
 * Which alert channels are on, from the secrets: a channel counts when the board would send through it,
 * the same keys its senders ask for (src/alerts.mjs sendEmail and sendSms, server.mjs heartbeat), and a
 * key that still holds the template's example value counts as empty.
 * → { tiers: ['email' | 'sms' | 'heartbeat'], examples: [<key that still holds an example value>] }
 */
export function alertTiers(env = {}) {
  const examples = Object.keys(TEMPLATE_EXAMPLES).filter((k) => env[k] === TEMPLATE_EXAMPLES[k]);
  const set = (k) => Boolean(env[k]) && !examples.includes(k);
  const tiers = [
    set('SMTP_HOST') && set('SMTP_USER') && set('SMTP_PASS') && 'email',
    set('SMS_WEBHOOK_URL') && set('SMS_WEBHOOK_KEY') && set('SMS_ALERT_TO') && 'sms',
    set('HEARTBEAT_URL') && set('HEARTBEAT_KEY') && 'heartbeat',
  ].filter(Boolean);
  return { tiers, examples };
}

/** Live check per step → { ok, detail }. `ctx` carries resolved paths (tests inject). */
export async function checkStep(id, ctx = {}) {
  const overlay = ctx.overlay || path.join(ROOT, 'overlay');
  const local = readJson(path.join(overlay, 'config', 'local.json')) || {};
  const models = readJson(path.join(overlay, 'config', 'models.json')) || {};
  switch (id) {
    case 'github': {
      const r = await run('gh', ['auth', 'status'], { timeout: 15000 });
      return { ok: r.ok, detail: r.ok ? 'gh is logged in' : 'not logged in — gh auth login' };
    }
    case 'engines': {
      const e = ctx.engines || await engineStatus();
      const want = [...new Set(Object.values(models.engine || {}))];
      // the examples ship a claude default — the step counts only once the person chose
      if (!want.length || (ctx.state && !ctx.state.answers?.enginesChosen)) return { ok: false, detail: 'no engine chosen yet' };
      const missing = want.filter((n) => !e[n]?.loggedIn);
      return { ok: !missing.length, detail: missing.length ? `not logged in: ${missing.join(', ')}` : `engines: ${Object.entries(models.engine).map(([k, v]) => `${k}=${v}`).join(' · ')}` };
    }
    case 'owner':
      return { ok: Boolean(local.owner?.name), detail: local.owner?.name ? `owner: ${local.owner.name}` : 'owner name not set' };
    case 'watch': {
      const n = ['jobs', 'docker', 'cron', 'endpoints'].reduce((a, k) => a + (local[k]?.length || 0), 0);
      return { ok: Boolean(local.dropExamples), detail: local.dropExamples ? `${n} item(s) from this Mac on the board` : 'still showing the example placeholders' };
    }
    case 'alerts': {
      const { tiers, examples } = alertTiers(ctx.secrets || {});
      const left = examples.length ? ` · still the template's example value: ${examples.join(', ')}` : '';
      return { ok: tiers.length > 0, detail: `${tiers.length ? `on: ${tiers.join(', ')}` : 'no alert channel (cmux notifications only)'}${left}` };
    }
    case 'vault': {
      const v = ctx.vault || (await shellEnv()).vault;
      const ok = existsSync(path.join(v, '.scripts', 'vault-backup.sh')) && existsSync(path.join(v, '.git'));
      return { ok, detail: ok ? `vault at ${v.replace(HOME, '~')}` : `no vault at ${v.replace(HOME, '~')}` };
    }
    case 'brain': {
      const g = await has('graphify');
      const skills = ['graphify', 'sync-obsidian'].filter((s) => existsSync(path.join(HOME, '.claude', 'skills', s, 'SKILL.md')));
      const parts = [g ? 'graphify' : 'graphify MISSING', `${skills.length}/2 skills`];
      return { ok: g && skills.length === 2, detail: parts.join(' · ') };
    }
    case 'macos': {
      const r = await run('pmset', ['-g']);
      const auto = /autorestart\s+1/.test(r.out);
      return { ok: Boolean(ctx.state?.answers?.macosConfirmed), detail: `${auto ? 'autorestart on' : 'autorestart off'}${ctx.state?.answers?.macosConfirmed ? ' · permissions confirmed' : ''}` };
    }
    default: return { ok: false, detail: '' };
  }
}
