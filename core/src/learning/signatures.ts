/**
 * Failure signatures: a short, stable key for "the same thing went wrong", read from a
 * stored round. Numbers, hashes, quotes and paths are taken out of a failing test's first
 * line, so a rerun of the same failure gets the same key. Core proposes factual lessons
 * from signatures that repeat, and a lesson whose signature comes back counts as not helping.
 */

import type { Round } from '../pipeline/rounds.js';

/** The owner sent passed work back: the signature of a task the owner was not happy with. */
export const OWNER_SENT_BACK = 'owner:sent-back';

const SIGNATURE_CHARS = 100;

/** The first line of a failure, with what changes from run to run taken out. */
export function failureKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/(?:[a-z]:)?(?:[\w.-]*\/)+[\w.-]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d+(\.\d+)?/g, '<n>')
    .replace(/(["'`]).*?\1/g, '<s>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, SIGNATURE_CHARS);
}

/** Every signature of a round that did not pass, one per kind of problem. */
export function signaturesOfRound(round: Pick<Round, 'checks' | 'flags' | 'verdict' | 'verify' | 'outcome'>): string[] {
  if (round.outcome === 'passed') return [];
  const out = new Set<string>();
  for (const c of round.checks) {
    if (c.status === 'failed') {
      const first = c.newFailures?.[0] ?? c.failures?.[0];
      out.add(first ? `check:${c.name}:${failureKey(first)}` : `check:${c.name}`);
    } else if (c.status === 'timeout') {
      out.add(`check:${c.name}:timeout`);
    }
  }
  for (const f of round.flags) if (f.severity === 'blocking') out.add(`flag:${f.kind}`);
  if (round.verdict?.verdict === 'fail') {
    if (round.verdict.criteria.some((c) => !c.met)) out.add('checker:criterion-not-met');
    if (round.verdict.issues.some((i) => i.severity === 'blocking')) out.add('checker:blocking-issue');
  }
  if (round.verify?.status === 'failed') out.add(round.verify.startFailure ? 'verify:did-not-start' : 'verify:tester-found-problem');
  return [...out];
}
