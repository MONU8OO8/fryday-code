// The board: dependencies between tasks, initiatives and their sub-tasks, and the scheduler that
// starts queued work by priority while slots are free, gates are met and the machine has room.
// A scratch database only; the scheduler's starter is replaced, so no agent runs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.homedir(), '.fryday-code', `scheduler-test-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_MAX_AGENTS = '2';
process.env.FRYDAY_MAC_NOTIFY = 'off';
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb, nowMs } from '../src/db/db';
import { createTask, getTask, setTaskState, taskMetadata } from '../src/pipeline/taskState';
import { addDependency, removeDependency, unmetDependencies, gateMet, updateBoardFields, LinkError } from '../src/pipeline/taskLinks';
import { configureScheduler, kickScheduler, schedulerStatus } from '../src/pipeline/scheduler';
import { initiativeStateFor, registerInitiatives, splitIntoSubtasks, validSplit } from '../src/pipeline/initiative';
import { ApprovalError, requestReleaseApproval } from '../src/pipeline/approvals';
import { StartError } from '../src/pipeline/pipeline';
import { tasksOverview } from '../src/pipeline/story';

const started: string[] = [];
let machine = { ok: true } as { ok: boolean; why?: string };

/** Put a task in a state without going through the pipeline. */
const force = (id: string, state: string) => getDb().prepare('UPDATE tasks SET state = ? WHERE id = ?').run(state, id);

before(() => {
  initDb(process.env.FRYDAY_DB!);
  registerInitiatives();
  configureScheduler({
    admit: () => machine,
    start: (id) => { started.push(id); force(id, 'intake'); },
  });
});

beforeEach(() => {
  started.length = 0;
  machine = { ok: true };
  // Earlier tests' tasks must not hold slots.
  getDb().prepare(`UPDATE tasks SET state = 'deployed', auto_start = 0`).run();
});

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('the scheduler starts auto-start tasks by priority, then board order, and only while slots are free', () => {
  const low = createTask('low', 'd', { priority: 'p2', autoStart: true });
  const urgent = createTask('urgent', 'd', { priority: 'p0', autoStart: true });
  const high = createTask('high', 'd', { priority: 'p1', autoStart: true });
  const manual = createTask('manual', 'd', { priority: 'p0' });
  kickScheduler();
  assert.deepEqual(started, [urgent.id, high.id]);
  assert.equal(getTask(low.id)!.state, 'queued');
  assert.equal(getTask(manual.id)!.state, 'queued', 'a task without auto-start waits for the owner');
  const status = schedulerStatus();
  assert.equal(status.paused, 'All 2 slots are busy');
  assert.deepEqual(status.slots, { used: 2, max: 2 });
  assert.ok(status.waiting.some((w) => w.id === low.id));

  force(urgent.id, 'awaiting_approval'); // waiting for the owner frees the slot
  kickScheduler();
  assert.deepEqual(started, [urgent.id, high.id, low.id]);
});

test('board order breaks a tie in priority', () => {
  const a = createTask('a', 'd', { autoStart: true });
  const b = createTask('b', 'd', { autoStart: true });
  updateBoardFields(b.id, { position: 0 });
  updateBoardFields(a.id, { position: 5 });
  kickScheduler();
  assert.deepEqual(started, [b.id, a.id]);
});

test('a task that waits at the start gate is started only once what it waits for has passed review', () => {
  const api = createTask('api', 'd');
  const screen = createTask('screen', 'd', { autoStart: true });
  addDependency(screen.id, api.id, 'start');
  kickScheduler();
  assert.deepEqual(started, []);
  assert.match(String(taskMetadata(getTask(screen.id)!)['note']), /must pass its review first/);
  assert.throws(() => addDependency(api.id, screen.id, 'start'), (e: unknown) => e instanceof LinkError && e.status === 409, 'a cycle is refused');

  force(api.id, 'awaiting_approval');
  kickScheduler();
  assert.deepEqual(started, [screen.id]);
});

test('a link never holds anything back, and a removed dependency stops holding it back', () => {
  const a = createTask('a', 'd');
  const b = createTask('b', 'd', { autoStart: true });
  const c = createTask('c', 'd', { autoStart: true });
  addDependency(b.id, a.id, 'link');
  addDependency(c.id, a.id, 'start');
  assert.deepEqual(unmetDependencies(b.id, 'start'), []);
  kickScheduler();
  assert.deepEqual(started, [b.id]);
  assert.ok(removeDependency(c.id, a.id));
  kickScheduler();
  assert.deepEqual(started, [b.id, c.id]);
});

test('a busy machine holds new work back and says why', () => {
  machine = { ok: false, why: 'The machine is short of memory' };
  const t = createTask('t', 'd', { autoStart: true });
  kickScheduler();
  assert.deepEqual(started, []);
  assert.equal(schedulerStatus().paused, 'The machine is short of memory');
  assert.match(String(taskMetadata(getTask(t.id)!)['note']), /short of memory/);
});

test('a task the scheduler cannot start is taken off auto-start with the reason', () => {
  configureScheduler({ start: () => { throw new StartError('Add and confirm a project first (Projects page)'); } });
  try {
    const t = createTask('t', 'd', { autoStart: true });
    kickScheduler();
    const row = getTask(t.id)!;
    assert.equal(row.auto_start, 0);
    assert.match(String(taskMetadata(row)['note']), /Could not start it automatically: Add and confirm a project/);
  } finally {
    configureScheduler({ start: (id) => { started.push(id); force(id, 'intake'); } });
  }
});

test('the release gate: met once the task it waits for is on staging', () => {
  const api = createTask('api', 'd');
  assert.equal(gateMet(getTask(api.id)!, 'release'), false);
  getDb().prepare(`INSERT INTO releases (id, task_id, repo_id, state, stg_branch, head_sha, started_at) VALUES ('rel-1', ?, 'r', 'pushed', 'stg', 'abc', ?)`).run(api.id, nowMs());
  assert.equal(gateMet(getTask(api.id)!, 'release'), true);
  assert.equal(gateMet(getTask(api.id)!, 'start'), true, 'on staging is past review too');
});

test('a release is not asked for while a task it waits for is not on staging, and is asked for once it is', () => {
  const api = createTask('api', 'd');
  const screen = createTask('screen', 'd');
  addDependency(screen.id, api.id, 'release');
  force(screen.id, 'awaiting_approval');
  getDb().prepare(`INSERT INTO task_workspaces (task_id, repo_id, repo_path, worktree_path, branch, base_ref, base_sha, head_sha, files_json, created_at) VALUES (?, 'no-such-project', '/nowhere', '/nowhere', 'b', 'origin/main', 'base', 'head', '[]', ?)`).run(screen.id, nowMs());
  getDb().prepare(`INSERT INTO task_rounds (task_id, round, head_sha, checks_json, flags_json, outcome, created_at) VALUES (?, 1, 'head', '[]', '[]', 'passed', ?)`).run(screen.id, nowMs());

  assert.throws(() => requestReleaseApproval(screen.id), (e: unknown) => e instanceof ApprovalError && e.status === 409 && /^Waiting to merge/.test(e.message));
  getDb().prepare(`UPDATE tasks SET metadata_json = json_set(COALESCE(metadata_json, '{}'), '$.note', ?) WHERE id = ?`).run(`Waiting to merge ${screen.id}: ...`, screen.id);

  getDb().prepare(`INSERT INTO releases (id, task_id, repo_id, state, stg_branch, head_sha, started_at) VALUES ('rel-2', ?, 'r', 'pushed', 'stg', 'abc', ?)`).run(api.id, nowMs());
  // Past the gate, the next refusal is about the project, not the dependency.
  assert.throws(() => requestReleaseApproval(screen.id), (e: unknown) => e instanceof ApprovalError && !/^Waiting/.test(e.message));
  kickScheduler();
  assert.doesNotMatch(String(taskMetadata(getTask(screen.id)!)['note']), /^Waiting to merge/, 'the scheduler asked again once the gate was met');
});

test('validSplit keeps known projects, renumbers dependencies and only allows earlier ones', () => {
  const split = validSplit([
    { projectId: 'api', title: 'Add endpoint', description: 'x', dependsOn: [1], gate: 'start' },
    { projectId: 'nope', title: 'Unknown', description: '', dependsOn: [], gate: 'start' },
    { projectId: 'web', title: 'Call it', description: 'y', dependsOn: [0, 2, 9], gate: 'release' },
  ], ['api', 'web']);
  assert.deepEqual(split?.map((s) => [s.projectId, s.dependsOn]), [['api', []], ['web', [0]]]);
  assert.equal(validSplit([{ projectId: 'api', title: 'a', description: '', dependsOn: [], gate: 'start' }, { projectId: 'api', title: 'b', description: '', dependsOn: [], gate: 'start' }], ['api']), null, 'one project is not an initiative');
});

test('an initiative: sub-tasks with dependencies, started by the scheduler, its state following theirs', () => {
  const parent = createTask('Show the new field', 'everywhere', { priority: 'p1' });
  const parts = splitIntoSubtasks(parent.id, [
    { projectId: 'api', title: 'Add the field to the API', description: 'x', dependsOn: [], gate: 'start' },
    { projectId: 'web', title: 'Show it', description: 'y', dependsOn: [0], gate: 'start' },
  ]);
  const p = getTask(parent.id)!;
  assert.equal(p.kind, 'initiative');
  assert.equal(p.state, 'tracking');
  assert.deepEqual(parts.map((c) => [getTask(c.id)!.parent_id, getTask(c.id)!.priority, getTask(c.id)!.auto_start]), [[parent.id, 'p1', 1], [parent.id, 'p1', 1]]);
  assert.equal(taskMetadata(getTask(parts[0]!.id)!)['plannedProject'], 'api');

  kickScheduler();
  assert.deepEqual(started, [parts[0]!.id], 'the screen waits for the API');

  const overview = tasksOverview().find((o) => o.id === parent.id)!;
  assert.equal(overview.column, null);
  assert.deepEqual(overview.board.children, parts.map((c) => c.id));
  assert.deepEqual(overview.board.parts.map((p) => [p.id, p.title]), parts.map((c) => [c.id, c.title]));
  assert.ok(overview.board.parts.every((p) => p.label.length > 0));
  assert.match(overview.line, /0 of 2 parts on staging/);

  force(parts[0]!.id, 'releasing');
  setTaskState(parts[0]!.id, 'deployed', 'on staging');
  assert.equal(getTask(parent.id)!.state, 'tracking');
  kickScheduler();
  assert.deepEqual(started, [parts[0]!.id, parts[1]!.id]);
  force(parts[1]!.id, 'releasing');
  setTaskState(parts[1]!.id, 'deployed', 'on staging');
  assert.equal(getTask(parent.id)!.state, 'deployed');
});

test('an initiative whose parts ended with one stopped needs the owner', () => {
  assert.deepEqual(initiativeStateFor([{ state: 'deployed' }, { state: 'failed' }])?.state, 'needs_owner');
  assert.deepEqual(initiativeStateFor([{ state: 'deployed' }, { state: 'coding' }])?.state, 'tracking');
  assert.deepEqual(initiativeStateFor([{ state: 'deployed' }, { state: 'deployed' }])?.state, 'deployed');
  assert.equal(initiativeStateFor([]), null);
});

test('board fields are validated', () => {
  const t = createTask('t', 'd');
  assert.throws(() => updateBoardFields(t.id, { priority: 'p9' as never }), LinkError);
  assert.throws(() => updateBoardFields(t.id, { position: -1 }), LinkError);
  assert.equal(updateBoardFields(t.id, { priority: 'p0', autoStart: true }).priority, 'p0');
});
