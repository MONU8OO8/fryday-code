// A task's flow, from stored facts: who has the task, who had it, hand-offs and send-backs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow, type FlowInput, type FlowRun } from '../src/pipeline/flow';
import type { Round } from '../src/pipeline/rounds';
import type { Verification } from '../src/verify/report';

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20, costUsd: 0.1 };
let t = 1000;
const run = (role: string, round = 0, state = 'completed'): FlowRun => ({ id: `run-${role}-${round}-${t}`, role, round, state, started_at: (t += 10), ended_at: state === 'running' ? null : t + 5, tools_json: null });
const check = (status: 'passed' | 'failed') => ({ name: 'test' as const, cmd: 'npm test', status, exitCode: status === 'passed' ? 0 : 1, durationMs: 1 });
const verdict = (pass: boolean) => ({ verdict: pass ? 'pass' as const : 'fail' as const, summary: '', criteria: [{ criterion: 'c', met: pass, evidence: '' }], issues: pass ? [] : [{ severity: 'blocking' as const, file: 'a', description: 'x' }] });
const verify = (passed: boolean, calls = 4): Verification => ({
  status: passed ? 'passed' : 'failed', service: null, testers: [{ kind: 'api', runId: 'r', report: null, calls, passed }], dataConnections: [], unavailable: [], refused: [], evidence: [],
});
function round(n: number, opts: { checks?: 'passed' | 'failed'; verdict?: boolean; verify?: Verification; outcome?: Round['outcome'] } = {}): Round & { createdAt: number } {
  return {
    taskId: 'T-1', round: n, headSha: 'abc', checks: [check(opts.checks ?? 'passed')], flags: [],
    verdict: opts.verdict === undefined ? null : verdict(opts.verdict), verify: opts.verify ?? null, outcome: opts.outcome ?? null, feedback: null,
    createdAt: (t += 10),
  };
}
const input = (change: Partial<FlowInput>): FlowInput => ({
  taskState: 'coding', taskUpdatedAt: 0, runs: [], rounds: [], questions: [], approvals: [], release: null, deploy: null, hasDeployer: false,
  testers: { api: true, ui: false }, hasStaging: true, usageOf: () => usage, budget: { limitTokens: 4_000_000, usedTokens: 1000 }, ...change,
});
const state = (flow: ReturnType<typeof buildFlow>) => Object.fromEntries(flow.nodes.map((n) => [n.id, n.state]));
const moves = (flow: ReturnType<typeof buildFlow>) => flow.edges.map((e) => `${e.from}>${e.to}${e.kind === 'sendback' ? ' (back)' : ''}`);

test('a new task: the Analyst is working, nothing else has been reached', () => {
  const flow = buildFlow(input({ taskState: 'intake', runs: [run('analyst', 0, 'running')] }));
  assert.equal(flow.current?.node, 'analyst');
  assert.equal(state(flow)['analyst'], 'active');
  assert.equal(state(flow)['planner'], 'idle');
  assert.equal(state(flow)['ui_tester'], 'skipped', 'the run profile has no UI tester');
  assert.equal(flow.nodes.find((n) => n.id === 'analyst')!.liveRunId?.startsWith('run-analyst'), true);
  assert.deepEqual(flow.edges, []);
});

test('a question puts the task with the owner, and the answer hands it back', () => {
  const t0 = t;
  const asking = buildFlow(input({ taskState: 'waiting_owner', runs: [run('analyst')], questions: [{ askedAt: t0 + 20, answeredAt: null }] }));
  assert.equal(asking.current?.node, 'owner');
  assert.equal(state(asking)['owner'], 'waiting');
  assert.equal(asking.nodes.find((n) => n.id === 'owner')!.detail, '1 question');
  assert.deepEqual(moves(asking), ['analyst>owner']);
});

test('a round sent back by a tester is a send-back to the coder, and the next round goes forward again', () => {
  const runs = [run('analyst'), run('planner'), run('coder', 1)];
  const r1 = round(1, { verdict: true, verify: verify(false), outcome: 'changes_requested' });
  runs.push(run('tester', 1), run('api_tester', 1), run('coder', 2, 'running'));
  // The tester runs started before the round was stored (checks first): order them by time as stored.
  r1.createdAt = runs[3]!.started_at - 1;
  const flow = buildFlow(input({ taskState: 'coding', runs, rounds: [r1] }));
  assert.deepEqual(moves(flow), ['analyst>planner', 'planner>coder', 'coder>checks', 'checks>reviewer', 'reviewer>api_tester', 'api_tester>coder (back)']);
  assert.equal(flow.current?.node, 'coder');
  assert.equal(flow.edges.at(-1)!.round, 1, 'the send-back is about round 1, the round that failed');
  assert.equal(state(flow)['api_tester'], 'failed', 'it sent the round back');
  assert.equal(state(flow)['reviewer'], 'done');
  assert.equal(flow.nodes.find((n) => n.id === 'coder')!.detail, 'round 2');
  assert.equal(flow.nodes.find((n) => n.id === 'api_tester')!.detail, '4 requests');
});

test('failing checks send the round back without asking the reviewer', () => {
  const runs = [run('planner'), run('coder', 1)];
  const r1 = round(1, { checks: 'failed', outcome: 'changes_requested' });
  runs.push(run('coder', 2, 'running'));
  const flow = buildFlow(input({ taskState: 'coding', runs, rounds: [r1] }));
  assert.deepEqual(moves(flow), ['planner>coder', 'coder>checks', 'checks>coder (back)']);
  assert.equal(state(flow)['checks'], 'failed');
  assert.equal(flow.nodes.find((n) => n.id === 'checks')!.detail, '1 blocking');
  assert.equal(state(flow)['reviewer'], 'idle');
});

test('while core runs the checks the task is at Checks, and the move there is the latest edge', () => {
  const flow = buildFlow(input({ taskState: 'testing', runs: [run('planner'), run('coder', 1)] }));
  assert.equal(flow.current?.node, 'checks');
  assert.equal(state(flow)['checks'], 'active');
  assert.deepEqual(moves(flow).at(-1), 'coder>checks');
  // That move's time is stored, not the clock: two looks give the same answer.
  const again = buildFlow(input({ taskState: 'testing', taskUpdatedAt: 5_000_000, runs: [run('planner'), run('coder', 1)] }));
  assert.equal(again.edges.at(-1)!.at, 5_000_000);
  assert.equal(again.current!.since, 5_000_000);
});

test('everything passed: the owner is asked, then the release runs and lands on staging', () => {
  const runs = [run('analyst'), run('planner'), run('coder', 1), run('tester', 1), run('api_tester', 1)];
  const r1 = round(1, { verdict: true, verify: verify(true), outcome: 'passed' });
  r1.createdAt = runs[3]!.started_at - 1;
  const asked = t + 10;
  const waiting = buildFlow(input({ taskState: 'awaiting_approval', runs, rounds: [r1], approvals: [{ action: 'release_stg', state: 'pending', requestedAt: asked, resolvedAt: null }] }));
  assert.equal(waiting.current?.node, 'owner');
  assert.equal(waiting.nodes.find((n) => n.id === 'owner')!.detail, 'approve release');
  assert.deepEqual(moves(waiting).at(-1), 'api_tester>owner');
  assert.ok(['reviewer', 'api_tester', 'checks', 'coder', 'planner', 'analyst'].every((n) => state(waiting)[n] === 'done'));

  const done = buildFlow(input({
    taskState: 'deployed', runs, rounds: [r1],
    approvals: [{ action: 'release_stg', state: 'executed', requestedAt: asked, resolvedAt: asked + 5 }], release: { state: 'pushed', startedAt: asked + 6 },
  }));
  assert.equal(done.current, null, 'a finished task is nowhere');
  assert.equal(state(done)['deploy'], 'skipped', 'no deployer');

  const deploying = buildFlow(input({
    taskState: 'deploying', runs, rounds: [r1], hasDeployer: true,
    approvals: [{ action: 'release_stg', state: 'executed', requestedAt: asked, resolvedAt: asked + 5 }, { action: 'deploy_stg', state: 'executed', requestedAt: asked + 7, resolvedAt: asked + 8 }],
    release: { state: 'pushed', startedAt: asked + 6 }, deploy: { state: 'running', outcome: null, startedAt: asked + 9, build: 42 },
  }));
  assert.equal(deploying.current?.node, 'deploy');
  assert.equal(state(deploying)['deploy'], 'active');
  assert.deepEqual(moves(deploying).slice(-3), ['owner>release', 'release>owner', 'owner>deploy']);
  const shipped = buildFlow(input({ taskState: 'deployed', runs, rounds: [r1], hasDeployer: true, release: { state: 'pushed', startedAt: asked + 6 }, deploy: { state: 'succeeded', outcome: 'deployed', startedAt: asked + 9, build: 42 } }));
  assert.equal(state(shipped)['deploy'], 'done');
  assert.equal(shipped.nodes.find((n) => n.id === 'deploy')!.detail, 'deployed');
  assert.equal(state(done)['release'], 'done');
  assert.equal(done.nodes.find((n) => n.id === 'release')!.detail, 'on staging');
  assert.equal(state(done)['owner'], 'done');
});

test('no staging branch and no run profile: release and testers are skipped, not pending', () => {
  const flow = buildFlow(input({ taskState: 'awaiting_approval', runs: [run('coder', 1), run('tester', 1)], rounds: [round(1, { verdict: true, outcome: 'passed' })], testers: { api: false, ui: false }, hasStaging: false }));
  assert.equal(state(flow)['api_tester'], 'skipped');
  assert.equal(state(flow)['ui_tester'], 'skipped');
  assert.equal(state(flow)['release'], 'skipped');
  assert.equal(flow.nodes.find((n) => n.id === 'release')!.detail, 'no staging branch');
});

test('an agent stopped at its token limit is shown as such, and the task waits for the owner', () => {
  const runs = [run('planner'), run('coder', 1, 'budget')];
  const flow = buildFlow(input({ taskState: 'needs_owner', runs, approvals: [{ action: 'continue_budget', state: 'pending', requestedAt: t + 1, resolvedAt: null }] }));
  assert.equal(state(flow)['coder'], 'failed');
  assert.equal(flow.nodes.find((n) => n.id === 'coder')!.detail, 'token limit');
  assert.equal(flow.current?.node, 'owner');
  assert.equal(flow.nodes.find((n) => n.id === 'owner')!.detail, 'more tokens?');
});

test("each node's tokens are the sum of its runs, and the task's budget is passed through", () => {
  const runs = [run('coder', 1), run('coder', 2), run('planner')];
  const flow = buildFlow(input({ runs, usageOf: (id) => ({ ...usage, costUsd: id.includes('coder') ? 0.5 : 0.25 }), budget: { limitTokens: 4_000_000, usedTokens: 1250 } }));
  const coder = flow.nodes.find((n) => n.id === 'coder')!;
  assert.equal(coder.runs, 2);
  assert.equal(coder.usage.costUsd, 1);
  assert.equal(coder.usage.outputTokens, 10);
  assert.equal(flow.nodes.find((n) => n.id === 'checks')!.usage.costUsd, 0, 'core spends nothing');
  assert.deepEqual(flow.budget, { limitTokens: 4_000_000, usedTokens: 1250 });
});

test('an Analyst that ran twice in a row is one turn, not a hand-off to itself', () => {
  const flow = buildFlow(input({ taskState: 'planning', runs: [run('analyst'), run('analyst'), run('planner', 0, 'running')] }));
  assert.deepEqual(moves(flow), ['analyst>planner']);
  assert.equal(flow.nodes.find((n) => n.id === 'analyst')!.detail, '2 passes');
});
