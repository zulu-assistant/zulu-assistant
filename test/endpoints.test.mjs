// node --test "test/*.test.mjs" — endpoint cards: optional JSON-body judge (okPath/detailPath)
import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeBody } from '../src/collect.mjs';

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
