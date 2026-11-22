/**
 * Stored task workspaces (one git worktree per task and repo) and the repo guidance
 * handed to agents that work in them.
 */

import fs from 'fs';
import path from 'path';
import { getDb, nowMs } from '../db/db.js';
import { sseEmit } from '../api/events.js';
import { removeWorkspace, removeCheckout, type Workspace } from './worktrees.js';
import { removeTaskDeps, projectKeepDir } from './deps.js';

const MAX_GUIDANCE_CHARS = 30_000;

export interface WorkspaceRow {
  task_id: string;
  repo_id: string;
  repo_path: string;
  worktree_path: string;
  branch: string;
  base_ref: string;
  base_sha: string;
  head_sha: string | null;
  files_json: string | null;
  baseline_json: string | null;
  /** The existing remote branch this task continues; null for a fresh branch from production. */
  target_branch: string | null;
  fork_sha: string | null;
  /** 1 when every commit on target_branch is the owner's own. */
  target_owned: number | null;
  /** Where the work was pushed, once the owner approved that. */
  pushed_ref: string | null;
  pushed_sha: string | null;
  removed_at: number | null;
  created_at: number;
}

export function getWorkspaces(taskId: string): WorkspaceRow[] {
  return getDb().prepare('SELECT * FROM task_workspaces WHERE task_id = ? ORDER BY created_at').all(taskId) as WorkspaceRow[];
}

/** The task's live workspace, if it has one. */
export function activeWorkspace(taskId: string): WorkspaceRow | undefined {
  return getWorkspaces(taskId).find((w) => w.removed_at === null);
}

export interface Continuation {
  targetBranch: string;
  forkSha: string;
  owned: boolean;
}

export function saveWorkspace(ws: Workspace, continues?: Continuation): void {
  getDb().prepare(`
    INSERT INTO task_workspaces (task_id, repo_id, repo_path, worktree_path, branch, base_ref, base_sha, target_branch, fork_sha, target_owned, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ws.taskId, ws.repoId, ws.repoPath, ws.worktreePath, ws.branch, ws.baseRef, ws.baseSha,
    continues?.targetBranch ?? null, continues?.forkSha ?? null, continues ? (continues.owned ? 1 : 0) : null, nowMs()
  );
}

/** Throwaway checkouts that belong to a workspace: where checks and the tester run, and the base commit. */
export function reviewCheckoutPath(ws: Pick<WorkspaceRow, 'worktree_path'>): string {
  return `${ws.worktree_path}.review`;
}
export function baseCheckoutPath(ws: Pick<WorkspaceRow, 'worktree_path'>): string {
  return `${ws.worktree_path}.base`;
}
/** Where the service under test runs and the tester agents work. */
export function verifyCheckoutPath(ws: Pick<WorkspaceRow, 'worktree_path'>): string {
  return `${ws.worktree_path}.verify`;
}

/**
 * The repo's own instructions for agents. Read by core and handed to the agent, so
 * it does not depend on which files the agent's checkout happens to contain.
 */
export function readGuidance(roots: string[], maxChars = MAX_GUIDANCE_CHARS): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const root of roots) {
    const candidates = [path.join(root, 'CLAUDE.md')];
    const rulesDir = path.join(root, '.claude', 'rules');
    if (fs.existsSync(rulesDir)) {
      for (const name of fs.readdirSync(rulesDir).sort()) {
        if (name.endsWith('.md')) candidates.push(path.join(rulesDir, name));
      }
    }
    for (const file of candidates) {
      const rel = path.relative(root, file);
      if (seen.has(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      seen.add(rel);
      parts.push(`## ${rel}\n\n${fs.readFileSync(file, 'utf8').trim()}`);
    }
  }
  const text = parts.join('\n\n');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[repo guidance cut at ${maxChars} characters]` : text;
}

/** Remove a task's worktree, its throwaway checkouts and its branch. Unmerged work on the branch is lost. */
export function discardWorkspaces(taskId: string): number {
  const active = getWorkspaces(taskId).filter((w) => w.removed_at === null);
  for (const ws of active) {
    removeCheckout(ws.repo_path, reviewCheckoutPath(ws));
    removeCheckout(ws.repo_path, baseCheckoutPath(ws));
    removeCheckout(ws.repo_path, verifyCheckoutPath(ws));
    removeWorkspace({ repoPath: ws.repo_path, worktreePath: ws.worktree_path, branch: ws.branch }, true);
    removeTaskDeps(projectKeepDir(ws.repo_id), taskId);
    getDb().prepare('UPDATE task_workspaces SET removed_at = ? WHERE task_id = ? AND repo_id = ?').run(nowMs(), taskId, ws.repo_id);
  }
  if (active.length > 0) sseEmit({ type: 'workspace_removed', taskId });
  return active.length;
}
