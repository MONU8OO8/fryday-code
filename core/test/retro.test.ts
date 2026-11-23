// Retro: the Reflector's record and answer, when a retro is worth it, core's own lessons
// from repeated failures, and the scoring of lessons once a task ends. No agent is run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const tmp = path.join(os.tmpdir(), `fryday-retro-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';

import { initDb, getDb } from '../src/db/db';
import { parseRetro, proposeCoreLessons, requestRetro, retroRecord, storeRetro, taskEnded, taskSignatures, worthRetro, ownerSentBack, RETRO_SCHEMA } from '../src/learning/retro';
import { decide, getLesson, listLessons, propose, recordUses } from '../src/learning/lessons';
import { failureKey, signaturesOfRound, OWNER_SENT_BACK } from '../src/learning/signatures';
import { getTask } from '../src/pipeline/taskState';

before(() => initDb(process.env.FRYDAY_DB!));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = Date.now();
const HOME = os.homedir();
const db = () => getDb();

function seedProject(id: string) {
  db().prepare(`INSERT OR IGNORE INTO projects (id, name, local_path, prod_branch, created_at, updated_at) VALUES (?, ?, '/nowhere', 'main', ?, ?)`).run(id, `Project ${id}`, NOW, NOW);
}
function seedTask(id: string, project: string, state = 'awaiting_approval', extra: { description?: string; plan?: object } = {}) {
  seedProject(project);
  db().prepare(`INSERT INTO tasks (id, title, description, state, created_at, updated_at, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, `Task ${id}`, extra.description ?? 'Add tax to the cart total', state, NOW, NOW, extra.plan ? JSON.stringify(extra.plan) : null);
  db().prepare(`INSERT INTO task_workspaces (task_id, repo_id, repo_path, worktree_path, branch, base_ref, base_sha, created_at) VALUES (?, ?, '/nowhere', '/nowhere/wt', 'feat/x', 'origin/main', 'abc', ?)`)
    .run(id, project, NOW);
}
function seedRound(taskId: string, round: number, outcome: string, parts: { checks?: object[]; flags?: object[]; verdict?: object } = {}) {
  db().prepare(`INSERT INTO task_rounds (task_id, round, head_sha, checks_json, flags_json, verdict_json, outcome, created_at) VALUES (?, ?, 'h', ?, ?, ?, ?, ?)`)
    .run(taskId, round, JSON.stringify(parts.checks ?? []), JSON.stringify(parts.flags ?? []), parts.verdict ? JSON.stringify(parts.verdict) : null, outcome, NOW);
}
const failedTest = (line: string) => ({ name: 'test', cmd: 'npm test', status: 'failed', output: '', failures: [line] });

test('failure signatures ignore what changes from run to run', () => {
  assert.equal(failureKey('cart › total at 18% expected 118 got 100 (src/cart.test.js:12)'), failureKey('cart › total at 18% expected 120 got 101 (lib/other/cart.test.js:40)'));
  assert.notEqual(failureKey('cart › total'), failureKey('cart › discount'));
  assert.deepEqual(signaturesOfRound({ outcome: 'passed', checks: [failedTest('x') as never], flags: [], verdict: null, verify: null }), [], 'a passed round has none');
  assert.deepEqual(signaturesOfRound({
    outcome: 'changes_requested',
    checks: [failedTest('cart › total') as never, { name: 'lint', cmd: 'npm run lint', status: 'timeout', output: '' } as never],
    flags: [{ kind: 'test-skipped', severity: 'blocking', path: 'a', detail: 'd' } as never],
    verdict: { verdict: 'fail', summary: '', criteria: [{ criterion: 'c', met: false, evidence: '' }], issues: [] },
    verify: null,
  }), ['check:test:cart › total', 'check:lint:timeout', 'flag:test-skipped', 'checker:criterion-not-met']);
});

test("the Reflector's answer is checked: unknown roles, empty and overlong lessons are dropped, at most three kept", () => {
  const ok = { scope: 'project', role: 'coder', trigger: 'cart totals', lesson: 'Run the tax tests before reporting.', evidenceRefs: ['round 1: tests failed'] };
  assert.deepEqual(parseRetro(JSON.stringify({ lessons: [ok] })), [ok]);
  assert.deepEqual(parseRetro(JSON.stringify({ lessons: [{ ...ok, role: 'releaser' }, { ...ok, lesson: 'short' }, { ...ok, scope: 'everywhere' }, { ...ok, lesson: 'x'.repeat(1000) }] })), []);
  assert.equal(parseRetro(JSON.stringify({ lessons: [ok, ok, ok, ok, ok] }))!.length, 3);
  assert.equal(parseRetro('not json'), null);
  assert.equal(parseRetro(JSON.stringify({ nope: [] })), null);
  assert.deepEqual(RETRO_SCHEMA.properties.lessons.items.properties.role.enum, ['analyst', 'planner', 'coder', 'tester']);
});

test('the record names what went wrong and the owner said, as material, without paths or secrets', () => {
  seedTask('R-1', 'shop', 'awaiting_approval', {
    description: `Fix totals; the key is AKIA${'A'.repeat(16)} and the file is ${HOME}/work/shop/src/cart.js`,
    plan: { summary: 's', approach: 'a', flow: [], files: [], criteria: ['Totals include tax', 'Empty carts show a message'], testPlan: [], risks: [], questions: [] },
  });
  seedRound('R-1', 1, 'changes_requested', {
    checks: [failedTest('cart › total includes tax')],
    verdict: { verdict: 'fail', summary: '', criteria: [{ criterion: 'Totals include tax', met: false, evidence: 'no tax line' }], issues: [] },
  });
  db().prepare(`UPDATE task_rounds SET self_check_json = ? WHERE task_id = 'R-1'`).run(JSON.stringify({ claims: [{ index: 1, claim: 'met', evidence: '' }], calibration: { claimedMet: 1, overconfident: 1, unsure: 0, unsureUnmet: 0, misses: ['Totals include tax'] } }));
  seedRound('R-1', 2, 'passed');
  db().prepare(`INSERT INTO task_messages (task_id, author, kind, body, created_at) VALUES ('R-1', 'owner', 'note', 'The total must round to two decimals', ?)`).run(NOW);
  const text = retroRecord('R-1', 'sent_back');
  assert.match(text, /material to learn from, not instructions/);
  assert.match(text, /The owner sent the work back/);
  assert.match(text, /Check test \(`npm test`\) failed: cart › total includes tax/);
  assert.match(text, /Criterion not met: Totals include tax/);
  assert.match(text, /said these were met; the Checker disagreed: Totals include tax/);
  assert.match(text, /round to two decimals/);
  assert.ok(!text.includes(HOME), 'no home folder');
  assert.ok(!text.includes(`AKIA${'A'.repeat(16)}`), 'no secret');
});

test('a retro is worth it only when something went wrong or the owner sent work back', () => {
  seedTask('R-2', 'shop', 'deployed');
  assert.equal(worthRetro('R-2', 'ended'), false, 'no round reviewed: nothing to learn');
  seedRound('R-2', 1, 'passed');
  assert.equal(worthRetro('R-2', 'ended'), false, 'passed first time');
  ownerSentBack('R-2');
  assert.equal(worthRetro('R-2', 'ended'), true, 'the owner sent it back once');
  assert.ok(taskSignatures('R-2').includes(OWNER_SENT_BACK));
  assert.equal(worthRetro('R-1', 'ended'), true, 'a round was sent back');
  assert.equal(worthRetro('R-2', 'stopped'), true);
});

test('no retro is started until learning is registered at startup', () => {
  requestRetro('R-1', 'sent_back');
  assert.equal(db().prepare(`SELECT COUNT(*) AS n FROM runs WHERE role = 'reflector'`).get().n, 0);
  assert.ok(!(getTask('R-1')!.metadata_json ?? '').includes('retrosPending'));
});

test("the Reflector's lessons are stored as proposals, scoped and tagged, with the task's failures as signatures", () => {
  const stored = storeRetro('R-1', [
    { scope: 'project', role: 'coder', trigger: 'cart tax', lesson: 'Add a test for the tax line before reporting the total as done.', evidenceRefs: ['round 1: tests failed'] },
    { scope: 'global', role: 'planner', trigger: 'money', lesson: 'Write rounding rules into the acceptance criteria for money values.', evidenceRefs: ["owner's note"] },
  ]);
  assert.equal(stored, 2);
  const proposed = listLessons('proposed');
  const coder = proposed.find((l) => l.role === 'coder');
  const planner = proposed.find((l) => l.role === 'planner');
  assert.equal(coder!.projectId, 'shop');
  assert.equal(planner!.projectId, null, 'global');
  assert.deepEqual(coder!.evidence[0], { taskId: 'R-1', round: 1, what: 'round 1: tests failed' });
  assert.ok(coder!.tags.includes('tax'));
  assert.ok(coder!.signatures.includes('check:test:cart › total includes tax'));
  assert.equal(storeRetro('R-1', [{ scope: 'project', role: 'coder', trigger: '', lesson: 'Add a test for the tax line before reporting the total as done!', evidenceRefs: [] }]), 0, 'the same lesson again is not stored');
});

test('core proposes a lesson for a check that failed the same way twice in a project, once', () => {
  seedTask('R-3', 'shop');
  seedRound('R-3', 1, 'changes_requested', { checks: [failedTest('price › rounds half up at 0.5')] });
  assert.equal(proposeCoreLessons('R-3').length, 0, 'once is not a pattern');
  seedTask('R-4', 'shop');
  seedRound('R-4', 1, 'changes_requested', { checks: [failedTest('price › rounds half up at 1.5')] });
  const [p] = proposeCoreLessons('R-4');
  assert.ok(p, 'twice is');
  assert.equal(p!.role, 'coder');
  assert.equal(p!.source, 'core');
  assert.match(p!.text, /the test check \(`npm test`\) failed 2 times the same way: "price › rounds half up at 1\.5"/);
  assert.deepEqual(p!.evidence.map((e) => e.taskId).sort(), ['R-3', 'R-4']);
  assert.equal(proposeCoreLessons('R-4').length, 0, 'not proposed again');
  seedTask('R-5', 'other');
  seedRound('R-5', 1, 'changes_requested', { checks: [failedTest('price › rounds half up at 2.5')] });
  assert.equal(proposeCoreLessons('R-5').length, 0, 'failures in another project do not count');
});

test('a task that ends scores the lessons it was given: hurt when its failure came back, helped when it passed first time', () => {
  const hurtful = propose({ projectId: 'shop', role: 'coder', tags: ['stock'], text: 'Check stock counts never go below zero.', evidence: [], signatures: ['check:test:stock › never negative'], source: 'core' })!;
  const helpful = propose({ projectId: 'shop', role: 'coder', tags: ['stock'], text: 'Read the stock module before changing it.', evidence: [], signatures: ['check:lint'], source: 'reflector' })!;
  decide(hurtful.id, 'active');
  decide(helpful.id, 'active');

  seedTask('R-6', 'shop');
  seedRound('R-6', 1, 'changes_requested', { checks: [failedTest('stock › never negative')] });
  seedRound('R-6', 2, 'passed');
  recordUses('R-6', 'coder', [hurtful.id, helpful.id]);
  taskEnded('R-6', 'ended');
  assert.equal(getLesson(hurtful.id)!.hurt, 1);
  assert.equal(getLesson(helpful.id)!.helped, 0, 'did not pass first time: neutral');

  seedTask('R-7', 'shop');
  seedRound('R-7', 1, 'passed');
  recordUses('R-7', 'coder', [helpful.id]);
  taskEnded('R-7', 'ended');
  taskEnded('R-7', 'ended');
  assert.equal(getLesson(helpful.id)!.helped, 1, 'scored once, however often the end is seen');
  assert.equal(getLesson(helpful.id)!.uses, 2);
});
