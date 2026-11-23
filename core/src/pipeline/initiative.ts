/**
 * Initiatives: one piece of work that needs changes in several projects.
 *
 * An initiative is a task (kind 'initiative') with sub-tasks (parent_id), one per project.
 * The sub-tasks are ordinary tasks: each has its own workspace, rounds and approvals, and
 * the scheduler starts them as their dependencies allow. The initiative runs no agents;
 * its state follows from theirs:
 *
 *   tracking      while any sub-task is still going
 *   deployed      when every sub-task is on staging
 *   needs_owner   when every sub-task has ended and at least one was stopped
 *
 * An initiative comes from the Analyst's split (confirmed by the owner) or from the owner
 * naming several projects when creating the task.
 */

import { getDb, nowMs } from '../db/db.js';
import { sseEmit } from '../api/events.js';
import { canTransition } from './stateMachine.js';
import { createTask, getTask, onTaskStateChange, setTaskState, type Priority, type TaskRow } from './taskState.js';
import { addDependency, childrenOf } from './taskLinks.js';
import { addMessage } from './thread.js';
import type { SplitSubtask } from './brief.js';

const MAX_PARTS = 6;

/**
 * Keep the usable parts of a proposed split: known projects, a title, dependencies only on
 * earlier parts (so there can be no cycle). Null unless at least two projects remain.
 */
export function validSplit(subtasks: SplitSubtask[], projectIds: readonly string[]): SplitSubtask[] | null {
  const known = new Set(projectIds);
  const kept: Array<SplitSubtask & { from: number }> = [];
  subtasks.slice(0, MAX_PARTS).forEach((s, from) => {
    if (!known.has(s.projectId) || !s.title.trim()) return;
    kept.push({ ...s, title: s.title.trim().slice(0, 200), description: s.description.trim(), from });
  });
  if (new Set(kept.map((k) => k.projectId)).size < 2) return null;
  // Renumber dependencies after dropping parts; keep only those pointing to an earlier kept part.
  const position = new Map(kept.map((k, i) => [k.from, i]));
  return kept.map(({ from: _from, ...k }, i) => ({
    ...k,
    dependsOn: [...new Set(k.dependsOn.map((d) => position.get(d)).filter((d): d is number => d !== undefined && d < i))],
  }));
}

export interface SplitOptions {
  priority?: Priority;
  /** Start the sub-tasks as soon as they may (the default), or leave them for the owner to start. */
  autoStart?: boolean;
}

/** Make `parentId` an initiative with these parts as its sub-tasks. Returns the sub-tasks in order. */
export function splitIntoSubtasks(parentId: string, parts: SplitSubtask[], opts: SplitOptions = {}): TaskRow[] {
  const parent = getTask(parentId);
  if (!parent) throw new Error(`Unknown task ${parentId}`);
  if (parts.length < 2) throw new Error('An initiative needs at least two parts');
  const autoStart = opts.autoStart ?? true;
  const db = getDb();
  const children = db.transaction(() => {
    db.prepare(`UPDATE tasks SET kind = 'initiative', auto_start = 0, updated_at = ? WHERE id = ?`).run(nowMs(), parentId);
    const made = parts.map((p) => createTask(p.title, `${p.description}\n\n(Part of ${parentId}: ${parent.title})`, {
      priority: opts.priority ?? parent.priority,
      parentId,
      autoStart,
      metadata: { plannedProject: p.projectId },
    }));
    parts.forEach((p, i) => {
      for (const d of p.dependsOn) addDependency(made[i]!.id, made[d]!.id, p.gate);
    });
    return made;
  })();
  addMessage(parentId, 'fryday', 'event', `Split into ${children.length} tasks: ${children.map((c) => `${c.id} ${c.title}`).join('; ')}`);
  if (canTransition(getTask(parentId)!.state, 'tracking')) {
    setTaskState(parentId, 'tracking', autoStart
      ? `${children.length} sub-tasks; FryDay starts each one as soon as it can`
      : `${children.length} sub-tasks, waiting on the board for you to start them`);
  }
  sseEmit({ type: 'task_created', taskId: parentId });
  return children;
}

/** What the initiative's state should be, from its sub-tasks. Null: leave it as it is. */
export function initiativeStateFor(children: Array<Pick<TaskRow, 'state'>>): { state: 'tracking' | 'deployed' | 'needs_owner'; note: string } | null {
  if (!children.length) return null;
  const deployed = children.filter((c) => c.state === 'deployed').length;
  const failed = children.filter((c) => c.state === 'failed').length;
  if (deployed === children.length) return { state: 'deployed', note: `All ${children.length} sub-tasks are on staging` };
  if (deployed + failed === children.length) return { state: 'needs_owner', note: `${failed} of ${children.length} sub-tasks were stopped; restart them or stop the initiative` };
  return { state: 'tracking', note: `${deployed} of ${children.length} sub-tasks on staging` };
}

function rollUp(child: TaskRow): void {
  if (!child.parent_id) return;
  const parent = getTask(child.parent_id);
  if (!parent || parent.kind !== 'initiative' || parent.state === 'failed') return;
  const next = initiativeStateFor(childrenOf(parent.id));
  if (!next || next.state === parent.state) {
    sseEmit({ type: 'task_updated', taskId: parent.id });
    return;
  }
  if (canTransition(parent.state, next.state)) setTaskState(parent.id, next.state, next.note);
}

/** Call once at startup. */
export function registerInitiatives(): void {
  onTaskStateChange((task) => rollUp(task));
}
