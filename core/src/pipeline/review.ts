/**
 * Review data and wording — the plan, the tester's verdict, what a round decided, and
 * the text sent to the tester and back to the coder. No I/O apart from writing the
 * tester's brief; the pipeline does the rest.
 */

import fs from 'fs';
import path from 'path';
import { isBlocking, type CheckResult } from './checks.js';
import { hasBlockingFlag, type DiffFlag } from './diffFlags.js';

// ─── Plan ─────────────────────────────────────────────────────────────────────

export interface Plan {
  summary: string;
  approach: string;
  flow: Array<{ step: string; detail: string }>;
  files: string[];
  criteria: string[];
  testPlan: string[];
  risks: string[];
  questions: string[];
}

const strings = { type: 'array', items: { type: 'string' } } as const;

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'approach', 'flow', 'files', 'criteria', 'testPlan', 'risks', 'questions'],
  properties: {
    summary: { type: 'string' },
    approach: { type: 'string' },
    flow: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['step', 'detail'],
        properties: { step: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    files: strings,
    criteria: strings,
    testPlan: strings,
    risks: strings,
    questions: strings,
  },
} as const;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function parsePlan(json: string | null): Plan | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    const flow = p['flow'];
    if (typeof p['summary'] !== 'string' || typeof p['approach'] !== 'string') return null;
    if (!Array.isArray(flow) || !flow.every((f) => f && typeof f.step === 'string' && typeof f.detail === 'string')) return null;
    for (const key of ['files', 'criteria', 'testPlan', 'risks', 'questions']) if (!isStringArray(p[key])) return null;
    if ((p['criteria'] as string[]).length === 0) return null;
    return p as unknown as Plan;
  } catch {
    return null;
  }
}

// ─── Verdict ──────────────────────────────────────────────────────────────────

export interface Verdict {
  verdict: 'pass' | 'fail';
  summary: string;
  criteria: Array<{ criterion: string; met: boolean; evidence: string }>;
  issues: Array<{ severity: 'blocking' | 'minor'; file: string; description: string }>;
}

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'criteria', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    summary: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'met', 'evidence'],
        properties: { criterion: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'description'],
        properties: {
          severity: { type: 'string', enum: ['blocking', 'minor'] },
          file: { type: 'string' },
          description: { type: 'string' },
        },
      },
    },
  },
} as const;

export function parseVerdict(json: string | null): Verdict | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v['verdict'] !== 'pass' && v['verdict'] !== 'fail') return null;
    if (typeof v['summary'] !== 'string' || !Array.isArray(v['criteria']) || !Array.isArray(v['issues'])) return null;
    if (!v['criteria'].every((c) => c && typeof c.criterion === 'string' && typeof c.met === 'boolean' && typeof c.evidence === 'string')) return null;
    if (!v['issues'].every((i) => i && (i.severity === 'blocking' || i.severity === 'minor') && typeof i.description === 'string')) return null;
    return v as unknown as Verdict;
  } catch {
    return null;
  }
}

/**
 * Whether the tester's verdict lets the change through. Stricter than the verdict word:
 * an unmet criterion or a blocking issue fails it even if the tester wrote "pass".
 */
export function verdictPasses(verdict: Verdict): boolean {
  return verdict.verdict === 'pass' && verdict.criteria.every((c) => c.met) && !verdict.issues.some((i) => i.severity === 'blocking');
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/** Checks and flags alone can send a round back; the tester is only asked when they are clean. */
export function gateBlocks(checks: CheckResult[], flags: DiffFlag[]): boolean {
  return checks.some(isBlocking) || hasBlockingFlag(flags);
}

// ─── Wording ──────────────────────────────────────────────────────────────────

const CHECK_OUTPUT_CHARS = 3500;
const tail = (text: string, max: number) => (text.length > max ? `[earlier output cut]\n${text.slice(-max)}` : text);

function checkLine(c: CheckResult): string {
  const how = c.status === 'timeout' ? 'timed out' : `exit ${c.exitCode}`;
  const label: Record<CheckResult['status'], string> = {
    passed: 'passed',
    failed: `FAILED (${how})`,
    timeout: 'FAILED (timed out)',
    error: 'COULD NOT BE RUN (the sandbox did not start; this is a problem with the machine, not with the change)',
    preexisting:
      c.comparedBy === 'failures'
        ? `fails (${how}), with the same ${c.failures?.length ?? 0} failure${c.failures?.length === 1 ? '' : 's'} it had before this task — none are new`
        : `fails, but it already failed before this task (${how}); new failures could not be told apart from old ones`,
  };
  const fresh = c.status === 'failed' && c.newFailures?.length
    ? ` — ${c.newFailures.length} failure${c.newFailures.length === 1 ? '' : 's'} not present before this task`
    : '';
  return `- ${c.name} — \`${c.cmd}\`: ${label[c.status]}${fresh}`;
}

/** What the coder is told when a round is sent back. */
export function coderFeedback(round: number, checks: CheckResult[], flags: DiffFlag[], verdict: Verdict | null): string {
  const parts = [`The review of round ${round} found problems. Fix them in this same workspace, then finish with your report.`];

  const failing = checks.filter(isBlocking);
  if (failing.length > 0) {
    parts.push('## Checks that fail\n\nFryday ran these on your committed change. They must pass.');
    for (const c of failing) {
      // On a repo that was already red, name exactly what this task broke.
      const fresh = c.newFailures?.length
        ? `\n\nNew with your change (these did not fail before):\n${c.newFailures.slice(0, 40).map((f) => `- ${f}`).join('\n')}\n\nOther failures in the output were already there; leave them alone.`
        : '';
      parts.push(`${checkLine(c)}${fresh}\n\n\`\`\`\n${tail(c.output.trim(), CHECK_OUTPUT_CHARS)}\n\`\`\``);
    }
  }

  const blocking = flags.filter((f) => f.severity === 'blocking');
  if (blocking.length > 0) {
    parts.push(
      '## Changes that are not allowed\n\nTests may not be deleted, skipped or focused to get a pass. Restore them and fix the code instead.\n\n' +
        blocking.map((f) => `- ${f.path}: ${f.detail}`).join('\n')
    );
  }

  if (verdict) {
    const unmet = verdict.criteria.filter((c) => !c.met);
    const issues = verdict.issues;
    if (unmet.length > 0) parts.push('## Acceptance criteria not met\n\n' + unmet.map((c) => `- ${c.criterion}\n  ${c.evidence}`).join('\n'));
    if (issues.length > 0) {
      parts.push("## Tester's findings\n\n" + issues.map((i) => `- [${i.severity}]${i.file ? ` ${i.file}:` : ''} ${i.description}`).join('\n'));
    }
  }
  return parts.join('\n\n');
}

/** One line for the owner on why a round was sent back or escalated. */
export function roundSummary(checks: CheckResult[], flags: DiffFlag[], verdict: Verdict | null): string {
  const reasons: string[] = [];
  const failing = checks.filter(isBlocking).map((c) => c.name);
  if (failing.length > 0) reasons.push(`failing checks: ${failing.join(', ')}`);
  const blocking = flags.filter((f) => f.severity === 'blocking');
  if (blocking.length > 0) reasons.push(blocking.map((f) => `${f.detail.split(':')[0]} (${f.path})`).join('; '));
  if (verdict && !verdictPasses(verdict)) {
    const n = verdict.issues.filter((i) => i.severity === 'blocking').length;
    const unmet = verdict.criteria.filter((c) => !c.met).length;
    reasons.push(`tester: ${[n ? `${n} blocking issue${n === 1 ? '' : 's'}` : '', unmet ? `${unmet} unmet criteri${unmet === 1 ? 'on' : 'a'}` : ''].filter(Boolean).join(', ') || verdict.summary}`);
  }
  return reasons.join('; ') || 'no reason recorded';
}

export interface ReviewBrief {
  taskId: string;
  title: string;
  description: string;
  round: number;
  plan: Plan | null;
  checks: CheckResult[];
  flags: DiffFlag[];
  depsNote: string;
  patch: string;
  /** What testers observed on the running service in earlier rounds, as the coder was told. */
  earlier?: Array<{ round: number; feedback: string }>;
}

const EARLIER_CHARS = 5000;
/** Quoted feedback keeps its structure but cannot look like a section of this brief. */
const demoteHeadings = (text: string) => text.replace(/^(#{1,3}) /gm, '#### ');

export const REVIEW_DIR = 'FRYDAY_REVIEW';

/** Write the tester's brief into its throwaway checkout. */
export function writeReviewBrief(checkoutPath: string, brief: ReviewBrief): void {
  const dir = path.join(checkoutPath, REVIEW_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const criteria = brief.plan?.criteria.length
    ? brief.plan.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : 'No plan was written for this task. Derive the criteria from the task description and state them in your verdict.';
  const flags = brief.flags.length
    ? brief.flags.map((f) => `- [${f.severity}] ${f.path}: ${f.detail}`).join('\n')
    : 'Nothing flagged.';
  const checks = brief.checks.length
    ? brief.checks.map(checkLine).join('\n')
    : 'This repo has no test, lint or typecheck command configured, so nothing was run. Say so in your verdict.';

  const readme = [
    `# Review brief — ${brief.taskId}, round ${brief.round}`,
    `## Task\n\n**${brief.title}**\n\n${brief.description}`,
    brief.plan ? `## Planned approach\n\n${brief.plan.summary}\n\n${brief.plan.approach}` : '',
    `## Acceptance criteria\n\n${criteria}`,
    `## Checks Fryday already ran on this change\n\n${checks}\n\nDependencies in this checkout: ${brief.depsNote}`,
    `## Flagged in the diff\n\n${flags}`,
    brief.earlier?.length
      ? '## What testers saw in earlier rounds\n\nThis is history, from earlier commits of this task: what a tester observed when the service was started and used, and sent back to the Coder. It is not about the commit you are reviewing. The checks above are the only results for this commit. Where it quotes an observed fact (a response, a value read from a database), the Coder was right to act on it even if the task text does not say it. Check that each point is dealt with in this change.\n\n' +
        brief.earlier.map((e) => `### Round ${e.round} (an earlier commit)\n\n${tail(demoteHeadings(e.feedback), EARLIER_CHARS)}`).join('\n\n')
      : '',
    '## The change\n\nSee `diff.patch` in this folder.',
  ].filter(Boolean).join('\n\n');

  fs.writeFileSync(path.join(dir, 'README.md'), `${readme}\n`);
  fs.writeFileSync(path.join(dir, 'diff.patch'), `${brief.patch}\n`);
}
