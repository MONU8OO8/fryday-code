/**
 * Verification data and wording: what a tester reports after using the running
 * service, what is stored for the round, and the text given to testers and sent back to
 * the coder. No I/O apart from writing the testers' brief.
 */

import fs from 'fs';
import path from 'path';
import type { Plan } from '../pipeline/review.js';
import { budgetedDiff } from '../pipeline/diffBudget.js';
import { sweepBlocking, sweepFeedback, type SweepResult } from './sweep.js';

export type TesterKind = 'api' | 'ui';
export const TESTER_ROLE = { api: 'api_tester', ui: 'ui_tester' } as const;
export const TESTER_NAME = { api: 'API tester', ui: 'UI tester' } as const;

export interface VerifyReport {
  verdict: 'pass' | 'fail';
  summary: string;
  /**
   * Every acceptance criterion, in the brief's order and words.
   * not_checked: this tester has no way to observe it (the reason goes in evidence).
   */
  criteria: Array<{ criterion: string; result: 'met' | 'not_met' | 'not_checked'; evidence: string }>;
  /** Anything else found: behaviour that used to work, errors, things the criteria do not cover. */
  issues: Array<{ severity: 'blocking' | 'minor'; where: string; description: string; evidence: string }>;
  /** What the tester wanted to try and could not, and why. */
  notTested: string[];
  /**
   * Problems seen that this change did not cause (they are there without it too). Not part of the
   * verdict: core may file each as a bug card of its own (pipeline/bugs.ts).
   */
  outOfScope?: OutOfScope[];
}

export interface OutOfScope { title: string; where: string; description: string; steps: string[]; evidence: string; severity: 'blocking' | 'minor' }

const text = { type: 'string' } as const;

export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'summary', 'criteria', 'issues', 'notTested', 'outOfScope'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    summary: text,
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'result', 'evidence'],
        properties: { criterion: text, result: { type: 'string', enum: ['met', 'not_met', 'not_checked'] }, evidence: text },
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'where', 'description', 'evidence'],
        properties: { severity: { type: 'string', enum: ['blocking', 'minor'] }, where: text, description: text, evidence: text },
      },
    },
    notTested: { type: 'array', items: text },
    outOfScope: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'where', 'description', 'steps', 'evidence', 'severity'],
        properties: { title: text, where: text, description: text, steps: { type: 'array', items: text }, evidence: text, severity: { type: 'string', enum: ['blocking', 'minor'] } },
      },
    },
  },
} as const;

export function parseVerifyReport(json: string | null): VerifyReport | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    if (v['verdict'] !== 'pass' && v['verdict'] !== 'fail') return null;
    if (typeof v['summary'] !== 'string' || !Array.isArray(v['criteria']) || !Array.isArray(v['issues']) || !Array.isArray(v['notTested'])) return null;
    if (!v['criteria'].every((c) => c && typeof c.criterion === 'string' && ['met', 'not_met', 'not_checked'].includes(c.result) && typeof c.evidence === 'string')) return null;
    if (!v['issues'].every((i) => i && (i.severity === 'blocking' || i.severity === 'minor') && typeof i.description === 'string' && typeof i.evidence === 'string' && typeof i.where === 'string')) return null;
    if (!v['notTested'].every((n) => typeof n === 'string')) return null;
    // Older reports have no outOfScope; a malformed entry is dropped, never a reason to lose the report.
    const extra = Array.isArray(v['outOfScope']) ? (v['outOfScope'] as Array<Record<string, unknown>>) : [];
    v['outOfScope'] = extra.filter((o) => o && typeof o['description'] === 'string' && typeof o['where'] === 'string').map((o) => ({
      title: typeof o['title'] === 'string' ? o['title'] : '', where: o['where'] as string, description: o['description'] as string,
      steps: Array.isArray(o['steps']) ? (o['steps'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      evidence: typeof o['evidence'] === 'string' ? o['evidence'] : '', severity: o['severity'] === 'blocking' ? 'blocking' : 'minor',
    }));
    return v as unknown as VerifyReport;
  } catch {
    return null;
  }
}

/**
 * Whether a tester's report lets the change through. Stricter than its verdict word: a
 * criterion that is not met or a blocking issue fails it whatever the verdict says.
 */
export function reportPasses(report: VerifyReport): boolean {
  return report.verdict === 'pass' && !report.criteria.some((c) => c.result === 'not_met') && !report.issues.some((i) => i.severity === 'blocking');
}

// ─── What is stored for a round ───────────────────────────────────────────────

export interface TesterRecord {
  kind: TesterKind;
  runId: string;
  report: VerifyReport | null;
  /** How many times the tester really used the service (requests sent, or browser steps). */
  calls: number;
  passed: boolean;
}

export interface Verification {
  /**
   * running  in progress
   * passed   every tester that ran let the change through
   * failed   a tester found a problem, or the service does not start with the change
   * error    it could not be carried out (the service does not start even without the change, no browser, ...)
   */
  status: 'running' | 'passed' | 'failed' | 'error';
  service: { command: string; port: number; listen: 'loopback' | 'all' | 'unknown'; readyAfterMs: number } | null;
  /** Set when the service did not come up. */
  startFailure?: { reason: string; detail: string; logTail: string; alsoWithoutTheChange: boolean | null };
  testers: TesterRecord[];
  /** Data connections the API tester was given. */
  dataConnections: string[];
  /** Connections granted to the project that could not be given this time, with the reason. */
  unavailable: Array<{ name: string; why: string }>;
  /** Places the page tried to reach and was stopped. */
  refused: string[];
  /** Screenshot files kept for the owner. */
  evidence: string[];
  /** Core's own check of the visited pages at phone, tablet and desktop size (sweep.ts). */
  sweep?: SweepResult;
  note?: string;
}

export const emptyVerification = (): Verification => ({
  status: 'running', service: null, testers: [], dataConnections: [], unavailable: [], refused: [], evidence: [],
});

// ─── Wording ──────────────────────────────────────────────────────────────────

const LOG_CHARS = 3000;
const tail = (s: string, max: number) => (s.length > max ? `[earlier output cut]\n${s.slice(-max)}` : s);

function findings(record: TesterRecord): string {
  const report = record.report;
  if (!report) return '';
  const parts: string[] = [];
  const unmet = report.criteria.filter((c) => c.result === 'not_met');
  if (unmet.length > 0) parts.push('Acceptance criteria not met:\n' + unmet.map((c) => `- ${c.criterion}\n  What happened: ${c.evidence}`).join('\n'));
  if (report.issues.length > 0) {
    parts.push('Findings:\n' + report.issues.map((i) => `- [${i.severity}]${i.where ? ` ${i.where}:` : ''} ${i.description}\n  What happened: ${i.evidence}`).join('\n'));
  }
  return parts.join('\n\n');
}

/** What the coder is told when the running service showed a problem. */
export function verifyFeedback(round: number, v: Verification): string {
  const parts = [
    `Round ${round} passed the checks and the code review, but failed when the service was started and used. Fix the cause in this same workspace, then finish with your report. The evidence below is what really happened, not an opinion.`,
  ];
  if (v.startFailure) {
    parts.push(
      `## The service does not start with your change\n\n${v.startFailure.detail}\n\nIt starts without your change, so the cause is in what you changed. This is what it printed:\n\n\`\`\`\n${tail(v.startFailure.logTail.trim() || '(nothing)', LOG_CHARS)}\n\`\`\``
    );
  }
  for (const record of v.testers.filter((t) => !t.passed && t.report)) {
    parts.push(`## What the ${TESTER_NAME[record.kind]} found\n\n${record.report!.summary}\n\n${findings(record)}`);
  }
  if (v.sweep && sweepBlocking(v.sweep).length) {
    parts.push(`## The pages at phone, tablet and desktop size\n\nA page that is wider than the screen scrolls sideways on a phone: fix the layout so it fits (no fixed widths wider than the screen, wrap or stack what does not fit). The other lines are worth fixing too if your change caused them.\n\n${sweepFeedback(v.sweep)}`);
  }
  return parts.join('\n\n');
}

/** One line for the owner on what verification found. */
export function verifySummary(v: Verification): string {
  if (v.startFailure) return `the service does not start: ${v.startFailure.detail}`;
  const reasons = v.testers.filter((t) => !t.passed).map((t) => {
    if (!t.report) return `${TESTER_NAME[t.kind]}: no usable report`;
    const unmet = t.report.criteria.filter((c) => c.result === 'not_met').length;
    const blocking = t.report.issues.filter((i) => i.severity === 'blocking').length;
    const counts = [unmet ? `${unmet} criteri${unmet === 1 ? 'on' : 'a'} not met` : '', blocking ? `${blocking} blocking issue${blocking === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
    return `${TESTER_NAME[t.kind]}: ${counts || t.report.summary}`;
  });
  const sized = sweepBlocking(v.sweep);
  if (sized.length) reasons.push(`at ${[...new Set(sized.map((i) => i.device))].join(' and ')} size a page is wider than the screen`);
  return reasons.join('; ') || v.note || 'no reason recorded';
}

export const VERIFY_DIR = 'FRYDAY_VERIFY';
export const BROWSER_DIR = path.join(VERIFY_DIR, 'browser');

export interface VerifyBrief {
  kind: TesterKind;
  taskId: string;
  title: string;
  description: string;
  round: number;
  plan: Plan | null;
  patch: string;
  files: Array<{ status: string; path: string }>;
  /** The address the browser opens (UI tester only). */
  startUrl?: string;
  dataConnections: Array<{ name: string; envKind: string; tools: string[] }>;
  unavailable: Array<{ name: string; why: string }>;
  /** What verification found in an earlier round of this task; it must be fixed now. */
  earlier: string | null;
  /** What the other tester did before this one, if anything. */
  before: string | null;
  ownerNotes: string;
}

/** Write a tester's brief into its checkout. */
const TESTER_DIFF_CHARS = 10_000;

/** The change for a tester, who tries the service rather than reading code: the files, and the diff within a budget. */
function changeForTester(brief: VerifyBrief): string {
  const files = `Files changed:\n${brief.files.map((f) => `- ${f.status} ${f.path}`).join('\n')}`;
  const diff = budgetedDiff(brief.patch, TESTER_DIFF_CHARS, [brief.plan?.criteria.join('\n') ?? '', brief.earlier ?? ''].join('\n'));
  return `## The change\n\n${files}\n\n${diff.complete ? 'The whole diff' : 'The most relevant parts of the diff'} (all of it is in \`diff.patch\` in this folder):\n\n\`\`\`diff\n${diff.text}\n\`\`\``;
}

export function writeVerifyBrief(checkoutPath: string, brief: VerifyBrief): void {
  const dir = path.join(checkoutPath, VERIFY_DIR);
  fs.mkdirSync(path.join(checkoutPath, BROWSER_DIR), { recursive: true });
  const criteria = brief.plan?.criteria.length
    ? brief.plan.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : 'No plan was written for this task. Derive the criteria from the task description and state them in your report.';
  const list = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
  const data = brief.dataConnections.length
    ? brief.dataConnections.map((c) => `- \`${c.name}\` (${c.envKind} data, read-only): ${c.tools.map((t) => `\`mcp__${c.name}__${t}\``).join(', ')}`).join('\n')
    : 'None. Judge data only by what the service itself returns.';
  const missing = brief.unavailable.length
    ? `\n\nNot available this time: ${brief.unavailable.map((u) => `${u.name} (${u.why})`).join('; ')}. Say so under "notTested" if you needed one.`
    : '';
  const reach =
    brief.kind === 'api'
      ? 'The service is already running. Reach it only with the `request` tool (`mcp__fryday_service__request`): give a path such as `/api/items`. The `log` tool shows what the service printed. Your shell has no network, so `curl` and the like cannot work.'
      : `The service is already running at ${brief.startUrl}. Open it with the browser tools (\`mcp__fryday_browser__browser_navigate\` and the others). The browser can open this service and nothing else. Screenshots you take are saved under \`${BROWSER_DIR}/\`; open one with Read when you need to look at it. The \`log\` tool shows what the service printed.`;

  const readme = [
    `# Verification brief for the ${TESTER_NAME[brief.kind]} — ${brief.taskId}, round ${brief.round}`,
    `## Task\n\n**${brief.title}**\n\n${brief.description}`,
    brief.ownerNotes,
    brief.plan ? `## Planned approach\n\n${brief.plan.summary}` : '',
    `## Acceptance criteria\n\n${criteria}`,
    brief.plan?.testPlan.length ? `## Test plan from the planner\n\n${list(brief.plan.testPlan)}` : '',
    `## How to reach the service\n\n${reach}`,
    brief.kind === 'api' ? `## Data you may read\n\n${data}${missing}` : '',
    brief.earlier ? `## Found in an earlier round\n\nThese were sent back to the coder. Check first that each one is really fixed:\n\n${brief.earlier}` : '',
    brief.before ? `## Before you\n\n${brief.before}` : '',
    changeForTester(brief),
  ].filter(Boolean).join('\n\n');

  fs.writeFileSync(path.join(dir, 'README.md'), `${readme}\n`);
  fs.writeFileSync(path.join(dir, 'diff.patch'), `${brief.patch}\n`);
}

/** One phrase for an approval ticket: how the change was tried out running, or that it was not. */
export function verifiedPhrase(v: Verification | null): string {
  if (!v) return 'not tried out running (the project has no run profile)';
  if (v.status !== 'passed') return 'not verified running';
  const did = v.testers.map((t) => `${TESTER_NAME[t.kind]}: ${t.calls} ${t.kind === 'api' ? 'request' : 'browser step'}${t.calls === 1 ? '' : 's'}`).join('; ');
  return `tried out running (${did})`;
}
