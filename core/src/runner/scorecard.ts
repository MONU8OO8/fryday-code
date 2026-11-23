/**
 * How each agent has been doing, from stored facts only (`runs`, `task_rounds`, usage):
 * how often the Builder's first round passes, how many rounds it takes, what sends work back,
 * tokens per task, and runs stopped at their time or token limit. Also where tokens and time
 * went, per stage and per project, for History.
 */

import { getDb } from '../db/db.js';
import { countedTokens, getRunUsage } from './usage.js';
import { shortenPaths } from './runEvents.js';
import { redactSecrets } from '../secretPatterns.js';
import type { CheckResult } from '../pipeline/checks.js';
import type { DiffFlag } from '../pipeline/diffFlags.js';
import type { SelfCheck, Verdict } from '../pipeline/review.js';
import type { Verification } from '../verify/report.js';

export const LANE_ROLES = ['analyst', 'planner', 'coder', 'tester', 'api_tester', 'ui_tester', 'reflector', 'fryday'] as const;
export type LaneRole = (typeof LANE_ROLES)[number];

export interface RoleScore {
  runs: number;
  tasks: number;
  /** Runs stopped at their time limit, at their token limit, or that failed. */
  stops: { timeout: number; budget: number; failed: number };
  tokensPerTask: number | null;
  minutesPerRun: number | null;
  /** Builder: share of tasks whose first round passed (0–1). A round the owner accepted despite its findings is not a pass. */
  firstRoundPassRate?: number | null;
  /** Builder: rounds needed, over tasks that passed. */
  roundsToPass?: number | null;
  /** Builder: what sent its work back, most common first, with the latest failing test or error for a failed check. */
  failureCauses?: Array<{ cause: string; count: number; example?: string }>;
  /** Builder: of the criteria it said were met in its self-check, the share the Checker agreed with (0–1). */
  selfCheckAccuracy?: number | null;
  /** Builder: criteria it said were met that the Checker found not met. */
  overconfidentClaims?: number;
  /** Builder: first-round passes on tasks it was given approved lessons on, and on the others. */
  lessonTrend?: { withLessons: { tasks: number; firstRoundPassRate: number | null }; without: { tasks: number; firstRoundPassRate: number | null } };
  /** Checker and testers: share of their verdicts that let the change through (0–1). */
  passRate?: number | null;
}

export interface Scorecard {
  role: LaneRole;
  week: RoleScore;
  month: RoleScore;
}

interface RunRow { id: string; task_id: string | null; role: string; state: string; started_at: number; ended_at: number | null }
interface RoundRow { task_id: string; round: number; checks_json: string | null; flags_json: string | null; verdict_json: string | null; verify_json: string | null; outcome: string | null; self_check_json: string | null }

const DAY = 86_400_000;
const parse = <T>(json: string | null): T | null => {
  if (!json) return null;
  try { return JSON.parse(json) as T; } catch { return null; }
};
const share = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 100) / 100 : null);

const FLAG_CAUSE: Partial<Record<DiffFlag['kind'], string>> = {
  'test-deleted': 'A test was deleted',
  'test-skipped': 'A test was skipped',
  'test-focused': 'A test was focused (.only)',
  secret: 'A secret-looking value was added',
};
const CHECK_CAUSE: Record<string, string> = { test: 'Tests failed', lint: 'Lint failed', typecheck: 'Type check failed' };

/** The first failure a failed check read from its output (new ones first), cleaned, for a cause's example. */
function failureExample(checksJson: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of parse<CheckResult[]>(checksJson) ?? []) {
    const first = c.status === 'failed' ? (c.newFailures?.[0] ?? c.failures?.[0]) : undefined;
    const cause = CHECK_CAUSE[c.name] ?? `${c.name} failed`;
    if (first && !out.has(cause)) out.set(cause, redactSecrets(shortenPaths(first)).slice(0, 160));
  }
  return out;
}

/** Why one round did not pass, in plain words; one entry per kind of reason. */
export function causesOfRound(r: Pick<RoundRow, 'checks_json' | 'flags_json' | 'verdict_json' | 'verify_json'>): string[] {
  const out = new Set<string>();
  for (const c of parse<CheckResult[]>(r.checks_json) ?? []) {
    if (c.status === 'failed') out.add(CHECK_CAUSE[c.name] ?? `${c.name} failed`);
    else if (c.status === 'timeout') out.add('A check timed out');
    else if (c.status === 'error') out.add('A check could not run');
  }
  for (const f of parse<DiffFlag[]>(r.flags_json) ?? []) {
    if (f.severity === 'blocking') out.add(FLAG_CAUSE[f.kind] ?? 'The diff scan blocked it');
  }
  const verdict = parse<Verdict>(r.verdict_json);
  if (verdict?.verdict === 'fail') {
    if (verdict.criteria?.some((c) => !c.met)) out.add('An acceptance criterion was not met');
    if (verdict.issues?.some((i) => i.severity === 'blocking')) out.add('The Checker found a blocking issue');
    if (!verdict.criteria?.some((c) => !c.met) && !verdict.issues?.some((i) => i.severity === 'blocking')) out.add('The Checker sent it back');
  }
  const verify = parse<Verification>(r.verify_json);
  if (verify?.status === 'failed') out.add(verify.startFailure ? 'The service did not start with the change' : 'A tester found a problem');
  return [...out];
}

/** Tasks whose Builder was given at least one approved lesson. */
function lessonTasks(): Set<string> {
  return new Set((getDb().prepare(`SELECT DISTINCT task_id FROM lesson_uses WHERE role = 'coder'`).all() as Array<{ task_id: string }>).map((r) => r.task_id));
}

function scoreRole(role: LaneRole, runs: RunRow[], rounds: RoundRow[]): RoleScore {
  const mine = runs.filter((r) => r.role === role || (role === 'fryday' && r.role === 'system'));
  const tasks = new Set(mine.flatMap((r) => (r.task_id ? [r.task_id] : [])));
  const tokens = mine.reduce((n, r) => n + countedTokens(getRunUsage(r.id)), 0);
  const ended = mine.filter((r) => r.ended_at !== null);
  const score: RoleScore = {
    runs: mine.length,
    tasks: tasks.size,
    stops: {
      timeout: mine.filter((r) => r.state === 'timeout').length,
      budget: mine.filter((r) => r.state === 'budget').length,
      failed: mine.filter((r) => r.state === 'failed').length,
    },
    tokensPerTask: tasks.size ? Math.round(tokens / tasks.size) : null,
    minutesPerRun: ended.length ? Math.round((ended.reduce((n, r) => n + (r.ended_at! - r.started_at), 0) / ended.length / 60_000) * 10) / 10 : null,
  };
  const ofTasks = rounds.filter((r) => tasks.has(r.task_id) && r.outcome);
  if (role === 'coder') {
    const byTask = new Map<string, RoundRow[]>();
    for (const r of ofTasks) byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), r]);
    const firsts = [...byTask.values()].map((rs) => rs.find((r) => r.round === 1)).filter((r): r is RoundRow => !!r);
    const passedAt = [...byTask.values()].map((rs) => rs.filter((r) => r.outcome === 'passed').map((r) => r.round)).filter((rs) => rs.length).map((rs) => Math.min(...rs));
    const counts = new Map<string, number>();
    const examples = new Map<string, string>();
    const sentBack = ofTasks.filter((x) => x.outcome !== 'passed');
    for (const r of sentBack) for (const c of causesOfRound(r)) counts.set(c, (counts.get(c) ?? 0) + 1);
    for (const r of sentBack) for (const [cause, example] of failureExample(r.checks_json)) examples.set(cause, example);
    score.firstRoundPassRate = share(firsts.filter((r) => r.outcome === 'passed').length, firsts.length);
    const taught = lessonTasks();
    const firstsWith = firsts.filter((r) => taught.has(r.task_id));
    const firstsWithout = firsts.filter((r) => !taught.has(r.task_id));
    score.lessonTrend = {
      withLessons: { tasks: firstsWith.length, firstRoundPassRate: share(firstsWith.filter((r) => r.outcome === 'passed').length, firstsWith.length) },
      without: { tasks: firstsWithout.length, firstRoundPassRate: share(firstsWithout.filter((r) => r.outcome === 'passed').length, firstsWithout.length) },
    };
    score.roundsToPass = passedAt.length ? Math.round((passedAt.reduce((a, b) => a + b, 0) / passedAt.length) * 10) / 10 : null;
    const calibrations = ofTasks.flatMap((r) => parse<SelfCheck>(r.self_check_json)?.calibration ?? []);
    const claimedMet = calibrations.reduce((n, c) => n + c.claimedMet, 0);
    score.overconfidentClaims = calibrations.reduce((n, c) => n + c.overconfident, 0);
    score.selfCheckAccuracy = share(claimedMet - score.overconfidentClaims, claimedMet);
    score.failureCauses = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([cause, count]) => (examples.has(cause) ? { cause, count, example: examples.get(cause)! } : { cause, count }));
  } else if (role === 'tester') {
    const verdicts = ofTasks.map((r) => parse<Verdict>(r.verdict_json)).filter((v): v is Verdict => !!v);
    score.passRate = share(verdicts.filter((v) => v.verdict === 'pass').length, verdicts.length);
  } else if (role === 'api_tester' || role === 'ui_tester') {
    const kind = role === 'api_tester' ? 'api' : 'ui';
    const records = ofTasks.flatMap((r) => parse<Verification>(r.verify_json)?.testers ?? []).filter((t) => t.kind === kind);
    score.passRate = share(records.filter((t) => t.passed).length, records.length);
  }
  return score;
}

/** One scorecard per agent: the last 7 and the last 30 days. */
export function scorecards(now = Date.now()): Scorecard[] {
  const db = getDb();
  const monthAgo = now - 30 * DAY;
  const weekAgo = now - 7 * DAY;
  const runs = db.prepare('SELECT id, task_id, role, state, started_at, ended_at FROM runs WHERE started_at >= ?').all(monthAgo) as RunRow[];
  const rounds = db.prepare('SELECT task_id, round, checks_json, flags_json, verdict_json, verify_json, outcome, self_check_json FROM task_rounds WHERE created_at >= ?').all(monthAgo) as RoundRow[];
  const weekRuns = runs.filter((r) => r.started_at >= weekAgo);
  return LANE_ROLES.map((role) => ({ role, week: scoreRole(role, weekRuns, rounds), month: scoreRole(role, runs, rounds) }));
}

export interface CostRow { key: string; tokens: number; reusedTokens: number; minutes: number; runs: number }
export interface CostAnalytics {
  days: number;
  byStage: CostRow[];
  byProject: CostRow[];
}

const STAGE_OF: Record<string, string> = {
  analyst: 'Understand', planner: 'Plan', coder: 'Build', tester: 'Check', api_tester: 'Check', ui_tester: 'Check', fryday: 'Talking to you', system: 'Talking to you',
};

/** Tokens and agent time per journey stage and per project, for runs started in the last `days` days. */
export function costAnalytics(days = 30, now = Date.now()): CostAnalytics {
  const db = getDb();
  const runs = db.prepare(`
    SELECT r.id, r.role, r.started_at, r.ended_at,
      (SELECT w.repo_id FROM task_workspaces w WHERE w.task_id = r.task_id ORDER BY w.created_at DESC LIMIT 1) AS repo_id,
      json_extract(t.metadata_json, '$.plannedProject') AS planned
    FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
    WHERE r.started_at >= ?
  `).all(now - days * DAY) as Array<{ id: string; role: string; started_at: number; ended_at: number | null; repo_id: string | null; planned: string | null }>;
  const names = new Map((db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
  const stage = new Map<string, CostRow>();
  const project = new Map<string, CostRow>();
  const add = (map: Map<string, CostRow>, key: string, tokens: number, reused: number, minutes: number) => {
    const row = map.get(key) ?? { key, tokens: 0, reusedTokens: 0, minutes: 0, runs: 0 };
    row.tokens += tokens; row.reusedTokens += reused; row.minutes += minutes; row.runs += 1;
    map.set(key, row);
  };
  for (const r of runs) {
    const u = getRunUsage(r.id);
    const minutes = r.ended_at ? (r.ended_at - r.started_at) / 60_000 : 0;
    add(stage, STAGE_OF[r.role] ?? 'Other', countedTokens(u), u.cacheReadTokens, minutes);
    const repo = r.repo_id ?? r.planned;
    add(project, repo ? names.get(repo) ?? repo : 'No project yet', countedTokens(u), u.cacheReadTokens, minutes);
  }
  const done = (map: Map<string, CostRow>) => [...map.values()].map((r) => ({ ...r, minutes: Math.round(r.minutes * 10) / 10 })).sort((a, b) => b.tokens - a.tokens);
  return { days, byStage: done(stage), byProject: done(project) };
}
