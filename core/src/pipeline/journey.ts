/**
 * The journey line of the simple UI: six stops, each a group of nodes of the flow model
 * (flow.ts), so the line can never disagree with where core says the task is.
 */

import type { TaskFlow, FlowNode, FlowNodeId, FlowNodeState } from './flow.js';

export type StopId = 'understand' | 'plan' | 'build' | 'check' | 'approve' | 'live';
export type StopState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface Journey {
  stops: Array<{ id: StopId; state: StopState }>;
  current: StopId | null;
  /** How many times the change went back to the Builder. */
  sendbacks: number;
  /**
   * live: deployed to staging by the project's deployer. on_staging: on staging, but the project has no
   * deployer, so nothing was started. handed_over: shared for review, nothing on staging. stopped: the task failed.
   */
  finished: 'live' | 'on_staging' | 'handed_over' | 'stopped' | null;
}

/**
 * How a task that core left with the owner (needs_owner) actually ended, read from stored facts.
 * on_staging_no_deploy  the change is on staging and the project has no deployer
 * handed_over           the work was pushed for review and nothing else is waiting
 * null                  anything else: the task really needs the owner, or is not with them
 */
export type TaskOutcome = 'on_staging_no_deploy' | 'handed_over' | null;

export const STOP_ORDER: StopId[] = ['understand', 'plan', 'build', 'check', 'approve', 'live'];

const STOP_NODES: Record<StopId, FlowNodeId[]> = {
  understand: ['analyst'],
  plan: ['planner'],
  build: ['coder'],
  check: ['checks', 'reviewer', 'api_tester', 'ui_tester'],
  approve: ['owner'],
  live: ['release', 'deploy'],
};

function stopOfNode(node: FlowNodeId): StopId {
  return STOP_ORDER.find((id) => STOP_NODES[id].includes(node))!;
}

function stopState(states: FlowNodeState[], currentState: FlowNodeState | null): StopState {
  if (currentState === 'active' || currentState === 'waiting') return currentState;
  const real = states.filter((s) => s !== 'skipped');
  if (real.length === 0) return 'skipped';
  if (real.includes('failed')) return 'failed';
  if (real.includes('done')) return 'done';
  return 'idle';
}

export function journeyOf(flow: TaskFlow, taskState: string, outcome: TaskOutcome = null): Journey {
  const byId = new Map<FlowNodeId, FlowNode>(flow.nodes.map((n) => [n.id, n]));
  const currentNode = flow.current?.node ?? null;
  const stops = STOP_ORDER.map((id) => {
    const nodes = STOP_NODES[id].map((n) => byId.get(n)).filter((n): n is FlowNode => n !== undefined);
    const here = currentNode !== null && STOP_NODES[id].includes(currentNode) ? byId.get(currentNode)?.state ?? null : null;
    return { id, state: stopState(nodes.map((n) => n.state), here) };
  });
  const stop = (id: StopId) => stops.find((s) => s.id === id)!;
  let current: StopId | null = currentNode ? stopOfNode(currentNode) : null;
  let finished: Journey['finished'] = taskState === 'deployed' ? 'live' : taskState === 'failed' ? 'stopped' : null;

  if (taskState === 'waiting_owner') {
    // The flow puts the owner node on a question during intake, but the task waits at
    // Understand for the owner's answer, not at Your OK.
    stop('understand').state = 'waiting';
    if (stop('approve').state === 'waiting') stop('approve').state = 'idle';
    current = 'understand';
  }

  if (outcome) {
    // A successful ending core leaves with the owner: Your OK was given and nothing waits.
    stop('approve').state = 'done';
    stop('live').state = outcome === 'on_staging_no_deploy' ? 'done' : 'skipped';
    current = null;
    finished = outcome === 'on_staging_no_deploy' ? 'on_staging' : 'handed_over';
  } else if (stop('approve').state === 'done') {
    // The flow marks the owner done after any answered question; Your OK is done only once the task is past it.
    const live = stop('live').state;
    const past = (current !== null && STOP_ORDER.indexOf(current) > STOP_ORDER.indexOf('approve'))
      || live === 'active' || live === 'done' || live === 'failed' || finished === 'live';
    if (!past) stop('approve').state = 'idle';
  }

  return {
    stops,
    current,
    sendbacks: flow.edges.filter((e) => e.kind === 'sendback').length,
    finished,
  };
}

export type TaskGroup = 'needs_you' | 'working' | 'done';

export function groupOf(state: string, outcome: TaskOutcome = null): TaskGroup {
  if (outcome) return 'done';
  if (state === 'waiting_owner' || state === 'awaiting_approval' || state === 'needs_owner') return 'needs_you';
  if (state === 'deployed' || state === 'failed') return 'done';
  return 'working';
}

const WORKING_LINE: Record<StopId, string> = {
  understand: 'The Understander is reading the task',
  plan: 'The Planner is working out the change',
  build: 'The Builder is making the change',
  check: 'The change is being checked',
  approve: 'Waiting for you',
  live: 'Being released to staging',
};

export function overviewLine(state: string, journey: Journey, outcome: TaskOutcome = null): string {
  if (outcome === 'on_staging_no_deploy') return 'On staging: deploy it yourself';
  if (outcome === 'handed_over') return 'Handed over for review';
  switch (state) {
    case 'queued': return 'Waiting to start';
    case 'waiting_owner': return 'Has a question for you';
    case 'awaiting_approval': return 'Ready: needs your OK';
    case 'needs_owner': return 'Stopped: needs you';
    case 'deployed': return 'Done: on staging';
    case 'failed': return 'Stopped';
    default: return journey.current ? WORKING_LINE[journey.current] : 'Working on it';
  }
}
