// Request source guards (extracted from server.mjs so they can be tested).

const ipOf = (req) => (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

// reachable from localhost and the private tailnet ONLY (Tailscale uses
// 100.64.0.0/10); every other source — LAN included — is refused
export function allowedSource(req) {
  const ip = ipOf(req);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  const m = ip.match(/^100\.(\d+)\./);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

// stricter: this Mac only (scripts, agents, Mission Control)
export function localOnly(req) {
  const ip = ipOf(req);
  return ip === '127.0.0.1' || ip === '::1';
}
