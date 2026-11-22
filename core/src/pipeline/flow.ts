/**
 * A task's flow: who has the task now, who had it before, and every hand-off and
 * send-back between them, with what each agent used. The UI draws it; nothing here
 * decides anything.
 *
 * Built only from stored facts (runs, review rounds, questions, approvals, releases), so
 * it is the same after a restart and the same for every viewer. buildFlow() is pure;
 * taskFlow() loads what it needs.
 */

import { getDb } from '../db/db.js';
import { getRepo } from '../registry/registry.js';
import { getTask, taskTokenLimit } from './taskState.js';
import { getRounds, type Round } from './rounds.js';
import { countedTokens, getRunUsage, type RunUsageSummary } from '../runner/usage.js';
import { parseRunProfile } from '../verify/profile.js';
import { verdictPasses } from './review.js';
import { isBlocking } from './checks.js';
import { hasBlockingFlag } from './diffFlags.js';

export type FlowNodeId = 'analyst' | 'planner' | 'coder' | 'checks' | 'reviewer' | 'api_tester' | 'ui_tester' | 'owner' | 'release' | 'deploy';

/**
 * idle     not reached yet
 * active   working on the task right now
 * waiting  the task waits here (the owner's answer or approval)
 * done     did its part
 * failed   its last turn did not let the change through (it sent the task back, or failed)
 * skipped  not part of this task (no run profile for a tester, no staging branch)
 */
export type FlowNodeState = 'idle' | 'active' | 'waiting' | 'done' | 'failed' | 'skipped';

export interface FlowNode {
  id: FlowNodeId;
  label: string;
  kind: 'agent' | 'core' | 'owner';
  state: FlowNodeState;
  /** One short line about its latest turn: "round 2", "2 blocking", "7 requests". */
  detail: string;
  /** Agent runs it had on this task. */
  runs: number;
  /** Its run that is going now, if any. */
  liveRunId: string | null;
  usage: RunUsageSummary;
}

export interface FlowEdge {
  from: FlowNodeId;
  to: FlowNodeId;
  /** handoff: work moves on. sendback: something failed and the coder gets it again. */
  kind: 'handoff' | 'sendback';
  at: number;
  round: number | null;
}

export interface TaskFlow {
  nodes: FlowNode[];
  /** Every move, oldest first. The last one is how the task got where it is. */
  edges: FlowEdge[];
  /** Where the task is now, and since when. */
  current: { node: FlowNodeId; since: number } | null;
  budget: { limitTokens: number; usedTokens: number };
}

export const FLOW_ORDER: FlowNodeId[] = ['analyst', 'planner', 'coder', 'checks', 'reviewer', 'api_tester', 'ui_tester', 'owner', 'release', 'deploy'];

const LABELS: Record<FlowNodeId, { label: string; kind: FlowNode['kind'] }> = {
  analyst: { label: 'Analyst', kind: 'agent' },
  planner: { label: 'Planner', kind: 'agent' },
  coder: { label: 'Coder', kind: 'agent' },
  checks: { label: 'Checks', kind: 'core' },
  reviewer: { label: 'Reviewer', kind: 'agent' },
  api_tester: { label: 'API tester', kind: 'agent' },
  ui_tester: { label: 'UI tester', kind: 'agent' },
  owner: { label: 'You', kind: 'owner' },
  release: { label: 'Release', kind: 'core' },
  deploy: { label: 'Deploy', kind: 'core' },
};

/** Which node an agent role is drawn as. */
export const NODE_OF_ROLE: Record<string, FlowNodeId> = {
  analyst: 'analyst', planner: 'planner', coder: 'coder', tester: 'reviewer', api_tester: 'api_tester', ui_tester: 'ui_tester',
};

export interface FlowRun {
  id: string;
  role: string;
  round: number;
  state: string;
  started_at: number;
  ended_at: number | null;
  tools_json: string | null;
}

export interface FlowInput {
  taskState: string;
  /** When the task last changed state: the time of a move core made between agents. */
  taskUpdatedAt: number;
  runs: FlowRun[];
  rounds: Array<Round & { createdAt: number }>;
  questions: Array<{ askedAt: number; answeredAt: number | null }>;
  approvals: Array<{ action: string; state: string; requestedAt: number; resolvedAt: number | null }>;
  release: { state: string; startedAt: number } | null;
  /** The latest staging deploy, when the project has a deployer. */
  deploy: { state: string; outcome: string | null; startedAt: number; build: number | null } | null;
  hasDeployer: boolean;
  /** Which testers the project's run profile asks for. */
  testers: { api: boolean; ui: boolean };
  hasStaging: boolean;
  usageOf: (runId: string) => RunUsageSummary;
  budget: { limitTokens: number; usedTokens: number };
}

interface Step {
  node: FlowNodeId;
  at: number;
  round: number | null;
}

const zero = (): RunUsageSummary => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const SENT_BACK_BY = new Set<FlowNodeId>(['checks', 'reviewer', 'api_tester', 'ui_tester']);

/** Whether a round's gate (checks and diff flags) let the change through. */
function gatePassed(r: Round): boolean {
  return !r.checks.some(isBlocking) && !hasBlockingFlag(r.flags);
}

export function buildFlow(input: FlowInput): TaskFlow {
  const runs = [...input.runs].sort((a, b) => a.started_at - b.started_at);

  // ─── What happened, in order ───────────────────────────────────────────────
  const steps: Step[] = [];
  for (const run of runs) {
    const node = NODE_OF_ROLE[run.role];
    if (node) steps.push({ node, at: run.started_at, round: run.round || null });
  }
  for (const r of input.rounds) steps.push({ node: 'checks', at: r.createdAt, round: r.round });
  for (const q of input.questions) steps.push({ node: 'owner', at: q.askedAt, round: null });
  for (const a of input.approvals) steps.push({ node: 'owner', at: a.requestedAt, round: null });
  if (input.release) steps.push({ node: 'release', at: input.release.startedAt, round: null });
  if (input.deploy) steps.push({ node: 'deploy', at: input.deploy.startedAt, round: null });
  steps.sort((a, b) => a.at - b.at || FLOW_ORDER.indexOf(a.node) - FLOW_ORDER.indexOf(b.node));

  // Repeats of the same node in a row are one turn (an Analyst that ran twice, two questions at once).
  const turns = steps.filter((s, i) => i === 0 || steps[i - 1]!.node !== s.node);
  const edges: FlowEdge[] = [];
  for (let i = 1; i < turns.length; i++) {
    const from = turns[i - 1]!.node;
    const to = turns[i]!.node;
    const sendback = to === 'coder' && SENT_BACK_BY.has(from);
    // A send-back is about the round that failed; a hand-off about the round it starts.
    const round = sendback ? turns[i - 1]!.round ?? turns[i]!.round : turns[i]!.round ?? turns[i - 1]!.round;
    edges.push({ from, to, kind: sendback ? 'sendback' : 'handoff', at: turns[i]!.at, round });
  }

  // ─── Where it is now ───────────────────────────────────────────────────────
  const live = runs.filter((r) => r.state === 'running');
  const liveNode = live.length ? NODE_OF_ROLE[live[live.length - 1]!.role] ?? null : null;
  const s = input.taskState;
  const currentNode: FlowNodeId | null =
    liveNode
    ?? (s === 'waiting_owner' || s === 'awaiting_approval' || s === 'needs_owner' ? 'owner'
      : s === 'releasing' ? 'release'
      : s === 'deploying' ? 'deploy'
      : s === 'testing' ? 'checks'
      : s === 'verifying' ? (input.testers.api ? 'api_tester' : 'ui_tester')
      : s === 'workspace' ? 'planner'
      : s === 'intake' ? 'analyst'
      : s === 'planning' ? 'planner'
      : s === 'coding' ? 'coder'
      : null);
  // If the task's place is not the last turn recorded (core is between steps), the move to it is the latest edge.
  const last = turns[turns.length - 1];
  if (currentNode && last && last.node !== currentNode && !['deployed', 'failed'].includes(s)) {
    const sendback = currentNode === 'coder' && SENT_BACK_BY.has(last.node);
    // Stored, not "now": the same answer on every refresh, so the view does not restart its clock.
    edges.push({ from: last.node, to: currentNode, kind: sendback ? 'sendback' : 'handoff', at: Math.max(input.taskUpdatedAt, last.at), round: last.round });
  }
  const since = edges.length ? edges[edges.length - 1]!.at : runs[0]?.started_at ?? 0;

  // ─── Each node ─────────────────────────────────────────────────────────────
  const lastRound = input.rounds[input.rounds.length - 1];
  const nodes: FlowNode[] = FLOW_ORDER.map((id) => {
    const mine = runs.filter((r) => NODE_OF_ROLE[r.role] === id);
    const usage = mine.reduce((sum, r) => {
      const u = input.usageOf(r.id);
      return {
        inputTokens: sum.inputTokens + u.inputTokens, outputTokens: sum.outputTokens + u.outputTokens,
        cacheReadTokens: sum.cacheReadTokens + u.cacheReadTokens, cacheWriteTokens: sum.cacheWriteTokens + u.cacheWriteTokens,
        costUsd: sum.costUsd + u.costUsd,
      };
    }, zero());
    const liveRun = mine.filter((r) => r.state === 'running').at(-1) ?? null;
    const reached = turns.some((t) => t.node === id);
    let state: FlowNodeState = reached ? 'done' : 'idle';
    let detail = '';

    const lastRun = mine.at(-1);
    if (lastRun && ['failed', 'killed', 'timeout', 'budget'].includes(lastRun.state)) {
      state = 'failed';
      detail = lastRun.state === 'budget' ? 'token limit' : lastRun.state === 'timeout' ? 'time limit' : lastRun.state === 'killed' ? 'stopped' : 'failed';
    }

    switch (id) {
      case 'analyst':
        if (reached && !detail) detail = mine.length > 1 ? `${mine.length} passes` : 'brief written';
        break;
      case 'planner':
        if (reached && !detail) detail = 'plan written';
        break;
      case 'coder':
        if (lastRun && !detail) detail = `round ${Math.max(lastRun.round, 1)}`;
        break;
      case 'checks':
        if (lastRound) {
          const passed = gatePassed(lastRound);
          state = passed ? 'done' : 'failed';
          const n = lastRound.checks.length;
          detail = n === 0 ? 'none configured' : passed ? `${plural(n, 'check')} green` : `${lastRound.checks.filter(isBlocking).length || 'flag'} blocking`;
        }
        break;
      case 'reviewer': {
        const reviewed = [...input.rounds].reverse().find((r) => r.verdict);
        if (reviewed?.verdict && !(lastRun && ['failed', 'killed', 'timeout', 'budget'].includes(lastRun.state))) {
          const ok = verdictPasses(reviewed.verdict);
          state = ok ? 'done' : 'failed';
          const blocking = reviewed.verdict.issues.filter((i) => i.severity === 'blocking').length;
          detail = ok ? 'pass' : blocking ? `${blocking} blocking` : 'fail';
        }
        break;
      }
      case 'api_tester':
      case 'ui_tester': {
        const kind = id === 'api_tester' ? 'api' : 'ui';
        if (!input.testers[kind] && mine.length === 0) { state = 'skipped'; detail = 'not in run profile'; break; }
        const verified = [...input.rounds].reverse().find((r) => r.verify?.testers.some((t) => t.kind === kind));
        const record = verified?.verify?.testers.filter((t) => t.kind === kind).at(-1);
        if (record && !(lastRun && ['failed', 'killed', 'timeout', 'budget'].includes(lastRun.state))) {
          state = record.passed ? 'done' : 'failed';
          detail = plural(record.calls, kind === 'api' ? 'request' : 'browser step');
        }
        break;
      }
      case 'owner': {
        const open = input.questions.filter((q) => q.answeredAt === null).length;
        const pending = input.approvals.filter((a) => a.state === 'pending');
        if (open) detail = plural(open, 'question');
        else if (pending.length) {
          const action = pending.at(-1)!.action;
          detail = action === 'push_branch' ? 'approve push' : action === 'continue_budget' ? 'more tokens?' : action === 'deploy_stg' ? 'approve deploy' : action === 'deploy_input' ? 'Jenkins asks' : 'approve release';
        }
        else if (s === 'needs_owner') detail = 'needs you';
        else if (s === 'awaiting_approval') detail = 'ready for you';
        else if (reached) detail = 'answered';
        break;
      }
      case 'release':
        if (!input.hasStaging && !input.release) { state = 'skipped'; detail = 'no staging branch'; break; }
        if (input.release) {
          state = input.release.state === 'pushed' ? 'done' : input.release.state === 'running' ? 'active' : input.release.state === 'reverted' ? 'done' : 'failed';
          detail = input.release.state === 'pushed' ? 'on staging' : input.release.state;
        }
        break;
      case 'deploy': {
        const d = input.deploy;
        if (!input.hasDeployer && !d) { state = 'skipped'; detail = 'no deployer'; break; }
        if (!d) break;
        const OUTCOME: Record<string, string> = {
          deployed: 'deployed', build_failed: 'build failed', wrong_commit: 'wrong commit', unconfirmed: 'not confirmed', cancelled: 'cancelled',
          production_prompt: 'needs a person', timeout: 'time limit', error: 'error', interrupted: 'interrupted', declined: 'declined',
        };
        state = d.state === 'succeeded' ? 'done' : ['failed', 'stopped'].includes(d.state) ? 'failed' : 'active';
        detail = d.outcome ? OUTCOME[d.outcome] ?? d.outcome : d.state === 'waiting_input' ? 'asks you' : d.build ? `build #${d.build}` : 'queued';
        break;
      }
    }

    if (id === currentNode && !['deployed', 'failed'].includes(s)) {
      state = id === 'owner' ? 'waiting' : 'active';
    }
    return { id, ...LABELS[id], state, detail, runs: mine.length, liveRunId: liveRun?.id ?? null, usage };
  });

  return {
    nodes,
    edges,
    current: currentNode && !['deployed', 'failed'].includes(s) ? { node: currentNode, since } : null,
    budget: input.budget,
  };
}

// ─── Loading ──────────────────────────────────────────────────────────────────

export function taskFlow(taskId: string): TaskFlow | null {
  const task = getTask(taskId);
  if (!task) return null;
  const db = getDb();
  const runs = db.prepare('SELECT id, role, round, state, started_at, ended_at, tools_json FROM runs WHERE task_id = ?').all(taskId) as FlowRun[];
  const created = new Map((db.prepare('SELECT round, created_at FROM task_rounds WHERE task_id = ?').all(taskId) as Array<{ round: number; created_at: number }>).map((r) => [r.round, r.created_at]));
  const rounds = getRounds(taskId).map((r) => ({ ...r, createdAt: created.get(r.round) ?? 0 }));
  const questions = (db.prepare('SELECT asked_at, answered_at FROM task_questions WHERE task_id = ?').all(taskId) as Array<{ asked_at: number; answered_at: number | null }>)
    .map((q) => ({ askedAt: q.asked_at, answeredAt: q.answered_at }));
  const approvals = (db.prepare('SELECT action, state, requested_at, resolved_at FROM approvals WHERE task_id = ? ORDER BY requested_at').all(taskId) as Array<{ action: string; state: string; requested_at: number; resolved_at: number | null }>)
    .map((a) => ({ action: a.action, state: a.state, requestedAt: a.requested_at, resolvedAt: a.resolved_at }));
  const releaseRow = db.prepare('SELECT state, started_at FROM releases WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { state: string; started_at: number } | undefined;
  const deployRow = db.prepare('SELECT state, outcome, started_at, build_number FROM deploys WHERE task_id = ? ORDER BY started_at DESC LIMIT 1').get(taskId) as { state: string; outcome: string | null; started_at: number; build_number: number | null } | undefined;
  const repoId = (db.prepare('SELECT repo_id FROM task_workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(taskId) as { repo_id: string } | undefined)?.repo_id
    ?? (() => { try { return (JSON.parse(task.metadata_json ?? '{}') as { intake?: { repoId?: string } }).intake?.repoId ?? null; } catch { return null; } })();
  const repo = repoId ? getRepo(repoId) : undefined;
  const profile = parseRunProfile(repo?.runProfile ?? null);
  const usage = new Map<string, RunUsageSummary>();
  const usageOf = (runId: string) => {
    if (!usage.has(runId)) usage.set(runId, getRunUsage(runId));
    return usage.get(runId)!;
  };
  const used = runs.reduce((sum, r) => sum + countedTokens(usageOf(r.id)), 0);
  return buildFlow({
    taskState: task.state,
    taskUpdatedAt: task.updated_at,
    runs,
    rounds,
    questions,
    approvals,
    release: releaseRow ? { state: releaseRow.state, startedAt: releaseRow.started_at } : null,
    deploy: deployRow ? { state: deployRow.state, outcome: deployRow.outcome, startedAt: deployRow.started_at, build: deployRow.build_number } : null,
    hasDeployer: Boolean(repo?.deployer),
    testers: { api: profile?.api ?? false, ui: profile?.ui ?? false },
    hasStaging: Boolean(repo?.stgBranch),
    usageOf,
    budget: { limitTokens: taskTokenLimit(task), usedTokens: used },
  });
}

