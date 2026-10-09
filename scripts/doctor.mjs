#!/usr/bin/env node
// zulu doctor — one redacted text file that describes this install, for a bug
// report. Written to data/doctor-<time>.txt (600) and NEVER uploaded: read it,
// then attach it to a beta-feedback issue yourself.
//
// Redacted: every value in data/secrets.env, emails, tokens/keys/JWTs, phone
// numbers, private + Tailscale IPs, your home path, user and host names. Logins
// are reported as yes/no only.
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, run, engineStatus, shellEnv, readStateSync, summarize } from '../src/setup.mjs';
import { parseEnv } from '../src/config.mjs';

export function redactor({ secrets = {}, home = os.homedir(), user = os.userInfo().username, host = os.hostname() } = {}) {
  const literal = [...Object.values(secrets).filter((v) => v && v.length >= 4), host, host.replace(/\.local$/, '')]
    .filter(Boolean).sort((a, b) => b.length - a.length)
    .map((v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
  const rules = [
    [/\b(?:sk-(?:ant-)?|gh[pousr]_|xox[abprs]-|shp(?:at|ss|ca|pa)_|AKIA)[A-Za-z0-9_-]{8,}/g, '<token>'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<jwt>'],
    [/\b(password|passwd|secret|api[_-]?key|token|key)(\s*[:=]\s*)\S+/gi, '$1$2<redacted>'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
    [/\+\d{10,15}\b/g, '<phone>'],
    [/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g, '<ip>'],
    [/\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/gi, '<uuid>'],
  ];
  return (text) => {
    let t = String(text);
    for (const re of literal) t = t.replace(re, '<secret>');
    for (const [re, to] of rules) t = t.replace(re, to);
    if (home) t = t.split(home).join('~');
    if (user && user.length > 2) t = t.replace(new RegExp(`\\b${user}\\b`, 'g'), '<user>');
    return t;
  };
}

const tail = async (f, n = 80) => (await readFile(f, 'utf8').catch(() => '(missing)')).split('\n').slice(-n).join('\n');

async function main() {
  const secrets = parseEnv(await readFile(path.join(ROOT, 'data', 'secrets.env'), 'utf8').catch(() => ''));
  const R = redactor({ secrets });
  const sec = [];
  const add = (title, body) => sec.push(`## ${title}\n${String(body).trim()}\n`);
  const ver = async (cmd, args = ['--version']) => ((await run(cmd, args, { timeout: 8000 })).out.split('\n')[0] || 'missing').trim();

  add('install', [
    `when: ${new Date().toISOString()}`,
    `version: ${(await run('git', ['-C', ROOT, 'describe', '--tags', '--always', '--dirty'])).out.trim()}`,
    `macOS: ${(await run('sw_vers', ['-productVersion'])).out.trim()} (${os.arch()})`,
    `node: ${process.version}`,
  ].join('\n'));
  add('tools', (await Promise.all([['claude'], ['codex'], ['cmux'], ['gh'], ['uv'], ['graphify'], ['brew'], ['docker']]
    .map(async ([c]) => `${c}: ${await ver(c)}`))).join('\n'));
  const e = await engineStatus();
  add('engines (logins yes/no only)', Object.entries(e).map(([n, s]) => `${n}: installed=${s.installed} loggedIn=${s.loggedIn}`).join('\n'));
  const models = JSON.parse(await readFile(path.join(ROOT, 'overlay', 'config', 'models.json'), 'utf8').catch(() => '{}'));
  add('engine choice', JSON.stringify(models.engine || '(not chosen)'));
  const s = summarize(readStateSync());
  add('setup', s ? s.steps.map((x) => `${x.status.padEnd(8)} ${x.title}`).join('\n') : '(no setup state — not installed with install.sh)');
  const env = await shellEnv();
  add('paths', `label prefix: ${env.prefix}\nvault: ${env.vault}`);
  add('bootstrap check', (await run(path.join(ROOT, 'scripts/bootstrap.sh'), ['check'], { timeout: 120000 })).out);
  const st = await run('curl', ['-s', '-m', '5', 'http://localhost:3210/api/status']);
  try {
    const j = JSON.parse(st.out);
    add('board', `HTTP 200 · ${j.counts.ok}/${j.counts.total} ok · agents ${j.counts.agents}\n` +
      j.jobs.filter((x) => x.status !== 'ok').map((x) => `${x.status.padEnd(8)} ${x.name} — ${x.detail}`).join('\n'));
  } catch { add('board', 'not answering on :3210'); }
  add('launchd (board)', (await run('launchctl', ['print', `gui/${process.getuid()}/${env.prefix}.master-console`])).out.split('\n')
    .filter((l) => /state =|last exit|pid =|program/.test(l)).join('\n') || 'not loaded');
  for (const f of ['server.log', 'server.err.log', 'demo.log']) add(`logs/${f} (last 80 lines)`, await tail(path.join(ROOT, 'logs', f)));

  const out = path.join(ROOT, 'data', `doctor-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`);
  await writeFile(out, R(`# zulu doctor\n\n${sec.join('\n')}`), { mode: 0o600 });
  console.log(`wrote ${out.replace(os.homedir(), '~')} (redacted; nothing was uploaded)`);
  console.log('read it before attaching it to an issue — remove anything you would rather not share');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e.message); process.exit(1); });
