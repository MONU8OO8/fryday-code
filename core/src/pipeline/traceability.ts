/**
 * The traceability table of a task: each acceptance criterion of the plan, the tests the plan
 * named for it, what the Checker found and what each tester found, from the latest round that
 * was reviewed. Criteria are matched by their words; the plan does not number them.
 */

import { getTask } from './taskState.js';
import { getRounds } from './rounds.js';
import { matchCriterion, normalize, parsePlan } from './review.js';
import { shortenPaths } from '../runner/runEvents.js';
import { redactSecrets } from '../secretPatterns.js';

export { matchCriterion };

export interface TraceRow {
  criterion: string;
  /** Items of the plan's test plan that speak to this criterion. */
  tests: string[];
  checker: { met: boolean; evidence: string } | null;
  testers: Array<{ who: 'App tester' | 'Page tester'; result: 'met' | 'not_met' | 'not_checked'; evidence: string }>;
}

export interface Traceability {
  /** The round the findings come from; null before any review. */
  round: number | null;
  rows: TraceRow[];
  /** Test-plan items that could not be tied to one criterion. */
  otherTests: string[];
}

const EVIDENCE_CHARS = 500;
const STOP = new Set(['that', 'with', 'from', 'this', 'when', 'then', 'have', 'into', 'there', 'their', 'should', 'would', 'which', 'each', 'every', 'test', 'tests', 'check', 'returns', 'return', 'shows', 'must']);

const words = (s: string) => new Set(normalize(s).split(' ').filter((w) => w.length >= 4 && !STOP.has(w)));
const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w)).length;
const clean = (s: string) => {
  const t = redactSecrets(shortenPaths(s.trim()));
  return t.length > EVIDENCE_CHARS ? `${t.slice(0, EVIDENCE_CHARS)}…` : t;
};


/** Each test-plan item goes to the criterion it shares the most words with (at least two). */
export function linkTests(criteria: string[], testPlan: string[]): { byCriterion: string[][]; other: string[] } {
  const keys = criteria.map(words);
  const byCriterion = criteria.map(() => [] as string[]);
  const other: string[] = [];
  for (const test of testPlan) {
    const w = words(test);
    let best = -1;
    let bestScore = 1;
    keys.forEach((k, i) => {
      const score = overlap(w, k);
      if (score > bestScore) { best = i; bestScore = score; }
    });
    if (best >= 0) byCriterion[best]!.push(test);
    else other.push(test);
  }
  return { byCriterion, other };
}

export function traceability(taskId: string): Traceability | null {
  const task = getTask(taskId);
  if (!task) return null;
  const plan = parsePlan(task.plan_json);
  const rounds = getRounds(taskId);
  const reviewed = [...rounds].reverse().find((r) => r.verdict || r.verify) ?? null;
  const criteria = plan?.criteria?.length ? plan.criteria : reviewed?.verdict?.criteria.map((c) => c.criterion) ?? [];
  const { byCriterion, other } = linkTests(criteria, plan?.testPlan ?? []);
  const rows = criteria.map((criterion, i): TraceRow => {
    const c = reviewed?.verdict ? matchCriterion(criterion, i, criteria.length, reviewed.verdict.criteria) : undefined;
    const testers = (reviewed?.verify?.testers ?? []).flatMap((t) => {
      const found = t.report ? matchCriterion(criterion, i, criteria.length, t.report.criteria) : undefined;
      return found ? [{ who: t.kind === 'api' ? 'App tester' as const : 'Page tester' as const, result: found.result, evidence: clean(found.evidence) }] : [];
    });
    return { criterion: clean(criterion), tests: byCriterion[i]!.map(clean), checker: c ? { met: c.met, evidence: clean(c.evidence) } : null, testers };
  });
  return { round: reviewed?.round ?? null, rows, otherTests: other.map(clean) };
}
