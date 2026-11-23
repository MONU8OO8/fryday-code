/**
 * What the agent monitor reads from core: lanes (core/src/api/agents.ts), a run's steps
 * (core/src/runner/runTimeline.ts), scorecards and cost (core/src/runner/scorecard.ts),
 * and a task's traceability table (core/src/pipeline/traceability.ts).
 */

export type StepKind = 'read' | 'search' | 'edit' | 'command' | 'mcp' | 'web' | 'message' | 'other' | 'finished';

export interface TimelineStep {
  /** Stable across pages; the same step may come again with its result filled in. */
  id: string;
  at: number | null;
  kind: StepKind;
  tool: string | null;
  hint: string;
  text?: string;
  ok?: boolean;
  exitCode?: number;
}

export interface TimelinePage { steps: TimelineStep[]; cursor: number; more: boolean; live: boolean }

export interface RoleScore {
  runs: number;
  tasks: number;
  stops: { timeout: number; budget: number; failed: number };
  tokensPerTask: number | null;
  minutesPerRun: number | null;
  firstRoundPassRate?: number | null;
  roundsToPass?: number | null;
  selfCheckAccuracy?: number | null;
  overconfidentClaims?: number;
  lessonTrend?: { withLessons: { tasks: number; firstRoundPassRate: number | null }; without: { tasks: number; firstRoundPassRate: number | null } };
  failureCauses?: Array<{ cause: string; count: number; example?: string }>;
  passRate?: number | null;
}

export interface Scorecard { role: string; week: RoleScore; month: RoleScore }

export interface LaneRun {
  runId: string;
  taskId: string | null;
  taskTitle: string | null;
  state: string;
  round: number;
  startedAt: number;
  endedAt: number | null;
  tokens: number;
  limit: number | null;
  now?: { tool: string | null; hint: string; text: string } | null;
}

export interface Lane { role: string; who: string; live: LaneRun[]; recent: LaneRun[]; scorecard: Scorecard | null }

export interface RunSummary {
  run: {
    runId: string; role: string; who: string; state: string; round: number; model: string | null;
    taskId: string | null; taskTitle: string | null; startedAt: number; endedAt: number | null;
    tokens: number; limit: number | null; error: string | null;
  };
  filesEdited: string[];
  filesRead: number;
  commands: Array<{ hint: string; exitCode: number | null }>;
  mcpCalls: number;
  steps: number;
  report: string | null;
  output: unknown;
  diff: { patch: string | null; note: string | null } | null;
}

export interface CostRow { key: string; tokens: number; reusedTokens: number; minutes: number; runs: number }
export interface CostAnalytics { days: number; byStage: CostRow[]; byProject: CostRow[] }

export interface TraceRow {
  criterion: string;
  tests: string[];
  checker: { met: boolean; evidence: string } | null;
  testers: Array<{ who: 'App tester' | 'Page tester'; result: 'met' | 'not_met' | 'not_checked'; evidence: string }>;
}
export interface Traceability { round: number | null; rows: TraceRow[]; otherTests: string[] }

export const RUN_STATE: Record<string, { label: string; tone: 'ok' | 'bad' | 'warn' | 'neutral' }> = {
  completed: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  killed: { label: 'Stopped', tone: 'warn' },
  budget: { label: 'Token limit', tone: 'warn' },
  timeout: { label: 'Time limit', tone: 'bad' },
  running: { label: 'Working', tone: 'neutral' },
};
