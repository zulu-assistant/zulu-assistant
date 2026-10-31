#!/usr/bin/env node
// Chat intake (task #223): team chat → ledger tasks, status back into the thread.
// Runs as its own LaunchAgent (system/launchd/chat-intake.plist.tmpl, KeepAlive)
// next to the board; talks to the board over localhost with data/intake-token.
//
//   node scripts/chat-intake.mjs            run (idles while tokens are absent)
//   node scripts/chat-intake.mjs --check    resolve tokens/channels/people, link health, catch-up preview, exit
//   node scripts/chat-intake.mjs --sweep --since <ISO|12h|2d> [--apply]
//        preview the requests posted since then that were never filed; --apply asks the
//        running service to file them (it owns the state files; capped at 7 days)
//
// Design: data/handoffs/slack-adapter-design-2026-10-24.md (private) /
// docs/CHAT-INTAKE.md (public). Never logs a token; never runs an attachment.
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, SETTINGS, PRINCIPALS, OWNER, loadSecrets, resolve } from '../src/config.mjs';
const OWNER_NAME = OWNER.name;
import {
  loadChannels, routeEvent, plainText, parseContract, requestBody, replyBody, withheldBody, titleFor,
  ownerFor, safeFileName, renderMentions, coalesce, openSeen, openThreads, openInbox, writeAtomic, chatFileProblem,
  catchupOldest, parseSince, seenFloor, historyEvents, missedByLink, linkHealth, linkStatePatch, readJson, publishBackoff,
} from '../src/intake.mjs';
import { slackApi, listChannels, userNames, mentionedIds, downloadFile, socketMode, uploadToThread } from '../src/intake-slack.mjs';

const STATE_DIR = path.join(ROOT, 'data', 'chat-intake');
const BOARD = `http://127.0.0.1:${SETTINGS.port}`;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let status = { state: 'starting', since: new Date().toISOString(), lastEventAt: null, lastError: null, channels: [] };
const setStatus = async (patch) => {
  status = { ...status, ...patch, at: new Date().toISOString() };
  await writeAtomic(path.join(STATE_DIR, 'status.json'), status).catch(() => {});
};

async function intakeToken() {
  return (await readFile(path.join(ROOT, 'data', 'intake-token'), 'utf8').catch(() => '')).trim();
}

/** Board call with the intake token. → { status, json } (never throws on HTTP errors). */
async function board(method, p, body) {
  const res = await fetch(BOARD + p, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', 'x-mesh-intake': await intakeToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function run(secrets, { check = false, ...opts } = {}) {
  const bot = secrets.SLACK_BOT_TOKEN;
  const cfg = loadChannels(resolve('config/channels.json'));
  const auth = await slackApi(bot, 'auth.test');
  const visible = await listChannels(bot);
  const channelById = new Map();
  const report = [];
  for (const c of cfg.channels) {
    const v = visible.get(c.name);
    report.push({ name: c.name, id: v?.id || null, member: Boolean(v?.member), owner: c.owner });
    if (v?.id) channelById.set(v.id, c);
  }
  const statusCh = cfg.statusChannel ? visible.get(cfg.statusChannel) : null;
  report.push({ name: cfg.statusChannel, id: statusCh?.id || null, member: Boolean(statusCh?.member), owner: '(status publisher)' });
  const people = [...PRINCIPALS.values()].map((p) => `${p.id}=${p.slack.length ? 'linked' : 'NO chat id'}`);
  // --check / --sweep run beside the live service: never overwrite its status.json (the board's link card reads it)
  if (!check) await setStatus({ channels: report, bot: auth.user, team: auth.team });
  if (check) {
    console.log(`bot ${auth.user} in ${auth.team}`);
    const live = await readJson(path.join(STATE_DIR, 'status.json'), null);
    const h = linkHealth(live);
    console.log(`  link (running service): ${h.level.toUpperCase()} — ${h.why}`);
    const cur = await readJson(path.join(STATE_DIR, 'cursor.json'), {});
    for (const [id, ts] of Object.entries(cur)) console.log(`  history cursor ${id}: ${new Date(Number(ts) * 1000).toISOString()}`);
    // what the next catch-up (or the --sweep window) would file (read-only: nothing is filed or posted here)
    const seenNow = await openSeen(path.join(STATE_DIR, 'seen.json'));
    const threadsNow = await openThreads(path.join(STATE_DIR, 'threads.json'));
    for (const [id, c] of channelById) {
      const oldest = catchupOldest({ cursor: cur[id], since: opts.since });
      const j = await slackApi(bot, 'conversations.history', { channel: id, oldest, limit: 200 }).catch((e) => ({ error: e.message }));
      if (j.error) { console.log(`  catch-up #${c.name}: history unreadable — ${j.error}`); continue; }
      const todo = historyEvents(j.messages, id, oldest).filter((ev) => !seenNow.has(`${id}:${ev.ts}`)
        && routeEvent(ev, { botUserId: auth.user_id, channelById, threads: threadsNow.map, principals: PRINCIPALS }).kind === 'request');
      const lastSeen = seenFloor(seenNow.keys(), id);
      console.log(`  catch-up #${c.name}: last seen ${lastSeen ? new Date(Number(lastSeen) * 1000).toISOString() : 'none'} · ${todo.length} unfiled request(s) since ${new Date(Number(oldest) * 1000).toISOString()}${todo.length ? ` (${todo.map((e) => new Date(Number(e.ts) * 1000).toISOString().slice(0, 16)).join(', ')})` : ''}`);
    }
    for (const r of report) console.log(`  #${r.name}: ${r.id ? (r.member ? 'ok (member)' : 'FOUND, bot not invited — /invite @' + auth.user) : 'NOT FOUND'} → ${r.owner}`);
    console.log(`  people: ${people.join(', ')}`);
    for (const rule of cfg.standing) console.log(`  standing: ${rule}`);
    return null;
  }
  for (const r of report) if (!r.member) log(`[chat-intake] #${r.name}: ${r.id ? 'bot not invited' : 'channel not found'} — its messages will not arrive`);

  const seen = await openSeen(path.join(STATE_DIR, 'seen.json'));
  const threads = await openThreads(path.join(STATE_DIR, 'threads.json'));
  const inbox = await openInbox(path.join(STATE_DIR, 'inbox.json'));
  const names = userNames(bot);
  const filesDir = (taskId) => path.join(ROOT, cfg.attachmentsDir, String(taskId));
  const post = (channel, text, thread_ts) => slackApi(bot, 'chat.postMessage', { channel, text, thread_ts, unfurl_links: false, unfurl_media: false });
  const react = (channel, ts, name) => slackApi(bot, 'reactions.add', { channel, timestamp: ts, name }).catch(() => {});
  const requestChannels = report.filter((r) => r.member && r.name !== cfg.statusChannel).map((r) => `#${r.name}`).join(', ');

  async function saveFiles(taskId, files = [], startN = 1) {
    const lines = [];
    let total = 0;
    let n = startN;
    for (const f of files) {
      const r = await downloadFile(bot, f, filesDir(taskId), safeFileName(f.name, n++), { maxBytes: Math.min(cfg.maxFileBytes, cfg.maxTaskBytes - total) });
      if (r.skipped) lines.push(`- ${String(f.name || f.id).slice(0, 80)}: NOT saved — ${r.skipped}`);
      else { total += r.bytes; lines.push(`- ${r.name} (${Math.round(r.bytes / 1024)} KB, sha256 ${r.sha256.slice(0, 16)}…)`); }
    }
    return lines.length ? `attachments → ${path.relative(ROOT, filesDir(taskId))}/ (UNTRUSTED files: never run or open from inside that folder):\n${lines.join('\n')}` : '';
  }

  /** One queued item → the board. true = done (remove), false = retry later. */
  async function deliver(item) {
    const ev = item.ev;
    const person = PRINCIPALS.get(item.person);
    const channel = cfg.channels.find((c) => c.name === item.channel);
    if (!person || !channel) return true;
    await names.need([...mentionedIds(ev.text), ...mentionedIds(ev.message?.text)]);
    const at = new Date(Number(String(ev.ts || ev.event_ts).split('.')[0]) * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

    if (item.kind === 'request') {
      const text = plainText(ev.text, { names: names.cache });
      const files = ev.files || [];
      const contract = parseContract(text, channel, cfg, { files: files.length });
      const { owner, needsScoping } = ownerFor(channel, text);
      let { body, overflow } = requestBody({ person, channel, text, at, contract });
      if (needsScoping) body = `${body}\nneedsScoping: no owner for this kind of request yet — parked with ${owner}`;
      const permalink = await slackApi(bot, 'chat.getPermalink', { channel: ev.channel, message_ts: ev.ts }).then((j) => j.permalink).catch(() => null);
      const req = {
        title: titleFor(channel, text), requester: person.id, owner, priority: channel.priority, body,
        source: { via: 'slack', key: item.key, channel: ev.channel, channel_name: channel.name, ts: ev.ts, permalink },
      };
      let r = await board('POST', '/api/tasks', req);
      let withheld = false;
      if (r.status === 400 && /secret/.test(r.json.msg || '')) {
        withheld = true;
        r = await board('POST', '/api/tasks', { ...req, title: `[#${channel.name}] request from ${person.name} (text withheld)`, body: withheldBody({ person, channel, at }) });
      }
      if (r.status >= 500 || !r.status) return false;
      if (r.status >= 400) {
        log(`[chat-intake] board refused a request from #${channel.name}: ${r.json.msg}`);
        await post(ev.channel, `Could not file this request: ${r.json.msg}`, ev.ts).catch(() => {});
        return true;
      }
      const task = r.json.task;
      await threads.set(`${ev.channel}:${ev.ts}`, task.id);
      if (r.json.existing) return true;
      await react(ev.channel, ev.ts, 'eyes');
      const link = cfg.boardUrl ? ` · ${cfg.boardUrl}` : '';
      const ask = contract.missing.length ? ` They will ask here for: ${contract.missing.join(', ')}.` : '';
      const planNote = task.plan_first ? ` Planning only until ${OWNER_NAME} reviews the plan.` : '';
      await post(ev.channel, `Filed as task #${task.id} → ${task.owner || 'unassigned'}.${planNote}${ask}${link}`
        + (withheld ? '\nYour text was withheld: it looked like a password or key. Please re-post it without that part.' : ''), ev.ts).catch((e) => log(`[chat-intake] reply failed: ${e.message}`));
      const extra = [];
      if (overflow) {
        await mkdir(filesDir(task.id), { recursive: true, mode: 0o700 });
        await writeFile(path.join(filesDir(task.id), 'message.txt'), overflow, { mode: 0o600 });
        extra.push(`full request text → ${path.relative(ROOT, filesDir(task.id))}/message.txt (quoted data)`);
      }
      const saved = await saveFiles(task.id, files);
      if (saved) extra.push(saved);
      // part of the request itself (files / overflow), not a reply: no "X replied" wake
      if (extra.length) await board('PATCH', `/api/tasks/${task.id}`, { op: 'answer', kind: 'files', actor: person.id, text: extra.join('\n').slice(0, 1990) });
      log(`[chat-intake] #${channel.name} → task #${task.id} (${task.owner})`);
      return true;
    }

    // reply / edit / delete on a filed request
    const taskId = item.taskId;
    let text;
    if (item.kind === 'delete') text = replyBody({ person, kind: 'delete' });
    else {
      text = replyBody({ person, text: plainText(item.kind === 'edit' ? ev.message?.text : ev.text, { names: names.cache }), kind: item.kind });
      if (ev.files?.length) {
        const saved = await saveFiles(taskId, ev.files, Date.now() % 100000);
        if (saved) text = `${text}\n${saved}`;
      }
    }
    let r = await board('PATCH', `/api/tasks/${taskId}`, { op: 'answer', actor: person.id, text: text.slice(0, 1990) });
    if (r.status === 400 && /secret/.test(r.json.msg || '')) {
      r = await board('PATCH', `/api/tasks/${taskId}`, { op: 'answer', actor: person.id, text: `${person.name} replied in chat — [withheld: it looked like a credential]` });
      await post(ev.channel, 'Your reply was withheld from the task: it looked like a password or key.', ev.thread_ts || ev.ts).catch(() => {});
    }
    if (r.status >= 500 || !r.status) return false;
    if (r.status >= 400) log(`[chat-intake] board refused a reply on #${taskId}: ${r.json.msg}`);
    return true;
  }

  let draining = false;
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      for (const item of [...inbox.items]) {
        let done;
        try { done = await deliver(item); } catch (e) { log(`[chat-intake] deliver: ${e.message}`); done = false; }
        if (!done) break;                        // board down — keep order, retry later
        await inbox.remove(item.key);
      }
    } finally { draining = false; }
  }

  async function onEvent(ev, meta) {
    await setStatus({ lastEventAt: new Date().toISOString() });
    const route = routeEvent(ev, { botUserId: auth.user_id, channelById, threads: threads.map, principals: PRINCIPALS });
    if (route.kind === 'ignore') {
      if (route.why === 'not a listed person' && ev.user) log(`[chat-intake] message from unlisted member ${ev.user} in ${ev.channel} ignored (add them to config/principals.json to hear them)`);
      return;
    }
    const msgKey = ev.ts && ['request', 'reply'].includes(route.kind) ? `${ev.channel}:${ev.ts}` : null;
    if (seen.has(meta.eventId, msgKey)) return;
    if (route.kind === 'redirect') {
      await seen.add(meta.eventId);
      await slackApi(bot, 'chat.postEphemeral', { channel: ev.channel, user: ev.user, text: `Post requests in ${requestChannels || 'a request channel'} — each top-level message there becomes a task.` }).catch(() => {});
      return;
    }
    const key = `slack:${meta.teamId || auth.team_id}:${ev.channel}:${ev.ts || ev.event_ts}`;
    await inbox.push({ key: route.kind === 'request' ? key : `${key}:${meta.eventId}`, kind: route.kind, person: route.person.id, channel: route.channel.name, taskId: route.taskId || null, ev });
    await seen.add(meta.eventId, msgKey);       // persisted BEFORE the board call: a crash re-drains, never re-files
    await drain();
  }

  const failures = new Map();   // outbox item id → { n, nextAt }: 3 tries (now, +1 min, +5 min), then dropped
  async function publish() {
    const r = await board('GET', '/api/intake/outbox').catch(() => null);
    const items = r?.status === 200 ? r.json.items || [] : [];
    if (!items.length) return;
    const sent = [];
    for (const it of coalesce(items)) {
      if ((failures.get(it.id)?.nextAt || 0) > Date.now()) break;   // backing off; keep the order
      if (!it.channel || !it.thread_ts) { log(`[chat-intake] publish #${it.taskId}: no chat thread — dropped`); sent.push(it.id); continue; }
      try {
        if (it.file) {
          // a file an agent made for the requester (task.sh chat-file); re-checked here, the board checked it too
          const st = await stat(path.join(ROOT, it.file)).catch(() => null);
          const bad = chatFileProblem(it.file, { size: st?.size, isFile: st?.isFile(), attachmentsDir: cfg.attachmentsDir });
          if (bad) { log(`[chat-intake] file for #${it.taskId} not posted: ${bad}`); sent.push(it.id); continue; }
          await uploadToThread(bot, { channel: it.channel, thread_ts: it.thread_ts, filename: path.basename(it.file),
            bytes: await readFile(path.join(ROOT, it.file)), title: it.title, comment: it.text ? renderMentions(it.text, PRINCIPALS) : '' });
          log(`[chat-intake] #${it.taskId}: posted ${path.basename(it.file)} to the thread`);
          sent.push(it.id);
          continue;
        }
        await post(it.channel, renderMentions(it.text, PRINCIPALS), it.thread_ts);
        if (/ done\b/.test(it.text)) await react(it.channel, it.thread_ts, 'white_check_mark');
        // #status gets the one-line gist; the full question stays in the request's thread
        const gist = String(it.text).split('\n')[0].slice(0, 200) + (String(it.text).length > 200 || it.text.includes('\n') ? ' …' : '');
        if (it.status && statusCh?.member) await post(statusCh.id, `#${it.channel_name || 'request'} · ${renderMentions(gist, PRINCIPALS, null)}`).catch(() => {});
      } catch (e) {
        // permanent errors drop the item at once; anything else retries, but at most MAX_TRIES passes
        const n = (failures.get(it.id)?.n || 0) + 1;
        const wait = publishBackoff(e.message, n);
        if (wait != null) {
          failures.set(it.id, { n, nextAt: Date.now() + wait });
          log(`[chat-intake] publish #${it.taskId}: ${e.message} (try ${n}/3, next in ${Math.round(wait / 1000)} s)`);
          break;
        }
        log(`[chat-intake] publish #${it.taskId}: ${e.message} — dropped after ${n} tr${n === 1 ? 'y' : 'ies'}`);
        await fetch(`${BOARD}/api/event`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'bad', text: `chat intake: could not post #${it.taskId}'s update to its chat thread (${e.message}) — dropped after ${n} tr${n === 1 ? 'y' : 'ies'}` }) }).catch(() => {});
      }
      failures.delete(it.id);
      sent.push(it.id);
    }
    // everything coalesced away counts as sent too
    const kept = new Set(coalesce(items).map((x) => x.id));
    for (const it of items) if (!kept.has(it.id)) sent.push(it.id);
    if (sent.length) await board('POST', '/api/intake/outbox/ack', { ids: sent });
  }

  // daily one-liner in the status channel (08:00 local, once a day)
  async function daily() {
    const now = new Date();
    const day = now.toDateString();
    if (!statusCh?.member || now.getHours() < 8 || status.dailyFor === day) return;
    const r = await board('GET', '/api/tasks?status=live').catch(() => null);
    if (r?.status !== 200) return;
    const mine = (r.json.tasks || []).filter((t) => t.source?.via === 'slack');
    const waiting = {};
    for (const t of mine) for (const x of t.blocked_on || []) if (typeof x === 'string') (waiting[x] ||= []).push(`#${t.id}`);
    const w = Object.entries(waiting).map(([p, ids]) => `waiting on ${PRINCIPALS.get(p)?.name || p}: ${ids.join(' ')}`);
    await post(statusCh.id, `Chat requests: ${mine.length} open${w.length ? ` · ${w.join(' · ')}` : ''}`).catch(() => {});
    await setStatus({ dailyFor: day });
  }

  // history catch-up: after start, after each reconnect, and every 5 min (also the missed-delivery probe)
  const cursorFile = path.join(STATE_DIR, 'cursor.json');
  const cursors = await readJson(cursorFile, {});
  let sweeping = false;
  async function sweep(why, since = null) {
    if (sweeping) return false;
    sweeping = true;
    try {
      let missed = 0;
      const connectedMs = status.state === 'connected' && status.connectedAt ? Date.parse(status.connectedAt) : null;
      for (const id of channelById.keys()) {
        const oldest = catchupOldest({ cursor: cursors[id], since });
        let newest = oldest; let page;
        do {
          const j = await slackApi(bot, 'conversations.history', { channel: id, oldest, limit: 200, cursor: page });
          for (const ev of historyEvents(j.messages, id, oldest)) {
            if (connectedMs && Number(ev.ts) * 1000 > connectedMs && missedByLink(ev, (k) => seen.has(k))
              && routeEvent(ev, { botUserId: auth.user_id, channelById, threads: threads.map, principals: PRINCIPALS }).kind === 'request') missed++;
            await onEvent(ev, { eventId: `hist:${id}:${ev.ts}`, teamId: auth.team_id, history: true });
            if (Number(ev.ts) > Number(newest)) newest = ev.ts;
          }
          for (const m of j.messages || []) if (Number(m.ts) > Number(newest)) newest = m.ts;
          page = j.has_more ? j.response_metadata?.next_cursor : null;
        } while (page);
        // the cursor only moves forward (a manual window reads further back without rewinding it)
        if (!cursors[id] || Number(newest) > Number(cursors[id])) { cursors[id] = newest; await writeAtomic(cursorFile, cursors); }
      }
      await setStatus({ lastSweepOkAt: new Date().toISOString() });
      if (since != null) log(`[chat-intake] manual sweep since ${new Date(since).toISOString()} done`);
      if (missed) { log(`[chat-intake] history sweep (${why}): the socket missed ${missed} request(s) — filed now`); sock.kick('socket missed messages'); }
    } catch (e) { log(`[chat-intake] history sweep (${why}): ${e.message}`); return false; }
    finally { sweeping = false; }
    return true;
  }
  // a manual window asked for with `--sweep --since … --apply` (the service owns the state files)
  const sweepReq = path.join(STATE_DIR, 'sweep-request.json');
  async function manualSweep() {
    const req = await readJson(sweepReq, null);
    if (!req) return;
    const since = Number(req.since);
    if (!Number.isFinite(since)) { await unlink(sweepReq).catch(() => {}); return; }
    log(`[chat-intake] manual sweep requested since ${new Date(since).toISOString()}`);
    if (await sweep('manual', since)) await unlink(sweepReq).catch(() => {});
  }

  let lastFrameWrite = 0;
  const sock = socketMode({
    appToken: secrets.SLACK_APP_TOKEN, onEvent, log,
    onHello: ({ reconnect }) => sweep(reconnect ? 'reconnect' : 'start'),
    onState: (state, err) => {
      const at = new Date().toISOString();
      if (state === 'frame') {                     // liveness only: written at most every 30 s
        if (Date.now() - lastFrameWrite < 30_000) { status.lastFrameAt = at; return; }
        lastFrameWrite = Date.now();
        return setStatus({ lastFrameAt: at });
      }
      return setStatus(linkStatePatch(state, err, status, at));
    },
  });
  const timers = [
    setInterval(() => sweep('sweep').catch(() => {}), 5 * 60_000),
    setInterval(() => manualSweep().catch(() => {}), 30_000),
    setInterval(() => drain().catch(() => {}), 30_000),
    setInterval(() => publish().catch((e) => log(`[chat-intake] publish: ${e.message}`)), 10_000),
    setInterval(() => daily().catch(() => {}), 5 * 60_000),
  ];
  drain().catch(() => {});
  return { stop() { sock.stop(); timers.forEach(clearInterval); } };
}

async function main() {
  const argv = process.argv.slice(2);
  const sweepMode = argv.includes('--sweep');
  const check = argv.includes('--check') || sweepMode;
  const sinceArg = argv[argv.indexOf('--since') + 1];
  const since = sweepMode ? parseSince(argv.includes('--since') ? sinceArg : '') : null;
  if (sweepMode && since == null) { console.log('usage: chat-intake --sweep --since <ISO time | 12h | 2d> [--apply]'); process.exit(2); }
  if (sweepMode && argv.includes('--apply')) {
    await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
    await writeAtomic(path.join(STATE_DIR, 'sweep-request.json'), { since, at: new Date().toISOString() });
    console.log(`asked the running service to file unfiled requests since ${new Date(since).toISOString()} (picked up within 30 s; see logs/chat-intake.log)`);
    process.exit(0);
  }
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  try { status.dailyFor = JSON.parse(await readFile(path.join(STATE_DIR, 'status.json'), 'utf8')).dailyFor; } catch { /* first run */ }
  for (;;) {
    const s = loadSecrets();
    if (!s.SLACK_APP_TOKEN || !s.SLACK_BOT_TOKEN) {
      if (check) { console.log('not configured: SLACK_APP_TOKEN / SLACK_BOT_TOKEN missing in data/secrets.env'); process.exit(1); }
      await setStatus({ state: 'not configured' });
      await sleep(60_000);
      continue;
    }
    try {
      const h = await run(s, { check, since });
      if (check) process.exit(0);
      log('[chat-intake] running');
      // re-start when the tokens change (owner rotated them)
      const sig = `${s.SLACK_APP_TOKEN.length}:${s.SLACK_BOT_TOKEN.slice(-6)}`;
      for (;;) {
        await sleep(60_000);
        const n = loadSecrets();
        if (`${(n.SLACK_APP_TOKEN || '').length}:${(n.SLACK_BOT_TOKEN || '').slice(-6)}` !== sig) { log('[chat-intake] tokens changed — reconnecting'); h.stop(); break; }
      }
    } catch (e) {
      const msg = String(e.message).replace(/x(?:ox[abp]|app)-[A-Za-z0-9-]+/g, '[token]');
      log(`[chat-intake] start failed: ${msg}`);
      if (check) process.exit(1);
      await setStatus({ state: 'error', lastError: msg });
      await sleep(60_000);
    }
  }
}

main();
