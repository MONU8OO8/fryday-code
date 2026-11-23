/**
 * The one place a task's state changes: validates the transition, stores it and
 * tells the UI.
 */

import { getDb, nowMs } from '../db/db.js';
import { sseEmit } from '../api/events.js';
import { assertTransition, type TaskState } from './stateMachine.js';
import { addEvent } from './thread.js';
import { getSettings } from '../settings.js';
import { countedTokens, getTaskUsage } from '../runner/usage.js';

export interface TaskRow {
  id: string;
  seq: number;
  title: string;
  description: string;
  state: TaskState;
  created_at: number;
  updated_at: number;
  plan_json: string | null;
  brief_json: string | null;
  metadata_json: string | null;
  parent_id: string | null;
  priority: Priority;
  kind: 'task' | 'initiative';
  /** owner: asked for by the owner; bug: filed by core from a problem an agent found (bugs.ts). */
  origin: 'owner' | 'bug';
  auto_start: number;
  position: number;
}

export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export function getTask(taskId: string): TaskRow | undefined {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as TaskRow | undefined;
}

/** Where a busy-service retry keeps its one-time value (see retry.ts); a state change clears it. */
export const PENDING_RETRY_KEY = 'pendingRetry';

/** Move a task to `to`. `note` is a one-line explanation shown to the owner. */
export function setTaskState(taskId: string, to: TaskState, note?: string): TaskRow {
  const task = getTask(taskId);
  if (!task) throw new Error(`Unknown task ${taskId}`);
  assertTransition(task.state, to);

  const metadata: Record<string, unknown> = { ...parseJson(task.metadata_json), ...(note !== undefined ? { note } : {}) };
  delete metadata[PENDING_RETRY_KEY]; // a retry scheduled before this change must not start
  getDb()
    .prepare('UPDATE tasks SET state = ?, metadata_json = ?, updated_at = ? WHERE id = ?')
    .run(to, JSON.stringify(metadata), nowMs(), taskId);

  if (note) addEvent(taskId, note);
  const updated = getTask(taskId)!;
  sseEmit({ type: 'task_updated', taskId, task: updated });
  notifyStateChange(updated, note);
  return updated;
}

/** Change the one-line note without changing the state (progress inside a stage). */
export function setTaskNote(taskId: string, note: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const metadata = { ...parseJson(task.metadata_json), note };
  getDb().prepare('UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(metadata), nowMs(), taskId);
  addEvent(taskId, note);
  sseEmit({ type: 'task_updated', taskId, task: getTask(taskId) });
}

/** Read or change the small per-task values kept beside the note (intake choices, token limit). */
export function taskMetadata(task: Pick<TaskRow, 'metadata_json'>): Record<string, unknown> {
  return parseJson(task.metadata_json);
}

export function updateTaskMetadata(taskId: string, change: Record<string, unknown>): void {
  const task = getTask(taskId);
  if (!task) return;
  getDb().prepare('UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...parseJson(task.metadata_json), ...change }), nowMs(), taskId);
}

/**
 * Most counted tokens the task may use: its own raised limit (metadata.tokenLimit, set when
 * the owner allows more) or the default from Settings.
 */
export function taskTokenLimit(task: Pick<TaskRow, 'metadata_json'>): number {
  const stored = parseJson(task.metadata_json)['tokenLimit'];
  return typeof stored === 'number' && stored > 0 ? stored : getSettings().taskTokenLimit;
}

/** Counted tokens the task's agents have used so far. */
export function taskTokensUsed(taskId: string): number {
  return countedTokens(getTaskUsage(taskId));
}

/** What the task may still use. Zero or less: it asks the owner before the next agent. */
export function taskTokensLeft(taskId: string): number {
  const task = getTask(taskId);
  return task ? taskTokenLimit(task) - taskTokensUsed(taskId) : 0;
}

// Set at startup: the notifier (what the owner should hear about), the initiative rollup and the scheduler.
type StateListener = (task: TaskRow, note: string | undefined) => void;
const stateListeners: StateListener[] = [];
export function onTaskStateChange(listener: StateListener): void {
  if (!stateListeners.includes(listener)) stateListeners.push(listener);
}
function notifyStateChange(task: TaskRow, note: string | undefined): void {
  for (const listener of stateListeners) {
    try {
      listener(task, note);
    } catch (err) {
      console.error('[fryday-core] state listener failed:', err);
    }
  }
}

function parseJson(text: string | null): Record<string, unknown> {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export interface NewTaskOptions {
  priority?: Priority;
  kind?: 'task' | 'initiative';
  parentId?: string | null;
  /** The scheduler starts it when a slot is free and its dependencies are met. */
  autoStart?: boolean;
  /** Kept for the scheduler: the project and branch to start it with. */
  metadata?: Record<string, unknown>;
  origin?: 'owner' | 'bug';
}

/** Create a queued task. The API, the Chat space and an initiative's split all make tasks through this. */
export function createTask(title: string, description: string, opts: NewTaskOptions = {}): TaskRow {
  const db = getDb();
  const id = db.transaction(() => {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM tasks').get() as { next: number }).next;
    const taskId = `T-${seq}`;
    const now = nowMs();
    db.prepare(`
      INSERT INTO tasks (id, seq, title, description, state, created_at, updated_at, priority, kind, parent_id, auto_start, position, metadata_json, origin)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      taskId, seq, title, description, now, now,
      opts.priority ?? 'p2', opts.kind ?? 'task', opts.parentId ?? null, opts.autoStart ? 1 : 0, seq,
      opts.metadata ? JSON.stringify(opts.metadata) : null, opts.origin ?? 'owner',
    );
    return taskId;
  })();
  const task = getTask(id)!;
  sseEmit({ type: 'task_created', task });
  return task;
}
