// What the live views read: an agent's recent steps from its log, short hints for tool
// calls, where the tokens went by agent, each agent's scorecard, and the traceability table.
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
import { causesOfRound, costAnalytics, scorecards } from '../src/runner/scorecard';
import { linkTests, matchCriterion, traceability } from '../src/pipeline/traceability';

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

// Far enough ahead that the runs added by the tests above fall outside every window.
const LATER = Date.now() + 400 * 86_400_000;
const MIN = 60_000;

function seedTask(id: string, opts: { plan?: object; project?: string } = {}) {
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at, plan_json, metadata_json)
    VALUES (?, NULL, ?, '', 'deployed', ?, ?, ?, ?)`).run(id, `Task ${id}`, LATER, LATER, opts.plan ? JSON.stringify(opts.plan) : null,
    opts.project ? JSON.stringify({ plannedProject: opts.project }) : null);
}
function seedRun(id: string, taskId: string | null, role: string, state: string, minutes: number, tokens: number, at = LATER) {
  getDb().prepare(`INSERT INTO runs (id, task_id, role, round, state, log_path, started_at, ended_at) VALUES (?, ?, ?, 1, ?, 'x', ?, ?)`)
    .run(id, taskId, role, state, at, at + minutes * MIN);
  getDb().prepare(`INSERT INTO usage_events (id, run_id, task_id, message_id, event_type, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, recorded_at)
    VALUES (?, ?, ?, NULL, 'result', ?, 0, 50, 0, 0, ?)`).run(`${id}:result`, id, taskId, tokens, at);
}
function seedRound(taskId: string, round: number, outcome: string, parts: { checks?: object[]; flags?: object[]; verdict?: object; verify?: object }) {
  getDb().prepare(`INSERT INTO task_rounds (task_id, round, checks_json, flags_json, verdict_json, verify_json, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(taskId, round, JSON.stringify(parts.checks ?? []), JSON.stringify(parts.flags ?? []), parts.verdict ? JSON.stringify(parts.verdict) : null,
      parts.verify ? JSON.stringify(parts.verify) : null, outcome, LATER);
}
const verdict = (pass: boolean, criteria: Array<[string, boolean, string]> = []) => ({
  verdict: pass ? 'pass' : 'fail', summary: '', issues: [], criteria: criteria.map(([criterion, met, evidence]) => ({ criterion, met, evidence })),
});

test('why a round was sent back, in plain words, one entry per kind of reason', () => {
  assert.deepEqual(causesOfRound({
    checks_json: JSON.stringify([{ name: 'test', status: 'failed' }, { name: 'lint', status: 'passed' }, { name: 'typecheck', status: 'error' }]),
    flags_json: JSON.stringify([{ kind: 'test-skipped', severity: 'blocking' }, { kind: 'large-diff', severity: 'warning' }]),
    verdict_json: JSON.stringify(verdict(false, [['Totals add up', false, 'off by 3']])),
    verify_json: JSON.stringify({ status: 'failed', testers: [] }),
  }), ['Tests failed', 'A check could not run', 'A test was skipped', 'An acceptance criterion was not met', 'A tester found a problem']);
  assert.deepEqual(causesOfRound({ checks_json: null, flags_json: null, verdict_json: JSON.stringify(verdict(false)), verify_json: null }), ['The Checker sent it back']);
  assert.deepEqual(causesOfRound({ checks_json: '{broken', flags_json: null, verdict_json: null, verify_json: null }), [], 'a broken row is no cause');
});

test("each agent's scorecard: first-round passes, rounds to pass, causes, stops, and the week apart from the month", () => {
  seedTask('S-1'); seedTask('S-2'); seedTask('S-3');
  // S-1 passed first time; S-2 passed in round 2 after failing tests; S-3 never passed, last month.
  seedRun('s1-c', 'S-1', 'coder', 'completed', 4, 1000);
  seedRun('s2-c', 'S-2', 'coder', 'completed', 6, 3000);
  seedRun('s3-c', 'S-3', 'coder', 'timeout', 30, 2000, LATER - 20 * 86_400_000);
  seedRun('s2-t', 'S-2', 'tester', 'completed', 2, 500);
  seedRun('s2-a', 'S-2', 'api_tester', 'budget', 3, 800);
  seedRun('chat', null, 'system', 'completed', 1, 100);
  seedRound('S-1', 1, 'passed', { verdict: verdict(true) });
  seedRound('S-2', 1, 'changes_requested', { checks: [{ name: 'test', status: 'failed' }], verdict: verdict(false), verify: { status: 'failed', testers: [{ kind: 'api', passed: false }] } });
  seedRound('S-2', 2, 'passed', { verdict: verdict(true), verify: { status: 'passed', testers: [{ kind: 'api', passed: true }] } });
  seedRound('S-3', 1, 'escalated', { checks: [{ name: 'test', status: 'failed', failures: ['cart › applies the discount'] }] });
  // The Builder on S-1 was given an approved lesson; S-2 and S-3 were not.
  const lessonId = Number(getDb().prepare(`INSERT INTO lessons (project_id, role, trigger_tags, text, evidence_json, signatures_json, source, state, created_at, decided_at) VALUES (NULL, 'coder', '[]', 'Run the cart tests first', '[]', '[]', 'core', 'active', ?, ?)`).run(LATER, LATER).lastInsertRowid);
  getDb().prepare(`INSERT INTO lesson_uses (lesson_id, task_id, role, created_at) VALUES (?, 'S-1', 'coder', ?)`).run(lessonId, LATER);

  const cards = new Map(scorecards(LATER + MIN * 60).map((c) => [c.role, c]));
  assert.deepEqual([...cards.keys()], ['analyst', 'planner', 'coder', 'tester', 'api_tester', 'ui_tester', 'reflector', 'fryday']);
  const coder = cards.get('coder')!;
  assert.equal(coder.month.runs, 3);
  assert.equal(coder.month.tasks, 3);
  assert.equal(coder.month.firstRoundPassRate, 0.33);
  assert.deepEqual(coder.month.lessonTrend, { withLessons: { tasks: 1, firstRoundPassRate: 1 }, without: { tasks: 2, firstRoundPassRate: 0 } });
  assert.equal(coder.month.roundsToPass, 1.5);
  assert.deepEqual(coder.month.failureCauses?.[0], { cause: 'Tests failed', count: 2, example: 'cart › applies the discount' });
  assert.equal(coder.month.stops.timeout, 1);
  assert.equal(coder.month.tokensPerTask, 2000);
  assert.equal(coder.week.runs, 2, 'the run 20 days back is only in the month');
  assert.equal(coder.week.firstRoundPassRate, 0.5);
  assert.equal(coder.week.minutesPerRun, 5);
  assert.equal(cards.get('tester')!.month.passRate, 0.5);
  assert.equal(cards.get('api_tester')!.month.passRate, 0.5);
  assert.equal(cards.get('api_tester')!.month.stops.budget, 1);
  assert.equal(cards.get('fryday')!.month.runs, 1, 'talking to the owner counts for the Lead');
  assert.equal(cards.get('ui_tester')!.month.passRate, null, 'no verdicts is no rate, not zero');
  assert.equal(cards.get('analyst')!.month.tokensPerTask, null);
});

test('where tokens and time went, per stage and per project, biggest first', () => {
  getDb().prepare(`INSERT INTO projects (id, name, local_path, prod_branch, created_at, updated_at) VALUES ('shop', 'Shop', '/nowhere', 'main', ?, ?)`).run(LATER, LATER);
  seedTask('C-1', { project: 'shop' });
  seedTask('C-2', { project: 'gone' });
  seedRun('c1-p', 'C-1', 'planner', 'completed', 2, 700, LATER + 100 * 86_400_000);
  seedRun('c1-c', 'C-1', 'coder', 'completed', 10, 5000, LATER + 100 * 86_400_000);
  seedRun('c2-c', 'C-2', 'coder', 'completed', 5, 1000, LATER + 100 * 86_400_000);
  seedRun('c-chat', null, 'fryday', 'completed', 1, 50, LATER + 100 * 86_400_000);
  const a = costAnalytics(7, LATER + 101 * 86_400_000);
  assert.equal(a.days, 7);
  assert.deepEqual(a.byStage.map((r) => [r.key, r.tokens, r.runs]), [['Build', 6000, 2], ['Plan', 700, 1], ['Talking to you', 50, 1]]);
  assert.deepEqual(a.byProject.map((r) => [r.key, r.tokens]), [['Shop', 5700], ['gone', 1000], ['No project yet', 50]]);
  assert.equal(a.byStage[0]!.minutes, 15);
  assert.equal(a.byStage[0]!.reusedTokens, 100);
});

test('criteria are matched by their words, or by place when both lists are as long', () => {
  const found = [{ criterion: 'The cart total includes tax.' }, { criterion: 'Empty carts show a message' }];
  assert.equal(matchCriterion('the cart total includes tax', 0, 2, found), found[0]);
  assert.equal(matchCriterion('Empty carts show a message when nothing is added', 1, 2, found), found[1]);
  assert.equal(matchCriterion('Something reworded', 1, 2, found), found[1]);
  assert.equal(matchCriterion('Something reworded', 1, 3, found), undefined);
  const { byCriterion, other } = linkTests(
    ['The cart total includes tax', 'Empty carts show a friendly message'],
    ['Unit test: cart total with tax at 18%', 'Render an empty cart and expect the friendly message', 'Run the linter'],
  );
  assert.deepEqual(byCriterion, [['Unit test: cart total with tax at 18%'], ['Render an empty cart and expect the friendly message']]);
  assert.deepEqual(other, ['Run the linter']);
});

test("the traceability table joins the plan's criteria and tests with what the Checker and each tester found", () => {
  const FAKE = ['sk', 'ant', 'y'.repeat(28)].join('-');
  seedTask('R-1', { plan: {
    summary: 's', approach: 'a', flow: [{ step: 'x', detail: 'y' }], files: [], risks: [], questions: [],
    criteria: ['The cart total includes tax', 'Empty carts show a friendly message'],
    testPlan: ['Unit test: cart total with tax', 'Run the linter'],
  } });
  assert.deepEqual(traceability('R-1')!.round, null, 'before any review there are no findings');
  assert.equal(traceability('R-1')!.rows[0]!.checker, null);
  seedRound('R-1', 1, 'changes_requested', { verdict: verdict(false, [['The cart total includes tax', false, 'off by 3']]) });
  seedRound('R-1', 2, 'passed', {
    verdict: verdict(true, [['the cart total includes tax.', true, `matches; key ${FAKE}`], ['Empty carts show a friendly message', true, 'seen']]),
    verify: { status: 'passed', testers: [
      { kind: 'api', passed: true, report: { criteria: [{ criterion: 'The cart total includes tax', result: 'met', evidence: 'GET /cart total 118' }] } },
      { kind: 'ui', passed: true, report: { criteria: [{ criterion: 'x', result: 'not_checked', evidence: '' }, { criterion: 'y', result: 'met', evidence: 'message shown' }] } },
    ] },
  });
  const t = traceability('R-1')!;
  assert.equal(t.round, 2, 'the latest reviewed round');
  assert.deepEqual(t.rows[0]!.tests, ['Unit test: cart total with tax']);
  assert.deepEqual(t.otherTests, ['Run the linter']);
  assert.equal(t.rows[0]!.checker!.met, true);
  assert.ok(!JSON.stringify(t).includes(FAKE), 'evidence is cleaned of secret-looking text');
  assert.deepEqual(t.rows[0]!.testers.map((x) => [x.who, x.result]), [['App tester', 'met'], ['Page tester', 'not_checked']]);
  assert.deepEqual(t.rows[1]!.testers.map((x) => [x.who, x.result, x.evidence]), [['Page tester', 'met', 'message shown']]);
  assert.equal(traceability('NOPE'), null);
});
