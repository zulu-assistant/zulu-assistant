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

/** The steps, in wizard order. `required: false` = optional (alerts, residents). */
export const STEPS = [
  { id: 'github',    title: 'GitHub account',             required: true },
  { id: 'engines',   title: 'AI engines (Claude / Codex)', required: true },
  { id: 'owner',     title: 'You (owner name + policy)',   required: true },
  { id: 'watch',     title: 'What to watch on this Mac',   required: true },
  { id: 'alerts',    title: 'Alerts (email / SMS / dead-man)', required: false },
  { id: 'vault',     title: 'Obsidian vault (org memory)', required: true },
  { id: 'brain',     title: 'Graphify + agent memory',     required: true },
  { id: 'macos',     title: 'macOS permissions + power',   required: true },
  { id: 'residents', title: 'Resident agents for your repos', required: false },
  { id: 'verify',    title: 'Verify + start Mission Control', required: true },
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
      const env = ctx.secrets || {};
      const tiers = [env.SMTP_HOST && env.ALERT_EMAIL_TO && 'email', env.SMS_WEBHOOK_URL && 'sms', env.HEARTBEAT_URL && 'heartbeat'].filter(Boolean);
      return { ok: tiers.length > 0, detail: tiers.length ? `on: ${tiers.join(', ')}` : 'no alert channel (cmux notifications only)' };
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
