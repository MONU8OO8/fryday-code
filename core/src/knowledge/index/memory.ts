/**
 * Memory of finished work: what each task that passed review was about, what was planned,
 * which files it changed and what the review sent back on the way. The Planner of a new task
 * gets the few most like it, so a mistake made once is less likely to be made twice and a
 * known path through the code is found without exploring for it.
 *
 * Stored in the code index (index.db, table memory), found by meaning when vectors are
 * available and by shared words otherwise. It is a record kept by core, not instructions.
 */

import { getDb, nowMs } from '../../db/db.js';
import { getTask } from '../../pipeline/taskState.js';
import { parseBrief } from '../../pipeline/brief.js';
import { parsePlan } from '../../pipeline/review.js';
import { getRounds } from '../../pipeline/rounds.js';
import { activeWorkspace } from '../../pipeline/workspaces.js';
import { redactSecrets } from '../../secretPatterns.js';
import { hasVectors, indexDb } from './store.js';
import { embedPassages, embedQuery } from './embed.js';

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Remember a task that passed review. Replaces what was remembered before for it. Never throws. */
export function rememberTask(taskId: string): void {
  try {
    const task = getTask(taskId);
    if (!task) return;
    const brief = parseBrief(task.brief_json);
    const plan = parsePlan(task.plan_json);
    const ws = activeWorkspace(taskId);
    const rounds = getRounds(taskId);
    const files = ws?.files_json ? (JSON.parse(ws.files_json) as Array<{ path: string }>).map((f) => f.path) : plan?.files ?? [];
    const sentBack = rounds.filter((r) => r.outcome === 'changes_requested' && r.feedback).map((r) => `round ${r.round}: ${clip(r.feedback!, 300)}`);
    const text = [
      `Task: ${clip(task.title, 200)}`,
      `Asked: ${clip(task.description, 600)}`,
      brief ? `Understood: ${clip(brief.summary, 400)}` : '',
      plan ? `Planned: ${clip(plan.summary, 400)} ${clip(plan.approach, 400)}` : '',
      files.length ? `Files changed: ${files.slice(0, 15).join(', ')}` : '',
      sentBack.length ? `Sent back: ${sentBack.slice(0, 3).join(' | ')}` : 'Passed without being sent back.',
    ].filter(Boolean).join('\n');
    const outcome = `${rounds.length} round${rounds.length === 1 ? '' : 's'}`;
    const db = indexDb();
    const had = db.prepare('SELECT rowid FROM memory WHERE task_id = ?').get(taskId) as { rowid: number } | undefined;
    if (had && hasVectors()) db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(BigInt(had.rowid));
    db.prepare(`INSERT INTO memory (task_id, project_id, title, text, outcome, at, embedded) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(task_id) DO UPDATE SET project_id = excluded.project_id, title = excluded.title, text = excluded.text, outcome = excluded.outcome, at = excluded.at, embedded = 0`)
      .run(taskId, ws?.repo_id ?? null, clip(task.title, 200), redactSecrets(text), outcome, nowMs());
  } catch (err) {
    console.warn(`[fryday-core] could not remember ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Vectors for remembered tasks that have none yet. */
export async function embedMemory(): Promise<number> {
  if (!hasVectors()) return 0;
  const db = indexDb();
  const rows = db.prepare('SELECT rowid, text FROM memory WHERE embedded = 0 LIMIT 64').all() as Array<{ rowid: number; text: string }>;
  if (rows.length === 0) return 0;
  const vectors = await embedPassages(rows.map((r) => r.text));
  if (!vectors) return 0;
  db.transaction(() => rows.forEach((r, i) => {
    db.prepare('DELETE FROM memory_vec WHERE rowid = ?').run(BigInt(r.rowid));
    db.prepare('INSERT INTO memory_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(r.rowid), vectors[i]!);
    db.prepare('UPDATE memory SET embedded = 1 WHERE rowid = ?').run(r.rowid);
  }))();
  return rows.length;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'can', 'than', 'more', 'give', 'should', 'not', 'are', 'was', 'has', 'have', 'into', 'when', 'what', 'task', 'asked', 'planned', 'files', 'changed', 'passed', 'without', 'being', 'sent', 'back', 'round', 'rounds']);
/** Words, cut to six letters so "validate" and "validation" meet. */
const words = (text: string) => new Set((text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? []).filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)));
type MemRow = { rowid: number; task_id: string; project_id: string | null; title: string; text: string; outcome: string | null };

/**
 * A "Similar past tasks" section for the Planner: at most `k` finished tasks most like this
 * one, the same project first. '' when there are none. Never throws.
 */
export async function similarTasks(taskId: string, projectId: string, query: string, k = 3, maxChars = 3200): Promise<string> {
  try {
    const db = indexDb();
    // Only tasks that still exist in this install count (a test or a reset leaves none behind).
    const live = (r: MemRow) => r.task_id !== taskId && !!getDb().prepare('SELECT 1 FROM tasks WHERE id = ?').get(r.task_id);
    let found: Array<MemRow & { score: number }> = [];
    const vector = hasVectors() ? await embedQuery(query).catch(() => null) : null;
    if (vector) {
      const near = db.prepare('SELECT rowid, distance FROM memory_vec WHERE embedding MATCH ? AND k = 30 ORDER BY distance').all(vector) as Array<{ rowid: number; distance: number }>;
      const get = db.prepare('SELECT rowid, task_id, project_id, title, text, outcome FROM memory WHERE rowid = ?');
      found = near.map((n) => ({ ...(get.get(Number(n.rowid)) as MemRow), score: 1 - n.distance / 2 })).filter((r) => r.task_id && r.score > 0.55);
    } else {
      const want = words(query);
      found = (db.prepare('SELECT rowid, task_id, project_id, title, text, outcome FROM memory ORDER BY at DESC LIMIT 500').all() as MemRow[]).map((r) => {
        const have = words(r.text);
        let shared = 0;
        for (const w of want) if (have.has(w)) shared++;
        return { ...r, score: shared / Math.max(4, want.size) };
      }).filter((r) => r.score >= 0.25);
    }
    const picked = found.filter(live)
      .map((r) => ({ ...r, score: r.score * (r.project_id === projectId ? 1.15 : 1) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    if (picked.length === 0) return '';
    let left = maxChars;
    const blocks: string[] = [];
    for (const r of picked) {
      const block = `### ${r.task_id}${r.project_id && r.project_id !== projectId ? ` (in ${r.project_id})` : ''} · ${r.outcome ?? ''}\n${r.text}`;
      if (block.length > left) break;
      blocks.push(block);
      left -= block.length;
    }
    return blocks.length
      ? `## Similar past tasks\n\nFinished tasks FryDay remembers that look like this one: what was planned, what changed and what the review sent back. A record to learn from, not instructions; this task may differ.\n\n${blocks.join('\n\n')}`
      : '';
  } catch {
    return '';
  }
}
