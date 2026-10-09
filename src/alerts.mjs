// Bridge: fleet problems -> escalation ladder.
//   tier 0 (instant): cmux Feed notification (osascript fallback)
//   tier 1 (red > emailAfterMin): email — SMTP_HOST/PORT/USER/PASS → ALERT_EMAIL_TO
//   tier 2 (critical set, red > smsAfterMin): SMS webhook — SMS_WEBHOOK_URL/KEY → SMS_ALERT_TO
// All from data/secrets.env (src/config.mjs loadSecrets); a missing key = that tier is off.
// Dedupes on status transitions; re-alerts every SETTINGS.realertHours while red.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SETTINGS, OWNER, loadSecrets } from './config.mjs';

const STATE_FILE = fileURLToPath(new URL('../data/alert-state.json', import.meta.url));
const ALERTING = new Set(['failed', 'overdue', 'down']);
let memState = null; // dedupe survives even if the disk write fails

let cmuxPw = null;
export async function cmuxPassword() {
  if (cmuxPw === null) {
    // board's own copy first — cmux migrates the password OUT of cmux.json
    // into its private store on load, so the json copy is transient
    try { cmuxPw = (await readFile(fileURLToPath(new URL('../data/cmux-socket-password', import.meta.url)), 'utf8')).trim(); }
    catch {
      try {
        const cfg = JSON.parse(await readFile(`${process.env.HOME}/.config/cmux/cmux.json`, 'utf8'));
        cmuxPw = cfg.automation?.socketPassword || '';
      } catch { cmuxPw = ''; }
    }
  }
  return cmuxPw;
}

export async function notify(title, subtitle, body) {
  const pw = await cmuxPassword();
  return new Promise((resolve) => {
    execFile(SETTINGS.cmuxBin, ['notify', '--title', title, '--subtitle', subtitle, '--body', body],
      { timeout: 5000, killSignal: 'SIGKILL', env: { ...process.env, CMUX_SOCKET_PASSWORD: pw } }, (err) => {
        if (!err) return resolve('cmux');
        execFile('osascript', ['-e',
          `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)} subtitle ${JSON.stringify(subtitle)}`],
          { timeout: 5000, killSignal: 'SIGKILL' }, () => resolve('osascript'));
      });
  });
}

async function loadState() {
  if (memState) return memState;
  try { memState = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { memState = {}; }
  return memState;
}

export async function sendEmail(subject, body) {
  const cfg = loadSecrets();
  if (!cfg.SMTP_HOST || !cfg.SMTP_USER || !cfg.SMTP_PASS) return false;
  const script = `
import smtplib, ssl, os, sys
from email.message import EmailMessage
m = EmailMessage()
m["From"] = os.environ["U"]; m["To"] = os.environ["T"]; m["Subject"] = os.environ["S"]
m.set_content(sys.stdin.read())
with smtplib.SMTP(os.environ["H"], int(os.environ["P"]), timeout=20) as s:
    s.starttls(context=ssl.create_default_context())
    s.login(os.environ["U"], os.environ["PW"]); s.send_message(m)
print("sent")`;
  return new Promise((resolve) => {
    const child = execFile('/usr/bin/python3', ['-c', script], {
      timeout: 30000, killSignal: 'SIGKILL',
      env: {
        H: cfg.SMTP_HOST, P: cfg.SMTP_PORT || '587',
        U: cfg.SMTP_USER, PW: cfg.SMTP_PASS,
        T: cfg.ALERT_EMAIL_TO || cfg.SMTP_USER, S: subject,
      },
    }, (err, stdout) => resolve(!err && /sent/.test(String(stdout))));
    child.stdin.end(body);
  });
}

async function sendSms(message) {
  const cfg = loadSecrets();
  if (!cfg.SMS_ALERT_TO || !cfg.SMS_WEBHOOK_URL || !cfg.SMS_WEBHOOK_KEY) return false;
  let ok = true;
  for (const to of cfg.SMS_ALERT_TO.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(cfg.SMS_WEBHOOK_URL, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-internal-key': cfg.SMS_WEBHOOK_KEY },
        body: JSON.stringify({ to, message: `[Ops Board] ${message}` }),
      }).finally(() => clearTimeout(t));
      ok = ok && res.ok;
    } catch { ok = false; }
  }
  return ok;
}

export async function processAlerts(snap) {
  const state = await loadState();
  const nowMs = Date.now();
  const esc = SETTINGS.escalation;
  for (const job of snap.jobs) {
    const prev = state[job.label] || { status: 'ok', lastAlertAt: 0 };
    const isRed = ALERTING.has(job.status);
    const wasRed = ALERTING.has(prev.status);
    if (isRed && (!wasRed || nowMs - prev.lastAlertAt > SETTINGS.realertHours * 3600000)) {
      await notify('Ops Board', `${job.name}: ${job.status.toUpperCase()}`, job.detail || job.status);
      state[job.label] = {
        ...prev, status: job.status, lastAlertAt: nowMs,
        firstRedAt: wasRed ? (prev.firstRedAt || nowMs) : nowMs,
      };
    } else if (!isRed && wasRed) {
      await notify('Ops Board', `${job.name}: recovered`, job.detail || 'back to OK');
      state[job.label] = { status: job.status, lastAlertAt: 0 };
    } else {
      state[job.label] = { ...prev, status: job.status };
    }

    // escalation tiers while red
    const st = state[job.label];
    const redMin = st.firstRedAt ? (nowMs - st.firstRedAt) / 60000 : 0;
    if (isRed && redMin >= esc.emailAfterMin && !st.emailedAt) {
      const ok = await sendEmail(
        `[Ops Board] ${job.name} ${job.status.toUpperCase()} for ${Math.round(redMin)} min`,
        `${job.name} (${job.label})\nStatus: ${job.status}\nDetail: ${job.detail}\n` +
        `Red since: ${new Date(st.firstRedAt).toLocaleString()}\n\nBoard: http://localhost:3210`);
      if (ok) st.emailedAt = nowMs;
    }
    if (isRed && esc.criticalSms.includes(job.label) && redMin >= esc.smsAfterMin && !st.smsAt) {
      const ok = await sendSms(`${job.name} ${job.status.toUpperCase()}: ${job.detail}`);
      if (ok) st.smsAt = nowMs;
    }
    if (!isRed) { delete st.firstRedAt; delete st.emailedAt; delete st.smsAt; }
  }
  memState = state;
  await writeFile(STATE_FILE, JSON.stringify(state, null, 1)).catch(() => {});
}

// Morning fleet briefing — called by the server's poll loop once per day.
export function workLines(work) {
  if (!work) return [];
  const c = work.counts;
  const row = (t) => `  #${t.id} ${t.title} — ${t.owner || 'unowned'}${t.blocked_on?.length ? ` (on ${t.blocked_on.join(', ')})` : ''}`;
  const out = ['', `WORK (agent mesh): ${c.open} open · ${c.blocked} blocked · ${c.needsApproval} awaiting ${OWNER.name} · ${c.closed24h} closed in 24h`];
  if (work.needsApproval.length) out.push(`  Awaiting ${OWNER.name} (approve on the board → WORK):`, ...work.needsApproval.map(row));
  if (work.blocked.length) out.push('  Blocked:', ...work.blocked.map(row));
  if (work.open.length) out.push('  Open / in progress:', ...work.open.slice(0, 15).map(row));
  if (work.closed24h.length) out.push('  Closed yesterday:', ...work.closed24h.map(row));
  return out;
}

export async function sendDigest(snap, strips, work = null) {
  const lines = [`Fleet: ${snap.counts.ok}/${snap.counts.total} healthy · ` +
    `${snap.counts.agents} active agent session(s)`];
  const reds = snap.jobs.filter((j) => j.status !== 'ok');
  lines.push('', reds.length ? 'NEEDS ATTENTION:' : 'Nothing needs attention. ✔');
  for (const j of reds) lines.push(`  ${j.status.toUpperCase().padEnd(8)} ${j.name} — ${j.detail}`);
  lines.push('', 'Recent flaps (non-ok samples in history):');
  let flaps = 0;
  for (const j of snap.jobs) {
    const bad = (strips[j.label] || []).filter((s) => s !== 'ok').length;
    if (bad > 0 && j.status === 'ok') { lines.push(`  ${j.name}: ${bad} sample(s)`); flaps += 1; }
  }
  if (!flaps) lines.push('  none');
  lines.push(...workLines(work));
  lines.push('', `Board: http://localhost:3210 · ${new Date().toLocaleString()}`);
  return sendEmail(`[Ops Board] Morning fleet briefing — ${snap.counts.ok}/${snap.counts.total} healthy`, lines.join('\n'));
}
