/**
 * Task pipeline state machine.
 *
 * States:
 *   queued → intake ⇄ waiting_owner → workspace → planning → coding ⇄ testing → verifying
 *          → awaiting_approval → releasing → (awaiting_approval → deploying) → deployed
 *          → failed | needs_owner
 *
 * Transitions are validated here and persisted in SQLite by the caller.
 */

export type TaskState =
  | 'queued'
  | 'intake'
  | 'waiting_owner'
  | 'planning'
  | 'workspace'
  | 'coding'
  | 'testing'
  | 'verifying'
  | 'awaiting_approval'
  | 'releasing'
  | 'deploying'
  | 'deployed'
  | 'failed'
  | 'needs_owner';

/** Terminal states — no further transitions. */
export const TERMINAL_STATES = new Set<TaskState>(['deployed', 'failed', 'needs_owner']);

/** Valid transitions per state. */
const TRANSITIONS: Record<TaskState, TaskState[]> = {
  queued:            ['intake', 'planning', 'workspace', 'failed'],
  intake:            ['waiting_owner', 'workspace', 'needs_owner', 'failed'],
  waiting_owner:     ['intake', 'workspace', 'needs_owner', 'failed'], // the owner answered: go on from where it stopped
  planning:          ['workspace', 'coding', 'needs_owner', 'failed'],
  workspace:         ['planning', 'coding', 'needs_owner', 'failed'],
  coding:            ['testing', 'needs_owner', 'failed'],
  testing:           ['coding', 'verifying', 'awaiting_approval', 'needs_owner', 'failed'],
  verifying:         ['coding', 'awaiting_approval', 'needs_owner', 'failed'], // coding: a tester found a problem in the running service
  awaiting_approval: ['releasing', 'deploying', 'coding', 'needs_owner', 'failed'], // needs_owner: the owner declined the release
  releasing:         ['deployed', 'awaiting_approval', 'deploying', 'needs_owner', 'failed'], // awaiting_approval: one push done, the next needs its own yes; deploying: the yes covered the deploy too
  deploying:         ['deployed', 'awaiting_approval', 'needs_owner', 'failed'], // awaiting_approval: the pipeline asks a question only the owner may answer
  deployed:          [],
  failed:            [],
  needs_owner:       ['intake', 'planning', 'coding', 'testing', 'verifying', 'awaiting_approval', 'releasing', 'deploying', 'failed'], // the owner can let it go on; awaiting_approval: accepted as it is
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task state transition: ${from} → ${to}`);
  }
}

/** Human-readable label for a state. */
export function stateLabel(state: TaskState): string {
  const labels: Record<TaskState, string> = {
    queued:            'Queued',
    intake:            'Understanding the task',
    waiting_owner:     'Waiting for your answer',
    planning:          'Planning',
    workspace:         'Setting up workspace',
    coding:            'Coding',
    testing:           'Testing',
    verifying:         'Trying it out running',
    awaiting_approval: 'Awaiting your approval',
    releasing:         'Releasing to staging',
    deploying:         'Deploying to staging',
    deployed:          'Deployed to staging',
    failed:            'Failed',
    needs_owner:       'Needs your input',
  };
  return labels[state] ?? state;
}

/** CSS color class hint for UI. */
export function stateColor(state: TaskState): 'cyan' | 'amber' | 'green' | 'red' | 'gray' {
  switch (state) {
    case 'deployed':          return 'green';
    case 'failed':
    case 'needs_owner':       return 'red';
    case 'waiting_owner':
    case 'awaiting_approval': return 'amber';
    case 'queued':            return 'gray';
    default:                  return 'cyan';
  }
}

/** States that mean an agent is actively running. */
export const ACTIVE_STATES = new Set<TaskState>(['intake', 'planning', 'workspace', 'coding', 'testing', 'verifying', 'releasing', 'deploying']);
