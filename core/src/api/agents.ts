/**
 * Agents API — live view of running agent processes.
 * GET  /api/agents          — list all runs (active + recent)
 * GET  /api/agents/:runId/activity — what the agent did, newest last (tools it called, what it said)
 * POST /api/agents/:runId/kill  — kill a run
 * GET  /api/agents/roles         — one lane per agent: its live runs, its last 20, its scorecard
 * GET  /api/agents/analytics     — tokens and time per stage and per project (?days=30)
 * GET  /api/agents/:runId/timeline?cursor= — a page of the run's steps
 * GET  /api/agents/:runId/summary — files, commands, report, structured answer, and the round's diff for a Builder run
 */

import fs from 'fs';
import { Router } from 'express';
import { getDb } from '../db/db.js';
import { killRun, activeRunIds } from '../runner/supervisor.js';
import { countedTokens, getRunUsage } from '../runner/usage.js';
import { recentActivity, shortenPaths } from '../runner/runEvents.js';
import { runTimeline, summarizeRunLog, toolLabel } from '../runner/runTimeline.js';
import { LANE_ROLES, costAnalytics, scorecards } from '../runner/scorecard.js';
import { ACTOR_NAME, actorOfRole } from '../pipeline/plainWords.js';
import { git } from '../pipeline/worktrees.js';
import { redactSecrets } from '../secretPatterns.js';

export const agentsRouter = Router();

agentsRouter.get('/', (_req, res) => {
  const db = getDb();
  const activeIds = new Set(activeRunIds());

  const runs = db
    .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT 100`)
    .all() as Array<{ id: string } & Record<string, unknown>>;

  // A run whose result has arrived is done, even while its process is still winding down.
  const result = runs.map((r) => {
    const active = r['state'] === 'running' && activeIds.has(r.id);
    return {
      ...r,
      is_active: active,
      usage: getRunUsage(r.id),
      // For a running agent, what it is doing now.
      last: active && typeof r['log_path'] === 'string' ? recentActivity(r['log_path'], 1).at(-1) ?? null : null,
    };
  });

  res.json({ agents: result, active_count: result.filter((r) => r.is_active).length });
});

agentsRouter.get('/:runId/activity', (req, res) => {
  const run = getDb().prepare('SELECT log_path FROM runs WHERE id = ?').get(req.params['runId']) as { log_path: string } | undefined;
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  const max = Math.min(Math.max(parseInt(String(req.query['max'] ?? '40'), 10) || 40, 1), 200);
  res.json({ activity: recentActivity(run.log_path, max) });
});

agentsRouter.post('/:runId/kill', (req, res) => {
  const { runId } = req.params;
  const db = getDb();
  const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json({ ok: true, stopped: killRun(runId) });
});

// ─── Agents page: lanes, a run's steps and summary, scorecards, where tokens went ───────────

interface LaneRunRow {
  id: string; task_id: string | null; role: string; state: string; round: number; started_at: number; ended_at: number | null;
  token_limit: number | null; log_path: string; title: string | null;
}

const laneRun = (r: LaneRunRow) => ({
  runId: r.id, taskId: r.task_id, taskTitle: r.title, state: r.state, round: r.round,
  startedAt: r.started_at, endedAt: r.ended_at, tokens: countedTokens(getRunUsage(r.id)), limit: r.token_limit,
});

/** What a live run is doing now, in a few words, cleaned. */
function nowStep(logPath: string): { tool: string | null; hint: string; text: string } | null {
  const last = recentActivity(logPath, 1).at(-1);
  if (!last || last.kind !== 'assistant') return null;
  const tool = last.tools.at(-1) ?? null;
  return { tool: tool ? toolLabel(tool) : null, hint: redactSecrets(last.toolInputs.at(-1) ?? ''), text: redactSecrets(shortenPaths(last.text)).slice(0, 280) };
}

agentsRouter.get('/roles', (_req, res) => {
  const db = getDb();
  const active = new Set(activeRunIds());
  const cards = new Map(scorecards().map((s) => [s.role, s]));
  const select = `SELECT r.id, r.task_id, r.role, r.state, r.round, r.started_at, r.ended_at, r.token_limit, r.log_path, t.title
    FROM runs r LEFT JOIN tasks t ON t.id = r.task_id`;
  const lanes = LANE_ROLES.map((role) => {
    const roles = role === 'fryday' ? ['fryday', 'system'] : [role];
    const marks = roles.map(() => '?').join(', ');
    const live = (db.prepare(`${select} WHERE r.role IN (${marks}) AND r.state = 'running' ORDER BY r.started_at`).all(...roles) as LaneRunRow[])
      .filter((r) => active.has(r.id))
      .map((r) => ({ ...laneRun(r), now: nowStep(r.log_path) }));
    const recent = (db.prepare(`${select} WHERE r.role IN (${marks}) AND r.state != 'running' ORDER BY r.started_at DESC LIMIT 20`).all(...roles) as LaneRunRow[]).map(laneRun);
    return { role, who: ACTOR_NAME[actorOfRole(role)], live, recent, scorecard: cards.get(role) ?? null };
  });
  res.json({ lanes });
});

agentsRouter.get('/analytics', (req, res) => {
  const days = Math.min(Math.max(parseInt(String(req.query['days'] ?? '30'), 10) || 30, 1), 365);
  res.json(costAnalytics(days));
});

interface RunRow {
  id: string; task_id: string | null; role: string; state: string; round: number; model: string | null; log_path: string;
  result_text: string | null; output_json: string | null; token_limit: number | null; started_at: number; ended_at: number | null;
  error_msg: string | null; title: string | null;
}

const runRow = (id: string) => getDb()
  .prepare('SELECT r.*, t.title FROM runs r LEFT JOIN tasks t ON t.id = r.task_id WHERE r.id = ?')
  .get(id) as RunRow | undefined;

agentsRouter.get('/:runId/timeline', (req, res) => {
  const run = runRow(req.params['runId']!);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  const cursor = Math.max(parseInt(String(req.query['cursor'] ?? '0'), 10) || 0, 0);
  const limit = Math.min(Math.max(parseInt(String(req.query['limit'] ?? '100'), 10) || 100, 1), 500);
  const live = run.state === 'running' && activeRunIds().includes(run.id);
  res.json({ ...runTimeline(run.log_path, cursor, limit, live), live });
});

const REPORT_CHARS = 20_000;
const DIFF_CHARS = 200_000;

/** The structured answer of a run, cleaned; null when there is none or it does not parse. */
function cleanOutput(json: string | null): unknown {
  if (!json) return null;
  try { return JSON.parse(redactSecrets(shortenPaths(json))); } catch { return null; }
}

/** What the Builder's round changed: from the previous round's commit (or the base) to this round's. */
function roundDiff(taskId: string, round: number): { patch: string | null; note: string | null } {
  const db = getDb();
  const ws = db.prepare('SELECT repo_path, worktree_path, base_sha, removed_at FROM task_workspaces WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(taskId) as { repo_path: string; worktree_path: string; base_sha: string; removed_at: number | null } | undefined;
  if (!ws) return { patch: null, note: 'This task has no workspace.' };
  const head = (r: number) => (db.prepare('SELECT head_sha FROM task_rounds WHERE task_id = ? AND round = ?').get(taskId, r) as { head_sha: string | null } | undefined)?.head_sha ?? null;
  const to = head(round);
  if (!to) return { patch: null, note: 'No commit for this round yet.' };
  const from = round > 1 ? head(round - 1) ?? ws.base_sha : ws.base_sha;
  const where = !ws.removed_at && fs.existsSync(ws.worktree_path) ? ws.worktree_path : ws.repo_path;
  try {
    const patch = redactSecrets(git(where, ['diff', '-U3', `${from}..${to}`]));
    return patch.length > DIFF_CHARS
      ? { patch: patch.slice(0, DIFF_CHARS), note: 'The diff is long; the first part is shown.' }
      : { patch, note: patch ? null : 'The round changed nothing.' };
  } catch {
    return { patch: null, note: 'The commits of this round are no longer there (the workspace was discarded).' };
  }
}

agentsRouter.get('/:runId/summary', (req, res) => {
  const run = runRow(req.params['runId']!);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  const log = summarizeRunLog(run.log_path);
  const report = run.result_text ? redactSecrets(shortenPaths(run.result_text)) : null;
  const diff = run.role === 'coder' && run.task_id && run.round > 0 ? roundDiff(run.task_id, run.round) : null;
  res.json({
    run: {
      runId: run.id, role: run.role, who: ACTOR_NAME[actorOfRole(run.role)], state: run.state, round: run.round, model: run.model,
      taskId: run.task_id, taskTitle: run.title, startedAt: run.started_at, endedAt: run.ended_at,
      tokens: countedTokens(getRunUsage(run.id)), limit: run.token_limit,
      error: run.error_msg ? redactSecrets(shortenPaths(run.error_msg)) : null,
    },
    filesEdited: log.filesEdited,
    filesRead: log.filesRead,
    commands: log.commands,
    mcpCalls: log.mcpCalls,
    steps: log.steps,
    report: report && report.length > REPORT_CHARS ? `${report.slice(0, REPORT_CHARS)}…` : report,
    output: cleanOutput(run.output_json),
    diff,
  });
});
