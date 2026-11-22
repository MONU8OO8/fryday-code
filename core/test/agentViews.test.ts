// What the live views read: an agent's recent steps from its log, short hints for tool
// calls, and where the tokens went by agent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-views-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { recentActivity, shortenPaths, toolHint, summarizeEvent } from '../src/runner/runEvents';
import { getUsageByRole } from '../src/runner/usage';

before(() => initDb(process.env.FRYDAY_DB!));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const assistant = (id: string, content: unknown[], usage = { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 9 }) =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', model: 'm', stop_reason: 'end_turn', content, usage }, session_id: 's' });

test('tool hints show what a call was about, with the workspace prefix and home folder shortened', () => {
  const home = os.homedir();
  assert.equal(toolHint({ file_path: `${home}/.fryday-code/worktrees/T-4/shop/src/cart.js` }), 'src/cart.js');
  assert.equal(toolHint({ command: `cd ${home}/.fryday-code/worktrees/T-4/shop.review && npm test` }), 'cd . && npm test');
  assert.equal(toolHint({ url: 'http://127.0.0.1:4000/cart' }), 'http://127.0.0.1:4000/cart');
  assert.equal(toolHint({ query: 'SELECT  *\n FROM plans' }), 'SELECT * FROM plans');
  assert.equal(toolHint({ target: 'e7' }), '', 'an element reference says nothing to a person');
  assert.equal(toolHint({ content: 'a whole file' }), '', 'never the content of a file');
  assert.equal(toolHint({ command: 'x'.repeat(300) }).length, 91);
  assert.equal(shortenPaths(`${home}/Documents/a`), '~/Documents/a');
});

test('an assistant step carries its tools, what they were about, and its tokens', () => {
  const s = summarizeEvent(JSON.parse(assistant('m1', [{ type: 'text', text: 'Reading the cart.' }, { type: 'tool_use', id: 't', name: 'Read', input: { file_path: 'src/cart.js' } }])));
  assert.deepEqual(s, {
    kind: 'assistant', text: 'Reading the cart.', tools: ['Read'], toolInputs: ['src/cart.js'],
    usage: { inputTokens: 3, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 9 },
  });
});

test("an agent's recent steps are read from the end of its log, newest last", () => {
  const log = path.join(tmp, 'run.jsonl');
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's', model: 'm', tools: [], mcp_servers: [] }),
    ...Array.from({ length: 50 }, (_, i) => assistant(`m${i}`, [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `step ${i}` } }])),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't49', content: 'secret output' }] } }),
    'not json',
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 's', usage: {}, total_cost_usd: 0.1 }),
  ];
  fs.writeFileSync(log, `${lines.join('\n')}\n`);
  const steps = recentActivity(log, 5);
  assert.deepEqual(steps.map((s) => s.kind === 'assistant' && s.toolInputs[0]), ['step 45', 'step 46', 'step 47', 'step 48', 'step 49']);
  assert.ok(!JSON.stringify(recentActivity(log)).includes('secret output'), 'tool results are not part of the activity');
  // Only the end of a long log is read; a line cut at the start of that window is dropped, not misread.
  const tail = recentActivity(log, 100, 2000);
  assert.ok(tail.length > 0 && tail.length < 50);
  assert.deepEqual(recentActivity(path.join(tmp, 'missing.jsonl')), []);
});

test('usage by agent sums each role, names its usual model, counts limit stops, most counted tokens first', () => {
  const db = getDb();
  const add = (id: string, role: string, state: string, model: string, cost: number, startedAt = Date.now()) => {
    db.prepare(`INSERT INTO runs (id, task_id, role, round, state, log_path, started_at, model) VALUES (?, NULL, ?, 0, ?, 'x', ?, ?)`).run(id, role, state, startedAt, model);
    db.prepare(`INSERT INTO usage_events (id, run_id, task_id, message_id, event_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, recorded_at)
      VALUES (?, ?, NULL, NULL, 'result', 10, 20, 300, 5, ?, ?)`).run(`${id}:result`, id, cost, startedAt);
  };
  add('c1', 'coder', 'completed', 'claude-sonnet-5-5', 0.5);
  add('c2', 'coder', 'budget', 'claude-opus-5-5', 1.0);
  add('c3', 'coder', 'completed', 'claude-opus-5-5', 0.25);
  add('p1', 'planner', 'completed', 'claude-opus-5-5', 0.3);
  add('old', 'tester', 'completed', 'claude-opus-5-5', 9, Date.now() - 30 * 86_400_000);
  const roles = getUsageByRole(Date.now() - 86_400_000);
  assert.deepEqual(roles.map((r) => r.role), ['coder', 'planner'], 'older runs are left out');
  const coder = roles[0]!;
  assert.equal(coder.runs, 3);
  assert.equal(coder.budgetStops, 1);
  assert.equal(coder.model, 'claude-opus-5-5');
  assert.equal(coder.costUsd, 1.75);
  assert.equal(coder.cacheReadTokens, 900);
});
