// An agent run's steps from its log: what each step was, its result, paging, and that nothing
// secret or any tool output comes back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { runTimeline, stepsFromLog, summarizeRunLog, kindOfTool, toolLabel } from '../src/runner/runTimeline';
import { redactSecrets } from '../src/secretPatterns';

const tmp = path.join(os.tmpdir(), `fryday-timeline-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Built at run time so no file in the repository holds anything that looks like a key.
const FAKE_KEY = ['sk', 'ant', 'x'.repeat(28)].join('-');
const FAKE_TOKEN = `gh${'p'}_${'A'.repeat(36)}`;

const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const assistant = (n: number, content: unknown[]) =>
  JSON.stringify({ type: 'assistant', timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(), message: { id: `m${n}`, role: 'assistant', model: 'm', stop_reason: 'tool_use', content, usage }, session_id: 's' });
const result = (id: string, content: unknown, isError = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const home = os.homedir();

function writeLog(name: string, lines: string[], trailingNewline = true): string {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, lines.join('\n') + (trailingNewline ? '\n' : ''));
  return file;
}

test('tools are sorted into reads, searches, edits, commands, MCP calls and web', () => {
  assert.equal(kindOfTool('Read'), 'read');
  assert.equal(kindOfTool('Grep'), 'search');
  assert.equal(kindOfTool('MultiEdit'), 'edit');
  assert.equal(kindOfTool('Write'), 'edit');
  assert.equal(kindOfTool('Bash'), 'command');
  assert.equal(kindOfTool('mcp__fryday-service__request'), 'mcp');
  assert.equal(kindOfTool('WebFetch'), 'web');
  assert.equal(kindOfTool('TodoWrite'), 'other');
  assert.equal(toolLabel('mcp__fryday-service__request'), 'fryday-service · request');
  assert.equal(toolLabel('mcp__playwright__browser_click'), 'playwright · browser_click');
  assert.equal(toolLabel('mcp__fryday_browser__browser_click'), 'click', 'the same words as the live view');
  assert.equal(toolLabel('mcp__fryday_service__request'), 'request');
  assert.equal(toolLabel('mcp__fryday_service__log'), 'service log');
});

test('each step says what it was about, and a command its exit code; tool output never comes back', () => {
  const log = writeLog('steps.jsonl', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [], mcp_servers: [] }),
    assistant(1, [{ type: 'text', text: 'Looking at the cart first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: `${home}/.fryday-code/worktrees/T-7/shop/src/cart.js` } }]),
    result('t1', 'const SECRET_FILE_CONTENT = 1;'),
    assistant(2, [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: `${home}/.fryday-code/worktrees/T-7/shop/src/cart.js`, old_string: 'a', new_string: 'b' } }]),
    result('t2', 'ok'),
    assistant(3, [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }]),
    result('t3', 'Exit code 1\n3 failing: expected 30 got 27', true),
    assistant(4, [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm test' } }]),
    result('t4', '12 passing'),
    assistant(5, [{ type: 'tool_use', id: 't5', name: 'mcp__fryday-service__request', input: { url: 'http://127.0.0.1:4000/cart' } }]),
    result('t5', [{ type: 'text', text: '{"total":30}' }]),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', usage: {}, total_cost_usd: 0 }),
  ]);
  const page = runTimeline(log);
  assert.deepEqual(page.steps.map((s) => [s.kind, s.tool, s.hint]), [
    ['message', null, ''],
    ['read', 'Read', 'src/cart.js'],
    ['edit', 'Edit', 'src/cart.js'],
    ['command', 'Bash', 'npm test'],
    ['command', 'Bash', 'npm test'],
    ['mcp', 'fryday-service · request', 'http://127.0.0.1:4000/cart'],
    ['finished', null, ''],
  ]);
  assert.equal(page.steps[0]!.text, 'Looking at the cart first.');
  assert.deepEqual(page.steps.filter((s) => s.kind === 'command').map((s) => [s.ok, s.exitCode]), [[false, 1], [true, 0]]);
  assert.equal(page.steps[1]!.ok, true);
  assert.equal(page.steps[6]!.ok, true);
  assert.ok(page.steps[1]!.at && page.steps[1]!.at > 0);
  assert.equal(page.more, false);
  const body = JSON.stringify(page);
  for (const leaked of ['SECRET_FILE_CONTENT', '3 failing', '12 passing', '"total":30', 'worktrees']) assert.ok(!body.includes(leaked), `${leaked} must not come back`);

  const summary = summarizeRunLog(log);
  assert.deepEqual(summary.filesEdited, ['src/cart.js']);
  assert.equal(summary.filesRead, 1);
  assert.deepEqual(summary.commands, [{ hint: 'npm test', exitCode: 1 }, { hint: 'npm test', exitCode: 0 }]);
  assert.equal(summary.mcpCalls, 1);
});

test('secret-looking text in what the agent said or ran is hidden', () => {
  const log = writeLog('secret.jsonl', [
    assistant(1, [{ type: 'text', text: `I found the key ${FAKE_KEY} in the config.` }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `curl -H "Authorization: Bearer ${FAKE_TOKEN}" http://x` } }]),
    result('t1', FAKE_TOKEN),
  ]);
  const body = JSON.stringify(runTimeline(log));
  assert.ok(!body.includes(FAKE_KEY));
  assert.ok(!body.includes(FAKE_TOKEN));
  assert.ok(body.includes('[hidden]'));
  assert.equal(redactSecrets('API_KEY=abcdefghijkl and nothing else'), 'API_KEY=[hidden] and nothing else');
  assert.equal(redactSecrets('postgres://app:hunter2hunter2@db:5432/x'), '[hidden]db:5432/x');
  assert.equal(redactSecrets('nothing to hide here'), 'nothing to hide here');
});

test('pages follow each other by byte offset, step ids stay the same, results after a full page are still filled in', () => {
  const lines = Array.from({ length: 30 }, (_, i) => [
    assistant(i, [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `step ${i}` } }]),
    result(`t${i}`, i % 3 === 0 ? 'Exit code 2' : 'fine', i % 3 === 0),
  ]).flat();
  const log = writeLog('paged.jsonl', lines);
  const all = runTimeline(log, 0, 500).steps;
  assert.equal(all.length, 30);
  const seen: string[] = [];
  let cursor = 0;
  for (let pages = 0; pages < 10; pages++) {
    const page = runTimeline(log, cursor, 7);
    for (const s of page.steps) {
      seen.push(s.id);
      assert.notEqual(s.ok, undefined, 'the result right after a page fills is read');
    }
    if (!page.more) break;
    cursor = page.cursor;
  }
  assert.deepEqual(seen, all.map((s) => s.id));
  assert.deepEqual(all.slice(0, 4).map((s) => s.exitCode), [2, 0, 0, 2]);
});

test('at the live end of a log, a step still waiting for its result is read again next time; a cut line is left for later', () => {
  const head = [
    assistant(1, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm install' } }]),
    result('t1', 'done'),
    assistant(2, [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }]),
  ];
  const text = `${head.join('\n')}\n`;
  const live = stepsFromLog(text, 0, 100, true, true);
  assert.equal(live.steps.length, 2);
  assert.equal(live.steps[1]!.ok, undefined);
  const line2 = Buffer.byteLength(`${head[0]}\n${head[1]}\n`);
  assert.equal(live.cursor, line2, 'comes back to the step without a result');
  const next = stepsFromLog(`${head[2]}\n${result('t2', 'Exit code 1', true)}\n`, line2, 100, true, true);
  assert.equal(next.steps[0]!.id, live.steps[1]!.id, 'the same step, now with its result');
  assert.equal(next.steps[0]!.exitCode, 1);

  const ended = stepsFromLog(text, 0, 100, true, false);
  assert.equal(ended.cursor, Buffer.byteLength(text), 'a finished run is not read again');

  const cut = stepsFromLog(`${head[0]}\n${head[1].slice(0, 20)}`, 0, 100, false, true);
  assert.equal(cut.steps.length, 1);
  assert.equal(cut.cursor, Buffer.byteLength(`${head[0]}\n`));
  assert.equal(cut.more, true);
});

test('a missing log is an empty timeline, not an error', () => {
  assert.deepEqual(runTimeline(path.join(tmp, 'nope.jsonl')), { steps: [], cursor: 0, more: false });
});
