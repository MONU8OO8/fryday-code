/**
 * The board's scheduler: what starts next, without the owner pressing Start each time.
 *
 * Every few seconds (and right after anything that may free a slot) it:
 *   1. starts queued tasks marked auto-start, highest priority first, then board order,
 *      while fewer than Settings.maxAgents tasks are working, the machine can take more
 *      work (see system/health.ts) and everything the task waits for at the start gate
 *      has passed its review;
 *   2. asks for the release of a task that was held back by a release dependency, once
 *      that dependency is on staging.
 *
 * It never approves anything and never pushes: starting a task only begins the Analyst's
 * reading, and a release still needs the owner's yes on its ticket.
 */

import { getDb } from '../db/db.js';
import { getSettings } from '../settings.js';
import { sseEmit } from '../api/events.js';
import { ACTIVE_STATES } from './stateMachine.js';
import { onTaskStateChange, setTaskNote, taskMetadata, type TaskRow } from './taskState.js';
import { unmetDependencies } from './taskLinks.js';
import { requestNextApproval } from './pushFlow.js';
import { startTask, StartError } from './pipeline.js';

const TICK_MS = 5_000;

export interface Admission {
  ok: boolean;
  /** Plain words, when not ok. */
  why?: string;
}

export interface SchedulerStatus {
  running: boolean;
  slots: { used: number; max: number };
  /** Why nothing more is being started right now, if that is the case. */
  paused: string | null;
  /** Queued auto-start tasks and what each is waiting for. */
  waiting: Array<{ id: string; why: string }>;
  lastTickAt: number | null;
}

type Starter = (taskId: string, project: string | null, branch: string | null) => void;
let admit: () => Admission = () => ({ ok: true });
let start: Starter = (taskId, project, branch) => startTask(taskId, project, { branch });
let timer: NodeJS.Timeout | null = null;
let ticking = false;
let again = false;
let status: SchedulerStatus = { running: false, slots: { used: 0, max: 0 }, paused: null, waiting: [], lastTickAt: null };

const PRIORITY_ORDER = `CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 ELSE 3 END`;

export function schedulerStatus(): SchedulerStatus {
  return { ...status, slots: { ...status.slots }, waiting: [...status.waiting] };
}

function workingCount(): number {
  const states = [...ACTIVE_STATES];
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE kind = 'task' AND state IN (${states.map(() => '?').join(', ')})`)
    .get(...states) as { n: number };
  return row.n;
}

/** Set a note only when it says something new, so a waiting task's thread is not filled every tick. */
function noteOnce(task: TaskRow, note: string): void {
  if (taskMetadata(task)['note'] !== note) setTaskNote(task.id, note);
}

function startDue(): Pick<SchedulerStatus, 'paused' | 'waiting'> {
  const waiting: SchedulerStatus['waiting'] = [];
  const queued = getDb()
    .prepare(`SELECT * FROM tasks WHERE state = 'queued' AND kind = 'task' AND auto_start = 1 ORDER BY ${PRIORITY_ORDER}, position, created_at`)
    .all() as TaskRow[];
  if (!queued.length) return { paused: null, waiting };

  const max = getSettings().maxAgents;
  let paused: string | null = null;
  for (const task of queued) {
    const blockers = unmetDependencies(task.id, 'start');
    if (blockers.length) {
      const why = `Waiting: ${blockers.map((b) => b.why).join('; ')}`;
      waiting.push({ id: task.id, why });
      noteOnce(task, why);
      continue;
    }
    if (paused) { waiting.push({ id: task.id, why: paused }); continue; }
    if (workingCount() >= max) {
      paused = `All ${max} slots are busy`;
      waiting.push({ id: task.id, why: paused });
      continue;
    }
    const machine = admit();
    if (!machine.ok) {
      paused = machine.why ?? 'The machine is too busy to start more work';
      waiting.push({ id: task.id, why: paused });
      noteOnce(task, `Waiting to start: ${paused}`);
      continue;
    }
    const meta = taskMetadata(task);
    const project = typeof meta['plannedProject'] === 'string' ? meta['plannedProject'] : null;
    const branch = typeof meta['plannedBranch'] === 'string' ? meta['plannedBranch'] : null;
    try {
      start(task.id, project, branch);
    } catch (err) {
      if (!(err instanceof StartError)) throw err;
      // The owner has to fix something; do not try again every tick.
      getDb().prepare('UPDATE tasks SET auto_start = 0 WHERE id = ?').run(task.id);
      setTaskNote(task.id, `Could not start it automatically: ${err.message}`);
    }
  }
  return { paused, waiting };
}

/** A task held back from asking for its release: ask now if what it waited for is on staging. */
function releaseDue(): void {
  const held = getDb()
    .prepare(`
      SELECT t.* FROM tasks t
      WHERE t.state = 'awaiting_approval' AND t.kind = 'task'
        AND json_extract(t.metadata_json, '$.note') LIKE 'Waiting to merge%'
        AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.state = 'pending')
    `)
    .all() as TaskRow[];
  for (const task of held) {
    if (unmetDependencies(task.id, 'release').length) continue;
    setTaskNote(task.id, requestNextApproval(task.id));
  }
}

/** Run one pass now. Overlapping calls are folded into one more pass after the current one. */
export function kickScheduler(): void {
  if (ticking) { again = true; return; }
  ticking = true;
  try {
    do {
      again = false;
      const { paused, waiting } = startDue();
      releaseDue();
      const next: SchedulerStatus = {
        running: timer !== null,
        slots: { used: workingCount(), max: getSettings().maxAgents },
        paused,
        waiting,
        lastTickAt: Date.now(),
      };
      const changed = JSON.stringify({ ...next, lastTickAt: 0 }) !== JSON.stringify({ ...status, lastTickAt: 0 });
      status = next;
      if (changed) sseEmit({ type: 'scheduler', status: schedulerStatus() });
    } while (again);
  } catch (err) {
    console.error('[fryday-core] scheduler pass failed:', err);
  } finally {
    ticking = false;
  }
}

/** Replace how the scheduler checks the machine or starts a task (tests start nothing real). */
export function configureScheduler(opts: { admit?: () => Admission; start?: Starter }): void {
  if (opts.admit) admit = opts.admit;
  if (opts.start) start = opts.start;
}

/** Call once at startup, after interrupted tasks are recovered. `admission` is the machine's health check. */
export function startScheduler(admission?: () => Admission): void {
  if (admission) admit = admission;
  if (timer) return;
  timer = setInterval(kickScheduler, TICK_MS);
  timer.unref();
  // A task finishing, failing or reaching review may free a slot or meet a gate.
  onTaskStateChange((task) => {
    if (ACTIVE_STATES.has(task.state)) return;
    setImmediate(kickScheduler);
  });
  kickScheduler();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  status = { ...status, running: false };
}
