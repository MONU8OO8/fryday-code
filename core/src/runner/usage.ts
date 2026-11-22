/**
 * Token accounting — deduplicates by message_id; treats `result` event as authoritative.
 *
 * Rules:
 *   - Each `assistant` event's message.id is one row per run. Claude streams the same message
 *     several times while it grows, so a repeat keeps the largest value of each counter: the
 *     live total is right, and a repeat of a finished message changes nothing.
 *   - On `--resume`, the final `result` event already includes the cumulative total.
 *   - We store both individual assistant events and the final result, but aggregate queries
 *     should SUM only assistant events OR use the single result event per run — not both.
 */

import { getDb, nowMs } from '../db/db.js';
import type { ClaudeAssistantEvent, ClaudeResultEvent } from './streamParser.js';

export interface UsageRow {
  id: string;
  run_id: string;
  task_id: string | null;
  message_id: string | null;
  event_type: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  recorded_at: number;
}

/**
 * Record an assistant event's usage. A message seen again keeps the largest value of each
 * counter (Claude streams a growing message under one id). A message id already stored for
 * another run is ignored, as before.
 */
export function recordAssistantUsage(
  runId: string,
  taskId: string | null,
  event: ClaudeAssistantEvent
): void {
  const u = event.message?.usage;
  if (!u) return;
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO usage_events
      (id, run_id, task_id, message_id, event_type, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, recorded_at)
    VALUES (?, ?, ?, ?, 'assistant', ?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      input_tokens = MAX(input_tokens, excluded.input_tokens),
      output_tokens = MAX(output_tokens, excluded.output_tokens),
      cache_read_tokens = MAX(cache_read_tokens, excluded.cache_read_tokens),
      cache_write_tokens = MAX(cache_write_tokens, excluded.cache_write_tokens)
  `).run(
    `${runId}:${event.message.id}`,
    runId,
    taskId,
    event.message.id,
    u.input_tokens ?? 0,
    u.output_tokens ?? 0,
    u.cache_read_input_tokens ?? 0,
    u.cache_creation_input_tokens ?? 0,
    nowMs()
  );
}

/** Record the final result event. Replaces any earlier result row for this run. */
export function recordResultUsage(
  runId: string,
  taskId: string | null,
  event: ClaudeResultEvent
): void {
  const u = event.usage;
  if (!u) return;
  const db = getDb();
  // Upsert — there should be at most one result per run
  db.prepare(`
    INSERT OR REPLACE INTO usage_events
      (id, run_id, task_id, message_id, event_type, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, cost_usd, recorded_at)
    VALUES (?, ?, ?, NULL, 'result', ?, ?, ?, ?, ?, ?)
  `).run(
    `${runId}:result`,
    runId,
    taskId,
    u.input_tokens ?? 0,
    u.output_tokens ?? 0,
    u.cache_read_input_tokens ?? 0,
    u.cache_creation_input_tokens ?? 0,
    event.total_cost_usd ?? 0,
    nowMs()
  );
}

export interface RunUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Notional cost at API prices. Kept for the record only; never shown and never a limit. */
  costUsd: number;
}

type TokenCounts = Pick<RunUsageSummary, 'inputTokens' | 'outputTokens' | 'cacheWriteTokens'>;

/**
 * The tokens that count toward a limit: input + output + cache writes. Cache reads are
 * context reused from earlier turns; they are shown apart, as "reused", and never counted.
 * The one place this rule lives.
 */
export function countedTokens(u: TokenCounts): number {
  return (u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheWriteTokens ?? 0);
}

/**
 * Usage for one run. The result event is authoritative for tokens and cost — except
 * that a run stopped at its limit reports zero tokens in its result (it still
 * reports the cost), so then the tokens come from the turns that were seen.
 */
export function getRunUsage(runId: string): RunUsageSummary {
  return sumRuns('u.run_id = ?', runId);
}

/**
 * Sum usage over a set of runs. Per run, the result event is used when it carries
 * tokens; otherwise the assistant events seen so far are summed. Cost always comes
 * from the result event.
 */
function sumRuns(whereSql: string, param: string | number): RunUsageSummary {
  const rows = getDb().prepare(`
    SELECT u.run_id,
      SUM(CASE WHEN u.event_type = 'result' THEN 1 ELSE 0 END) as has_result,
      SUM(CASE WHEN u.event_type = 'result' THEN u.input_tokens ELSE 0 END) as ri,
      SUM(CASE WHEN u.event_type = 'result' THEN u.output_tokens ELSE 0 END) as ro,
      SUM(CASE WHEN u.event_type = 'result' THEN u.cache_read_tokens ELSE 0 END) as rcr,
      SUM(CASE WHEN u.event_type = 'result' THEN u.cache_write_tokens ELSE 0 END) as rcw,
      SUM(CASE WHEN u.event_type = 'result' THEN u.cost_usd ELSE 0 END) as rc,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.input_tokens ELSE 0 END) as ai,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.output_tokens ELSE 0 END) as ao,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.cache_read_tokens ELSE 0 END) as acr,
      SUM(CASE WHEN u.event_type = 'assistant' THEN u.cache_write_tokens ELSE 0 END) as acw
    FROM usage_events u JOIN runs r ON r.id = u.run_id
    WHERE ${whereSql}
    GROUP BY u.run_id
  `).all(param) as Array<Record<string, number>>;

  const total: RunUsageSummary = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const r of rows) {
    const hasResult = Boolean(r['has_result']);
    const resultTokens = (r['ri'] ?? 0) + (r['ro'] ?? 0) + (r['rcr'] ?? 0) + (r['rcw'] ?? 0);
    const fromResult = hasResult && resultTokens > 0;
    total.inputTokens += (fromResult ? r['ri'] : r['ai']) ?? 0;
    total.outputTokens += (fromResult ? r['ro'] : r['ao']) ?? 0;
    total.cacheReadTokens += (fromResult ? r['rcr'] : r['acr']) ?? 0;
    total.cacheWriteTokens += (fromResult ? r['rcw'] : r['acw']) ?? 0;
    total.costUsd += hasResult ? r['rc'] ?? 0 : 0;
  }
  return total;
}

/** Usage for a task across all its runs. */
export function getTaskUsage(taskId: string): RunUsageSummary {
  return sumRuns('u.task_id = ?', taskId);
}

/** Usage for every run started at or after `sinceMs`. */
export function getUsageSince(sinceMs: number): RunUsageSummary {
  return sumRuns('r.started_at >= ?', sinceMs);
}

export interface RoleUsage extends RunUsageSummary {
  role: string;
  runs: number;
  /** Runs that stopped at their token limit. */
  budgetStops: number;
  /** Most common model among these runs. */
  model: string | null;
}

/** Usage per agent role for runs started at or after `sinceMs`, most counted tokens first. */
export function getUsageByRole(sinceMs: number): RoleUsage[] {
  const runs = getDb().prepare('SELECT id, role, state, model FROM runs WHERE started_at >= ?').all(sinceMs) as Array<{ id: string; role: string; state: string; model: string | null }>;
  const byRole = new Map<string, RoleUsage & { models: Map<string, number> }>();
  for (const run of runs) {
    const u = getRunUsage(run.id);
    const entry = byRole.get(run.role) ?? { role: run.role, runs: 0, budgetStops: 0, model: null, models: new Map(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
    entry.runs++;
    if (run.state === 'budget') entry.budgetStops++;
    if (run.model) entry.models.set(run.model, (entry.models.get(run.model) ?? 0) + 1);
    entry.inputTokens += u.inputTokens;
    entry.outputTokens += u.outputTokens;
    entry.cacheReadTokens += u.cacheReadTokens;
    entry.cacheWriteTokens += u.cacheWriteTokens;
    entry.costUsd += u.costUsd;
    byRole.set(run.role, entry);
  }
  return [...byRole.values()]
    .map(({ models, ...rest }) => ({ ...rest, model: [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null }))
    .sort((a, b) => countedTokens(b) - countedTokens(a));
}
