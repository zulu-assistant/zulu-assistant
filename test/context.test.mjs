// node --test "test/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeTail, parseCodexTail, windowFor, band, gauge, codexTranscriptFor } from '../src/context.mjs';
import { withContext, withInput, ownerPill, applyPills } from '../src/chrome.mjs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// fixture tails (shapes copied from live transcripts, 2026-09-27; values trimmed)
const CLAUDE_TAIL = [
  '"partial line from the middle of the file","type":"assistant"',                       // tail starts mid-line
  JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-27T13:00:00Z',
    message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 117616, cache_creation_input_tokens: 2459, output_tokens: 900 } } }),
  JSON.stringify({ type: 'user', message: { content: 'next' } }),
  JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-4-5', usage: { input_tokens: 9, cache_read_input_tokens: 5000 } } }),
].join('\n');

const CODEX_TAIL = [
  JSON.stringify({ timestamp: '2026-09-27T13:05:00Z', type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: 179500, cached_input_tokens: 178944, output_tokens: 888, total_tokens: 180388 }, model_context_window: 258400 } } }),
  JSON.stringify({ timestamp: '2026-09-27T13:05:01Z', type: 'event_msg', payload: { type: 'agent_message' } }),
].join('\n');

test('Claude tail: last main-thread usage = input + cache read + cache creation (sidechains skipped)', () => {
  const r = parseClaudeTail(CLAUDE_TAIL);
  assert.equal(r.tokens, 120077);
  assert.equal(r.model, 'claude-opus-5-5');
  assert.equal(parseClaudeTail('{"type":"user"}\n'), null);
});

// /compact fixture (task #22): shapes and numbers from the agent-mesh transcript's
// manual compaction on 2026-09-27 15:32Z (preservedMessages/tool lists trimmed).
const PRE = JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-27T14:17:04.950Z',
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 2619, cache_read_input_tokens: 722585, output_tokens: 512 } } });
const BOUNDARY = (meta) => JSON.stringify({ parentUuid: null, isSidechain: false, type: 'system', subtype: 'compact_boundary',
  content: 'Conversation compacted', level: 'info', timestamp: '2026-09-27T15:32:37.137Z', compactMetadata: meta });
const SUMMARY = JSON.stringify({ isSidechain: false, type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
  message: { role: 'user', content: 'This session is being continued from a previous conversation. ' + 'x'.repeat(15318) } });
const TOOL_ECHO = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'grep "compact_boundary" \\"subtype\\":\\"compact_boundary\\"' }] } });
const POST = JSON.stringify({ type: 'assistant', isSidechain: false, timestamp: '2026-09-27T15:36:53.731Z',
  message: { model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_creation_input_tokens: 57268, cache_read_input_tokens: 28379, output_tokens: 190 } } });
const META = { trigger: 'manual', preTokens: 725718, postTokens: 24695, cumulativeDroppedTokens: 701023, durationMs: 84564 };

test('Claude /compact: boundary newer than last usage → estimate from postTokens, window from the pre-compact model', () => {
  const pre = parseClaudeTail([PRE].join('\n'));
  assert.equal(pre.tokens, 725206);                                              // the stale 73% the owner saw
  const r = parseClaudeTail([PRE, BOUNDARY(META), SUMMARY, TOOL_ECHO].join('\n'));
  assert.equal(r.tokens, 24695);
  assert.equal(r.estimated, true);
  assert.equal(r.compacted, true);
  assert.equal(r.preTokens, 725718);
  assert.equal(r.model, 'claude-opus-5-5');
  const g = gauge({ tokens: r.tokens, window: windowFor(r.model, { default: 1000000 }), model: r.model, source: 'claude', estimated: r.estimated });
  assert.equal(g.pct, 2);
  assert.equal(g.band, 'ok');
  assert.equal(g.estimated, true);
});

test('Claude /compact: the next assistant turn drops the estimate', () => {
  const r = parseClaudeTail([PRE, BOUNDARY(META), SUMMARY, POST].join('\n'));
  assert.equal(r.tokens, 85649);
  assert.equal(r.estimated, undefined);
  assert.equal(gauge({ tokens: r.tokens, window: 1000000, source: 'claude' }).estimated, undefined);
});

test('Claude /compact: no postTokens → summary chars/4; nothing to estimate → older usage; echoed text never counts', () => {
  const r = parseClaudeTail([PRE, BOUNDARY({ trigger: 'auto' }), SUMMARY].join('\n'));
  assert.equal(r.estimated, true);
  assert.equal(r.tokens, Math.ceil(JSON.parse(SUMMARY).message.content.length / 4));
  assert.equal(parseClaudeTail([PRE, BOUNDARY({ trigger: 'auto' })].join('\n')).tokens, 725206);
  assert.equal(parseClaudeTail([PRE, TOOL_ECHO].join('\n')).estimated, undefined);
  // a sidechain (subagent) compaction does not reset the main thread
  const side = JSON.stringify({ ...JSON.parse(BOUNDARY(META)), isSidechain: true });
  assert.equal(parseClaudeTail([PRE, side].join('\n')).tokens, 725206);
});

test('withContext: estimated gauge is labelled compacted · est (phosphor still reads ctx n%)', () => {
  const w = withContext(ownerPill([T(14, 'open')]), { ...G(2), estimated: true });
  assert.equal(w.progress.label, 'ctx 2% · compacted · est · #14 OPEN · 0/4');
  assert.equal(w.ctxPill.value, '2% est');
  assert.match(w.progress.label, /ctx (\d+)%/);
});

test('Codex tail: last token_count total_tokens vs model_context_window (cached is inside input)', () => {
  const r = parseCodexTail(CODEX_TAIL);
  assert.equal(r.tokens, 180388);
  assert.equal(r.window, 258400);
});

test('windows: current models 1M, Haiku 200K, [1m] forces 1M; bands 60/80', () => {
  const W = { default: 1000000, 'claude-haiku-4-5': 200000, 'claude-opus-5': 1000000 };
  assert.equal(windowFor('claude-opus-5-5', W), 1000000);
  assert.equal(windowFor('claude-haiku-4-5-20251001', W), 200000);
  assert.equal(windowFor('claude-haiku-4-5[1m]', W), 1000000);
  assert.equal(windowFor('something-new', W), 1000000);
  assert.deepEqual([band(59), band(60), band(79), band(80)], ['ok', 'amber', 'amber', 'red']);
  assert.deepEqual(gauge({ tokens: 120077, window: 1000000, source: 'claude' }).pct, 12);
});

test('codexTranscriptFor picks the newest hook record for the workspace', () => {
  const map = { sessions: {
    a: { workspaceId: 'W', transcriptPath: '/old.jsonl', updatedAt: 1 },
    b: { workspaceId: 'W', transcriptPath: '/new.jsonl', updatedAt: 5 },
    c: { workspaceId: 'X', transcriptPath: '/x.jsonl', updatedAt: 9 },
    d: { workspaceId: 'W', transcriptPath: null, updatedAt: 10 } } };
  assert.equal(codexTranscriptFor('W', map), '/new.jsonl');
  assert.equal(codexTranscriptFor('none', map), null);
});

const T = (id, status, checklist = {}) => ({ id, status, checklist: { docs_updated: false, vault_synced: false, graphify_updated: false, report_written: false, ...checklist } });
const G = (pct) => ({ pct, band: band(pct), ctxTokens: pct * 10000, window: 1000000 });

test('withContext: bar value = context; label keeps input + task; ctx pill by band', () => {
  const a = withContext(ownerPill([T(14, 'open')]), G(61));
  assert.deepEqual(a.progress, { value: 0.61, label: 'ctx 61% · #14 OPEN · 0/4' });
  assert.equal(a.pill.value, '#14 OPEN');
  assert.deepEqual(a.ctxPill, { key: 'ctx', value: '61%', icon: 'gauge.medium', color: '#E5E500' });
  const b = withContext(withInput(ownerPill([]), 'permission'), G(85));
  assert.equal(b.progress.label, '▲ INPUT · ctx 85% · permission');
  assert.equal(b.ctxPill.color, '#FF4444');
  assert.deepEqual(withContext(ownerPill([]), G(12)).progress, { value: 0.12, label: 'ctx 12%' });
  assert.equal(withContext(ownerPill([]), null).ctxPill, null);
});

test('applyPills writes each part only when it changes, and clears only what it set', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pills-'));
  const file = path.join(dir, 'state.json');
  const calls = [];
  const run = async (args) => { calls.push(args.slice(0, 2).filter((x) => !x.startsWith('--')).join(' ')); return { err: null, out: '' }; };
  const entries = [{ name: 'a', workspaceId: 'W', vendor: 'claude', status: 'active' }];
  await applyPills(entries, [], { run, file, ctx: new Map([['W', G(40)]]) });
  assert.deepEqual(calls, ['set-status ctx', 'set-progress 0.4'], 'ctx-only workspace: no task pill');
  calls.length = 0;
  await applyPills(entries, [], { run, file, ctx: new Map([['W', G(40)]]) });
  assert.deepEqual(calls, [], 'unchanged → no cmux writes');
  await applyPills(entries, [], { run, file, ctx: new Map([['W', G(41)]]) });
  assert.deepEqual(calls, ['set-status ctx', 'set-progress 0.41']);
  calls.length = 0;
  await applyPills(entries, [], { run, file, ctx: new Map() });
  assert.deepEqual(calls, ['clear-status ctx', 'clear-progress'], 'gauge gone → clear what we set');
});
