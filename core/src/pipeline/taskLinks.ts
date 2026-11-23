/**
 * How tasks relate: an initiative and its sub-tasks (tasks.parent_id), and one task
 * waiting for another (task_dependencies). Storage and the gate rules only; the scheduler
 * and the approvals decide what to do with them.
 *
 *   start    the task is not started until the one it depends on has passed its review
 *   release  the task is not merged into staging until the one it depends on is on staging
 *   link     the two are related (a follow-up); nothing waits
 *
 * Gate facts are read from the database directly (rounds, releases), so this module can
 * be used by approvals and the release flow without importing them.
 */

import { getDb, nowMs } from '../db/db.js';
import { sseEmit } from '../api/events.js';
import { getTask, PRIORITIES, type Priority, type TaskRow } from './taskState.js';

export type Gate = 'start' | 'release' | 'link';
export const GATES: readonly Gate[] = ['start', 'release', 'link'];

export interface Dependency {
  taskId: string;
  dependsOn: string;
  gate: Gate;
}

export interface Blocker {
  id: string;
  title: string;
  state: string;
  gate: Gate;
  /** Plain words: what is being waited for. */
  why: string;
}

export class LinkError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
  }
}

export function dependenciesOf(taskId: string): Dependency[] {
  return (getDb().prepare('SELECT task_id, depends_on, gate FROM task_dependencies WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<{ task_id: string; depends_on: string; gate: Gate }>)
    .map((r) => ({ taskId: r.task_id, dependsOn: r.depends_on, gate: r.gate }));
}

export function dependentsOf(taskId: string): Dependency[] {
  return (getDb().prepare('SELECT task_id, depends_on, gate FROM task_dependencies WHERE depends_on = ? ORDER BY created_at').all(taskId) as Array<{ task_id: string; depends_on: string; gate: Gate }>)
    .map((r) => ({ taskId: r.task_id, dependsOn: r.depends_on, gate: r.gate }));
}

export function childrenOf(parentId: string): TaskRow[] {
  return getDb().prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY seq').all(parentId) as TaskRow[];
}

/** Whether `from` already (directly or through others) waits for `to`. Links do not count: nothing waits on them. */
function reaches(from: string, to: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const d of dependenciesOf(id)) if (d.gate !== 'link') stack.push(d.dependsOn);
  }
  return false;
}

/** Make `taskId` wait for `dependsOn`. Replaces an earlier gate between the same two. Refuses a cycle. */
export function addDependency(taskId: string, dependsOn: string, gate: Gate): Dependency {
  if (!GATES.includes(gate)) throw new LinkError(400, 'gate must be start, release or link');
  if (taskId === dependsOn) throw new LinkError(400, 'A task cannot wait for itself');
  const task = getTask(taskId);
  const other = getTask(dependsOn);
  if (!task || !other) throw new LinkError(404, `No task ${task ? dependsOn : taskId}`);
  if (task.kind === 'initiative' || other.kind === 'initiative') throw new LinkError(400, 'Dependencies are between tasks; an initiative follows its sub-tasks');
  if (gate !== 'link' && reaches(dependsOn, taskId)) throw new LinkError(409, `${dependsOn} already waits for ${taskId}; that would wait forever`);
  getDb().prepare(`
    INSERT INTO task_dependencies (task_id, depends_on, gate, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(task_id, depends_on) DO UPDATE SET gate = excluded.gate
  `).run(taskId, dependsOn, gate, nowMs());
  sseEmit({ type: 'task_updated', taskId });
  return { taskId, dependsOn, gate };
}

export function removeDependency(taskId: string, dependsOn: string): boolean {
  const removed = getDb().prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on = ?').run(taskId, dependsOn).changes > 0;
  if (removed) sseEmit({ type: 'task_updated', taskId });
  return removed;
}

// ─── Gate facts ───────────────────────────────────────────────────────────────

const PASSED_STATES = new Set(['awaiting_approval', 'releasing', 'deploying', 'deployed']);

function onStaging(taskId: string): boolean {
  const r = getDb().prepare(`SELECT state FROM releases WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(taskId) as { state: string } | undefined;
  return r?.state === 'pushed';
}

function passedReview(taskId: string): boolean {
  const r = getDb().prepare(`SELECT outcome FROM task_rounds WHERE task_id = ? ORDER BY round DESC LIMIT 1`).get(taskId) as { outcome: string | null } | undefined;
  return r?.outcome === 'passed' || r?.outcome === 'accepted';
}

/** Whether `dep` is far enough for a task waiting on it at `gate`. */
export function gateMet(dep: Pick<TaskRow, 'id' | 'state'>, gate: Gate): boolean {
  if (gate === 'link') return true;
  if (gate === 'release') return dep.state === 'deployed' || onStaging(dep.id);
  return PASSED_STATES.has(dep.state) || passedReview(dep.id) || onStaging(dep.id);
}

/** What `taskId` still waits for at `gate` (start or release). Empty: nothing. */
export function unmetDependencies(taskId: string, gate: Exclude<Gate, 'link'>): Blocker[] {
  const out: Blocker[] = [];
  for (const d of dependenciesOf(taskId)) {
    if (d.gate !== gate) continue;
    const dep = getTask(d.dependsOn);
    if (!dep) continue; // a deleted task no longer holds anything back
    if (gateMet(dep, gate)) continue;
    const stopped = dep.state === 'failed';
    const why = stopped
      ? `${dep.id} was stopped; remove the dependency or restart it`
      : gate === 'release'
        ? `${dep.id} (${dep.title}) must be on staging first`
        : `${dep.id} (${dep.title}) must pass its review first`;
    out.push({ id: dep.id, title: dep.title, state: dep.state, gate, why });
  }
  return out;
}

// ─── Board fields ─────────────────────────────────────────────────────────────

export interface BoardChange {
  priority?: Priority;
  autoStart?: boolean;
  position?: number;
}

export function updateBoardFields(taskId: string, change: BoardChange): TaskRow {
  const task = getTask(taskId);
  if (!task) throw new LinkError(404, `No task ${taskId}`);
  if (change.priority !== undefined && !PRIORITIES.includes(change.priority)) throw new LinkError(400, 'priority must be p0, p1, p2 or p3');
  if (change.position !== undefined && (!Number.isInteger(change.position) || change.position < 0)) throw new LinkError(400, 'position must be a whole number');
  getDb().prepare('UPDATE tasks SET priority = ?, auto_start = ?, position = ?, updated_at = ? WHERE id = ?').run(
    change.priority ?? task.priority,
    change.autoStart === undefined ? task.auto_start : change.autoStart ? 1 : 0,
    change.position ?? task.position,
    nowMs(),
    taskId,
  );
  const updated = getTask(taskId)!;
  sseEmit({ type: 'task_updated', taskId, task: updated });
  return updated;
}

/** Put the backlog in this order (ids first to last); tasks not named keep their place after them. */
export function reorderBacklog(ids: string[]): void {
  const db = getDb();
  const update = db.prepare('UPDATE tasks SET position = ? WHERE id = ?');
  db.transaction(() => ids.forEach((id, i) => update.run(i, id)))();
  sseEmit({ type: 'board_reordered' });
}
