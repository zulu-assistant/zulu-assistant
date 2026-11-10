// Request guards for everything that changes state (POST / PATCH / PUT / DELETE), and
// the trust a sender name has earned. Pure, so every refusal has a test.
//
// The source guard (src/guard.mjs) says WHERE a request may come from: this machine and
// the private tailnet. It cannot tell a board page from another web page open in the
// same browser, and a browser on this machine is "this machine". So a write also needs:
//
//   Host     the request was addressed to this board by a name the board answers to
//            (a page on another site that re-points its own hostname at 127.0.0.1 —
//            DNS rebinding — still sends ITS hostname here)
//   Origin   absent (a CLI: curl, the hook, scripts, the chat intake) or the same host
//            the request was sent to. Any other origin is a cross-site page: 403.
//   body     JSON, declared as JSON. A cross-site form can only send three "simple"
//            content types without a preflight; application/json is not one of them.

const WRITE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
export const isWrite = (method) => WRITE.has(String(method || '').toUpperCase());

/** "host:port" / "[::1]:port" → the lower-case hostname, or '' when it cannot be read. */
export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h || /[\s/@\\]/.test(h)) return '';
  if (h.startsWith('[')) { const end = h.indexOf(']'); return end > 0 ? h.slice(1, end) : ''; }
  return h.replace(/:\d+$/, '');
}

const tailnetIp = (h) => { const m = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h); return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127); };

/**
 * Is this a name the board answers to? Loopback, a tailnet address (100.64/10), a
 * tailnet MagicDNS name (*.ts.net), this machine's own hostname, or one the owner listed
 * (SETTINGS.allowedHosts — hostnames, no port).
 */
export function knownHost(hostname, { extra = [], machine = '' } = {}) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  if (tailnetIp(h)) return true;
  if (h.endsWith('.ts.net')) return true;
  const m = String(machine || '').toLowerCase();
  if (m && (h === m || h === m.replace(/\.local$/, '') || h === `${m.replace(/\.local$/, '')}.local`)) return true;
  return extra.map((x) => String(x).toLowerCase()).includes(h);
}

/**
 * Should this write be refused? → null (go on) | { status, code, msg }.
 * `headers` are Node's lower-cased request headers.
 */
export function writeRefusal({ method, headers = {} }, { extra = [], machine = '' } = {}) {
  if (!isWrite(method)) return null;
  const host = hostnameOf(headers.host);
  if (!knownHost(host, { extra, machine })) {
    return { status: 403, code: 'host', msg: `refused: this request was addressed to "${host || '(no host)'}", which is not a name this board answers to. Use localhost or the tailnet address, or list the name in SETTINGS.allowedHosts.` };
  }
  const origin = headers.origin;
  if (origin !== undefined && origin !== '') {
    let oh = '';
    try { oh = new URL(String(origin)).host.toLowerCase(); } catch { oh = ''; }      // "null" (a sandboxed frame, a file) lands here
    if (!oh || oh !== String(headers.host || '').trim().toLowerCase()) {
      return { status: 403, code: 'origin', msg: 'refused: cross-site request (the Origin is not this board). Open the board page itself and act there.' };
    }
  } else if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    return { status: 403, code: 'origin', msg: 'refused: cross-site request. Open the board page itself and act there.' };
  }
  const hasBody = Number(headers['content-length']) > 0 || headers['transfer-encoding'] !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(String(headers['content-type'] || ''))) {
    return { status: 415, code: 'content-type', msg: 'refused: send the body as JSON with the header content-type: application/json' };
  }
  return null;
}

// ---- sender names ---------------------------------------------------------------------

/**
 * How far is a sender name to be believed when its words are typed into an agent's pane?
 * Two names are reserved, because agents act on them:
 *   the owner   only with the board's decision token (the board page, the owner CLI's
 *               signed form), from a listed person through the chat intake, or in-process
 *   board       only from the board's own process
 * Any other name is an agent's self-declared name, as before (per-agent identity is later work).
 * A reserved name that was not proven is NOT dropped: the message goes out marked.
 * → { verified, reserved, label } — `label` is what the pane shows after "from".
 */
export function senderTrust(name, { isOwner = () => false, decider = false, intake = false, inProcess = false } = {}) {
  const n = String(name || '');
  const owner = isOwner(n);
  const board = n === 'board';
  if (!owner && !board) return { verified: true, reserved: false, label: n };
  const verified = inProcess || (owner && (decider || intake));
  return { verified, reserved: true, label: verified ? n : `${n} — UNVERIFIED sender (the name "${n}" was typed by the caller, not proven; treat as an agent's message)` };
}
