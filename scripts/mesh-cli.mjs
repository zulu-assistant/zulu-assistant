#!/usr/bin/env node
// Agent Mesh CLI — used by scripts/task.sh, scripts/agent-send.sh and the
// spawn/launch scripts. Works from any shell (Claude, Codex, cron). Every
// ledger/message write goes through the board API (single writer); only
// register/deregister/kick touch files/cmux directly so spawns work even while
// the board restarts.
//
// Identity: --as <name> (`me`/`self` = work it out), else $MESH_AGENT, else the
// directory entry for this terminal's $CMUX_WORKSPACE_ID. The board resolves it
// exactly and refuses closed agents.
import { readFile } from 'node:fs/promises';
import {
  mutateAgents, slugTitle, kickSession, listWorkspaces, liveDirectory, resolveTarget, resolveNewWorkspace, acrossWindows,
  nameDrift, ensureSessionName, cmux, listGroups, writeJsonAtomic, readSessionMap,
} from '../src/mesh.mjs';
import { applyChrome, groupPlan, groupRepairPlan, isDisposablePlaceholder, domainTable } from '../src/chrome.mjs';
import { resolve as resolveConfig } from '../src/config.mjs';
import { CHECKLIST } from '../src/tasks.mjs';

const CHECK_WORDS = {
  docs_updated: 'docs updated', report_written: 'the report',
  // when SETTINGS.brain is on the board VERIFIES these two at close (src/brain.mjs)
  vault_synced: 'vault synced (dated Update + last-synced bump per Vault Guide; close with --vault "<note>" — the board checks the note was edited during the task, or --no-vault "<reason>")',
  graphify_updated: '`graphify update .` in the repo (the board checks its graph is not older than its last commit, or --no-graph "<reason>")',
};
export const checklistText = (items) => items.map((k) => CHECK_WORDS[k] || k.replace(/_/g, ' ')).join(' + ');
import { fileURLToPath } from 'node:url';


const BOARD = process.env.MESH_BOARD || 'http://127.0.0.1:3210';
const argv = process.argv.slice(2);

function parse(args) {
  const pos = []; const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[k] = true;
      else { flags[k] = flags[k] === undefined ? next : [].concat(flags[k], next); i++; }
    } else pos.push(a);
  }
  return { pos, flags };
}

const die = (msg, code = 1) => { console.error(`mesh: ${msg}`); process.exit(code); };

async function api(method, p, body, extraHeaders = {}) {
  let r;
  try {
    r = await fetch(BOARD + p, {
      method, headers: { 'content-type': 'application/json', ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000),
    });
  } catch (e) { die(`board unreachable at ${BOARD} (${e.message}) — is the board LaunchAgent (<prefix>.master-console) running?`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(`${j.msg || r.status}${j.missing ? ` [missing: ${j.missing.join(', ')}]` : ''}${j.candidates ? `\n  candidates: ${j.candidates.join('\n              ')}` : ''}`, 2);
  return j;
}

async function whoami(flags) {
  // `--as me|self` (or a bare --as) means "work it out", not an agent called "me"
  const as = typeof flags.as === 'string' ? flags.as.trim() : '';
  if (as && !['me', 'self'].includes(as.toLowerCase())) return as;
  if (process.env.MESH_AGENT) return process.env.MESH_AGENT;
  const ws = process.env.CMUX_WORKSPACE_ID;
  if (ws) {
    const { agents } = await api('GET', '/api/agents');
    const me = agents.find((a) => a.workspaceId && a.workspaceId.toUpperCase() === ws.toUpperCase());
    if (me) return me.name;
  }
  die('cannot tell who you are — pass --as <your-agent-name> or export MESH_AGENT');
}

const fmtTask = (t) => {
  const bo = t.blocked_on?.length ? ` blocked_on=${t.blocked_on.join(',')}` : '';
  return `#${t.id} [${t.status}] ${t.title}  (owner ${t.owner || '-'}, from ${t.requester}${bo})`;
};

const HELP = `usage:
  task.sh create "<title>" --owner <agent> [--body "<one paragraph>"] [--priority low|normal|high|urgent]
                [--handoff <path>] [--vault <note>] [--repo <path>] [--pr <url>] [--graphify "<query>"] [--as <your-name>]
  task.sh claim|start|unblock <id> ["note"]
  task.sh comment <id> "<text>" [--wake]
  task.sh block <id> --on <ids|owner> ["why"]
  task.sh plan <id> "<plan>"   (plan-first requests: posts the plan, then the task awaits the owner's review on the board)
  task.sh chat-file <id> <data/handoffs/…file> ["comment"] [--title "<t>"]   (chat-filed tasks: post your file in the thread)
  task.sh approve-request <id> --policy "<POLICY.md ESCALATE line>" ["what exactly"] [--program]
                                     --program: ask for a PROGRAM GO — once approved, the task's standing gate
                                     classes (merges into private repos, local launchd loads) run without a tap
  task.sh revoke-go <id> ["why"]     end the task's program go (it also ends when the task closes)
  task.sh approved-in-pane <id> "<what the owner said, when>" [--decline]
                                     record an answer the owner gave in your pane
  task.sh check <id> <item>...   (items: SETTINGS.ledger.checklist — mesh-cli.mjs checklist)
  task.sh close <id> --handoff <report path> [--pr <url>] [--vault <note>] [--repo <path>] [--checklist all|a,b,..] ["summary"]
                [--no-vault "<reason>"] [--no-graph "<reason>"]   (when the board verifies vault_synced / graphify_updated)
                [--no-gates "<reason>"]   (guardrails: waive gates_resolved)
  task.sh focus <id>      (guardrails: the task your gated commands' receipts land on; claim/start set it
                          only when you haven't set one yourself on a live task)
  task.sh gate <id> <gate> approve|decline ["reason"]
                          OWNER ONLY, from the owner's own shell (e.g. a ! line): decide a gate with the
                          board's decision token. An agent running this is itself gated (class self).
  task.sh audit <id> [--json]   (guardrails: every gate request, decision and run on the task)
  task.sh gate-approved <id> <gate> "<what the owner said, where>" [--decline]
                                     mission-control only: record a gate answer the owner gave in a pane
  task.sh assign <id> <agent> | cancel <id> ["why"] | reopen <id>
  task.sh set-requester <id> <agent> "<why>"   (mission-control only: fix a misattributed requester)
  task.sh list [--owner <agent>] [--status open,blocked,..|live] | show <id> | mine
  agent-send.sh <name|title> "<message>" [--task <id>] [--wake] [--as <your-name>]
  mesh agents | whoami | slug "<title>" | outbox [drop <agent>] | sync-names [--apply] [--only <agent>]
  mesh sync-colors [--apply] | sync-groups [--apply] | close-placeholders [--apply]  (owner only)`;

const links = (f) => {
  const l = {};
  for (const [k, key] of [['handoff', 'handoff'], ['vault', 'vault'], ['repo', 'repo'], ['pr', 'pr'], ['graphify', 'graphify_query']]) if (typeof f[k] === 'string') l[key] = f[k];
  return l;
};

async function task(sub, pos, flags) {
  const id = pos[0];
  const note = (i) => pos[i] || (typeof flags.text === 'string' ? flags.text : undefined);
  const patch = async (body) => {
    const r = await api('PATCH', `/api/tasks/${id}`, { actor: await whoami(flags), ...body });
    console.log(fmtTask(r.task));
    for (const d of r.deliveries || []) console.log(`  → ${d.to || ''} ${d.delivered ? 'delivered' : d.queued ? `queued (${d.reason})` : d.msg || ''}`);
  };
  switch (sub) {
    case 'create': {
      if (!pos[0]) die('create needs a title');
      const r = await api('POST', '/api/tasks', {
        title: pos[0], requester: await whoami(flags), owner: flags.owner || null,
        body: flags.body, priority: flags.priority, links: links(flags),
      });
      console.log(fmtTask(r.task));
      for (const d of r.deliveries || []) console.log(`  → ${d.to} ${d.delivered ? 'woken' : d.queued ? `wake queued (${d.reason})` : d.msg || ''}`);
      return;
    }
    case 'claim': case 'start': case 'unblock': case 'cancel': case 'reopen':
      return patch({ op: sub, text: note(1) });
    case 'comment':
      return patch({ op: 'comment', text: note(1), wake: Boolean(flags.wake) });
    case 'block':
      return patch({ op: 'block', blocked_on: String(flags.on || ''), text: note(1) });
    case 'plan':
      // plan-first requests (a planFirst person's chat ask): post the plan → awaits the owner's review on the board
      return patch({ op: 'plan', text: note(1) });
    case 'chat-file': {
      // a file you made for the requester (e.g. a calendar .ics) → posted into the request's chat thread
      if (!pos[1]) die('chat-file needs a path under data/handoffs/: task.sh chat-file <id> <path> ["comment"] [--title "<title>"]');
      const r = await api('POST', `/api/tasks/${id}/chat-file`, { actor: await whoami(flags), path: pos[1], text: pos[2], title: typeof flags.title === 'string' ? flags.title : undefined });
      return console.log(`#${id}: ${r.queued} queued for the chat thread (the intake posts it within ~10 s)`);
    }
    case 'approve-request':
      return patch({ op: 'request_approval', policy_item: flags.policy, text: note(1), ...(flags.program ? { kind: 'program' } : {}) });
    case 'revoke-go':
      return patch({ op: 'revoke_go', text: note(1) });
    case 'approved-in-pane':
      // `--decline "<text>"` parses the text as the flag's value — accept it either way
      return patch({ op: 'record_decision', decision: flags.decline ? 'decline' : 'approve',
        text: note(1) ?? (typeof flags.decline === 'string' ? flags.decline : undefined) });
    case 'check':
      return patch({ op: 'checklist', checklist: Object.fromEntries(pos.slice(1).map((k) => [k, true])) });
    case 'close': {
      // 'all' is expanded by the server against the configured checklist
      const items = typeof flags.checklist === 'string' && flags.checklist !== 'all' ? flags.checklist.split(',') : [];
      const checklist = flags.checklist === 'all' ? 'all' : Object.fromEntries(items.map((k) => [k.trim(), true]));
      // --no-vault / --no-graph "<reason>": waive the verified brain items (kept on the task)
      const waive = {};
      if (typeof flags['no-vault'] === 'string') waive.vault_synced = flags['no-vault'];
      if (typeof flags['no-graph'] === 'string') waive.graphify_updated = flags['no-graph'];
      if (typeof flags['no-gates'] === 'string') waive.gates_resolved = flags['no-gates'];
      if (flags['no-vault'] === true || flags['no-graph'] === true || flags['no-gates'] === true) die('--no-vault / --no-graph / --no-gates need a reason: --no-vault "<why no vault note>"');
      return patch({ op: 'close', checklist, links: links(flags), text: note(1), ...(Object.keys(waive).length ? { waive } : {}) });
    }
    case 'focus': {
      const r = await api('POST', '/api/gates/focus', { actor: await whoami(flags), task: Number(id) });
      return console.log(`${r.agent}: gated commands now land on #${r.focus}`);
    }
    case 'audit': {
      const r = await api('GET', `/api/tasks/${id}/audit`);
      if (flags.json) return console.log(JSON.stringify(r, null, 2));
      if (!r.rows.length) return console.log(`#${id}: no gates`);
      for (const x of r.rows) console.log(`${String(x.at).replace('T', ' ').slice(0, 19)}  ${x.gate.padEnd(4)} ${String(x.event).padEnd(12)} ${String(x.cls).padEnd(9)} ${x.actor}${x.via ? ` (${x.via})` : ''}\n      ${x.command}  [${x.cwd}]${x.reason ? `\n      reason: ${x.reason}` : ''}`);
      return;
    }
    case 'gate': {
      // the owner's terminal decision: same token, same rules as the board's RUN ONCE / DECLINE.
      // No actor is sent — a request carrying an agent identity is refused (condition H).
      const [gate, decision] = [pos[1], pos[2]];
      if (!gate || !['approve', 'decline'].includes(decision)) die('usage: task.sh gate <task> <gate> approve|decline ["reason"]');
      const tokenFile = new URL('../data/mesh-decision-token', import.meta.url);
      const token = (await readFile(tokenFile, 'utf8').catch(() => '')).trim();
      if (!token) die('no decision token in data/mesh-decision-token (is this the board\'s checkout, and has the board run once?)');
      const r = await api('PATCH', `/api/tasks/${id}`, { op: 'gate_decide', gate, decision, ...(pos[3] ? { reason: pos[3] } : {}) },
        { 'x-mesh-decision': token, 'x-mesh-via': 'cli' });
      const g = (r.task.gates || []).find((x) => x.id === gate);
      return console.log(`#${id} ${gate}: ${g?.status || decision}${g?.expires_at && decision === 'approve' ? ` (runs once, by ${String(g.expires_at).slice(11, 16)}Z)` : ''}`);
    }
    case 'gate-approved':
      if (!pos[1]) die('gate-approved needs the gate id: task.sh gate-approved <task> <gate> "<what the owner said>" [--decline]');
      return patch({ op: 'gate_record', gate: pos[1], decision: flags.decline ? 'decline' : 'approve',
        text: note(2) ?? (typeof flags.decline === 'string' ? flags.decline : undefined) });
    case 'assign':
      return patch({ op: 'assign', owner: pos[1], text: note(2) });
    case 'set-requester':   // mission-control only: repair a misattributed task
      return patch({ op: 'set_requester', requester: pos[1], text: note(2) });
    case 'list': case 'mine': {
      const q = new URLSearchParams();
      const owner = sub === 'mine' ? await whoami(flags) : flags.owner;
      if (owner) q.set('owner', owner);
      q.set('status', flags.status || 'live');
      const { tasks } = await api('GET', `/api/tasks?${q}`);
      console.log(tasks.length ? tasks.map(fmtTask).join('\n') : '(no tasks)');
      return;
    }
    case 'show': {
      const t = await api('GET', `/api/tasks/${id}`);
      console.log(fmtTask(t));
      console.log(`  checklist: ${Object.entries(t.checklist).map(([k, v]) => `${v ? '✔' : '✗'} ${k}`).join('  ')}`);
      if (Object.keys(t.links).length) console.log(`  links: ${JSON.stringify(t.links)}`);
      if (t.approval) console.log(`  approval: ${JSON.stringify(t.approval)}`);
      for (const c of t.comments.slice(-10)) console.log(`  ${c.at.slice(5, 16)} ${c.who}: ${c.text}`);
      return;
    }
    default: die(HELP);
  }
}

async function main() {
  const [cmd, sub, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help') return console.log(HELP);

  if (cmd === 'task') { const { pos, flags } = parse(rest); return task(sub, pos, flags); }

  if (cmd === 'send') {
    const { pos, flags } = parse([sub, ...rest].filter((x) => x !== undefined));
    const [to, text] = pos;
    if (!to || !text) die('usage: agent-send.sh <name|title> "<message>" [--task <id>] [--wake]');
    const r = await api('POST', '/api/mesh/send', { to, text, from: await whoami(flags), task: flags.task, wake: Boolean(flags.wake) });
    console.log(r.delivered ? `delivered to ${r.to}` : r.queued ? `queued for ${r.to}: ${r.reason}` : (r.msg || JSON.stringify(r)));
    return;
  }

  if (cmd === 'agents') {
    const { agents, outbox } = await api('GET', '/api/agents');
    for (const a of agents.filter((x) => x.status !== 'closed')) {
      const st = a.live ? a.live.status : a.vendor === 'codex' ? 'codex' : a.workspaceId ? 'no session' : a.kind;
      const drift = a.live && !a.live.nameOk ? `  (session name "${a.live.liveName}" — drift)` : '';
      console.log(`${a.name.padEnd(30)} ${String(st).padEnd(10)} ${(a.kind || '').padEnd(15)} ${(a.owns || [])[0] || (a.needsOwnership ? '— needs ownership —' : '')}${drift}`);
    }
    if (outbox.length) console.log(`\noutbox: ${outbox.length} queued (${outbox.map((m) => m.to).join(', ')})`);
    return;
  }

  if (cmd === 'outbox') {          // mesh outbox            → list queued messages
    const { outbox } = await api('GET', '/api/agents');   // mesh outbox drop <agent> → cancel them
    if (sub === 'drop') { const r = await api('POST', '/api/mesh/outbox/drop', { to: rest[0] }); return console.log(`dropped ${r.dropped}`); }
    return console.log(outbox.length ? outbox.map((m) => `${m.to}: ${m.line} — ${m.lastReason || ''}`).join('\n') : '(outbox empty)');
  }

  if (cmd === 'whoami') { const { flags } = parse([sub, ...rest].filter(Boolean)); return console.log(await whoami(flags)); }
  if (cmd === 'slug') return console.log(slugTitle([sub, ...rest].join(' ')));
  // the configured close checklist in words (agent prompts render it); --keys = raw item names
  if (cmd === 'checklist') return console.log(sub === '--keys' ? CHECKLIST.join(' ') : checklistText(CHECKLIST));

  // ---- used by agent-spawn.sh / resident-launch.sh / agent-close.sh ----
  if (cmd === 'register') {
    const { flags } = parse([sub, ...rest].filter(Boolean));
    if (!flags.workspace || !flags.title) die('register needs --workspace <uuid> --title <title>');
    await mutateAgents((doc) => {
      const i = doc.agents.findIndex((a) => a.workspaceId === flags.workspace);
      const entry = {
        ...(i >= 0 ? doc.agents[i] : {}),
        name: slugTitle(flags.title), title: flags.title, workspaceId: flags.workspace,
        vendor: flags.vendor || 'claude', kind: flags.kind || 'worker',
        repo: flags.repo || null, cwd: flags.repo || null,
        owns: flags.owns ? [].concat(flags.owns) : (i >= 0 ? doc.agents[i].owns : []),
        escalate_to: 'mission-control', status: 'active', added_at: new Date().toISOString(),
      };
      delete entry.needsOwnership;
      if (!entry.owns?.length) entry.needsOwnership = true;
      if (i >= 0) doc.agents[i] = entry; else doc.agents.push(entry);
    });
    return console.log(`registered ${slugTitle(flags.title)} (${flags.workspace})`);
  }

  if (cmd === 'deregister') {
    const { pos } = parse([sub, ...rest].filter(Boolean));
    let hit = null;
    await mutateAgents((doc) => {
      const dir = doc.agents;
      const r = resolveTarget(pos[0], dir.map((a) => ({ ...a })));
      if (!r.agent) die(r.error);
      hit = dir.find((a) => a.workspaceId ? a.workspaceId === r.agent.workspaceId : a.name === r.agent.name);
      hit.status = 'closed';
      hit.closed_at = new Date().toISOString();
    });
    return console.log(`deregistered ${hit.name} (kept as closed)`);
  }

  if (cmd === 'resolve') {
    const dir = await liveDirectory();
    const r = resolveTarget([sub, ...rest].join(' '), dir);
    if (!r.agent) die(`${r.error}${r.candidates ? `\n  ${r.candidates.join('\n  ')}` : ''}`);
    return console.log(JSON.stringify({ name: r.agent.name, workspaceId: r.agent.workspaceId, vendor: r.agent.vendor, kind: r.agent.kind, status: r.agent.status }));
  }

  // session name ⇄ workspace title. Dry-run unless --apply; --only <name> limits
  // it to one agent. Types `/rename` only into idle panes (no dialog, no draft).
  if (cmd === 'sync-names') {
    const { flags } = parse([sub, ...rest].filter(Boolean));
    let drift = nameDrift(await liveDirectory());
    if (flags.only) drift = drift.filter((a) => a.name === flags.only || a.live?.liveName === flags.only);
    if (!drift.length) return console.log('no name drift');
    for (const a of drift) {
      if (!flags.apply) { console.log(`would /rename ${a.live.liveName} → ${a.name}`); continue; }
      const r = await ensureSessionName(a);
      console.log(r.ok ? `renamed ${r.from} → ${r.to}` : `skipped ${a.name}: ${r.skipped || r.reason}`);
    }
    return;
  }

  // cmux chrome (Tier 2). Dry-run unless --apply.
  if (cmd === 'sync-colors') {
    const { flags } = parse([sub, ...rest].filter(Boolean));
    const cfg = JSON.parse(await readFile(resolveConfig('config/mesh.json'), 'utf8'));
    const r = await applyChrome(await liveDirectory(), { cfg, apply: Boolean(flags.apply), max: Number(flags.max) || 100 });
    if (r.skipped) die(r.skipped);
    for (const a of r.actions) console.log(`${flags.apply ? (r.applied.includes(a) ? 'applied' : 'pending') : 'would'} ${a.action} ${a.name}: ${a.value}`);
    for (const m of r.manual) console.log(`hand-set, left alone: ${m.name} ${m.field} = ${m.value}`);
    if (!r.actions.length && !r.manual.length) console.log('colors + descriptions in sync');
    return;
  }

  // Domain groups: one collapsible sidebar group per domain (≥2 members).
  // Repairs existing groups in place; creates only when a group is missing
  // (cmux 0.64.25 always generates a placeholder anchor on create — it is
  // removed from the group, remembered, and listed for closing).
  // Reversible: `cmux workspace-group ungroup <group>` keeps every member.
  if (cmd === 'sync-groups') {
    const { flags } = parse([sub, ...rest].filter(Boolean));
    const cfg = JSON.parse(await readFile(resolveConfig('config/mesh.json'), 'utf8'));
    const { colors, icons } = domainTable(cfg);
    const [dir, workspaces, groups] = await Promise.all([liveDirectory(), listWorkspaces(), listGroups()]);
    if (!groups || !workspaces.length) die('cmux socket not answering');
    const plan = groupPlan(dir, cfg);
    const { steps, creates, placeholders } = groupRepairPlan(plan, groups, workspaces, { colors, icons });
    if (!steps.length && !creates.length) return console.log('groups in sync (0 changes)');
    if (!flags.apply) {
      for (const c of creates) console.log(`would create ${c.group} (⚠ cmux will generate 1 placeholder workspace; it is removed from the group and listed for close-placeholders)`);
      for (const st of steps) console.log(`would run: cmux ${st.args.join(' ')}   [${st.group}]`);
      return;
    }
    const newPlaceholders = [...placeholders];
    const refFor = new Map();
    for (const c of creates) {
      const r = await cmux(c.args);
      if (r.err) { console.log(`FAILED create ${c.group}: ${r.err}`); continue; }
      const g = ((await listGroups())?.groups || []).find((x) => x.idempotency_key === c.args[c.args.indexOf('--idempotency-key') + 1]);
      if (!g) { console.log(`FAILED create ${c.group}: group not found after create`); continue; }
      const gen = (await listWorkspaces()).find((w) => w.ref === g.anchor_workspace_ref)?.id;
      refFor.set(c.group, { ref: g.ref, generated: g.anchor_workspace_is_generated ? gen : null });
      if (g.anchor_workspace_is_generated && gen) newPlaceholders.push(gen);
    }
    for (const st of steps) {
      const created = refFor.get(st.group);
      const args = st.args.map((a) => (a === '<ref>' ? created?.ref : a === '<generated>' ? created?.generated : a));
      if (args.some((a) => a == null)) continue;            // create failed or no placeholder to remove
      const r = await cmux(args);
      console.log(`${r.err ? 'FAILED' : 'ok'}: cmux ${args.join(' ')}${r.err ? ` — ${r.err}` : ''}`);
    }
    if (newPlaceholders.length) {
      const file = new URL('../data/mesh-placeholder-workspaces.json', import.meta.url);
      const known = JSON.parse(await readFile(file, 'utf8').catch(() => '[]'));
      await writeJsonAtomic(fileURLToPath(file), [...new Set([...known, ...newPlaceholders])]);
      console.log(`placeholder workspaces (empty, cmux-generated; ignored by the mesh): ${newPlaceholders.join(', ')}`);
      console.log('Owner: close them in the sidebar, or run `node scripts/mesh-cli.mjs close-placeholders --apply`.');
    }
    return;
  }

  // OWNER ONLY (Mission Control/agents must not close workspaces): close the
  // empty cmux-generated placeholder workspaces left by group creation. Refuses
  // anything not remembered as generated, grouped, or ever used.
  if (cmd === 'close-placeholders') {
    const { flags } = parse([sub, ...rest].filter(Boolean));
    const known = new Set(JSON.parse(await readFile(new URL('../data/mesh-placeholder-workspaces.json', import.meta.url), 'utf8').catch(() => '[]')));
    const r = await acrossWindows(cmux, ['workspace', 'list', '--json']);
    if (r.err) die(r.err);
    const rows = JSON.parse(r.out).workspaces || [];
    const idByRef = new Map(rows.map((w) => [w.ref, w.id]));
    const groupedIds = new Set(((await listGroups())?.groups || []).flatMap((g) => (g.member_workspace_refs || []).map((x) => idByRef.get(x))));
    const sessionWorkspaces = new Set(Object.keys((await readSessionMap()).activeSessionsByWorkspace || {}));
    const ok = rows.filter((w) => isDisposablePlaceholder(w, { knownPlaceholders: known, groupedIds, sessionWorkspaces }));
    const refused = rows.filter((w) => known.has(w.id) && !ok.includes(w));
    for (const w of refused) console.log(`refusing ${w.ref} "${w.title}": grouped, has a session, or has input`);
    if (!ok.length) return console.log('no disposable placeholders');
    for (const w of ok) {
      if (!flags.apply) { console.log(`would close ${w.ref} "${w.title}" (${w.id})`); continue; }
      const c = await cmux(['close-workspace', '--workspace', w.id]);
      console.log(`${c.err ? 'FAILED' : 'closed'} ${w.ref} "${w.title}"${c.err ? ` — ${c.err}` : ''}`);
    }
    return;
  }

  if (cmd === 'workspace-id') {    // "OK workspace:36 (UUID)" or a bare ref → its UUID
    const { flags } = parse(rest);
    const out = String(sub || '');
    const ref = (out.match(/workspace:\d+/) || [])[0] || null;
    const r = await resolveNewWorkspace({ out, ref, title: typeof flags.title === 'string' ? flags.title : null });
    if (!r.id) die(`no ${ref || out}${flags.title ? ` (or workspace titled "${flags.title}")` : ''}`);
    if (!/output/.test(r.via)) console.error(`mesh: ${ref} resolved via ${r.via}`);
    return console.log(r.id);
  }

  if (cmd === 'kick') {
    const { flags } = parse([sub, ...rest].filter(Boolean));
    if (!flags.workspace || !flags.file) die('kick needs --workspace <uuid> --file <promptfile> [--name <session name>]');
    await readFile(flags.file, 'utf8');                        // must exist
    const line = `Read the brief at "${flags.file}" and execute it in full (it is your task; the report-back protocol is at the end).`;
    const r = await kickSession({ workspace: flags.workspace, line, name: flags.name });
    console.log(r.ok ? `kicked: prompt submitted (attempt ${r.attempt}${r.note ? `, ${r.note}` : ''})` : `KICK FAILED: ${r.reason}`);
    process.exit(r.ok ? 0 : 3);
  }

  die(HELP);
}

main().catch((e) => die(e.message));
