// The story and overview read from the database, through the API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fryday-story-'));
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
process.env.FRYDAY_MAC_NOTIFY = 'off';

import { getDb, initDb, nowMs } from '../src/db/db';
import { createTask, setTaskState } from '../src/pipeline/taskState';
import { raiseTicket } from '../src/pipeline/approvals';
import { askQuestions } from '../src/pipeline/questions';
import { addMessage } from '../src/pipeline/thread';
import { taskStory, tasksOverview } from '../src/pipeline/story';

before(() => initDb(process.env.FRYDAY_DB!));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('a task waiting for an answer: its story, journey and place in the overview', () => {
  const task = createTask('Add a CSV export', 'Add a button that downloads orders as CSV');
  setTaskState(task.id, 'intake', 'Reading the task');
  askQuestions(task.id, 'analyst', [{ kind: 'clarify', question: 'Include phone numbers?', options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }] }]);
  setTaskState(task.id, 'waiting_owner', '1 question for you');
  addMessage(task.id, 'owner', 'note', 'Please hurry');

  const story = taskStory(task.id)!;
  assert.equal(story.task.title, 'Add a CSV export');
  assert.deepEqual(story.items.map((i) => `${i.from}:${i.kind}`), ['you:note', 'understander:question', 'you:note', 'fryday:said']);
  assert.equal(story.items[3]!.text, 'Got it. The team is waiting for your answer to the question above.');
  assert.deepEqual(story.choices, { tryAgain: false, accept: false, why: null });
  assert.equal(story.canStop, true, 'a task waiting on an answer can be stopped');
  assert.equal(story.canSendBack, false, 'nothing has been built to send back');
  assert.equal(story.items[1]!.action?.kind, 'answer');
  assert.equal(story.journey.stops.length, 6);
  assert.equal(story.now, null);

  assert.equal(story.askAgain, null, 'nothing to ask again for a task with a question open');

  const item = tasksOverview().find((t) => t.id === task.id)!;
  assert.equal(typeof item.usedTokens, 'number');
  assert.ok(Number.isFinite(item.usedTokens));
  assert.equal('spentUsd' in item, false, 'no money figure in the overview');
  assert.equal(item.group, 'needs_you');
  assert.equal(item.line, 'Has a question for you');
  assert.equal(taskStory('T-404'), null);
});

test('the routes: /overview is not taken for a task id, and a missing task is a 404', async () => {
  const express = (await import('express')).default;
  const { tasksRouter } = await import('../src/api/tasks');
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks`;
  try {
    const overview = await fetch(`${base}/overview`);
    assert.equal(overview.status, 200);
    assert.ok(Array.isArray(((await overview.json()) as { tasks: unknown[] }).tasks));
    const first = tasksOverview()[0]!;
    const story = await fetch(`${base}/${first.id}/story`);
    assert.equal(story.status, 200);
    assert.equal(((await story.json()) as { task: { id: string } }).task.id, first.id);
    assert.equal((await fetch(`${base}/T-404/story`)).status, 404);
    // Trying again and accepting as it is are the owner's, at the UI (the session cookie), only.
    for (const action of ['try-again', 'accept', 'stop', 'send-back']) {
      const res = await fetch(`${base}/${first.id}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(res.status, 403, action);
    }
  } finally {
    server.close();
  }
});

// ─── Endings core leaves with the owner ───────────────────────────────────────

function ticket(taskId: string, action: string, state: string, at: number): void {
  getDb().prepare(`INSERT INTO approvals (id, task_id, action, payload_json, code, state, requested_at, resolved_at) VALUES (?, ?, ?, '{"summary":"s"}', '123456', ?, ?, ?)`)
    .run(`apr-${taskId}-${at}`, taskId, action, state, at, state === 'pending' ? null : at + 1);
}
function release(taskId: string, state: string, at: number): void {
  getDb().prepare(`INSERT INTO releases (id, task_id, repo_id, state, stg_branch, head_sha, started_at) VALUES (?, ?, 'shop', ?, 'staging', 'abc', ?)`).run(`rel-${taskId}`, taskId, state, at);
}
function needsOwner(title: string, note: string) {
  const task = createTask(title, title);
  setTaskState(task.id, 'intake');
  setTaskState(task.id, 'needs_owner', note);
  return task;
}

test('a release with no deployer, and a hand-over, read as done; a pending deploy is still your OK', () => {
  const t0 = nowMs();
  const staged = needsOwner('On staging', 'Merged into staging and pushed (merge 2a85c981). Deploy staging yourself: this project has no deployer set up.');
  ticket(staged.id, 'release_stg', 'executed', t0);
  release(staged.id, 'pushed', t0 + 5);
  const handed = needsOwner('Handed over', 'Pushed cart-fix (2a85c981). Open a pull request from it into main; main itself was not pushed to. This project has no staging branch, so nothing else is waiting.');
  ticket(handed.id, 'push_branch', 'executed', t0);
  const deploying = createTask('Deploy asked', 'Deploy asked');
  for (const state of ['intake', 'workspace', 'coding', 'testing', 'awaiting_approval'] as const) setTaskState(deploying.id, state);
  ticket(deploying.id, 'release_stg', 'executed', t0);
  release(deploying.id, 'pushed', t0 + 5);
  ticket(deploying.id, 'deploy_stg', 'pending', t0 + 10);

  const overview = tasksOverview();
  const of = (id: string) => overview.find((t) => t.id === id)!;
  assert.equal(of(staged.id).group, 'done');
  assert.equal(of(staged.id).line, 'On staging: deploy it yourself');
  assert.equal(of(staged.id).journey.finished, 'on_staging');
  assert.equal(of(handed.id).group, 'done');
  assert.equal(of(handed.id).line, 'Handed over for review');
  assert.equal(of(handed.id).journey.finished, 'handed_over');
  assert.equal(of(deploying.id).group, 'needs_you');
  assert.equal(of(deploying.id).journey.current, 'approve');
  assert.equal(of(deploying.id).journey.stops[4]!.state, 'waiting');

  const story = taskStory(staged.id)!;
  assert.equal(story.items.at(-1)!.text, `The staging server is not updated yet: I could not deploy it myself. Write "deploy it" here and I try again.`);
  assert.equal(story.journey.finished, 'on_staging');
  assert.deepEqual(story.journey.stops.slice(4).map((s) => s.state), ['done', 'done']);
  assert.equal(story.journey.current, null);
  const shared = taskStory(handed.id)!;
  assert.equal(shared.items.at(-1)!.text, 'The work is saved and shared for review. Nothing was changed on staging.');
  // FryDay's own lines (the push card's wording is left as it is in this pass).
  for (const s of [story, shared]) assert.doesNotMatch(JSON.stringify(s.items.filter((i) => i.from === 'fryday').map((i) => i.text)), /2a85c981|\bcommit\b|\bbranch\b/);
  for (const s of [story, shared]) assert.doesNotMatch(JSON.stringify(s.items.map((i) => i.text)), /2a85c981/);
  assert.equal(taskStory(deploying.id)!.journey.stops[4]!.state, 'waiting');
});

// ─── What the story and the overview never give out ───────────────────────────

test('neither the story nor the overview contains an approval code or a log path', () => {
  const task = createTask('Secret-free', 'Nothing secret in the answer');
  setTaskState(task.id, 'intake');
  const logPath = path.join(tmp, 'runs', 'run-known-log-path.jsonl');
  getDb().prepare(`INSERT INTO runs (id, task_id, role, state, log_path, started_at) VALUES ('run-known', ?, 'coder', 'running', ?, ?)`).run(task.id, logPath, nowMs());
  const row = raiseTicket(task.id, 'release_stg', { summary: 'Merge it' }, 'abc1234');
  const code = (getDb().prepare('SELECT code FROM approvals WHERE id = ?').get(row.id) as { code: string }).code;
  assert.match(code, /^\d{6}$/);

  const story = JSON.stringify(taskStory(task.id));
  const overview = JSON.stringify(tasksOverview());
  assert.ok(story.includes(row.id), 'the ticket is in the story');
  for (const [name, text] of [['story', story], ['overview', overview]] as const) {
    assert.doesNotMatch(text, new RegExp(`(?<!\\d)${code}(?!\\d)`), `${name} has the code`);
    assert.doesNotMatch(text, /"code"/, `${name} has a code field`);
    assert.ok(!text.includes(logPath), `${name} has the log path`);
    assert.ok(!text.includes('run-known-log-path'), `${name} has the log file name`);
  }
});

test('one task whose facts cannot be read does not take the overview down', () => {
  const good = createTask('Readable', 'Readable');
  const bad = createTask('Unreadable', 'Unreadable');
  getDb().prepare(`INSERT INTO task_rounds (task_id, round, checks_json, created_at) VALUES (?, 1, '{not json', ?)`).run(bad.id, nowMs());
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  let ids: string[];
  try {
    ids = tasksOverview().map((t) => t.id);
  } finally {
    console.error = original;
  }
  assert.ok(ids.includes(good.id));
  assert.ok(!ids.includes(bad.id));
  assert.ok(ids.length > 2, 'the other tasks are still listed');
  assert.ok(errors.some((e) => e[0] === '[fryday-core] overview: could not read' && e[1] === bad.id));
});

test('an agent that ran after the hand-over means the old ending no longer counts', () => {
  const t0 = nowMs() - 1000;
  const task = needsOwner('Handed over, then worked on', 'The Builder failed.');
  ticket(task.id, 'push_branch', 'executed', t0);
  const before = tasksOverview().find((t) => t.id === task.id)!;
  assert.equal(before.journey.finished, 'handed_over');
  getDb().prepare(`INSERT INTO runs (id, task_id, role, state, log_path, started_at, ended_at) VALUES (?, ?, 'coder', 'failed', ?, ?, ?)`)
    .run(`run-${task.id}`, task.id, path.join(tmp, 'runs', `run-${task.id}.jsonl`), t0 + 50, t0 + 60);
  const after = tasksOverview().find((t) => t.id === task.id)!;
  assert.equal(after.group, 'needs_you');
  assert.equal(after.journey.finished, null);
  assert.equal(after.line, 'Stopped: needs you');
  const story = taskStory(task.id)!;
  assert.equal(story.journey.finished, null);
  assert.equal(story.items.at(-1)!.text, 'I stopped and need you: The Builder failed.');
});
