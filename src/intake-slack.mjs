// Slack transport for the chat intake (task #223). Zero-dependency: Node 22's
// global WebSocket + fetch. Socket Mode, so nothing listens on the internet:
// we dial out to Slack, Slack pushes events down the socket.
//
// Tokens come from data/secrets.env (the owner types them; agents never handle
// them): SLACK_APP_TOKEN (xapp-, connections:write) opens the socket,
// SLACK_BOT_TOKEN (xoxb-) reads channels/files and posts in threads.
import { createWriteStream } from 'node:fs';
import { mkdir, chmod, rename, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const API = 'https://slack.com/api/';

export class SlackError extends Error {
  constructor(method, error, extra = {}) { super(`${method}: ${error}`); this.method = method; this.error = error; Object.assign(this, extra); }
}

/** One Web API call (form-encoded — every method accepts it). Retries a 429 once per its Retry-After. */
export async function slackApi(token, method, params = {}, { fetchImpl = fetch, retries = 2 } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(API + method, {
      method: 'POST', body,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') || 1);
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    const j = await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }));
    if (!j.ok) throw new SlackError(method, j.error || 'unknown_error', { needed: j.needed });
    return j;
  }
}

/**
 * Upload one file into a thread (scope files:write): get an upload URL, send the bytes,
 * then complete it into channel + thread_ts. Slack's current flow (files.upload is retired).
 */
export async function uploadToThread(token, { channel, thread_ts, filename, bytes, title, comment }, { fetchImpl = fetch } = {}) {
  const u = await slackApi(token, 'files.getUploadURLExternal', { filename, length: bytes.length }, { fetchImpl });
  const put = await fetchImpl(u.upload_url, { method: 'POST', body: bytes, signal: AbortSignal.timeout(60_000) });
  if (!put.ok) throw new SlackError('upload', `http_${put.status}`);
  return slackApi(token, 'files.completeUploadExternal', {
    files: [{ id: u.file_id, title: title || filename }], channel_id: channel, thread_ts, initial_comment: comment || undefined,
  }, { fetchImpl });
}

/** Every channel the bot can see: name → { id, member }. */
export async function listChannels(token, opts) {
  const out = new Map();
  let cursor;
  do {
    const j = await slackApi(token, 'conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 999, cursor }, opts);
    for (const c of j.channels || []) out.set(String(c.name).toLowerCase(), { id: c.id, member: Boolean(c.is_member) });
    cursor = j.response_metadata?.next_cursor || '';
  } while (cursor);
  return out;
}

/** A display-name cache (users.info), for turning <@U…> into names in the quoted body. */
export function userNames(token, opts) {
  const cache = {};
  return {
    cache,
    async need(ids) {
      for (const id of new Set(ids)) {
        if (cache[id]) continue;
        try {
          const j = await slackApi(token, 'users.info', { user: id }, opts);
          cache[id] = j.user?.profile?.display_name || j.user?.real_name || j.user?.name || id;
        } catch { cache[id] = id; }
      }
      return cache;
    },
  };
}

export const mentionedIds = (text) => [...String(text || '').matchAll(/<@([UW][A-Z0-9]+)/g)].map((m) => m[1]);

/**
 * Download one Slack file into dir as an UNTRUSTED file: 0600, never executable,
 * quarantine-flagged on macOS, size-capped. Never opened, unzipped or run here.
 * → { name, bytes, sha256 } or { skipped: why }
 */
export async function downloadFile(token, file, dir, localName, { maxBytes, fetchImpl = fetch } = {}) {
  if (!file?.url_private_download || ['tombstone', 'hidden_by_limit', 'external'].includes(file.mode)) return { skipped: `not downloadable (${file?.mode || 'no url'})` };
  if (maxBytes && file.size > maxBytes) return { skipped: `too large (${Math.round(file.size / 1048576)} MB)` };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const res = await fetchImpl(file.url_private_download, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) return { skipped: `download failed (http ${res.status})` };
  if (/text\/html/.test(res.headers.get('content-type') || '') && !/html/.test(file.mimetype || '')) return { skipped: 'download returned a login page (files:read scope missing?)' };
  const final = path.join(dir, localName);
  const tmp = `${final}.part`;
  const hash = createHash('sha256');
  let bytes = 0;
  const src = Readable.fromWeb(res.body);
  src.on('data', (c) => {
    bytes += c.length; hash.update(c);
    if (maxBytes && bytes > maxBytes) src.destroy(new Error('size cap'));
  });
  try {
    await pipeline(src, createWriteStream(tmp, { mode: 0o600 }));
  } catch (e) {
    return { skipped: e.message === 'size cap' ? 'too large' : `download failed (${e.message})` };
  }
  await chmod(tmp, 0o600);
  await rename(tmp, final);
  if (process.platform === 'darwin') {
    await new Promise((r) => execFile('xattr', ['-w', 'com.apple.quarantine', `0081;${Math.floor(Date.now() / 1000).toString(16)};chat-intake;`, final], () => r()));
  }
  const st = await stat(final);
  return { name: localName, bytes: st.size, sha256: hash.digest('hex') };
}

/**
 * Socket Mode connection with reconnect. Every envelope is ACKED FIRST (Slack
 * re-sends un-acked envelopes after ~3 s), then handed to onEvent(event, meta).
 * Slack refreshes sockets every few hours ("disconnect" frames) — that is normal.
 *
 * Reconnecting never waits for the old socket's `close` event: a half-dead TCP link
 * may never finish the close handshake (task #340 — 2.5 days silent with the process
 * alive). On `disconnect` the replacement is dialled at once and the old socket is
 * dropped; a watchdog revives any socket that is not OPEN; and when no `hello` arrives
 * for `maxDownMs`, or `connections.open` keeps failing (not an auth error), `exit(1)`
 * hands the restart to the service manager (launchd KeepAlive).
 * Slack's keep-alive pings are WebSocket control frames that Node's WebSocket answers
 * internally, so liveness is judged from what we can see (frames, socket state) plus the
 * caller's history sweep (`kick()` forces a reconnect when the sweep finds missed messages).
 */
export function socketMode({ appToken, onEvent, onState = () => {}, onHello = () => {}, log = console.log,
  WebSocketImpl = globalThis.WebSocket, fetchImpl = fetch, timers = globalThis, now = () => Date.now(),
  exit = (code) => process.exit(code), maxDownMs = 15 * 60e3, maxOpenFailures = 8, watchdogMs = 30e3, stuckMs = 30e3 } = {}) {
  let ws = null;
  let wsSince = 0;               // when the current socket was created
  let stopped = false;
  let backoff = 1000;
  let timer = null;
  let openFailures = 0;
  let downSince = now();         // null while connected (hello seen)
  let everConnected = false;

  const drop = (sock) => {
    if (!sock) return;
    try { sock.close(); } catch { /* already gone */ }
  };
  const lost = (why) => {
    if (downSince == null) downSince = now();
    onState('disconnected', why);
  };

  async function connect() {
    if (stopped) return;
    onState('connecting');
    let url;
    try {
      url = (await slackApi(appToken, 'apps.connections.open', {}, { fetchImpl })).url;
      openFailures = 0;
    } catch (e) {
      onState('error', e.message);
      log(`[chat-intake] connections.open failed: ${e.message}`);
      if (/invalid_auth|not_allowed_token_type|account_inactive|token_revoked/.test(e.message)) backoff = 5 * 60e3;
      else if (++openFailures >= maxOpenFailures) return giveUp(`connections.open failed ${openFailures}× in a row`);
      return retry();
    }
    if (stopped) return;
    const sock = new WebSocketImpl(url);
    ws = sock; wsSince = now();
    sock.addEventListener('message', (m) => {
      if (ws !== sock) return;                       // a replaced socket: ignore whatever it still says
      let msg;
      try { msg = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data)); } catch { return; }
      onState('frame');
      if (msg.envelope_id) { try { sock.send(JSON.stringify({ envelope_id: msg.envelope_id })); } catch { /* socket closing; Slack retries */ } }
      if (msg.type === 'hello') {
        backoff = 1000; downSince = null;
        const again = everConnected; everConnected = true;
        onState('connected');
        Promise.resolve(onHello({ reconnect: again })).catch((e) => log(`[chat-intake] after hello: ${e.message}`));
        return;
      }
      if (msg.type === 'disconnect') {
        log(`[chat-intake] slack asked to reconnect (${msg.reason}) — dialling a new socket`);
        replace(`disconnect (${msg.reason})`);
        return;
      }
      if (msg.type === 'events_api' && msg.payload?.event) {
        Promise.resolve(onEvent(msg.payload.event, { eventId: msg.payload.event_id, teamId: msg.payload.team_id, retry: msg.retry_attempt || 0 }))
          .catch((e) => log(`[chat-intake] event handler: ${e.message}`));
      }
    });
    sock.addEventListener('close', (e) => {
      if (ws !== sock) return;
      const why = `socket closed (code ${e?.code ?? '?'}${e?.reason ? `, ${e.reason}` : ''})`;
      log(`[chat-intake] ${why} — reconnecting`);
      ws = null; lost(why); retry();
    });
    sock.addEventListener('error', () => { /* close follows — and if it never does, the watchdog acts */ });
  }
  /** Forget the current socket (never wait for its close) and dial a new one now. */
  function replace(why) {
    const old = ws; ws = null;
    drop(old);
    lost(why);
    clear();
    backoff = 1000;
    connect();
  }
  function clear() { if (timer) { timers.clearTimeout(timer); timer = null; } }
  function retry() {
    if (stopped || timer) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 5 * 60e3);
    timer = timers.setTimeout(() => { timer = null; connect(); }, wait);
  }
  function giveUp(why) {
    log(`[chat-intake] link down — ${why}; exiting so the service manager restarts it`);
    stopped = true; clear(); timers.clearInterval(dog);
    drop(ws); ws = null;
    exit(1);
  }
  const OPEN = WebSocketImpl.OPEN ?? 1;
  const dog = timers.setInterval(() => {
    if (stopped) return;
    if (downSince != null && now() - downSince > maxDownMs) return giveUp(`no hello for ${Math.round((now() - downSince) / 60e3)} min`);
    if (timer) return;                                   // a retry is already scheduled
    if (!ws) return void retry();                        // nothing live and nothing pending
    if (ws.readyState !== OPEN && now() - wsSince > stuckMs) {
      log(`[chat-intake] socket stuck (readyState ${ws.readyState}) — reconnecting`);
      replace('stuck socket');
    }
  }, watchdogMs);
  connect();
  return {
    stop() { stopped = true; clear(); timers.clearInterval(dog); drop(ws); ws = null; },
    /** The caller saw evidence the link is dead (history had messages the socket never delivered). */
    kick(why = 'kicked') { if (!stopped) { log(`[chat-intake] ${why} — reconnecting`); replace(why); } },
  };
}
