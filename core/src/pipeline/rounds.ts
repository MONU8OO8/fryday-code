/** Stored review rounds: what the checks, the diff flags and the tester said after each coder round. */

import { getDb, nowMs } from '../db/db.js';
import type { CheckResult } from './checks.js';
import type { DiffFlag } from './diffFlags.js';
import type { SelfCheck, Verdict } from './review.js';
import type { Verification } from '../verify/report.js';

/** accepted: the round was escalated, and the owner accepted the change as it is. */
export type RoundOutcome = 'passed' | 'changes_requested' | 'escalated' | 'accepted';

/** The round lets the task go on to the owner's approval: it passed, or the owner accepted it. */
export const roundCleared = (outcome: string | null | undefined): boolean => outcome === 'passed' || outcome === 'accepted';

export interface Round {
  taskId: string;
  round: number;
  headSha: string | null;
  checks: CheckResult[];
  flags: DiffFlag[];
  verdict: Verdict | null;
  /** What happened when the change was run and used, for projects with a run profile. */
  verify: Verification | null;
  outcome: RoundOutcome | null;
  feedback: string | null;
  /** The coder's self-check on each criterion and how it compared with the tester. */
  selfCheck: SelfCheck | null;
}

interface RoundRow {
  task_id: string; round: number; head_sha: string | null; checks_json: string | null; flags_json: string | null;
  verdict_json: string | null; verify_json: string | null; outcome: RoundOutcome | null; feedback: string | null;
  self_check_json: string | null;
}

const fromRow = (r: RoundRow): Round => ({
  taskId: r.task_id,
  round: r.round,
  headSha: r.head_sha,
  checks: r.checks_json ? (JSON.parse(r.checks_json) as CheckResult[]) : [],
  flags: r.flags_json ? (JSON.parse(r.flags_json) as DiffFlag[]) : [],
  verdict: r.verdict_json ? (JSON.parse(r.verdict_json) as Verdict) : null,
  verify: r.verify_json ? (JSON.parse(r.verify_json) as Verification) : null,
  outcome: r.outcome,
  feedback: r.feedback,
  selfCheck: r.self_check_json ? (JSON.parse(r.self_check_json) as SelfCheck) : null,
});

export function getRounds(taskId: string): Round[] {
  return (getDb().prepare('SELECT * FROM task_rounds WHERE task_id = ? ORDER BY round').all(taskId) as RoundRow[]).map(fromRow);
}

export function getRound(taskId: string, round: number): Round | undefined {
  const row = getDb().prepare('SELECT * FROM task_rounds WHERE task_id = ? AND round = ?').get(taskId, round) as RoundRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Record the gate results for a round, replacing any earlier attempt at the same round. */
export function saveGate(taskId: string, round: number, headSha: string, checks: CheckResult[], flags: DiffFlag[]): void {
  getDb().prepare(`
    INSERT INTO task_rounds (task_id, round, head_sha, checks_json, flags_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, round) DO UPDATE SET
      head_sha = excluded.head_sha, checks_json = excluded.checks_json, flags_json = excluded.flags_json,
      verdict_json = NULL, verify_json = NULL, outcome = NULL, feedback = NULL, self_check_json = NULL
  `).run(taskId, round, headSha, JSON.stringify(checks), JSON.stringify(flags), nowMs());
}

export function saveVerdict(taskId: string, round: number, verdict: Verdict): void {
  getDb().prepare('UPDATE task_rounds SET verdict_json = ? WHERE task_id = ? AND round = ?').run(JSON.stringify(verdict), taskId, round);
}

export function saveSelfCheck(taskId: string, round: number, selfCheck: SelfCheck): void {
  getDb().prepare('UPDATE task_rounds SET self_check_json = ? WHERE task_id = ? AND round = ?').run(JSON.stringify(selfCheck), taskId, round);
}

export function saveOutcome(taskId: string, round: number, outcome: RoundOutcome, feedback: string | null): void {
  getDb().prepare('UPDATE task_rounds SET outcome = ?, feedback = ? WHERE task_id = ? AND round = ?').run(outcome, feedback, taskId, round);
}
