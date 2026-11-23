/**
 * What the board shows about a task besides its journey: priority and order, what it waits
 * for, its sub-tasks, and which agent is at work on it right now. Read from stored facts only.
 */

import { getDb } from '../db/db.js';
import { actorOfRole, ACTOR_NAME } from './plainWords.js';
import { getTask, type Priority, type TaskRow } from './taskState.js';
import { stateLabel, type TaskState } from './stateMachine.js';
import { childrenOf, dependenciesOf, gateMet, unmetDependencies, type Gate } from './taskLinks.js';

export interface BoardFacts {
  priority: Priority;
  kind: 'task' | 'initiative';
  parent: { id: string; title: string } | null;
  autoStart: boolean;
  position: number;
  dependsOn: Array<{ id: string; title: string; gate: Gate; met: boolean }>;
  /** What holds it back right now, in plain words. Null: nothing. */
  waiting: string | null;
  /** For an initiative: its sub-tasks, in order. */
  children: string[];
  /** For an initiative: the same sub-tasks with what the page shows of each. */
  parts: Array<{ id: string; title: string; state: string; label: string }>;
  /** The agent working on it now, if any. */
  agent: { runId: string; who: string; since: number } | null;
}

export function boardFacts(task: TaskRow): BoardFacts {
  const parent = task.parent_id ? getTask(task.parent_id) : undefined;
  const kids = task.kind === 'initiative' ? childrenOf(task.id) : [];
  const dependsOn = dependenciesOf(task.id).flatMap((d) => {
    const dep = getTask(d.dependsOn);
    return dep ? [{ id: dep.id, title: dep.title, gate: d.gate, met: gateMet(dep, d.gate) }] : [];
  });
  const gate = task.state === 'queued' ? 'start' : task.state === 'awaiting_approval' ? 'release' : null;
  const blockers = gate ? unmetDependencies(task.id, gate) : [];
  const run = getDb()
    .prepare(`SELECT id, role, started_at FROM runs WHERE task_id = ? AND state = 'running' AND role != 'reflector' ORDER BY started_at DESC LIMIT 1`)
    .get(task.id) as { id: string; role: string; started_at: number } | undefined;
  return {
    priority: task.priority,
    kind: task.kind,
    parent: parent ? { id: parent.id, title: parent.title } : null,
    autoStart: task.auto_start === 1,
    position: task.position,
    dependsOn,
    waiting: blockers.length ? blockers.map((b) => b.why).join('; ') : null,
    children: kids.map((c) => c.id),
    parts: kids.map((c) => ({ id: c.id, title: c.title, state: c.state, label: stateLabel(c.state as TaskState) })),
    agent: run ? { runId: run.id, who: ACTOR_NAME[actorOfRole(run.role)], since: run.started_at } : null,
  };
}
