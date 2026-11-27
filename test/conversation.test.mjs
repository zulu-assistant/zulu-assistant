// Conversation view (src/conversation.mjs + public/conversation.js, /?conversation=<id> + GET /api/conversation):
// the last turns of one agent session from its transcript tail, read-only. The parser against fixture
// transcripts, what is never shown, where a transcript may be read from, the page render, the switch.
import './temp-root.mjs';   // first: one temp folder per test process, removed at exit (#665)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  conversationMode, validSessionId, safeMessage, toolPart, cleanUserText, parseConversation, transcriptOf, insideTranscripts,
  createConversations, demoConversation, WITHHELD, COMPACTED, MAX_ENTRIES, MAX_TEXT, MAX_NOTE, WHY, TAIL_STEPS, ENOUGH_ENTRIES,
} from '../src/conversation.mjs';
import { transcriptFor } from '../src/sessions-plain.mjs';
import { demoEnv, freePort } from './demo-board.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(new URL(`../${p}`, import.meta.url), 'utf8');
const ctx = {};
vm.runInNewContext(await read('public/conversation.js'), { globalThis: ctx });
const view = ctx.ConversationView;

const SECRET = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123';
const ID = '0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9';
const T = (n) => `2026-01-20T12:${String(n).padStart(2, '0')}:00.000Z`;

// transcript lines as Claude Code writes them (the fields this reader looks at)
const user = (content, over = {}) => JSON.stringify({ type: 'user', timestamp: T(over.n ?? 0), message: { role: 'user', content }, ...over, n: undefined });
const asst = (content, over = {}) => JSON.stringify({ type: 'assistant', timestamp: T(over.n ?? 0), message: { role: 'assistant', model: 'm', content, usage: { input_tokens: 5 } }, ...over, n: undefined });
const text = (t) => ({ type: 'text', text: t });
const tool = (name, input) => ({ type: 'tool_use', id: 'toolu_1', name, input });
const lines = (...l) => l.join('\n') + '\n';

test('conversationMode: only "on" turns the view on; a session id has no slash, dot or space', () => {
  assert.equal(conversationMode(undefined), 'off');
  assert.equal(conversationMode({ mode: 'observe' }), 'off');
  assert.equal(conversationMode({ mode: 'on' }), 'on');
  assert.ok(validSessionId(ID));
  assert.ok(validSessionId('demo-4'));
  for (const bad of ['', null, '..', '../x', 'a/b', 'a.b', 'a b', '-abc', 'x'.repeat(65), 'abc%2F', 'ab']) assert.equal(validSessionId(bad), false, String(bad));
});

test('parse: what was said, what the agent answered, in order; lines the agent wrote in a row are one entry', () => {
  const { entries, cut } = parseConversation(lines(
    user('Find out why the export failed.', { n: 1 }),
    asst([text('Looking at the log.')], { n: 2 }),
    asst([tool('Bash', { command: 'tail -50 /var/log/export.log', description: 'Show the end of the export log' })], { n: 3 }),
    user([{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'row 41: bad date RESULT-TEXT' }], { n: 4 }),
    asst([text('A date with no year stops the run.')], { n: 5 }),
    user('Skip such rows.', { n: 6 }),
    asst([text('Done.')], { n: 7 }),
  ));
  assert.equal(cut, false);
  assert.deepEqual(entries.map((e) => e.role), ['user', 'agent', 'user', 'agent']);
  assert.equal(entries[0].text, 'Find out why the export failed.');
  assert.equal(entries[0].via, 'typed');
  assert.deepEqual(entries[1].parts, [
    { kind: 'text', text: 'Looking at the log.' },
    { kind: 'tool', name: 'Bash', note: 'Show the end of the export log' },
    { kind: 'text', text: 'A date with no year stops the run.' },
  ]);
  assert.equal(entries[1].at, T(5), 'the entry carries the time of its last line');
  assert.equal(entries[3].parts[0].text, 'Done.');
});

test('never shown: a command, any other tool input, a tool result, thinking, a helper agent\'s lines, other line kinds', () => {
  const raw = lines(
    user('go', { n: 1 }),
    asst([{ type: 'thinking', thinking: 'THINKING-TEXT' }, tool('Bash', { command: 'curl -H "x: COMMAND-TEXT" https://example.test', description: 'Call the service' }),
      tool('Write', { file_path: '/tmp/FILE-PATH', content: 'FILE-CONTENT' }), tool('mcp__shop__update', { id: 'INPUT-ID' })], { n: 2 }),
    user([{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'RESULT-TEXT' }] }], { n: 3 }),
    asst([text('SIDECHAIN-TEXT')], { n: 4, isSidechain: true }),
    user('SIDECHAIN-ASK', { n: 4, isSidechain: true }),
    user('META-TEXT', { n: 5, isMeta: true }),
    JSON.stringify({ type: 'api-request-blob', message: { role: 'assistant', content: [text('BLOB-TEXT')] } }),
    JSON.stringify({ type: 'attachment', attachment: { text: 'ATTACHMENT-TEXT "type":"user"' } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'SYSTEM-TEXT' }),
    '{"type":"user","message":{"content":"HALF-A-LINE',
    asst([text('The service answered.')], { n: 6 }),
  );
  const out = JSON.stringify(parseConversation(raw));
  for (const never of ['THINKING-TEXT', 'COMMAND-TEXT', 'FILE-PATH', 'FILE-CONTENT', 'INPUT-ID', 'RESULT-TEXT', 'SIDECHAIN-TEXT', 'SIDECHAIN-ASK', 'META-TEXT', 'BLOB-TEXT', 'ATTACHMENT-TEXT', 'SYSTEM-TEXT', 'HALF-A-LINE'])
    assert.ok(!out.includes(never), `${never} is in the output`);
  const { entries } = parseConversation(raw);
  assert.deepEqual(entries[1].parts, [
    { kind: 'tool', name: 'Bash', note: 'Call the service' },
    { kind: 'tool', name: 'Write', note: '' },
    { kind: 'tool', name: 'mcp__shop__update', note: '' },
    { kind: 'text', text: 'The service answered.' },
  ]);
});

test('secrets: a paragraph that looks like a credential is withheld and the rest of the message stays; a tool description too', () => {
  const { entries } = parseConversation(lines(
    user(`Use this.\n\nexport API_KEY=${SECRET}\n\nThen run the import.`, { n: 1 }),
    asst([text(`The key is ${SECRET}.\n\nThe import ran.`), tool('Bash', { description: `Call with ${SECRET}` })], { n: 2 }),
  ));
  assert.equal(entries[0].text, `Use this.\n\n${WITHHELD}\n\nThen run the import.`);
  assert.equal(entries[1].parts[0].text, `${WITHHELD}\n\nThe import ran.`);
  assert.equal(entries[1].parts[1].note, WITHHELD);
  assert.ok(!JSON.stringify(entries).includes(SECRET));
});

test('safeMessage and toolPart: long text is cut, a strange tool name is not repeated, a non-string description is dropped', () => {
  assert.equal(safeMessage('x'.repeat(MAX_TEXT + 500)).length, MAX_TEXT);
  assert.equal(safeMessage('a  \r\n\r\n\r\n b'), 'a\n\n b');
  assert.equal(safeMessage(''), '');
  assert.equal(toolPart({ name: '<img src=x>', input: {} }).name, 'a tool');
  assert.equal(toolPart({ name: 'Bash', input: { description: { nested: 'x' } } }).note, '');
  assert.equal(toolPart({ name: 'Bash', input: { description: 'd'.repeat(500) } }).note.length, MAX_NOTE);
  assert.equal(toolPart({ name: 'Bash', input: { description: 'two\nlines   here' } }).note, 'two lines here');
  assert.deepEqual(toolPart({ name: 'Bash' }), { kind: 'tool', name: 'Bash', note: '' });
});

test('what was said to the agent: the harness\'s reminder blocks are removed, a slash command reads as typed, harness notices are left out, a mesh message is marked', () => {
  assert.equal(cleanUserText('<system-reminder>REMINDER</system-reminder>\nFix the test.\n<system-reminder>two</system-reminder>'), 'Fix the test.');
  assert.equal(cleanUserText('<command-message>compact</command-message>\n<command-name>/compact</command-name>\n<command-args>keep the plan</command-args>'), '/compact keep the plan');
  assert.equal(cleanUserText('<command-name>/clear</command-name>'), '/clear');
  assert.equal(cleanUserText('<local-command-stdout>Compacted</local-command-stdout>'), '');
  assert.equal(cleanUserText('<task-notification>agent 3 finished</task-notification>'), '');
  assert.equal(cleanUserText('<system-reminder>only this</system-reminder>'), '');
  const { entries } = parseConversation(lines(
    user('<system-reminder>only this</system-reminder>', { n: 1 }),
    user([text('[mesh] from coordinator (task #12): check the queue'), text('<system-reminder>x</system-reminder>')], { n: 2 }),
    user('<local-command-stdout>ok</local-command-stdout>', { n: 3 }),
  ));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].via, 'mesh');
  assert.equal(entries[0].text, '[mesh] from coordinator (task #12): check the queue');
});

test('a compaction is one notice, and its summary text is not shown', () => {
  const { entries } = parseConversation(lines(
    asst([text('before')], { n: 1 }),
    user('SUMMARY-TEXT of everything so far', { n: 2, isCompactSummary: true }),
    asst([text('after')], { n: 3 }),
  ));
  assert.deepEqual(entries.map((e) => e.role), ['agent', 'note', 'agent']);
  assert.equal(entries[1].text, COMPACTED);
  assert.ok(!JSON.stringify(entries).includes('SUMMARY-TEXT'));
});

test('the limit keeps the newest entries and says older ones were left out', () => {
  const many = [];
  for (let i = 0; i < MAX_ENTRIES + 6; i += 1) many.push(i % 2 ? asst([text(`a${i}`)], { n: i % 60 }) : user(`u${i}`, { n: i % 60 }));
  const { entries, cut } = parseConversation(lines(...many));
  assert.equal(entries.length, MAX_ENTRIES);
  assert.equal(cut, true);
  assert.equal(entries.at(-1).parts[0].text, `a${MAX_ENTRIES + 5}`);
  assert.equal(parseConversation('').entries.length, 0);
  assert.equal(parseConversation(null).cut, false);
});

// ---- where a transcript may be read from ----
async function home() {
  const h = await mkdtemp(path.join(os.tmpdir(), 'conversation-home-'));
  const cwd = path.join(h, 'work', 'my repo');
  const file = transcriptFor(h, cwd, ID);
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.join(h, '.claude', 'sessions'), { recursive: true });
  await writeFile(file, lines(user('hello', { n: 1 }), asst([text('hi')], { n: 2 })));
  return { h, cwd, file, registryDir: path.join(h, '.claude', 'sessions'), root: path.join(h, '.claude', 'projects') };
}

test('the transcript is found through the session map, else the registry; the id is compared, never joined into a path', async () => {
  const x = await home();
  const map = path.join(x.h, 'map.json');
  await writeFile(map, JSON.stringify({ sessions: { [ID]: { transcriptPath: x.file } } }));
  assert.equal(await transcriptOf(ID, { cmuxMap: map, registryDir: x.registryDir, home: x.h }), x.file);
  assert.equal(await transcriptOf(ID, { cmuxMap: null, registryDir: x.registryDir, home: x.h }), null, 'no record of it anywhere');
  await writeFile(path.join(x.registryDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: ID, cwd: x.cwd }));
  await writeFile(path.join(x.registryDir, 'half.json'), '{"pid":');
  assert.equal(await transcriptOf(ID, { cmuxMap: null, registryDir: x.registryDir, home: x.h }), x.file);
  assert.equal(await transcriptOf(ID, { cmuxMap: path.join(x.h, 'absent.json'), registryDir: x.registryDir, home: x.h }), x.file);
  for (const bad of ['../../etc/passwd', 'constructor', '__proto__', 'a/b']) assert.equal(await transcriptOf(bad, { cmuxMap: map, registryDir: x.registryDir, home: x.h }), null, bad);
});

test('a path outside the transcripts folder is refused: a record that names another file, a link that leads out, a file that is not a transcript', async () => {
  const x = await home();
  const outside = path.join(x.h, 'secrets.jsonl');
  await writeFile(outside, lines(user('OUTSIDE-TEXT', { n: 1 })));
  assert.equal(await insideTranscripts(x.file, x.root), await insideTranscripts(x.file, x.root));
  assert.ok(await insideTranscripts(x.file, x.root));
  assert.equal(await insideTranscripts(outside, x.root), null);
  assert.equal(await insideTranscripts(path.join(x.root, '..', '..', 'secrets.jsonl'), x.root), null);
  const link = path.join(path.dirname(x.file), 'link.jsonl');
  await symlink(outside, link);
  assert.equal(await insideTranscripts(link, x.root), null, 'a link out of the folder');
  const notes = path.join(path.dirname(x.file), 'notes.txt');
  await writeFile(notes, 'x');
  assert.equal(await insideTranscripts(notes, x.root), null);
  assert.equal(await insideTranscripts(path.join(x.root, 'absent.jsonl'), x.root), null);
  // through the reader: a session map that names the outside file gets "not found", and none of its text
  const map = path.join(x.h, 'map.json');
  await writeFile(map, JSON.stringify({ sessions: { [ID]: { transcriptPath: outside } } }));
  const r = await createConversations({ cmuxMap: map, registryDir: x.registryDir, home: x.h, root: x.root }).read(ID);
  assert.deepEqual(r, { ok: false, why: 'not-found' });
});

test('the reader: entries, the last write, "partial" when the file is longer than the tail, a new read when the file grows', async () => {
  const x = await home();
  await writeFile(path.join(x.registryDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: ID, cwd: x.cwd }));
  const c = createConversations({ registryDir: x.registryDir, home: x.h, root: x.root });
  const r = await c.read(ID);
  assert.equal(r.ok, true); assert.equal(r.session, ID); assert.equal(r.partial, false);
  assert.deepEqual(r.entries.map((e) => e.role), ['user', 'agent']);
  assert.match(r.at, /^\d{4}-\d\d-\d\dT/);
  await writeFile(x.file, lines(user('hello', { n: 1 }), asst([text('hi')], { n: 2 }), user('more', { n: 3 })));
  assert.equal((await c.read(ID)).entries.length, 3);
  const small = await createConversations({ registryDir: x.registryDir, home: x.h, root: x.root, steps: [200] }).read(ID);
  assert.equal(small.partial, true);
  assert.deepEqual(await c.read('no-such-session'), { ok: false, why: 'not-found' });
  assert.deepEqual(await c.read('../x'), { ok: false, why: 'bad-id' });
  for (const k of ['bad-id', 'not-found', 'unreadable']) assert.ok(WHY[k]);
});

test('the reader widens its read when the end of the file holds too few turns, and stops at the last step', async () => {
  const x = await home();
  await writeFile(path.join(x.registryDir, '4242.json'), JSON.stringify({ pid: 4242, sessionId: ID, cwd: x.cwd }));
  // a question, then a long run of large tool results, then the answer: the last 2 KB hold only the answer
  const big = Array.from({ length: 12 }, (_, i) => user([{ type: 'tool_result', tool_use_id: 't', content: 'r'.repeat(1500) }], { n: i }));
  await writeFile(x.file, lines(user('the question', { n: 1 }), ...big, asst([text('the answer')], { n: 30 })));
  const opts = { registryDir: x.registryDir, home: x.h, root: x.root };
  const narrow = await createConversations({ ...opts, steps: [2000] }).read(ID);
  assert.deepEqual(narrow.entries.map((e) => e.role), ['agent']);
  assert.equal(narrow.partial, true);
  const widened = await createConversations({ ...opts, steps: [2000, 1e6] }).read(ID);
  assert.deepEqual(widened.entries.map((e) => e.role), ['user', 'agent']);
  assert.equal(widened.entries[0].text, 'the question');
  assert.equal(widened.partial, false);
  // enough turns with something said to the agent: the first step is all that is read
  const turns = [];
  for (let i = 0; i < ENOUGH_ENTRIES + 4; i += 1) turns.push(i % 2 ? asst([text(`a${i}`)], { n: i }) : user(`u${i}`, { n: i }));
  await writeFile(x.file, lines(user('FIRST', { n: 0 }), ...big, ...turns));
  const first = await createConversations({ ...opts, steps: [1500, 1e6] }).read(ID);
  assert.equal(first.partial, true);
  assert.ok(!JSON.stringify(first.entries).includes('FIRST'));
  assert.deepEqual(TAIL_STEPS, [1048576, 4194304, 16777216]);
});

test('the module and the page have no way to write or send: no file write, no child process, no POST, no token', async () => {
  const mod = await read('src/conversation.mjs');
  assert.doesNotMatch(mod, /writeFile|appendFile|rename\(|unlink|child_process|fetch\(/);
  const js = await read('public/conversation.js');
  assert.doesNotMatch(js, /method:|POST|PATCH|mesh-decision|x-mesh|<a |href=/i);
  assert.equal([...js.matchAll(/fetch\(/g)].length, 1, 'one fetch: the read');
  const html = await read('public/conversation.html');
  assert.doesNotMatch(html, /%%MESH_DECISION%%|mesh-decision|<form|<input|<textarea|<button/, 'no token and nothing to type into or press');
});

test('the page: untrusted text is escaped and never a link; who said what has a word, not a colour alone', () => {
  const r = { ok: true, cut: false, partial: false, at: T(9), entries: [
    { role: 'user', via: 'mesh', at: T(1), text: '[mesh] from <b>x</b>: see https://example.test/a?b=1&c=2' },
    { role: 'agent', at: T(2), parts: [{ kind: 'text', text: '<script>alert(1)</script>\n<a href="https://example.test">click</a>' }, { kind: 'tool', name: 'Bash', note: '<img src=x onerror=alert(1)>' }] },
    { role: 'user', via: 'typed', at: T(3), text: 'ok' },
    { role: 'note', at: T(4), text: COMPACTED },
  ] };
  const html = view.render(r);
  assert.doesNotMatch(html, /<script|<img|<a |<b>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /→ TO THE AGENT · MESH/);
  assert.match(html, /→ TO THE AGENT <span/);
  assert.match(html, /← THE AGENT/);
  assert.match(html, /<span class="cv-tool">Bash<\/span> <span class="cv-note">&lt;img src=x onerror=alert\(1\)&gt;<\/span>/);
  assert.match(html, /01-20 12:02Z/);
  assert.match(html, new RegExp(COMPACTED.slice(0, 30)));
});

test('the page: many tool calls in a row fold into one line; older turns left out are said; an empty reading is said', () => {
  const tools = Array.from({ length: 5 }, (_, i) => ({ kind: 'tool', name: `T${i}`, note: '' }));
  const html = view.render({ entries: [{ role: 'agent', at: T(1), parts: [{ kind: 'text', text: 'a' }, ...tools, { kind: 'text', text: 'b' }, tools[0]] }], cut: true, partial: false });
  assert.match(html, /<summary>5 tool calls<\/summary>/);
  assert.equal([...html.matchAll(/<details/g)].length, 1, 'the single call after is not folded');
  assert.match(html, /Earlier turns are not shown/);
  assert.match(view.render({ entries: [{ role: 'agent', parts: [] }], cut: false, partial: true }), /Earlier turns are not shown/);
  assert.doesNotMatch(view.render({ entries: [{ role: 'user', via: 'typed', text: 'x' }], cut: false, partial: false }), /Earlier turns/);
  assert.match(view.render({ entries: [], cut: false, partial: false }), /Nothing was said/);
  assert.match(view.render(null), /no reading/);
  assert.equal(view.when('nonsense'), '');
});

test('the demo conversation is fixed text', () => {
  const d = demoConversation('demo-4', Date.parse(T(30)));
  assert.equal(d.ok, true); assert.equal(d.session, 'demo-4');
  assert.deepEqual(d.entries.map((e) => e.role), ['user', 'agent', 'user', 'agent']);
});

// ---- a real board ----
async function board(mode, fn) {
  const overlay = await mkdtemp(path.join(os.tmpdir(), 'conversation-overlay-'));
  await mkdir(path.join(overlay, 'config'), { recursive: true });
  await writeFile(path.join(overlay, 'config', 'local.json'), JSON.stringify({ settings: { conversationView: { mode } } }));
  const port = await freePort();
  const env = demoEnv({ MC_PORT: String(port), MC_OVERLAY: overlay, ZULU_NO_NOTIFY: '1' });
  const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = null;
    for (let i = 0; i < 80 && !up; i += 1) {
      await new Promise((res) => setTimeout(res, 150));
      up = await fetch(`${base}/api/status`).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    }
    assert.ok(up?.demo, 'demo board answered');
    await fn(base, up);
  } finally { child.kill(); }
}

test('a real board with the view on: the route answers for a session, refuses a bad id, the page has no token, the board page says "on"', async () => {
  await board('on', async (base, status) => {
    const id = status.sessions[0].id;
    const res = await fetch(`${base}/api/conversation?session=${encodeURIComponent(id)}`);
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.ok, true); assert.equal(r.session, id);
    assert.ok(r.entries.length >= 2);
    assert.equal((await fetch(`${base}/api/conversation?session=..%2F..%2Fetc%2Fpasswd`)).status, 400);
    assert.equal((await fetch(`${base}/api/conversation`)).status, 400);
    const page = await fetch(`${base}/?conversation=${encodeURIComponent(id)}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<title>Conversation · /);
    const index = await (await fetch(`${base}/`)).text();
    const token = index.match(/name="mesh-decision" content="([0-9a-f]+)"/)?.[1];
    assert.ok(token, 'the board page has its token');
    assert.ok(!html.includes(token), 'the conversation page does not');
    assert.match(index, /name="conversation-view" content="on"/);
    assert.equal((await fetch(`${base}/conversation.js`)).status, 200);
    const post = await fetch(`${base}/api/conversation?session=${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.ok(post.status >= 400, `POST answered ${post.status}`);
  });
});

test('a real board with the view off: no route, no page, no script, and ?conversation= is the board page', async () => {
  await board('off', async (base) => {
    assert.equal((await fetch(`${base}/api/conversation?session=demo-1`)).status, 404);
    assert.equal((await fetch(`${base}/conversation.html`)).status, 404);
    assert.equal((await fetch(`${base}/conversation.js`)).status, 404);
    const index = await (await fetch(`${base}/?conversation=demo-1`)).text();
    assert.match(index, /name="conversation-view" content="off"/);
    assert.match(index, /name="mesh-decision"/);
  });
});

test('the board page links a tile to the view only when it is on and the session id is plain', async () => {
  const app = await read('public/app.js');
  assert.match(app, /const conversationLink = \(s\) => \(conversationOn && \/\^\[A-Za-z0-9\]\[A-Za-z0-9-\]\{3,63\}\$\/\.test/);
  assert.match(app, /href="\/\?conversation=\$\{encodeURIComponent\(s\.id\)\}"/);
});
