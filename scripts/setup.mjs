#!/usr/bin/env node
// zulu setup — the guided half of the install: connect YOUR accounts and config.
//
//   zulu setup                 walk every step that isn't done yet (resumable)
//   zulu setup --status        the checklist, no questions
//   zulu setup --step <id>     (re)do one step: github engines owner watch alerts vault brain macos residents verify
//
// Every step has a live check (src/setup.mjs): a step that is already true is
// ticked without asking. Nothing here stores a credential — logins go through
// each tool's own flow (gh, claude, codex); alert keys go to data/secrets.env
// (600). Answers that shape the board go to overlay/config/local.json.
import { readFile, writeFile, mkdir, cp, readdir, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import { STEPS, ROOT, readState, writeState, markStep, summarize, checkStep, engineStatus, shellEnv, readJson, run } from '../src/setup.mjs';
import { parseSelection, scanLaunchAgents, scanDocker, scanCron, scanRepos } from '../src/setup-scan.mjs';
import { parseEnv } from '../src/config.mjs';

const HOME = process.env.HOME;
const OVERLAY = process.env.MC_OVERLAY || path.join(ROOT, 'overlay');
const LOCAL = path.join(OVERLAY, 'config', 'local.json');
const MODELS = path.join(OVERLAY, 'config', 'models.json');
const SECRETS = path.join(ROOT, 'data', 'secrets.env');
const tilde = (p) => String(p).replace(HOME, '~');

// ---- terminal I/O -------------------------------------------------------------------
// terminal: false keeps the tty in normal line mode — raw mode would drop typed-ahead input
const rl = readline.createInterface({ input: process.stdin, terminal: false });
// a line queue (not rl.question): answers typed ahead, or piped in by a test, are
// never lost. End of input ABORTS the wizard — it never falls through to defaults.
const lines = []; let waiting = null; let closed = false;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
const nextLine = async () => {
  const l = lines.length ? lines.shift() : closed ? null : await new Promise((r) => { waiting = r; });
  if (l === null) throw new Error('input ended — setup stopped (re-run zulu setup to continue)');
  return l;
};
const ask = async (q, def = '') => { process.stdout.write(`${q}${def ? ` [${def}]` : ''} `); return (await nextLine()).trim() || def; };
const yes = async (q, def = 'n') => /^y/i.test(await ask(`${q} (y/n)`, def));
const stty = (mode) => process.stdin.isTTY && spawnSync('stty', [mode], { stdio: ['inherit', 'ignore', 'ignore'] });
const askSecret = async (q) => {
  process.stdout.write(`${q} `);
  stty('-echo');                                   // typed characters are not shown
  try { return (await nextLine()).trim(); } finally { stty('echo'); process.stdout.write('\n'); }
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts }).status === 0;
const say = (tag, msg) => console.log(`${tag.padEnd(6)} ${msg}`);
const json = async (f, d = {}) => readJson(f) || d;
const save = async (f, doc) => { await mkdir(path.dirname(f), { recursive: true }); await writeFile(f, JSON.stringify(doc, null, 2) + '\n'); };

async function upsertSecrets(pairs) {
  const text = await readFile(SECRETS, 'utf8').catch(async () => readFile(path.join(ROOT, 'secrets.env.example'), 'utf8'));
  let lines = text.split('\n');
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined || v === '') continue;
    const i = lines.findIndex((l) => l.replace(/^export\s+/, '').startsWith(`${k}=`));
    const line = `${k}=${JSON.stringify(v)}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
  }
  await mkdir(path.dirname(SECRETS), { recursive: true });
  await writeFile(SECRETS, lines.join('\n'), { mode: 0o600 });
  await chmod(SECRETS, 0o600);
}

// ---- steps ----------------------------------------------------------------------------
const DO = {
  async github() {
    say('info', 'GitHub: used for the dead-man\'s switch, repo work and updates. Opens gh\'s own login.');
    sh('gh', ['auth', 'login']);
  },

  async engines() {
    const e = await engineStatus();
    for (const [n, s] of Object.entries(e)) say(s.loggedIn ? 'ok' : s.installed ? 'todo' : 'miss', `${n}: ${s.installed ? (s.loggedIn ? `logged in (${s.via})` : 'installed, not logged in') : 'not installed (./install.sh installs it)'}`);
    console.log('Mission Control (the master agent), workers and the scheduled triage can each run on Claude Code or Codex.');
    const pick = async (role, def) => { const a = (await ask(`  ${role} engine — claude or codex?`, def)).toLowerCase(); return a.startsWith('co') ? 'codex' : 'claude'; };
    const def = e.claude.loggedIn || !e.codex.loggedIn ? 'claude' : 'codex';
    const engine = { master: await pick('Mission Control', def), worker: await pick('Workers + residents', def), triage: await pick('Scheduled triage', def) };
    for (const n of new Set(Object.values(engine))) {
      if (e[n].loggedIn) continue;
      if (!e[n].installed) { say('warn', `${n} is not installed — run ./install.sh first, then zulu setup --step engines`); continue; }
      say('info', `logging in to ${n} with its own flow (subscription or API key — your choice there)`);
      if (n === 'claude') sh('claude', ['auth', 'login']); else sh('codex', ['login']);
    }
    const models = await json(MODELS, await json(path.join(ROOT, 'examples/config/models.json')));
    await save(MODELS, { ...models, engine });
    const st = (await readState()) || { steps: {}, answers: {} };
    st.answers = { ...(st.answers || {}), enginesChosen: true };
    await writeState(st);
  },

  async owner() {
    const local = await json(LOCAL);
    const name = await ask('Your name (shown as the approver on the board; agents say "needs <name>\'s approval")', local.owner?.name || '');
    if (!name) return;
    local.owner = { id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'owner', name };
    await save(LOCAL, local);
    for (const rel of ['POLICY.md', 'MISSION-CONTROL.md', 'config/TRIAGE.md']) {
      const f = path.join(OVERLAY, rel);
      const t = await readFile(f, 'utf8').catch(() => null);
      if (t && t.includes('<OWNER>')) { await writeFile(f, t.replaceAll('<OWNER>', name)); say('done', `filled your name into overlay/${rel}`); }
    }
    await restartBoard();
    say('info', `overlay/POLICY.md decides what agents may do without you (paid / outward / destructive always escalate).`);
    if (await yes('Open POLICY.md now to adjust it?')) sh('open', ['-t', path.join(OVERLAY, 'POLICY.md')]);
  },

  async watch() {
    const { prefix } = await shellEnv();
    const local = await json(LOCAL);
    const pickFrom = async (title, items, show) => {
      if (!items.length) { say('skip', `${title}: none found`); return []; }
      console.log(`\n${title}:`);
      items.forEach((x, i) => console.log(`  ${String(i + 1).padStart(2)}. ${show(x)}`));
      for (;;) { try { return parseSelection(await ask('  watch which? (e.g. 1,3-5 · all · none)', 'all'), items.length).map((i) => items[i]); } catch (e) { say('warn', e.message); } }
    };
    const jobs = await pickFrom('LaunchAgents in ~/Library/LaunchAgents', await scanLaunchAgents(prefix), (j) => `${j.label}`);
    const docker = await pickFrom('Docker containers', await scanDocker(), (c) => `${c.name}  (${c.status})`);
    const cron = await pickFrom('crontab lines', await scanCron(), (c) => `${c.schedule}  ${c.command.slice(0, 70)}`);
    const urls = (await ask('\nHTTP endpoints to check (comma-separated URLs, Enter for none)', '')).split(',').map((s) => s.trim()).filter(Boolean);
    local.domains = [{ id: 'mine', name: 'My Jobs', accent: '#00e5e5' }];
    local.jobs = jobs.map((j) => ({ label: j.label, name: j.name, domain: 'mine' }));
    local.docker = docker.map((c) => ({ name: c.name, display: `Docker: ${c.name}`, domain: 'mine' }));
    local.cron = cron.map((c) => ({ id: c.id, name: c.match, domain: 'mine', schedule: c.schedule, match: c.match, quietOk: true }));
    local.endpoints = urls.map((u, i) => ({ id: `ep${i + 1}`, name: u.replace(/^https?:\/\//, ''), url: u, everyPolls: 5 }));
    local.dropExamples = true;
    await save(LOCAL, local);
    say('done', `${jobs.length} LaunchAgent(s), ${docker.length} container(s), ${cron.length} cron line(s), ${urls.length} endpoint(s) → overlay/config/local.json`);
    say('info', 'cron cards are judged by crontab presence; add a `log` path in local.json to judge each run.');
    await restartBoard();
  },

  async alerts() {
    console.log('The board always notifies in cmux. These add escalation for when you are away. Enter skips any line.');
    const p = {};
    if (await yes('Email alerts (SMTP)?', 'y')) {
      p.SMTP_HOST = await ask('  SMTP host (e.g. smtp.gmail.com)'); p.SMTP_PORT = await ask('  SMTP port (587 = STARTTLS, 465 = TLS)', '587');
      p.SMTP_USER = await ask('  SMTP user'); p.SMTP_PASS = await askSecret('  SMTP password / app password (hidden):');
      p.ALERT_EMAIL_TO = await ask('  send alerts to (email)');
    }
    if (await yes('SMS alerts via a webhook you run?')) {
      p.SMS_WEBHOOK_URL = await ask('  webhook URL'); p.SMS_WEBHOOK_KEY = await askSecret('  webhook key (hidden):'); p.SMS_ALERT_TO = await ask('  phone number (E.164)');
    }
    if (await yes('Dead-man\'s switch (a heartbeat row + a GitHub Action that emails if the board goes silent)?')) {
      p.HEARTBEAT_URL = await ask('  heartbeat PATCH URL (PostgREST row)'); p.HEARTBEAT_KEY = await askSecret('  heartbeat key (hidden):');
      say('info', 'then: copy .github/workflows/deadman.example.yml into a repo of yours and run scripts/bootstrap.sh install --deadman (docs/INSTALL.md)');
    }
    await upsertSecrets(p);
    say('done', `saved to ${tilde(SECRETS)} (600) — the board re-reads it, no restart`);
  },

  async vault() {
    const env = await shellEnv();
    let vault = env.vault;
    if (existsSync(path.join(vault, '.obsidian')) || existsSync(path.join(vault, 'Home.md'))) {
      if (!existsSync(path.join(vault, '.scripts', 'vault-backup.sh'))) say('info', `a vault exists at ${tilde(vault)}; adding the .scripts/ automation to it`);
    } else {
      const ans = await ask('Path for your Obsidian vault (new, or an existing vault folder)', tilde(vault));
      vault = path.resolve(ans.replace(/^~/, HOME));
    }
    if (vault !== env.vault) await setZuluEnv('VAULT', vault);
    await mkdir(vault, { recursive: true });
    const owner = (await json(LOCAL)).owner?.name || 'Owner';
    // copy the template without overwriting anything that exists
    const walk = async (rel = '') => {
      for (const e of await readdir(path.join(ROOT, 'examples/vault', rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name); const dst = path.join(vault, r);
        if (e.isDirectory()) { await mkdir(dst, { recursive: true }); await walk(r); continue; }
        if (existsSync(dst)) continue;
        const t = await readFile(path.join(ROOT, 'examples/vault', r));
        await writeFile(dst, /\.(md|sh|tmpl)$/.test(e.name) ? String(t).replaceAll('<OWNER>', owner) : t, { mode: e.name.endsWith('.sh') ? 0o755 : 0o644 });
      }
    };
    await walk();
    for (const [tmpl, name] of [['vault-backup', 'obsidian-backup'], ['vault-staleness', 'obsidian-staleness']]) {
      sh(path.join(ROOT, 'scripts/render-tmpl.sh'), [path.join(vault, '.scripts/launchd', `${tmpl}.plist.tmpl`), path.join(vault, '.scripts', `${env.prefix}.${name}.plist`)], { env: { ...process.env, VAULT: vault } });
    }
    await cp(path.join(ROOT, 'examples/claude/skills/sync-obsidian'), path.join(vault, '.scripts/claude-skills/sync-obsidian'), { recursive: true, force: false, errorOnExist: false });
    await mkdir(path.join(vault, '.scripts/claude-global'), { recursive: true });
    const g = path.join(vault, '.scripts/claude-global/CLAUDE.md');
    if (!existsSync(g)) await writeFile(g, String(await readFile(path.join(ROOT, 'examples/claude/CLAUDE.global.md.tmpl'))).replaceAll('<OWNER>', owner).replaceAll('$HOME/<VAULT_NAME>', vault).replaceAll('<VAULT_NAME>', path.basename(vault)));
    if (!existsSync(path.join(vault, '.git'))) {
      sh('git', ['init', '-q', '-b', 'main'], { cwd: vault }); sh('git', ['add', '-A'], { cwd: vault });
      sh('git', ['commit', '-q', '-m', 'vault: initial structure (zulu setup)'], { cwd: vault });
    }
    say('done', `vault ready at ${tilde(vault)}`);
    if (!(await run('git', ['-C', vault, 'remote'])).out.trim() && await yes('Back the vault up to a NEW PRIVATE GitHub repo under your account?')) {
      const name = await ask('  repo name', path.basename(vault).toLowerCase().replace(/[^a-z0-9-]+/g, '-'));
      sh('gh', ['repo', 'create', name, '--private', '--source', vault, '--push']);
    }
    if (!existsSync('/Applications/Obsidian.app') && await yes('Install the Obsidian app (brew cask)?', 'y')) sh('brew', ['install', '--cask', 'obsidian']);
    // load ONLY the vault's two agents (backup every 30 min, staleness check) — not a full bootstrap
    for (const name of ['obsidian-backup', 'obsidian-staleness']) {
      const label = `${env.prefix}.${name}`;
      const dst = path.join(HOME, 'Library/LaunchAgents', `${label}.plist`);
      if (process.env.ZULU_NO_LAUNCHD) { say('skip', `${label} (ZULU_NO_LAUNCHD)`); continue; }
      if ((await run('launchctl', ['print', `gui/${process.getuid()}/${label}`])).ok) { say('skip', `${label} loaded`); continue; }
      await mkdir(path.dirname(dst), { recursive: true });
      await cp(path.join(vault, '.scripts', `${label}.plist`), dst);
      say(sh('launchctl', ['bootstrap', `gui/${process.getuid()}`, dst]) ? 'done' : 'FAIL', `load ${label}`);
    }
    if (existsSync('/Applications/Obsidian.app') && await yes('Open the vault in Obsidian now?', 'y')) sh('open', ['-a', 'Obsidian', vault]);
  },

  async brain() {
    sh(path.join(ROOT, 'install.sh'), ['--brain']);
    const engines = Object.values((await json(MODELS)).engine || {});
    if (engines.includes('codex')) {
      const agents = path.join(HOME, '.codex', 'AGENTS.md');
      if (!existsSync(agents)) {
        const { vault } = await shellEnv(); const owner = (await json(LOCAL)).owner?.name || 'the owner';
        await mkdir(path.dirname(agents), { recursive: true });
        await writeFile(agents, String(await readFile(path.join(ROOT, 'examples/codex/AGENTS.md.tmpl'))).replaceAll('<OWNER>', owner).replaceAll('$HOME/<VAULT_NAME>', vault).replaceAll('<VAULT_NAME>', path.basename(vault)));
        say('done', 'wrote ~/.codex/AGENTS.md (the same rules Claude gets from ~/.claude/CLAUDE.md)');
      }
      const cfg = await readFile(path.join(HOME, '.codex', 'config.toml'), 'utf8').catch(() => '');
      if (!/\[mcp_servers\.graphify\]/.test(cfg) && existsSync(path.join(HOME, '.local/bin/graphify-mcp'))) {
        sh('codex', ['mcp', 'add', 'graphify', '--', path.join(HOME, '.local/bin/graphify-mcp'), path.join(HOME, '.graphify/global-graph.json')]);
      }
    }
    if ((await run('/bin/sh', ['-c', 'command -v graphify'])).ok) sh('graphify', ['update', '.']);
  },

  async macos() {
    const panes = [
      ['Full Disk Access → turn ON for cmux (agents read/write across your folders)', 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'],
      ['Login Items → add cmux (agents come back after a reboot)', 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'],
      ['Users & Groups → Automatically log in (optional: unattended reboots)', 'x-apple.systempreferences:com.apple.Users-Groups-Settings.extension'],
    ];
    for (const [what, url] of panes) { console.log(`\n• ${what}`); if (await yes('  open that settings pane now?', 'y')) sh('open', [url]); }
    if (!/autorestart\s+1/.test((await run('pmset', ['-g'])).out) && await yes('\nRestart automatically after a power failure (sudo pmset autorestart 1)?', 'y')) sh('sudo', ['pmset', 'autorestart', '1']);
    if (!existsSync('/Applications/Tailscale.app') && await yes('Phone access to the board over Tailscale (opens the App Store page)?')) sh('open', ['macappstore://apps.apple.com/app/tailscale/id1475387142']);
    if (await yes('\nDone with the permissions above?', 'y')) { const st = await readState(); st.answers = { ...(st.answers || {}), macosConfirmed: true }; await writeState(st); }
  },

  async residents() {
    console.log('A resident is a long-lived agent that owns one repo (keeps a .claude/RESIDENT-STATE.md, survives compaction).');
    const repos = await scanRepos();
    if (!repos.length) return say('skip', 'no git repos found under ~');
    repos.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${tilde(r)}`));
    let chosen = [];
    for (;;) { try { chosen = parseSelection(await ask('  start residents for which? (agents use your Claude/Codex plan)', 'none'), repos.length).map((i) => repos[i]); break; } catch (e) { say('warn', e.message); } }
    for (const repo of chosen) sh(path.join(ROOT, 'scripts/resident-launch.sh'), [repo, path.basename(repo)]);
  },

  async verify() {
    sh(path.join(ROOT, 'scripts/bootstrap.sh'), ['check']);
    const st = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://localhost:3210/api/status']);
    say(st.out === '200' ? 'ok' : 'warn', `board on :3210 → HTTP ${st.out || 'none'}`);
    if (await yes('Start Mission Control in cmux now?', 'y')) sh(path.join(ROOT, 'install.sh'), ['mission-control']);
  },
};

/** The board reads local.json at start: restart its LaunchAgent so new cards appear. */
async function restartBoard() {
  const { prefix } = await shellEnv();
  if (process.env.ZULU_NO_LAUNCHD) return say('skip', 'board restart (ZULU_NO_LAUNCHD)');
  const r = await run('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${prefix}.master-console`]);
  say(r.ok ? 'done' : 'note', r.ok ? 'board restarted — the new cards are on :3210' : 'board LaunchAgent not loaded yet (./install.sh loads it); it will read your answers when it starts');
}

async function setZuluEnv(key, value) {
  const f = path.join(OVERLAY, 'config', 'zulu.env');
  const t = await readFile(f, 'utf8').catch(() => '');
  const line = `${key}="${value}"`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, re.test(t) ? t.replace(re, line) : `${t}${t.endsWith('\n') || !t ? '' : '\n'}${line}\n`);
}

async function status(state, { record = true } = {}) {
  const secrets = parseEnv(await readFile(SECRETS, 'utf8').catch(() => ''));
  console.log('\nZulu setup');
  for (const s of STEPS) {
    const c = await checkStep(s.id, { state, secrets });
    const st = state.steps?.[s.id]?.status;
    // a step that is already true counts as done (the board card reads the state file)
    if (record && c.ok && st !== 'done') state = await markStep(s.id, 'done', c.detail);
    const mark = c.ok || st === 'done' ? '✔' : st === 'skipped' ? '–' : '○';
    console.log(`  ${mark} ${s.title.padEnd(34)} ${c.detail || (st === 'skipped' ? 'skipped' : '')}${s.required ? '' : '  (optional)'}`);
  }
  const sum = summarize(state);
  console.log(`\n${sum.done}/${sum.total} handled${sum.next ? ` — next: ${sum.next}` : ''}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes('--step') ? args[args.indexOf('--step') + 1] : null;
  if (only && !DO[only]) { console.error(`unknown step "${only}" (${STEPS.map((s) => s.id).join(' ')})`); process.exit(2); }
  const existing = await readState();
  let state = existing || { installedAt: null, steps: {}, answers: {} };
  // --status only reads (and records live passes) when this install already has state
  if (args.includes('--status')) { await status(state, { record: Boolean(existing) }); return rl.close(); }
  if (!existing) await writeState(state);
  if (!process.stdin.isTTY) { console.error('zulu setup is interactive — run it in a terminal (zulu setup --status works anywhere)'); process.exit(2); }
  await status(state);
  for (const s of STEPS) {
    if (only && s.id !== only) continue;
    state = await readState();
    const secrets = parseEnv(await readFile(SECRETS, 'utf8').catch(() => ''));
    let c = await checkStep(s.id, { state, secrets });
    if (!only && (c.ok || state.steps?.[s.id]?.status)) { if (c.ok && state.steps?.[s.id]?.status !== 'done') await markStep(s.id, 'done', c.detail); continue; }
    console.log(`\n━━ ${s.title}${s.required ? '' : ' (optional)'} ━━  ${c.detail || ''}`);
    const a = (await ask('Enter = set it up · s = skip for now · q = quit', '')).toLowerCase();
    if (a === 'q') break;
    if (a === 's') { await markStep(s.id, 'skipped'); say('skip', `${s.title} — come back with: zulu setup --step ${s.id}`); continue; }
    try { await DO[s.id](); } catch (e) { if (/^input ended/.test(e.message)) throw e; say('FAIL', `${s.title}: ${e.message}`); }
    c = await checkStep(s.id, { state: await readState(), secrets: parseEnv(await readFile(SECRETS, 'utf8').catch(() => '')) });
    // residents + verify are actions, not states: running them completes them;
    // alerts with no channel chosen counts as a deliberate skip
    const ran = ['residents', 'verify'].includes(s.id);
    if (c.ok || ran) { await markStep(s.id, 'done', c.detail); say('done', `${s.title}${c.detail ? `: ${c.detail}` : ''}`); }
    else if (s.id === 'alerts') { await markStep(s.id, 'skipped', c.detail); say('skip', `${s.title}: ${c.detail}`); }
    else say('todo', `${s.title} is not complete yet (${c.detail}) — re-run: zulu setup --step ${s.id}`);
  }
  await status(await readState());
  rl.close();
}

main().catch((e) => { console.error(e.message); rl.close(); process.exit(1); });
