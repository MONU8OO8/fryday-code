/**
 * Agents API — live view of running agent processes.
 * GET  /api/agents          — list all runs (active + recent)
 * GET  /api/agents/:runId/activity — what the agent did, newest last (tools it called, what it said)
 * POST /api/agents/:runId/kill  — kill a run
 */

import { Router } from 'express';
import { getDb } from '../db/db.js';
import { killRun, activeRunIds } from '../runner/supervisor.js';
import { getRunUsage } from '../runner/usage.js';
import { recentActivity } from '../runner/runEvents.js';

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
