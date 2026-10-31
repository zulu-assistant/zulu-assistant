// Guardrails gate service (board side). The hook (scripts/gate-hook.mjs) sends each
// tool call that hit a trigger here; the board re-classifies it with ITS policy, files
// or finds the gate on the ledger, redeems single-use grants, and answers
// pass | allow | deny. docs/GUARDRAILS.md.
import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { classify, isEnforced, compileTriggers, triggerLines, cmdHash, describeToolCall, dryHash, scriptPath, shellQuote, repoSlug, globMatch, positionals, HASH_VERSION, DEFAULT_POLICY, OPAQUE } from './gates.mjs';
import { createGateStore, auditRows, focusOf } from './gate-ledger.mjs';
import { containsSecret, LIVE_STATUSES, activeProgramGo } from './tasks.mjs';

const MODES = ['enforce', 'observe', 'off'];

/** Validate a policy object; returns a list of problems (empty = ok). */
export function policyProblems(p) {
  const out = [];
  if (!p || typeof p !== 'object') return ['policy is not an object'];
  if (p.version !== 1) out.push('version must be 1');
  if (p.mode && !MODES.includes(p.mode)) out.push(`mode must be ${MODES.join('|')}`);
  if (!Array.isArray(p.classes) || !p.classes.length) out.push('classes must be a non-empty list');
  const ids = new Set();
  for (const c of p.classes || []) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(c.id || '')) out.push(`class id "${c.id}" must be a short slug`);
    if (ids.has(c.id)) out.push(`class id "${c.id}" is listed twice`); ids.add(c.id);
    if (!Array.isArray(c.rules) || !c.rules.length) out.push(`class ${c.id}: rules must be a non-empty list`);
    for (const r of c.rules || []) {
      if (!(r.bin || r.script || r.scriptIn || r.tool || r.sql || r.pathAny || r.pathWrite || r.textAny)) out.push(`class ${c.id}: a rule needs bin, script, scriptIn, tool, sql, pathAny, pathWrite or textAny`);
      for (const k of ['tool', 'sql']) if (r[k]) { try { new RegExp(r[k]); } catch { out.push(`class ${c.id}: ${k} is not a valid regex`); } }
      // every @list a rule names must exist
      for (const v of [r.labels, r.unlessLabels, r.pathWrite, r.scriptIn, r.unlessFlags, ...(r.pathAny || [])]) {
        if (typeof v === 'string' && v.startsWith('@') && !Array.isArray(p.lists?.[v.slice(1)])) out.push(`class ${c.id}: list ${v} is not defined`);
      }
    }
  }
  return out;
}

/** The gate decision text an agent sees (one line, no secrets). */
export const denyText = {
  pending: (t, g) => `GATE: ${g.label} — not run. Waiting on the owner, task #${t} (gate ${g.id})${g.previously ? `; it was approved before (${String(g.previously.at).slice(11, 16)}Z, ${g.previously.gate}) but expired unused, so the owner is asked again` : ''}. You'll be woken when they decide; do not retry it or work around it.`,
  waiting: (t, g) => `GATE: still waiting on the owner — task #${t} gate ${g.id}. Do not retry; you'll be woken.`,
  declined: (t, g) => `GATE: declined by the owner ${String(g.decided_at || '').slice(0, 16).replace('T', ' ')}Z${g.reason ? ` (${g.reason})` : ''}. Do not retry; ask on task #${t}.`,
  dry: (t, cmd) => `GATE: run the dry form first, in this task (#${t}): ${cmd} — then try the write form again.`,
  focus: (n) => `GATE: you have ${n} live tasks and no focus, so this gate would land on the wrong one. Set it first: task.sh focus <N> — then retry.`,
  down: () => 'GATE: board unreachable — gated command not run (fail closed). Retry when the board is up.',
};

export function createGateService({ root, ledger, policyFile, identifyWs, mcName = async () => 'mission-control', isPrivateRepo = ghIsPrivate, prInfo = ghPrInfo, recordEvent = async () => {}, afterTaskChange = async () => {}, ownerId = 'owner', home = os.homedir(), git = defaultGit, now = () => Date.now(), stateDir }) {
  const store = createGateStore(stateDir || path.join(root, 'data', 'guardrails'));
  let policy = null; let policyMtime = 0; let policyError = null; let triggersFor = null;

  async function loadPolicy() {
    const file = typeof policyFile === 'function' ? policyFile() : policyFile;
    const st = await stat(file).catch(() => null);
    if (!st) {
      if (!policy) { policy = DEFAULT_POLICY; policyError = 'policy file missing — using the shipped default'; policyMtime = 'default'; await syncTriggers(); }
      return policy;
    }
    const key = `${file}@${st.mtimeMs}`;
    if (key === policyMtime && policy) return policy;
    policyMtime = key;
    try {
      const p = JSON.parse(await readFile(file, 'utf8'));
      const probs = policyProblems(p);
      if (probs.length) throw new Error(probs.join('; '));
      policy = p; policyError = null;
    } catch (e) {
      policyError = `policy invalid (${e.message}) — ${policy ? 'keeping the last good policy' : 'using the shipped default'}`;
      policy = policy || DEFAULT_POLICY;
      recordEvent('bad', `guardrails: ${policyError}`).catch(() => {});
    }
    await syncTriggers();
    return policy;
  }
  async function syncTriggers() {
    const watched = await store.watched();
    const key = JSON.stringify([policyMtime, watched]);
    if (key === triggersFor) return;
    const lines = [...triggerLines(policy), ...watched.map((w) => path.basename(w).replace(/[.[\]()*+?{}|^$\\]/g, '\\$&'))];
    await store.writeTriggers(lines);
    triggersFor = key;
    // the server classifies with the same lines the hook greps (watched scripts included)
    compiled = [...compileTriggers(policy), ...watched.map((w) => ({ ere: path.basename(w), re: new RegExp(path.basename(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }))];
  }
  let compiled = null;
  const ctxFor = (cwd) => ({
    home, boardRoot: root, triggers: compiled || compileTriggers(policy),
    repoRoot: (d) => git(d, ['rev-parse', '--show-toplevel']),   // null outside a repo: no working tree there
    git,
  });
  const redact = (s) => (containsSecret(s) ? null : s);

  async function liveTasksOf(agent) { return (await ledger.list({ owner: agent, status: 'live' })) || []; }
  async function findByHash(agent, hash) {
    for (const t of await ledger.list({ status: 'live' })) {
      const gs = (t.gates || []).filter((g) => g.cmdHash === hash && g.agent === agent);
      if (gs.length) return { t, g: gs[gs.length - 1] };
    }
    return null;
  }
  async function resolveTask(agent, label, short) {
    const focus = focusOf(await store.focus(), agent)?.task;
    const live = await liveTasksOf(agent);
    if (focus && live.some((t) => t.id === focus)) return { id: focus };
    if (live.length === 1) return { id: live[0].id };
    if (live.length > 1) return { needsFocus: live.length };
    // zero live tasks: a new one for this gate (owner = the agent; unregistered → mission control)
    const owner = agent.startsWith('unregistered:') ? await mcName() : agent;
    const t = await ledger.create({ title: `GATE: ${label} — ${short}`.slice(0, 200), requester: 'board', owner, priority: 'normal' });
    return { id: t.id, created: true };
  }

  /** The hook's question, logged: every answer leaves one line in data/guardrails/checks.jsonl. */
  async function check(input) {
    const r = await decide(input);
    const raw = Array.isArray(input.command) ? input.command.join(' ') : String(input.command ?? input.filePath ?? '');
    const agent = (input.workspaceId && (await identifyWs(input.workspaceId).catch(() => null))) || `unregistered:${path.basename(input.cwd || root)}`;
    await store.logCheck({
      at: new Date(now()).toISOString(), event: input.event || 'pre', agent, tool: input.tool, decision: r.decision,
      ...(r.observed ? { observed: true } : {}), ...(r.stale ? { stale: true } : {}), ...(r.task ? { task: r.task, gate: r.gate } : {}),
      reason: r.reason ? String(r.reason).slice(0, 120) : undefined,
      command: containsSecret(raw) ? '[withheld: contains a secret]' : raw.replace(/\s+/g, ' ').slice(0, 160), cwd: input.cwd,
    }).catch(() => {});
    return r;
  }

  /** → { decision: 'pass'|'allow'|'deny', reason?, task?, gate? } */
  async function decide(input) {
    // the hook stops waiting at its deadline and denies on its own; a request served later (a frozen or
    // slow board) must not file a gate the agent was never told about
    if (Number(input.deadline) > 0 && now() > Number(input.deadline)) return { decision: 'deny', reason: 'stale request (the hook already gave up)', stale: true };
    const p = await loadPolicy();
    const tool = normTool(input.tool);
    const engine = input.engine === 'codex' ? 'codex' : 'claude';
    const cwd = input.cwd || root;
    const command = Array.isArray(input.command) ? input.command.map(shellQuote).join(' ') : String(input.command ?? '');
    const call = { tool, command, filePath: input.filePath || null, cwd };
    const agent = (input.workspaceId && (await identifyWs(input.workspaceId))) || `unregistered:${path.basename(cwd)}`;
    const ctx = ctxFor(cwd);
    const r = classify(call, p, ctx);

    // dry-run bookkeeping: watched scripts run without their write flags
    if (r.verdict === 'clear' && tool === 'Bash' && r.scripts?.length) {
      const watched = await store.watched();
      for (const c of r.scripts) {
        const sp = scriptPath(c); if (!sp) continue;
        const abs = path.resolve(cwd, sp.replace(/^~(?=\/)/, home));
        if (!watched.includes(abs)) continue;
        const dh = dryHash(cwd, c.tokens);
        const focus = focusOf(await store.focus(), agent)?.task ?? null;
        await store.recordDry({ agent, cwd, dryHash: dh, script: abs, task: focus, phase: input.event === 'post' ? 'completed' : 'started', now: now() });
      }
    }
    if (input.event === 'post' || r.verdict === 'clear') return { decision: 'pass' };

    const mode = MODES.includes(p.mode) ? p.mode : 'enforce';
    const enforced = mode === 'enforce' && isEnforced(p, agent, { registered: !agent.startsWith('unregistered:') });
    // what the owner sees: the shell command, or for any other tool the tool + its full input
    const toolInput = tool !== 'Bash' && input.toolInput && typeof input.toolInput === 'object' ? input.toolInput : null;
    const text = toolInput ? describeToolCall(tool, toolInput) : command;
    const shown = redact(text) ?? `[withheld: the ${toolInput ? 'tool input' : 'command'} contains a secret] ${r.cmd?.bin || tool}${call.filePath ? ` ${call.filePath}` : ''}`;
    if (mode === 'off') return { decision: 'pass' };
    if (!enforced) {
      // observe: ticker + observed.jsonl only, never the task (condition G)
      await store.observe({ at: new Date(now()).toISOString(), agent, engine, cls: r.cls, why: redact(r.why) ?? '[withheld]', command: shown, cwd, tool });
      recordEvent('sys', `guardrails (observe): ${agent} would wait on the owner — ${r.cls}: ${String(shown).slice(0, 80)}`).catch(() => {});
      return { decision: 'pass', observed: true };
    }

    const hash = cmdHash({ engine, cwd, tool, command, filePath: call.filePath || '', toolInput });
    // 1. an approved grant for exactly this call: consume it, let it run once
    const grant = await store.redeem({ cmdHash: hash, agent, now: now() });
    if (grant && !grant.expired) {
      const u = await ledger.update(grant.task, { op: 'gate_event', actor: 'board', gate: grant.gate, event: 'executed' }, { gateSystem: true });
      recordEvent('sys', `guardrails: ${agent} ran gate ${grant.gate} on #${grant.task} (single use)`).catch(() => {});
      await afterTaskChange(u.task, u, 'board');
      return { decision: 'allow', reason: `approved by the owner (task #${grant.task} gate ${grant.gate}) — runs once`, task: grant.task, gate: grant.gate };
    }
    if (grant?.expired) await ledger.update(grant.task, { op: 'gate_event', actor: 'board', gate: grant.gate, event: 'expired' }, { gateSystem: true }).catch(() => {});

    // 2. the same call is already waiting, or was declined
    const prior = await findByHash(agent, hash);
    // the owner already approved exactly this call once, but it expired unused: ask again (an approval
    // is of the call at that time — never re-armed), and say so on the row and in the notices
    let earlier = null;
    if (prior && (prior.g.status === 'expired' || (prior.g.status === 'approved' && prior.g.expires_at && Date.parse(prior.g.expires_at) <= now()))) {
      if (prior.g.status === 'approved') await ledger.update(prior.t.id, { op: 'gate_event', actor: 'board', gate: prior.g.id, event: 'expired' }, { gateSystem: true }).catch(() => {});
      earlier = { gate: prior.g.id, task: prior.t.id, at: prior.g.decided_at };
    }
    if (prior?.g.status === 'pending') {
      await ledger.update(prior.t.id, { op: 'gate_event', actor: 'board', gate: prior.g.id, event: 'attempt' }, { gateSystem: true });
      return { decision: 'deny', reason: denyText.waiting(prior.t.id, prior.g), task: prior.t.id, gate: prior.g.id };
    }
    if (prior?.g.status === 'declined') {
      const u = await ledger.update(prior.t.id, { op: 'gate_event', actor: 'board', gate: prior.g.id, event: 'rerun_declined' }, { gateSystem: true });
      await afterTaskChange(u.task, u, 'board');
      return { decision: 'deny', reason: denyText.declined(prior.t.id, prior.g), task: prior.t.id, gate: prior.g.id };
    }

    // 3. which task the receipt lands on (condition C)
    const short = String(shown).replace(/\s+/g, ' ').slice(0, 80);
    const where = await resolveTask(agent, r.label, short);
    if (where.needsFocus) return { decision: 'deny', reason: denyText.focus(where.needsFocus) };

    const base = { cls: r.cls, label: r.label, why: redact(r.why) ?? '[withheld]', command: shown, commandRedacted: shown !== text, bin: r.cmd?.bin || null,
      cwd, tool, engine, agent, session: input.session || null, cmdHash: hash, hashVersion: HASH_VERSION, ttlMinutes: r.ttlMinutes };
    if (earlier) {
      base.previously = earlier;
      base.why = `${base.why} · previously approved ${String(earlier.at).slice(11, 16)}Z (#${earlier.task} ${earlier.gate}), expired unused`;
    }
    // a merge row says which PR: title, branches and repo, looked up when the gate is filed
    if (r.cls === 'merge' && r.cmd) {
      const s = await prInfo(r.cmd, r.cmd.cwd || cwd).catch(() => null);
      if (s) base.why = redact(`${base.why} · PR #${s.number} "${s.title}" (${s.head} → ${s.base})${s.repo ? ` · ${s.repo}` : ''}`) ?? base.why;
    }

    // 4. dry run first (from the task's own history)
    if (r.requireDryRun && r.dryTokens) {
      const dh = dryHash(cwd, r.dryTokens);
      const sp = scriptPath(r.cmd);
      if (sp && await store.watch(path.resolve(cwd, sp.replace(/^~(?=\/)/, home)))) await syncTriggers();
      const t = await ledger.get(where.id);
      const lastUse = Math.max(0, ...(t.gates || []).filter((g) => g.dryRun?.dryHash === dh && g.executed_at).map((g) => Date.parse(g.executed_at)));
      const seen = [...(await store.dryRecords())].reverse().find((d) => d.agent === agent && d.dryHash === dh && d.completed_at && Date.parse(d.completed_at) > lastUse);
      const dryCmd = redact(r.dryTokens.map(shellQuote).join(' ')) ?? '[the same command without its write flag]';
      if (!seen) {
        const u = await ledger.update(where.id, { op: 'gate_request', actor: 'board', gate: { ...base, status: 'dry_required', dryRun: { required: true, dryHash: dh, command: dryCmd } } }, { gateSystem: true });
        await afterTaskChange(u.task, u, 'board');
        return { decision: 'deny', reason: denyText.dry(where.id, dryCmd), task: where.id };
      }
      base.dryRun = { required: true, seen_at: seen.completed_at, dryHash: dh, command: dryCmd };
    }

    // 5. standing approval: a program go on this task approves the standing classes (merge into private repos, local loads)
    const cls = (p.classes || []).find((c) => c.id === r.cls);
    if (cls?.standing) {
      const t = await ledger.get(where.id);
      const go = activeProgramGo(t);
      // the repo is the one the command runs in (cd / git -C), not the hook's session folder
      const why = !go ? 'no program go' : r.cmd?.cdUnknown ? 'the command runs in a folder the gate cannot resolve' : await standingBlocker(r, r.cmd?.cwd || cwd, p);
      if (go && !why) {
        const a = await ledger.update(where.id, { op: 'gate_request', actor: 'board', gate: { ...base, auto: { go: go.id, owner: ownerId } } }, { gateSystem: true });
        const g = a.task.gates[a.task.gates.length - 1];
        const u = await ledger.update(where.id, { op: 'gate_event', actor: 'board', gate: g.id, event: 'executed' }, { gateSystem: true });
        recordEvent('sys', `guardrails: ${agent} ${r.cls} on #${where.id} auto-approved under program go ${go.id} (gate ${g.id})`).catch(() => {});
        await afterTaskChange(u.task, { ...u, events: [...(a.events || []), ...(u.events || [])] }, 'board');
        return { decision: 'allow', reason: `auto-approved under program go ${go.id} on task #${where.id} (gate ${g.id}) — runs once`, task: where.id, gate: g.id };
      }
      if (go) base.why = `${base.why} · not under the program go: ${why}`;
    }

    // 6. file the gate and wait on the owner
    const u = await ledger.update(where.id, { op: 'gate_request', actor: 'board', gate: base }, { gateSystem: true });
    const g = u.task.gates[u.task.gates.length - 1];
    await afterTaskChange(u.task, u, 'board');
    return { decision: 'deny', reason: denyText.pending(where.id, g), task: where.id, gate: g.id };
  }

  /** Why a standing-class call still needs a tap ('' = it may run under the go). Fails toward asking. */
  async function standingBlocker(r, cwd, p) {
    if (r.cls !== 'merge') return '';
    const toks = r.cmd?.tokens || [];
    const ri = toks.findIndex((x) => x === '-R' || x === '--repo');
    const flagged = ri >= 0 ? toks[ri + 1] : toks.find((x) => x.startsWith('--repo='))?.slice(7);
    const slug = flagged ? repoSlug(`/${flagged}`) || flagged : repoSlug(git(cwd, ['remote', 'get-url', 'origin']));
    if (!slug) return 'the target repo is unknown';
    const inList = (n) => (p.lists?.[n] || []).some((g) => globMatch(String(g).toLowerCase(), slug.toLowerCase()));
    if (inList('publicRemotes')) return `${slug} is public`;
    if (inList('deployOnPush')) return `${slug} deploys on push`;
    if ((await isPrivateRepo(slug)) !== true) return `${slug} is not confirmed private`;
    return '';
  }

  /** After an approval is recorded on the ledger: mint the grant (before the agent is woken). */
  async function afterDecision(task, gateId) {
    const g = (task.gates || []).find((x) => x.id === gateId);
    if (!g || g.status !== 'approved') return null;
    // filed under an older fingerprint version (before an upgrade)? A shell gate whose full, unredacted
    // text is on record is re-fingerprinted, so the owner's tap still lets exactly that command run.
    let hash = g.cmdHash;
    if ((g.hashVersion || 'gate-v1') !== HASH_VERSION && g.tool === 'Bash' && !g.commandRedacted && !/\n… \[cut at /.test(g.command))
      hash = cmdHash({ engine: g.engine, cwd: g.cwd, tool: 'Bash', command: g.command });
    return store.mint({ task: task.id, gate: g.id, agent: g.agent, cmdHash: hash, expiresAt: g.expires_at });
  }

  /** Focus from claim/start: never replaces one the agent set itself on a task that is still live. */
  async function autoFocus(agent, taskId) {
    const cur = focusOf(await store.focus(), agent);
    if (cur?.explicit && cur.task !== Number(taskId)) {
      const t = await ledger.get(cur.task);
      if (t && LIVE_STATUSES.includes(t.status) && t.owner === agent) return false;
    }
    await store.setFocus(agent, taskId, { explicit: false });
    return true;
  }

  /** Board card: pending gates, hooks installed, policy health. */
  async function card(tasks) {
    await loadPolicy();
    const pending = tasks.flatMap((t) => (t.gates || []).filter((g) => g.status === 'pending').map((g) => ({ t: t.id, g })));
    const oldest = pending.length ? Math.min(...pending.map((x) => Date.parse(x.g.requested_at))) : null;
    const hooks = await hooksInstalled(home);
    const mode = policy?.mode || 'enforce';
    let status = 'ok';
    const bits = [`${mode}${policy?.enforceFor && !policy.enforceFor.includes('*') ? ` for ${policy.enforceFor.join(', ')}` : ''}`];
    if (pending.length) bits.push(`${pending.length} waiting on the owner (oldest ${Math.round((now() - oldest) / 60e3)}m)`);
    if (pending.length && now() - oldest > 30 * 60e3) status = 'warn';
    bits.push(`hook: claude ${hooks.claude ? 'on' : 'MISSING'}${hooks.codex == null ? '' : ` · codex ${hooks.codex ? 'on' : 'MISSING'}`}`);
    if (!hooks.claude && mode !== 'off') status = 'failed';
    if (policyError) { bits.push(policyError); status = 'failed'; }
    return { status, detail: bits.join(' · '), pending: pending.length };
  }

  async function audit(taskId) {
    const t = await ledger.get(taskId);
    return t ? auditRows(t) : null;
  }

  return { check, afterDecision, card, audit, loadPolicy, store, autoFocus, setFocus: (a, id) => store.setFocus(a, id, { explicit: true }), policy: () => policy, policyError: () => policyError };
}

/** Claude: Bash/Read/Edit/Write/mcp__*; Codex shells arrive as shell/exec_command/local_shell. */
export function normTool(t) {
  const s = String(t || 'Bash');
  return /^(shell|exec_command|local_shell|container\.exec|unified_exec)$/i.test(s) ? 'Bash' : s;
}

// Which PR a merge gate is about (gh pr view in the call's folder; -R honored). null when gh can't tell.
async function ghPrInfo(cmd, cwd) {
  const toks = cmd.tokens || [];
  const ri = toks.findIndex((x) => x === '-R' || x === '--repo');
  const repo = ri >= 0 ? toks[ri + 1] : (toks.find((x) => x.startsWith('--repo=')) || '').slice(7) || null;
  const pos = positionals(cmd);
  const target = pos[pos.indexOf('merge') + 1];        // number, URL or branch; none = the current branch's PR
  const args = ['pr', 'view', ...(target ? [target] : []), ...(repo ? ['-R', repo] : []), '--json', 'number,title,headRefName,baseRefName,url'];
  const out = execFileSync('gh', args, { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  const j = JSON.parse(out);
  return { number: j.number, title: String(j.title || '').slice(0, 120), head: j.headRefName, base: j.baseRefName, repo: repoSlug(j.url?.replace(/\/pull\/\d+$/, '')) };
}

// GitHub says whether a repo is private (gh, the owner's login); cached 6h; any failure → not confirmed
const privCache = new Map();
async function ghIsPrivate(slug) {
  const hit = privCache.get(slug);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  let v = null;
  try { v = execFileSync('gh', ['api', `repos/${slug}`, '--jq', '.private'], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true'; } catch { v = null; }
  privCache.set(slug, { v, at: Date.now() });
  return v;
}

function defaultGit(cwd, args) {
  try { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; }
  catch { return null; }
}

/** Is the gate hook in the agents' settings? (claude: required; codex: only if ~/.codex exists) */
export async function hooksInstalled(home) {
  const has = async (f) => { try { return (await readFile(f, 'utf8')).includes('gate-hook.sh'); } catch { return null; } };
  const claude = await has(path.join(home, '.claude', 'settings.json'));
  const codexDir = await stat(path.join(home, '.codex')).catch(() => null);
  const codex = codexDir ? (await has(path.join(home, '.codex', 'hooks.json'))) ?? false : null;
  return { claude: !!claude, codex };
}
export { LIVE_STATUSES, OPAQUE };
