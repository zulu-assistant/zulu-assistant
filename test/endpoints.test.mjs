// node --test "test/*.test.mjs" — endpoint cards: optional JSON-body judge (okPath/detailPath)
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { judgeBody, httpChecks } from '../src/collect.mjs';
import { endpointCard } from '../src/status.mjs';

const ep = { id: 'api', url: 'http://localhost:8080/health', okPath: 'tabs.ok', detailPath: 'tabs.failed' };

test('judgeBody: no okPath → neutral; true → ok; false → down with the failed list quoted', () => {
  assert.deepEqual(judgeBody({ id: 'plain' }, '{"ok":false}'), { okFlag: null, note: '' });
  assert.deepEqual(judgeBody(ep, '{"ok":true,"tabs":{"ok":true,"failed":[]}}'), { okFlag: true, note: 'tabs.ok true' });
  const r = judgeBody(ep, '{"ok":true,"tabs":{"ok":false,"failed":["ads","seo"]}}');
  assert.equal(r.okFlag, false);
  assert.equal(r.note, 'tabs.ok false (ads, seo)');
});

test('judgeBody: a map detail lists its keys; no detailPath → bare note', () => {
  const r = judgeBody({ ...ep, detailPath: 'tabs.errors' }, '{"tabs":{"ok":false,"errors":{"ads":"no payload"}}}');
  assert.equal(r.note, 'tabs.ok false (ads)');
  assert.equal(judgeBody({ ...ep, detailPath: undefined }, '{"tabs":{"ok":false}}').note, 'tabs.ok false');
});

test('judgeBody: non-JSON or an absent path is reported, never a failure', () => {
  assert.deepEqual(judgeBody(ep, '<html>'), { okFlag: null, note: 'tabs.ok unreadable (body not JSON)' });
  assert.deepEqual(judgeBody(ep, '{"ok":true}'), { okFlag: null, note: 'tabs.ok absent' });
  // a probe that has not run yet publishes tabs: null — absent, not down
  assert.equal(judgeBody(ep, '{"ok":true,"tabs":null}').okFlag, null);
});

// #814: a health endpoint whose /health answered 503 + status "degraded" read ok for seven weeks
const health = { id: 'svc', name: 'svc /health', url: 'http://localhost:8080/health', okPath: 'status', okValue: 'healthy', detailPath: 'services.message' };
const DEGRADED = '{"status":"degraded","services":{"vendor":"error","message":"Products endpoint unsuccessful"}}';
const HEALTHY = '{"status":"healthy","services":{"vendor":"ok"}}';

test('#814 judgeBody: okValue must equal; another value is down with its detail; absent stays a note', () => {
  assert.deepEqual(judgeBody(health, HEALTHY), { okFlag: true, note: 'status healthy' });
  assert.deepEqual(judgeBody(health, DEGRADED), { okFlag: false, note: 'status degraded (Products endpoint unsuccessful)' });
  assert.equal(judgeBody({ ...health, detailPath: undefined }, DEGRADED).note, 'status degraded');
  assert.deepEqual(judgeBody(health, '{"services":{}}'), { okFlag: null, note: 'status absent' });
  assert.equal(judgeBody(health, '<html>').okFlag, null);
  // a true where a string is wanted is not the value
  assert.equal(judgeBody(health, '{"status":true}').okFlag, false);
  // a present null is a value under okValue (down); without okValue it is "not run yet" (a note), as before
  assert.equal(judgeBody(health, '{"status":null}').okFlag, false);
  assert.equal(judgeBody(ep, '{"tabs":{"ok":null}}').okFlag, null);
});

test('#814 endpointCard: 5xx is down whatever the body; 1xx–4xx keep their meaning; unreached stays down', () => {
  const card = (r) => endpointCard({ id: 'x', name: 'x', ...r });
  // the seen case: 503 with the degraded body
  const seen = card({ up: true, code: 503, ...judgeBody(health, DEGRADED) });
  assert.equal(seen.status, 'down');
  assert.equal(seen.detail, 'HTTP 503 · status degraded (Products endpoint unsuccessful)');
  assert.equal(seen.label, 'endpoint:x');
  // a 5xx is not softened by a healthy body, nor by a plain card with no body judge
  assert.equal(card({ up: true, code: 503, ...judgeBody(health, HEALTHY) }).status, 'down');
  for (const code of [500, 502, 503, 504, 599]) assert.equal(card({ up: true, code, okFlag: null, note: '' }).status, 'down', String(code));
  // a degraded body on a 200 is down too
  assert.equal(card({ up: true, code: 200, ...judgeBody(health, DEGRADED) }).status, 'down');
  // redirects, a login wall, not found: up as before (site roots answer these)
  for (const code of [200, 204, 301, 307, 308, 401, 403, 404, 499]) assert.equal(card({ up: true, code, okFlag: null, note: '' }).status, 'ok', String(code));
  // not reached: down as before
  assert.deepEqual([card({ up: false, code: null, err: 'ECONNREFUSED' }).status, card({ up: false, code: null, err: 'ECONNREFUSED' }).detail], ['down', 'unreachable (ECONNREFUSED)']);
  assert.equal(card({ up: false, code: null }).detail, 'unreachable (timeout)');
});

test('#814 judgeBody: a path never resolves to something inherited, and an odd value never throws', () => {
  for (const p of ['constructor', 'toString', '__proto__', 'status.length']) {
    const r = judgeBody({ ...health, okPath: p }, '{"status":"healthy"}');
    assert.equal(r.okFlag, null, p);
  }
  assert.equal(judgeBody(health, '{"status":{"a":1}}').okFlag, false);
  assert.equal(judgeBody(health, '{"status":["degraded"]}').note.startsWith('status ["degraded"]'), true);
  // an odd detail never throws
  assert.equal(judgeBody(health, '{"status":"degraded","services":{"message":[{"toString":null}]}}').okFlag, false);
  assert.equal(judgeBody(health, '{"status":"degraded","services":{"message":12}}').note, 'status degraded (12)');
});

test('#814 httpChecks: a 503 whose body never ends is down within the limit, never a stalled poll', { timeout: 10_000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/hang') { res.writeHead(503, { 'content-type': 'application/json' }); res.write('{"status":"degr'); return; }
    if (req.url === '/hang200') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":'); return; }
    if (req.url === '/html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); return; }
    if (req.url === '/badgzip') { res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' }); res.end('not gzip at all'); return; }
    if (req.url === '/stream') { res.writeHead(200); res.write('x'); return; }   // a header-only check never reads it
    if (req.url === '/ok') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(HEALTHY); return; }
    res.writeHead(503, { 'content-type': 'application/json' }); res.end(DEGRADED);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const eps = [
      { ...health, id: 'hang', url: `${base}/hang`, everyPolls: 1 },
      { ...health, id: 'deg', url: `${base}/deg`, everyPolls: 1 },
      { ...health, id: 'ok', url: `${base}/ok`, everyPolls: 1 },
      { ...health, id: 'hang200', url: `${base}/hang200`, everyPolls: 1 },
      { ...health, id: 'html', url: `${base}/html`, everyPolls: 1 },
      { ...health, id: 'badgzip', url: `${base}/badgzip`, everyPolls: 1 },
      { id: 'stream', name: 'plain', url: `${base}/stream`, everyPolls: 1 },
    ];
    const t0 = Date.now();
    const r = await httpChecks(0, eps, { timeoutMs: 800, cache: new Map() });
    assert.ok(Date.now() - t0 < 5000, 'the poll was not stalled by the endless body');
    const byId = Object.fromEntries(r.map((x) => [x.id, endpointCard(x)]));
    assert.equal(byId.hang.status, 'down');
    assert.match(byId.hang.detail, /^HTTP 503/);
    assert.equal(byId.deg.status, 'down');
    assert.equal(byId.deg.detail, 'HTTP 503 · status degraded (Products endpoint unsuccessful)');
    assert.equal(byId.ok.status, 'ok');
    // a 200 whose judged body is cut off by the limit is down; a body that arrives but is not JSON is a note
    assert.equal(byId.hang200.status, 'down');
    assert.match(byId.hang200.detail, /^HTTP 200 · body not read within/);
    assert.equal(byId.html.status, 'ok');
    assert.equal(byId.html.detail, 'HTTP 200 · status unreadable (body not JSON)');
    // a body error that is not the time limit names itself
    assert.equal(byId.badgzip.status, 'down');
    assert.match(byId.badgzip.detail, /^HTTP 200 · body unreadable \(/);
    // a header-only check answers at once and does not wait for its body
    assert.deepEqual([byId.stream.status, byId.stream.detail], ['ok', 'HTTP 200']);
  } finally { server.closeAllConnections?.(); server.close(); }
});
