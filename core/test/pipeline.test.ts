// The whole pipeline with stand-in agents: real git, real sandboxed checks, scripted
// planner / coder / tester. What each agent "does" is set per scenario in script().
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// The sandbox runs on macOS and on Linux (bubblewrap); elsewhere there is none to test.
const skip = !['darwin', 'linux'].includes(process.platform);
// Under the home folder, like real workspaces, so the sandbox's home rule is in play.
const tmp = path.join(os.homedir(), '.fryday-code', `pipeline-test-${randomBytes(4).toString('hex')}`);
fs.mkdirSync(tmp, { recursive: true });
const planFile = path.join(tmp, 'script.json');
const wrapper = path.join(tmp, 'claude-wrapper.sh');
fs.writeFileSync(
  wrapper,
  `#!/bin/sh\nexport FAKE_PLAN_FILE='${planFile}'\nexec node '${path.join(__dirname, 'fixtures', 'fake-claude.mjs')}' "$@"\n`,
  { mode: 0o755 }
);
process.env.FRYDAY_HOME = tmp;
process.env.FRYDAY_MAC_NOTIFY = 'off';
// These tests are about the pipeline, not about waiting for a busy Mac to have memory.
process.env.FRYDAY_MEMORY_WAIT_MS = '0';
process.env.FRYDAY_DB = path.join(tmp, 'test.db');
process.env.FRYDAY_RUNS = path.join(tmp, 'runs');
process.env.FRYDAY_WORKTREES = path.join(tmp, 'worktrees');
process.env.FRYDAY_SCRATCH = path.join(tmp, 'scratch');
process.env.CLAUDE_BIN = wrapper;
process.env.FRYDAY_CORE_SECRET = 'test-secret-not-a-real-credential';
process.env.FRYDAY_MAX_AGENTS = '2';
// A run that failed because the AI service was busy is retried at once here, not after 30 s.
process.env.FRYDAY_RETRY_BACKOFF_MS = '0';

import { initDb, getDb } from '../src/db/db';
import { overrideRepo, saveProject } from '../src/registry/registry';
import { activeRunIds, stopFollowing } from '../src/runner/supervisor';
import { startTask, registerPipeline, StartError, stoppedChoices, tryAgainAfterStop, acceptAsItIs, StoppedError, stopTask, sendBackToBuilder, canSendBack, canStop } from '../src/pipeline/pipeline';
import { addMessage } from '../src/pipeline/thread';
import { getWorkspaces, discardWorkspaces, readGuidance } from '../src/pipeline/workspaces';
import { getRounds } from '../src/pipeline/rounds';
import { getTask, setTaskState } from '../src/pipeline/taskState';
import { parsePlan } from '../src/pipeline/review';
import { isBusyServiceError, retryWhenBusy, cancelPendingRetry } from '../src/pipeline/retry';
import { latestApproval, resolveApproval } from '../src/pipeline/approvals';
import { updateSettings } from '../src/settings';
import { saveCursorKey, removeCursorKey } from '../src/runner/runners';

const origin = path.join(tmp, 'origin.git');
const main = path.join(tmp, 'main');
const REPO = 'scratch'; // the project added in before(), pointing at the scratch repo below
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { encoding: 'utf8' }).trim();

const GOOD_MATH = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';
const BROKEN_MATH = 'exports.add = (a, b) => a - b;\nexports.mul = (a, b) => a * b;\n';
const BASE_TEST = "const { test } = require('node:test');\nconst assert = require('node:assert');\nconst m = require('../src/math');\ntest('add', () => assert.equal(m.add(2, 3), 5));\n";
const GOOD_TEST = `${BASE_TEST}test('mul', () => assert.equal(m.mul(2, 3), 6));\n`;
const SKIPPED_TEST = BASE_TEST.replace("test('add'", "test.skip('add'") + "test('mul', () => assert.equal(m.mul(2, 3), 6));\n";

const PLAN = {
  summary: 'Add a mul function next to add.',
  approach: 'Export mul from src/math.js and cover it in test/math.test.js.',
  flow: [{ step: 'call', detail: 'callers require src/math and call mul(a, b)' }],
  files: ['src/math.js', 'test/math.test.js'],
  criteria: ['mul(2, 3) returns 6', 'add keeps working'],
  testPlan: ['node --test'],
  risks: [],
  questions: [],
};
const pass = { verdict: 'pass', summary: 'Meets the criteria.', criteria: PLAN.criteria.map((criterion) => ({ criterion, met: true, evidence: 'ran node --test' })), issues: [] };
const good = { write: { 'src/math.js': GOOD_MATH, 'test/math.test.js': GOOD_TEST } };

interface Call { role: string; job: string; call: number; overloaded?: boolean; prompt: string; argv: string[]; cwd: string; taskFolder?: string; files?: { brief: string; patch: string } }

function script(s: { planner?: unknown; coder: unknown[]; tester?: unknown[]; overloaded?: Record<string, number> }) {
  for (const f of [`${planFile}.count.json`, `${planFile}.calls.jsonl`]) fs.rmSync(f, { force: true });
  fs.writeFileSync(planFile, JSON.stringify({ planner: PLAN, tester: [pass], ...s }));
}
const calls = (): Call[] =>
  fs.existsSync(`${planFile}.calls.jsonl`) ? fs.readFileSync(`${planFile}.calls.jsonl`, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];

let seq = 0;
function addTask(title: string): string {
  const id = `T-${++seq}`;
  getDb().prepare(`INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, 0)`)
    .run(id, seq, title, `${title} — details`);
  return id;
}
const note = (id: string) => JSON.parse(getTask(id)!.metadata_json ?? '{}').note as string;

async function runToRest(id: string, timeoutMs = 60_000): Promise<string> {
  startTask(id, REPO);
  const start = Date.now();
  const resting = new Set(['awaiting_approval', 'needs_owner', 'failed']);
  while (!resting.has(getTask(id)!.state) || activeRunIds().length > 0) {
    if (Date.now() - start > timeoutMs) throw new Error(`${id} still ${getTask(id)!.state} after ${timeoutMs} ms: ${note(id)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return getTask(id)!.state;
}
const outcomes = (id: string) => getRounds(id).map((r) => r.outcome);
async function waitUntil(what: string, cond: () => boolean, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const ownerState = () => ({ status: sh(main, 'status', '--porcelain'), head: sh(main, 'rev-parse', 'HEAD'), branch: sh(main, 'rev-parse', '--abbrev-ref', 'HEAD') });
let ownerBefore: ReturnType<typeof ownerState>;

before(() => {
  fs.mkdirSync(path.join(main, 'src'), { recursive: true });
  fs.mkdirSync(path.join(main, 'test'), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', '-b', 'release', origin]);
  execFileSync('git', ['init', '-q', '-b', 'release', main]);
  sh(main, 'config', 'user.name', 'Test');
  sh(main, 'config', 'user.email', 'test@example.invalid');
  fs.writeFileSync(path.join(main, 'src', 'math.js'), 'exports.add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(main, 'test', 'math.test.js'), BASE_TEST);
  fs.writeFileSync(path.join(main, 'package.json'), '{"name":"scratch","version":"1.0.0"}\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'CLAUDE.md\nnode_modules\n');
  sh(main, 'add', '-A');
  sh(main, 'commit', '-q', '-m', 'init');
  sh(main, 'remote', 'add', 'origin', origin);
  sh(main, 'push', '-q', '-u', 'origin', 'release');
  fs.writeFileSync(path.join(main, 'src', 'math.js'), 'exports.add = (a, b) => a + b; // owner is editing\n');
  fs.writeFileSync(path.join(main, 'CLAUDE.md'), 'Use CommonJS exports.\n');
  ownerBefore = ownerState();

  initDb(process.env.FRYDAY_DB!);
  registerPipeline();
  saveProject({ id: REPO, name: 'Scratch repo', localPath: main, prodBranch: 'release', testCmd: 'node --test', verified: true });
  saveProject({ id: 'unverified', name: 'Not confirmed yet', localPath: main, prodBranch: 'release', verified: false });
});
after(() => { stopFollowing(); if (!process.env.FRYDAY_KEEP_TEST_HOME) fs.rmSync(tmp, { recursive: true, force: true }); });

test('a clean change is planned, coded, checked, reviewed and handed over in one round', { skip }, async () => {
  script({ coder: [good] });
  const id = addTask('Add mul');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.match(note(id), /^Passed checks and review in 1 round\./);

  // The plan was stored and given to the coder; repo guidance reached every agent.
  assert.deepEqual(parsePlan(getTask(id)!.plan_json), PLAN);
  const [analyst, planner, coder, tester] = calls();
  assert.deepEqual(calls().map((c) => c.role), ['analyst', 'planner', 'coder', 'tester']);
  assert.match(coder!.prompt, /## Acceptance criteria\n\n1\. mul\(2, 3\) returns 6\n2\. add keeps working/);

  // The Analyst read the task in a throwaway read-only checkout, and its brief reached the planner.
  assert.equal(analyst!.argv[analyst!.argv.indexOf('--tools') + 1], 'Read,Grep,Glob', 'the analyst is read-only');
  assert.match(analyst!.cwd, /\.analysis$/);
  assert.equal(fs.existsSync(analyst!.cwd), false, 'the analysis checkout is removed afterwards');
  assert.match(analyst!.taskFolder!, /^# Task T-1: Add mul\n\nAdd mul — details/);
  assert.match(analyst!.taskFolder!, /## Existing branches with unmerged work\n\nNone\./);
  assert.match(planner!.prompt, /## What is being asked \(from the Analyst\)\n\nA clear task\.\n\n## Requirements\n\n1\. Do what the task says\./);
  assert.equal(JSON.parse(getTask(id)!.brief_json!).summary, 'A clear task.');

  for (const c of [analyst!, planner!, coder!, tester!]) {
    assert.match(c.argv[c.argv.indexOf('--append-system-prompt') + 1]!, /Use CommonJS exports\./, `${c.role} got the repo guidance`);
    assert.ok(c.argv.includes('--settings'), `${c.role} is confined`);
  }
  assert.equal(planner!.argv[planner!.argv.indexOf('--tools') + 1], 'Read,Grep,Glob', 'the planner is read-only');
  assert.equal(tester!.argv[tester!.argv.indexOf('--tools') + 1], 'Read,Bash,Grep,Glob', 'the tester cannot edit');

  // The tester worked in a throwaway checkout with a brief, not in the coder's folder.
  const [ws] = getWorkspaces(id);
  assert.equal(tester!.cwd, `${ws!.worktree_path}.review`);
  assert.match(tester!.files!.brief, /1\. mul\(2, 3\) returns 6/);
  assert.match(tester!.files!.brief, /- test — `node --test`: passed/);
  assert.match(tester!.files!.patch, /\+exports\.mul = /);

  const [round] = getRounds(id);
  assert.equal(round!.outcome, 'passed');
  assert.deepEqual(round!.checks.map((c) => [c.name, c.status]), [['test', 'passed']]);
  assert.equal(round!.verdict!.verdict, 'pass');

  // The branch holds the change and nothing of the review; the review checkout is gone.
  assert.deepEqual(sh(main, 'diff', '--name-only', `${ws!.base_sha}..${ws!.branch}`).split('\n'), ['src/math.js', 'test/math.test.js']);
  assert.equal(fs.existsSync(`${ws!.worktree_path}.review`), false);
});

test('a failing check goes back to the coder with the output, and the fix passes', { skip }, async () => {
  script({ coder: [{ write: { 'src/math.js': BROKEN_MATH, 'test/math.test.js': GOOD_TEST } }, good] });
  const id = addTask('Add mul with a slip');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.match(note(id), /in 2 rounds/);
  assert.deepEqual(outcomes(id), ['changes_requested', 'passed']);

  const [r1, r2] = getRounds(id);
  assert.deepEqual(r1!.checks.map((c) => [c.name, c.status]), [['test', 'failed']]);
  assert.equal(r1!.verdict, null, 'the tester is not asked about a change that fails its checks');
  assert.deepEqual(r2!.checks.map((c) => [c.name, c.status]), [['test', 'passed']]);

  const coderCalls = calls().filter((c) => c.role === 'coder');
  assert.equal(coderCalls.length, 2);
  assert.match(coderCalls[1]!.prompt, /^The review of round 1 found problems\./);
  assert.match(coderCalls[1]!.prompt, /## Checks that fail/);
  assert.match(coderCalls[1]!.prompt, /expected: 5\s+actual: -1/, 'the real test output is in the feedback');
  assert.ok(coderCalls[1]!.argv.includes('--resume'), 'the coder continues its own conversation');
  assert.equal(calls().filter((c) => c.role === 'tester').length, 1);
  // The reviewer of the fixed round sees this commit's checks only, never round 1's failing output
  // (it once took that old failure for the current result and failed a correct change).
  const brief = calls().find((c) => c.role === 'tester')!.files!.brief;
  assert.doesNotMatch(brief, /Checks that fail|actual: -1|earlier rounds/);
});

test('skipping a test to get green checks is caught and sent back', { skip }, async () => {
  // Broken code, and the test that would show it is skipped: the checks pass.
  script({ coder: [{ write: { 'src/math.js': BROKEN_MATH, 'test/math.test.js': SKIPPED_TEST } }, good] });
  const id = addTask('Add mul by cheating');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.deepEqual(outcomes(id), ['changes_requested', 'passed']);

  const [r1] = getRounds(id);
  assert.deepEqual(r1!.checks.map((c) => c.status), ['passed'], 'the checks alone would have let it through');
  assert.deepEqual(r1!.flags.map((f) => [f.severity, f.kind, f.path]), [['blocking', 'test-skipped', 'test/math.test.js']]);
  assert.equal(r1!.verdict, null);
  assert.match(r1!.feedback!, /## Changes that are not allowed/);
  assert.match(r1!.feedback!, /test\/math\.test\.js: a test was skipped: test\.skip\('add'/);
});

test('the tester can send a change back, and its word "pass" does not outrank an unmet criterion', { skip }, async () => {
  const rejected = {
    verdict: 'fail', summary: 'mul is untested for negatives.',
    criteria: PLAN.criteria.map((criterion) => ({ criterion, met: true, evidence: 'ran it' })),
    issues: [{ severity: 'blocking', file: 'test/math.test.js', description: 'no test for negative factors' }],
  };
  const passWithUnmet = { ...pass, criteria: [{ criterion: PLAN.criteria[0], met: false, evidence: 'mul(2, 3) was never run' }] };
  script({ coder: [good], tester: [rejected, passWithUnmet, pass] });
  const id = addTask('Add mul under review');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.deepEqual(outcomes(id), ['changes_requested', 'changes_requested', 'passed']);

  const [r1, r2] = getRounds(id);
  assert.match(r1!.feedback!, /## Tester's findings\n\n- \[blocking\] test\/math\.test\.js: no test for negative factors/);
  assert.equal(r2!.verdict!.verdict, 'pass');
  assert.match(r2!.feedback!, /## Acceptance criteria not met\n\n- mul\(2, 3\) returns 6/);
});

test('after the round limit the task goes to the owner with the reason', { skip }, async () => {
  script({ coder: [{ write: { 'src/math.js': BROKEN_MATH, 'test/math.test.js': GOOD_TEST } }] }); // never fixed
  const id = addTask('Add mul that never works');
  assert.equal(await runToRest(id), 'needs_owner');
  assert.deepEqual(outcomes(id), ['changes_requested', 'changes_requested', 'escalated']);
  assert.equal(note(id), 'Still not passing after 3 rounds — failing checks: test');
  // A failing check is not a judgement the owner can overrule; one more round is all they can ask for.
  assert.deepEqual(stoppedChoices(id), { tryAgain: true, accept: false, why: null });
  assert.throws(() => acceptAsItIs(id), StoppedError);
  assert.equal(calls().filter((c) => c.role === 'coder').length, 3);
  assert.equal(calls().filter((c) => c.role === 'tester').length, 0);
  // The work stays on the branch for the owner to look at.
  const [ws] = getWorkspaces(id);
  assert.equal(sh(main, 'rev-list', '--count', `${ws!.base_sha}..${ws!.branch}`), '1');
});

// The Checker keeps saying no to work whose checks pass (T-1 on a real repo: a lint criterion
// that repo cannot meet). The owner decides: accept it as it is, or one more round with a note.
const neverPasses = {
  verdict: 'fail', summary: 'The code is right, but npm run lint cannot pass in this repo.',
  criteria: PLAN.criteria.map((criterion, i) => ({ criterion, met: i > 0, evidence: 'ran it' })),
  issues: [],
};

test('a task the Checker keeps rejecting can be accepted as it is, and goes on to the usual approval', { skip }, async () => {
  script({ coder: [good], tester: [neverPasses] });
  const id = addTask('Add mul the Checker will not pass');
  assert.equal(await runToRest(id), 'needs_owner');
  assert.deepEqual(outcomes(id), ['changes_requested', 'changes_requested', 'escalated']);
  assert.deepEqual(stoppedChoices(id), { tryAgain: true, accept: true, why: neverPasses.summary });

  acceptAsItIs(id);
  assert.equal(getTask(id)!.state, 'awaiting_approval');
  assert.deepEqual(outcomes(id), ['changes_requested', 'changes_requested', 'accepted']);
  // Accepting pushes nothing: the next step is the one a passed round gets. This project has no
  // staging branch, so (as for a passed round) the branch is simply ready and no ticket is raised.
  assert.match(note(id), /^You accepted the change as it is, with the Checker's open points\. The branch is ready\./);
  assert.equal(latestApproval(id), undefined);
  assert.deepEqual(stoppedChoices(id), { tryAgain: false, accept: false, why: null }, 'nothing left to decide');
  assert.throws(() => acceptAsItIs(id), StoppedError);
  await assert.rejects(tryAgainAfterStop(id), StoppedError);
});

test('trying again gives the Builder one more round, and the Checker reads what the owner wrote', { skip }, async () => {
  script({ coder: [good], tester: [neverPasses, neverPasses, neverPasses, pass] });
  const id = addTask('Add mul, then waive the lint point');
  assert.equal(await runToRest(id), 'needs_owner');
  addMessage(id, 'owner', 'note', 'Skip the lint check: this project has no lint set up.');
  await tryAgainAfterStop(id);
  assert.equal(getTask(id)!.state, 'coding');
  await assert.rejects(tryAgainAfterStop(id), StoppedError, 'a second press while it runs does nothing');
  while (getTask(id)!.state !== 'awaiting_approval' || activeRunIds().length > 0) {
    assert.notEqual(getTask(id)!.state, 'failed', note(id));
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(outcomes(id), ['changes_requested', 'changes_requested', 'escalated', 'passed']);
  const coders = calls().filter((c) => c.role === 'coder');
  assert.equal(coders.length, 4);
  assert.match(coders.at(-1)!.prompt, /Skip the lint check/, 'the Builder is told');
  const brief = calls().filter((c) => c.role === 'tester').at(-1)!.files!.brief;
  assert.match(brief, /## What the owner said[\s\S]*Skip the lint check: this project has no lint set up\./, 'so is the Checker');
});

// The owner tried the work and it is not right. Before, what they wrote was kept as a note that
// no agent read, because nothing started again once a task had passed review.
test('work that passed can be sent back to the Builder with what the owner found', { skip }, async () => {
  script({ coder: [good], tester: [pass] });
  const id = addTask('Add mul, then find it does not work');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.equal(canSendBack(id), true);
  await assert.rejects(sendBackToBuilder(id, '   '), StoppedError, 'an empty note says nothing to fix');

  await sendBackToBuilder(id, 'mul(2, -3) gives the wrong sign when I try it.');
  assert.equal(getTask(id)!.state, 'coding');
  assert.equal(canSendBack(id), false, 'not while the Builder is on it');
  await assert.rejects(sendBackToBuilder(id, 'again'), StoppedError);
  while (getTask(id)!.state !== 'awaiting_approval' || activeRunIds().length > 0) {
    assert.notEqual(getTask(id)!.state, 'failed', note(id));
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(outcomes(id), ['passed', 'passed'], 'one more round, checked again');
  const coders = calls().filter((c) => c.role === 'coder');
  assert.equal(coders.length, 2);
  assert.match(coders.at(-1)!.prompt, /The owner tried the change and it does not do what they need/);
  assert.match(coders.at(-1)!.prompt, /mul\(2, -3\) gives the wrong sign/, 'with their own words');
  assert.match(coders.at(-1)!.prompt, /which project it belongs in/, 'and told to name work that belongs elsewhere');
});

test('stopping a task withdraws what waits on the owner and runs nothing more', { skip }, async () => {
  script({ coder: [good], tester: [pass] });
  const id = addTask('Add mul, then stop');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.equal(canStop(id), true);
  await stopTask(id);
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.match(note(id), /^You stopped the task/);
  assert.equal(getDb().prepare(`SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND state = 'pending'`).get(id)!.n, 0);
  assert.equal(activeRunIds().length, 0);
  assert.equal(canStop(id), false, 'nothing left to stop');
  // The work is still there, so it can be sent back to be fixed from here.
  assert.equal(canSendBack(id), true);
});

test('stopping a task while an agent is working stops the agent', { skip }, async () => {
  script({ coder: [{ ...good, tokens: 1_000 }], tester: [pass] }); // keeps working turn after turn
  const id = addTask('Add mul slowly, then stop');
  startTask(id, REPO);
  await waitUntil('the coder to start', () => getTask(id)!.state === 'coding' && activeRunIds().length > 0);
  await stopTask(id);
  await waitUntil('the coder to stop', () => activeRunIds().length === 0, 20_000);
  assert.equal(getTask(id)!.state, 'needs_owner', 'the coder exiting does not hand it over a second time');
  assert.match(note(id), /^You stopped the task/);
});

test('a check that already failed before the task does not block it', { skip }, async () => {
  overrideRepo(REPO, { lintCmd: 'echo "legacy lint debt"; exit 1' });
  try {
    script({ coder: [good] });
    const id = addTask('Add mul despite lint debt');
    assert.equal(await runToRest(id), 'awaiting_approval');
    const [round] = getRounds(id);
    assert.deepEqual(round!.checks.map((c) => [c.name, c.status]), [['lint', 'preexisting'], ['test', 'passed']]);
    const tester = calls().find((c) => c.role === 'tester')!;
    assert.match(tester.files!.brief, /- lint — .*: fails, but it already failed before this task/);
    const [ws] = getWorkspaces(id);
    assert.equal(fs.existsSync(`${ws!.worktree_path}.base`), false, 'the base checkout is removed after use');
  } finally {
    overrideRepo(REPO, { lintCmd: null });
  }
});

test('a risky but allowed change passes with a flag for the owner', { skip }, async () => {
  script({ coder: [{ write: { ...good.write, '.github/workflows/ci.yml': 'on: push\n' } }] });
  const id = addTask('Add mul and a workflow');
  assert.equal(await runToRest(id), 'awaiting_approval');
  assert.match(note(id), /1 change flagged for your attention/);
  const [round] = getRounds(id);
  assert.deepEqual(round!.flags.map((f) => [f.severity, f.kind]), [['review', 'hook-or-ci']]);
  assert.match(calls().find((c) => c.role === 'tester')!.files!.brief, /\[review\] \.github\/workflows\/ci\.yml/);
});

test('an agent that reaches its token limit is stopped by core and the task pauses until the owner says to go on', { skip }, async () => {
  // Round 1: the coder writes half the change, then keeps going until core stops it at its
  // 1.5M-token limit. After the owner's yes it finishes.
  script({ coder: [{ write: { 'src/math.js': GOOD_MATH }, tokens: 200_000 }, good] });
  const id = addTask('Add mul on a tight budget');
  assert.equal(await runToRest(id), 'needs_owner');
  assert.match(note(id), /^Paused at a token limit\. The Builder on T-\d+ reached its 1\.5M-token limit for one go \([\d.]+M used on the task so far\)\. Let it go on\?$/);
  const stopped = getDb().prepare(`SELECT state, error_msg, token_limit FROM runs WHERE task_id = ? AND role = 'coder'`).get(id);
  assert.deepEqual(stopped, { state: 'budget', error_msg: 'stopped: it reached its token limit', token_limit: 1_500_000 });

  const ticket = latestApproval(id)!;
  assert.deepEqual([ticket.action, ticket.state, ticket.commit_sha], ['continue_budget', 'pending', null]);
  assert.deepEqual(JSON.parse(ticket.payload_json).stage, { role: 'coder', round: 1 });
  // What it had done so far is kept on the branch.
  const [ws] = getWorkspaces(id);
  assert.equal(sh(main, 'show', `${ws!.branch}:src/math.js`), GOOD_MATH.trim());
  assert.equal(getRounds(id).length, 0, 'nothing was reviewed yet');

  let done = false;
  resolveApproval(ticket.id, 'approved', { via: 'cookie' }, () => { done = true; });
  await waitUntil('the coder to be restarted', () => done);
  await waitUntil('the task to rest again', () => getTask(id)!.state === 'awaiting_approval' && activeRunIds().length === 0);

  const coderCalls = calls().filter((c) => c.role === 'coder');
  assert.equal(coderCalls.length, 2);
  assert.match(coderCalls[1]!.prompt, /^You were stopped because you reached your token limit/);
  assert.ok(coderCalls[1]!.argv.includes('--resume'), 'it continues its own conversation');
  assert.deepEqual(outcomes(id), ['passed']);
  assert.deepEqual(getDb().prepare(`SELECT round, state FROM runs WHERE task_id = ? AND role = 'coder' ORDER BY started_at`).all(id), [
    { round: 1, state: 'budget' }, { round: 1, state: 'completed' },
  ]);
});

test('declining at the limit keeps the work and stops the task (here the hidden money cap was reached)', { skip }, async () => {
  script({ coder: [{ write: { 'src/math.js': GOOD_MATH }, budget: true }] });
  const id = addTask('Add mul, then stop');
  assert.equal(await runToRest(id), 'needs_owner');
  resolveApproval(latestApproval(id)!.id, 'rejected', { via: 'cookie' });
  assert.equal(getTask(id)!.state, 'needs_owner');
  assert.equal(note(id), 'You stopped the task at its token limit. The branch and the work so far are kept.');
  assert.equal(calls().filter((c) => c.role === 'coder').length, 1);
});

test('a task that has used up its whole token budget asks before starting the next agent', { skip }, async () => {
  // Each stand-in run counts 35 tokens (7 in + 11 out + 17 cache writes; its 13 cache reads do
  // not count). With a 35-token task budget every agent uses all that is left, so the task asks
  // before each of the next three.
  updateSettings({ taskTokenLimit: 35 });
  try {
    script({ coder: [good] });
    const id = addTask('Add mul within a small task budget');
    assert.equal(await runToRest(id), 'needs_owner');
    assert.match(note(id), /has used 35 of its 35 tokens\. Allow another 35\?$/);
    assert.deepEqual(calls().map((c) => c.role), ['analyst'], 'the planner was not started');
    const ticket = latestApproval(id)!;
    assert.deepEqual(JSON.parse(ticket.payload_json), {
      summary: `${id} has used 35 of its 35 tokens. Allow another 35?`, stage: { role: 'planner', round: 0 }, why: 'task', usedTokens: 35,
    });

    // Each yes allows another 35 on top of what was used. The next agent is given exactly
    // that, uses it, and the task asks again before the one after.
    const approveAndWait = async (expectStage: unknown, usedSoFar: string): Promise<void> => {
      const ticket = latestApproval(id)!;
      assert.deepEqual(JSON.parse(ticket.payload_json).stage, expectStage);
      let started = false;
      resolveApproval(ticket.id, 'approved', { via: 'cookie' }, () => { started = true; });
      await waitUntil('the approved agent to start', () => started);
      await waitUntil('the next pause', () => getTask(id)!.state === 'needs_owner' && activeRunIds().length === 0 && latestApproval(id)!.id !== ticket.id);
      assert.ok(note(id).includes(`has used ${usedSoFar} of its ${usedSoFar} tokens`), note(id));
    };
    await approveAndWait({ role: 'planner', round: 0 }, '70');
    assert.equal(JSON.parse(getTask(id)!.metadata_json!).tokenLimit, 70, 'the yes raised the task limit in tokens');
    assert.deepEqual(calls().map((c) => c.role), ['analyst', 'planner'], 'the coder was not started without a yes');
    await approveAndWait({ role: 'coder', round: 1 }, '105');
    const coderRun = getDb().prepare(`SELECT token_limit FROM runs WHERE task_id = ? AND role = 'coder'`).get(id) as { token_limit: number };
    assert.equal(coderRun.token_limit, 35, 'the coder was given what the task had left');
    assert.equal(calls().some((c) => c.role === 'tester'), false, 'the reviewer was not started without a yes');

    // The last yes: the review runs and the task is handed over.
    assert.deepEqual(JSON.parse(latestApproval(id)!.payload_json).stage, { role: 'tester', round: 1 });
    let done = false;
    resolveApproval(latestApproval(id)!.id, 'approved', { via: 'cookie' }, () => { done = true; });
    await waitUntil('the review to start', () => done);
    await waitUntil('the task to rest', () => getTask(id)!.state === 'awaiting_approval' && activeRunIds().length === 0);
    assert.deepEqual(outcomes(id), ['passed']);
  } finally {
    updateSettings({ taskTokenLimit: 4_000_000 });
  }
});

test('a run stopped because the task ran out of tokens gets the task wording, not the agent one', { skip }, async () => {
  // The analyst and planner use 35 each, so the coder is given what is left of 300k and is
  // stopped at that; the task is then out of tokens, which is what the owner is told.
  updateSettings({ taskTokenLimit: 300_000 });
  try {
    script({ coder: [{ write: { 'src/math.js': GOOD_MATH }, tokens: 200_000 }] });
    const id = addTask('Add mul on a small task budget');
    assert.equal(await runToRest(id), 'needs_owner');
    const ticket = latestApproval(id)!;
    const payload = JSON.parse(ticket.payload_json);
    assert.equal(payload.why, 'task');
    assert.match(payload.summary, /^T-\d+ has used [\d.]+[kM] of its 300k tokens\. Allow another 300k\?$/);
    assert.doesNotMatch(payload.summary, /for one go/);
  } finally {
    updateSettings({ taskTokenLimit: 4_000_000 });
  }
});

test('an agent stopped at its own limit quotes the limit that run had, and a safety stop quotes none', { skip }, async () => {
  updateSettings({ roles: { coder: { tokenLimit: 120_000 } } });
  try {
    script({ coder: [{ write: { 'src/math.js': GOOD_MATH }, tokens: 200_000 }, good] });
    const id = addTask('Add mul within a 120k limit');
    assert.equal(await runToRest(id), 'needs_owner');
    const payload = JSON.parse(latestApproval(id)!.payload_json);
    assert.equal(payload.why, 'agent');
    assert.match(payload.summary, /^The Builder on T-\d+ reached its 120k-token limit for one go/);
    const run = getDb().prepare(`SELECT token_limit FROM runs WHERE task_id = ? AND role = 'coder'`).get(id) as { token_limit: number };
    assert.equal(run.token_limit, 120_000);
  } finally {
    updateSettings({ roles: { coder: { tokenLimit: 1_500_000 } } });
  }
  script({ coder: [{ write: { 'src/math.js': GOOD_MATH }, budget: true }] });
  const safety = addTask('Add mul, hit the safety cap');
  assert.equal(await runToRest(safety), 'needs_owner');
  const summary = JSON.parse(latestApproval(safety)!.payload_json).summary as string;
  assert.match(summary, /^The Builder on T-\d+ reached its safety limit \(/);
  assert.doesNotMatch(summary, /\d token|-token/);
});

test('a planner or coder that produces nothing usable hands the task to the owner', { skip }, async () => {
  script({ planner: { summary: 'incomplete' }, coder: [good] });
  const noPlan = addTask('Plan that is not a plan');
  assert.equal(await runToRest(noPlan), 'needs_owner');
  assert.equal(note(noPlan), 'The planner did not return a usable plan');
  assert.equal(calls().some((c) => c.role === 'coder'), false);

  script({ coder: [{}] });
  const noChange = addTask('Coder that changes nothing');
  assert.equal(await runToRest(noChange), 'needs_owner');
  assert.equal(note(noChange), 'The coder finished without changing any file');
});

test('only a busy AI service counts as a failure worth one more try', () => {
  for (const busy of [
    'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'API Error: Repeated 529 Overloaded errors',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}',
    'Request failed with status code 429',
  ]) assert.equal(isBusyServiceError(busy), true, busy);
  for (const other of [
    'Not logged in', 'agent exited without a result', 'Error: test failed at line 429', '', null, undefined,
    'API Error: 500 Internal server error',
    // An agent's own words about rate limits or overload are not the API being busy.
    'I could not finish: the upstream service is rate limited and overloaded (too many requests).',
    'The tests failed: expected the handler to answer 429 Too Many Requests when rate limiting kicks in.',
  ]) {
    assert.equal(isBusyServiceError(other), false, String(other));
  }
});

/** A task sitting in `state`, for the retry timer tests. */
function taskIn(title: string, state: 'coding'): string {
  const id = addTask(title);
  getDb().prepare('UPDATE tasks SET state = ? WHERE id = ?').run(state, id);
  return id;
}
const BUSY_EXIT = { state: 'failed', error: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}' };
async function withBackoff<T>(ms: number, work: () => Promise<T>): Promise<T> {
  const before = process.env.FRYDAY_RETRY_BACKOFF_MS;
  process.env.FRYDAY_RETRY_BACKOFF_MS = String(ms);
  try { return await work(); } finally { process.env.FRYDAY_RETRY_BACKOFF_MS = before; }
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a run whose final text only mentions rate limiting is not retried', () => {
  const id = taskIn('Agent talks about rate limits', 'coding');
  let again = 0;
  // A failed run whose error is its own words (the final text), not the API's answer.
  const retried = retryWhenBusy(id, { state: 'failed', error: 'The endpoint returns 429 when the rate limit is reached; I could not make the test pass.' }, { role: 'coder', round: 1 }, () => { again += 1; });
  assert.equal(retried, false);
  assert.equal(again, 0);
  assert.equal(JSON.parse(getTask(id)!.metadata_json ?? '{}').retried, undefined);
});

test('a busy-service retry starts once when nothing happened in the meantime', async () => {
  const id = taskIn('Retry with nothing in between', 'coding');
  let again = 0;
  await withBackoff(50, async () => {
    assert.equal(retryWhenBusy(id, BUSY_EXIT, { role: 'coder', round: 1 }, () => { again += 1; }), true);
    assert.equal(typeof JSON.parse(getTask(id)!.metadata_json!).pendingRetry, 'string');
    await pause(200);
  });
  assert.equal(again, 1);
  assert.equal(JSON.parse(getTask(id)!.metadata_json!).pendingRetry, undefined);
});

test('an owner-driven restart within the backoff does not get a second run from the old timer', async () => {
  const id = taskIn('Owner restarts during the backoff', 'coding');
  let again = 0;
  await withBackoff(100, async () => {
    assert.equal(retryWhenBusy(id, BUSY_EXIT, { role: 'coder', round: 1 }, () => { again += 1; }), true);
    // The owner stops the task and lets it go on again, all before the backoff is over.
    setTaskState(id, 'needs_owner', 'Stopped by the owner');
    setTaskState(id, 'coding', 'The owner let it go on');
    await pause(300);
  });
  assert.equal(getTask(id)!.state, 'coding', 'the task is back where the old timer expected it');
  assert.equal(again, 0, 'the old timer did not start the stage again');
});

test('a new start of the stage within the backoff cancels the scheduled retry', async () => {
  const id = taskIn('Stage started again during the backoff', 'coding');
  let again = 0;
  await withBackoff(100, async () => {
    assert.equal(retryWhenBusy(id, BUSY_EXIT, { role: 'coder', round: 2 }, () => { again += 1; }), true);
    cancelPendingRetry(id); // what every agent start for the task does first
    await pause(300);
  });
  assert.equal(again, 0);
});

test('a run that failed because the AI service was busy is tried once more, and the task goes on', { skip }, async () => {
  script({ coder: [good], overloaded: { analyst: 1, coder: 1, tester: 1 } });
  const id = addTask('Add mul while the service is busy');
  assert.equal(await runToRest(id), 'awaiting_approval', note(id));
  const coders = calls().filter((c) => c.role === 'coder');
  assert.deepEqual(coders.map((c) => Boolean(c.overloaded)), [true, false]);
  // The retry continues the failed run's own conversation and says why.
  assert.ok(coders[1]!.argv.includes('--resume'));
  assert.match(coders[1]!.prompt, /AI service was briefly unavailable/);
  assert.deepEqual(calls().filter((c) => c.role === 'tester').map((c) => Boolean(c.overloaded)), [true, false]);
  assert.deepEqual(outcomes(id), ['passed']);
  // The retry is a new run of its own, counted like any other.
  const runs = getDb().prepare(`SELECT role, state FROM runs WHERE task_id = ? AND role IN ('coder', 'tester') ORDER BY started_at`).all(id) as Array<{ role: string; state: string }>;
  assert.deepEqual(runs.map((r) => `${r.role}:${r.state}`), ['coder:failed', 'coder:completed', 'tester:failed', 'tester:completed']);
  assert.deepEqual(calls().filter((c) => c.role === 'analyst').map((c) => Boolean(c.overloaded)), [true, false]);
  assert.deepEqual(JSON.parse(getTask(id)!.metadata_json!).retried, ['analyst.brief:0', 'coder:1', 'tester:1']);
});

test('a second busy failure of the same stage goes to the owner', { skip }, async () => {
  script({ coder: [good], overloaded: { planner: 2 } });
  const id = addTask('Plan while the service stays busy');
  assert.equal(await runToRest(id), 'needs_owner');
  assert.match(note(id), /^The planner failed: API Error: 529/);
  assert.equal(calls().filter((c) => c.role === 'planner').length, 2);
  assert.equal(calls().some((c) => c.role === 'coder'), false);
});

/**
 * A stand-in Cursor CLI in its own install folder, the only folder of it the sandbox lets it
 * read: a copy of the fake and a launcher that points it at this suite's plan.
 */
function installFakeCursor(): void {
  const dir = path.join(tmp, 'cursor-install');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-cursor-agent.mjs'), path.join(dir, 'fake-cursor-agent.mjs'));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ planner: PLAN }));
  const launcher = path.join(dir, 'cursor-agent');
  fs.writeFileSync(launcher, `#!/bin/sh\nexport FAKE_PLAN_FILE='${path.join(dir, 'plan.json')}'\nexec node '${path.join(dir, 'fake-cursor-agent.mjs')}' "$@"\n`, { mode: 0o755 });
  process.env.CURSOR_AGENT_BIN = launcher;
}
const cursorSaw = (taskId: string, role: string) => {
  const run = getDb().prepare('SELECT log_path FROM runs WHERE task_id = ? AND role = ? ORDER BY started_at DESC LIMIT 1').get(taskId, role) as { log_path: string };
  const line = fs.readFileSync(run.log_path, 'utf8').split('\n').find((l) => l.includes('"fake_saw"'))!;
  return JSON.parse(line) as { cwd: string; prompt: string; home: string };
};

test('with the Analyst and the Planner on Cursor, they read throwaway copies and their answers drive the task', { skip }, async () => {
  installFakeCursor();
  saveCursorKey('test-cursor-key-not-a-real-credential');
  updateSettings({ roles: { analyst: { engine: 'cursor' }, planner: { engine: 'cursor' } } });
  try {
    script({ coder: [good] });
    const id = addTask('Add mul, planned on Cursor');
    assert.equal(await runToRest(id), 'awaiting_approval', note(id));
    const engines = getDb().prepare('SELECT role, engine FROM runs WHERE task_id = ? ORDER BY started_at').all(id) as Array<{ role: string; engine: string }>;
    assert.deepEqual(engines.map((r) => `${r.role}:${r.engine}`), ['analyst:cursor', 'planner:cursor', 'coder:claude', 'tester:claude']);
    assert.equal(JSON.parse(getTask(id)!.brief_json!).summary, 'A clear task, read by Cursor.');
    assert.deepEqual(parsePlan(getTask(id)!.plan_json), PLAN, 'the plan came from Cursor\'s last message');
    assert.deepEqual(calls().map((c) => c.role), ['coder', 'tester']);

    const [ws] = getWorkspaces(id);
    const analyst = cursorSaw(id, 'analyst');
    const planner = cursorSaw(id, 'planner');
    assert.match(analyst.cwd, /\.analysis$/);
    assert.equal(planner.cwd, `${ws!.worktree_path}.plan`, 'the planner read its own copy, not the coder\'s workspace');
    assert.equal(fs.existsSync(planner.cwd), false, 'and that copy is gone');
    assert.match(planner.prompt, /# How you work[\s\S]*Use CommonJS exports\./, 'repo guidance reached it');
    assert.match(planner.prompt, /## What is being asked \(from the Analyst\)\n\nA clear task, read by Cursor\./);
  } finally {
    updateSettings({ roles: { analyst: { engine: 'claude' }, planner: { engine: 'claude' } } });
  }
});

test('a Planner set to Cursor without a key hands the task over with the reason and leaves no copy behind', { skip }, async () => {
  installFakeCursor();
  removeCursorKey();
  updateSettings({ roles: { planner: { engine: 'cursor' } } });
  try {
    script({ coder: [good] });
    const id = addTask('Plan on Cursor without a key');
    assert.equal(await runToRest(id), 'needs_owner');
    assert.match(note(id), /Cursor CLI \(reduced isolation\) cannot run: no Cursor API key is set/);
    const [ws] = getWorkspaces(id);
    assert.equal(fs.existsSync(`${ws!.worktree_path}.plan`), false);
    assert.equal(calls().some((c) => c.role === 'coder'), false);
  } finally {
    updateSettings({ roles: { planner: { engine: 'claude' } } });
  }
});

test('a start the owner can fix is refused with a reason and changes nothing', { skip }, () => {
  const id = addTask('Never started');
  assert.throws(() => startTask(id, 'unverified'), (e: unknown) => e instanceof StartError && /not confirmed yet/.test(e.message));
  assert.throws(() => startTask(id, 'no-such-repo'), StartError);
  assert.throws(() => startTask('T-404', REPO), StartError);
  const noRemote = path.join(tmp, 'no-remote');
  execFileSync('git', ['init', '-q', noRemote]);
  saveProject({ id: 'no-remote', name: 'No remote', localPath: noRemote, prodBranch: 'main', verified: true });
  assert.throws(() => startTask(id, 'no-remote'), /no "origin" remote/);
  assert.equal(getTask(id)!.state, 'queued');
  assert.deepEqual(getWorkspaces(id), []);
  assert.throws(() => startTask('T-1', REPO), /only a queued task/);
});

test("through all of it the owner's copy and the remote were never touched", { skip }, () => {
  assert.deepEqual(ownerState(), ownerBefore);
  assert.equal(sh(origin, 'for-each-ref', '--format=%(refname)'), 'refs/heads/release');
  // Only task worktrees remain; every review and base checkout was removed.
  const worktrees = sh(main, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
  assert.equal(worktrees.filter((w) => /\.(review|base)$/.test(w)).length, 0);
  assert.deepEqual(fs.readdirSync(process.env.FRYDAY_SCRATCH!), [], 'no sandbox temp folders left');

  // Discarding removes a task's worktree and branch.
  const [ws] = getWorkspaces('T-1');
  assert.equal(discardWorkspaces('T-1'), 1);
  assert.equal(fs.existsSync(ws!.worktree_path), false);
  assert.equal(sh(main, 'branch', '--list', ws!.branch), '');
  assert.deepEqual(ownerState(), ownerBefore);
});

test('repo guidance is read from the given roots, once per file, and capped', () => {
  const a = path.join(tmp, 'ga'); const b = path.join(tmp, 'gb');
  fs.mkdirSync(path.join(a, '.claude', 'rules'), { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, '.claude', 'rules', 'style.md'), 'tabs');
  fs.writeFileSync(path.join(b, 'CLAUDE.md'), 'from b');
  fs.writeFileSync(path.join(a, 'CLAUDE.md'), 'from a');
  const text = readGuidance([a, b]);
  assert.match(text, /## CLAUDE\.md\n\nfrom a/);
  assert.match(text, /## \.claude\/rules\/style\.md\n\ntabs/);
  assert.doesNotMatch(text, /from b/, 'the first root wins for the same file');
  assert.equal(readGuidance([path.join(tmp, 'missing')]), '');
  assert.match(readGuidance([a], 10), /\[repo guidance cut at 10 characters\]$/);
});
