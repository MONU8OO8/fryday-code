/**
 * Code search for one task: the project's production index, with the task's own changes on
 * top, turned into a "Relevant code" section for an agent's prompt.
 *
 * What the task's worktree holds is read by core as data (never run) and is seen only by that
 * task's searches. Nothing here waits long: an index or a model that is not ready yet means a
 * smaller section, or none, and the agent explores as before.
 */

import { git } from '../../pipeline/worktrees.js';
import type { WorkspaceRow } from '../../pipeline/workspaces.js';
import { indexProject, indexState, indexTaskFiles } from './indexer.js';
import { relevantCode } from './retrieve.js';

export type PackRole = 'planner' | 'coder' | 'coder_round' | 'tester';

/** Token budgets per use. A round packet is smaller: the Builder has seen the task once already. */
export const PACK_BUDGET: Record<PackRole, number> = { planner: 6000, coder: 8000, coder_round: 5000, tester: 3000 };

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** Files that differ between the indexed production commit and the task's worktree, committed or not. */
export function changedSinceIndexed(ws: WorkspaceRow): string[] {
  const state = indexState(ws.repo_id);
  if (!state?.sha) return [];
  try {
    const tracked = git(ws.worktree_path, ['diff', '--name-only', '--no-renames', state.sha]).split('\n');
    const untracked = git(ws.worktree_path, ['ls-files', '--others', '--exclude-standard']).split('\n');
    return [...new Set([...tracked, ...untracked].map((s) => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

/** Bring the index up to date for this task: the project (briefly waited for) and the task's changes. */
export async function syncTaskIndex(taskId: string, ws: WorkspaceRow): Promise<void> {
  try {
    await within(indexProject(ws.repo_id), 20_000, null);
    indexTaskFiles(taskId, ws.repo_id, ws.worktree_path, changedSinceIndexed(ws));
  } catch (err) {
    console.warn(`[fryday-core] the code index for ${taskId} could not be updated: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** A "Relevant code" section for this task, or '' when there is nothing to show. Never throws. */
export async function codePackFor(taskId: string, ws: WorkspaceRow, role: PackRole, query: string, boostPaths: string[] = []): Promise<string> {
  try {
    await syncTaskIndex(taskId, ws);
    return await within(relevantCode({ projectId: ws.repo_id, taskId, query, budget: PACK_BUDGET[role], boostPaths }), 25_000, '');
  } catch {
    return '';
  }
}
