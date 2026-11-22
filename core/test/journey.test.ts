// The six stops of the journey line, grouped from the flow model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyOf, groupOf, overviewLine } from '../src/pipeline/journey';
import { FLOW_ORDER, type TaskFlow, type FlowNodeId, type FlowNodeState, type FlowEdge } from '../src/pipeline/flow';

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
function flow(states: Partial<Record<FlowNodeId, FlowNodeState>>, current: FlowNodeId | null, edges: FlowEdge[] = []): TaskFlow {
  return {
    nodes: FLOW_ORDER.map((id) => ({ id, label: id, kind: 'agent' as const, state: states[id] ?? 'idle', detail: '', runs: 0, liveRunId: null, usage: zero })),
    edges,
    current: current ? { node: current, since: 0 } : null,
    budget: { limitTokens: 4_000_000, usedTokens: 1000 },
  };
}
const states = (j: ReturnType<typeof journeyOf>) => j.stops.map((s) => `${s.id}:${s.state}`).join(' ');
const back = (round: number): FlowEdge => ({ from: 'checks', to: 'coder', kind: 'sendback', at: round, round });

test('a new task is at Understand', () => {
  const j = journeyOf(flow({ analyst: 'active', ui_tester: 'skipped' }, 'analyst'), 'intake');
  assert.equal(j.current, 'understand');
  assert.equal(states(j), 'understand:active plan:idle build:idle check:idle approve:idle live:idle');
  assert.equal(j.finished, null);
});

test('a send-back leaves Check marked and counts the loop', () => {
  const j = journeyOf(flow({ analyst: 'done', planner: 'done', coder: 'active', checks: 'failed', reviewer: 'idle', api_tester: 'skipped', ui_tester: 'skipped' }, 'coder', [back(1), back(2)]), 'coding');
  assert.equal(j.current, 'build');
  assert.equal(states(j), 'understand:done plan:done build:active check:failed approve:idle live:idle');
  assert.equal(j.sendbacks, 2);
});

test("the Understander's question waits at Understand, not at Your OK", () => {
  // What flow.ts gives while intake waits for the owner's answer: the owner node is current and waiting.
  const j = journeyOf(flow({ analyst: 'done', owner: 'waiting', ui_tester: 'skipped' }, 'owner'), 'waiting_owner');
  assert.equal(j.current, 'understand');
  assert.equal(states(j), 'understand:waiting plan:idle build:idle check:idle approve:idle live:idle');
  assert.equal(j.finished, null);
  assert.equal(overviewLine('waiting_owner', j), 'Has a question for you');
  // Once answered, intake goes on at Understand as before.
  const after = journeyOf(flow({ analyst: 'active', owner: 'done', ui_tester: 'skipped' }, 'analyst'), 'intake');
  assert.equal(after.current, 'understand');
  assert.equal(states(after), 'understand:active plan:idle build:idle check:idle approve:idle live:idle');
});

test('waiting for the owner is Your OK, and a finished task is live', () => {
  const waiting = journeyOf(flow({ analyst: 'done', planner: 'done', coder: 'done', checks: 'done', reviewer: 'done', owner: 'waiting' }, 'owner'), 'awaiting_approval');
  assert.equal(waiting.current, 'approve');
  assert.equal(waiting.stops[4]!.state, 'waiting');
  const live = journeyOf(flow({ analyst: 'done', planner: 'done', coder: 'done', checks: 'done', reviewer: 'done', owner: 'done', release: 'done', deploy: 'skipped' }, null), 'deployed');
  assert.equal(live.finished, 'live');
  assert.equal(live.stops[5]!.state, 'done');
  assert.equal(journeyOf(flow({}, null), 'failed').finished, 'stopped');
});

test('a stop whose every part is skipped is skipped', () => {
  const j = journeyOf(flow({ release: 'skipped', deploy: 'skipped' }, null), 'coding');
  assert.equal(j.stops[5]!.state, 'skipped');
});

test('tasks are grouped and described in one plain line', () => {
  assert.equal(groupOf('waiting_owner'), 'needs_you');
  assert.equal(groupOf('awaiting_approval'), 'needs_you');
  assert.equal(groupOf('needs_owner'), 'needs_you');
  assert.equal(groupOf('coding'), 'working');
  assert.equal(groupOf('queued'), 'working');
  assert.equal(groupOf('deployed'), 'done');
  assert.equal(groupOf('failed'), 'done');
  const building = journeyOf(flow({ coder: 'active' }, 'coder'), 'coding');
  assert.equal(overviewLine('coding', building), 'The Builder is making the change');
  assert.equal(overviewLine('awaiting_approval', building), 'Ready: needs your OK');
  assert.equal(overviewLine('waiting_owner', building), 'Has a question for you');
  assert.equal(overviewLine('deployed', building), 'Done: on staging');
});

test('Your OK is not done just because a question was answered', () => {
  // The flow marks the owner node done after any question; the approval for the change is still ahead.
  const building = journeyOf(flow({ analyst: 'done', owner: 'done', planner: 'done', coder: 'active' }, 'coder'), 'coding');
  assert.equal(building.stops[4]!.state, 'idle');
  const checking = journeyOf(flow({ analyst: 'done', owner: 'done', planner: 'done', coder: 'done', checks: 'active' }, 'checks'), 'testing');
  assert.equal(checking.stops[4]!.state, 'idle');
  const stopped = journeyOf(flow({ analyst: 'done', owner: 'done', coder: 'failed' }, null), 'failed');
  assert.equal(stopped.stops[4]!.state, 'idle');
  // Past Your OK, it stays done.
  const releasing = journeyOf(flow({ analyst: 'done', planner: 'done', coder: 'done', checks: 'done', owner: 'done', release: 'active' }, 'release'), 'releasing');
  assert.equal(releasing.stops[4]!.state, 'done');
  const failedRelease = journeyOf(flow({ coder: 'done', checks: 'done', owner: 'waiting', release: 'failed' }, 'owner'), 'needs_owner');
  assert.equal(failedRelease.stops[4]!.state, 'waiting', 'the owner is asked again');
  const live = journeyOf(flow({ coder: 'done', checks: 'done', owner: 'done', release: 'done', deploy: 'skipped' }, null), 'deployed');
  assert.equal(live.stops[4]!.state, 'done');
});

test('the successful endings that leave the task with the owner read as finished', () => {
  const after = { analyst: 'done', planner: 'done', coder: 'done', checks: 'done', reviewer: 'done', owner: 'waiting', release: 'done', deploy: 'skipped' } as const;
  const staging = journeyOf(flow(after, 'owner'), 'needs_owner', 'on_staging_no_deploy');
  assert.equal(states(staging), 'understand:done plan:done build:done check:done approve:done live:done');
  assert.equal(staging.current, null);
  assert.equal(staging.finished, 'on_staging', 'on staging, but nothing was deployed: not drawn as live');
  assert.equal(groupOf('needs_owner', 'on_staging_no_deploy'), 'done');
  assert.equal(overviewLine('needs_owner', staging, 'on_staging_no_deploy'), 'On staging: deploy it yourself');

  const handed = journeyOf(flow({ ...after, release: 'skipped' }, 'owner'), 'needs_owner', 'handed_over');
  assert.equal(states(handed), 'understand:done plan:done build:done check:done approve:done live:skipped');
  assert.equal(handed.current, null);
  assert.equal(handed.finished, 'handed_over');
  assert.equal(groupOf('needs_owner', 'handed_over'), 'done');
  assert.equal(overviewLine('needs_owner', handed, 'handed_over'), 'Handed over for review');

  // After a release on a project with a deployer, Your OK really is waiting for the deploy.
  const deploy = journeyOf(flow({ ...after, deploy: 'idle' }, 'owner'), 'awaiting_approval', null);
  assert.equal(deploy.stops[4]!.state, 'waiting');
  assert.equal(deploy.current, 'approve');
  assert.equal(deploy.finished, null);
  assert.equal(groupOf('awaiting_approval', null), 'needs_you');
  assert.equal(groupOf('needs_owner', null), 'needs_you');
  assert.equal(overviewLine('needs_owner', deploy, null), 'Stopped: needs you');
});
