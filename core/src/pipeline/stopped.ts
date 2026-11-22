/**
 * A task that stopped at the round limit, and what the owner can do with it. Reads stored facts
 * only; pipeline.ts carries the choices out (tryAgainAfterStop, acceptAsItIs).
 */

import fs from 'fs';
import { getDb } from '../db/db.js';
import { getTask } from './taskState.js';
import { activeWorkspace } from './workspaces.js';
import { getRounds } from './rounds.js';
import { gateBlocks, verdictPasses } from './review.js';

export class StoppedError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * What the owner can do with a task that stopped at the round limit. tryAgain: one more round
 * for the Builder, with what the owner wrote since. accept: take the change as it is and go
 * on to the usual approval; only when what stopped it was a judgement (the Checker or a tester),
 * never a failing check or a change FryDay does not allow. why: the Checker's own words.
 */
export interface StoppedChoices { tryAgain: boolean; accept: boolean; why: string | null }

const NO_CHOICES: StoppedChoices = { tryAgain: false, accept: false, why: null };

export function stoppedChoices(taskId: string): StoppedChoices {
  const task = getTask(taskId);
  if (!task || task.state !== 'needs_owner') return NO_CHOICES;
  const pending = getDb().prepare(`SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND state = 'pending'`).get(taskId) as { n: number };
  if (pending.n > 0) return NO_CHOICES;
  const ws = activeWorkspace(taskId);
  if (!ws || !fs.existsSync(ws.worktree_path)) return NO_CHOICES;
  const last = getRounds(taskId).at(-1);
  // Escalated with feedback is the round limit; without, a check could not run (another round cannot help).
  if (!last || last.outcome !== 'escalated' || !last.feedback) return NO_CHOICES;
  const why = last.verdict && !verdictPasses(last.verdict) ? last.verdict.summary
    : last.verify?.testers.find((t) => !t.passed)?.report?.summary ?? null;
  return { tryAgain: true, accept: !gateBlocks(last.checks, last.flags), why };
}
