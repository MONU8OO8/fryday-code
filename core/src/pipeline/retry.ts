/**
 * One more try when the AI service was briefly unavailable.
 *
 * A run that failed because the API was overloaded or rate limited says nothing about the
 * work. Its stage is started once more after a pause, before the task goes to the owner.
 * The retry is a new run like any other: it starts through the task's token limit and its
 * tokens count as usual. Which stages have had their retry is kept on the task (metadata
 * `retried`), so a stage gets at most one per round, and a restart cannot make it loop.
 *
 * A scheduled retry is also kept on the task, as a one-time value (metadata `pendingRetry`).
 * Any state change of the task and any new agent start for it clears that value, and the
 * timer does nothing unless it still finds its own: a stop, an owner's restart or a new
 * start within the backoff never gets a second run from an old timer.
 */

import { randomUUID } from 'node:crypto';
import { getTask, setTaskNote, taskMetadata, updateTaskMetadata, PENDING_RETRY_KEY } from './taskState.js';
import { ACTOR_NAME, actorOfRole } from './plainWords.js';

/**
 * How the claude CLI says the API was busy, in the run's own error (never the agent's final
 * text, which may only talk about rate limits): an `API Error` with a 429 or 529, a request
 * that failed with one of those status codes, or the API's own error types.
 */
const BUSY = [
  /^\s*API Error\b[^\n]*?\b(?:429|529)\b/i,
  /\bstatus(?: code)?\W{0,3}(?:429|529)\b/i,
  /\b(?:overloaded_error|rate_limit_error)\b/,
];

/** Whether a run's error (`exit.error` / `runs.error_msg`) says the AI service was briefly unavailable. */
export function isBusyServiceError(error: string | null | undefined): boolean {
  return typeof error === 'string' && BUSY.some((re) => re.test(error));
}

/** How long to wait before the retry. FRYDAY_RETRY_BACKOFF_MS; default 30 s. */
export function retryBackoffMs(): number {
  const n = Number(process.env['FRYDAY_RETRY_BACKOFF_MS'] ?? 30_000);
  return Number.isFinite(n) && n >= 0 ? n : 30_000;
}

/** Take the one retry of this stage. False when it was already used. */
function claimRetry(taskId: string, key: string): boolean {
  const task = getTask(taskId);
  if (!task) return false;
  const stored = taskMetadata(task)['retried'];
  const retried = Array.isArray(stored) ? stored.filter((k): k is string => typeof k === 'string') : [];
  if (retried.includes(key)) return false;
  updateTaskMetadata(taskId, { retried: [...retried, key] });
  return true;
}

export interface EndedRun {
  state: string;
  /** The run's error (`exit.error`); the agent's final text is not read. */
  error: string | null;
}

/** The stage a run was for: its role and round, and for a role with more than one job, which. */
export interface RetryStage {
  role: string;
  round: number;
  job?: string;
}

/**
 * When `run` failed because the AI service was busy and its stage has not had its retry
 * yet: note it on the task, call `again` after the backoff and return true. Otherwise
 * return false and do nothing; the caller hands the task to the owner as before.
 * `again` must check that the task is still where it was before it starts anything.
 */
export function retryWhenBusy(taskId: string, run: EndedRun, stage: RetryStage, again: () => void): boolean {
  if (run.state !== 'failed' || !isBusyServiceError(run.error)) return false;
  if (!claimRetry(taskId, `${stage.role}${stage.job ? `.${stage.job}` : ''}:${stage.round}`)) return false;
  const ms = retryBackoffMs();
  const when = ms >= 1000 ? ` in ${Math.round(ms / 1000)} seconds` : '';
  setTaskNote(taskId, `The AI service was busy for a moment. The ${ACTOR_NAME[actorOfRole(stage.role)]} will try again${when}.`);
  const nonce = randomUUID();
  updateTaskMetadata(taskId, { [PENDING_RETRY_KEY]: nonce });
  setTimeout(() => {
    if (!takePendingRetry(taskId, nonce)) return; // stopped, restarted or started again in the meantime
    again();
  }, ms);
  return true;
}

/** Clear the task's scheduled retry, if any: a new start of a stage replaces it. */
export function cancelPendingRetry(taskId: string): void {
  const task = getTask(taskId);
  if (task && taskMetadata(task)[PENDING_RETRY_KEY] !== undefined) updateTaskMetadata(taskId, { [PENDING_RETRY_KEY]: undefined });
}

/** True, once, when `nonce` is still the task's scheduled retry. */
function takePendingRetry(taskId: string, nonce: string): boolean {
  const task = getTask(taskId);
  if (!task || taskMetadata(task)[PENDING_RETRY_KEY] !== nonce) return false;
  updateTaskMetadata(taskId, { [PENDING_RETRY_KEY]: undefined });
  return true;
}
